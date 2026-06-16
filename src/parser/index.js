'use strict';

const { segment } = require('./ai-segmenter');
const { matchProduct, matchPickup, matchZone, getSurgeTwins, canonicalSize } = require('./matcher');
const { reconcile } = require('./reconciler');

// Confidence thresholds
const HIGH_CONFIDENCE_SCORE = 0.7;

function resolveItem(itemLine) {
  const { raw, productPhrase, sizeToken, qty, statedPrice } = itemLine;

  if (!productPhrase) {
    return {
      raw, productPhrase: '', sizeToken, qty, statedPrice,
      productName: null, sizeName: null, sizeId: null,
      unitPrice: null, lineTotal: null,
      confidence: 'unmatched', match: 'unresolved',
      candidates: [], issue: 'unmatched',
    };
  }

  const candidates = matchProduct(productPhrase, sizeToken, statedPrice);

  if (candidates.length === 0) {
    return {
      raw, productPhrase, sizeToken, qty, statedPrice,
      productName: null, sizeName: null, sizeId: null,
      unitPrice: null, lineTotal: null,
      confidence: 'unmatched', match: 'unresolved',
      candidates: [], issue: 'unmatched',
    };
  }

  const best = candidates[0];

  // Check if the best match is unambiguous:
  // - score high enough
  // - if sizeToken given: only one candidate has that size
  // - if statedPrice given: best has priceMatch
  const isHighConfidence =
    best.score >= HIGH_CONFIDENCE_SCORE &&
    (!statedPrice || best.priceMatch || candidates.filter(c => c.priceMatch).length === 0);

  // Ambiguous only if runner-up is very close AND the top score isn't near-perfect
  const hasAmbiguity =
    candidates.length > 1 &&
    best.score < 0.95 &&
    candidates[1].score >= best.score * 0.85 &&
    !best.priceMatch;

  let issue = null;
  let confidence = 'high';
  let match = 'auto';

  if (!isHighConfidence || hasAmbiguity) {
    confidence = 'low';
    match = 'unresolved';
    issue = 'ambiguous_product';
  }

  // Price mismatch check (only when we have a stated price and high confidence)
  if (statedPrice && best.price !== statedPrice && confidence === 'high') {
    confidence = 'low';
    match = 'unresolved';
    issue = 'price_mismatch';
  }

  const unitPrice = best.price;
  const lineTotal = unitPrice * qty;

  return {
    raw, productPhrase, sizeToken, qty, statedPrice,
    productName: best.productName,
    sizeName: best.sizeName,
    sizeId: best.sizeId,
    unitPrice,
    lineTotal,
    confidence,
    match,
    candidates,
    issue,
  };
}

async function parse(rawMessage) {
  const seg = await segment(rawMessage);

  // Resolve fulfillment
  let fulfillment = {
    type: seg.fulfillment.type || 'unknown',
    address: seg.fulfillment.address,
    branch: seg.fulfillment.branch,
    zoneId: null,
    zoneName: null,
    fee: seg.fulfillment.statedFee || 0,
    resolved: false,
  };

  if (fulfillment.type === 'pickup') {
    const pickupRow = matchPickup(fulfillment.address, fulfillment.branch);
    if (pickupRow) {
      fulfillment.zoneId = pickupRow.id;
      fulfillment.zoneName = pickupRow.name;
      fulfillment.fee = 0;
      fulfillment.branch = fulfillment.branch || 'Lekki';
      fulfillment.resolved = true;
    }
  } else if (fulfillment.type === 'delivery' || fulfillment.address) {
    fulfillment.type = 'delivery';
    const zone = matchZone(fulfillment.address);
    if (zone) {
      fulfillment.zoneId = zone.id;
      fulfillment.zoneName = zone.name;
      fulfillment.branch = zone.branch;
      fulfillment.surgeTwins = getSurgeTwins(zone);
      if (seg.fulfillment.statedFee) {
        // Explicit delivery fee stated — accept it as resolved
        fulfillment.fee = seg.fulfillment.statedFee;
        fulfillment.resolved = true;
      } else {
        // Zone known from address but fee unconfirmed — reconciler will verify from total gap
        fulfillment.fee = 0;
        fulfillment.resolved = false;
      }
    }
  }

  // Resolve items
  const items = seg.itemLines.map((line, index) => ({
    index,
    ...resolveItem(line),
  }));

  // Reconcile totals
  const { reconciliation, fulfillment: updatedFulfillment, itemsSubtotal, orderTotal } = reconcile(
    items,
    fulfillment,
    seg.statedTotal
  );

  // Overall order status
  const hasUnresolved = items.some(item => item.match === 'unresolved') ||
    !updatedFulfillment.resolved ||
    reconciliation.status === 'mismatch';

  const status = hasUnresolved ? 'needs_confirmation' : 'auto_accepted';

  return {
    rawMessage,
    customer: seg.customer,
    fulfillment: updatedFulfillment,
    items,
    statedTotal: seg.statedTotal,
    itemsSubtotal,
    orderTotal,
    reconciliation,
    notes: seg.notes,
    status,
  };
}

module.exports = { parse };
