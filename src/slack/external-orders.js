"use strict";

// Posts a notification into EXTERNAL_ORDERS_CHANNEL_ID whenever an order is
// created through a channel other than this bot (storefront checkout or the
// WhatsApp ordering agent) — both write into the same zupa-api `orders`
// table this bot pushes into, distinguished by the `platform` column
// ("Slack" for us, "WhatsApp-AI" for the WhatsApp agent, null for the
// storefront). There's no webhook/event system on the zupa-api side, so this
// polls GET /kitchen-api/orders on an interval using the same bearer
// credential already used for the kitchen/terminal summary endpoints.

const { EXTERNAL_ORDERS_CHANNEL_ID, EXTERNAL_ORDERS_POLL_INTERVAL_MS } = require("../constants");
const { buildExternalOrderBlocks } = require("./blocks");
const {
  getMetaValue,
  setMetaValue,
  wasExternalOrderNotified,
  markExternalOrderNotified,
  pruneOldNotifiedExternalOrders,
} = require("../data/db");

const POLL_CURSOR_KEY = "external_orders_poll_cursor";
// Re-fetches a small window behind the last cursor on every poll so an order
// whose createdAt landed just before the previous cursor (e.g. briefly
// delayed commit) isn't missed. The notified-orders table (see db.js) is
// what actually prevents re-posting anything already sent.
const LOOKBACK_MS = 2 * 60 * 1000;

async function fetchOrdersSince(sinceIso) {
  const url = new URL(`${process.env.ZUPA_API}/kitchen-api/orders`);
  url.searchParams.set("startDate", sinceIso);
  url.searchParams.set("limit", "100");
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${process.env.ZUPA_API_TOKEN}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET /kitchen-api/orders failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  const { data } = await res.json();
  return Array.isArray(data) ? data : [];
}

async function pollExternalOrders(client) {
  const cursor = getMetaValue(POLL_CURSOR_KEY);

  // First run ever: start watching from now instead of posting every
  // historical order already in zupa-api.
  if (!cursor) {
    setMetaValue(POLL_CURSOR_KEY, new Date().toISOString());
    return;
  }

  const since = new Date(new Date(cursor).getTime() - LOOKBACK_MS).toISOString();
  const orders = await fetchOrdersSince(since);
  if (orders.length === 0) return;

  for (const order of orders) {
    if (order.platform === "Slack") continue;
    if (wasExternalOrderNotified(order.id)) continue;

    await client.chat.postMessage({
      channel: EXTERNAL_ORDERS_CHANNEL_ID,
      text: `New order ${order.orderNumber || ""} via ${order.platform || "Storefront"}`,
      blocks: buildExternalOrderBlocks(order),
    });
    markExternalOrderNotified(order.id, order.orderNumber, order.platform);
  }

  const latestCreatedAt = orders.reduce(
    (max, o) => (o.createdAt && o.createdAt > max ? o.createdAt : max),
    cursor,
  );
  setMetaValue(POLL_CURSOR_KEY, latestCreatedAt);
  pruneOldNotifiedExternalOrders();
}

function startExternalOrdersPolling(client) {
  const tick = () =>
    pollExternalOrders(client).catch((err) =>
      console.error("[external-orders] Poll failed:", err.message),
    );
  tick();
  setInterval(tick, EXTERNAL_ORDERS_POLL_INTERVAL_MS);
}

module.exports = { startExternalOrdersPolling, pollExternalOrders };
