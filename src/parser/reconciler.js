'use strict';

const store = require('../data/store');

function namedZones() { return store.getCities().namedZones; }

// One-off flash delivery discount: matches the window/threshold/amount
// zupa-api applies server-side (customer_order.js, order.js). A CSR-entered
// statedTotal for a qualifying order already has this baked in, so a gap
// against a zone's raw price alone would wrongly read as a mismatch — this
// lets gap-matching recognize the discounted price too. Remove once the
// campaign ends.
const FLASH_DELIVERY_DISCOUNT_THRESHOLD = 10000;
const FLASH_DELIVERY_DISCOUNT_AMOUNT = 6000;
const FLASH_DELIVERY_DISCOUNT_END = new Date('2026-11-27T12:00:00+01:00'); // Africa/Lagos (WAT)

function zonePriceMatchesGap(zonePrice, gap, itemsSubtotal) {
  if (zonePrice === gap) return true;
  const flashEligible =
    Date.now() < FLASH_DELIVERY_DISCOUNT_END.getTime() &&
    itemsSubtotal >= FLASH_DELIVERY_DISCOUNT_THRESHOLD;
  return flashEligible && Math.max(0, zonePrice - FLASH_DELIVERY_DISCOUNT_AMOUNT) === gap;
}

// Match a monetary gap to a known named zone fee (base zones only)
function gapMatchesZone(gap, itemsSubtotal) {
  if (!gap || gap <= 0) return null;
  return namedZones().find(z => !z.isSurge && zonePriceMatchesGap(z.price, gap, itemsSubtotal)) || null;
}

// Match a monetary gap to a surge zone fee
function gapMatchesSurge(gap, baseZone, itemsSubtotal) {
  if (!gap || gap <= 0 || !baseZone) return null;
  const surgeIds = baseZone.surgeTwinIds || [];
  return namedZones().find(z => surgeIds.includes(z.id) && zonePriceMatchesGap(z.price, gap, itemsSubtotal)) || null;
}

function fmt(n) {
  return '₦' + Number(n).toLocaleString('en-NG');
}

// Main reconciler
// items: array of resolved line items with lineTotal set
// fulfillment: { type, fee, zoneId, zoneName, resolved }
// statedTotal: number or null
// Returns updated { reconciliation, fulfillment }
function reconcile(items, fulfillment, statedTotal) {
  const itemsSubtotal = items.reduce((sum, item) => {
    return sum + (item.lineTotal || 0);
  }, 0);

  const currentFee = fulfillment.fee || 0;
  const computedTotal = itemsSubtotal + currentFee;

  // No stated total → can't reconcile
  if (!statedTotal) {
    return {
      reconciliation: { status: 'unknown', gap: null, hypothesis: null },
      fulfillment,
      itemsSubtotal,
      orderTotal: computedTotal,
    };
  }

  if (computedTotal === statedTotal) {
    return {
      reconciliation: { status: 'matched', gap: 0, hypothesis: null },
      fulfillment,
      itemsSubtotal,
      orderTotal: computedTotal,
    };
  }

  const gap = statedTotal - itemsSubtotal;

  // If fulfillment is already resolved (pickup or explicit delivery fee), never override it.
  // Any gap is simply a mismatch — don't try to infer a different zone or fee.
  if (fulfillment.resolved) {
    return {
      reconciliation: computedTotal === statedTotal
        ? { status: 'matched', gap: 0, hypothesis: null }
        : { status: 'mismatch', gap: statedTotal - computedTotal, hypothesis: null },
      fulfillment,
      itemsSubtotal,
      orderTotal: computedTotal,
    };
  }

  // Try to infer delivery from the gap
  if (gap > 0) {
    // Check if gap matches current zone's base fee (delivery not yet added)
    if (fulfillment.zoneId && !fulfillment.resolved) {
      const zone = namedZones().find(z => z.id === fulfillment.zoneId);
      if (zone && zonePriceMatchesGap(zone.price, gap, itemsSubtotal)) {
        const updatedFulfillment = { ...fulfillment, fee: gap, resolved: true };
        return {
          reconciliation: {
            status: 'matched',
            gap: 0,
            hypothesis: `Delivery fee ${fmt(gap)} inferred from ${zone.name}`,
          },
          fulfillment: updatedFulfillment,
          itemsSubtotal,
          orderTotal: statedTotal,
        };
      }
    }

    // Check if gap matches a surge twin of the current zone
    if (fulfillment.zoneId) {
      const zone = namedZones().find(z => z.id === fulfillment.zoneId);
      const surge = gapMatchesSurge(gap, zone, itemsSubtotal);
      if (surge) {
        const updatedFulfillment = { ...fulfillment, fee: gap, zoneId: surge.id, zoneName: surge.name, resolved: true };
        return {
          reconciliation: {
            status: 'matched',
            gap: 0,
            hypothesis: `Surge applied: ${surge.name} ${fmt(gap)}`,
          },
          fulfillment: updatedFulfillment,
          itemsSubtotal,
          orderTotal: statedTotal,
        };
      }
    }

    // Check if gap matches any named zone (no zone set yet — infer from total)
    const inferredZone = gapMatchesZone(gap, itemsSubtotal);
    if (inferredZone) {
      const updatedFulfillment = {
        ...fulfillment,
        type: fulfillment.type || 'delivery',
        fee: gap,
        zoneId: inferredZone.id,
        zoneName: inferredZone.name,
        branch: inferredZone.branch,
        resolved: true,
      };
      return {
        reconciliation: {
          status: 'matched',
          gap: 0,
          hypothesis: `Delivery to ${inferredZone.name} ${fmt(gap)} inferred from total gap`,
        },
        fulfillment: updatedFulfillment,
        itemsSubtotal,
        orderTotal: statedTotal,
      };
    }
  }

  // Gap doesn't match anything
  return {
    reconciliation: {
      status: 'mismatch',
      gap: statedTotal - computedTotal,
      hypothesis: gap > 0 ? `Off by ${fmt(Math.abs(statedTotal - computedTotal))} — possible delivery or price difference` : null,
    },
    fulfillment,
    itemsSubtotal,
    orderTotal: computedTotal,
  };
}

module.exports = { reconcile };
