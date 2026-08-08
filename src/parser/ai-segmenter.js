"use strict";

const { OpenAI } = require("openai");
const { segment: ruleSegment } = require("./segmenter");
const store = require("../data/store");

let _client = null;

function getClient() {
  if (!_client) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const BASE_SYSTEM_PROMPT = `You are an order extraction assistant for Gourmet Twist, a bakery in Lagos, Nigeria.

Parse raw WhatsApp/Instagram DM order messages — they are often messy, informal, and inconsistently formatted.

Extraction rules:
- Nigerian phone numbers: 07xxx / 08xxx / 09xxx (11 digits) or +234xxx (13 digits). Extract as-is (no formatting changes).
- Instagram handles always start with @. Keep the @ prefix.
- For each ORDER ITEM extract: productPhrase (product name only, no size/qty/price), sizeToken, qty, statedPrice.
- CRITICAL: productPhrase must be the FULL product name from the CATALOGUE below. Customers often abbreviate — expand genuine abbreviations to the full catalogue name. E.g. "banana" → "Banana Bread", "choc cake" → "Chocolate Cake". Never truncate or abbreviate.
- CRITICAL: Do NOT substitute one catalogue product for a similar one. If the customer wrote a word that distinguishes two similar products (e.g. "fried rice" vs "jollof rice", "red velvet" vs "black forest"), keep that exact word — do not collapse it to the more common variant. Only expand when the customer clearly wrote less than the product name (abbreviation/shorthand); never replace one complete product name with another.
- sizeToken must be EXACTLY one of these values or null: mini, midi, regular, maxi, extra large, 6", 8", 10", 12", 14", standard, pack, packs, 25cl, 50cl, 1l, bowl
- Quantities: "x2", "2x", "×2", "(2)", "2 packs", "two" → integer 2. Default qty = 1 if not stated.
- Prices: "3000", "₦3,000", "3k", "3,500" → extract as a plain number (e.g. 3000, 3500). "3k" → 3000.
- statedTotal: the customer's stated grand total line (e.g. "Total....12,300(Name)", "Total: ₦55,500", "55500 total"). Extract as plain number or null.
- For fulfillment: set type to "pickup" if the customer says pickup / self-collect / will pick up; "delivery" if delivery / address given; "unknown" if unclear.
- For pickup: extract branch name (Lekki, Opebi, or Mainland) if mentioned, else null.
- For delivery: extract the address/area text verbatim into address field (do NOT resolve to zone names).
- statedFee: if customer writes "Delivery 4000" or "delivery fee: ₦3,500", extract as plain number; else null.
- If a name appears in parentheses after the total (e.g. "Total....12,300(Oluseye)"), treat it as the customer name.
- scheduledDate: if the customer mentions a future delivery/pickup date (e.g. "deliver Friday", "for Saturday 21st", "I need this on 25 June", "schedule for next Monday", "tomorrow"), resolve it to YYYY-MM-DD format using today's date as the reference. Return null for same-day or unspecified orders.
- recipient: if the order mentions a separate delivery recipient (e.g. "deliver to Amaka 08012345678", "recipient: Tolu", "for my mum at VI — call 0901…", "send to [name]"), extract their name and/or phone into recipient. The customer is the person placing/paying; the recipient is the person receiving. If customer and recipient appear to be the same person, set recipient to null. If only a recipient name is given with no separate customer name, still populate recipient (not customer).
- Notes: special instructions like "please prioritize", "urgent", "extra spicy", "no sugar". Short noise phrases (greetings, "hi", "Hello", "eye -", single orphan letters) go into notes only if they could be instructions; otherwise ignore.
- Ignore lines that are clearly noise: orphan letters/characters, "eye -" without context, greetings with no content.
- receiptName: if the message contains a name explicitly identified as the name on the payment transfer/receipt/bank statement — e.g. "name on receipt: John Okafor", "payment name: Ada", "sent from: Emeka Adeyemi", "transfer name: Chidi", "bank name: Oluwaseun", "name on transfer: Bisi" — extract it here. This is ONLY the bank transfer sender name when stated separately from the customer name; it is used for payment matching only and should not affect customer or recipient fields. Return null if not mentioned.

Return ONLY the JSON object matching the schema. Do not include explanation.`;

function buildSystemPrompt() {
  const todayLagos = new Date().toLocaleDateString("en-CA", {
    timeZone: "Africa/Lagos",
  }); // YYYY-MM-DD
  const products = store.getProducts();
  const cataloguePart =
    products && products.length > 0
      ? `\n\nCATALOGUE (exact product names — match customer text to the closest name here):\n${products.map((p) => p.name).join("\n")}`
      : "";
  return `${BASE_SYSTEM_PROMPT}\n\nToday's date (Lagos time): ${todayLagos}${cataloguePart}`;
}

// OpenAI structured-output schema (strict: true compatible)
const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "order_extraction",
    strict: true,
    schema: {
      type: "object",
      properties: {
        customer: {
          type: "object",
          properties: {
            name: { anyOf: [{ type: "string" }, { type: "null" }] },
            phone: { anyOf: [{ type: "string" }, { type: "null" }] },
            instagram: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          required: ["name", "phone", "instagram"],
          additionalProperties: false,
        },
        fulfillment: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["pickup", "delivery", "unknown"] },
            address: { anyOf: [{ type: "string" }, { type: "null" }] },
            branch: { anyOf: [{ type: "string" }, { type: "null" }] },
            statedFee: { anyOf: [{ type: "number" }, { type: "null" }] },
          },
          required: ["type", "address", "branch", "statedFee"],
          additionalProperties: false,
        },
        itemLines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              raw: { type: "string" },
              productPhrase: { type: "string" },
              sizeToken: { anyOf: [{ type: "string" }, { type: "null" }] },
              qty: { type: "integer" },
              statedPrice: { anyOf: [{ type: "number" }, { type: "null" }] },
            },
            required: [
              "raw",
              "productPhrase",
              "sizeToken",
              "qty",
              "statedPrice",
            ],
            additionalProperties: false,
          },
        },
        statedTotal: { anyOf: [{ type: "number" }, { type: "null" }] },
        scheduledDate: { anyOf: [{ type: "string" }, { type: "null" }] },
        recipient: {
          anyOf: [
            {
              type: "object",
              properties: {
                name: { anyOf: [{ type: "string" }, { type: "null" }] },
                phone: { anyOf: [{ type: "string" }, { type: "null" }] },
              },
              required: ["name", "phone"],
              additionalProperties: false,
            },
            { type: "null" },
          ],
        },
        notes: { type: "array", items: { type: "string" } },
        receiptName: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: [
        "customer",
        "fulfillment",
        "itemLines",
        "statedTotal",
        "scheduledDate",
        "recipient",
        "notes",
        "receiptName",
      ],
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
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: rawMessage },
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
    const response = await aiSegment(rawMessage);
    console.log("response: ", response);
    return response;
  } catch (err) {
    console.warn(
      "[ai-segmenter] OpenAI call failed, falling back to rule-based parser:",
      err.message,
    );
    return ruleSegment(rawMessage);
  }
}

module.exports = { segment };
