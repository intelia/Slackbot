"use strict";

const path = require("path");
const SystemProducts = require(path.join(__dirname, "..", "systemProducts"));

// Convert local phone format (09028920538) to international (+2349028920538)
function formatPhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("0") && digits.length === 11)
    return "+234" + digits.slice(1);
  if (digits.startsWith("234") && digits.length === 13) return "+" + digits;
  return phone;
}

// Build the payload expected by SystemProducts.createOrder
function buildZupaPayload(order) {
  const specialNoteParts = [];
  if (order.notes && order.notes.length > 0)
    specialNoteParts.push(order.notes.join(" "));
  if (order.customer.instagram)
    specialNoteParts.push(`IG: ${order.customer.instagram}`);

  const isPickup = order.fulfillment.type === "pickup";

  return {
    customer: {
      name: order.customer.name || null,
      phoneNumber: formatPhone(order.customer.phone),
    },
    ...(order.recipient && (order.recipient.name || order.recipient.phone) && {
      recipient: {
        name: order.recipient.name || null,
        phoneNumber: formatPhone(order.recipient.phone),
      },
    }),
    order: {
      amount: order.orderTotal,
      specialNote: specialNoteParts.join(" | ") || "",
      items: order.items.map((item) => ({
        productId: item.sizeId, // size-level UUID is the Zupa join key
        quantity: item.qty,
        price: item.unitPrice,
      })),
      ...(order.scheduledDate && { deliveryDate: order.scheduledDate }),
    },
    address: {
      deliveryAddress: isPickup ? null : order.fulfillment.address || null,
      isPickup,
      cityId: order.fulfillment.zoneId || null,
      pickupStore: isPickup
        ? (order.fulfillment.branch || "lekki").toLowerCase()
        : undefined,
    },
  };
}

async function pushToZupa(order, confirmedBy) {
  const payload = buildZupaPayload(order);

  console.log(
    `[Zupa] Pushing order confirmed by ${confirmedBy}:`,
    JSON.stringify(payload, null, 2),
  );

  const res = await SystemProducts.createOrder(payload);

  if (!res) throw new Error("No response from Zupa API");
  if (res.status === "error")
    throw new Error(res.message || "Zupa API returned an error");

  return {
    payload,
    zupaOrderId: res.id || res.orderId || res.data?.id || null,
    orderNumber: res.orderNumber,
    raw: res,
  };
}

// ── Order modification ────────────────────────────────────────────────────────

function buildModPayload(confirmedOrder, mod) {
  const payload = { orderNumber: confirmedOrder.orderNumber };

  if (mod.newName || mod.newPhone) {
    payload.updateCustomer = {};
    if (mod.newName)  payload.updateCustomer.name = mod.newName;
    if (mod.newPhone) payload.updateCustomer.phoneNumber = formatPhone(mod.newPhone);
  }

  if (mod.addItems.length > 0) {
    payload.addItems = mod.addItems.map((i) => ({
      productId: i.sizeId,
      quantity: i.qty,
      price: i.unitPrice,
    }));
  }

  if (mod.removeItems.length > 0) {
    payload.removeItems = mod.removeItems.map((i) => ({ productId: i.sizeId }));
  }

  if (mod.newZoneId) {
    payload.updateAddress = {
      deliveryAddress: mod.newAddress,
      cityId: mod.newZoneId,
    };
  }

  if (mod.newScheduledDate) {
    payload.deliveryDate = mod.newScheduledDate;
  }

  if (mod.newRecipient && (mod.newRecipient.name || mod.newRecipient.phone)) {
    payload.recipient = {
      name: mod.newRecipient.name || null,
      phoneNumber: formatPhone(mod.newRecipient.phone),
    };
  }

  return payload;
}

async function pushModification(confirmedOrder, mod, modifiedBy) {
  const payload = buildModPayload(confirmedOrder, mod);

  console.log(
    `[Zupa] Pushing modification for ${confirmedOrder.orderNumber} by ${modifiedBy}:`,
    JSON.stringify(payload, null, 2),
  );

  const res = await SystemProducts.modifyOrder(payload);
  if (!res) throw new Error("No response from Zupa API");
  if (res.status === "error")
    throw new Error(res.message || "Zupa API returned an error");

  return { payload, raw: res };
}

module.exports = { pushToZupa, buildZupaPayload, pushModification, buildModPayload };
