"use strict";

const { parse } = require("../parser/index");
const {
  matchProduct,
  matchZone,
  getZoneById,
  getProductIndex,
  rideHailTiers,
  pickupRows,
} = require("../parser/matcher");
const { reconcile } = require("../parser/reconciler");
const { pushToZupa } = require("../zupa");
const {
  fmt,
  trunc,
  buildReviewOrderBlocks,
  buildZonePickerModal,
  buildProductSearchModal,
} = require("./blocks");

// ── In-memory order state ─────────────────────────────────────────────────────
// Key: `${channelId}:${ts}` → DraftOrder
// This resets on restart; Phase 2 should persist to a database.
const orderStateMap = new Map();

function stateKey(channelId, ts) {
  return `${channelId}:${ts}`;
}

function getOrder(channelId, ts) {
  return orderStateMap.get(stateKey(channelId, ts));
}

function saveOrder(channelId, ts, order) {
  orderStateMap.set(stateKey(channelId, ts), order);
}

function deleteOrder(channelId, ts) {
  orderStateMap.delete(stateKey(channelId, ts));
}

// Re-run reconciliation after an item/zone change and update aggregates
function reReconcile(order) {
  const { reconciliation, fulfillment, itemsSubtotal, orderTotal } = reconcile(
    order.items,
    order.fulfillment,
    order.statedTotal,
  );
  order.reconciliation = reconciliation;
  order.fulfillment = fulfillment;
  order.itemsSubtotal = itemsSubtotal;
  order.orderTotal = orderTotal;

  const hasUnresolved =
    order.items.some((i) => i.issue !== null) ||
    !order.fulfillment.resolved ||
    order.reconciliation.status === "mismatch";
  order.status = hasUnresolved ? "needs_confirmation" : "auto_accepted";
  return order;
}

// ── Slash command: /parse-order ───────────────────────────────────────────────

async function handleParseOrderCommand({ command, ack, client }) {
  await ack();
  await client.views.open({
    trigger_id: command.trigger_id,
    view: {
      type: "modal",
      callback_id: "parse_order_submit",
      private_metadata: JSON.stringify({ channelId: command.channel_id }),
      title: { type: "plain_text", text: "Parse Order" },
      submit: { type: "plain_text", text: "Parse" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "raw_order",
          label: {
            type: "plain_text",
            text: "Paste the raw order message below:",
          },
          element: {
            type: "plain_text_input",
            action_id: "order_text",
            multiline: true,
            placeholder: {
              type: "plain_text",
              text: "Paste WhatsApp / IG DM text here…",
            },
          },
        },
      ],
    },
  });
}

// ── Modal: order text submitted → parse + post review ────────────────────────

async function handleParseOrderSubmit({ ack, body, view, client }) {
  await ack();

  const meta = JSON.parse(view.private_metadata || "{}");
  const channelId = meta.channelId;
  const rawText = view.state.values.raw_order.order_text.value;

  if (!rawText || !channelId) return;

  const order = await parse(rawText);
  const blocks = buildReviewOrderBlocks(order);

  const result = await client.chat.postMessage({
    channel: channelId,
    text: "Review Order",
    blocks,
  });

  if (result.ts) {
    saveOrder(channelId, result.ts, order);
  }
}

// ── App mention: @bot <order text> → parse + post review ─────────────────────

async function handleMentionOrder({ event, client }) {
  const channelId = event.channel;
  const rawText = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();

  if (!rawText) return;

  const order = await parse(rawText);
  const blocks = buildReviewOrderBlocks(order);

  const result = await client.chat.postMessage({
    channel: channelId,
    thread_ts: event.ts,
    text: "Review Order",
    blocks,
  });

  if (result.ts) {
    saveOrder(channelId, result.ts, order);
  }
}

// ── Product picker: dropdown selection ───────────────────────────────────────

async function handleProductPick({ ack, body, action, client }) {
  await ack();

  const channelId = body.container.channel_id;
  const ts = body.container.message_ts;
  const order = getOrder(channelId, ts);
  if (!order) return;

  // action_id format: product_pick_${itemIndex}
  const itemIndex = parseInt(action.action_id.replace("product_pick_", ""), 10);
  const selectedSizeId = action.selected_option.value;

  // Find the selected SKU in our product index
  let found = null;
  for (const product of getProductIndex()) {
    const size = product.sizes.find((s) => s.id === selectedSizeId);
    if (size) {
      found = { product, size };
      break;
    }
  }
  if (!found) return;

  const item = order.items.find((i) => i.index === itemIndex);
  if (!item) return;

  item.productName = found.product.name;
  item.sizeName = found.size.name;
  item.sizeId = found.size.id;
  item.unitPrice = found.size.price;
  item.lineTotal = found.size.price * item.qty;
  item.confidence = "high";
  item.match = "staff_confirmed";
  item.issue = null;

  reReconcile(order);
  saveOrder(channelId, ts, order);

  await client.chat.update({
    channel: channelId,
    ts,
    text: "Review Order",
    blocks: buildReviewOrderBlocks(order),
  });
}

// ── Edit item: expand a matched item for re-selection ────────────────────────

async function handleEditItem({ ack, body, action, client }) {
  await ack();

  const channelId = body.container.channel_id;
  const ts = body.container.message_ts;
  const order = getOrder(channelId, ts);
  if (!order) return;

  const itemIndex = parseInt(action.value, 10);

  await client.chat.update({
    channel: channelId,
    ts,
    text: "Review Order",
    blocks: buildReviewOrderBlocks(order, itemIndex),
  });
}

// ── Done editing item: collapse back to matched state ─────────────────────────

async function handleDoneEditItem({ ack, body, action, client }) {
  await ack();

  const channelId = body.container.channel_id;
  const ts = body.container.message_ts;
  const order = getOrder(channelId, ts);
  if (!order) return;

  await client.chat.update({
    channel: channelId,
    ts,
    text: "Review Order",
    blocks: buildReviewOrderBlocks(order, null),
  });
}

// ── Search product: open search modal ────────────────────────────────────────

async function handleSearchProduct({ ack, body, action, client }) {
  await ack();

  const channelId = body.container.channel_id;
  const ts = body.container.message_ts;
  const itemIndex = parseInt(action.value, 10);

  const privateMetadata = JSON.stringify({ channelId, ts });
  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildProductSearchModal(itemIndex, privateMetadata),
  });
}

// ── External select options: called by Slack as user types ───────────────────

async function handleProductSearchOptions({ options, ack }) {
  const query = (options.value || "").trim();

  let candidates;
  if (query.length < 2) {
    candidates = getProductIndex()
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((p) =>
        p.sizes.map((s) => ({
          productName: p.name,
          sizeName: s.name,
          sizeId: s.id,
          price: s.price,
        })),
      )
      .slice(0, 100);
  } else {
    candidates = matchProduct(query, null, null, null, 100);
  }

  await ack({
    options: candidates.map((c) => ({
      text: {
        type: "plain_text",
        text: trunc(`${c.productName} · ${c.sizeName} — ${fmt(c.price)}`, 75),
      },
      value: c.sizeId,
    })),
  });
}

// ── Product search submitted → update item ───────────────────────────────────

async function handleProductSearchSubmit({ ack, body, view, client }) {
  await ack({ response_action: "clear" });

  const meta = JSON.parse(view.private_metadata || "{}");
  const { channelId, ts, itemIndex } = meta;
  const selectedSizeId =
    view.state.values.product_select.product_search_select.selected_option
      ?.value;
  if (!selectedSizeId) return;

  const order = getOrder(channelId, ts);
  if (!order) return;

  let found = null;
  for (const product of getProductIndex()) {
    const size = product.sizes.find((s) => s.id === selectedSizeId);
    if (size) {
      found = { product, size };
      break;
    }
  }
  if (!found) return;

  const item = order.items.find((i) => i.index === itemIndex);
  if (!item) return;

  item.productName = found.product.name;
  item.sizeName = found.size.name;
  item.sizeId = found.size.id;
  item.unitPrice = found.size.price;
  item.lineTotal = found.size.price * item.qty;
  item.confidence = "high";
  item.match = "staff_confirmed";
  item.issue = null;

  reReconcile(order);
  saveOrder(channelId, ts, order);

  await client.chat.update({
    channel: channelId,
    ts,
    text: "Review Order",
    blocks: buildReviewOrderBlocks(order),
  });
}

// ── Change zone: open zone picker modal ──────────────────────────────────────

async function handleChangeZone({ ack, body, action, client }) {
  await ack();

  const channelId = body.container.channel_id;
  const ts = body.container.message_ts;
  const order = getOrder(channelId, ts);
  const currentAddress = order
    ? order.fulfillment.address || order.fulfillment.zoneName || ""
    : "";

  const privateMetadata = JSON.stringify({ channelId, ts });
  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildZonePickerModal(currentAddress, privateMetadata),
  });
}

// ── Zone picker submitted ─────────────────────────────────────────────────────

async function handleZonePickerSubmit({ ack, body, view, client }) {
  await ack({ response_action: "clear" });

  const meta = JSON.parse(view.private_metadata || "{}");
  const { channelId, ts } = meta;
  const order = getOrder(channelId, ts);
  if (!order) return;

  const namedZoneId =
    view.state.values.named_zone_select?.zone_select_input?.selected_option
      ?.value;
  const rideHailId =
    view.state.values.ride_hail_select?.ride_hail_input?.selected_option?.value;
  const zoneQuery = view.state.values.zone_search?.zone_input?.value || "";

  if (namedZoneId) {
    const zone = getZoneById(namedZoneId);
    if (zone) {
      order.fulfillment.zoneId = zone.id;
      order.fulfillment.zoneName = zone.name;
      order.fulfillment.branch = zone.branch;
      order.fulfillment.fee = zone.price;
      order.fulfillment.resolved = true;
    }
  } else if (rideHailId) {
    const tier = rideHailTiers.find((t) => t.id === rideHailId);
    if (tier) {
      order.fulfillment.zoneId = tier.id;
      order.fulfillment.zoneName = tier.name;
      order.fulfillment.fee = tier.price;
      order.fulfillment.branch = tier.branch;
      order.fulfillment.resolved = true;
    }
  } else if (zoneQuery.trim()) {
    const zone = matchZone(zoneQuery.trim());
    if (zone) {
      order.fulfillment.address = zoneQuery.trim();
      order.fulfillment.zoneId = zone.id;
      order.fulfillment.zoneName = zone.name;
      order.fulfillment.branch = zone.branch;
      order.fulfillment.fee = zone.price;
      order.fulfillment.resolved = true;
    } else {
      order.fulfillment.address = zoneQuery.trim();
      order.fulfillment.zoneId = null;
      order.fulfillment.zoneName = null;
      order.fulfillment.resolved = false;
    }
  }

  reReconcile(order);
  saveOrder(channelId, ts, order);

  await client.chat.update({
    channel: channelId,
    ts,
    text: "Review Order",
    blocks: buildReviewOrderBlocks(order),
  });
}

// ── Confirm order ────────────────────────────────────────────────────────────

async function handleConfirmOrder({ ack, body, action, client }) {
  await ack();

  const channelId = body.container.channel_id;
  const ts = body.container.message_ts;
  const order = getOrder(channelId, ts);
  if (!order) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: body.user.id,
      text: "⚠️ Order state not found. The bot may have restarted. Please re-parse the order.",
    });
    return;
  }

  const unresolvedItems = order.items.filter((i) => i.issue !== null);
  const zoneUnresolved =
    !order.fulfillment.resolved || !order.fulfillment.zoneId;

  if (unresolvedItems.length > 0 || zoneUnresolved) {
    const reasons = [];
    if (unresolvedItems.length > 0)
      reasons.push(`${unresolvedItems.length} unresolved item(s)`);
    if (zoneUnresolved) reasons.push("delivery zone not set");
    await client.chat.postEphemeral({
      channel: channelId,
      user: body.user.id,
      text: `⚠️ Cannot confirm yet: ${reasons.join(", ")}. Please resolve these first.`,
    });
    return;
  }

  const confirmedBy = body.user.id;
  let pushResult;
  try {
    pushResult = await pushToZupa(order, confirmedBy);
  } catch (err) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: body.user.id,
      text: `❌ Zupa push failed: ${err.message}`,
    });
    return;
  }

  deleteOrder(channelId, ts);

  const successText = [
    `✅  *Order confirmed by <@${confirmedBy}>*`,
    `Customer: ${order.customer.name || "—"}  |  ${order.fulfillment.type === "pickup" ? "Pickup" : "Delivery"}: ${order.fulfillment.zoneName || "—"}`,
    `Total: ₦${(order.orderTotal || 0).toLocaleString("en-NG")}`,
    pushResult.orderNumber
      ? `Zupa Order Number: \`${pushResult.orderNumber}\``
      : "_Payload logged (Zupa API not yet wired up)_",
  ].join("\n");

  await client.chat.update({
    channel: channelId,
    ts,
    text: successText,
    blocks: [],
  });
}

// ── Reject order ─────────────────────────────────────────────────────────────

async function handleRejectOrder({ ack, body, action, client }) {
  await ack();

  const channelId = body.container.channel_id;
  const ts = body.container.message_ts;

  deleteOrder(channelId, ts);

  await client.chat.update({
    channel: channelId,
    ts,
    text: `❌  Order rejected by <@${body.user.id}>`,
    blocks: [],
  });
}

module.exports = {
  handleParseOrderCommand,
  handleParseOrderSubmit,
  handleMentionOrder,
  handleProductPick,
  handleEditItem,
  handleDoneEditItem,
  handleSearchProduct,
  handleProductSearchOptions,
  handleProductSearchSubmit,
  handleChangeZone,
  handleZonePickerSubmit,
  handleConfirmOrder,
  handleRejectOrder,
};
