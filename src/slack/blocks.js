"use strict";

const store = require("../data/store");

function fmt(n) {
  if (n == null) return "—";
  return "₦" + Number(n).toLocaleString("en-NG");
}

function trunc(s, max) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ── Line item blocks ──────────────────────────────────────────────────────────

function matchedItemBlock(item) {
  const label = `✅  *${item.productName} · ${item.sizeName}*  ×${item.qty}  —  ${fmt(item.lineTotal)}`;
  return {
    type: "section",
    text: { type: "mrkdwn", text: label },
    accessory: {
      type: "button",
      text: { type: "plain_text", text: "Edit" },
      action_id: `edit_item_${item.index}`,
      value: String(item.index),
    },
  };
}

function ambiguousItemBlock(item) {
  const blocks = [];

  const headerText =
    item.issue === "unmatched"
      ? `❌  *"${trunc(item.raw, 60)}"* — no match found`
      : item.issue === "price_mismatch"
        ? `⚠️  *"${trunc(item.raw, 60)}"* — price mismatch (stated ${fmt(item.statedPrice)}, catalogue ${fmt(item.candidates[0]?.price)})`
        : `⚠️  *"${trunc(item.raw, 60)}"* — select the correct product:`;

  blocks.push({ type: "section", text: { type: "mrkdwn", text: headerText } });

  // Candidate picker (up to 5, plus a placeholder "none of these")
  const candidateOptions = item.candidates.slice(0, 5).map((c) => ({
    text: {
      type: "plain_text",
      text: trunc(
        `${c.productName} · ${c.sizeName} — ${fmt(c.price)}${c.priceMatch ? " ✓" : ""}`,
        75,
      ),
    },
    value: c.sizeId,
  }));

  if (candidateOptions.length > 0) {
    blocks.push({
      type: "actions",
      block_id: `item_actions_${item.index}`,
      elements: [
        {
          type: "static_select",
          action_id: `product_pick_${item.index}`,
          placeholder: { type: "plain_text", text: "Pick product…" },
          options: candidateOptions,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Search all" },
          action_id: `search_product_${item.index}`,
          value: String(item.index),
        },
      ],
    });
  } else {
    blocks.push({
      type: "actions",
      block_id: `item_actions_${item.index}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "🔍 Search all products" },
          action_id: `search_product_${item.index}`,
          value: String(item.index),
        },
      ],
    });
  }

  return blocks;
}

function editableItemBlock(item) {
  // Same as ambiguous but pre-selected on the current match (for "Edit" flow)
  const currentOption = item.sizeId
    ? {
        text: {
          type: "plain_text",
          text: trunc(
            `${item.productName} · ${item.sizeName} — ${fmt(item.unitPrice)}`,
            75,
          ),
        },
        value: item.sizeId,
      }
    : null;

  const options = [];
  if (currentOption) options.push(currentOption);
  item.candidates
    .slice(0, 4)
    .filter((c) => c.sizeId !== item.sizeId)
    .forEach((c) => {
      options.push({
        text: {
          type: "plain_text",
          text: trunc(`${c.productName} · ${c.sizeName} — ${fmt(c.price)}`, 75),
        },
        value: c.sizeId,
      });
    });

  if (options.length === 0) {
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `✏️  *"${item.raw}"* — search to replace:`,
        },
      },
      {
        type: "actions",
        block_id: `item_actions_${item.index}`,
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "🔍 Search all products" },
            action_id: `search_product_${item.index}`,
            value: String(item.index),
          },
        ],
      },
    ];
  }

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `✏️  *"${item.raw}"* — change product:` },
    },
    {
      type: "actions",
      block_id: `item_actions_${item.index}`,
      elements: [
        {
          type: "static_select",
          action_id: `product_pick_${item.index}`,
          initial_option: currentOption,
          placeholder: { type: "plain_text", text: "Select product…" },
          options: options.slice(0, 5),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Search all" },
          action_id: `search_product_${item.index}`,
          value: String(item.index),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Done" },
          action_id: `done_edit_item_${item.index}`,
          value: String(item.index),
        },
      ],
    },
  ];
}

// ── Main block builder ────────────────────────────────────────────────────────

function buildReviewOrderBlocks(order, editingItemIndex = null) {
  const blocks = [];
  const unresolvedItems = order.items.filter((i) => i.issue !== null);
  const zoneUnresolved =
    !order.fulfillment.resolved || !order.fulfillment.zoneId;

  // Header
  const needsReviewCount = unresolvedItems.length + (zoneUnresolved ? 1 : 0);
  const hasMismatch =
    needsReviewCount === 0 && order.reconciliation.status === "mismatch";
  const statusText =
    needsReviewCount > 0
      ? `⚠️  *Needs review* — ${needsReviewCount} unresolved`
      : hasMismatch
        ? `⚠️  *Price mismatch* — all items resolved but total is off by ${fmt(Math.abs(order.reconciliation.gap))}`
        : order.status === "auto_accepted"
          ? "✅  *Auto-accepted* — verify and confirm"
          : "✅  *All items resolved* — ready to confirm";

  const refLine = order.clientReference
    ? `Ref: \`${order.clientReference}\``
    : "";
  const parsedByLine = order.parsedBy ? `\n_Posted by: ${order.parsedBy}_` : "";
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*REVIEW ORDER*${refLine ? "  ·  " + refLine : ""}\n${statusText}${parsedByLine}`,
    },
  });
  blocks.push({ type: "divider" });

  // Customer
  const { customer, fulfillment } = order;
  const customerParts = [
    customer.name,
    customer.instagram,
    customer.phone,
  ].filter(Boolean);
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*CUSTOMER*\n${customerParts.join("  ·  ") || "—"}`,
    },
  });

  if (order.recipient && (order.recipient.name || order.recipient.phone)) {
    const recipientParts = [order.recipient.name, order.recipient.phone].filter(
      Boolean,
    );
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `📦  *Recipient:*  ${recipientParts.join("  ·  ")}`,
        },
      ],
    });
  }

  // Fulfillment
  const fulfillmentDesc =
    fulfillment.type === "pickup"
      ? `◉ *Pickup* — ${fulfillment.branch || "Lekki"}  (₦0)`
      : fulfillment.zoneName
        ? `◉ *Delivery* — ${fulfillment.zoneName}  ${fmt(fulfillment.fee)}${fulfillment.branch ? "  (" + fulfillment.branch + ")" : ""}`
        : `⚠️  *Delivery zone not resolved* — "${fulfillment.address || "?"}"`;

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: fulfillmentDesc },
    accessory: {
      type: "button",
      text: { type: "plain_text", text: "Change zone" },
      action_id: "change_zone",
      value: "change",
    },
  });

  {
    const humanDate = order.scheduledDate
      ? new Date(order.scheduledDate + "T12:00:00").toLocaleDateString(
          "en-NG",
          {
            timeZone: "Africa/Lagos",
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
          },
        )
      : null;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: humanDate
          ? `📅  *Delivery date:*  ${humanDate}`
          : `📅  _No delivery date set_`,
      },
      accessory: {
        type: "button",
        text: {
          type: "plain_text",
          text: order.scheduledDate ? "Change date" : "Set date",
        },
        action_id: "change_date",
        value: "change_date",
      },
    });
  }

  blocks.push({ type: "divider" });

  // Items
  blocks.push({ type: "section", text: { type: "mrkdwn", text: "*ITEMS*" } });

  for (const item of order.items) {
    if (editingItemIndex === item.index) {
      editableItemBlock(item).forEach((b) => blocks.push(b));
    } else if (item.issue !== null) {
      ambiguousItemBlock(item).forEach((b) => blocks.push(b));
    } else {
      blocks.push(matchedItemBlock(item));
    }
  }

  blocks.push({ type: "divider" });

  // Totals
  const reconcText =
    order.reconciliation.status === "matched"
      ? "✅  Matches customer's stated total"
      : order.reconciliation.status === "unknown"
        ? "—  No stated total to verify"
        : `⚠️  Off by ${fmt(Math.abs(order.reconciliation.gap))}${order.reconciliation.hypothesis ? " — " + order.reconciliation.hypothesis : ""}`;

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: [
        `Items:  *${fmt(order.itemsSubtotal)}*`,
        `Delivery:  *${fmt(order.fulfillment.fee || 0)}*`,
        ...(order.couponCode ? [`Coupon:  *${order.couponCode}*`] : []),
        `─────────────────`,
        `TOTAL:  *${fmt(order.orderTotal)}*`,
        reconcText,
      ].join("\n"),
    },
  });

  // Notes
  if (order.notes && order.notes.length > 0) {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `📌 *Note:* ${order.notes.join(" · ")}` },
      ],
    });
  }

  // Payment verification status (populated asynchronously after parse)
  {
    const ps = order.paymentStatus;
    const receiptNameNote = order.receiptName
      ? `  _(receipt name: *${order.receiptName}*)_`
      : "";
    let paymentText;
    if (order.otpOverride) {
      const auth = order.otpAuthorizedBy ? `<@${order.otpAuthorizedBy}>` : "operator";
      paymentText = `🔐  *Payment override (OTP)* — authorised by ${auth}`;
    } else if (ps === "verifying") {
      paymentText = `🔍  _Verifying payment…_${receiptNameNote}`;
    } else if (ps === "verified") {
      const p = order.paymentData || {};
      if (p.combined) {
        const count = (p.payments || []).length;
        const payer = p.payments?.[0]?.payerName ? `Payer: *${p.payments[0].payerName}*  ·  ` : "";
        const refs = (p.payments || []).map((pay) => `\`${pay.transactionRef}\``).join(", ");
        paymentText = `✅  *Payment verified* (${count} combined, ${p.timeDiffMinutes}min apart) — ${payer}Total: *${fmt(p.totalAmount)}*  ·  Refs: ${refs}`;
      } else {
        const paid = p.amount ? fmt(p.amount) + "  ·  " : "";
        const payer = p.payerName ? `Payer: *${p.payerName}*  ·  ` : "";
        paymentText = `✅  *Payment verified* — ${paid}${payer}Ref: \`${p.transactionRef || "—"}\``;
      }
    } else if (ps === "not_found") {
      paymentText =
        `⚠️  *No matching payment found* — use Refetch Payment or Request OTP below${receiptNameNote}`;
    } else if (ps === "error") {
      paymentText = `⚠️  *Payment check failed* — ${order.paymentError || "unknown error"}`;
    }
    if (paymentText) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: paymentText }],
      });
    }
  }

  blocks.push({ type: "divider" });

  // Action buttons
  const canConfirm = unresolvedItems.length === 0 && !zoneUnresolved;

  const rejectButton = {
    type: "button",
    text: { type: "plain_text", text: "Reject" },
    style: "danger",
    action_id: "reject_order",
    value: "reject",
    confirm: {
      title: { type: "plain_text", text: "Reject this order?" },
      text: {
        type: "mrkdwn",
        text: "The order will be discarded and not pushed to Zupa.",
      },
      confirm: { type: "plain_text", text: "Yes, reject" },
      deny: { type: "plain_text", text: "Cancel" },
    },
  };

  // When payment not found and order is otherwise ready: replace Confirm with
  // inline options to avoid an extra navigation step.
  // Skip this gate when OTP override is already authorised.
  if (order.paymentStatus === "not_found" && canConfirm && !order.otpOverride) {
    blocks.push({
      type: "actions",
      elements: [
        rejectButton,
        {
          type: "button",
          text: { type: "plain_text", text: "🔄  Refetch Payment" },
          action_id: "refetch_payment",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "💱  Adjust Amount" },
          action_id: "amount_adjust",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "👤  Try Different Name" },
          action_id: "try_payment_name",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "📲  Request OTP" },
          action_id: "request_otp",
          style: "primary",
        },
      ],
    });
    return blocks;
  }

  const confirmButton = {
    type: "button",
    text: {
      type: "plain_text",
      text: canConfirm ? "Confirm & Push to Zupa" : "🔒 Resolve issues first",
    },
    style: canConfirm ? "primary" : undefined,
    action_id: "confirm_order",
    value: "confirm",
  };

  if (hasMismatch) {
    const gapText = fmt(Math.abs(order.reconciliation.gap));
    confirmButton.confirm = {
      title: { type: "plain_text", text: "Price mismatch — confirm anyway?" },
      text: {
        type: "mrkdwn",
        text: `Total is off by *${gapText}*${order.reconciliation.hypothesis ? " — " + order.reconciliation.hypothesis : ""}. Submit to Zupa anyway?`,
      },
      confirm: { type: "plain_text", text: "Yes, submit anyway" },
      deny: { type: "plain_text", text: "Cancel" },
    };
  }

  blocks.push({
    type: "actions",
    elements: [rejectButton, confirmButton],
  });

  return blocks;
}

// ── Confirmed order receipt ───────────────────────────────────────────────────

function buildConfirmationBlocks(order, orderNumber, confirmedBy) {
  const blocks = [];

  // ── Header ────────────────────────────────────────────────────────────────
  const refPart = order.clientReference
    ? `  ·  Ref: \`${order.clientReference}\``
    : "";
  const numPart = orderNumber ? `  ·  Zupa: \`${orderNumber}\`` : "";
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `✅  *ORDER CONFIRMED*${refPart}${numPart}\nConfirmed by <@${confirmedBy}>${order.parsedBy ? "  ·  Posted by: " + order.parsedBy : ""}`,
    },
  });
  blocks.push({ type: "divider" });

  // ── Customer ──────────────────────────────────────────────────────────────
  const customerParts = [
    order.customer?.name,
    order.customer?.instagram
      ? `@${order.customer.instagram.replace(/^@/, "")}`
      : null,
    order.customer?.phone,
  ].filter(Boolean);
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*CUSTOMER*\n${customerParts.join("  ·  ") || "—"}`,
    },
  });

  if (order.recipient && (order.recipient.name || order.recipient.phone)) {
    const rParts = [order.recipient.name, order.recipient.phone].filter(
      Boolean,
    );
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `📦  *Recipient:*  ${rParts.join("  ·  ")}` },
      ],
    });
  }

  // ── Fulfillment ───────────────────────────────────────────────────────────
  const isPickup = order.fulfillment?.type === "pickup";
  const fulfillmentText = isPickup
    ? `◉  *Pickup* — ${order.fulfillment?.branch || "Lekki"}  _(₦0)_`
    : `🚚  *Delivery* — ${order.fulfillment?.zoneName || order.fulfillment?.address || "—"}${order.fulfillment?.branch ? "  (" + order.fulfillment.branch + ")" : ""}  —  ${fmt(order.fulfillment?.fee || 0)}`;
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: fulfillmentText },
  });

  if (order.scheduledDate) {
    const humanDate = new Date(
      order.scheduledDate + "T12:00:00",
    ).toLocaleDateString("en-NG", {
      timeZone: "Africa/Lagos",
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `📅  *Delivery date:*  ${humanDate}` },
      ],
    });
  }

  blocks.push({ type: "divider" });

  // ── Items ─────────────────────────────────────────────────────────────────
  blocks.push({ type: "section", text: { type: "mrkdwn", text: "*ITEMS*" } });

  for (const item of order.items || []) {
    const unitNote = item.qty > 1 ? `  _(${fmt(item.unitPrice)} each)_` : "";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `×${item.qty}  *${item.productName}*  ·  _${item.sizeName}_  —  ${fmt(item.lineTotal)}${unitNote}`,
      },
    });
  }

  blocks.push({ type: "divider" });

  // ── Totals ────────────────────────────────────────────────────────────────
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: [
        `Items:  *${fmt(order.itemsSubtotal)}*`,
        `Delivery:  *${fmt(order.fulfillment?.fee || 0)}*`,
        `─────────────────`,
        `TOTAL:  *${fmt(order.orderTotal)}*`,
      ].join("\n"),
    },
  });

  if (order.notes && order.notes.length > 0) {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `📌  _${order.notes.join("  ·  ")}_` },
      ],
    });
  }

  // ── Payment verification line ─────────────────────────────────────────────
  let paymentLine = null;
  if (order.otpOverride) {
    const auth = order.otpAuthorizedBy ? `<@${order.otpAuthorizedBy}>` : "operator";
    paymentLine = `🔐  *Payment override (OTP)* — authorised by ${auth}`;
  } else if (order.paymentStatus === "verified" && order.paymentData) {
    const p = order.paymentData;
    if (p.combined) {
      const count = (p.payments || []).length;
      const payer = p.payments?.[0]?.payerName ? `Payer: *${p.payments[0].payerName}*  ·  ` : "";
      const refs = (p.payments || []).map((pay) => `\`${pay.transactionRef}\``).join(", ");
      paymentLine = `✅  *Payment verified* (${count} combined, ${p.timeDiffMinutes}min apart) — ${payer}${fmt(p.totalAmount)}  ·  Refs: ${refs}`;
    } else {
      const parts = [];
      if (p.payerName) parts.push(`Payer: *${p.payerName}*`);
      if (p.transactionRef) parts.push(`Ref: \`${p.transactionRef}\``);
      if (p.amount) parts.push(fmt(p.amount));
      paymentLine = `✅  *Payment verified* — ${parts.join("  ·  ")}`;
    }
  }

  if (paymentLine) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: paymentLine }],
    });
  }

  // ── Linked receipts + Link / Complete buttons (OTP orders only) ──────────
  if (order.otpOverride) {
    for (const r of order.linkedReceipts || []) {
      const parts = [];
      if (r.payerName) parts.push(`Payer: *${r.payerName}*`);
      if (r.transactionRef) parts.push(`Ref: \`${r.transactionRef}\``);
      if (r.amount) parts.push(fmt(r.amount));
      if (r.linkedBy) parts.push(`Linked by <@${r.linkedBy}>`);
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `🧾  *Receipt linked* — ${parts.join("  ·  ")}` }],
      });
    }

    if (order.paymentComplete) {
      const completedBy = order.paymentCompletedBy
        ? `  ·  <@${order.paymentCompletedBy}>`
        : "";
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `✅  *Payment complete*${completedBy}` }],
      });
    } else {
      const btnLabel =
        order.linkedReceipts && order.linkedReceipts.length > 0
          ? "🧾 Link Another Receipt"
          : "🧾 Link Payment Receipt";
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: btnLabel },
            action_id: "link_receipt_btn",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "✅ Mark as Complete" },
            style: "primary",
            action_id: "mark_payment_complete",
            confirm: {
              title: { type: "plain_text", text: "Mark payment as complete?" },
              text: {
                type: "mrkdwn",
                text: "This will close the receipt linking flow. Use this when all receipts are linked or payment was made outside the system (e.g. cash).",
              },
              confirm: { type: "plain_text", text: "Yes, mark complete" },
              deny: { type: "plain_text", text: "Cancel" },
            },
          },
        ],
      });
    }
  }

  return blocks;
}

// ── Pre-parse duplicate warning ───────────────────────────────────────────────

function buildDuplicateWarningBlocks(duplicate) {
  const when = new Date(duplicate.confirmed_at).toLocaleString("en-NG", {
    timeZone: "Africa/Lagos",
  });
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `⚠️ *Duplicate order detected*\nThis exact message was already submitted as order \`${duplicate.order_number || "—"}\` for *${duplicate.customer_name || "—"}* on ${when}.\n\nWould you like to parse it anyway?`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel" },
          action_id: "cancel_parse",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Parse anyway" },
          style: "danger",
          action_id: "parse_anyway",
        },
      ],
    },
  ];
}

// ── Zone change modal ─────────────────────────────────────────────────────────

function buildZonePickerModal(currentAddress, privateMetadata) {
  const cities = store.getCities();
  const rideHailOptions = (cities.rideHailTiers || []).map((t) => ({
    text: {
      type: "plain_text",
      text: trunc(`${t.name} — ${fmt(t.price)}`, 75),
    },
    value: t.id,
  }));

  const pickupOptions = (cities.pickupRows || []).map((r) => ({
    text: { type: "plain_text", text: trunc(r.name, 75) },
    value: r.id,
  }));

  return {
    type: "modal",
    callback_id: "zone_picker_submit",
    private_metadata: privateMetadata,
    title: { type: "plain_text", text: "Change Zone" },
    submit: { type: "plain_text", text: "Apply" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "named_zone_select",
        label: { type: "plain_text", text: "Search delivery zone" },
        optional: true,
        element: {
          type: "external_select",
          action_id: "zone_search_select",
          placeholder: {
            type: "plain_text",
            text: 'Type to search all cities… e.g. "Lekki", "VI", "Ikoyi"',
          },
          min_query_length: 0,
        },
      },
      ...(rideHailOptions.length > 0
        ? [
            { type: "divider" },
            {
              type: "input",
              block_id: "ride_hail_select",
              label: {
                type: "plain_text",
                text: "Or select a ride-hail tier (Uber / Bolt)",
              },
              optional: true,
              element: {
                type: "static_select",
                action_id: "ride_hail_input",
                placeholder: { type: "plain_text", text: "Select tier…" },
                options: rideHailOptions,
              },
            },
          ]
        : []),
      ...(pickupOptions.length > 0
        ? [
            { type: "divider" },
            {
              type: "input",
              block_id: "pickup_select",
              label: {
                type: "plain_text",
                text: "Or select a pickup location",
              },
              optional: true,
              element: {
                type: "static_select",
                action_id: "pickup_input",
                placeholder: {
                  type: "plain_text",
                  text: "Select pickup location…",
                },
                options: pickupOptions,
              },
            },
          ]
        : []),
    ],
  };
}

// ── Mod: city picker modal (mirrors zone picker, mod-specific IDs) ────────────

function buildModCityPickerModal(privateMetadata) {
  const cities = store.getCities();
  const rideHailOptions = (cities.rideHailTiers || []).map((t) => ({
    text: { type: "plain_text", text: trunc(`${t.name} — ${fmt(t.price)}`, 75) },
    value: t.id,
  }));
  const pickupOptions = (cities.pickupRows || []).map((r) => ({
    text: { type: "plain_text", text: trunc(r.name, 75) },
    value: r.id,
  }));
  return {
    type: "modal",
    callback_id: "mod_city_picker_submit",
    private_metadata: privateMetadata,
    title: { type: "plain_text", text: "Change Delivery City" },
    submit: { type: "plain_text", text: "Apply" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "mod_named_zone_select",
        label: { type: "plain_text", text: "Search delivery zone" },
        optional: true,
        element: {
          type: "external_select",
          action_id: "mod_zone_search_select",
          placeholder: { type: "plain_text", text: 'Type to search… e.g. "Lekki", "VI", "Ikoyi"' },
          min_query_length: 0,
        },
      },
      ...(rideHailOptions.length > 0
        ? [
            { type: "divider" },
            {
              type: "input",
              block_id: "mod_ride_hail_select",
              label: { type: "plain_text", text: "Or select a ride-hail tier (Uber / Bolt)" },
              optional: true,
              element: {
                type: "static_select",
                action_id: "mod_ride_hail_input",
                placeholder: { type: "plain_text", text: "Select tier…" },
                options: rideHailOptions,
              },
            },
          ]
        : []),
      ...(pickupOptions.length > 0
        ? [
            { type: "divider" },
            {
              type: "input",
              block_id: "mod_pickup_select",
              label: { type: "plain_text", text: "Or select a pickup location" },
              optional: true,
              element: {
                type: "static_select",
                action_id: "mod_pickup_input",
                placeholder: { type: "plain_text", text: "Select pickup location…" },
                options: pickupOptions,
              },
            },
          ]
        : []),
    ],
  };
}

// ── Product search modal (searchable external_select) ─────────────────────────

function buildProductSearchModal(itemIndex, privateMetadata) {
  return {
    type: "modal",
    callback_id: "product_search_submit",
    private_metadata: JSON.stringify({
      ...JSON.parse(privateMetadata || "{}"),
      itemIndex,
    }),
    title: { type: "plain_text", text: "Search Products" },
    submit: { type: "plain_text", text: "Apply" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "product_select",
        label: { type: "plain_text", text: "Product & size" },
        element: {
          type: "external_select",
          action_id: "product_search_select",
          placeholder: {
            type: "plain_text",
            text: 'Type to search… e.g. "za", "banana 6", "choc"',
          },
          min_query_length: 1,
        },
      },
    ],
  };
}

function buildDatePickerModal(privateMetadata, initialDate) {
  const dateElement = {
    type: "datepicker",
    action_id: "date_pick",
    placeholder: { type: "plain_text", text: "Select delivery date" },
  };
  if (initialDate) dateElement.initial_date = initialDate;

  return {
    type: "modal",
    callback_id: "date_picker_submit",
    private_metadata: privateMetadata,
    title: { type: "plain_text", text: "Set Delivery Date" },
    submit: { type: "plain_text", text: "Apply" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "delivery_date_block",
        label: { type: "plain_text", text: "Delivery date" },
        element: dateElement,
      },
    ],
  };
}

function buildModAddSearchModal(meta) {
  return {
    type: "modal",
    callback_id: "mod_add_search_modal",
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text", text: "Search Products" },
    submit: { type: "plain_text", text: "Apply" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "product_select",
        label: { type: "plain_text", text: "Product & size" },
        element: {
          type: "external_select",
          action_id: "product_search_select",
          placeholder: {
            type: "plain_text",
            text: 'Type to search… e.g. "za", "banana 6", "choc"',
          },
          min_query_length: 1,
        },
      },
    ],
  };
}

// ── Modification review blocks ────────────────────────────────────────────────

function buildModReviewBlocks(mod, confirmedOrder) {
  const blocks = [];

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `📝 *ORDER MODIFICATION*\nOrder \`${confirmedOrder.orderNumber || "—"}\`  ·  ${confirmedOrder.customer?.name || "—"}`,
    },
  });
  blocks.push({ type: "divider" });

  // ── Customer update ───────────────────────────────────────────────────────
  if (mod.newName || mod.newPhone) {
    const lines = [];
    if (mod.newName) lines.push(`  👤  Name: *${mod.newName}*`);
    if (mod.newPhone) lines.push(`  📱  Phone: *${mod.newPhone}*`);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*CUSTOMER UPDATE:*\n${lines.join("\n")}` },
    });
  }

  // ── Recipient update ──────────────────────────────────────────────────────
  if (mod.newRecipient && (mod.newRecipient.name || mod.newRecipient.phone)) {
    const lines = [];
    if (mod.newRecipient.name)
      lines.push(`  👤  Name: *${mod.newRecipient.name}*`);
    if (mod.newRecipient.phone)
      lines.push(`  📱  Phone: *${mod.newRecipient.phone}*`);
    const prev = confirmedOrder.recipient
      ? [confirmedOrder.recipient.name, confirmedOrder.recipient.phone]
          .filter(Boolean)
          .join("  ·  ")
      : "none";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*RECIPIENT UPDATE* _(was: ${prev})_\n${lines.join("\n")}`,
      },
    });
  }

  // ── Resolved add items — show match prominently + Search all button ───────
  for (let i = 0; i < mod.addItems.length; i++) {
    const item = mod.addItems[i];
    const candidates = item.candidates || [];
    if (candidates.length > 1) {
      const options = candidates.map((c) => ({
        text: {
          type: "plain_text",
          text: trunc(`${c.productName} · ${c.sizeName} — ${fmt(c.price)}`, 75),
        },
        value: c.sizeId,
      }));
      const initial_option =
        options.find((o) => o.value === item.sizeId) || options[0];
      blocks.push({
        type: "section",
        block_id: `mod_add_pick_${i}`,
        text: {
          type: "mrkdwn",
          text: `➕  *Add ×${item.qty}:*  *${item.productName} · ${item.sizeName}* — ${fmt(item.lineTotal)}\n_${candidates.length} matches — tap to change:_`,
        },
        accessory: {
          type: "static_select",
          action_id: "mod_add_pick",
          initial_option,
          options,
        },
      });
    } else {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `➕  *Add ×${item.qty}:*  *${item.productName} · ${item.sizeName}* — ${fmt(item.lineTotal)}`,
        },
      });
    }
    blocks.push({
      type: "actions",
      block_id: `mod_add_btn_${i}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "🔍 Search all products" },
          action_id: "mod_add_search_btn",
          value: String(i),
        },
      ],
    });
  }

  // ── Unresolved additions — inline search + Search all button ─────────────
  for (let i = 0; i < mod.unresolvedAdditions.length; i++) {
    const ua = mod.unresolvedAdditions[i];
    blocks.push({
      type: "section",
      block_id: `mod_add_search_${i}`,
      text: {
        type: "mrkdwn",
        text: `⚠️  *"${trunc(ua.raw, 60)}"* — not found, search to add:`,
      },
      accessory: {
        type: "external_select",
        action_id: "mod_add_search",
        placeholder: { type: "plain_text", text: "Search products…" },
        min_query_length: 0,
      },
    });
    blocks.push({
      type: "actions",
      block_id: `mod_add_ubtn_${i}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "🔍 Search all products" },
          action_id: "mod_add_search_btn",
          value: `u_${i}`,
        },
      ],
    });
  }

  // ── Remove items — show match prominently + all-order-items dropdown ──────
  const allOrderOptions = (confirmedOrder.items || []).map((oi) => ({
    text: {
      type: "plain_text",
      text: trunc(
        `${oi.productName} · ${oi.sizeName} ×${oi.qty} — ${fmt(oi.unitPrice)}`,
        75,
      ),
    },
    value: oi.sizeId,
  }));

  for (let i = 0; i < mod.removeItems.length; i++) {
    const item = mod.removeItems[i];
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `➖  *Remove:*  *${item.productName} · ${item.sizeName}*  ×${item.qty}`,
      },
    });
    if (allOrderOptions.length > 0) {
      const initial_option =
        allOrderOptions.find((o) => o.value === item.sizeId) ||
        allOrderOptions[0];
      blocks.push({
        type: "section",
        block_id: `mod_remove_pick_${i}`,
        text: { type: "mrkdwn", text: `_Select which order item to remove:_` },
        accessory: {
          type: "static_select",
          action_id: "mod_remove_pick",
          initial_option,
          options: allOrderOptions,
        },
      });
    }
  }

  // ── Unresolved removals — pick from all order items ───────────────────────
  for (let j = 0; j < mod.unresolvedRemovals.length; j++) {
    const ur = mod.unresolvedRemovals[j];
    if (allOrderOptions.length > 0) {
      blocks.push({
        type: "section",
        block_id: `mod_remove_unresolved_${j}`,
        text: {
          type: "mrkdwn",
          text: `⚠️  *"${trunc(ur.raw, 40)}"* — not found in order. Select item to remove:`,
        },
        accessory: {
          type: "static_select",
          action_id: "mod_remove_unresolved_pick",
          placeholder: { type: "plain_text", text: "Select item to remove…" },
          options: allOrderOptions,
        },
      });
    } else {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `⚠️  *"${trunc(ur.raw, 40)}"* — not in this order`,
        },
      });
    }
  }

  // ── Scheduled date change ─────────────────────────────────────────────────
  if (mod.newScheduledDate) {
    const humanDate = new Date(
      mod.newScheduledDate + "T12:00:00",
    ).toLocaleDateString("en-NG", {
      timeZone: "Africa/Lagos",
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const prev = confirmedOrder.scheduledDate
      ? new Date(confirmedOrder.scheduledDate + "T12:00:00").toLocaleDateString(
          "en-NG",
          {
            timeZone: "Africa/Lagos",
            day: "numeric",
            month: "short",
            year: "numeric",
          },
        )
      : "same day";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `📅  *DELIVERY DATE*  _(was: ${prev})_\n  →  *${humanDate}*`,
      },
    });
  }

  // ── Zone change — always show picker when an address was detected ─────────
  if (mod.newAddress) {
    const prev =
      confirmedOrder.fulfillment?.zoneName ||
      confirmedOrder.fulfillment?.address ||
      "?";
    const matchText = mod.newZoneId
      ? `✅  Matched: *${mod.newZoneName}*  ${fmt(mod.newFee)}  (${mod.newBranch || ""})`
      : `⚠️  No zone matched for _"${mod.newAddress}"_ — search below`;
    blocks.push({
      type: "section",
      block_id: "mod_zone_search",
      text: {
        type: "mrkdwn",
        text: `*ADDRESS CHANGE* _(was: ${prev})_\n${matchText}`,
      },
      accessory: {
        type: "external_select",
        action_id: "mod_zone_select",
        placeholder: { type: "plain_text", text: "Confirm or change zone…" },
        min_query_length: 0,
      },
    });
  }

  blocks.push({ type: "divider" });

  // ── Payment gate / OTP pending states ─────────────────────────────────────
  if (mod.paymentStatus === "not_found") {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `💳  *Additional payment required: ${fmt(mod.modIncrease)}*\nNo matching payment found for this top-up amount. Verify the transfer or request an override.`,
      },
    });
    blocks.push({
      type: "actions",
      block_id: "mod_actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "🔁  Try Different Name" }, action_id: "mod_try_payment_name" },
        { type: "button", text: { type: "plain_text", text: "🔐  Request Override OTP" }, action_id: "mod_request_otp", style: "primary" },
        { type: "button", text: { type: "plain_text", text: "Cancel" }, action_id: "mod_reject" },
      ],
    });
    return blocks;
  }

  if (mod.paymentStatus === "otp_pending") {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `📲  *OTP sent to operator via WhatsApp*\nCollect the 6-digit code and enter it below.\n_Additional amount: ${fmt(mod.modIncrease)}_`,
      },
    });
    blocks.push({
      type: "actions",
      block_id: "mod_actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "🔐  Enter OTP" }, action_id: "mod_enter_otp", style: "primary" },
        { type: "button", text: { type: "plain_text", text: "Resend OTP" }, action_id: "mod_request_otp" },
        { type: "button", text: { type: "plain_text", text: "Cancel" }, action_id: "mod_reject" },
      ],
    });
    return blocks;
  }

  // ── Normal state ──────────────────────────────────────────────────────────
  const canApply =
    mod.addItems.length > 0 ||
    mod.removeItems.length > 0 ||
    mod.newZoneId ||
    mod.newName ||
    mod.newPhone ||
    mod.newScheduledDate ||
    (mod.newRecipient && (mod.newRecipient.name || mod.newRecipient.phone));
  const hasAnyChange =
    canApply ||
    mod.unresolvedAdditions.length > 0 ||
    (mod.newAddress && !mod.newZoneId);

  if (!hasAnyChange) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_No actionable changes found. Reply again with what you'd like to add, remove, or change._",
      },
    });
  }

  const actionElements = [
    { type: "button", text: { type: "plain_text", text: "Cancel" }, action_id: "mod_reject" },
    { type: "button", text: { type: "plain_text", text: "🗺️ Change City" }, action_id: "mod_city_picker_btn" },
  ];
  if (canApply) {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "Apply Modification" },
      style: "primary",
      action_id: "mod_confirm",
    });
  }
  blocks.push({ type: "actions", block_id: "mod_actions", elements: actionElements });

  return blocks;
}

// ── /menu modal ───────────────────────────────────────────────────────────────

function buildMenuContent(query) {
  const products = store.getProducts();
  const q = (query || "").toLowerCase().trim();

  const filtered = q
    ? products.filter((p) => (p.name || "").toLowerCase().includes(q))
    : products;

  if (filtered.length === 0) {
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `_No products found for "${trunc(query, 40)}"_`,
        },
      },
    ];
  }

  // Group by category, preserving insertion order
  const byCategory = new Map();
  for (const p of filtered) {
    const cat = p.category || "Products";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(p);
  }

  const blocks = [];

  for (const [category, prods] of byCategory) {
    if (blocks.length >= 93) break; // stay under 100-block modal limit

    blocks.push({
      type: "header",
      text: { type: "plain_text", text: trunc(category, 150) },
    });

    // Pack up to 10 products per section (renders as 5-row × 2-col grid in Slack)
    const CHUNK = 10;
    for (let i = 0; i < prods.length; i += CHUNK) {
      if (blocks.length >= 93) break;
      const fields = prods.slice(i, i + CHUNK).map((p) => {
        const validSizes = (p.sizes || []).filter(Boolean);
        const sizeText =
          validSizes.length > 0
            ? validSizes
                .map((s) => `${s.name}: *${fmt(s.price)}*`)
                .join("  ·  ")
            : "—";
        return { type: "mrkdwn", text: `*${trunc(p.name, 50)}*\n${sizeText}` };
      });
      blocks.push({ type: "section", fields });
    }

    blocks.push({ type: "divider" });
  }

  return blocks;
}

function buildMenuModal(query) {
  const q = query || "";
  return {
    type: "modal",
    callback_id: "menu_modal",
    title: { type: "plain_text", text: "Gourmet Twist Menu" },
    close: { type: "plain_text", text: "Close" },
    blocks: [
      {
        type: "input",
        block_id: "menu_search_block",
        dispatch_action: true,
        optional: true,
        label: { type: "plain_text", text: "Search" },
        element: {
          type: "plain_text_input",
          action_id: "menu_search_input",
          placeholder: {
            type: "plain_text",
            text: 'Filter products… e.g. "banana", "cake", "choc"',
          },
          initial_value: q,
          dispatch_action_config: {
            trigger_actions_on: ["on_character_entered"],
          },
        },
      },
      { type: "divider" },
      ...buildMenuContent(q),
    ],
  };
}

// ── /cities modal ─────────────────────────────────────────────────────────────

function buildCitiesModal() {
  return {
    type: "modal",
    title: { type: "plain_text", text: "Delivery Zones" },
    close: { type: "plain_text", text: "Close" },
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "Search all delivery zones and fees." },
      },
      {
        type: "actions",
        block_id: "cities_search",
        elements: [
          {
            type: "external_select",
            action_id: "cities_search_select",
            placeholder: {
              type: "plain_text",
              text: 'Type to search… e.g. "Lekki", "VI", "Chevron"',
            },
            min_query_length: 0,
          },
        ],
      },
    ],
  };
}

// ── /summary helpers ──────────────────────────────────────────────────────────

function summaryTotals(orders) {
  return {
    grandTotal: orders.reduce((s, o) => s + (o.orderTotal || 0), 0),
    itemsTotal: orders.reduce((s, o) => s + (o.itemsSubtotal || 0), 0),
    deliveryTotal: orders.reduce((s, o) => s + (o.fulfillment?.fee || 0), 0),
  };
}

// Shared per-order section blocks used by both the modal and the channel post.
function buildOrderSections(orders, cap) {
  const blocks = [];
  const shown = orders.slice(0, cap);

  if (orders.length > cap) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_Showing most recent ${cap} of ${orders.length} orders._`,
        },
      ],
    });
  }

  for (const order of shown) {
    const time = new Date(order._confirmedAt).toLocaleString("en-NG", {
      timeZone: "Africa/Lagos",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });

    const customerParts = [
      order.customer?.name,
      order.customer?.phone,
      order.customer?.instagram
        ? `@${order.customer.instagram.replace(/^@/, "")}`
        : null,
    ].filter(Boolean);

    const recipientLine =
      order.recipient?.name || order.recipient?.phone
        ? `📦 Recipient: ${[order.recipient.name, order.recipient.phone].filter(Boolean).join("  ·  ")}`
        : null;

    const isPickup = order.fulfillment?.type === "pickup";
    const fulfillmentLine = isPickup
      ? `📦 Pickup — ${order.fulfillment?.branch || "Lekki"}  _(₦0)_`
      : `🚚 ${order.fulfillment?.zoneName || order.fulfillment?.address || "—"}${order.fulfillment?.branch ? "  (" + order.fulfillment.branch + ")" : ""}  —  ${fmt(order.fulfillment?.fee)}`;

    const itemLines = (order.items || []).map(
      (i) =>
        `  ×${i.qty}  ${i.productName}  ·  _${i.sizeName}_  —  ${fmt(i.lineTotal)}`,
    );
    const notesLine =
      order.notes?.length > 0 ? `📌 _${order.notes.join(" · ")}_` : null;
    const orderNum = order.orderNumber
      ? `\`${order.orderNumber}\``
      : "_no order #_";
    const totalLine = `Subtotal: *${fmt(order.itemsSubtotal)}*   Delivery: *${fmt(order.fulfillment?.fee || 0)}*   *Total: ${fmt(order.orderTotal)}*`;

    const scheduledLine = order.scheduledDate
      ? `📅 Scheduled: ${new Date(order.scheduledDate + "T12:00:00").toLocaleDateString("en-NG", { timeZone: "Africa/Lagos", weekday: "short", day: "numeric", month: "short" })}`
      : null;

    const text = [
      `*${orderNum}*  ·  ${time}`,
      `👤 ${customerParts.join("  ·  ") || "—"}`,
      recipientLine,
      fulfillmentLine,
      scheduledLine,
      ...itemLines,
      notesLine,
      totalLine,
    ]
      .filter(Boolean)
      .join("\n");

    blocks.push({ type: "section", text: { type: "mrkdwn", text } });
    blocks.push({ type: "divider" });
  }

  return blocks;
}

// ── /summary modal ────────────────────────────────────────────────────────────

function buildSummaryModal(orders, dateLabel, channelId, userId, offsetDays) {
  const meta = JSON.stringify({
    channelId,
    userId,
    offsetDays: offsetDays || 0,
    dateLabel,
  });

  if (orders.length === 0) {
    return {
      type: "modal",
      callback_id: "summary_modal",
      private_metadata: meta,
      title: { type: "plain_text", text: "Daily Summary" },
      close: { type: "plain_text", text: "Close" },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*No orders confirmed by you on ${dateLabel}.*\n_Confirm an order via /parse-order or by mentioning the bot._`,
          },
        },
      ],
    };
  }

  const { grandTotal, itemsTotal, deliveryTotal } = summaryTotals(orders);

  return {
    type: "modal",
    callback_id: "summary_modal",
    private_metadata: meta,
    title: { type: "plain_text", text: "Daily Summary" },
    submit: { type: "plain_text", text: "Paste to channel" },
    close: { type: "plain_text", text: "Close" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `📊 *${orders.length} order${orders.length !== 1 ? "s" : ""} confirmed — ${dateLabel}*`,
            `Items: *${fmt(itemsTotal)}*   Delivery: *${fmt(deliveryTotal)}*   Grand total: *${fmt(grandTotal)}*`,
          ].join("\n"),
        },
      },
      { type: "divider" },
      ...buildOrderSections(orders, 45),
    ],
  };
}

// ── Channel summary post ──────────────────────────────────────────────────────

function buildSummaryChannelBlocks(orders, dateLabel, userId) {
  const { grandTotal, itemsTotal, deliveryTotal } = summaryTotals(orders);

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `📊 *Daily Summary — <@${userId}>*`,
          `_${dateLabel}_`,
          `${orders.length} order${orders.length !== 1 ? "s" : ""}   Items: *${fmt(itemsTotal)}*   Delivery: *${fmt(deliveryTotal)}*   Grand total: *${fmt(grandTotal)}*`,
        ].join("\n"),
      },
    },
    { type: "divider" },
    ...buildOrderSections(orders, 20), // messages cap at 50 blocks; 2 + 2×20 = 42
  ];
}

// ── End-of-day channel summary ────────────────────────────────────────────────

// ── Operations reports (daily / weekly / monthly) ─────────────────────────────

const DEPT_DISPLAY = {
  KITCHEN: "Kitchen",
  BAKERY: "Bakery",
  PACKINGBAKERY: "Packing",
  BREAKFAST: "Breakfast",
};

// ── Shared helpers ────────────────────────────────────────────────────────────

function _buildDeptText(k) {
  const depts = Object.entries(k.departments || {}).filter(
    ([, d]) => (d.totalScanned || 0) > 0,
  );
  if (depts.length === 0) return null;

  const deptLines = depts.map(([key, d]) => {
    const name = DEPT_DISPLAY[key] || key;
    return [
      `*${name}*`,
      `• Avg Time: *${Math.round(d.avgTimeMinutes)} mins*`,
      `• Orders On Time: *${d.onTime ?? 0}*`,
      `• Orders Delayed: *${d.delayed ?? 0}*`,
    ].join("\n");
  });

  const sorted = [...depts].sort(
    (a, b) => a[1].avgTimeMinutes - b[1].avgTimeMinutes,
  );
  const fastest = DEPT_DISPLAY[sorted[0][0]] || sorted[0][0];
  const slowest =
    DEPT_DISPLAY[sorted[sorted.length - 1][0]] || sorted[sorted.length - 1][0];

  return {
    text: [
      "*🏭  Department Performance*",
      "",
      deptLines.join("\n\n"),
      "",
      `🏆 *Fastest:* ${fastest}   🐢 *Slowest:* ${slowest}`,
    ].join("\n"),
    sorted,
  };
}

function _buildCsrText(csrOrders) {
  if (csrOrders.length === 0) return null;
  const byUser = {};
  for (const o of csrOrders) {
    // Use parsedBy (name from initial) if available; fall back to Slack mention for old orders
    const u = o.parsedBy || (o._confirmedBy ? `<@${o._confirmedBy}>` : "unknown");
    byUser[u] = (byUser[u] || 0) + 1;
  }
  const sorted = Object.entries(byUser).sort((a, b) => b[1] - a[1]);
  const lines = sorted.map(([name, cnt]) =>
    `${name === "unknown" ? "Unknown" : name} — *${cnt}* orders`,
  );
  const top = sorted[0];
  const bottom = sorted[sorted.length - 1];
  const footer = [
    top ? `🏆 *Top Performer:* ${top[0]} (${top[1]})` : null,
    bottom && bottom[0] !== top[0]
      ? `📉 *Lowest Performer:* ${bottom[0]} (${bottom[1]})`
      : null,
  ].filter(Boolean);
  return ["*👥  CSR Performance*", ...lines, "", ...footer]
    .filter((s) => s !== "")
    .join("\n");
}

function _buildAlertsText(k) {
  const alerts = k.alerts || {};
  const delayed = (k.orders || {}).delayed ?? 0;
  const lines = [];

  if (alerts.primaryDelayOrigin && delayed > 0) {
    const origin =
      DEPT_DISPLAY[alerts.primaryDelayOrigin] || alerts.primaryDelayOrigin;
    lines.push(
      `• *${delayed}* delayed order${delayed !== 1 ? "s" : ""} — primary origin: *${origin}*`,
    );
  }
  if (alerts.longestDelayedOrder) {
    const lo = alerts.longestDelayedOrder;
    const dept = DEPT_DISPLAY[lo.delayOriginDept] || lo.delayOriginDept || "—";
    lines.push(
      `• Longest delay: *${lo.totalMinutes} mins*  (Order \`${lo.orderNumber}\`, origin: ${dept})`,
    );
  }

  return lines.length > 0
    ? ["*⚠️  Operational Alerts*", ...lines].join("\n")
    : null;
}

function _cmpIcon(diff, lowerIsBetter = false) {
  if (diff === 0) return "🟰";
  return (lowerIsBetter ? diff < 0 : diff > 0) ? "✅" : "❌";
}

function _cmpLine(icon, label, diff, currentValue, unit = "") {
  const u = unit ? ` ${unit}` : "";
  if (diff === 0) return `${icon} ${label}: ${currentValue}${u} (no change)`;
  return `${icon} ${label}: ${diff > 0 ? "+" : ""}${diff}${u}`;
}

function _buildComparisonText(today, prev, label) {
  if (!prev) return null;
  const ko = (today || {}).orders || {};
  const po = (prev || {}).orders || {};

  const totalDiff = (ko.processed ?? 0) - (po.processed ?? 0);
  const onTimeDiff = (ko.onTime ?? 0) - (po.onTime ?? 0);
  const delayedDiff = (ko.delayed ?? 0) - (po.delayed ?? 0);
  const avgNow = Math.round((today || {}).avgProcessingTimeMinutes ?? 0);
  const avgDiff =
    avgNow - Math.round((prev || {}).avgProcessingTimeMinutes ?? 0);

  return [
    `*📈  Comparison to ${label}*`,
    _cmpLine(_cmpIcon(totalDiff), "Total Orders", totalDiff, ko.processed ?? 0),
    _cmpLine(
      _cmpIcon(onTimeDiff),
      "Orders Completed On Time",
      onTimeDiff,
      ko.onTime ?? 0,
    ),
    _cmpLine(
      _cmpIcon(avgDiff, true),
      "Avg Processing Time",
      avgDiff,
      avgNow,
      "mins",
    ),
    _cmpLine(
      _cmpIcon(delayedDiff, true),
      "Delayed Orders",
      delayedDiff,
      ko.delayed ?? 0,
    ),
  ].join("\n");
}

function _buildOtpPaymentsText(otpOrders) {
  const lines = ["*💳  Unconfirmed Payments*"];
  if (otpOrders.length === 0) {
    lines.push("• None this week.");
    return lines.join("\n");
  }
  for (const o of otpOrders) {
    const orderNum = o.orderNumber || o.clientReference || "—";
    const price = o.orderTotal
      ? `₦${Number(o.orderTotal).toLocaleString("en-NG")}`
      : "—";
    const auth = o._otpAuthorizedBy ? `<@${o._otpAuthorizedBy}>` : "—";
    lines.push(`• Order \`${orderNum}\` | ${price}\n  Authorised by: ${auth}`);
  }
  return lines.join("\n");
}

function _buildExecutiveSummaryText(k, prevData, periodName) {
  const ko = (k || {}).orders || {};
  const total = ko.processed ?? 0;
  const bullets = [];

  bullets.push(
    `• *${total.toLocaleString()}* orders were processed during ${periodName}.`,
  );

  if (prevData) {
    const avgNow = Math.round(k.avgProcessingTimeMinutes ?? 0);
    const avgPrev = Math.round(prevData.avgProcessingTimeMinutes ?? 0);
    const avgDiff = avgNow - avgPrev;
    const avgPct =
      avgPrev > 0 ? Math.abs(Math.round((avgDiff / avgPrev) * 100)) : null;
    if (avgDiff < 0) {
      bullets.push(
        `• Average processing time *improved by ${Math.abs(avgDiff)} mins*${avgPct ? ` (${avgPct}%)` : ""} compared to last month.`,
      );
    } else if (avgDiff > 0) {
      bullets.push(
        `• Average processing time *increased by ${avgDiff} mins*${avgPct ? ` (${avgPct}%)` : ""} compared to last month.`,
      );
    }

    const delayedNow = ko.delayed ?? 0;
    const delayedPrev = (prevData.orders || {}).delayed ?? 0;
    const delayedDiff = delayedNow - delayedPrev;
    if (delayedDiff < 0 && delayedPrev > 0) {
      const pct = Math.abs(Math.round((delayedDiff / delayedPrev) * 100));
      bullets.push(
        `• Delayed orders *reduced by ${pct}%* compared to last month.`,
      );
    }
  }

  const depts = Object.entries(k.departments || {}).filter(
    ([, d]) => (d.totalScanned || 0) > 0,
  );
  if (depts.length > 0) {
    const sorted = [...depts].sort(
      (a, b) => a[1].avgTimeMinutes - b[1].avgTimeMinutes,
    );
    const fastestName = DEPT_DISPLAY[sorted[0][0]] || sorted[0][0];
    bullets.push(
      `• *${fastestName}* was the fastest department for the month.`,
    );

    const totalDelayed = depts.reduce((s, [, d]) => s + (d.delayed ?? 0), 0);
    if (totalDelayed > 0) {
      const mostDelayed = depts.reduce(
        (a, b) => ((b[1].delayed ?? 0) > (a[1].delayed ?? 0) ? b : a),
        depts[0],
      );
      const pct = Math.round(
        ((mostDelayed[1].delayed ?? 0) / totalDelayed) * 100,
      );
      const name = DEPT_DISPLAY[mostDelayed[0]] || mostDelayed[0];
      bullets.push(`• *${name}* contributed *${pct}%* of all delayed orders.`);
    }
  }

  return bullets.join("\n");
}

const _footer = {
  type: "context",
  elements: [
    { type: "mrkdwn", text: "_Powered by Gourmet Twist Operations Bot_" },
  ],
};

// ── Daily Operations Report ───────────────────────────────────────────────────

function buildDailyReportBlocks(
  kitchenData,
  yesterdayData,
  csrOrders,
  dateLabel,
) {
  const k = kitchenData || {};
  const orders = k.orders || {};
  const blocks = [];

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: "📊  Daily Operations Report" },
  });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `_${dateLabel}_` }],
  });
  blocks.push({ type: "divider" });

  const total = orders.processed ?? 0;
  const onTime = orders.onTime ?? 0;
  const delayed = orders.delayed ?? 0;
  const csrCount = csrOrders.length;
  const pct = total > 0 ? ((onTime / total) * 100).toFixed(1) : "—";
  const avgMins =
    k.avgProcessingTimeMinutes != null
      ? `${Math.round(k.avgProcessingTimeMinutes)} mins`
      : "—";

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: [
        "*📦  Order Summary*",
        `• Total Orders: *${total}*`,
        `• Total Orders by CSRs: *${csrCount}*`,
        `• Orders Completed On Time: *${onTime}*  (${pct}%)`,
        `• Delayed Orders: *${delayed}*`,
        `• Avg Processing Time: *${avgMins}*`,
      ].join("\n"),
    },
  });
  blocks.push({ type: "divider" });

  const deptResult = _buildDeptText(k);
  if (deptResult) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: deptResult.text },
    });
    blocks.push({ type: "divider" });
  }

  const csrText = _buildCsrText(csrOrders);
  if (csrText) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: csrText } });
    blocks.push({ type: "divider" });
  }

  const alertsText = _buildAlertsText(k);
  if (alertsText) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: alertsText },
    });
    blocks.push({ type: "divider" });
  }

  const cmpText = _buildComparisonText(kitchenData, yesterdayData, "Yesterday");
  if (cmpText) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: cmpText } });
  }

  blocks.push(_footer);
  return blocks;
}

// ── Weekly Operations Report ──────────────────────────────────────────────────
// otpOrders: from getOtpOverridesForPeriod — orders confirmed via OTP override

function buildWeeklyReportBlocks(
  kitchenData,
  prevData,
  csrOrders,
  otpOrders,
  periodLabel,
) {
  const k = kitchenData || {};
  const orders = k.orders || {};
  const blocks = [];

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: "📊  Weekly Operations Report" },
  });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `_${periodLabel}_` }],
  });
  blocks.push({ type: "divider" });

  const total = orders.processed ?? 0;
  const onTime = orders.onTime ?? 0;
  const delayed = orders.delayed ?? 0;
  const csrCount = csrOrders.length;
  const otpCount = (otpOrders || []).length;
  const avgMins =
    k.avgProcessingTimeMinutes != null
      ? `${Math.round(k.avgProcessingTimeMinutes)} mins`
      : "—";

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: [
        "*📦  Order Summary*",
        `• Total Orders: *${total.toLocaleString()}*`,
        `• Total Orders by CSRs: *${csrCount.toLocaleString()}*`,
        `• Orders Completed On Time: *${onTime.toLocaleString()}*`,
        `• Delayed Orders: *${delayed.toLocaleString()}*`,
        `• Avg Processing Time: *${avgMins}*`,
        `• Unconfirmed Payments: *${otpCount}*`,
      ].join("\n"),
    },
  });
  blocks.push({ type: "divider" });

  const deptResult = _buildDeptText(k);
  if (deptResult) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: deptResult.text },
    });
    blocks.push({ type: "divider" });
  }

  const csrText = _buildCsrText(csrOrders);
  if (csrText) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: csrText } });
    blocks.push({ type: "divider" });
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: _buildOtpPaymentsText(otpOrders || []) },
  });
  blocks.push({ type: "divider" });

  const alertsText = _buildAlertsText(k);
  if (alertsText) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: alertsText },
    });
    blocks.push({ type: "divider" });
  }

  const cmpText = _buildComparisonText(kitchenData, prevData, "Last Week");
  if (cmpText) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: cmpText } });
  }

  blocks.push(_footer);
  return blocks;
}

// ── Monthly Operations Report ─────────────────────────────────────────────────

function buildMonthlyReportBlocks(
  kitchenData,
  prevData,
  csrOrders,
  periodLabel,
) {
  const k = kitchenData || {};
  const orders = k.orders || {};
  const blocks = [];

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: "📊  Monthly Operations Report" },
  });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `_${periodLabel}_` }],
  });
  blocks.push({ type: "divider" });

  // Executive Summary — extract just the month name from periodLabel (first word)
  const monthName = periodLabel.split(/[\s·,]+/)[0];
  const execText = _buildExecutiveSummaryText(k, prevData, monthName);
  if (execText) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: ["*📌  Executive Summary*", execText].join("\n"),
      },
    });
    blocks.push({ type: "divider" });
  }

  const total = orders.processed ?? 0;
  const onTime = orders.onTime ?? 0;
  const delayed = orders.delayed ?? 0;
  const csrCount = csrOrders.length;
  const avgMins =
    k.avgProcessingTimeMinutes != null
      ? `${Math.round(k.avgProcessingTimeMinutes)} mins`
      : "—";

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: [
        "*📦  Order Summary*",
        `• Total Orders: *${total.toLocaleString()}*`,
        `• Total Orders by CSRs: *${csrCount.toLocaleString()}*`,
        `• Orders Completed On Time: *${onTime.toLocaleString()}*`,
        `• Delayed Orders: *${delayed.toLocaleString()}*`,
        `• Avg Processing Time: *${avgMins}*`,
      ].join("\n"),
    },
  });
  blocks.push({ type: "divider" });

  const deptResult = _buildDeptText(k);
  if (deptResult) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: deptResult.text },
    });
    blocks.push({ type: "divider" });
  }

  const csrText = _buildCsrText(csrOrders);
  if (csrText) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: csrText } });
    blocks.push({ type: "divider" });
  }

  const alertsText = _buildAlertsText(k);
  if (alertsText) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: alertsText },
    });
    blocks.push({ type: "divider" });
  }

  const cmpText = _buildComparisonText(kitchenData, prevData, "Last Month");
  if (cmpText) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: cmpText } });
  }

  blocks.push(_footer);
  return blocks;
}

// ── Payment verification / OTP flow blocks ────────────────────────────────────

function buildPaymentNotFoundBlocks(order) {
  const customer = order.customer?.name || "Unknown";
  const recipient = order.recipient?.name || customer;
  const amount = fmt(order.orderTotal);
  const ref = order.clientReference || "—";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `❌  *No matching payment found*`,
          `Customer: *${customer}*  ·  Recipient: *${recipient}*  ·  Amount: *${amount}*`,
          `Ref: \`${ref}\``,
          `\nNo payment from the last 24 hours matches this order. You can request an override OTP from the operator to proceed without a matched payment.`,
        ].join("\n"),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "💱  Adjust Amount" },
          action_id: "amount_adjust",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "📲  Request Override OTP" },
          action_id: "request_otp",
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Back to Review" },
          action_id: "back_to_review",
        },
      ],
    },
  ];
}

function buildAmountAdjustModal(privateMetadata, orderTotal, limit) {
  return {
    type: "modal",
    callback_id: "amount_adjust_submit",
    private_metadata: privateMetadata,
    title: { type: "plain_text", text: "Adjust Search Amount" },
    submit: { type: "plain_text", text: "Search" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `Order total: *${fmt(orderTotal)}*`,
            ``,
            `Enter the difference between the order total and the actual payment amount.`,
            `Use a *negative* value if the customer paid *more* than the order total.`,
            ``,
            `_Example: order ₦10,000, customer paid ₦10,500 → enter \`-500\`_`,
            `_Maximum allowed: ±${fmt(limit)}_`,
          ].join("\n"),
        },
      },
      {
        type: "input",
        block_id: "adjust_amount_block",
        label: { type: "plain_text", text: "Amount difference" },
        element: {
          type: "plain_text_input",
          action_id: "adjust_amount_input",
          placeholder: { type: "plain_text", text: "e.g.  -500  or  300" },
        },
      },
    ],
  };
}

function buildOtpPendingBlocks(order) {
  const ref = order.clientReference || "—";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `📲  *OTP sent to manager*`,
          `Collect the 6-digit code from the designated operator and enter it below.`,
          `Ref: \`${ref}\`  ·  _OTP is valid for 30 minutes._`,
        ].join("\n"),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "🔐  Enter OTP" },
          action_id: "enter_otp",
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Resend OTP" },
          action_id: "request_otp",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Back to Review" },
          action_id: "back_to_review",
        },
      ],
    },
  ];
}

function buildPaymentNameModal(privateMetadata) {
  return {
    type: "modal",
    callback_id: "payment_name_submit",
    private_metadata: privateMetadata,
    title: { type: "plain_text", text: "Payment Name" },
    submit: { type: "plain_text", text: "Search Payment" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Enter the name exactly as it appears on the payment transfer.",
          },
        ],
      },
      {
        type: "input",
        block_id: "payment_name_block",
        label: { type: "plain_text", text: "Name on payment" },
        element: {
          type: "plain_text_input",
          action_id: "payment_name_input",
          placeholder: { type: "plain_text", text: "e.g. Chukwuemeka Okafor" },
        },
      },
    ],
  };
}

// notice: optional string shown at the top (e.g. "OTP resent." confirmation)
function buildOtpModal(privateMetadata, opts = {}) {
  const noticeText =
    opts.notice ||
    "📲  OTP sent to operator via WhatsApp. Collect the 6-digit code and enter it below.";

  return {
    type: "modal",
    callback_id: "otp_verify_submit",
    private_metadata: privateMetadata,
    title: { type: "plain_text", text: "Override OTP" },
    submit: { type: "plain_text", text: "Verify OTP" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: noticeText }],
      },
      {
        type: "input",
        block_id: "otp_block",
        label: { type: "plain_text", text: "OTP Code" },
        hint: {
          type: "plain_text",
          text: "Enter the 6-digit code sent to the operator.",
        },
        element: {
          type: "plain_text_input",
          action_id: "otp_input",
          placeholder: { type: "plain_text", text: "123456" },
          max_length: 6,
          min_length: 6,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "🔄  Resend OTP" },
            action_id: "resend_otp_modal",
          },
        ],
      },
    ],
  };
}

// ── /availability modal ────────────────────────────────────────────────────────

function _formatAvailQty(size) {
  const branches = Object.values(size.availableQuantity || {});
  if (branches.length === 0) return "—";
  return branches.map((b) => `${b.branchName}: ${b.quantity}`).join("  ·  ");
}

// Shared filter: (1) only products with at least 1 unit available somewhere,
// (2) search by category, product name, or size name.
// Size-only match narrows displayed sizes to the matching ones.
function applyAvailabilityFilter(products, query) {
  const available = products.filter((p) =>
    (p.sizes || []).some((s) =>
      Object.values(s.availableQuantity || {}).some((b) => b.quantity > 0),
    ),
  );
  if (!query) return available;
  const q = query.toLowerCase().trim();
  return available.flatMap((p) => {
    const nameMatch = (p.name || "").toLowerCase().includes(q);
    const catMatch = (p.category || "").toLowerCase().includes(q);
    const matchingSizes = (p.sizes || []).filter((s) =>
      (s.name || "").toLowerCase().includes(q),
    );
    if (!nameMatch && !catMatch && !matchingSizes.length) return [];
    return [{ ...p, sizes: nameMatch || catMatch ? p.sizes : matchingSizes }];
  });
}

function buildAvailabilityContent(products, query) {
  const filtered = applyAvailabilityFilter(products, query);

  if (filtered.length === 0) {
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: query
            ? `_No available products found for "${trunc(query, 40)}"_`
            : "_No products with available stock._",
        },
      },
    ];
  }

  const byCategory = new Map();
  for (const p of filtered) {
    const cat = p.category || "Products";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(p);
  }

  const blocks = [];
  for (const [category, prods] of byCategory) {
    if (blocks.length >= 92) break;
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: trunc(category, 150) },
    });

    for (const p of prods) {
      if (blocks.length >= 92) break;
      const validSizes = (p.sizes || []).filter(Boolean);
      if (validSizes.length === 0) continue;

      const sizeLines = validSizes
        .map((s) => `• *${s.name}* (${fmt(s.price)}):  ${_formatAvailQty(s)}`)
        .join("\n");

      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*${trunc(p.name, 50)}*\n${sizeLines}` },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "📋" },
          action_id: "avail_copy_product",
          value: trunc(p.name, 255),
        },
      });
    }

    blocks.push({ type: "divider" });
  }

  return blocks;
}

function buildAvailabilityModal(products, query, privateMetadata) {
  const q = query || "";
  return {
    type: "modal",
    callback_id: "availability_modal",
    private_metadata: privateMetadata || "{}",
    title: { type: "plain_text", text: "Product Availability" },
    close: { type: "plain_text", text: "Close" },
    blocks: [
      {
        type: "input",
        block_id: "avail_search_block",
        dispatch_action: true,
        optional: true,
        label: { type: "plain_text", text: "Search products" },
        element: {
          type: "plain_text_input",
          action_id: "availability_search_input",
          placeholder: {
            type: "plain_text",
            text: 'Filter by name, category, or size — e.g. "cake", "midi"',
          },
          initial_value: q,
          dispatch_action_config: {
            trigger_actions_on: ["on_character_entered"],
          },
        },
      },
      {
        type: "actions",
        block_id: "avail_copy_all_block",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "📋 Copy List" },
            action_id: "avail_copy_all",
          },
        ],
      },
      { type: "divider" },
      ...buildAvailabilityContent(products, q),
    ],
  };
}

// ── Receipt lookup modal (step 1) ─────────────────────────────────────────────

function buildReceiptLookupModal(privateMetadata, order) {
  return {
    type: "modal",
    callback_id: "receipt_lookup_submit",
    private_metadata:
      typeof privateMetadata === "string"
        ? privateMetadata
        : JSON.stringify(privateMetadata),
    title: { type: "plain_text", text: "Link Payment Receipt" },
    submit: { type: "plain_text", text: "Search" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Enter a transaction reference for an exact match, or search by payer name and amount.",
        },
      },
      {
        type: "input",
        block_id: "ref_block",
        optional: true,
        label: { type: "plain_text", text: "Transaction Reference" },
        element: {
          type: "plain_text_input",
          action_id: "ref_input",
          placeholder: { type: "plain_text", text: "e.g. SQGOUR..." },
        },
      },
      {
        type: "input",
        block_id: "name_block",
        optional: true,
        label: { type: "plain_text", text: "Payer Name" },
        element: {
          type: "plain_text_input",
          action_id: "name_input",
          initial_value: order?.customer?.name || "",
        },
      },
      {
        type: "input",
        block_id: "amount_block",
        optional: true,
        label: { type: "plain_text", text: "Amount" },
        element: {
          type: "plain_text_input",
          action_id: "amount_input",
          initial_value: order?.orderTotal != null ? String(order.orderTotal) : "",
        },
      },
    ],
  };
}

// ── Receipt found modal (step 2) ──────────────────────────────────────────────

function buildReceiptFoundModal(privateMetadata, receipt) {
  const paidAt = receipt.paidAt
    ? new Date(receipt.paidAt).toLocaleString("en-NG", {
        timeZone: "Africa/Lagos",
      })
    : "—";
  return {
    type: "modal",
    callback_id: "receipt_found_modal",
    private_metadata:
      typeof privateMetadata === "string"
        ? privateMetadata
        : JSON.stringify(privateMetadata),
    title: { type: "plain_text", text: "Link Payment Receipt" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "✅ Receipt found — confirm to link it to this order.",
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Payer*\n${receipt.payerName || "—"}` },
          { type: "mrkdwn", text: `*Amount*\n${fmt(receipt.amount)}` },
          {
            type: "mrkdwn",
            text: `*Ref*\n\`${receipt.transactionRef}\``,
          },
          { type: "mrkdwn", text: `*Status*\n${receipt.status || "—"}` },
          { type: "mrkdwn", text: `*Paid at*\n${paidAt}` },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "✅ Confirm & Link" },
            style: "primary",
            action_id: "confirm_receipt_link",
          },
        ],
      },
    ],
  };
}

module.exports = {
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
  buildMenuModal,
  buildCitiesModal,
  buildSummaryModal,
  buildSummaryChannelBlocks,
  buildDailyReportBlocks,
  buildWeeklyReportBlocks,
  buildMonthlyReportBlocks,
  buildPaymentNotFoundBlocks,
  buildOtpPendingBlocks,
  buildPaymentNameModal,
  buildOtpModal,
  buildAvailabilityModal,
  applyAvailabilityFilter,
  buildAmountAdjustModal,
  buildReceiptLookupModal,
  buildReceiptFoundModal,
};
