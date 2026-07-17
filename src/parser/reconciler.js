'use strict';

const store = require('../data/store');

function namedZones() { return store.getCities().namedZones; }

// Match a monetary gap to a known named zone fee (base zones only)
function gapMatchesZone(gap) {
  if (!gap || gap <= 0) return null;
  return namedZones().find(z => !z.isSurge && z.price === gap) || null;
}

// Match a monetary gap to a surge zone fee
function gapMatchesSurge(gap, baseZone) {
  if (!gap || gap <= 0 || !baseZone) return null;
  const surgeIds = baseZone.surgeTwinIds || [];
  return namedZones().find(z => surgeIds.includes(z.id) && z.price === gap) || null;
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
      if (zone && zone.price === gap) {
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
      const surge = gapMatchesSurge(gap, zone);
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
    const inferredZone = gapMatchesZone(gap);
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
