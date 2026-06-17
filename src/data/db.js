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
`);

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

function saveConfirmedOrder(channelId, ts, order) {
  db.prepare(
    'INSERT OR REPLACE INTO live_orders (channel_ts, order_number, order_json, confirmed_at) VALUES (?, ?, ?, ?)'
  ).run(`${channelId}:${ts}`, order.orderNumber || '', JSON.stringify(order), Date.now());
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

module.exports = { findDuplicate, recordOrder, saveConfirmedOrder, getConfirmedOrder, updateConfirmedOrder };
