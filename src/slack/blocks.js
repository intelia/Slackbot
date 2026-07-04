'use strict';

const { rideHailTiers, namedZones, pickupRows } = require('../parser/matcher');
const store = require('../data/store');

function fmt(n) {
  if (n == null) return '—';
  return '₦' + Number(n).toLocaleString('en-NG');
}

function trunc(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ── Line item blocks ──────────────────────────────────────────────────────────

function matchedItemBlock(item) {
  const label = `✅  *${item.productName} · ${item.sizeName}*  ×${item.qty}  —  ${fmt(item.lineTotal)}`;
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: label },
    accessory: {
      type: 'button',
      text: { type: 'plain_text', text: 'Edit' },
      action_id: `edit_item_${item.index}`,
      value: String(item.index),
    },
  };
}

function ambiguousItemBlock(item) {
  const blocks = [];

  const headerText = item.issue === 'unmatched'
    ? `❌  *"${trunc(item.raw, 60)}"* — no match found`
    : item.issue === 'price_mismatch'
    ? `⚠️  *"${trunc(item.raw, 60)}"* — price mismatch (stated ${fmt(item.statedPrice)}, catalogue ${fmt(item.candidates[0]?.price)})`
    : `⚠️  *"${trunc(item.raw, 60)}"* — select the correct product:`;

  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: headerText } });

  // Candidate picker (up to 5, plus a placeholder "none of these")
  const candidateOptions = item.candidates.slice(0, 5).map(c => ({
    text: { type: 'plain_text', text: trunc(`${c.productName} · ${c.sizeName} — ${fmt(c.price)}${c.priceMatch ? ' ✓' : ''}`, 75) },
    value: c.sizeId,
  }));

  if (candidateOptions.length > 0) {
    blocks.push({
      type: 'actions',
      block_id: `item_actions_${item.index}`,
      elements: [
        {
          type: 'static_select',
          action_id: `product_pick_${item.index}`,
          placeholder: { type: 'plain_text', text: 'Pick product…' },
          options: candidateOptions,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Search all' },
          action_id: `search_product_${item.index}`,
          value: String(item.index),
        },
      ],
    });
  } else {
    blocks.push({
      type: 'actions',
      block_id: `item_actions_${item.index}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔍 Search all products' },
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
  const currentOption = item.sizeId ? {
    text: { type: 'plain_text', text: trunc(`${item.productName} · ${item.sizeName} — ${fmt(item.unitPrice)}`, 75) },
    value: item.sizeId,
  } : null;

  const options = [];
  if (currentOption) options.push(currentOption);
  item.candidates.slice(0, 4).filter(c => c.sizeId !== item.sizeId).forEach(c => {
    options.push({
      text: { type: 'plain_text', text: trunc(`${c.productName} · ${c.sizeName} — ${fmt(c.price)}`, 75) },
      value: c.sizeId,
    });
  });

  if (options.length === 0) {
    return [{ type: 'section', text: { type: 'mrkdwn', text: `✏️  *"${item.raw}"* — search to replace:` } },
      { type: 'actions', block_id: `item_actions_${item.index}`, elements: [{ type: 'button', text: { type: 'plain_text', text: '🔍 Search all products' }, action_id: `search_product_${item.index}`, value: String(item.index) }] }];
  }

  return [
    { type: 'section', text: { type: 'mrkdwn', text: `✏️  *"${item.raw}"* — change product:` } },
    {
      type: 'actions',
      block_id: `item_actions_${item.index}`,
      elements: [
        {
          type: 'static_select',
          action_id: `product_pick_${item.index}`,
          initial_option: currentOption,
          placeholder: { type: 'plain_text', text: 'Select product…' },
          options: options.slice(0, 5),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Search all' },
          action_id: `search_product_${item.index}`,
          value: String(item.index),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Done' },
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
  const unresolvedItems = order.items.filter(i => i.issue !== null);
  const zoneUnresolved = !order.fulfillment.resolved || !order.fulfillment.zoneId;

  // Header
  const needsReviewCount = unresolvedItems.length + (zoneUnresolved ? 1 : 0);
  const hasMismatch = needsReviewCount === 0 && order.reconciliation.status === 'mismatch';
  const statusText = needsReviewCount > 0
    ? `⚠️  *Needs review* — ${needsReviewCount} unresolved`
    : hasMismatch
    ? `⚠️  *Price mismatch* — all items resolved but total is off by ${fmt(Math.abs(order.reconciliation.gap))}`
    : order.status === 'auto_accepted' ? '✅  *Auto-accepted* — verify and confirm' : '✅  *All items resolved* — ready to confirm';

  const refLine = order.clientReference ? `Ref: \`${order.clientReference}\`` : '';
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*REVIEW ORDER*${refLine ? '  ·  ' + refLine : ''}\n${statusText}` },
  });
  blocks.push({ type: 'divider' });

  // Customer
  const { customer, fulfillment } = order;
  const customerParts = [customer.name, customer.instagram, customer.phone].filter(Boolean);
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*CUSTOMER*\n${customerParts.join('  ·  ') || '—'}` },
  });

  if (order.recipient && (order.recipient.name || order.recipient.phone)) {
    const recipientParts = [order.recipient.name, order.recipient.phone].filter(Boolean);
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `📦  *Recipient:*  ${recipientParts.join('  ·  ')}` }],
    });
  }

  // Fulfillment
  const fulfillmentDesc = fulfillment.type === 'pickup'
    ? `◉ *Pickup* — ${fulfillment.branch || 'Lekki'}  (₦0)`
    : fulfillment.zoneName
    ? `◉ *Delivery* — ${fulfillment.zoneName}  ${fmt(fulfillment.fee)}${fulfillment.branch ? '  (' + fulfillment.branch + ')' : ''}`
    : `⚠️  *Delivery zone not resolved* — "${fulfillment.address || '?'}"`;

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: fulfillmentDesc },
    accessory: {
      type: 'button',
      text: { type: 'plain_text', text: 'Change zone' },
      action_id: 'change_zone',
      value: 'change',
    },
  });

  {
    const humanDate = order.scheduledDate
      ? new Date(order.scheduledDate + 'T12:00:00').toLocaleDateString('en-NG', {
          timeZone: 'Africa/Lagos', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        })
      : null;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: humanDate ? `📅  *Delivery date:*  ${humanDate}` : `📅  _No delivery date set_`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: order.scheduledDate ? 'Change date' : 'Set date' },
        action_id: 'change_date',
        value: 'change_date',
      },
    });
  }

  blocks.push({ type: 'divider' });

  // Items
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*ITEMS*' } });

  for (const item of order.items) {
    if (editingItemIndex === item.index) {
      editableItemBlock(item).forEach(b => blocks.push(b));
    } else if (item.issue !== null) {
      ambiguousItemBlock(item).forEach(b => blocks.push(b));
    } else {
      blocks.push(matchedItemBlock(item));
    }
  }

  blocks.push({ type: 'divider' });

  // Totals
  const reconcText = order.reconciliation.status === 'matched'
    ? '✅  Matches customer\'s stated total'
    : order.reconciliation.status === 'unknown'
    ? '—  No stated total to verify'
    : `⚠️  Off by ${fmt(Math.abs(order.reconciliation.gap))}${order.reconciliation.hypothesis ? ' — ' + order.reconciliation.hypothesis : ''}`;

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        `Items:  *${fmt(order.itemsSubtotal)}*`,
        `Delivery:  *${fmt(order.fulfillment.fee || 0)}*`,
        `─────────────────`,
        `TOTAL:  *${fmt(order.orderTotal)}*`,
        reconcText,
      ].join('\n'),
    },
  });

  // Notes
  if (order.notes && order.notes.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `📌 *Note:* ${order.notes.join(' · ')}` }],
    });
  }

  blocks.push({ type: 'divider' });

  // Action buttons
  const canConfirm = unresolvedItems.length === 0 && !zoneUnresolved;

  const confirmButton = {
    type: 'button',
    text: { type: 'plain_text', text: canConfirm ? 'Confirm & Push to Zupa' : '🔒 Resolve issues first' },
    style: canConfirm ? 'primary' : undefined,
    action_id: 'confirm_order',
    value: 'confirm',
  };

  if (hasMismatch) {
    const gapText = fmt(Math.abs(order.reconciliation.gap));
    confirmButton.confirm = {
      title: { type: 'plain_text', text: 'Price mismatch — confirm anyway?' },
      text: {
        type: 'mrkdwn',
        text: `Total is off by *${gapText}*${order.reconciliation.hypothesis ? ' — ' + order.reconciliation.hypothesis : ''}. Submit to Zupa anyway?`,
      },
      confirm: { type: 'plain_text', text: 'Yes, submit anyway' },
      deny: { type: 'plain_text', text: 'Cancel' },
    };
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Reject' },
        style: 'danger',
        action_id: 'reject_order',
        value: 'reject',
        confirm: {
          title: { type: 'plain_text', text: 'Reject this order?' },
          text: { type: 'mrkdwn', text: 'The order will be discarded and not pushed to Zupa.' },
          confirm: { type: 'plain_text', text: 'Yes, reject' },
          deny: { type: 'plain_text', text: 'Cancel' },
        },
      },
      confirmButton,
    ],
  });

  return blocks;
}

// ── Confirmed order receipt ───────────────────────────────────────────────────

function buildConfirmationBlocks(order, orderNumber, confirmedBy) {
  const blocks = [];

  // ── Header ────────────────────────────────────────────────────────────────
  const refPart  = order.clientReference ? `  ·  Ref: \`${order.clientReference}\`` : '';
  const numPart  = orderNumber ? `  ·  Zupa: \`${orderNumber}\`` : '';
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `✅  *ORDER CONFIRMED*${refPart}${numPart}\nConfirmed by <@${confirmedBy}>`,
    },
  });
  blocks.push({ type: 'divider' });

  // ── Customer ──────────────────────────────────────────────────────────────
  const customerParts = [
    order.customer?.name,
    order.customer?.instagram ? `@${order.customer.instagram.replace(/^@/, '')}` : null,
    order.customer?.phone,
  ].filter(Boolean);
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*CUSTOMER*\n${customerParts.join('  ·  ') || '—'}` },
  });

  if (order.recipient && (order.recipient.name || order.recipient.phone)) {
    const rParts = [order.recipient.name, order.recipient.phone].filter(Boolean);
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `📦  *Recipient:*  ${rParts.join('  ·  ')}` }],
    });
  }

  // ── Fulfillment ───────────────────────────────────────────────────────────
  const isPickup = order.fulfillment?.type === 'pickup';
  const fulfillmentText = isPickup
    ? `◉  *Pickup* — ${order.fulfillment?.branch || 'Lekki'}  _(₦0)_`
    : `🚚  *Delivery* — ${order.fulfillment?.zoneName || order.fulfillment?.address || '—'}${order.fulfillment?.branch ? '  (' + order.fulfillment.branch + ')' : ''}  —  ${fmt(order.fulfillment?.fee || 0)}`;
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: fulfillmentText },
  });

  if (order.scheduledDate) {
    const humanDate = new Date(order.scheduledDate + 'T12:00:00').toLocaleDateString('en-NG', {
      timeZone: 'Africa/Lagos', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `📅  *Delivery date:*  ${humanDate}` }],
    });
  }

  blocks.push({ type: 'divider' });

  // ── Items ─────────────────────────────────────────────────────────────────
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*ITEMS*' } });

  for (const item of (order.items || [])) {
    const unitNote = item.qty > 1 ? `  _(${fmt(item.unitPrice)} each)_` : '';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `×${item.qty}  *${item.productName}*  ·  _${item.sizeName}_  —  ${fmt(item.lineTotal)}${unitNote}`,
      },
    });
  }

  blocks.push({ type: 'divider' });

  // ── Totals ────────────────────────────────────────────────────────────────
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        `Items:  *${fmt(order.itemsSubtotal)}*`,
        `Delivery:  *${fmt(order.fulfillment?.fee || 0)}*`,
        `─────────────────`,
        `TOTAL:  *${fmt(order.orderTotal)}*`,
      ].join('\n'),
    },
  });

  if (order.notes && order.notes.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `📌  _${order.notes.join('  ·  ')}_` }],
    });
  }

  return blocks;
}

// ── Pre-parse duplicate warning ───────────────────────────────────────────────

function buildDuplicateWarningBlocks(duplicate) {
  const when = new Date(duplicate.confirmed_at).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' });
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `⚠️ *Duplicate order detected*\nThis exact message was already submitted as order \`${duplicate.order_number || '—'}\` for *${duplicate.customer_name || '—'}* on ${when}.\n\nWould you like to parse it anyway?`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Cancel' },
          action_id: 'cancel_parse',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Parse anyway' },
          style: 'danger',
          action_id: 'parse_anyway',
        },
      ],
    },
  ];
}

// ── Zone change modal ─────────────────────────────────────────────────────────

function buildZonePickerModal(currentAddress, privateMetadata) {
  const rideHailOptions = rideHailTiers.map(t => ({
    text: { type: 'plain_text', text: trunc(`${t.name} — ${fmt(t.price)}`, 75) },
    value: t.id,
  }));

  const pickupOptions = pickupRows.map(r => ({
    text: { type: 'plain_text', text: trunc(r.name, 75) },
    value: r.id,
  }));

  return {
    type: 'modal',
    callback_id: 'zone_picker_submit',
    private_metadata: privateMetadata,
    title: { type: 'plain_text', text: 'Change Zone' },
    submit: { type: 'plain_text', text: 'Apply' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'named_zone_select',
        label: { type: 'plain_text', text: 'Search delivery zone' },
        optional: true,
        element: {
          type: 'external_select',
          action_id: 'zone_search_select',
          placeholder: { type: 'plain_text', text: 'Type to search all cities… e.g. "Lekki", "VI", "Ikoyi"' },
          min_query_length: 0,
        },
      },
      { type: 'divider' },
      {
        type: 'input',
        block_id: 'ride_hail_select',
        label: { type: 'plain_text', text: 'Or select a ride-hail tier (Uber / Bolt)' },
        optional: true,
        element: {
          type: 'static_select',
          action_id: 'ride_hail_input',
          placeholder: { type: 'plain_text', text: 'Select tier…' },
          options: rideHailOptions,
        },
      },
      ...(pickupOptions.length > 0 ? [
        { type: 'divider' },
        {
          type: 'input',
          block_id: 'pickup_select',
          label: { type: 'plain_text', text: 'Or select a pickup location' },
          optional: true,
          element: {
            type: 'static_select',
            action_id: 'pickup_input',
            placeholder: { type: 'plain_text', text: 'Select pickup location…' },
            options: pickupOptions,
          },
        },
      ] : []),
    ],
  };
}

// ── Product search modal (searchable external_select) ─────────────────────────

function buildProductSearchModal(itemIndex, privateMetadata) {
  return {
    type: 'modal',
    callback_id: 'product_search_submit',
    private_metadata: JSON.stringify({ ...JSON.parse(privateMetadata || '{}'), itemIndex }),
    title: { type: 'plain_text', text: 'Search Products' },
    submit: { type: 'plain_text', text: 'Apply' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'product_select',
        label: { type: 'plain_text', text: 'Product & size' },
        element: {
          type: 'external_select',
          action_id: 'product_search_select',
          placeholder: { type: 'plain_text', text: 'Type to search… e.g. "za", "banana 6", "choc"' },
          min_query_length: 1,
        },
      },
    ],
  };
}

function buildDatePickerModal(privateMetadata, initialDate) {
  const dateElement = {
    type: 'datepicker',
    action_id: 'date_pick',
    placeholder: { type: 'plain_text', text: 'Select delivery date' },
  };
  if (initialDate) dateElement.initial_date = initialDate;

  return {
    type: 'modal',
    callback_id: 'date_picker_submit',
    private_metadata: privateMetadata,
    title: { type: 'plain_text', text: 'Set Delivery Date' },
    submit: { type: 'plain_text', text: 'Apply' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'delivery_date_block',
        label: { type: 'plain_text', text: 'Delivery date' },
        element: dateElement,
      },
    ],
  };
}

function buildModAddSearchModal(meta) {
  return {
    type: 'modal',
    callback_id: 'mod_add_search_modal',
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text', text: 'Search Products' },
    submit: { type: 'plain_text', text: 'Apply' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'product_select',
        label: { type: 'plain_text', text: 'Product & size' },
        element: {
          type: 'external_select',
          action_id: 'product_search_select',
          placeholder: { type: 'plain_text', text: 'Type to search… e.g. "za", "banana 6", "choc"' },
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
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `📝 *ORDER MODIFICATION*\nOrder \`${confirmedOrder.orderNumber || '—'}\`  ·  ${confirmedOrder.customer?.name || '—'}`,
    },
  });
  blocks.push({ type: 'divider' });

  // ── Customer update ───────────────────────────────────────────────────────
  if (mod.newName || mod.newPhone) {
    const lines = [];
    if (mod.newName)  lines.push(`  👤  Name: *${mod.newName}*`);
    if (mod.newPhone) lines.push(`  📱  Phone: *${mod.newPhone}*`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*CUSTOMER UPDATE:*\n${lines.join('\n')}` } });
  }

  // ── Recipient update ──────────────────────────────────────────────────────
  if (mod.newRecipient && (mod.newRecipient.name || mod.newRecipient.phone)) {
    const lines = [];
    if (mod.newRecipient.name)  lines.push(`  👤  Name: *${mod.newRecipient.name}*`);
    if (mod.newRecipient.phone) lines.push(`  📱  Phone: *${mod.newRecipient.phone}*`);
    const prev = confirmedOrder.recipient
      ? [confirmedOrder.recipient.name, confirmedOrder.recipient.phone].filter(Boolean).join('  ·  ')
      : 'none';
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*RECIPIENT UPDATE* _(was: ${prev})_\n${lines.join('\n')}` } });
  }

  // ── Resolved add items — show match prominently + Search all button ───────
  for (let i = 0; i < mod.addItems.length; i++) {
    const item = mod.addItems[i];
    const candidates = item.candidates || [];
    if (candidates.length > 1) {
      const options = candidates.map(c => ({
        text: { type: 'plain_text', text: trunc(`${c.productName} · ${c.sizeName} — ${fmt(c.price)}`, 75) },
        value: c.sizeId,
      }));
      const initial_option = options.find(o => o.value === item.sizeId) || options[0];
      blocks.push({
        type: 'section',
        block_id: `mod_add_pick_${i}`,
        text: { type: 'mrkdwn', text: `➕  *Add ×${item.qty}:*  *${item.productName} · ${item.sizeName}* — ${fmt(item.lineTotal)}\n_${candidates.length} matches — tap to change:_` },
        accessory: {
          type: 'static_select',
          action_id: 'mod_add_pick',
          initial_option,
          options,
        },
      });
    } else {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `➕  *Add ×${item.qty}:*  *${item.productName} · ${item.sizeName}* — ${fmt(item.lineTotal)}` } });
    }
    blocks.push({
      type: 'actions',
      block_id: `mod_add_btn_${i}`,
      elements: [{ type: 'button', text: { type: 'plain_text', text: '🔍 Search all products' }, action_id: 'mod_add_search_btn', value: String(i) }],
    });
  }

  // ── Unresolved additions — inline search + Search all button ─────────────
  for (let i = 0; i < mod.unresolvedAdditions.length; i++) {
    const ua = mod.unresolvedAdditions[i];
    blocks.push({
      type: 'section',
      block_id: `mod_add_search_${i}`,
      text: { type: 'mrkdwn', text: `⚠️  *"${trunc(ua.raw, 60)}"* — not found, search to add:` },
      accessory: {
        type: 'external_select',
        action_id: 'mod_add_search',
        placeholder: { type: 'plain_text', text: 'Search products…' },
        min_query_length: 0,
      },
    });
    blocks.push({
      type: 'actions',
      block_id: `mod_add_ubtn_${i}`,
      elements: [{ type: 'button', text: { type: 'plain_text', text: '🔍 Search all products' }, action_id: 'mod_add_search_btn', value: `u_${i}` }],
    });
  }

  // ── Remove items — show match prominently + all-order-items dropdown ──────
  const allOrderOptions = (confirmedOrder.items || []).map(oi => ({
    text: { type: 'plain_text', text: trunc(`${oi.productName} · ${oi.sizeName} ×${oi.qty} — ${fmt(oi.unitPrice)}`, 75) },
    value: oi.sizeId,
  }));

  for (let i = 0; i < mod.removeItems.length; i++) {
    const item = mod.removeItems[i];
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `➖  *Remove:*  *${item.productName} · ${item.sizeName}*  ×${item.qty}` } });
    if (allOrderOptions.length > 0) {
      const initial_option = allOrderOptions.find(o => o.value === item.sizeId) || allOrderOptions[0];
      blocks.push({
        type: 'section',
        block_id: `mod_remove_pick_${i}`,
        text: { type: 'mrkdwn', text: `_Select which order item to remove:_` },
        accessory: {
          type: 'static_select',
          action_id: 'mod_remove_pick',
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
        type: 'section',
        block_id: `mod_remove_unresolved_${j}`,
        text: { type: 'mrkdwn', text: `⚠️  *"${trunc(ur.raw, 40)}"* — not found in order. Select item to remove:` },
        accessory: {
          type: 'static_select',
          action_id: 'mod_remove_unresolved_pick',
          placeholder: { type: 'plain_text', text: 'Select item to remove…' },
          options: allOrderOptions,
        },
      });
    } else {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `⚠️  *"${trunc(ur.raw, 40)}"* — not in this order` } });
    }
  }

  // ── Scheduled date change ─────────────────────────────────────────────────
  if (mod.newScheduledDate) {
    const humanDate = new Date(mod.newScheduledDate + 'T12:00:00').toLocaleDateString('en-NG', {
      timeZone: 'Africa/Lagos', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    const prev = confirmedOrder.scheduledDate
      ? new Date(confirmedOrder.scheduledDate + 'T12:00:00').toLocaleDateString('en-NG', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', year: 'numeric' })
      : 'same day';
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `📅  *DELIVERY DATE*  _(was: ${prev})_\n  →  *${humanDate}*` },
    });
  }

  // ── Zone change — always show picker when an address was detected ─────────
  if (mod.newAddress) {
    const prev = confirmedOrder.fulfillment?.zoneName || confirmedOrder.fulfillment?.address || '?';
    const matchText = mod.newZoneId
      ? `✅  Matched: *${mod.newZoneName}*  ${fmt(mod.newFee)}  (${mod.newBranch || ''})`
      : `⚠️  No zone matched for _"${mod.newAddress}"_ — search below`;
    blocks.push({
      type: 'section',
      block_id: 'mod_zone_search',
      text: { type: 'mrkdwn', text: `*ADDRESS CHANGE* _(was: ${prev})_\n${matchText}` },
      accessory: {
        type: 'external_select',
        action_id: 'mod_zone_select',
        placeholder: { type: 'plain_text', text: 'Confirm or change zone…' },
        min_query_length: 0,
      },
    });
  }

  blocks.push({ type: 'divider' });

  const canApply = mod.addItems.length > 0 || mod.removeItems.length > 0 || mod.newZoneId || mod.newName || mod.newPhone || mod.newScheduledDate || (mod.newRecipient && (mod.newRecipient.name || mod.newRecipient.phone));
  const hasAnyChange = canApply || mod.unresolvedAdditions.length > 0 || (mod.newAddress && !mod.newZoneId);

  if (hasAnyChange) {
    const elements = [{ type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: 'mod_reject' }];
    if (canApply) {
      elements.push({ type: 'button', text: { type: 'plain_text', text: 'Apply Modification' }, style: 'primary', action_id: 'mod_confirm' });
    }
    blocks.push({ type: 'actions', block_id: 'mod_actions', elements });
  } else {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: "_No actionable changes found. Reply again with what you'd like to add, remove, or change._" },
    });
  }

  return blocks;
}

// ── /menu modal ───────────────────────────────────────────────────────────────

function buildMenuContent(query) {
  const products = store.getProducts();
  const q = (query || '').toLowerCase().trim();

  const filtered = q
    ? products.filter(p => (p.name || '').toLowerCase().includes(q))
    : products;

  if (filtered.length === 0) {
    return [{
      type: 'section',
      text: { type: 'mrkdwn', text: `_No products found for "${trunc(query, 40)}"_` },
    }];
  }

  // Group by category, preserving insertion order
  const byCategory = new Map();
  for (const p of filtered) {
    const cat = (p.category || 'Products');
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(p);
  }

  const blocks = [];

  for (const [category, prods] of byCategory) {
    if (blocks.length >= 93) break; // stay under 100-block modal limit

    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: trunc(category, 150) },
    });

    // Pack up to 10 products per section (renders as 5-row × 2-col grid in Slack)
    const CHUNK = 10;
    for (let i = 0; i < prods.length; i += CHUNK) {
      if (blocks.length >= 93) break;
      const fields = prods.slice(i, i + CHUNK).map(p => {
        const validSizes = (p.sizes || []).filter(Boolean);
        const sizeText = validSizes.length > 0
          ? validSizes.map(s => `${s.name}: *${fmt(s.price)}*`).join('  ·  ')
          : '—';
        return { type: 'mrkdwn', text: `*${trunc(p.name, 50)}*\n${sizeText}` };
      });
      blocks.push({ type: 'section', fields });
    }

    blocks.push({ type: 'divider' });
  }

  return blocks;
}

function buildMenuModal(query) {
  const q = query || '';
  return {
    type: 'modal',
    callback_id: 'menu_modal',
    title: { type: 'plain_text', text: 'Gourmet Twist Menu' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      {
        type: 'input',
        block_id: 'menu_search_block',
        dispatch_action: true,
        optional: true,
        label: { type: 'plain_text', text: 'Search' },
        element: {
          type: 'plain_text_input',
          action_id: 'menu_search_input',
          placeholder: { type: 'plain_text', text: 'Filter products… e.g. "banana", "cake", "choc"' },
          initial_value: q,
          dispatch_action_config: {
            trigger_actions_on: ['on_character_entered'],
          },
        },
      },
      { type: 'divider' },
      ...buildMenuContent(q),
    ],
  };
}

// ── /cities modal ─────────────────────────────────────────────────────────────

function buildCitiesModal() {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'Delivery Zones' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'Search all delivery zones and fees.' },
      },
      {
        type: 'actions',
        block_id: 'cities_search',
        elements: [
          {
            type: 'external_select',
            action_id: 'cities_search_select',
            placeholder: { type: 'plain_text', text: 'Type to search… e.g. "Lekki", "VI", "Chevron"' },
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
    grandTotal:    orders.reduce((s, o) => s + (o.orderTotal     || 0), 0),
    itemsTotal:    orders.reduce((s, o) => s + (o.itemsSubtotal  || 0), 0),
    deliveryTotal: orders.reduce((s, o) => s + (o.fulfillment?.fee || 0), 0),
  };
}

// Shared per-order section blocks used by both the modal and the channel post.
function buildOrderSections(orders, cap) {
  const blocks = [];
  const shown  = orders.slice(0, cap);

  if (orders.length > cap) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_Showing most recent ${cap} of ${orders.length} orders._` }],
    });
  }

  for (const order of shown) {
    const time = new Date(order._confirmedAt).toLocaleString('en-NG', {
      timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hour12: true,
    });

    const customerParts = [
      order.customer?.name,
      order.customer?.phone,
      order.customer?.instagram ? `@${order.customer.instagram.replace(/^@/, '')}` : null,
    ].filter(Boolean);

    const recipientLine = (order.recipient?.name || order.recipient?.phone)
      ? `📦 Recipient: ${[order.recipient.name, order.recipient.phone].filter(Boolean).join('  ·  ')}`
      : null;

    const isPickup = order.fulfillment?.type === 'pickup';
    const fulfillmentLine = isPickup
      ? `📦 Pickup — ${order.fulfillment?.branch || 'Lekki'}  _(₦0)_`
      : `🚚 ${order.fulfillment?.zoneName || order.fulfillment?.address || '—'}${order.fulfillment?.branch ? '  (' + order.fulfillment.branch + ')' : ''}  —  ${fmt(order.fulfillment?.fee)}`;

    const itemLines  = (order.items || []).map(i => `  ×${i.qty}  ${i.productName}  ·  _${i.sizeName}_  —  ${fmt(i.lineTotal)}`);
    const notesLine  = order.notes?.length > 0 ? `📌 _${order.notes.join(' · ')}_` : null;
    const orderNum   = order.orderNumber ? `\`${order.orderNumber}\`` : '_no order #_';
    const totalLine  = `Subtotal: *${fmt(order.itemsSubtotal)}*   Delivery: *${fmt(order.fulfillment?.fee || 0)}*   *Total: ${fmt(order.orderTotal)}*`;

    const scheduledLine = order.scheduledDate
      ? `📅 Scheduled: ${new Date(order.scheduledDate + 'T12:00:00').toLocaleDateString('en-NG', { timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short' })}`
      : null;

    const text = [
      `*${orderNum}*  ·  ${time}`,
      `👤 ${customerParts.join('  ·  ') || '—'}`,
      recipientLine,
      fulfillmentLine,
      scheduledLine,
      ...itemLines,
      notesLine,
      totalLine,
    ].filter(Boolean).join('\n');

    blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
    blocks.push({ type: 'divider' });
  }

  return blocks;
}

// ── /summary modal ────────────────────────────────────────────────────────────

function buildSummaryModal(orders, dateLabel, channelId, userId, offsetDays) {
  const meta = JSON.stringify({ channelId, userId, offsetDays: offsetDays || 0, dateLabel });

  if (orders.length === 0) {
    return {
      type: 'modal',
      callback_id: 'summary_modal',
      private_metadata: meta,
      title: { type: 'plain_text', text: 'Daily Summary' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*No orders confirmed by you on ${dateLabel}.*\n_Confirm an order via /parse-order or by mentioning the bot._` },
      }],
    };
  }

  const { grandTotal, itemsTotal, deliveryTotal } = summaryTotals(orders);

  return {
    type: 'modal',
    callback_id: 'summary_modal',
    private_metadata: meta,
    title: { type: 'plain_text', text: 'Daily Summary' },
    submit: { type: 'plain_text', text: 'Paste to channel' },
    close:  { type: 'plain_text', text: 'Close' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `📊 *${orders.length} order${orders.length !== 1 ? 's' : ''} confirmed — ${dateLabel}*`,
            `Items: *${fmt(itemsTotal)}*   Delivery: *${fmt(deliveryTotal)}*   Grand total: *${fmt(grandTotal)}*`,
          ].join('\n'),
        },
      },
      { type: 'divider' },
      ...buildOrderSections(orders, 45),
    ],
  };
}

// ── Channel summary post ──────────────────────────────────────────────────────

function buildSummaryChannelBlocks(orders, dateLabel, userId) {
  const { grandTotal, itemsTotal, deliveryTotal } = summaryTotals(orders);

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `📊 *Daily Summary — <@${userId}>*`,
          `_${dateLabel}_`,
          `${orders.length} order${orders.length !== 1 ? 's' : ''}   Items: *${fmt(itemsTotal)}*   Delivery: *${fmt(deliveryTotal)}*   Grand total: *${fmt(grandTotal)}*`,
        ].join('\n'),
      },
    },
    { type: 'divider' },
    ...buildOrderSections(orders, 20), // messages cap at 50 blocks; 2 + 2×20 = 42
  ];
}

// ── End-of-day channel summary ────────────────────────────────────────────────

// ── Daily operations report ───────────────────────────────────────────────────
// kitchenData  : response from GET /kitchen-api/daily-summary (today)
// yesterdayData: same endpoint for yesterday, or null if unavailable
// csrOrders    : array from getAllOrdersToday() filtered to this channel

const DEPT_DISPLAY = {
  KITCHEN:      'Kitchen',
  BAKERY:       'Bakery',
  PACKINGBAKERY:'Packing',
  BREAKFAST:    'Breakfast',
};

function buildDailyReportBlocks(kitchenData, yesterdayData, csrOrders, dateLabel) {
  const k      = kitchenData || {};
  const orders = k.orders || {};
  const blocks = [];

  // ── Header ────────────────────────────────────────────────────────────────
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: '📊  Daily Operations Report' },
  });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `_${dateLabel}_` }],
  });
  blocks.push({ type: 'divider' });

  // ── Order Summary ─────────────────────────────────────────────────────────
  const total    = orders.processed ?? 0;
  const onTime   = orders.onTime    ?? 0;
  const delayed  = orders.delayed   ?? 0;
  const csrCount = csrOrders.length;
  const pct      = total > 0 ? ((onTime / total) * 100).toFixed(1) : '—';
  const avgMins  = k.avgProcessingTimeMinutes != null
    ? `${Math.round(k.avgProcessingTimeMinutes)} mins` : '—';

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        '*📦  Order Summary*',
        `• Total Orders: *${total}*`,
        `• Total Orders by CSRs: *${csrCount}*`,
        `• Orders Completed On Time: *${onTime}*  (${pct}%)`,
        `• Delayed Orders: *${delayed}*`,
        `• Avg Processing Time: *${avgMins}*`,
      ].join('\n'),
    },
  });
  blocks.push({ type: 'divider' });

  // ── Department Performance ─────────────────────────────────────────────────
  const depts = Object.entries(k.departments || {})
    .filter(([, d]) => (d.totalScanned || 0) > 0);

  if (depts.length > 0) {
    const deptLines = depts.map(([key, d]) => {
      const name = DEPT_DISPLAY[key] || key;
      return [
        `*${name}*`,
        `• Avg Time: *${Math.round(d.avgTimeMinutes)} mins*  (SLA: ${d.slaMinutes} mins)`,
        `• SLA Compliance: *${d.complianceRate}%*  (${d.onTime} on time, ${d.delayed} delayed)`,
      ].join('\n');
    });

    // Fastest = lowest avg time; Slowest = highest avg time
    const sorted  = [...depts].sort((a, b) => a[1].avgTimeMinutes - b[1].avgTimeMinutes);
    const fastest = DEPT_DISPLAY[sorted[0][0]] || sorted[0][0];
    const slowest = DEPT_DISPLAY[sorted[sorted.length - 1][0]] || sorted[sorted.length - 1][0];

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '*🏭  Department Performance*',
          '',
          deptLines.join('\n\n'),
          '',
          `🏆 *Fastest:* ${fastest}   🐢 *Slowest:* ${slowest}`,
        ].join('\n'),
      },
    });
    blocks.push({ type: 'divider' });
  }

  // ── CSR Performance ────────────────────────────────────────────────────────
  const byUser = {};
  for (const o of csrOrders) {
    const u = o._confirmedBy || 'unknown';
    byUser[u] = (byUser[u] || 0) + 1;
  }
  const csrSorted = Object.entries(byUser).sort((a, b) => b[1] - a[1]);

  if (csrSorted.length > 0) {
    const csrLines = csrSorted.map(([uid, cnt]) =>
      uid === 'unknown' ? `Unknown — *${cnt}* orders` : `<@${uid}> — *${cnt}* orders`
    );
    const top    = csrSorted[0];
    const bottom = csrSorted[csrSorted.length - 1];
    const footer = [
      top    ? `🏆 *Top Performer:* <@${top[0]}> (${top[1]})` : null,
      bottom && bottom[0] !== top[0]
        ? `📉 *Lowest Performer:* <@${bottom[0]}> (${bottom[1]})` : null,
    ].filter(Boolean);

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ['*👥  CSR Performance*', ...csrLines, '', ...footer].filter(s => s !== '').join('\n'),
      },
    });
    blocks.push({ type: 'divider' });
  }

  // ── Operational Alerts ────────────────────────────────────────────────────
  const alerts  = k.alerts || {};
  const longest = alerts.longestDelayedOrder;
  const alertLines = [];

  if (alerts.primaryDelayOrigin && delayed > 0) {
    const origin = DEPT_DISPLAY[alerts.primaryDelayOrigin] || alerts.primaryDelayOrigin;
    alertLines.push(`• *${delayed}* delayed order${delayed !== 1 ? 's' : ''} — primary origin: *${origin}*`);
  }
  if (longest) {
    const dept = DEPT_DISPLAY[longest.delayOriginDept] || longest.delayOriginDept || '—';
    alertLines.push(
      `• Longest delay: *${longest.totalMinutes} mins*  (Order \`${longest.orderNumber}\`, origin: ${dept}, excess: ${longest.excessMinutes} mins)`
    );
  }

  if (alertLines.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: ['*⚠️  Operational Alerts*', ...alertLines].join('\n') },
    });
    blocks.push({ type: 'divider' });
  }

  // ── Comparison to Yesterday ────────────────────────────────────────────────
  if (yesterdayData) {
    const y      = yesterdayData.orders || {};
    const yAvg   = yesterdayData.avgProcessingTimeMinutes ?? 0;
    const yTotal = y.processed ?? 0;
    const ySLA   = yTotal > 0 ? (y.onTime ?? 0) / yTotal * 100 : 0;
    const todaySLA = total > 0 ? onTime / total * 100 : 0;

    function diffLine(label, todayVal, yVal, unit = '', lowerIsBetter = false) {
      const diff = todayVal - yVal;
      if (diff === 0) return `→ *${label}:* No change`;
      const better  = lowerIsBetter ? diff < 0 : diff > 0;
      const arrow   = better ? '↑' : '↓';
      const sign    = diff > 0 ? '+' : '';
      const display = Number.isInteger(diff) ? diff : parseFloat(diff.toFixed(1));
      return `${arrow} *${label}:* ${sign}${display}${unit ? ' ' + unit : ''}`;
    }

    const orderDiff  = total - yTotal;
    const orderPct   = yTotal > 0 ? ((orderDiff / yTotal) * 100).toFixed(1) : null;
    const orderArrow = orderDiff === 0 ? '→' : orderDiff > 0 ? '↑' : '↓';
    const orderLine  = orderDiff === 0
      ? `→ *Orders:* No change`
      : `${orderArrow} *Orders:* ${orderDiff > 0 ? '+' : ''}${orderDiff}${orderPct ? ` (${orderDiff > 0 ? '+' : ''}${orderPct}%)` : ''}`;

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '*📈  Comparison to Yesterday*',
          orderLine,
          diffLine('Avg Processing Time', Math.round(k.avgProcessingTimeMinutes ?? 0), Math.round(yAvg), 'mins', true),
          diffLine('SLA Compliance', parseFloat(todaySLA.toFixed(1)), parseFloat(ySLA.toFixed(1)), '%'),
          diffLine('Delayed Orders', delayed, y.delayed ?? 0, '', true),
        ].join('\n'),
      },
    });
  }

  return blocks;
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
  buildModReviewBlocks,
  buildMenuModal,
  buildCitiesModal,
  buildSummaryModal,
  buildSummaryChannelBlocks,
  buildDailyReportBlocks,
};
