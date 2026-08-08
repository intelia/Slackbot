"use strict";

const { App } = require("@slack/bolt");
const handlers = require("./handlers");

function createApp() {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
  });

  // ── Commands ────────────────────────────────────────────────────────────────
  app.command("/parse-order", handlers.handleParseOrderCommand);
  app.command("/menu", handlers.handleMenuCommand);
  app.command("/cities", handlers.handleCitiesCommand);
  app.command("/my-orders", handlers.handleSummaryCommand);
  app.command("/daily-summary", handlers.handleDailySummaryCommand);
  app.command("/weekly-summary", handlers.handleWeeklySummaryCommand);
  app.command("/monthly-summary", handlers.handleMonthlySummaryCommand);
  app.command("/refresh-products", handlers.handleRefreshProductsCommand);
  app.command("/available", handlers.handleAvailabilityCommand);
  app.command("/set-initial", handlers.handleSetInitialCommand);

  // ── Events ──────────────────────────────────────────────────────────────────
  app.event("app_mention", handlers.handleMentionOrder);
  app.message("--version", handlers.handleVersionCommand);
  app.event("message", handlers.handleThreadMessage);

  // ── Modal submissions ───────────────────────────────────────────────────────
  app.view("parse_order_submit", handlers.handleParseOrderSubmit);
  app.view("product_search_submit", handlers.handleProductSearchSubmit);
  app.view("zone_picker_submit", handlers.handleZonePickerSubmit);
  app.view("mod_city_picker_submit", handlers.handleModCityPickerSubmit);
  app.view("summary_modal", handlers.handleSummarySubmit);

  // ── External select options ─────────────────────────────────────────────────
  app.options("product_search_select", handlers.handleProductSearchOptions);
  app.options("zone_search_select", handlers.handleZoneSearchOptions);
  app.options("menu_search_select", handlers.handleMenuSearchOptions);
  app.options("cities_search_select", handlers.handleCitiesSearchOptions);
  // Mod review pickers reuse the same data sources
  app.options("mod_add_search", handlers.handleProductSearchOptions);
  app.options("mod_zone_select", handlers.handleZoneSearchOptions);
  app.options("mod_zone_search_select", handlers.handleZoneSearchOptions);

  // ── Global error handler ────────────────────────────────────────────────────
  app.error(async (error) => {
    console.error("[bolt] Unhandled error:", error);
  });

  // ── Actions ─────────────────────────────────────────────────────────────────
  // Product selection dropdown (matches product_pick_0, product_pick_1, etc.)
  app.action(/^product_pick_\d+$/, handlers.handleProductPick);

  // Edit / done-edit per item
  app.action(/^edit_item_\d+$/, handlers.handleEditItem);
  app.action(/^done_edit_item_\d+$/, handlers.handleDoneEditItem);

  // Product search modal trigger
  app.action(/^search_product_\d+$/, handlers.handleSearchProduct);

  // Zone picker
  app.action("change_zone", handlers.handleChangeZone);

  // Date picker
  app.action("change_date", handlers.handleChangeDateBtn);
  app.view("date_picker_submit", handlers.handleDatePickerSubmit);

  // Payment verification / OTP flow
  app.action("request_otp", handlers.handleRequestOtp);
  app.action("resend_otp_modal", handlers.handleResendOtpModal);
  app.action("refetch_payment", handlers.handleRefetchPayment);
  app.action("try_payment_name", handlers.handleTryPaymentName);
  app.view("payment_name_submit", handlers.handlePaymentNameSubmit);
  app.action("enter_otp", handlers.handleEnterOtp);
  app.view("otp_verify_submit", handlers.handleOtpVerifySubmit);
  app.action("back_to_review", handlers.handleBackToReview);

  // Duplicate warning
  app.action("parse_anyway", handlers.handleParseAnyway);
  app.action("cancel_parse", handlers.handleCancelParse);

  // Order lifecycle
  app.action("confirm_order", handlers.handleConfirmOrder);
  app.action("reject_order", handlers.handleRejectOrder);

  // Order modification
  app.action("mod_confirm", handlers.handleModConfirm);
  app.action("mod_reject", handlers.handleModReject);
  app.action("mod_add_pick", handlers.handleModAddPick);
  app.action("mod_add_search", handlers.handleModAddSearch);
  app.action("mod_add_search_btn", handlers.handleModAddSearchBtn);
  app.view("mod_add_search_modal", handlers.handleModAddSearchModalSubmit);
  app.action("mod_remove_pick", handlers.handleModRemovePick);
  app.action(
    "mod_remove_unresolved_pick",
    handlers.handleModRemoveUnresolvedPick,
  );
  app.action("mod_zone_select", handlers.handleModZoneSelect);
  app.action("mod_city_picker_btn", handlers.handleModCityPickerBtn);
  app.action("mod_try_payment_name", handlers.handleModTryPaymentName);
  app.action("mod_request_otp", handlers.handleModRequestOtp);
  app.action("mod_enter_otp", handlers.handleModEnterOtp);

  // Menu live filter (fires on each keystroke, updates modal via views.update)
  app.action("menu_search_input", handlers.handleMenuSearch);

  // Availability live filter + copy
  app.action("availability_search_input", handlers.handleAvailabilitySearch);
  app.action("avail_copy_product", handlers.handleAvailabilityCopyProduct);
  app.action("avail_copy_all", handlers.handleAvailabilityCopyAll);
  app.action("avail_dismiss_copy", handlers.handleAvailabilityDismiss);

  // Cities browse (no-op ack — read-only modal)
  app.action("cities_search_select", handlers.handleCitiesSelect);

  return app;
}

module.exports = { createApp };
