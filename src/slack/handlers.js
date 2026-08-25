"use strict";

const { parse } = require("../parser/index");
const {
  matchProduct,
  getZoneById,
  getProductIndex,
  normalize,
} = require("../parser/matcher");
const store = require("../data/store");
const { reconcile } = require("../parser/reconciler");
const {
  pushToZupa,
  pushModification,
  fetchKitchenSummary,
  verifyPayment,
  requestOverrideOtp,
  verifyOverrideOtp,
  lookupReceipt,
  confirmReceiptMatch,
  authorizeOtpOverride,
} = require("../zupa");
const {
  findDuplicate,
  recordOrder,
  saveConfirmedOrder,
  getConfirmedOrder,
  getConfirmedOrderRow,
  updateConfirmedOrder,
  getDailySummary,
  getAllOrdersToday,
  getOrdersForPeriod,
  getOtpOverridesForPeriod,
  lagosWeekBounds,
  lagosMonthBounds,
  isLastDayOfLagosMonth,
  savePendingOrder,
  deletePendingOrder,
  getAllPendingOrders,
  clearAllPendingOrders,
  setCsrInitial,
  getCsrByInitial,
  getAllCsrInitials,
} = require("../data/db");
const { parseModification } = require("../parser/mod-segmenter");
const { forceRefresh } = require("../data/loader");
const SystemProducts = require("../../systemProducts");
const { PAYMENT_ADJUSTMENT_LIMIT, MANAGER_USER_IDS } = require("../constants");
const {
  fmt,
  trunc,
  buildReviewOrderBlocks,
  buildConfirmationBlocks,
  buildDuplicateWarningBlocks,
  buildZonePickerModal,
  buildDatePickerModal,
  buildProductSearchModal,
  buildModAddSearchModal,
  buildModCityPickerModal,
  buildModReviewBlocks,
  buildPaymentNotFoundBlocks,
  buildOtpPendingBlocks,
  buildPaymentNameModal,
  buildOtpModal,
  buildMenuModal,
  buildCitiesModal,
  buildSummaryModal,
  buildSummaryChannelBlocks,
  buildDailyReportBlocks,
  buildUnconfirmedOrdersBlocks,
  buildUnconfirmedOrdersModal,
  buildWeeklyReportBlocks,
  buildMonthlyReportBlocks,
  buildAvailabilityModal,
  applyAvailabilityFilter,
  buildAmountAdjustModal,
  buildReceiptLookupModal,
  buildReceiptFoundModal,
} = require("./blocks");

// ── Ephemeral helper ──────────────────────────────────────────────────────────
// Always posts in-thread when threadTs is provided so mobile users see it.
function ephem(client, { channel, user, threadTs, text }) {
  const payload = { channel, user, text };
  if (threadTs) payload.thread_ts = threadTs;
  return client.chat.postEphemeral(payload).catch(() => {});
}

// ── Availability cache (short-lived — inventory changes in real time) ─────────
let _availCache = null;
let _availCacheAt = 0;
const AVAIL_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

async function _fetchAvailability() {
  const now = Date.now();
  if (_availCache && now - _availCacheAt < AVAIL_CACHE_TTL) return _availCache;
  _availCache = await SystemProducts.fetchProductsWithAvailability();
  _availCacheAt = now;
  return _availCache;
}

// ── CSR initial helpers ───────────────────────────────────────────────────────
// Extracts #XX at the very end of a message (1–4 uppercase letters after #).
function extractInitial(text) {
  const match = (text || "").trim().match(/#([A-Za-z]{1,4})\s*$/);
  return match ? match[1].toUpperCase() : null;
}

// Returns the display label for who posted the order.
// Format: "Bimbo  ·  #BB" | "#BB" (no mapping) | "<@slackId>" (no initial)
function resolveParsedBy(initial, slackUserId) {
  if (initial) {
    const row = getCsrByInitial(initial);
    return row ? `${row.name}  ·  #${initial}` : `#${initial}`;
  }
  return slackUserId ? `<@${slackUserId}>` : "—";
}

// ── In-memory order state (backed by SQLite for restart recovery) ─────────────
// Key: `${channelId}:${ts}` → DraftOrder
const orderStateMap = new Map();

function stateKey(channelId, ts) {
  return `${channelId}:${ts}`;
}

function getOrder(channelId, ts) {
  return orderStateMap.get(stateKey(channelId, ts));
}

function saveOrder(channelId, ts, order) {
  orderStateMap.set(stateKey(channelId, ts), order);
  savePendingOrder(channelId, ts, order);
}

function deleteOrder(channelId, ts) {
  orderStateMap.delete(stateKey(channelId, ts));
  deletePendingOrder(channelId, ts);
}

// ── In-memory modification state ──────────────────────────────────────────────
// Key: `${channelId}:${modMessageTs}` → { threadTs, confirmedOrder, mod }
const modStateMap = new Map();

// ── In-memory pending-parse state (awaiting duplicate confirmation) ────────────
// Key: `${channelId}:${warningMessageTs}` → { channelId, rawText, threadTs? }
const pendingParseMap = new Map();

// ── In-memory daily-report state (backs the "View Unconfirmed Orders" drill-down) ─
// Key: `${channelId}:${reportMessageTs}` → { unconfirmed, lookup, dateLabel }
const dailyReportStateMap = new Map();

// Builds clientReference → { parsedBy, otpOverride, otpAuthorizedBy } from our own
// confirmed-order records, so the kitchen API's unconfirmed list (joined on
// platformOrderReference === our clientReference) can show who posted/authorized each order.
function _buildClientRefLookup(orders) {
  const lookup = {};
  for (const o of orders) {
    if (!o.clientReference) continue;
    lookup[o.clientReference] = {
      parsedBy: o.parsedBy || null,
      otpOverride: o.otpOverride || false,
      otpAuthorizedBy: o.otpAuthorizedBy || null,
    };
  }
  return lookup;
}

function _enrichUnconfirmedOrders(unconfirmedOrders, lookup) {
  return (unconfirmedOrders || []).map((o) => ({
    ...o,
    ...(lookup[o.platformOrderReference] || {}),
  }));
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

  const submitterId = body.user.id;
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
        userId: submitterId,
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
  order.paymentStatus = "verifying";
  order.parsedByInitial = extractInitial(rawText);
  order.parsedBy = resolveParsedBy(order.parsedByInitial, submitterId);
  const blocks = buildReviewOrderBlocks(order);

  if (loading.ts) {
    await client.chat.update({
      channel: channelId,
      ts: loading.ts,
      text: "Review Order",
      blocks,
    });
    saveOrder(channelId, loading.ts, order);
    verifyPaymentBackground(client, order, channelId, loading.ts);
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
        userId: event.user,
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
  order.paymentStatus = "verifying";
  order.parsedByInitial = extractInitial(rawText);
  order.parsedBy = resolveParsedBy(order.parsedByInitial, event.user);
  const blocks = buildReviewOrderBlocks(order);

  if (loading.ts) {
    await client.chat.update({
      channel: channelId,
      ts: loading.ts,
      text: "Review Order",
      blocks,
    });
    saveOrder(channelId, loading.ts, order);
    verifyPaymentBackground(client, order, channelId, loading.ts);
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

  const privateMetadata = JSON.stringify({ channelId, ts, threadTs: body.container.thread_ts || null });
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
  const nonSurge = (store.getCities().namedZones || []).filter((z) => !z.isSurge);

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
  const { channelId, ts, itemIndex, threadTs = null } = meta;
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
    await ephem(client, { channel: channelId, user: body.user.id, threadTs, text: "⚠️ Order state was lost (the bot may have restarted). Please re-paste the order message to start again." });
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
    await ephem(client, { channel: channelId, user: body.user.id, threadTs, text: "⚠️ That product could not be matched in the current catalogue (the list may have just refreshed). Please open the search again and re-select." });
    return;
  }

  const item = order.items.find((i) => i.index === itemIndex);
  if (!item) {
    console.error("[product-search-submit] item index not found in order", {
      itemIndex,
      items: order.items.map((i) => i.index),
    });
    await ephem(client, { channel: channelId, user: body.user.id, threadTs, text: "⚠️ Could not locate that item in the order. Please try again." });
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

  const privateMetadata = JSON.stringify({ channelId, ts, threadTs: body.container.thread_ts || null });
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
  const pickupId =
    view.state.values.pickup_select?.pickup_input?.selected_option?.value;
  const addressText = (
    view.state.values.address_input?.address_text?.value || ""
  ).trim();

  if (namedZoneId) {
    const zone = getZoneById(namedZoneId);
    if (zone) {
      order.fulfillment.type = "delivery";
      order.fulfillment.zoneId = zone.id;
      order.fulfillment.zoneName = zone.name;
      order.fulfillment.branch = zone.branch;
      order.fulfillment.fee = zone.price;
      order.fulfillment.resolved = true;
    }
  } else if (rideHailId) {
    const tier = (store.getCities().rideHailTiers || []).find((t) => t.id === rideHailId);
    if (tier) {
      order.fulfillment.type = "delivery";
      order.fulfillment.zoneId = tier.id;
      order.fulfillment.zoneName = tier.name;
      order.fulfillment.fee = tier.price;
      order.fulfillment.branch = tier.branch;
      order.fulfillment.resolved = true;
    }
  } else if (pickupId) {
    const row = (store.getCities().pickupRows || []).find((r) => r.id === pickupId);
    if (row) {
      order.fulfillment.type = "pickup";
      order.fulfillment.zoneId = row.id;
      order.fulfillment.zoneName = row.name;
      // Derive branch from the row name directly — API may not set closestStore on pickup rows
      order.fulfillment.branch = /opebi/i.test(row.name) ? "Opebi"
        : /mainland/i.test(row.name) ? "Mainland"
        : "Lekki";
      order.fulfillment.fee = 0;
      order.fulfillment.resolved = true;
    }
  }

  // Zone/city changes almost always mean the address changes too —
  // apply whatever the CSR typed (or cleared) in the address field.
  order.fulfillment.address = addressText || null;

  reReconcile(order);
  saveOrder(channelId, ts, order);

  await client.chat.update({
    channel: channelId,
    ts,
    text: "Review Order",
    blocks: buildReviewOrderBlocks(order),
  });
}

// ── Date picker: open modal to set/change delivery date ──────────────────────

async function handleChangeDateBtn({ ack, body, client }) {
  await ack();
  const channelId = body.container.channel_id;
  const ts = body.container.message_ts;
  const order = getOrder(channelId, ts);

  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildDatePickerModal(
      JSON.stringify({ channelId, ts }),
      order?.scheduledDate || null,
    ),
  });
}

// ── Date picker submitted → update order.scheduledDate ────────────────────────

async function handleDatePickerSubmit({ ack, body, view, client }) {
  await ack({ response_action: "clear" });

  const meta = JSON.parse(view.private_metadata || "{}");
  const { channelId, ts } = meta;
  const selectedDate =
    view.state.values.delivery_date_block?.date_pick?.selected_date || null;

  const order = getOrder(channelId, ts);
  if (!order) return;

  order.scheduledDate = selectedDate;
  saveOrder(channelId, ts, order);

  await client.chat.update({
    channel: channelId,
    ts,
    text: "Review Order",
    blocks: buildReviewOrderBlocks(order),
  });
}

// ── Shared: push a confirmed order to Zupa and update the message ────────────

// Fire-and-forget: run payment verification in background, then re-render the review
function verifyPaymentBackground(client, order, channelId, ts) {
  // receiptName: name as it appears on the bank transfer — takes priority for payment matching.
  // Zupa payload is unaffected; this is lookup-only.
  const customerName = order.receiptName || order.customer?.name || "";
  const recipientName = order.receiptName
    ? (order.recipient?.name || order.customer?.name || customerName)
    : (order.recipient?.name || customerName);

  verifyPayment(customerName, recipientName, order.orderTotal, {
    deliveryPrice: order.fulfillment?.fee,
    couponCode: order.couponCode,
  })
    .then((match) => {
      const current = getOrder(channelId, ts);
      if (!current) return; // order was confirmed/rejected before we finished
      if (match) {
        current.paymentStatus = "verified";
        current.paymentData = match;
      } else {
        current.paymentStatus = "not_found";
      }
      saveOrder(channelId, ts, current);
      return client.chat.update({
        channel: channelId,
        ts,
        text: "Review Order",
        blocks: buildReviewOrderBlocks(current),
      });
    })
    .catch((err) => {
      const current = getOrder(channelId, ts);
      if (!current) return;
      current.paymentStatus = "error";
      current.paymentError = err.message;
      saveOrder(channelId, ts, current);
      return client.chat
        .update({
          channel: channelId,
          ts,
          text: "Review Order",
          blocks: buildReviewOrderBlocks(current),
        })
        .catch(() => {});
    });
}

async function executePush(order, confirmedBy, channelId, ts, client, threadTs = null) {
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
    await ephem(client, { channel: channelId, user: confirmedBy, threadTs, text: `❌ Zupa push failed: ${err.message}` });
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
  saveConfirmedOrder(channelId, order.slackRootTs || ts, order, confirmedBy, {
    otpOverride: order.otpOverride || false,
    otpAuthorizedBy: order.otpAuthorizedBy || null,
  });
  deleteOrder(channelId, ts);

  await client.chat.update({
    channel: channelId,
    ts,
    text: `✅ Order confirmed${pushResult.orderNumber ? " · Zupa: " + pushResult.orderNumber : ""}${order.clientReference ? " · Ref: " + order.clientReference : ""}`,
    blocks: buildConfirmationBlocks(order, pushResult.orderNumber, confirmedBy),
  });

  // Update all managers' OTP Slack messages to show receipt is still pending.
  if (order.otpOverride && order.otpSlackMessages?.length > 0) {
    const newBlocks = await _updateOtpMessageStatus(client, order, "⏳  *Receipt not yet linked*");
    if (newBlocks) {
      order.otpSlackBlocks = newBlocks;
      updateConfirmedOrder(channelId, order.slackRootTs || ts, order);
    }
  }
}

// ── Confirm order ────────────────────────────────────────────────────────────

async function handleConfirmOrder({ ack, body, action, client }) {
  await ack();

  const channelId = body.container.channel_id;
  const ts = body.container.message_ts;
  const threadTs = body.container.thread_ts || null;
  const order = getOrder(channelId, ts);
  if (!order) {
    await ephem(client, { channel: channelId, user: body.user.id, threadTs, text: "⚠️ Order state not found. The bot may have restarted. Please re-parse the order." });
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
    await ephem(client, { channel: channelId, user: body.user.id, threadTs, text: `⚠️ Cannot confirm yet: ${reasons.join(", ")}. Please resolve these first.` });
    return;
  }

  // ── Payment gate ────────────────────────────────────────────────────────────
  // OTP override set remotely (manager clicked Authorize in the Slack OTP notification)
  // bypasses all payment checks.
  if (order.otpOverride) {
    await executePush(order, body.user.id, channelId, ts, client, threadTs);
    return;
  }

  // paymentStatus is set by the background check that runs right after parsing.
  // If somehow the check is still running (very fast click) or errored, fall back
  // to a synchronous call so we never block the confirm flow.
  const paymentStatus = order.paymentStatus;

  if (paymentStatus === "verified") {
    await executePush(order, body.user.id, channelId, ts, client, threadTs);
  } else if (paymentStatus === "not_found") {
    await client.chat.update({
      channel: channelId,
      ts,
      text: "No matching payment found — override required",
      blocks: buildPaymentNotFoundBlocks(order),
    });
  } else {
    // 'verifying', 'error', or undefined — run synchronously as fallback
    let paymentMatch;
    try {
      const customerName = order.customer?.name || "";
      const recipientName = order.recipient?.name || customerName;
      paymentMatch = await verifyPayment(
        customerName,
        recipientName,
        order.orderTotal,
        { deliveryPrice: order.fulfillment?.fee, couponCode: order.couponCode },
      );
    } catch (err) {
      console.log(`error verifying payment ${err}`);
      await ephem(client, { channel: channelId, user: body.user.id, threadTs, text: `⚠️ Payment verification error: ${err.message}` });
      return;
    }

    if (paymentMatch) {
      await executePush(order, body.user.id, channelId, ts, client, threadTs);
    } else {
      await client.chat.update({
        channel: channelId,
        ts,
        text: "No matching payment found — override required",
        blocks: buildPaymentNotFoundBlocks(order),
      });
    }
  }
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
  order.paymentStatus = "verifying";
  order.parsedByInitial = extractInitial(pending.rawText);
  order.parsedBy = resolveParsedBy(order.parsedByInitial, pending.userId);
  const blocks = buildReviewOrderBlocks(order);

  await client.chat.update({
    channel: channelId,
    ts: warningTs,
    text: "Review Order",
    blocks,
  });
  saveOrder(channelId, warningTs, order);
  verifyPaymentBackground(client, order, channelId, warningTs);
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

// ── Shared: push a confirmed-order modification to Zupa and update message ────

async function applyModification(client, channelId, modMessageTs, modifiedBy) {
  const modState = modStateMap.get(stateKey(channelId, modMessageTs));
  if (!modState) return;

  const { threadTs, confirmedOrder, mod } = modState;

  await client.chat.update({
    channel: channelId,
    ts: modMessageTs,
    text: "Applying modification…",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: ":hourglass_flowing_sand: *Applying modification…*" } }],
  });

  try {
    await pushModification(confirmedOrder, mod, modifiedBy);
  } catch (err) {
    await client.chat.update({
      channel: channelId,
      ts: modMessageTs,
      text: "Modification failed",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `❌ *Modification failed:* ${err.message}` } },
        { type: "section", text: { type: "mrkdwn", text: "_Reply in this thread again to retry._" } },
      ],
    });
    return;
  }

  modStateMap.delete(stateKey(channelId, modMessageTs));

  // Apply changes to stored order so future mods have accurate state
  if (mod.newName) confirmedOrder.customer.name = mod.newName;
  if (mod.newPhone) confirmedOrder.customer.phone = mod.newPhone;
  if (mod.addItems.length > 0) confirmedOrder.items.push(...mod.addItems);
  if (mod.removeItems.length > 0) {
    const removedIds = new Set(mod.removeItems.map((i) => i.sizeId));
    confirmedOrder.items = confirmedOrder.items.filter((i) => !removedIds.has(i.sizeId));
  }
  if (mod.newZoneId) {
    confirmedOrder.fulfillment.zoneId = mod.newZoneId;
    confirmedOrder.fulfillment.zoneName = mod.newZoneName;
    confirmedOrder.fulfillment.branch = mod.newBranch;
    confirmedOrder.fulfillment.fee = mod.newFee;
    confirmedOrder.fulfillment.address = mod.newAddress;
  }
  if (mod.newScheduledDate) confirmedOrder.scheduledDate = mod.newScheduledDate;
  if (mod.newRecipient && (mod.newRecipient.name || mod.newRecipient.phone)) {
    confirmedOrder.recipient = mod.newRecipient;
  }
  updateConfirmedOrder(channelId, threadTs, confirmedOrder);

  const nameLine = mod.newName ? `  👤  Name: ${mod.newName}` : null;
  const phoneLine = mod.newPhone ? `  📱  Phone: ${mod.newPhone}` : null;
  const addedLines = mod.addItems.map((i) => `  ➕  ${i.productName} · ${i.sizeName} ×${i.qty} — ${fmt(i.lineTotal)}`);
  const removedLines = mod.removeItems.map((i) => `  ➖  ${i.productName} · ${i.sizeName} ×${i.qty}`);
  const addressLine = mod.newZoneId
    ? `  📍  ${confirmedOrder.fulfillment.address}  ·  ${confirmedOrder.fulfillment.zoneName}  (${fmt(confirmedOrder.fulfillment.fee)})`
    : null;
  const dateLine = mod.newScheduledDate ? `  📅  Delivery date: ${mod.newScheduledDate}` : null;
  const recipientLine = mod.newRecipient && (mod.newRecipient.name || mod.newRecipient.phone)
    ? `  📦  Recipient: ${[mod.newRecipient.name, mod.newRecipient.phone].filter(Boolean).join("  ·  ")}`
    : null;
  const paymentLine = mod.otpOverride
    ? `  🔐  Payment override (OTP)`
    : mod.paymentData?.transactionRef
      ? `  ✅  Payment verified — Ref: \`${mod.paymentData.transactionRef}\``
      : null;
  const summary = [nameLine, phoneLine, recipientLine, ...addedLines, ...removedLines, addressLine, dateLine, paymentLine]
    .filter(Boolean)
    .join("\n");

  await client.chat.update({
    channel: channelId,
    ts: modMessageTs,
    text: "Modification applied",
    blocks: [{
      type: "section",
      text: { type: "mrkdwn", text: `✅ *Modification applied by <@${modifiedBy}>*\nOrder \`${confirmedOrder.orderNumber}\`\n${summary}` },
    }],
  });
}

// ── Compute net amount increase for a modification ────────────────────────────

function computeModIncrease(mod, confirmedOrder) {
  // Baseline: what the customer has already paid (never updated after mods).
  const originalPayment = confirmedOrder.orderTotal || 0;

  // Current confirmed items total (reflects all previous mods applied to items).
  const currentItemsTotal = (confirmedOrder.items || []).reduce((s, i) => s + (i.lineTotal || 0), 0);

  // Items being removed in this mod — use confirmed order's lineTotal for accuracy.
  const removedSizeIds = new Set(mod.removeItems.map((i) => i.sizeId));
  const removedTotal = (confirmedOrder.items || [])
    .filter((i) => removedSizeIds.has(i.sizeId))
    .reduce((s, i) => s + (i.lineTotal || 0), 0);

  const addedTotal = mod.addItems.reduce((s, i) => s + (i.lineTotal || 0), 0);
  const newFee = mod.newZoneId ? (mod.newFee || 0) : (confirmedOrder.fulfillment?.fee || 0);

  const proposedTotal = currentItemsTotal - removedTotal + addedTotal + newFee;

  // Only require payment for the amount above what was originally paid.
  return Math.max(0, proposedTotal - originalPayment);
}

async function handleModConfirm({ ack, body, client }) {
  await ack();

  const channelId = body.container.channel_id;
  const modMessageTs = body.container.message_ts;
  const threadTs = body.container.thread_ts || null;
  const modState = modStateMap.get(stateKey(channelId, modMessageTs));
  if (!modState) return;

  const { confirmedOrder, mod } = modState;
  const modifiedBy = body.user.id;

  const modIncrease = computeModIncrease(mod, confirmedOrder);

  if (modIncrease > 0) {
    const customerName = confirmedOrder.receiptName || confirmedOrder.customer?.name || "";
    const recipientName = confirmedOrder.receiptName
      ? (confirmedOrder.recipient?.name || confirmedOrder.customer?.name || customerName)
      : (confirmedOrder.recipient?.name || customerName);

    let paymentMatch;
    try {
      paymentMatch = await verifyPayment(customerName, recipientName, modIncrease);
    } catch (err) {
      await ephem(client, { channel: channelId, user: modifiedBy, threadTs, text: `⚠️ Payment verification error: ${err.message}` });
      return;
    }

    if (!paymentMatch) {
      mod.paymentStatus = "not_found";
      mod.modIncrease = modIncrease;
      await client.chat.update({
        channel: channelId,
        ts: modMessageTs,
        text: "Order Modification — Payment Required",
        blocks: buildModReviewBlocks(mod, confirmedOrder),
      });
      return;
    }

    mod.paymentData = paymentMatch;
  }

  await applyModification(client, channelId, modMessageTs, modifiedBy);
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

  const orderItem = (modState.confirmedOrder.items || []).find(
    (oi) => oi.sizeId === sizeId,
  );
  if (!orderItem) return;

  modState.mod.removeItems[idx] = {
    productName: orderItem.productName,
    sizeName: orderItem.sizeName,
    sizeId: orderItem.sizeId,
    qty: orderItem.qty,
    unitPrice: orderItem.unitPrice,
    lineTotal: orderItem.lineTotal,
    candidates: item.candidates || [],
  };

  await client.chat.update({
    channel: channelId,
    ts: modMessageTs,
    text: "Order Modification",
    blocks: buildModReviewBlocks(modState.mod, modState.confirmedOrder),
  });
}

// ── Mod: open full catalog search modal for an add item ──────────────────────

async function handleModAddSearchBtn({ ack, body, client }) {
  await ack();
  const action = body.actions[0];
  const value = action.value || "";

  const channelId = body.container.channel_id;
  const modMessageTs = body.container.message_ts;

  const isUnresolved = value.startsWith("u_");
  const idx = parseInt(isUnresolved ? value.slice(2) : value, 10);

  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildModAddSearchModal({
      channelId,
      modMessageTs,
      idx,
      isUnresolved,
      threadTs: body.container.thread_ts || null,
    }),
  });
}

// ── Mod: full catalog search modal submitted → update add item ────────────────

async function handleModAddSearchModalSubmit({ ack, body, view, client }) {
  await ack({ response_action: "clear" });

  const meta = JSON.parse(view.private_metadata || "{}");
  const { channelId, modMessageTs, idx, isUnresolved, threadTs = null } = meta;
  const selectedSizeId =
    view.state.values.product_select.product_search_select.selected_option
      ?.value;
  if (!selectedSizeId) return;

  const modState = modStateMap.get(stateKey(channelId, modMessageTs));
  if (!modState) {
    await ephem(client, { channel: channelId, user: body.user.id, threadTs, text: "⚠️ Modification state was lost (the bot may have restarted). Please re-send the modification request." });
    return;
  }

  let found = null;
  for (const product of getProductIndex()) {
    const size = (product.sizes || []).find(
      (s) => s && s.id === selectedSizeId,
    );
    if (size) {
      found = { product, size };
      break;
    }
  }
  if (!found) {
    await ephem(client, { channel: channelId, user: body.user.id, threadTs, text: "⚠️ That product could not be matched in the current catalogue. Please try searching again." });
    return;
  }

  const newItem = {
    productName: found.product.name,
    sizeName: found.size.name,
    sizeId: found.size.id,
    qty: 1,
    unitPrice: found.size.price,
    lineTotal: found.size.price,
    candidates: [],
  };

  if (isUnresolved) {
    modState.mod.unresolvedAdditions.splice(idx, 1);
    modState.mod.addItems.push(newItem);
  } else {
    const existing = modState.mod.addItems[idx];
    if (existing) {
      newItem.qty = existing.qty;
      newItem.lineTotal = found.size.price * existing.qty;
    }
    modState.mod.addItems[idx] = newItem;
  }

  await client.chat.update({
    channel: channelId,
    ts: modMessageTs,
    text: "Order Modification",
    blocks: buildModReviewBlocks(modState.mod, modState.confirmedOrder),
  });
}

// ── Mod: pick order item to remove for unresolved removal ────────────────────

async function handleModRemoveUnresolvedPick({ ack, body, client }) {
  await ack();
  const action = body.actions[0];
  const sizeId = action.selected_option.value;
  const idx = parseInt((action.block_id || "").split("_").pop(), 10);

  const channelId = body.container.channel_id;
  const modMessageTs = body.container.message_ts;
  const modState = modStateMap.get(stateKey(channelId, modMessageTs));
  if (!modState) return;

  const orderItem = (modState.confirmedOrder.items || []).find(
    (oi) => oi.sizeId === sizeId,
  );
  if (!orderItem) return;

  modState.mod.unresolvedRemovals.splice(idx, 1);
  modState.mod.removeItems.push({
    productName: orderItem.productName,
    sizeName: orderItem.sizeName,
    sizeId: orderItem.sizeId,
    qty: orderItem.qty,
    unitPrice: orderItem.unitPrice,
    lineTotal: orderItem.lineTotal,
    candidates: [],
  });

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

// ── Mod: open city picker modal ───────────────────────────────────────────────

async function handleModCityPickerBtn({ ack, body, client }) {
  await ack();

  const channelId = body.container.channel_id;
  const modMessageTs = body.container.message_ts;
  const modState = modStateMap.get(stateKey(channelId, modMessageTs));
  const currentAddress = modState
    ? modState.mod.newAddress ||
      modState.confirmedOrder.fulfillment?.address ||
      modState.confirmedOrder.fulfillment?.zoneName ||
      ""
    : "";

  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildModCityPickerModal(
      JSON.stringify({ channelId, modMessageTs, threadTs: body.container.thread_ts || null }),
      currentAddress,
    ),
  });
}

// ── Mod: city picker submitted ────────────────────────────────────────────────

async function handleModCityPickerSubmit({ ack, body, view, client }) {
  await ack({ response_action: "clear" });

  const meta = JSON.parse(view.private_metadata || "{}");
  const { channelId, modMessageTs } = meta;
  const modState = modStateMap.get(stateKey(channelId, modMessageTs));
  if (!modState) return;

  const namedZoneId = view.state.values.mod_named_zone_select?.mod_zone_search_select?.selected_option?.value;
  const rideHailId  = view.state.values.mod_ride_hail_select?.mod_ride_hail_input?.selected_option?.value;
  const pickupId    = view.state.values.mod_pickup_select?.mod_pickup_input?.selected_option?.value;
  const addressText = (
    view.state.values.mod_address_input?.mod_address_text?.value || ""
  ).trim();

  const cities = store.getCities();

  if (namedZoneId) {
    const zone = getZoneById(namedZoneId);
    if (zone) {
      modState.mod.newZoneId   = zone.id;
      modState.mod.newZoneName = zone.name;
      modState.mod.newBranch   = zone.branch;
      modState.mod.newFee      = zone.price;
      modState.mod.newAddress  = addressText || zone.name;
    }
  } else if (rideHailId) {
    const tier = (cities.rideHailTiers || []).find((t) => t.id === rideHailId);
    if (tier) {
      modState.mod.newZoneId   = tier.id;
      modState.mod.newZoneName = tier.name;
      modState.mod.newBranch   = tier.branch;
      modState.mod.newFee      = tier.price;
      modState.mod.newAddress  = addressText || tier.name;
    }
  } else if (pickupId) {
    const row = (cities.pickupRows || []).find((r) => r.id === pickupId);
    if (row) {
      modState.mod.newZoneId   = row.id;
      modState.mod.newZoneName = row.name;
      modState.mod.newBranch   = /opebi/i.test(row.name) ? "Opebi" : /mainland/i.test(row.name) ? "Mainland" : "Lekki";
      modState.mod.newFee      = 0;
      modState.mod.newAddress  = addressText || row.name;
    }
  } else {
    return; // nothing selected
  }

  // Reset payment gate if fee changed — user must re-confirm
  delete modState.mod.paymentStatus;
  delete modState.mod.modIncrease;

  await client.chat.update({
    channel: channelId,
    ts: modMessageTs,
    text: "Order Modification",
    blocks: buildModReviewBlocks(modState.mod, modState.confirmedOrder),
  });
}

// ── Mod: payment gate — Try Different Name ────────────────────────────────────

async function handleModTryPaymentName({ ack, body, client }) {
  await ack();

  const channelId   = body.container.channel_id;
  const modMessageTs = body.container.message_ts;
  const threadTs     = body.container.thread_ts || null;

  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildPaymentNameModal(
      JSON.stringify({ context: "mod", channelId, modMessageTs, confirmedBy: body.user.id, threadTs }),
    ),
  });
}

// ── Mod: payment gate — Request / Resend OTP ──────────────────────────────────

async function handleModRequestOtp({ ack, body, client }) {
  await ack();

  const channelId    = body.container.channel_id;
  const modMessageTs = body.container.message_ts;
  const threadTs     = body.container.thread_ts || null;
  const modState     = modStateMap.get(stateKey(channelId, modMessageTs));
  if (!modState) return;

  const { confirmedOrder, mod } = modState;

  // Pass a synthetic order so the WhatsApp message shows the top-up amount and added items
  const otpOrder = {
    customer:    confirmedOrder.customer,
    recipient:   confirmedOrder.recipient,
    orderTotal:  mod.modIncrease,
    items:       mod.addItems,
  };

  let slackThreadLink = null;
  try {
    const pl = await client.chat.getPermalink({ channel: channelId, message_ts: modMessageTs });
    if (pl.ok) slackThreadLink = pl.permalink;
  } catch (_) {}

  try {
    await requestOverrideOtp(confirmedOrder.clientReference, otpOrder, slackThreadLink);
  } catch (err) {
    await ephem(client, { channel: channelId, user: body.user.id, threadTs, text: `⚠️ Could not send OTP: ${err.message}` });
    return;
  }

  mod.paymentStatus = "otp_pending";
  await client.chat.update({
    channel: channelId,
    ts: modMessageTs,
    text: "Order Modification — OTP Pending",
    blocks: buildModReviewBlocks(mod, confirmedOrder),
  });

  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildOtpModal(
      JSON.stringify({ context: "mod", channelId, modMessageTs, confirmedBy: body.user.id, threadTs, slackThreadLink }),
    ),
  });
}

// ── Mod: Enter OTP — reopen modal without resending (mobile fix) ──────────────

async function handleModEnterOtp({ ack, body, client }) {
  await ack();

  const channelId    = body.container.channel_id;
  const modMessageTs = body.container.message_ts;

  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildOtpModal(
      JSON.stringify({ context: "mod", channelId, modMessageTs, confirmedBy: body.user.id, threadTs: body.container.thread_ts || null }),
    ),
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
  const cities = store.getCities();
  const zones = (cities.namedZones || []).filter((z) => !z.isSurge);
  const rideHailTiers = cities.rideHailTiers || [];
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

// ── /daily-summary command ────────────────────────────────────────────────────

async function handleDailySummaryCommand({ command, ack, client }) {
  await ack();

  const channelId = command.channel_id;
  const userId = command.user_id;

  try {
    const arg = (command.text || "").trim();
    const offsetDays = /^-?\d+$/.test(arg) ? parseInt(arg, 10) : 0;

    const lagosDate = (off) =>
      new Date(Date.now() + off * 86_400_000).toLocaleDateString("en-CA", {
        timeZone: "Africa/Lagos",
      });

    const dateLabel = new Date(
      Date.now() + offsetDays * 86_400_000,
    ).toLocaleDateString("en-NG", {
      timeZone: "Africa/Lagos",
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    // Fetch kitchen data and CSR orders in parallel
    const [kitchenData, yesterdayData, allOrders] = await Promise.all([
      fetchKitchenSummary(lagosDate(offsetDays), lagosDate(offsetDays)).catch(
        (err) => {
          console.error("[daily-summary] Kitchen API:", err.message);
          return null;
        },
      ),
      fetchKitchenSummary(
        lagosDate(offsetDays - 1),
        lagosDate(offsetDays - 1),
      ).catch(() => null),
      Promise.resolve(getAllOrdersToday(offsetDays)),
    ]);

    const channelOrders = allOrders.filter((o) => o._channelId === channelId);

    if (!kitchenData && channelOrders.length === 0) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: `📊 No data available for ${dateLabel}.`,
      });
      return;
    }

    const posted = await client.chat.postMessage({
      channel: channelId,
      text: `📊 Daily Operations Report — ${dateLabel}`,
      blocks: buildDailyReportBlocks(
        kitchenData,
        yesterdayData,
        channelOrders,
        dateLabel,
      ),
    });

    if (kitchenData?.unconfirmed?.total > 0 && posted.ts) {
      dailyReportStateMap.set(stateKey(channelId, posted.ts), {
        unconfirmed: kitchenData.unconfirmed,
        lookup: _buildClientRefLookup(allOrders),
        dateLabel,
      });
    }
  } catch (err) {
    console.error("[handleDailySummaryCommand]", err);
    await client.chat
      .postEphemeral({
        channel: channelId,
        user: userId,
        text: `❌ Could not generate summary: ${err.message}`,
      })
      .catch(() => {});
  }
}

// ── Daily report: view unconfirmed orders ─────────────────────────────────────

async function handleShowUnconfirmedOrders({ ack, body, client }) {
  await ack();

  const channelId = body.container.channel_id;
  const ts = body.container.message_ts;
  const state = dailyReportStateMap.get(stateKey(channelId, ts));

  if (!state) {
    await ephem(client, {
      channel: channelId,
      user: body.user.id,
      text: "⚠️ This report has expired (bot may have restarted). Please rerun /daily-summary.",
    });
    return;
  }

  const enriched = _enrichUnconfirmedOrders(state.unconfirmed.orders, state.lookup);
  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildUnconfirmedOrdersModal(
      JSON.stringify({ channelId, reportTs: ts }),
      state.unconfirmed,
      enriched,
      state.dateLabel,
    ),
  });
}

async function handleUnconfirmedOrdersPost({ ack, body, view, client }) {
  await ack({ response_action: "clear" });

  const { channelId, reportTs } = JSON.parse(view.private_metadata || "{}");
  const state = dailyReportStateMap.get(stateKey(channelId, reportTs));

  if (!state) {
    await ephem(client, {
      channel: channelId,
      user: body.user.id,
      text: "⚠️ This report has expired (bot may have restarted). Please rerun /daily-summary.",
    });
    return;
  }

  const enriched = _enrichUnconfirmedOrders(state.unconfirmed.orders, state.lookup);
  await client.chat.postMessage({
    channel: channelId,
    thread_ts: reportTs,
    text: `📋 Unconfirmed Orders — ${state.dateLabel}`,
    blocks: buildUnconfirmedOrdersBlocks(state.unconfirmed, enriched, state.dateLabel),
  });
}

// ── /weekly-summary ───────────────────────────────────────────────────────────

async function handleWeeklySummaryCommand({ command, ack, client }) {
  await ack();
  const channelId = command.channel_id;
  const userId = command.user_id;
  try {
    const lagosDate = (off) =>
      new Date(Date.now() + off * 86_400_000).toLocaleDateString("en-CA", {
        timeZone: "Africa/Lagos",
      });

    const [y, m, d] = lagosDate(0).split("-").map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const daysFromMonday = dow === 0 ? 6 : dow - 1;

    const thisStart = lagosDate(-daysFromMonday);
    const thisEnd = lagosDate(0);
    const prevStart = lagosDate(-daysFromMonday - 7);
    const prevEnd = lagosDate(-7);

    const { startMs, endMs } = lagosWeekBounds();
    const allOrders = getOrdersForPeriod(startMs, endMs);
    const otpOrders = getOtpOverridesForPeriod(startMs, endMs);
    const channelOrders = allOrders.filter((o) => o._channelId === channelId);

    const mondayUtc = new Date(Date.UTC(y, m - 1, d - daysFromMonday));
    const thursday = new Date(mondayUtc.getTime() + 3 * 86_400_000);
    const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil(((thursday - yearStart) / 86_400_000 + 1) / 7);
    const endStr = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-NG", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    const periodLabel = `Week ${weekNum}  ·  Ending ${endStr}`;

    const [kitchenData, prevData] = await Promise.all([
      fetchKitchenSummary(thisStart, thisEnd).catch((err) => {
        console.error("[weekly-summary] Kitchen API:", err.message);
        return null;
      }),
      fetchKitchenSummary(prevStart, prevEnd).catch(() => null),
    ]);

    if (!kitchenData && channelOrders.length === 0) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: `📊 No data available for ${periodLabel}.`,
      });
      return;
    }

    await client.chat.postMessage({
      channel: channelId,
      text: `📊 Weekly Operations Report — ${periodLabel}`,
      blocks: buildWeeklyReportBlocks(
        kitchenData,
        prevData,
        channelOrders,
        otpOrders,
        periodLabel,
      ),
    });
  } catch (err) {
    console.error("[handleWeeklySummaryCommand]", err);
    await client.chat
      .postEphemeral({
        channel: channelId,
        user: userId,
        text: `❌ Could not generate report: ${err.message}`,
      })
      .catch(() => {});
  }
}

// ── /monthly-summary ──────────────────────────────────────────────────────────

async function handleMonthlySummaryCommand({ command, ack, client }) {
  await ack();
  const channelId = command.channel_id;
  const userId = command.user_id;
  try {
    const lagosDate = (off) =>
      new Date(Date.now() + off * 86_400_000).toLocaleDateString("en-CA", {
        timeZone: "Africa/Lagos",
      });

    const [year, month] = lagosDate(0).split("-").map(Number);
    const thisStart = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
    const thisEnd = lagosDate(0);

    const lastMonthDate = new Date(Date.UTC(year, month - 2, 1));
    const lmy = lastMonthDate.getUTCFullYear();
    const lmm = lastMonthDate.getUTCMonth() + 1;
    const prevStart = `${String(lmy).padStart(4, "0")}-${String(lmm).padStart(2, "0")}-01`;
    const lastDay = new Date(Date.UTC(year, month - 1, 0));
    const prevEnd = lastDay.toLocaleDateString("en-CA", { timeZone: "UTC" });

    const { startMs, endMs } = lagosMonthBounds();
    const allOrders = getOrdersForPeriod(startMs, endMs);
    const channelOrders = allOrders.filter((o) => o._channelId === channelId);

    const monthLabel = new Date(
      Date.UTC(year, month - 1, 1),
    ).toLocaleDateString("en-NG", { month: "long", year: "numeric" });
    const dateLabel = new Date().toLocaleDateString("en-NG", {
      timeZone: "Africa/Lagos",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const periodLabel = `${monthLabel}  ·  ${dateLabel}`;

    const [kitchenData, prevData] = await Promise.all([
      fetchKitchenSummary(thisStart, thisEnd).catch((err) => {
        console.error("[monthly-summary] Kitchen API:", err.message);
        return null;
      }),
      fetchKitchenSummary(prevStart, prevEnd).catch(() => null),
    ]);

    if (!kitchenData && channelOrders.length === 0) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: `📊 No data available for ${periodLabel}.`,
      });
      return;
    }

    await client.chat.postMessage({
      channel: channelId,
      text: `📊 Monthly Operations Report — ${monthLabel}`,
      blocks: buildMonthlyReportBlocks(
        kitchenData,
        prevData,
        channelOrders,
        periodLabel,
      ),
    });
  } catch (err) {
    console.error("[handleMonthlySummaryCommand]", err);
    await client.chat
      .postEphemeral({
        channel: channelId,
        user: userId,
        text: `❌ Could not generate report: ${err.message}`,
      })
      .catch(() => {});
  }
}

// ── /refresh-products ────────────────────────────────────────────────────────

// ── /availability command ─────────────────────────────────────────────────────

function _formatProductForCopy(product) {
  const lines = (product.sizes || [])
    .filter(Boolean)
    .map((s) => {
      const branches = Object.values(s.availableQuantity || {});
      const qty =
        branches.length === 0
          ? "—"
          : branches.map((b) => `${b.branchName}: ${b.quantity}`).join(" · ");
      return `• ${s.name} (${fmt(s.price)}): ${qty}`;
    })
    .join("\n");
  return `*${product.name}*\n${lines}`;
}

// Splits a long string into chunks of maxLen at natural newline boundaries.
function _splitIntoSections(text, maxLen = 2900) {
  const lines = text.split("\n");
  const sections = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLen) {
      if (current) sections.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) sections.push(current);
  return sections;
}

// Posts a dismissible ephemeral — user clicks "✕ Dismiss" and it deletes itself
// via the response_url that Slack injects into the action payload.
async function _postDismissibleEphemeral(client, channelId, userId, sections) {
  const contentBlocks = sections.map((text) => ({
    type: "section",
    text: { type: "mrkdwn", text },
  }));
  contentBlocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "✕  Dismiss" },
        action_id: "avail_dismiss_copy",
        style: "danger",
      },
    ],
  });
  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: "Availability data",
    blocks: contentBlocks,
  }).catch(() => {});
}

async function handleAvailabilityCommand({ command, ack, client }) {
  await ack();
  try {
    const products = await _fetchAvailability();
    const meta = JSON.stringify({
      channelId: command.channel_id,
      userId: command.user_id,
      query: "",
    });
    await client.views.open({
      trigger_id: command.trigger_id,
      view: buildAvailabilityModal(products, "", meta),
    });
  } catch (err) {
    console.error("[availability] Failed to fetch:", err.message);
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: "⚠️ Failed to load availability data. Please try again shortly.",
    });
  }
}

async function handleAvailabilitySearch({ ack, body, action, client }) {
  await ack();
  const query = action.value || "";
  let meta;
  try {
    meta = JSON.parse(body.view?.private_metadata || "{}");
  } catch {
    meta = {};
  }
  meta.query = query;
  try {
    const products = await _fetchAvailability();
    await client.views.update({
      view_id: body.view.id,
      view: buildAvailabilityModal(products, query, JSON.stringify(meta)),
    });
  } catch (err) {
    console.error("[availability] Search update failed:", err.message);
  }
}

async function handleAvailabilityCopyProduct({ ack, body, client }) {
  await ack();
  const productName = body.actions?.[0]?.value;
  let meta;
  try {
    meta = JSON.parse(body.view?.private_metadata || "{}");
  } catch {
    meta = {};
  }
  const { channelId, userId } = meta;
  if (!channelId || !userId || !productName) return;

  const products = await _fetchAvailability().catch(() => null);
  if (!products) return;
  const product = products.find((p) => p.name === productName);
  if (!product) return;

  const text = _formatProductForCopy(product);
  await _postDismissibleEphemeral(client, channelId, userId, [text]);
}

async function handleAvailabilityCopyAll({ ack, body, client }) {
  await ack();
  let meta;
  try {
    meta = JSON.parse(body.view?.private_metadata || "{}");
  } catch {
    meta = {};
  }
  const { channelId, userId, query } = meta;
  if (!channelId || !userId) return;

  const rawProducts = await _fetchAvailability().catch(() => null);
  if (!rawProducts) return;

  const filtered = applyAvailabilityFilter(rawProducts, query || "");
  if (filtered.length === 0) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: "_No available products to copy._",
    }).catch(() => {});
    return;
  }

  // Group by category, format as plain text
  const byCategory = new Map();
  for (const p of filtered) {
    const cat = p.category || "Products";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(p);
  }

  let fullText = "";
  for (const [cat, prods] of byCategory) {
    fullText += `*── ${cat} ──*\n`;
    for (const p of prods) {
      fullText += `${_formatProductForCopy(p)}\n\n`;
    }
  }

  const sections = _splitIntoSections(fullText.trim());
  // Stay under 50-block message limit: max 47 content sections + 1 actions block
  const capped = sections.slice(0, 47);
  if (sections.length > 47) {
    capped[capped.length - 1] += "\n\n_…list truncated_";
  }

  await _postDismissibleEphemeral(client, channelId, userId, capped);
}

async function handleAvailabilityDismiss({ ack, body }) {
  await ack();
  const responseUrl = body.response_url;
  if (!responseUrl) return;
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delete_original: true }),
  }).catch(() => {});
}

// ── Amount adjustment ─────────────────────────────────────────────────────────

async function handleAmountAdjust({ ack, body, client }) {
  await ack();
  const channelId = body.container.channel_id;
  const ts = body.container.message_ts;
  const threadTs = body.container.thread_ts || null;
  const order = getOrder(channelId, ts);
  if (!order) return;

  const meta = JSON.stringify({ channelId, ts, threadTs, confirmedBy: body.user.id });
  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildAmountAdjustModal(meta, order.orderTotal, PAYMENT_ADJUSTMENT_LIMIT),
  });
}

async function handleAmountAdjustSubmit({ ack, body, view, client }) {
  const rawInput = (
    view.state.values?.adjust_amount_block?.adjust_amount_input?.value || ""
  ).trim();
  const diff = parseFloat(rawInput.replace(/,/g, ""));

  if (isNaN(diff)) {
    await ack({
      response_action: "errors",
      errors: { adjust_amount_block: "Enter a valid number, e.g. -500 or 300" },
    });
    return;
  }
  if (Math.abs(diff) > PAYMENT_ADJUSTMENT_LIMIT) {
    await ack({
      response_action: "errors",
      errors: { adjust_amount_block: `Maximum allowed difference is ±${fmt(PAYMENT_ADJUSTMENT_LIMIT)}` },
    });
    return;
  }
  await ack();

  const { channelId, ts, threadTs = null, confirmedBy } = JSON.parse(
    view.private_metadata || "{}",
  );
  const order = getOrder(channelId, ts);
  if (!order) return;

  // formula: adjustedAmount = orderTotal - diff
  // e.g. orderTotal=10000, diff=-500 → sends 10500 (customer paid more)
  const adjustedAmount = order.orderTotal - diff;
  const customerName = order.receiptName || order.customer?.name || "";
  const recipientName = order.receiptName
    ? order.recipient?.name || order.customer?.name || customerName
    : order.recipient?.name || customerName;

  let match;
  try {
    match = await verifyPayment(customerName, recipientName, adjustedAmount);
  } catch (err) {
    await ephem(client, {
      channel: channelId, user: confirmedBy, threadTs,
      text: `⚠️ Payment verification error: ${err.message}`,
    });
    return;
  }

  if (match) {
    order.paymentStatus = "verified";
    order.paymentData = match;
  } else {
    order.paymentStatus = "not_found";
    await ephem(client, {
      channel: channelId, user: confirmedBy, threadTs,
      text: `⚠️ No payment found for adjusted amount *${fmt(adjustedAmount)}*. Try a different value or request an OTP.`,
    });
  }

  saveOrder(channelId, ts, order);
  await client.chat.update({
    channel: channelId,
    ts,
    text: "Review Order",
    blocks: buildReviewOrderBlocks(order),
  }).catch(() => {});
}

// ── /set-initial command ──────────────────────────────────────────────────────

async function handleSetInitialCommand({ command, ack, respond }) {
  await ack();
  const text = (command.text || "").trim();

  if (!text) {
    const all = getAllCsrInitials();
    if (all.length === 0) {
      await respond({ response_type: "ephemeral", text: "_No initials registered yet._\nUsage: `/set-initial BB Bimbo`" });
      return;
    }
    const lines = all.map((r) => `*#${r.initial}* → ${r.name}`).join("\n");
    await respond({ response_type: "ephemeral", text: `*Registered CSR Initials:*\n${lines}` });
    return;
  }

  const [initialRaw, ...nameParts] = text.split(/\s+/);
  const initial = initialRaw.toUpperCase();
  const name = nameParts.join(" ").trim();

  if (!/^[A-Z]{1,4}$/.test(initial)) {
    await respond({ response_type: "ephemeral", text: "⚠️ Invalid initial — use 1–4 letters only, e.g. `/set-initial BB Bimbo`" });
    return;
  }
  if (!name) {
    await respond({ response_type: "ephemeral", text: "⚠️ Please provide a name. Usage: `/set-initial BB Bimbo`" });
    return;
  }

  setCsrInitial(initial, name, command.user_id);
  await respond({
    response_type: "in_channel",
    text: `✅ *#${initial}* → *${name}* registered.`,
  });
}

async function handleRefreshProductsCommand({ command, ack, respond }) {
  await ack();
  try {
    const { productCount, zoneCount } = await forceRefresh();
    await respond({
      response_type: "in_channel",
      text: `✅ Product catalogue refreshed by <@${command.user_id}> — *${productCount} products* and *${zoneCount} delivery zones* loaded.`,
    });
  } catch (err) {
    console.error("[handleRefreshProductsCommand]", err);
    await respond({
      response_type: "ephemeral",
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

// ── Payment / OTP flow handlers ───────────────────────────────────────────────

async function handleRequestOtp({ ack, body, client }) {
  await ack();

  const channelId = body.container.channel_id;
  const ts = body.container.message_ts;
  const threadTs = body.container.thread_ts || null;
  const order = getOrder(channelId, ts);
  if (!order) return;

  // Fetch the Slack permalink so Zupa can add a "Go to thread" button in its OTP notification
  let slackThreadLink = null;
  try {
    const pl = await client.chat.getPermalink({ channel: channelId, message_ts: ts });
    if (pl.ok) slackThreadLink = pl.permalink;
  } catch (_) {}

  // Record who requested the OTP so the confirmation card shows the correct CSR
  // when the manager authorizes remotely instead of entering the code in the thread.
  order.otpRequestedBy = body.user.id;
  saveOrder(channelId, ts, order);

  let slackMessages = [];
  try {
    slackMessages = await requestOverrideOtp(order.clientReference, order, slackThreadLink);
  } catch (err) {
    await ephem(client, { channel: channelId, user: body.user.id, threadTs, text: `⚠️ Could not send OTP: ${err.message}` });
    return;
  }

  order.otpSlackMessages = slackMessages;
  saveOrder(channelId, ts, order);

  // Update message to OTP-pending state so mobile users can re-open the modal
  // without resending (Enter OTP button re-opens; Resend OTP button explicitly resends)
  await client.chat.update({
    channel: channelId,
    ts,
    text: "OTP sent — awaiting entry",
    blocks: buildOtpPendingBlocks(order),
  }).catch(() => {});

  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildOtpModal(
      JSON.stringify({ channelId, ts, confirmedBy: body.user.id, threadTs, slackThreadLink }),
    ),
  });
}

async function handleResendOtpModal({ ack, body, view, client }) {
  await ack();

  const meta = JSON.parse(view.private_metadata || "{}");
  const order = getOrder(meta.channelId, meta.ts);

  let notice;
  if (!order) {
    notice = "⚠️  Order not found — close this modal and re-parse the order.";
  } else {
    try {
      await requestOverrideOtp(order.clientReference, order, meta.slackThreadLink || null);
      notice =
        "✅  *OTP resent.* Enter the new 6-digit code sent to the operator.";
    } catch (err) {
      notice = `⚠️  *Could not resend OTP:* ${err.message}`;
    }
  }

  await client.views
    .update({
      view_id: view.id,
      view: buildOtpModal(view.private_metadata, { notice }),
    })
    .catch(() => {});
}

async function handleRefetchPayment({ ack, body, client }) {
  await ack();

  const channelId = body.container.channel_id;
  const ts = body.container.message_ts;
  const order = getOrder(channelId, ts);
  if (!order) return;

  order.paymentStatus = "verifying";
  delete order.paymentData;
  saveOrder(channelId, ts, order);

  await client.chat.update({
    channel: channelId,
    ts,
    text: "Review Order",
    blocks: buildReviewOrderBlocks(order),
  });

  verifyPaymentBackground(client, order, channelId, ts);
}

async function handleTryPaymentName({ ack, body, client }) {
  await ack();

  const channelId = body.container.channel_id;
  const ts = body.container.message_ts;

  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildPaymentNameModal(JSON.stringify({ channelId, ts, threadTs: body.container.thread_ts || null })),
  });
}

async function handlePaymentNameSubmit({ ack, body, view, client }) {
  const meta = JSON.parse(view.private_metadata || "{}");
  const { context, channelId, ts, modMessageTs, confirmedBy, threadTs = null } = meta;
  const paymentName = (
    view.state.values?.payment_name_block?.payment_name_input?.value || ""
  ).trim();

  // ── Mod context ──────────────────────────────────────────────────────────────
  if (context === "mod") {
    const modState = modStateMap.get(stateKey(channelId, modMessageTs));
    if (!modState) {
      await ack({ response_action: "errors", errors: { payment_name_block: "Modification state not found — please retry." } });
      return;
    }
    await ack();

    const { confirmedOrder, mod } = modState;
    let match;
    try {
      match = await verifyPayment(paymentName, paymentName, mod.modIncrease);
    } catch (err) {
      await ephem(client, { channel: channelId, user: body.user.id, threadTs, text: `⚠️ Payment check failed: ${err.message}` });
      return;
    }

    if (match) {
      mod.paymentData = match;
      delete mod.paymentStatus;
      await applyModification(client, channelId, modMessageTs, confirmedBy || body.user.id);
    } else {
      await ephem(client, { channel: channelId, user: body.user.id, threadTs, text: `⚠️ No payment found for *"${paymentName}"* either. Try another name or request an OTP.` });
    }
    return;
  }

  // ── Order context ─────────────────────────────────────────────────────────────
  const order = getOrder(channelId, ts);
  if (!order) {
    await ack({
      response_action: "errors",
      errors: {
        payment_name_block: "Order not found — please re-parse the order.",
      },
    });
    return;
  }

  await ack(); // close modal

  let match;
  try {
    match = await verifyPayment(paymentName, paymentName, order.orderTotal, {
      deliveryPrice: order.fulfillment?.fee,
      couponCode: order.couponCode,
    });
  } catch (err) {
    await ephem(client, { channel: channelId, user: body.user.id, threadTs, text: `⚠️ Payment check failed: ${err.message}` });
    return;
  }

  if (match) {
    order.paymentStatus = "verified";
    order.paymentData = match;
  } else {
    order.paymentStatus = "not_found";
    await ephem(client, { channel: channelId, user: body.user.id, threadTs, text: `⚠️ No payment found for *"${paymentName}"* either. Try another name or request an OTP.` });
  }

  saveOrder(channelId, ts, order);
  await client.chat
    .update({
      channel: channelId,
      ts,
      text: "Review Order",
      blocks: buildReviewOrderBlocks(order),
    })
    .catch(() => {});
}

async function handleEnterOtp({ ack, body, client }) {
  await ack();

  const channelId = body.container.channel_id;
  const ts = body.container.message_ts;
  const confirmedBy = body.user.id;

  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildOtpModal(JSON.stringify({ channelId, ts, confirmedBy, threadTs: body.container.thread_ts || null })),
  });
}

async function handleOtpVerifySubmit({ ack, body, view, client }) {
  const meta = JSON.parse(view.private_metadata || "{}");
  const { context, channelId, ts, modMessageTs, confirmedBy, threadTs = null } = meta;
  const otp = view.state.values?.otp_block?.otp_input?.value?.trim() || "";

  // ── Mod context ──────────────────────────────────────────────────────────────
  if (context === "mod") {
    const modState = modStateMap.get(stateKey(channelId, modMessageTs));
    if (!modState) {
      await ack({ response_action: "errors", errors: { otp_block: "Modification state not found — please retry." } });
      return;
    }

    try {
      await verifyOverrideOtp(modState.confirmedOrder.clientReference, otp);
    } catch (err) {
      const msg = err.message.includes("expired")
        ? "OTP has expired. Close this modal and request a new one."
        : err.message.includes("No OTP requested")
          ? 'No OTP was requested. Use the "Request Override OTP" button first.'
          : `Invalid OTP — ${err.message}`;
      await ack({ response_action: "errors", errors: { otp_block: msg } });
      return;
    }

    await ack();
    modState.mod.otpOverride = true;
    delete modState.mod.paymentStatus;
    await applyModification(client, channelId, modMessageTs, confirmedBy || body.user.id);
    return;
  }

  // ── Order context ─────────────────────────────────────────────────────────────
  const order = getOrder(channelId, ts);

  if (!order) {
    await ack({
      response_action: "errors",
      errors: {
        otp_block: "Order state not found — please re-parse the order.",
      },
    });
    return;
  }

  try {
    await verifyOverrideOtp(order.clientReference, otp);
  } catch (err) {
    const msg = err.message.includes("expired")
      ? "OTP has expired. Close this modal and request a new one."
      : err.message.includes("No OTP requested")
        ? 'No OTP was requested for this order. Use the "Request Override OTP" button first.'
        : `Invalid OTP — ${err.message}`;
    await ack({ response_action: "errors", errors: { otp_block: msg } });
    return;
  }

  await ack();
  order.otpOverride = true;
  order.otpAuthorizedBy = confirmedBy;
  await executePush(order, confirmedBy, channelId, ts, client, threadTs);
}

async function handleBackToReview({ ack, body, client }) {
  await ack();

  const channelId = body.container.channel_id;
  const ts = body.container.message_ts;
  const order = getOrder(channelId, ts);
  if (!order) return;

  await client.chat.update({
    channel: channelId,
    ts,
    text: "Review Order",
    blocks: buildReviewOrderBlocks(order),
  });
}

// ── OTP remote authorization ──────────────────────────────────────────────────

function findOrderByClientRef(clientReference) {
  for (const [key, order] of orderStateMap.entries()) {
    if (order.clientReference === clientReference) {
      const colonIdx = key.indexOf(':');
      return { channelId: key.slice(0, colonIdx), ts: key.slice(colonIdx + 1), order };
    }
  }
  return null;
}

async function handleOtpAuthorize({ ack, body, client }) {
  await ack();

  const clientReference = body.actions?.[0]?.value;
  const authorizerId = body.user.id;
  const otpChannelId = body.channel?.id;
  const otpMessageTs = body.message?.ts;

  if (!clientReference) return;

  // Validate with Zupa that an OTP was issued for this reference and hasn't expired.
  try {
    await authorizeOtpOverride(clientReference);
  } catch (err) {
    if (otpChannelId) {
      await client.chat.postEphemeral({
        channel: otpChannelId,
        user: authorizerId,
        text: `⚠️ Authorization failed: ${err.message}`,
      });
    }
    return;
  }

  // Build the authorised blocks from the clicking manager's message as the template.
  // All managers received the same OTP message content, so this works for all.
  const originalBlocks = body.message?.blocks || [];
  const authorisedBlocks = [
    ...originalBlocks.filter((b) => b.type !== "actions"),
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `✅  *Authorised by <@${authorizerId}>*` }],
    },
  ];

  // Find the pending order to get all managers' message coordinates.
  const found = findOrderByClientRef(clientReference);

  // Update every manager's OTP DM. Fall back to just the clicking manager's message
  // if the order isn't in memory (e.g. after a bot restart).
  const messagesToUpdate =
    found?.order?.otpSlackMessages?.length > 0
      ? found.order.otpSlackMessages
      : otpChannelId && otpMessageTs
        ? [{ channelId: otpChannelId, messageTs: otpMessageTs }]
        : [];

  for (const msg of messagesToUpdate) {
    await client.chat
      .update({
        channel: msg.channelId,
        ts: msg.messageTs,
        blocks: authorisedBlocks,
        text: "Payment Override OTP Request — Authorised",
      })
      .catch((err) => console.error(`[handleOtpAuthorize] update channel=${msg.channelId}`, err.message));
  }

  if (!found) {
    if (otpChannelId) {
      await client.chat.postEphemeral({
        channel: otpChannelId,
        user: authorizerId,
        text: `✅ Authorised — but the order isn't in memory (bot may have restarted). The CSR can enter the OTP manually in the order thread to confirm.`,
      });
    }
    return;
  }

  const { channelId, ts, order } = found;
  order.otpOverride = true;
  order.otpAuthorizedBy = authorizerId;
  order.otpSlackBlocks = authorisedBlocks;
  saveOrder(channelId, ts, order);

  await client.chat.update({
    channel: channelId,
    ts,
    text: "Review Order — OTP authorised",
    blocks: buildReviewOrderBlocks(order),
  }).catch(() => {});
}

// Updates all managers' OTP Slack messages with a new status line.
// Uses the blocks stored on the order (otpSlackBlocks) as the base template to avoid
// a conversations.history API call. Returns the new blocks so callers can persist them.
async function _updateOtpMessageStatus(client, order, statusText) {
  if (!order.otpSlackMessages || order.otpSlackMessages.length === 0) return null;
  const base = order.otpSlackBlocks || [];
  const cleanedBlocks = base.filter((b) => {
    if (b.type !== "context") return true;
    const text = b.elements?.[0]?.text || "";
    return !text.startsWith("⏳") && !text.startsWith("🧾") && !text.startsWith("✅  *Payment complete");
  });
  const newBlocks = [
    ...cleanedBlocks,
    { type: "context", elements: [{ type: "mrkdwn", text: statusText }] },
  ];
  for (const msg of order.otpSlackMessages) {
    await client.chat
      .update({
        channel: msg.channelId,
        ts: msg.messageTs,
        blocks: newBlocks,
        text: "Payment Override OTP Request",
      })
      .catch((err) => console.error(`[_updateOtpMessageStatus] channel=${msg.channelId}`, err.message));
  }
  return newBlocks;
}

// ── OTP receipt linking ───────────────────────────────────────────────────────

async function handleLinkReceiptBtn({ ack, body, client }) {
  await ack();

  if (!MANAGER_USER_IDS.has(body.user.id)) {
    await client.chat.postEphemeral({
      channel: body.container.channel_id,
      user: body.user.id,
      text: "⚠️ Only managers can link payment receipts.",
    });
    return;
  }

  const channelId = body.container.channel_id;
  const messageTs = body.container.message_ts;
  const threadTs = body.container.thread_ts || null;
  // For /parse-order, no thread → lookupTs = messageTs (the confirmation card ts).
  // For @mention, threadTs = slackRootTs = the key used in saveConfirmedOrder.
  const lookupTs = threadTs || messageTs;

  const row = getConfirmedOrderRow(channelId, lookupTs);
  if (!row) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: body.user.id,
      text: "⚠️ Could not find the confirmed order — please try again.",
    });
    return;
  }

  const meta = JSON.stringify({
    channelId,
    messageTs,
    lookupTs,
    confirmedBy: row.confirmedBy,
  });
  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildReceiptLookupModal(meta, row.order),
  });
}

async function handleReceiptLookupSubmit({ ack, body, view }) {
  const vals = view.state.values;
  const transactionRef = vals.ref_block?.ref_input?.value?.trim() || null;
  const payerName = vals.name_block?.name_input?.value?.trim() || null;
  const amountRaw = vals.amount_block?.amount_input?.value?.trim() || null;
  const amount = amountRaw && !Number.isNaN(Number(amountRaw)) ? Number(amountRaw) : null;

  if (!transactionRef && !payerName && amount === null) {
    await ack({
      response_action: "errors",
      errors: { ref_block: "Enter a transaction reference, or payer name/amount to search." },
    });
    return;
  }

  const query = transactionRef
    ? { transactionRef }
    : { ...(payerName ? { payerName } : {}), ...(amount !== null ? { amount } : {}) };

  let receipt;
  try {
    receipt = await lookupReceipt(query);
  } catch (err) {
    console.error("[handleReceiptLookupSubmit]", err);
    await ack({
      response_action: "errors",
      errors: { ref_block: `Lookup failed: ${err.message}` },
    });
    return;
  }

  if (!receipt) {
    await ack({
      response_action: "errors",
      errors: { ref_block: "No matching receipt found. Try a different reference or name." },
    });
    return;
  }

  const meta = JSON.parse(view.private_metadata || "{}");
  const updatedMeta = JSON.stringify({ ...meta, foundReceipt: receipt });
  await ack({ response_action: "update", view: buildReceiptFoundModal(updatedMeta, receipt) });
}

async function handleConfirmReceiptLink({ ack, body, client }) {
  await ack();
  const viewId = body.view?.id;
  const meta = JSON.parse(body.view?.private_metadata || "{}");
  const { channelId, messageTs, lookupTs, confirmedBy, foundReceipt } = meta;

  if (!foundReceipt || !channelId) {
    await client.views.update({
      view_id: viewId,
      view: {
        type: "modal",
        title: { type: "plain_text", text: "Error" },
        close: { type: "plain_text", text: "Close" },
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "⚠️ Session data missing — please try again from the confirmation card." } }],
      },
    });
    return;
  }

  const row = getConfirmedOrderRow(channelId, lookupTs);
  if (!row) {
    await client.views.update({
      view_id: viewId,
      view: {
        type: "modal",
        title: { type: "plain_text", text: "Error" },
        close: { type: "plain_text", text: "Close" },
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "⚠️ Order not found in database — please try again." } }],
      },
    });
    return;
  }

  const order = row.order;

  try {
    await confirmReceiptMatch(foundReceipt.transactionRef, order.orderNumber || null);
  } catch (err) {
    const msg =
      err.code === "ALREADY_MATCHED"
        ? "⚠️ This receipt has already been linked to another order."
        : `⚠️ Could not link receipt: ${err.message}`;
    await client.views.update({
      view_id: viewId,
      view: {
        type: "modal",
        title: { type: "plain_text", text: "Link Receipt" },
        close: { type: "plain_text", text: "Close" },
        blocks: [{ type: "section", text: { type: "mrkdwn", text: msg } }],
      },
    });
    return;
  }

  // Append to linked receipts on the order and persist
  order.linkedReceipts = [
    ...(order.linkedReceipts || []),
    {
      transactionRef: foundReceipt.transactionRef,
      amount: foundReceipt.amount,
      payerName: foundReceipt.payerName,
      paidAt: foundReceipt.paidAt,
      linkedBy: body.user.id,
    },
  ];
  updateConfirmedOrder(channelId, lookupTs, order);

  // Rebuild the confirmation card in-place
  const resolvedBy = confirmedBy || row.confirmedBy;
  await client.chat.update({
    channel: channelId,
    ts: messageTs,
    text: `✅ Order confirmed${order.orderNumber ? " · Zupa: " + order.orderNumber : ""}${order.clientReference ? " · Ref: " + order.clientReference : ""}`,
    blocks: buildConfirmationBlocks(order, order.orderNumber, resolvedBy),
  });

  // Update all managers' OTP Slack messages to reflect receipt link status.
  if (order.otpSlackMessages?.length > 0) {
    const count = order.linkedReceipts.length;
    const linker = `<@${body.user.id}>`;
    const statusText =
      count === 1
        ? `🧾  *Receipt linked by ${linker}*`
        : `🧾  *${count} receipts linked — last by ${linker}*`;
    const newBlocks = await _updateOtpMessageStatus(client, order, statusText);
    if (newBlocks) order.otpSlackBlocks = newBlocks;
  }

  // Update the modal to a success state (closes interaction)
  await client.views.update({
    view_id: viewId,
    view: {
      type: "modal",
      title: { type: "plain_text", text: "Receipt Linked" },
      close: { type: "plain_text", text: "Close" },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `✅ Receipt \`${foundReceipt.transactionRef}\` linked successfully to order *${order.orderNumber || order.clientReference}*.`,
          },
        },
      ],
    },
  });
}

async function handleMarkPaymentComplete({ ack, body, client }) {
  await ack();

  if (!MANAGER_USER_IDS.has(body.user.id)) {
    await client.chat.postEphemeral({
      channel: body.container.channel_id,
      user: body.user.id,
      text: "⚠️ Only managers can mark payment as complete.",
    });
    return;
  }

  const channelId = body.container.channel_id;
  const messageTs = body.container.message_ts;
  const threadTs = body.container.thread_ts || null;
  const lookupTs = threadTs || messageTs;

  const row = getConfirmedOrderRow(channelId, lookupTs);
  if (!row) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: body.user.id,
      text: "⚠️ Order not found — please try again.",
    });
    return;
  }

  const order = row.order;
  order.paymentComplete = true;
  order.paymentCompletedBy = body.user.id;

  // Update all managers' OTP Slack messages before persisting so otpSlackBlocks stays in sync.
  if (order.otpSlackMessages?.length > 0) {
    const newBlocks = await _updateOtpMessageStatus(
      client,
      order,
      `✅  *Payment complete — <@${body.user.id}>*`,
    );
    if (newBlocks) order.otpSlackBlocks = newBlocks;
  }

  updateConfirmedOrder(channelId, lookupTs, order);

  const resolvedBy = row.confirmedBy;
  await client.chat.update({
    channel: channelId,
    ts: messageTs,
    text: `✅ Order confirmed${order.orderNumber ? " · Zupa: " + order.orderNumber : ""}${order.clientReference ? " · Ref: " + order.clientReference : ""}`,
    blocks: buildConfirmationBlocks(order, order.orderNumber, resolvedBy),
  });
}

// ── Startup: restore pending orders from SQLite ───────────────────────────────

async function restorePendingOrders(client) {
  const rows = getAllPendingOrders();
  if (rows.length === 0) return { restored: 0, failed: 0 };

  let restored = 0;
  let failed = 0;

  for (const { channelId, ts, order } of rows) {
    try {
      const blocks = buildReviewOrderBlocks(order);
      await client.chat.update({
        channel: channelId,
        ts,
        text: "Review Order",
        blocks,
      });
      orderStateMap.set(stateKey(channelId, ts), order);
      restored++;
      console.log(`[restore] ✓ ${channelId}:${ts}`);
    } catch (err) {
      // Message deleted or bot removed — discard from DB so it doesn't reappear
      deletePendingOrder(channelId, ts);
      failed++;
      console.error(`[restore] ✗ ${channelId}:${ts} — ${err.message || err}`);
    }
  }

  console.log(`[restore] Done — ${restored} restored, ${failed} failed.`);
  return { restored, failed };
}

// ── EOD: expire unsubmitted pending orders ────────────────────────────────────

async function clearExpiredPendingOrders(client) {
  const rows = getAllPendingOrders();
  if (rows.length === 0) return 0;

  // Update each message in Slack so CSRs can see it was auto-expired
  await Promise.allSettled(
    rows.map(({ channelId, ts }) =>
      client.chat.update({
        channel: channelId,
        ts,
        text: '⏰ Order expired — not submitted by end of day.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '⏰  *Order expired* — not submitted by end of day. Re-parse the original message if still needed.',
            },
          },
        ],
      }).catch(() => {}) // ignore deleted/inaccessible messages
    )
  );

  orderStateMap.clear();
  clearAllPendingOrders();

  console.log(`[eod] Cleared ${rows.length} expired pending order(s).`);
  return rows.length;
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
  handleChangeDateBtn,
  handleDatePickerSubmit,
  handleConfirmOrder,
  handleParseAnyway,
  handleCancelParse,
  handleRejectOrder,
  handleThreadMessage,
  handleModConfirm,
  handleModReject,
  handleModAddPick,
  handleModAddSearch,
  handleModAddSearchBtn,
  handleModAddSearchModalSubmit,
  handleModRemovePick,
  handleModRemoveUnresolvedPick,
  handleModZoneSelect,
  handleModCityPickerBtn,
  handleModCityPickerSubmit,
  handleModTryPaymentName,
  handleModRequestOtp,
  handleModEnterOtp,
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
  handleDailySummaryCommand,
  handleShowUnconfirmedOrders,
  handleUnconfirmedOrdersPost,
  handleWeeklySummaryCommand,
  handleMonthlySummaryCommand,
  handleAmountAdjust,
  handleAmountAdjustSubmit,
  handleSetInitialCommand,
  handleAvailabilityCommand,
  handleAvailabilitySearch,
  handleAvailabilityCopyProduct,
  handleAvailabilityCopyAll,
  handleAvailabilityDismiss,
  handleRefreshProductsCommand,
  restorePendingOrders,
  handleRequestOtp,
  handleResendOtpModal,
  handleRefetchPayment,
  handleTryPaymentName,
  handlePaymentNameSubmit,
  handleEnterOtp,
  handleOtpVerifySubmit,
  handleBackToReview,
  handleOtpAuthorize,
  handleLinkReceiptBtn,
  handleReceiptLookupSubmit,
  handleConfirmReceiptLink,
  handleMarkPaymentComplete,
  clearExpiredPendingOrders,
};
