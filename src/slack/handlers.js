"use strict";

const { parse } = require("../parser/index");
const {
  matchProduct,
  getZoneById,
  getProductIndex,
  namedZones,
  rideHailTiers,
  normalize,
} = require("../parser/matcher");
const { reconcile } = require("../parser/reconciler");
const { pushToZupa, pushModification } = require("../zupa");
const {
  findDuplicate,
  recordOrder,
  saveConfirmedOrder,
  getConfirmedOrder,
  updateConfirmedOrder,
  getDailySummary,
} = require("../data/db");
const { parseModification } = require("../parser/mod-segmenter");
const { forceRefresh } = require("../data/loader");
const {
  fmt,
  trunc,
  buildReviewOrderBlocks,
  buildDuplicateWarningBlocks,
  buildZonePickerModal,
  buildProductSearchModal,
  buildModReviewBlocks,
  buildMenuModal,
  buildCitiesModal,
  buildSummaryModal,
  buildSummaryChannelBlocks,
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

// ── In-memory modification state ──────────────────────────────────────────────
// Key: `${channelId}:${modMessageTs}` → { threadTs, confirmedOrder, mod }
const modStateMap = new Map();

// ── In-memory pending-parse state (awaiting duplicate confirmation) ────────────
// Key: `${channelId}:${warningMessageTs}` → { channelId, rawText, threadTs? }
const pendingParseMap = new Map();

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

  const existing = findDuplicate(rawText);
  if (existing) {
    const warning = await client.chat.postMessage({
      channel: channelId,
      text: "Duplicate order detected",
      blocks: buildDuplicateWarningBlocks(existing),
    });
    if (warning.ts) {
      pendingParseMap.set(stateKey(channelId, warning.ts), {
        channelId,
        rawText,
      });
    }
    return;
  }

  const loading = await client.chat.postMessage({
    channel: channelId,
    text: "Parsing order…",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":hourglass_flowing_sand: *Parsing order…*",
        },
      },
    ],
  });

  const order = await parse(rawText);
  const blocks = buildReviewOrderBlocks(order);

  if (loading.ts) {
    await client.chat.update({
      channel: channelId,
      ts: loading.ts,
      text: "Review Order",
      blocks,
    });
    saveOrder(channelId, loading.ts, order);
  }
}

// ── App mention: @bot <order text> → parse + post review ─────────────────────

async function handleMentionOrder({ event, client }) {
  const channelId = event.channel;
  const rawText = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();

  if (!rawText) return;

  const existing = findDuplicate(rawText);
  if (existing) {
    const warning = await client.chat.postMessage({
      channel: channelId,
      thread_ts: event.ts,
      text: "Duplicate order detected",
      blocks: buildDuplicateWarningBlocks(existing),
    });
    if (warning.ts) {
      pendingParseMap.set(stateKey(channelId, warning.ts), {
        channelId,
        rawText,
        threadTs: event.ts,
      });
    }
    return;
  }

  const loading = await client.chat.postMessage({
    channel: channelId,
    thread_ts: event.ts,
    text: "Parsing order…",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":hourglass_flowing_sand: *Parsing order…*",
        },
      },
    ],
  });

  const order = await parse(rawText);
  order.slackRootTs = event.ts; // thread root = the mention ts, not the bot's reply ts
  const blocks = buildReviewOrderBlocks(order);

  if (loading.ts) {
    await client.chat.update({
      channel: channelId,
      ts: loading.ts,
      text: "Review Order",
      blocks,
    });
    saveOrder(channelId, loading.ts, order);
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
  if (query.length < 1) {
    // Empty query — return a broad alphabetical sample as a browsable fallback.
    // In practice min_query_length:1 on the modal means this branch is rarely hit.
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
    // Any typed character triggers the real scorer — covers the full catalogue
    // including products near end of alphabet (e.g. "z" finds "Zayith Yoghurt").
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

// ── External select options: zone search ─────────────────────────────────────

async function handleZoneSearchOptions({ options, ack }) {
  const query = normalize(options.value || "").trim();
  const nonSurge = namedZones.filter((z) => !z.isSurge);

  let results;
  if (query.length < 2) {
    results = [...nonSurge]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 100);
  } else {
    const qTokens = query.split(" ").filter((t) => t.length >= 2);
    results = nonSurge
      .map((z) => {
        const zn = z.normalized;
        let score = 0;
        if (zn === query) score = 1;
        else if (zn.startsWith(query)) score = 0.95;
        else if (zn.includes(query)) score = 0.85;
        else if (query.includes(zn)) score = 0.8;
        else {
          let matches = 0;
          for (const t of qTokens) {
            if (zn.includes(t) || zn.split(" ").some((zt) => zt.startsWith(t)))
              matches++;
          }
          score = qTokens.length > 0 ? matches / qTokens.length : 0;
        }
        return { zone: z, score };
      })
      .filter((r) => r.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.zone.name.localeCompare(b.zone.name),
      )
      .slice(0, 100)
      .map((r) => r.zone);
  }

  await ack({
    options: results.map((z) => ({
      text: {
        type: "plain_text",
        text: trunc(`${z.name} — ${fmt(z.price)}`, 75),
      },
      value: z.id,
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
  if (!order) {
    console.error("[product-search-submit] order not found in state", {
      channelId,
      ts,
    });
    await client.chat.postEphemeral({
      channel: channelId,
      user: body.user.id,
      text: "⚠️ Order state was lost (the bot may have restarted). Please re-paste the order message to start again.",
    });
    return;
  }

  let found = null;
  for (const product of getProductIndex()) {
    const size = product.sizes.find((s) => s.id === selectedSizeId);
    if (size) {
      found = { product, size };
      break;
    }
  }
  if (!found) {
    console.error("[product-search-submit] sizeId not found in product index", {
      selectedSizeId,
    });
    await client.chat.postEphemeral({
      channel: channelId,
      user: body.user.id,
      text: "⚠️ That product could not be matched in the current catalogue (the list may have just refreshed). Please open the search again and re-select.",
    });
    return;
  }

  const item = order.items.find((i) => i.index === itemIndex);
  if (!item) {
    console.error("[product-search-submit] item index not found in order", {
      itemIndex,
      items: order.items.map((i) => i.index),
    });
    await client.chat.postEphemeral({
      channel: channelId,
      user: body.user.id,
      text: "⚠️ Could not locate that item in the order. Please try again.",
    });
    return;
  }

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
    view.state.values.named_zone_select?.zone_search_select?.selected_option
      ?.value;
  const rideHailId =
    view.state.values.ride_hail_select?.ride_hail_input?.selected_option?.value;

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

// ── Shared: push a confirmed order to Zupa and update the message ────────────

async function executePush(order, confirmedBy, channelId, ts, client) {
  await client.chat.update({
    channel: channelId,
    ts,
    text: "Submitting order to Zupa…",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":hourglass_flowing_sand: *Submitting order to Zupa…*",
        },
      },
    ],
  });

  let pushResult;
  try {
    pushResult = await pushToZupa(order, confirmedBy);
  } catch (err) {
    await client.chat.update({
      channel: channelId,
      ts,
      text: "Review Order",
      blocks: buildReviewOrderBlocks(order),
    });
    await client.chat.postEphemeral({
      channel: channelId,
      user: confirmedBy,
      text: `❌ Zupa push failed: ${err.message}`,
    });
    return;
  }

  order.orderNumber = pushResult.orderNumber;
  recordOrder(
    order.rawMessage || "",
    pushResult.orderNumber,
    order.customer?.name,
  );
  // For mention-based orders, save under the thread root ts (the @mention ts)
  // so that thread replies can look it up via event.thread_ts.
  // For /parse-order, ts IS the root message, so slackRootTs is not set.
  saveConfirmedOrder(channelId, order.slackRootTs || ts, order, confirmedBy);
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

  await executePush(order, body.user.id, channelId, ts, client);
}

// ── Parse anyway: proceed after duplicate warning ─────────────────────────────

async function handleParseAnyway({ ack, body, client }) {
  await ack();

  const channelId = body.container.channel_id;
  const warningTs = body.container.message_ts;
  const pending = pendingParseMap.get(stateKey(channelId, warningTs));
  if (!pending) return;
  pendingParseMap.delete(stateKey(channelId, warningTs));

  await client.chat.update({
    channel: channelId,
    ts: warningTs,
    text: "Parsing order…",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":hourglass_flowing_sand: *Parsing order…*",
        },
      },
    ],
  });

  const order = await parse(pending.rawText);
  const blocks = buildReviewOrderBlocks(order);

  await client.chat.update({
    channel: channelId,
    ts: warningTs,
    text: "Review Order",
    blocks,
  });
  saveOrder(channelId, warningTs, order);
}

// ── Cancel parse: dismiss duplicate warning ───────────────────────────────────

async function handleCancelParse({ ack, body, client }) {
  await ack();

  const channelId = body.container.channel_id;
  const warningTs = body.container.message_ts;
  pendingParseMap.delete(stateKey(channelId, warningTs));

  await client.chat.update({
    channel: channelId,
    ts: warningTs,
    text: "Duplicate dismissed",
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "✕ Duplicate order dismissed." },
      },
    ],
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

// ── Thread reply: parse modification intent ───────────────────────────────────

async function handleThreadMessage({ event, client }) {
  // Skip bot messages, edited/deleted subtypes, and non-thread messages
  if (event.subtype || event.bot_id) return;
  if (!event.thread_ts || event.thread_ts === event.ts) return;

  const channelId = event.channel;
  const threadTs = event.thread_ts;

  const confirmedOrder = getConfirmedOrder(channelId, threadTs);
  if (!confirmedOrder) return;

  const rawText = (event.text || "").trim();
  if (!rawText || rawText === "--version") return;

  const loading = await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: "Parsing modification…",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":hourglass_flowing_sand: *Parsing modification…*",
        },
      },
    ],
  });
  if (!loading.ts) return;

  let mod;
  try {
    mod = await parseModification(rawText, confirmedOrder);
  } catch (err) {
    await client.chat.update({
      channel: channelId,
      ts: loading.ts,
      text: "❌ Failed to parse modification",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `❌ Could not parse modification: ${err.message}`,
          },
        },
      ],
    });
    return;
  }

  modStateMap.set(stateKey(channelId, loading.ts), {
    threadTs,
    confirmedOrder,
    mod,
  });

  await client.chat.update({
    channel: channelId,
    ts: loading.ts,
    text: "Order Modification",
    blocks: buildModReviewBlocks(mod, confirmedOrder),
  });
}

// ── Mod confirm: apply the modification ──────────────────────────────────────

async function handleModConfirm({ ack, body, client }) {
  await ack();

  const channelId = body.container.channel_id;
  const modMessageTs = body.container.message_ts;
  const modState = modStateMap.get(stateKey(channelId, modMessageTs));
  if (!modState) return;

  const { threadTs, confirmedOrder, mod } = modState;
  const modifiedBy = body.user.id;

  await client.chat.update({
    channel: channelId,
    ts: modMessageTs,
    text: "Applying modification…",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":hourglass_flowing_sand: *Applying modification…*",
        },
      },
    ],
  });

  try {
    await pushModification(confirmedOrder, mod, modifiedBy);
  } catch (err) {
    await client.chat.update({
      channel: channelId,
      ts: modMessageTs,
      text: "Modification failed",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `❌ *Modification failed:* ${err.message}`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "_Reply in this thread again to retry._",
          },
        },
      ],
    });
    return;
  }

  modStateMap.delete(stateKey(channelId, modMessageTs));

  // Apply changes to the stored order so future modifications have accurate state
  if (mod.newName) confirmedOrder.customer.name = mod.newName;
  if (mod.newPhone) confirmedOrder.customer.phone = mod.newPhone;
  if (mod.addItems.length > 0) confirmedOrder.items.push(...mod.addItems);
  if (mod.removeItems.length > 0) {
    const removedIds = new Set(mod.removeItems.map((i) => i.sizeId));
    confirmedOrder.items = confirmedOrder.items.filter(
      (i) => !removedIds.has(i.sizeId),
    );
  }
  if (mod.newZoneId) {
    confirmedOrder.fulfillment.zoneId = mod.newZoneId;
    confirmedOrder.fulfillment.zoneName = mod.newZoneName;
    confirmedOrder.fulfillment.branch = mod.newBranch;
    confirmedOrder.fulfillment.fee = mod.newFee;
    confirmedOrder.fulfillment.address = mod.newAddress;
  }
  if (mod.newScheduledDate) confirmedOrder.scheduledDate = mod.newScheduledDate;
  updateConfirmedOrder(channelId, threadTs, confirmedOrder);

  const nameLine = mod.newName ? `  👤  Name: ${mod.newName}` : null;
  const phoneLine = mod.newPhone ? `  📱  Phone: ${mod.newPhone}` : null;
  const addedLines = mod.addItems.map(
    (i) =>
      `  ➕  ${i.productName} · ${i.sizeName} ×${i.qty} — ${fmt(i.lineTotal)}`,
  );
  const removedLines = mod.removeItems.map(
    (i) => `  ➖  ${i.productName} · ${i.sizeName} ×${i.qty}`,
  );
  const addressLine = mod.newZoneId
    ? `  📍  ${confirmedOrder.fulfillment.zoneName}`
    : null;
  const dateLine = mod.newScheduledDate
    ? `  📅  Delivery date: ${mod.newScheduledDate}`
    : null;
  const summary = [
    nameLine,
    phoneLine,
    ...addedLines,
    ...removedLines,
    addressLine,
    dateLine,
  ]
    .filter(Boolean)
    .join("\n");

  await client.chat.update({
    channel: channelId,
    ts: modMessageTs,
    text: "Modification applied",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `✅ *Modification applied by <@${modifiedBy}>*\nOrder \`${confirmedOrder.orderNumber}\`\n${summary}`,
        },
      },
    ],
  });
}

// ── Mod reject: cancel the pending modification ───────────────────────────────

async function handleModReject({ ack, body, client }) {
  await ack();

  const channelId = body.container.channel_id;
  const modMessageTs = body.container.message_ts;

  modStateMap.delete(stateKey(channelId, modMessageTs));

  await client.chat.update({
    channel: channelId,
    ts: modMessageTs,
    text: "Modification cancelled",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `✕ Modification cancelled by <@${body.user.id}>`,
        },
      },
    ],
  });
}

// ── Mod: pick a different product for a resolved addition ─────────────────────

async function handleModAddPick({ ack, body, client }) {
  await ack();
  const action = body.actions[0];
  const sizeId = action.selected_option.value;
  const idx = parseInt((action.block_id || "").split("_").pop(), 10);

  const channelId = body.container.channel_id;
  const modMessageTs = body.container.message_ts;
  const modState = modStateMap.get(stateKey(channelId, modMessageTs));
  if (!modState) return;

  const item = modState.mod.addItems[idx];
  if (!item) return;
  const picked = (item.candidates || []).find((c) => c.sizeId === sizeId);
  if (!picked) return;

  modState.mod.addItems[idx] = {
    ...item,
    productName: picked.productName,
    sizeName: picked.sizeName,
    sizeId: picked.sizeId,
    unitPrice: picked.price,
    lineTotal: picked.price * item.qty,
  };

  await client.chat.update({
    channel: channelId,
    ts: modMessageTs,
    text: "Order Modification",
    blocks: buildModReviewBlocks(modState.mod, modState.confirmedOrder),
  });
}

// ── Mod: pick a product for an unresolved addition (external_select) ──────────

async function handleModAddSearch({ ack, body, client }) {
  await ack();
  const action = body.actions[0];
  const sizeId = action.selected_option.value;
  const idx = parseInt((action.block_id || "").split("_").pop(), 10);

  const channelId = body.container.channel_id;
  const modMessageTs = body.container.message_ts;
  const modState = modStateMap.get(stateKey(channelId, modMessageTs));
  if (!modState) return;

  // Find the product in the index
  let found = null;
  for (const p of getProductIndex()) {
    const s = (p.sizes || []).find((sz) => sz && sz.id === sizeId);
    if (s) {
      found = {
        productName: p.name,
        sizeName: s.name,
        sizeId: s.id,
        unitPrice: s.price,
      };
      break;
    }
  }
  if (!found) return;

  // Move from unresolved to addItems
  modState.mod.unresolvedAdditions.splice(idx, 1);
  modState.mod.addItems.push({
    ...found,
    qty: 1,
    lineTotal: found.unitPrice,
    candidates: [],
  });

  await client.chat.update({
    channel: channelId,
    ts: modMessageTs,
    text: "Order Modification",
    blocks: buildModReviewBlocks(modState.mod, modState.confirmedOrder),
  });
}

// ── Mod: pick which order item to remove (when multiple candidates match) ─────

async function handleModRemovePick({ ack, body, client }) {
  await ack();
  const action = body.actions[0];
  const sizeId = action.selected_option.value;
  const idx = parseInt((action.block_id || "").split("_").pop(), 10);

  const channelId = body.container.channel_id;
  const modMessageTs = body.container.message_ts;
  const modState = modStateMap.get(stateKey(channelId, modMessageTs));
  if (!modState) return;

  const item = modState.mod.removeItems[idx];
  if (!item) return;
  const picked = (item.candidates || []).find((c) => c.sizeId === sizeId);
  if (!picked) return;

  modState.mod.removeItems[idx] = { ...picked, candidates: item.candidates };

  await client.chat.update({
    channel: channelId,
    ts: modMessageTs,
    text: "Order Modification",
    blocks: buildModReviewBlocks(modState.mod, modState.confirmedOrder),
  });
}

// ── Mod: select delivery zone from external_select ───────────────────────────

async function handleModZoneSelect({ ack, body, client }) {
  await ack();
  const action = body.actions[0];
  const zoneId = action.selected_option.value;

  const channelId = body.container.channel_id;
  const modMessageTs = body.container.message_ts;
  const modState = modStateMap.get(stateKey(channelId, modMessageTs));
  if (!modState) return;

  const zone = getZoneById(zoneId);
  if (!zone) return;

  modState.mod.newZoneId = zone.id;
  modState.mod.newZoneName = zone.name;
  modState.mod.newBranch = zone.branch;
  modState.mod.newFee = zone.price;

  await client.chat.update({
    channel: channelId,
    ts: modMessageTs,
    text: "Order Modification",
    blocks: buildModReviewBlocks(modState.mod, modState.confirmedOrder),
  });
}

// ── /menu command ─────────────────────────────────────────────────────────────

async function handleMenuCommand({ command, ack, client }) {
  console.log(" =========== \n\n", command, `\n\n`);

  await ack();
  await client.views.open({
    trigger_id: command.trigger_id,
    view: buildMenuModal(),
  });
}

async function handleMenuSearchOptions({ options, ack }) {
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

async function handleMenuSelect({ ack }) {
  await ack();
}

async function handleMenuSearch({ ack, body, action, client }) {
  await ack();
  const query = action.value || "";
  try {
    await client.views.update({
      view_id: body.view.id,
      view: buildMenuModal(query),
    });
  } catch (err) {
    console.error("[menu] views.update failed:", err.message);
  }
}

// ── /cities command ───────────────────────────────────────────────────────────

async function handleCitiesCommand({ command, ack, client }) {
  await ack();
  await client.views.open({
    trigger_id: command.trigger_id,
    view: buildCitiesModal(),
  });
}

async function handleCitiesSearchOptions({ options, ack }) {
  const query = normalize(options.value || "").trim();
  const zones = namedZones.filter((z) => !z.isSurge);
  const allOptions = [...zones, ...rideHailTiers];

  let results;
  if (query.length < 2) {
    results = [...zones]
      .sort((a, b) => a.name.localeCompare(b.name))
      .concat(rideHailTiers)
      .slice(0, 100);
  } else {
    const qTokens = query.split(" ").filter((t) => t.length >= 2);
    results = allOptions
      .map((z) => {
        const zn = z.normalized;
        let score = 0;
        if (zn === query) score = 1;
        else if (zn.startsWith(query)) score = 0.95;
        else if (zn.includes(query)) score = 0.85;
        else if (query.includes(zn)) score = 0.8;
        else {
          let matches = 0;
          for (const t of qTokens) {
            if (zn.includes(t) || zn.split(" ").some((zt) => zt.startsWith(t)))
              matches++;
          }
          score = qTokens.length > 0 ? matches / qTokens.length : 0;
        }
        return { zone: z, score };
      })
      .filter((r) => r.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.zone.name.localeCompare(b.zone.name),
      )
      .slice(0, 100)
      .map((r) => r.zone);
  }

  await ack({
    options: results.map((z) => ({
      text: {
        type: "plain_text",
        text: trunc(
          `${z.name} · ${z.branch || "Ride-hail"} — ${fmt(z.price)}`,
          75,
        ),
      },
      value: z.id,
    })),
  });
}

async function handleCitiesSelect({ ack }) {
  await ack();
}

// ── Version command ───────────────────────────────────────────────────────────

async function handleVersionCommand({ message, say }) {
  const { version } = require("../../package.json");
  await say({
    text: `Zupa Order Bot v${version}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Zupa Order Bot*  \`v${version}\`` },
      },
    ],
    thread_ts: message.thread_ts || message.ts,
  });
}

// ── /summary command ──────────────────────────────────────────────────────────

async function handleSummaryCommand({ command, ack, client }) {
  console.log(" =========== \n\n", command, `\n\n`);
  await ack();

  const userId = command.user_id;
  const channelId = command.channel_id;

  try {
    const arg = (command.text || "").trim();
    const offsetDays = /^-?\d+$/.test(arg) ? parseInt(arg, 10) : 0;

    const orders = getDailySummary(userId, offsetDays);

    const dateLabel = new Date(
      Date.now() + 3600_000 * (1 + offsetDays),
    ).toLocaleDateString("en-NG", {
      timeZone: "Africa/Lagos",
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    await client.views.open({
      trigger_id: command.trigger_id,
      view: buildSummaryModal(orders, dateLabel, channelId, userId, offsetDays),
    });
  } catch (err) {
    console.error("[handleSummaryCommand] Error:", err);
    await client.chat
      .postEphemeral({
        channel: channelId,
        user: userId,
        text: `❌ Could not open summary: ${err.message}`,
      })
      .catch(() => {});
  }
}

// ── /refresh-products ────────────────────────────────────────────────────────

async function handleRefreshProductsCommand({ command, ack, respond }) {
  await ack();
  try {
    const { productCount, zoneCount } = await forceRefresh();
    await respond({
      response_type: 'in_channel',
      text: `✅ Product catalogue refreshed by <@${command.user_id}> — *${productCount} products* and *${zoneCount} delivery zones* loaded.`,
    });
  } catch (err) {
    console.error('[handleRefreshProductsCommand]', err);
    await respond({
      response_type: 'ephemeral',
      text: `❌ Refresh failed: ${err.message}`,
    });
  }
}

// ── /summary modal submit → paste to channel ──────────────────────────────────

async function handleSummarySubmit({ ack, body, view, client }) {
  await ack();

  const meta = JSON.parse(view.private_metadata || "{}");
  const { channelId, userId, offsetDays, dateLabel } = meta;
  if (!channelId || !userId) return;

  const orders = getDailySummary(userId, offsetDays || 0);

  await client.chat.postMessage({
    channel: channelId,
    text: `Daily summary from <@${userId}> — ${dateLabel}`,
    blocks: buildSummaryChannelBlocks(orders, dateLabel, userId),
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
  handleZoneSearchOptions,
  handleProductSearchSubmit,
  handleChangeZone,
  handleZonePickerSubmit,
  handleConfirmOrder,
  handleParseAnyway,
  handleCancelParse,
  handleRejectOrder,
  handleThreadMessage,
  handleModConfirm,
  handleModReject,
  handleModAddPick,
  handleModAddSearch,
  handleModRemovePick,
  handleModZoneSelect,
  handleVersionCommand,
  handleMenuCommand,
  handleMenuSearchOptions,
  handleMenuSelect,
  handleMenuSearch,
  handleCitiesCommand,
  handleCitiesSearchOptions,
  handleCitiesSelect,
  handleSummaryCommand,
  handleSummarySubmit,
  handleRefreshProductsCommand,
};
