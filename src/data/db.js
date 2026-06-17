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
  )
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

module.exports = { findDuplicate, recordOrder };
