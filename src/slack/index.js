'use strict';

const { App } = require('@slack/bolt');
const handlers = require('./handlers');

function createApp() {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
  });

  // ── Commands ────────────────────────────────────────────────────────────────
  app.command('/parse-order', handlers.handleParseOrderCommand);
  app.command('/menu', handlers.handleMenuCommand);
  app.command('/cities', handlers.handleCitiesCommand);

  // ── Events ──────────────────────────────────────────────────────────────────
  app.event('app_mention', handlers.handleMentionOrder);
  app.message('--version', handlers.handleVersionCommand);
  app.event('message', handlers.handleThreadMessage);

  // ── Modal submissions ───────────────────────────────────────────────────────
  app.view('parse_order_submit', handlers.handleParseOrderSubmit);
  app.view('product_search_submit', handlers.handleProductSearchSubmit);
  app.view('zone_picker_submit', handlers.handleZonePickerSubmit);

  // ── External select options ─────────────────────────────────────────────────
  app.options('product_search_select', handlers.handleProductSearchOptions);
  app.options('zone_search_select', handlers.handleZoneSearchOptions);
  app.options('menu_search_select', handlers.handleMenuSearchOptions);
  app.options('cities_search_select', handlers.handleCitiesSearchOptions);

  // ── Actions ─────────────────────────────────────────────────────────────────
  // Product selection dropdown (matches product_pick_0, product_pick_1, etc.)
  app.action(/^product_pick_\d+$/, handlers.handleProductPick);

  // Edit / done-edit per item
  app.action(/^edit_item_\d+$/, handlers.handleEditItem);
  app.action(/^done_edit_item_\d+$/, handlers.handleDoneEditItem);

  // Product search modal trigger
  app.action(/^search_product_\d+$/, handlers.handleSearchProduct);

  // Zone picker
  app.action('change_zone', handlers.handleChangeZone);

  // Duplicate warning
  app.action('parse_anyway', handlers.handleParseAnyway);
  app.action('cancel_parse', handlers.handleCancelParse);

  // Order lifecycle
  app.action('confirm_order', handlers.handleConfirmOrder);
  app.action('reject_order', handlers.handleRejectOrder);

  // Order modification
  app.action('mod_confirm', handlers.handleModConfirm);
  app.action('mod_reject', handlers.handleModReject);

  // Menu live filter (fires on each keystroke, updates modal via views.update)
  app.action('menu_search_input', handlers.handleMenuSearch);

  // Cities browse (no-op ack — read-only modal)
  app.action('cities_search_select', handlers.handleCitiesSelect);

  return app;
}

module.exports = { createApp };
