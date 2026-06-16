'use strict';

const { rideHailTiers } = require('../parser/matcher');

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
  const statusText = needsReviewCount === 0
    ? (order.status === 'auto_accepted' ? '✅  *Auto-accepted* — verify and confirm' : '✅  *All items resolved* — ready to confirm')
    : `⚠️  *Needs review* — ${needsReviewCount} unresolved`;

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
  const canConfirm = unresolvedItems.length === 0 &&
    !zoneUnresolved &&
    order.reconciliation.status !== 'mismatch';

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
      {
        type: 'button',
        text: { type: 'plain_text', text: canConfirm ? 'Confirm & Push to Zupa' : '🔒 Resolve issues first' },
        style: canConfirm ? 'primary' : undefined,
        action_id: 'confirm_order',
        value: 'confirm',
      },
    ],
  });

  return blocks;
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
        block_id: 'zone_search',
        label: { type: 'plain_text', text: 'Enter delivery area / zone name' },
        element: {
          type: 'plain_text_input',
          action_id: 'zone_input',
          initial_value: currentAddress || '',
          placeholder: { type: 'plain_text', text: 'e.g. Ikoyi, Lekki Phase 1, Alapere…' },
        },
        hint: { type: 'plain_text', text: 'The bot will match this to the nearest zone. Saved matches update the alias map.' },
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

// ── Product search modal ──────────────────────────────────────────────────────

function buildProductSearchModal(itemIndex, currentPhrase, privateMetadata) {
  return {
    type: 'modal',
    callback_id: 'product_search_submit',
    private_metadata: JSON.stringify({ ...JSON.parse(privateMetadata || '{}'), itemIndex }),
    title: { type: 'plain_text', text: 'Search Products' },
    submit: { type: 'plain_text', text: 'Find' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'search_query',
        label: { type: 'plain_text', text: 'Product name' },
        element: {
          type: 'plain_text_input',
          action_id: 'query_input',
          initial_value: currentPhrase || '',
          placeholder: { type: 'plain_text', text: 'e.g. Banana bread, Chicken Pie, Nutella…' },
        },
      },
      {
        type: 'input',
        block_id: 'size_input',
        label: { type: 'plain_text', text: 'Size (optional)' },
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: 'size_value',
          placeholder: { type: 'plain_text', text: 'e.g. Mini, Regular, 8"…' },
        },
      },
    ],
  };
}

// ── Search results modal (after search submitted) ─────────────────────────────

function buildSearchResultsModal(results, itemIndex, privateMetadata) {
  if (results.length === 0) {
    return {
      type: 'modal',
      callback_id: 'search_result_noop',
      title: { type: 'plain_text', text: 'No Results' },
      close: { type: 'plain_text', text: 'Back' },
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: 'No products matched your search. Try a different name.' } },
      ],
    };
  }

  const options = results.slice(0, 25).map(c => ({
    text: { type: 'plain_text', text: trunc(`${c.productName} · ${c.sizeName} — ${fmt(c.price)}`, 75) },
    value: c.sizeId,
  }));

  return {
    type: 'modal',
    callback_id: 'search_result_submit',
    private_metadata: JSON.stringify({ ...JSON.parse(privateMetadata || '{}'), itemIndex }),
    title: { type: 'plain_text', text: 'Select Product' },
    submit: { type: 'plain_text', text: 'Apply' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'result_select',
        label: { type: 'plain_text', text: `${results.length > 25 ? 'Top 25 of ' + results.length : results.length} results — select the correct one:` },
        element: {
          type: 'static_select',
          action_id: 'result_choice',
          placeholder: { type: 'plain_text', text: 'Choose…' },
          options,
        },
      },
    ],
  };
}

module.exports = {
  buildReviewOrderBlocks,
  buildZonePickerModal,
  buildProductSearchModal,
  buildSearchResultsModal,
};
