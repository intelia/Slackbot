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
    order: {
      amount: order.orderTotal,
      specialNote: specialNoteParts.join(" | ") || "",
      items: order.items.map((item) => ({
        productId: item.sizeId, // size-level UUID is the Zupa join key
        quantity: item.qty,
        price: item.unitPrice,
      })),
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

module.exports = { pushToZupa, buildZupaPayload };
