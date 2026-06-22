'use strict';

const { rideHailTiers, namedZones } = require('../parser/matcher');
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

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*REVIEW ORDER*\n${statusText}` },
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

  if (order.scheduledDate) {
    const humanDate = new Date(order.scheduledDate + 'T12:00:00').toLocaleDateString('en-NG', {
      timeZone: 'Africa/Lagos', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `📅  *Scheduled delivery:*  ${humanDate}` }],
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

  // ── Resolved add items — static_select when candidates > 1 ───────────────
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
        text: { type: 'mrkdwn', text: `➕  *Add ×${item.qty}* — confirm product:` },
        accessory: {
          type: 'static_select',
          action_id: 'mod_add_pick',
          initial_option,
          options,
        },
      });
    } else {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `  ➕  *${item.productName} · ${item.sizeName}*  ×${item.qty}  —  ${fmt(item.lineTotal)}` } });
    }
  }

  // ── Unresolved additions — external_select to search & pick ──────────────
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
  }

  // ── Resolved remove items — static_select when multiple order items match ─
  for (let i = 0; i < mod.removeItems.length; i++) {
    const item = mod.removeItems[i];
    const candidates = item.candidates || [];
    if (candidates.length > 1) {
      const options = candidates.map(c => ({
        text: { type: 'plain_text', text: trunc(`${c.productName} · ${c.sizeName} ×${c.qty} — ${fmt(c.unitPrice)}`, 75) },
        value: c.sizeId,
      }));
      const initial_option = options.find(o => o.value === item.sizeId) || options[0];
      blocks.push({
        type: 'section',
        block_id: `mod_remove_pick_${i}`,
        text: { type: 'mrkdwn', text: `➖  *Remove* — confirm which item:` },
        accessory: {
          type: 'static_select',
          action_id: 'mod_remove_pick',
          initial_option,
          options,
        },
      });
    } else {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `  ➖  *${item.productName} · ${item.sizeName}*  ×${item.qty}  —  ${fmt(item.lineTotal || item.unitPrice * item.qty)}` } });
    }
  }

  // ── Unresolved removals (text only — nothing to pick from) ────────────────
  if (mod.unresolvedRemovals.length > 0) {
    const lines = mod.unresolvedRemovals.map(r => `  ⚠️  "${r.raw}" — not in this order`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*UNRESOLVED REMOVALS:*\n${lines.join('\n')}` } });
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

  const canApply = mod.addItems.length > 0 || mod.removeItems.length > 0 || mod.newZoneId || mod.newName || mod.newPhone || mod.newScheduledDate;
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

module.exports = {
  fmt,
  trunc,
  buildReviewOrderBlocks,
  buildDuplicateWarningBlocks,
  buildZonePickerModal,
  buildProductSearchModal,
  buildModReviewBlocks,
  buildMenuModal,
  buildCitiesModal,
  buildSummaryModal,
  buildSummaryChannelBlocks,
};
