"use strict";

// Maximum allowed ± difference when adjusting the payment search amount.
// e.g. 1000 means the CSR can enter -1000 to +1000.
const PAYMENT_ADJUSTMENT_LIMIT = 1000;

const MANAGER_USER_IDS =
  process.env.ENV === "dev"
    ? new Set(["U0BA1L1SFEZ"]) // Adebayo Azeez
    : new Set([
        "U08UX5S1Z63", // Uche Uzoka
        "U08V531QSS2", // Udoka Uzoka
        "U091TRTU3U4", // Muhammed
        "U0BA1L1SFEZ", // Adebayo Azeez
      ]);

const APP_MANAGER_USER_IDS = new Set([
  "U08U7T57GAH", // Ayo Aboyade
  "U0BA1L1SFEZ", // Adebayo Azeez
  "U08V531QSS2", // Udoka Uzoka
]);

// Where storefront/WhatsApp orders (i.e. anything not placed through this
// bot) get posted as they're created — see src/slack/external-orders.js.
const EXTERNAL_ORDERS_CHANNEL_ID = "C090YLGQLKE";
const EXTERNAL_ORDERS_POLL_INTERVAL_MS = 60 * 1000;

module.exports = {
  PAYMENT_ADJUSTMENT_LIMIT,
  MANAGER_USER_IDS,
  APP_MANAGER_USER_IDS,
  EXTERNAL_ORDERS_CHANNEL_ID,
  EXTERNAL_ORDERS_POLL_INTERVAL_MS,
};
