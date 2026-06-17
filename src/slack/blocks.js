'use strict';

const { rideHailTiers, namedZones } = require('../parser/matcher');

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
          placeholder: { type: 'plain_text', text: 'Type to search… e.g. "ha ca coc", "banana 6"' },
          min_query_length: 0,
        },
      },
    ],
  };
}

// ── Modification review blocks ────────────────────────────────────────────────

function buildModReviewBlocks(mod, confirmedOrder) {
  const blocks = [];
  const hasResolved = mod.addItems.length > 0 || mod.removeItems.length > 0 || mod.newZoneId;

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `📝 *ORDER MODIFICATION*\nOrder \`${confirmedOrder.orderNumber || '—'}\`  ·  ${confirmedOrder.customer?.name || '—'}`,
    },
  });
  blocks.push({ type: 'divider' });

  if (mod.addItems.length > 0) {
    const lines = mod.addItems.map(i => `  ➕  *${i.productName} · ${i.sizeName}*  ×${i.qty}  —  ${fmt(i.lineTotal)}`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*ADD:*\n${lines.join('\n')}` } });
  }

  if (mod.removeItems.length > 0) {
    const lines = mod.removeItems.map(i => `  ➖  *${i.productName} · ${i.sizeName}*  ×${i.qty}  —  ${fmt(i.lineTotal)}`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*REMOVE:*\n${lines.join('\n')}` } });
  }

  if (mod.newZoneId) {
    const prev = confirmedOrder.fulfillment?.zoneName || confirmedOrder.fulfillment?.address || '?';
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*ADDRESS CHANGE:*\n  ${prev}  →  ${mod.newZoneName}  ${fmt(mod.newFee)}` },
    });
  } else if (mod.newAddress && !mod.newZoneId) {
    const prev = confirmedOrder.fulfillment?.zoneName || confirmedOrder.fulfillment?.address || '?';
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `⚠️ *Address not matched:*  "${mod.newAddress}"\n_(${prev} unchanged)_` },
    });
  }

  if (mod.unresolvedAdditions.length > 0) {
    const lines = mod.unresolvedAdditions.map(i => `  ⚠️  "${i.raw}" — not found in catalogue`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*UNRESOLVED ADDITIONS:*\n${lines.join('\n')}` } });
  }

  if (mod.unresolvedRemovals.length > 0) {
    const lines = mod.unresolvedRemovals.map(i => `  ⚠️  "${i.raw}" — not in this order`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*UNRESOLVED REMOVALS:*\n${lines.join('\n')}` } });
  }

  blocks.push({ type: 'divider' });

  if (hasResolved) {
    blocks.push({
      type: 'actions',
      block_id: 'mod_actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Cancel' },
          action_id: 'mod_reject',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Apply Modification' },
          style: 'primary',
          action_id: 'mod_confirm',
        },
      ],
    });
  } else {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: "_No actionable changes found. Reply again with what you'd like to add, remove, or change._" },
    });
  }

  return blocks;
}

module.exports = {
  fmt,
  trunc,
  buildReviewOrderBlocks,
  buildDuplicateWarningBlocks,
  buildZonePickerModal,
  buildProductSearchModal,
  buildModReviewBlocks,
};
