'use strict';

const Database = require('better-sqlite3');
const crypto   = require('crypto');
const path     = require('path');

const db = new Database(path.join(__dirname, '../../zupa-orders.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS confirmed_orders (
    hash         TEXT PRIMARY KEY,
    order_number TEXT,
    customer_name TEXT,
    confirmed_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS live_orders (
    channel_ts   TEXT PRIMARY KEY,
    order_number TEXT NOT NULL,
    order_json   TEXT NOT NULL,
    confirmed_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pending_orders (
    channel_ts TEXT PRIMARY KEY,
    order_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bot_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Migrate: add confirmed_by if this is an existing database without it
try { db.exec('ALTER TABLE live_orders ADD COLUMN confirmed_by TEXT'); } catch (_) {}

const LAGOS_OFFSET_MS = 60 * 60 * 1000; // Africa/Lagos = UTC+1

function lagosDateBounds(offsetDays = 0) {
  const localNow = Date.now() + LAGOS_OFFSET_MS + offsetDays * 86_400_000;
  const localMidnight = localNow - (localNow % 86_400_000);
  const startMs = localMidnight - LAGOS_OFFSET_MS;
  return { startMs, endMs: startMs + 86_400_000 };
}

function hashRaw(rawMessage) {
  const normalized = (rawMessage || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function findDuplicate(rawMessage) {
  return db.prepare('SELECT * FROM confirmed_orders WHERE hash = ?').get(hashRaw(rawMessage)) || null;
}

function recordOrder(rawMessage, orderNumber, customerName) {
  db.prepare(
    'INSERT OR REPLACE INTO confirmed_orders (hash, order_number, customer_name, confirmed_at) VALUES (?, ?, ?, ?)'
  ).run(hashRaw(rawMessage), orderNumber || null, customerName || null, Date.now());
}

function saveConfirmedOrder(channelId, ts, order, confirmedBy) {
  db.prepare(
    'INSERT OR REPLACE INTO live_orders (channel_ts, order_number, order_json, confirmed_at, confirmed_by) VALUES (?, ?, ?, ?, ?)'
  ).run(`${channelId}:${ts}`, order.orderNumber || '', JSON.stringify(order), Date.now(), confirmedBy || null);
}

function getDailySummary(userId, offsetDays = 0) {
  const { startMs, endMs } = lagosDateBounds(offsetDays);
  return db.prepare(
    'SELECT order_json, confirmed_at FROM live_orders WHERE confirmed_by = ? AND confirmed_at >= ? AND confirmed_at < ? ORDER BY confirmed_at ASC'
  ).all(userId, startMs, endMs).map(r => ({ ...JSON.parse(r.order_json), _confirmedAt: r.confirmed_at }));
}

// Returns every order confirmed today across ALL channels,
// with _channelId / _confirmedBy / _confirmedAt injected.
function getAllOrdersToday(offsetDays = 0) {
  const { startMs, endMs } = lagosDateBounds(offsetDays);
  return db.prepare(
    'SELECT channel_ts, order_json, confirmed_at, confirmed_by FROM live_orders WHERE confirmed_at >= ? AND confirmed_at < ? ORDER BY confirmed_at ASC'
  ).all(startMs, endMs).map(r => ({
    ...JSON.parse(r.order_json),
    _channelId:   r.channel_ts.split(':')[0],
    _confirmedAt: r.confirmed_at,
    _confirmedBy: r.confirmed_by,
  }));
}

function getConfirmedOrder(channelId, ts) {
  const row = db.prepare('SELECT order_json FROM live_orders WHERE channel_ts = ?').get(`${channelId}:${ts}`);
  return row ? JSON.parse(row.order_json) : null;
}

function updateConfirmedOrder(channelId, ts, order) {
  db.prepare(
    'UPDATE live_orders SET order_json = ? WHERE channel_ts = ?'
  ).run(JSON.stringify(order), `${channelId}:${ts}`);
}

// ── Pending orders (survives bot restarts) ────────────────────────────────────

function savePendingOrder(channelId, ts, order) {
  db.prepare('INSERT OR REPLACE INTO pending_orders (channel_ts, order_json, updated_at) VALUES (?, ?, ?)')
    .run(`${channelId}:${ts}`, JSON.stringify(order), Date.now());
}

function deletePendingOrder(channelId, ts) {
  db.prepare('DELETE FROM pending_orders WHERE channel_ts = ?').run(`${channelId}:${ts}`);
}

function getAllPendingOrders() {
  return db.prepare('SELECT channel_ts, order_json FROM pending_orders ORDER BY updated_at ASC').all()
    .map(r => {
      const colonIdx = r.channel_ts.indexOf(':');
      return {
        channelId: r.channel_ts.slice(0, colonIdx),
        ts:        r.channel_ts.slice(colonIdx + 1),
        order:     JSON.parse(r.order_json),
      };
    });
}

// ── Bot metadata (version tracking, etc.) ────────────────────────────────────

function getMetaValue(key) {
  const row = db.prepare('SELECT value FROM bot_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMetaValue(key, value) {
  db.prepare('INSERT OR REPLACE INTO bot_meta (key, value) VALUES (?, ?)').run(key, String(value));
}

module.exports = {
  findDuplicate, recordOrder,
  saveConfirmedOrder, getConfirmedOrder, updateConfirmedOrder,
  getDailySummary, getAllOrdersToday,
  savePendingOrder, deletePendingOrder, getAllPendingOrders,
  getMetaValue, setMetaValue,
};
