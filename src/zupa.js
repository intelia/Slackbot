'use strict';

// Emit the Zupa-ready order payload.
// In Phase 1 this logs and returns the payload.
// Phase 2: replace the stub with the actual Zupa API call.

function buildPayload(order, confirmedBy) {
  return {
    status: 'confirmed',
    source: 'whatsapp',
    raw_message: order.rawMessage,
    customer: {
      name: order.customer.name || null,
      instagram: order.customer.instagram || null,
      phone: order.customer.phone || null,
    },
    fulfillment: {
      type: order.fulfillment.type,
      branch: order.fulfillment.branch || null,
      address: order.fulfillment.address || null,
      zone_id: order.fulfillment.zoneId || null,
      zone_name: order.fulfillment.zoneName || null,
      delivery_fee: order.fulfillment.fee || 0,
    },
    items: order.items.map(item => ({
      size_id: item.sizeId,
      product_name: item.productName,
      size: item.sizeName,
      qty: item.qty,
      unit_price: item.unitPrice,
      line_total: item.lineTotal,
      match: item.match,
    })),
    items_subtotal: order.itemsSubtotal,
    order_total: order.orderTotal,
    reconciliation: order.reconciliation.status,
    confirmed_by: confirmedBy,
    notes: order.notes || [],
    overrides: [],
  };
}

async function pushToZupa(order, confirmedBy) {
  const payload = buildPayload(order, confirmedBy);

  // Phase 1: log payload; Phase 2: POST to Zupa API
  console.log('[Zupa] Order confirmed:', JSON.stringify(payload, null, 2));

  // TODO Phase 2: uncomment and configure
  // const response = await fetch(process.env.ZUPA_API_URL, {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ZUPA_API_KEY}` },
  //   body: JSON.stringify(payload),
  // });
  // if (!response.ok) throw new Error(`Zupa API error: ${response.status}`);
  // return response.json();

  return { payload, zupaOrderId: null };
}

module.exports = { pushToZupa, buildPayload };
