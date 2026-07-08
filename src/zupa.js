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
    clientReference: order.clientReference || null,
    customer: {
      name: order.customer.name || null,
      phoneNumber: formatPhone(order.customer.phone),
    },
    ...(order.recipient &&
      (order.recipient.name || order.recipient.phone) && {
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
      ...(order.paymentData?.transactionRef && {
        paymentReference: order.paymentData.transactionRef,
      }),
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
    if (mod.newName) payload.updateCustomer.name = mod.newName;
    if (mod.newPhone)
      payload.updateCustomer.phoneNumber = formatPhone(mod.newPhone);
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

// ── Payment verification & OTP ────────────────────────────────────────────────

async function paymentFetch(endpoint, body) {
  const url = `${process.env.ZUPA_API}/${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.ZUPA_API_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch((err) => {
    console.log(`[payment Fetch] No response from Zupa API`, err);
  });
  console.log(`[payment Fetch] response from ${endpoint} : `, data, body);
  return { status: res.status, data };
}

// Returns payment object if matched, null if no match (404), throws on other errors.
async function verifyPayment(customerName, recipientName, amount) {
  const { status, data } = await paymentFetch("payment/order/verify-payment", {
    customerName,
    recipientName,
    amount,
  });
  if (status === 200 && data.matched) return data;
  if (status === 404) return null;
  throw new Error(
    data.message || `Payment verification failed (HTTP ${status})`,
  );
}

// Sends a 6-digit OTP to the operator's WhatsApp. Throws on error.
async function requestOverrideOtp(clientReference) {
  const { status, data } = await paymentFetch("payment/order/override-otp", {
    clientReference,
  });
  if (status === 200 && data.success) return true;
  throw new Error(data.message || `OTP request failed (HTTP ${status})`);
}

// Verifies the OTP. Returns true on success, throws with API message on failure.
async function verifyOverrideOtp(clientReference, otp) {
  const { status, data } = await paymentFetch(
    "payment/order/override-otp/verify",
    {
      clientReference,
      otp,
    },
  );
  if (status === 200 && data.success) return true;
  throw new Error(data.message || `OTP verification failed (HTTP ${status})`);
}

// Returns kitchen summary for a date range (YYYY-MM-DD strings).
// For a single day, pass the same date for both startDate and endDate.
// Throws on non-2xx; callers should .catch(() => null) for optional periods.
async function fetchKitchenSummary(startDate, endDate) {
  const url = new URL(`${process.env.ZUPA_API}/kitchen-api/daily-summary`);
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  console.log(`[Zupa] Fetching kitchen summary ${startDate}→${endDate}`);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${process.env.ZUPA_API_TOKEN}` },
  });
  console.log(`[Zupa] Kitchen summary response: ${res.status}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      err.message || `Kitchen summary API failed (HTTP ${res.status})`,
    );
  }
  const result = await res.json();
  console.log("[Zupa] Kitchen summary data:", result);
  return result;
}

module.exports = {
  pushToZupa,
  buildZupaPayload,
  pushModification,
  buildModPayload,
  verifyPayment,
  requestOverrideOtp,
  verifyOverrideOtp,
  fetchKitchenSummary,
};
