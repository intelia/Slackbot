'use strict';

const { OpenAI } = require('openai');
const { segment: ruleSegment } = require('./segmenter');

let _client = null;

function getClient() {
  if (!_client) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const SYSTEM_PROMPT = `You are an order extraction assistant for Gourmet Twist, a bakery in Lagos, Nigeria.

Parse raw WhatsApp/Instagram DM order messages — they are often messy, informal, and inconsistently formatted.

Extraction rules:
- Nigerian phone numbers: 07xxx / 08xxx / 09xxx (11 digits) or +234xxx (13 digits). Extract as-is (no formatting changes).
- Instagram handles always start with @. Keep the @ prefix.
- For each ORDER ITEM extract: productPhrase (product name only, no size/qty/price), sizeToken, qty, statedPrice.
- sizeToken must be EXACTLY one of these values or null: mini, midi, regular, maxi, extra large, 6", 8", 10", 12", 14", standard, pack, packs, 25cl, 50cl, 1l, bowl
- Quantities: "x2", "2x", "×2", "(2)", "2 packs", "two" → integer 2. Default qty = 1 if not stated.
- Prices: "3000", "₦3,000", "3k", "3,500" → extract as a plain number (e.g. 3000, 3500). "3k" → 3000.
- statedTotal: the customer's stated grand total line (e.g. "Total....12,300(Name)", "Total: ₦55,500", "55500 total"). Extract as plain number or null.
- For fulfillment: set type to "pickup" if the customer says pickup / self-collect / will pick up; "delivery" if delivery / address given; "unknown" if unclear.
- For pickup: extract branch name (Lekki, Opebi, or Mainland) if mentioned, else null.
- For delivery: extract the address/area text verbatim into address field (do NOT resolve to zone names).
- statedFee: if customer writes "Delivery 4000" or "delivery fee: ₦3,500", extract as plain number; else null.
- If a name appears in parentheses after the total (e.g. "Total....12,300(Oluseye)"), treat it as the customer name.
- Notes: special instructions like "please prioritize", "urgent", "extra spicy", "no sugar". Short noise phrases (greetings, "hi", "Hello", "eye -", single orphan letters) go into notes only if they could be instructions; otherwise ignore.
- Ignore lines that are clearly noise: orphan letters/characters, "eye -" without context, greetings with no content.

Return ONLY the JSON object matching the schema. Do not include explanation.`;

// OpenAI structured-output schema (strict: true compatible)
const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'order_extraction',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        customer: {
          type: 'object',
          properties: {
            name:      { anyOf: [{ type: 'string' }, { type: 'null' }] },
            phone:     { anyOf: [{ type: 'string' }, { type: 'null' }] },
            instagram: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
          required: ['name', 'phone', 'instagram'],
          additionalProperties: false,
        },
        fulfillment: {
          type: 'object',
          properties: {
            type:      { type: 'string', enum: ['pickup', 'delivery', 'unknown'] },
            address:   { anyOf: [{ type: 'string' }, { type: 'null' }] },
            branch:    { anyOf: [{ type: 'string' }, { type: 'null' }] },
            statedFee: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          },
          required: ['type', 'address', 'branch', 'statedFee'],
          additionalProperties: false,
        },
        itemLines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              raw:           { type: 'string' },
              productPhrase: { type: 'string' },
              sizeToken:     { anyOf: [{ type: 'string' }, { type: 'null' }] },
              qty:           { type: 'integer' },
              statedPrice:   { anyOf: [{ type: 'number' }, { type: 'null' }] },
            },
            required: ['raw', 'productPhrase', 'sizeToken', 'qty', 'statedPrice'],
            additionalProperties: false,
          },
        },
        statedTotal: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        notes:       { type: 'array', items: { type: 'string' } },
      },
      required: ['customer', 'fulfillment', 'itemLines', 'statedTotal', 'notes'],
      additionalProperties: false,
    },
  },
};

async function aiSegment(rawMessage) {
  const client = getClient();

  const completion = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: RESPONSE_FORMAT,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: rawMessage },
    ],
  });

  const content = completion.choices[0].message.content;
  const parsed = JSON.parse(content);

  // Ensure required array fields are present (defensive)
  parsed.itemLines = parsed.itemLines || [];
  parsed.notes = parsed.notes || [];

  return parsed;
}

async function segment(rawMessage) {
  try {
    return await aiSegment(rawMessage);
  } catch (err) {
    console.warn('[ai-segmenter] OpenAI call failed, falling back to rule-based parser:', err.message);
    return ruleSegment(rawMessage);
  }
}

module.exports = { segment };
