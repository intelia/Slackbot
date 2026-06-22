'use strict';

const { OpenAI } = require('openai');
const store      = require('../data/store');
const { matchProduct, matchZone, normalize } = require('./matcher');

let _client = null;
function getClient() {
  if (!_client) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function buildSystemPrompt(existingItems) {
  const todayLagos = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }); // YYYY-MM-DD
  const catalogue  = store.getProducts().map(p => p.name).join('\n');
  const itemList   = existingItems.map(i => `- ${i.productName} · ${i.sizeName} ×${i.qty}`).join('\n');
  return `You are an order modification assistant for Gourmet Twist, a bakery in Lagos, Nigeria.
The user is replying in a confirmed-order thread to request changes.
Today's date (Lagos time): ${todayLagos}

CURRENT ORDER ITEMS:
${itemList}

CATALOGUE (exact product names — resolve abbreviations here):
${catalogue}

Parse what the user wants to change:
- addItems: new items to add. productPhrase must be the full catalogue name. sizeToken must be one of: mini, midi, regular, maxi, extra large, 6", 8", 10", 12", 14", standard, pack, packs, 25cl, 50cl, 1l, bowl — or null.
- removeItems: items to remove, matched by name against CURRENT ORDER ITEMS above.
- newAddress: new delivery area/address verbatim if the user wants to change it, else null.
- newName: new customer name if the user wants to change it, else null.
- newPhone: new customer phone number if the user wants to change it, else null.
- newScheduledDate: if the user wants to set or change the delivery/pickup date (e.g. "change delivery to Friday", "reschedule to 25 June", "deliver tomorrow"), resolve to YYYY-MM-DD using today's date as reference. Return null if no date change is requested.
- newRecipient: if the user wants to add or change the delivery recipient (e.g. "recipient is Amaka 0801…", "deliver to Tolu instead", "change recipient to…"), extract their name and/or phone. Set to null if no recipient change is requested.

Return ONLY the JSON object matching the schema.`;
}

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'order_modification',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        addItems: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              productPhrase: { type: 'string' },
              sizeToken:     { anyOf: [{ type: 'string' }, { type: 'null' }] },
              qty:           { type: 'integer' },
              statedPrice:   { anyOf: [{ type: 'number' }, { type: 'null' }] },
            },
            required: ['productPhrase', 'sizeToken', 'qty', 'statedPrice'],
            additionalProperties: false,
          },
        },
        removeItems: {
          type: 'array',
          items: {
            type: 'object',
            properties: { productPhrase: { type: 'string' } },
            required: ['productPhrase'],
            additionalProperties: false,
          },
        },
        newAddress:       { anyOf: [{ type: 'string' }, { type: 'null' }] },
        newName:          { anyOf: [{ type: 'string' }, { type: 'null' }] },
        newPhone:         { anyOf: [{ type: 'string' }, { type: 'null' }] },
        newScheduledDate: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        newRecipient: {
          anyOf: [
            {
              type: 'object',
              properties: {
                name:  { anyOf: [{ type: 'string' }, { type: 'null' }] },
                phone: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              },
              required: ['name', 'phone'],
              additionalProperties: false,
            },
            { type: 'null' },
          ],
        },
      },
      required: ['addItems', 'removeItems', 'newAddress', 'newName', 'newPhone', 'newScheduledDate', 'newRecipient'],
      additionalProperties: false,
    },
  },
};

async function aiSegmentMod(rawText, existingItems) {
  const client = getClient();
  const res = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: RESPONSE_FORMAT,
    messages: [
      { role: 'system', content: buildSystemPrompt(existingItems) },
      { role: 'user',   content: rawText },
    ],
  });
  const parsed = JSON.parse(res.choices[0].message.content);
  parsed.addItems    = parsed.addItems    || [];
  parsed.removeItems = parsed.removeItems || [];
  return parsed;
}

// Resolves an AI seg into matched products, zone, etc.
function resolve(seg, confirmedOrder) {
  const addItems            = [];
  const unresolvedAdditions = [];

  for (const item of seg.addItems) {
    const candidates = matchProduct(item.productPhrase, item.sizeToken, item.statedPrice, item.qty, 5);
    if (candidates.length > 0 && candidates[0].score >= 0.4) {
      const best = candidates[0];
      addItems.push({
        productName: best.productName,
        sizeName:    best.sizeName,
        sizeId:      best.sizeId,
        qty:         item.qty,
        unitPrice:   best.price,
        lineTotal:   best.price * item.qty,
        candidates,
      });
    } else {
      unresolvedAdditions.push({ raw: item.productPhrase });
    }
  }

  const removeItems        = [];
  const unresolvedRemovals = [];

  for (const item of seg.removeItems) {
    const phraseNorm = normalize(item.productPhrase || '');
    const matches = confirmedOrder.items.filter(oi => {
      const n = normalize(oi.productName || '');
      return n === phraseNorm || n.includes(phraseNorm) || phraseNorm.includes(n);
    });
    if (matches.length > 0) {
      removeItems.push({ ...matches[0], candidates: matches });
    } else {
      unresolvedRemovals.push({ raw: item.productPhrase });
    }
  }

  let newZoneId = null, newZoneName = null, newBranch = null, newFee = null;
  if (seg.newAddress) {
    const zone = matchZone(seg.newAddress);
    if (zone) {
      newZoneId   = zone.id;
      newZoneName = zone.name;
      newBranch   = zone.branch;
      newFee      = zone.price;
    }
  }

  const rec = seg.newRecipient;
  const newRecipient = rec && (rec.name || rec.phone)
    ? { name: rec.name || null, phone: rec.phone || null }
    : null;

  return {
    addItems,
    removeItems,
    unresolvedAdditions,
    unresolvedRemovals,
    newAddress:       seg.newAddress       || null,
    newZoneId,
    newZoneName,
    newBranch,
    newFee,
    newName:          seg.newName          || null,
    newPhone:         seg.newPhone         || null,
    newScheduledDate: seg.newScheduledDate || null,
    newRecipient,
  };
}

async function parseModification(rawText, confirmedOrder) {
  const seg = await aiSegmentMod(rawText, confirmedOrder.items);
  return resolve(seg, confirmedOrder);
}

module.exports = { parseModification };
