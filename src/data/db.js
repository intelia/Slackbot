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
  CREATE TABLE IF NOT EXISTS csr_initials (
    initial      TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    slack_user_id TEXT,
    updated_at   INTEGER NOT NULL
  );
`);

// Migrations
try { db.exec('ALTER TABLE live_orders ADD COLUMN confirmed_by TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE live_orders ADD COLUMN otp_override INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE live_orders ADD COLUMN otp_authorized_by TEXT'); } catch (_) {}

const LAGOS_OFFSET_MS = 60 * 60 * 1000; // Africa/Lagos = UTC+1

function lagosDateBounds(offsetDays = 0) {
  const localNow = Date.now() + LAGOS_OFFSET_MS + offsetDays * 86_400_000;
  const localMidnight = localNow - (localNow % 86_400_000);
  const startMs = localMidnight - LAGOS_OFFSET_MS;
  return { startMs, endMs: startMs + 86_400_000 };
}

function lagosWeekBounds() {
  const { startMs: todayStart } = lagosDateBounds(0);
  const lagosDate = new Date(todayStart + LAGOS_OFFSET_MS);
  const dow = lagosDate.getUTCDay(); // 0=Sun, 1=Mon, ...
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  const weekStart = todayStart - daysFromMonday * 86_400_000;
  return { startMs: weekStart, endMs: weekStart + 7 * 86_400_000 };
}

function lagosMonthBounds() {
  const { startMs: todayStart } = lagosDateBounds(0);
  const lagosDate = new Date(todayStart + LAGOS_OFFSET_MS);
  const year  = lagosDate.getUTCFullYear();
  const month = lagosDate.getUTCMonth();
  return {
    startMs: Date.UTC(year, month, 1)     - LAGOS_OFFSET_MS,
    endMs:   Date.UTC(year, month + 1, 1) - LAGOS_OFFSET_MS,
  };
}

function isLastDayOfLagosMonth() {
  const { startMs: todayStart }    = lagosDateBounds(0);
  const { startMs: tomorrowStart } = lagosDateBounds(1);
  return new Date(todayStart    + LAGOS_OFFSET_MS).getUTCMonth() !==
         new Date(tomorrowStart + LAGOS_OFFSET_MS).getUTCMonth();
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

function saveConfirmedOrder(channelId, ts, order, confirmedBy, opts = {}) {
  db.prepare(
    'INSERT OR REPLACE INTO live_orders (channel_ts, order_number, order_json, confirmed_at, confirmed_by, otp_override, otp_authorized_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    `${channelId}:${ts}`, order.orderNumber || '', JSON.stringify(order), Date.now(),
    confirmedBy || null, opts.otpOverride ? 1 : 0, opts.otpAuthorizedBy || null
  );
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

function getOrdersForPeriod(startMs, endMs) {
  return db.prepare(
    'SELECT channel_ts, order_json, confirmed_at, confirmed_by FROM live_orders WHERE confirmed_at >= ? AND confirmed_at < ? ORDER BY confirmed_at ASC'
  ).all(startMs, endMs).map(r => ({
    ...JSON.parse(r.order_json),
    _channelId:   r.channel_ts.split(':')[0],
    _confirmedAt: r.confirmed_at,
    _confirmedBy: r.confirmed_by,
  }));
}

function getOtpOverridesForPeriod(startMs, endMs) {
  return db.prepare(
    'SELECT order_json, confirmed_at, confirmed_by, otp_authorized_by FROM live_orders WHERE otp_override = 1 AND confirmed_at >= ? AND confirmed_at < ? ORDER BY confirmed_at ASC'
  ).all(startMs, endMs).map(r => ({
    ...JSON.parse(r.order_json),
    _confirmedAt:     r.confirmed_at,
    _confirmedBy:     r.confirmed_by,
    _otpAuthorizedBy: r.otp_authorized_by,
  }));
}

function getConfirmedOrder(channelId, ts) {
  const row = db.prepare('SELECT order_json FROM live_orders WHERE channel_ts = ?').get(`${channelId}:${ts}`);
  return row ? JSON.parse(row.order_json) : null;
}

function getConfirmedOrderRow(channelId, ts) {
  const row = db.prepare('SELECT order_json, confirmed_by FROM live_orders WHERE channel_ts = ?').get(`${channelId}:${ts}`);
  if (!row) return null;
  return { order: JSON.parse(row.order_json), confirmedBy: row.confirmed_by };
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

function clearAllPendingOrders() {
  db.prepare('DELETE FROM pending_orders').run();
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

// ── CSR initials ─────────────────────────────────────────────────────────────

function setCsrInitial(initial, name, slackUserId) {
  db.prepare(
    'INSERT OR REPLACE INTO csr_initials (initial, name, slack_user_id, updated_at) VALUES (?, ?, ?, ?)'
  ).run(initial.toUpperCase(), name, slackUserId || null, Date.now());
}

function getCsrByInitial(initial) {
  return db.prepare('SELECT initial, name FROM csr_initials WHERE initial = ?').get(initial.toUpperCase());
}

function getAllCsrInitials() {
  return db.prepare('SELECT initial, name FROM csr_initials ORDER BY initial ASC').all();
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
  saveConfirmedOrder, getConfirmedOrder, getConfirmedOrderRow, updateConfirmedOrder,
  getDailySummary, getAllOrdersToday, getOrdersForPeriod, getOtpOverridesForPeriod,
  lagosWeekBounds, lagosMonthBounds, isLastDayOfLagosMonth,
  savePendingOrder, deletePendingOrder, getAllPendingOrders, clearAllPendingOrders,
  getMetaValue, setMetaValue,
  setCsrInitial, getCsrByInitial, getAllCsrInitials,
};
