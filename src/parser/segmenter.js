'use strict';

const SIZE_TOKENS = [
  'extra large', 'extra-large',
  'mini', 'midi', 'regular', 'maxi',
  '6"', '8"', '10"', '12"', '14"',
  "6''", "8''", "10''", "12''", "14''",
  '6in', '8in', '10in', '12in', '14in',
  'standard', 'pack', 'packs',
  '25cl', '50cl', '1l', '1.5l', '2.5l', '3.5l',
  'bowl',
];

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12,
};

const NOISE_PATTERNS = [
  /^eye\s*[-–]?$/i,
  /^(hi|hello|hey|good\s+(morning|afternoon|evening|day))\b/i,
  /^(please|pls|kindly)\s+(prioritize|note|be\s+informed)/i,
  /^(thank(s|\s+you)?|thnx|tnx)[\s!.]*$/i,
  /^\s*[-–_*]+\s*$/,
];

function isNoiseLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length === 1 && !/\d/.test(trimmed)) return true;
  return NOISE_PATTERNS.some(re => re.test(trimmed));
}

// Is this line clearly a product/item? (has a size, quantity, or price token)
function looksLikeItemLine(line) {
  const lower = line.toLowerCase();
  const hasSizeToken = SIZE_TOKENS.some(t => {
    const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return re.test(lower);
  });
  if (hasSizeToken) return true;
  if (/[x×]\s*\d|\d\s*[x×]|\(\d+\)|\bpacks?\b|\bpcs?\b/i.test(line)) return true;
  // Has a price-like number (3+ digits, possibly with comma)
  if (/(?<![:/])\b\d{3,5}(?:,\d{3})?\b/.test(line)) return true;
  return false;
}

function parsePhone(line) {
  const stripped = line.replace(/[\s\-()]/g, '');
  if (/^[+]?[0-9]{10,14}$/.test(stripped)) return stripped;
  return null;
}

function parseInstagram(line) {
  const m = line.trim().match(/^@([\w.]+)/);
  return m ? `@${m[1]}` : null;
}

function parseAmount(str) {
  if (!str) return null;
  const cleaned = str.replace(/,/g, '').replace(/₦/g, '').trim();
  const n = Number(cleaned);
  return isFinite(n) && n > 0 ? n : null;
}

function parseTotalLine(line) {
  if (!/\btotal\b/i.test(line)) return null;
  const amountMatch = line.match(/[\d,]{4,}/);
  if (!amountMatch) return null;
  const amount = parseAmount(amountMatch[0]);
  if (!amount) return null;
  const nameMatch = line.match(/\(([A-Za-z][A-Za-z\s]{1,20})\)/);
  return { amount, name: nameMatch ? nameMatch[1].trim() : null };
}

function parseCouponLine(line) {
  const m = line.match(/\b(?:coupon|promo)(?:\s*code)?\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9\-]{2,})\b/i);
  return m ? m[1].toUpperCase() : null;
}

function parseFulfillmentLine(line) {
  const lower = line.toLowerCase();
  if (/pick\s*up|pickup/.test(lower)) {
    const branchMatch = line.match(/\b(lekki|opebi|mainland)\b/i);
    const branch = branchMatch ? capitalize(branchMatch[1]) : 'Lekki';
    return { type: 'pickup', address: null, branch };
  }
  if (/\bdelivery\b/.test(lower)) {
    const feeMatch = line.match(/[\d,]{3,}/);
    const statedFee = feeMatch ? parseAmount(feeMatch[0]) : null;
    const locationPart = line.replace(/\bdelivery\b/gi, '').replace(/[\d,₦:]+/g, '').trim();
    return { type: 'delivery', address: locationPart || null, statedFee };
  }
  return null;
}

function parseItemLine(line) {
  let working = line.trim().replace(/\.{2,}/g, ' ').replace(/…/g, ' ').replace(/\s+/g, ' ');

  // Extract stated price
  let statedPrice = null;
  working = working.replace(/(?<![x×\d])\b([\d]{1,3}(?:,\d{3})+|[\d]{3,5})\b(?!\s*[x×])/g, (match, p1) => {
    const n = parseAmount(p1);
    if (n && n >= 100) { statedPrice = n; return ' '; }
    return match;
  });
  working = working.trim();

  // Extract quantity
  let qty = 1;
  const qtyPatterns = [
    [/\bx\s*(\d+)\b/i, 1],
    [/\b(\d+)\s*x\b/i, 1],
    [/×\s*(\d+)/, 1],
    [/\((\d+)\)/, 1],
    [/\b(\d+)\s*packs?\b/i, 1],
    [/\b(\d+)\s*pcs?\b/i, 1],
    [/\b(\d+)\s*pieces?\b/i, 1],
  ];
  for (const [re] of qtyPatterns) {
    const m = working.match(re);
    if (m) { qty = parseInt(m[1], 10); working = working.replace(m[0], ' ').trim(); break; }
  }
  for (const [word, val] of Object.entries(NUMBER_WORDS)) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    if (re.test(working)) { qty = val; working = working.replace(re, ' ').trim(); break; }
  }

  // Extract size token
  let sizeToken = null;
  for (const token of SIZE_TOKENS) {
    const re = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(working)) { sizeToken = token; working = working.replace(re, ' ').trim(); break; }
  }

  return { productPhrase: working.replace(/\s+/g, ' ').trim(), sizeToken, qty, statedPrice };
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ── Main segmenter ────────────────────────────────────────────────────────────

function segment(rawMessage) {
  const lines = rawMessage.split(/\n|\r\n|\r/).map(l => l.trim()).filter(Boolean);

  const result = {
    rawMessage,
    customer: { name: null, phone: null, instagram: null },
    fulfillment: { type: null, address: null, branch: null, statedFee: null },
    itemLines: [],
    statedTotal: null,
    couponCode: null,
    noise: [],
    notes: [],
  };

  // Classify each line into a type on the first pass
  const classified = [];
  for (const line of lines) {
    if (isNoiseLine(line)) {
      if (/prioritize|priority|urgent/i.test(line)) {
        classified.push({ type: 'note', line });
      } else {
        classified.push({ type: 'noise', line });
      }
      continue;
    }

    const phone = parsePhone(line);
    if (phone) { classified.push({ type: 'phone', line, phone }); continue; }

    const ig = parseInstagram(line);
    if (ig) { classified.push({ type: 'instagram', line, ig }); continue; }

    const coupon = parseCouponLine(line);
    if (coupon) { classified.push({ type: 'coupon', line, coupon }); continue; }

    const total = parseTotalLine(line);
    if (total) { classified.push({ type: 'total', line, total }); continue; }

    const fulfillment = parseFulfillmentLine(line);
    if (fulfillment) { classified.push({ type: 'fulfillment', line, fulfillment }); continue; }

    // Short alpha-only line — could be name or address; decide in second pass
    const isShortAlpha = /^[A-Za-z][A-Za-z\s\-]{0,30}$/.test(line) && !looksLikeItemLine(line);
    if (isShortAlpha && line.split(' ').length <= 5) {
      classified.push({ type: 'ambiguous', line }); continue;
    }

    classified.push({ type: 'item', line });
  }

  // Second pass: resolve 'ambiguous' lines using position context
  const phoneIdx = classified.findIndex(c => c.type === 'phone');

  for (let i = 0; i < classified.length; i++) {
    const c = classified[i];

    if (c.type === 'phone') { result.customer.phone = c.phone; continue; }
    if (c.type === 'instagram') { result.customer.instagram = c.ig; continue; }
    if (c.type === 'note') { result.notes.push(c.line); continue; }
    if (c.type === 'noise') { result.noise.push(c.line); continue; }
    if (c.type === 'coupon') { result.couponCode = c.coupon; continue; }

    if (c.type === 'total') {
      result.statedTotal = c.total.amount;
      if (c.total.name && !result.customer.name) result.customer.name = c.total.name;
      continue;
    }

    if (c.type === 'fulfillment') {
      const f = c.fulfillment;
      // Selective merge: don't overwrite existing non-null fields with null
      if (f.type) result.fulfillment.type = f.type;
      if (f.address) result.fulfillment.address = f.address;
      if (f.branch) result.fulfillment.branch = f.branch;
      if (f.statedFee) result.fulfillment.statedFee = f.statedFee;
      continue;
    }

    if (c.type === 'item') {
      result.itemLines.push({ raw: c.line, ...parseItemLine(c.line) });
      continue;
    }

    if (c.type === 'ambiguous') {
      // Before the phone (or no phone found): treat as customer name
      if (phoneIdx === -1 || i < phoneIdx) {
        if (!result.customer.name) result.customer.name = c.line;
        else result.noise.push(c.line);
        continue;
      }

      // After the phone: treat as delivery address if not set yet
      if (!result.fulfillment.address && result.fulfillment.type !== 'pickup') {
        result.fulfillment.address = c.line;
        result.fulfillment.type = 'delivery';
        continue;
      }

      // Already have address: multi-word lines are likely items without price/size markers
      else if (c.line.split(' ').length >= 2) {
        result.itemLines.push({ raw: c.line, ...parseItemLine(c.line) });
      } else {
        result.noise.push(c.line);
      }
    }
  }

  return result;
}

module.exports = { segment, parseItemLine, parseTotalLine };
