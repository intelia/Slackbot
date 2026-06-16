'use strict';

const store   = require('../data/store');
const ALIAS_MAP = require('../data/alias-map.json');

// ── Normalization ─────────────────────────────────────────────────────────────

function normalize(s) {
  return (s || '')
    .toUpperCase()
    .trim()
    .replace(/[''"`]/g, '')
    .replace(/[/\\]+/g, ' ')   // "Eco/Winners" → "Eco Winners"
    .replace(/[-–—]+/g, ' ')
    .replace(/\s+/g, ' ');
}

const STOP_WORDS = new Set(['AND', 'WITH', 'THE', 'OF', 'IN', 'A', 'AN', 'X']);
function tokenize(normalized) {
  return normalized.split(' ').filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

// ── Product index (rebuilt whenever store data is refreshed) ──────────────────

function buildProductIndex(products) {
  return products.map(p => {
    const n = normalize(p.name);
    return {
      ...p,
      normalized: n,
      tokens: tokenize(n),
      tokensNoBread: tokenize(n.replace(/\bBREAD\b/, '').replace(/\bCAKE\b/, '')),
    };
  });
}

let _productIndex = buildProductIndex(store.getProducts());

// Called by loader.js after a successful API fetch
function refreshIndexes() {
  _productIndex = buildProductIndex(store.getProducts());
}

function getProductIndex() { return _productIndex; }

// ── Product scoring ───────────────────────────────────────────────────────────

function scoreProductMatch(phraseNorm, phraseTokens, product) {
  const prodNorm     = product.normalized;
  const prodTokens   = product.tokens;
  const prodTokensNB = product.tokensNoBread;

  if (phraseNorm === prodNorm) return 1.0;
  if (prodNorm.includes(phraseNorm)) return 0.9;
  const prodNormNB = prodNorm.replace(/\bBREAD\b/, '').replace(/\bCAKE\b/, '').trim();
  if (prodNormNB === phraseNorm || prodNormNB.includes(phraseNorm)) return 0.88;

  if (phraseTokens.length === 0) return 0;

  let matchCount = 0;
  for (const t of phraseTokens) {
    if (prodTokens.includes(t) || prodTokensNB.includes(t)) {
      matchCount += 1;
    } else if (t.length >= 4) {
      const fuzzy = [...prodTokens, ...prodTokensNB].some(pt => pt.startsWith(t) || t.startsWith(pt));
      if (fuzzy) matchCount += 0.8;
    }
  }
  const forwardScore = matchCount / phraseTokens.length;

  let reverseMatch = 0;
  for (const t of prodTokensNB) {
    if (phraseTokens.includes(t)) reverseMatch++;
    else if (t.length >= 4 && phraseTokens.some(pt => pt.startsWith(t) || t.startsWith(pt))) reverseMatch += 0.5;
  }
  const reverseScore = prodTokensNB.length > 0 ? reverseMatch / prodTokensNB.length : 0;

  return Math.min(1, forwardScore * 0.7 + reverseScore * 0.3);
}

// ── Size helpers ──────────────────────────────────────────────────────────────

const SIZE_NORM_MAP = {
  'MINI': 'Mini', 'MIDI': 'Midi', 'REGULAR': 'Regular', 'REG': 'Regular',
  'MAXI': 'Maxi', 'EXTRA LARGE': 'Extra Large', 'EXTRA-LARGE': 'Extra Large',
  'XL': 'Extra Large', 'STANDARD': 'Standard', 'PACK': 'Pack(s)', 'PACKS': 'Pack(s)',
  '6"': '6"', "6''": '6"', '6IN': '6"',
  '8"': '8"', "8''": '8"', '8IN': '8"',
  '10"': '10"', "10''": '10"', '10IN': '10"',
  '12"': '12"', "12''": '12"', '12IN': '12"',
  '14"': '14"', "14''": '14"', '14IN': '14"',
  '25CL': '25CL', '50CL': '50CL', '1L': '1L',
  '1.5L': '1.5L', '2.5L': '2.5L', '3.5L': '3.5L', 'BOWL': 'Bowl',
};

function canonicalSize(sizeToken) {
  if (!sizeToken) return null;
  return SIZE_NORM_MAP[sizeToken.toUpperCase()] || null;
}

function findSize(product, sizeName) {
  if (!sizeName) return null;
  const upper = sizeName.toUpperCase();
  return product.sizes.find(s => s.name.toUpperCase() === upper) || null;
}

// ── Product match ─────────────────────────────────────────────────────────────

function matchProduct(productPhrase, sizeToken, statedPrice, qty) {
  const phraseNorm  = normalize(productPhrase);
  const phraseTokens = tokenize(phraseNorm);
  const canonSize   = canonicalSize(sizeToken);
  const SCORE_THRESHOLD = 0.25;
  const candidates  = [];

  // statedPrice may be a unit price OR a line total; derive both possibilities
  const effectiveQty   = (qty && qty > 1) ? qty : 1;
  const unitFromTotal  = (statedPrice && effectiveQty > 1) ? Math.round(statedPrice / effectiveQty) : null;

  for (const product of _productIndex) {
    if (product.sizes.length === 0) continue;

    const score = scoreProductMatch(phraseNorm, phraseTokens, product);
    if (score < SCORE_THRESHOLD) continue;

    const targetSizes = canonSize
      ? product.sizes.filter(s => s.name.toUpperCase() === canonSize.toUpperCase())
      : product.sizes.length === 1 && product.sizes[0].name === 'Standard'
        ? product.sizes
        : product.sizes;

    for (const size of targetSizes) {
      let skuScore   = score;
      let priceMatch = false;

      if (statedPrice && size.price === statedPrice) {
        // unit price matches directly
        skuScore   = Math.min(1, skuScore + 0.4);
        priceMatch = true;
      } else if (unitFromTotal && size.price === unitFromTotal) {
        // statedPrice is the line total; unit price matches when divided by qty
        skuScore   = Math.min(1, skuScore + 0.4);
        priceMatch = true;
      } else if (statedPrice && Math.abs(size.price - statedPrice) / statedPrice < 0.05) {
        skuScore = Math.min(1, skuScore + 0.1);
      }

      candidates.push({ productName: product.name, sizeName: size.name, sizeId: size.id, price: size.price, score: skuScore, priceMatch });
    }
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.priceMatch && !b.priceMatch) return -1;
    if (b.priceMatch && !a.priceMatch) return 1;
    return 0;
  });

  return candidates.slice(0, 6);
}

// ── Zone matching ─────────────────────────────────────────────────────────────

function matchPickup(address, branch) {
  const { pickupRows } = store.getCities();
  const upper       = (address || '').toUpperCase();
  const branchUpper = (branch  || '').toUpperCase();

  if (branchUpper === 'OPEBI' || upper.includes('OPEBI')) return pickupRows.find(r => /opebi/i.test(r.name)) || pickupRows[0];
  if (branchUpper === 'LEKKI' || upper.includes('LEKKI')) return pickupRows.find(r => /lekki/i.test(r.name)) || pickupRows[0];
  return pickupRows.find(r => /^pickup$/i.test(r.name)) || pickupRows[0];
}

function matchZone(address) {
  if (!address) return null;
  const { namedZones } = store.getCities();
  const addressNorm   = normalize(address);
  const addressTokens = tokenize(addressNorm);

  // 1. Alias map
  const aliasKey = addressNorm.replace(/[^A-Z0-9\s]/g, '').trim();
  if (ALIAS_MAP[aliasKey]) {
    const alias = ALIAS_MAP[aliasKey];
    return namedZones.find(z => z.id === alias.zoneId) || { id: alias.zoneId, name: alias.zoneName, price: 0, branch: alias.branch, isSurge: false };
  }
  for (const token of addressTokens) {
    if (ALIAS_MAP[token]) {
      const alias = ALIAS_MAP[token];
      return namedZones.find(z => z.id === alias.zoneId) || { id: alias.zoneId, name: alias.zoneName, price: 0, branch: alias.branch, isSurge: false };
    }
  }

  // 2. Direct zone match
  let bestScore = 0;
  let bestZone  = null;

  for (const zone of namedZones) {
    if (zone.isSurge) continue;
    const zoneNorm   = zone.normalized;
    const zoneTokens = tokenize(zoneNorm);

    if (zoneNorm === addressNorm) return zone;

    if (zoneNorm.includes(addressNorm) || addressNorm.includes(zoneNorm)) {
      if (0.85 > bestScore) { bestScore = 0.85; bestZone = zone; }
      continue;
    }

    let matches = 0;
    for (const t of addressTokens) { if (zoneTokens.includes(t)) matches++; }
    const score = addressTokens.length > 0 ? matches / addressTokens.length : 0;
    if (score >= 0.5 && score > bestScore) { bestScore = score; bestZone = zone; }
  }

  return bestScore >= 0.5 ? bestZone : null;
}

function getSurgeTwins(baseZone) {
  if (!baseZone || !baseZone.surgeTwinIds) return [];
  const { namedZones } = store.getCities();
  return baseZone.surgeTwinIds.map(id => namedZones.find(z => z.id === id)).filter(Boolean);
}

function getZoneById(id) {
  const { namedZones, rideHailTiers, pickupRows } = store.getCities();
  return namedZones.find(z => z.id === id) || rideHailTiers.find(z => z.id === id) || pickupRows.find(z => z.id === id) || null;
}

module.exports = {
  matchProduct,
  matchPickup,
  matchZone,
  getSurgeTwins,
  getZoneById,
  canonicalSize,
  findSize,
  normalize,
  getProductIndex,
  refreshIndexes,
  get namedZones()    { return store.getCities().namedZones; },
  get rideHailTiers() { return store.getCities().rideHailTiers; },
  get pickupRows()    { return store.getCities().pickupRows; },
  ALIAS_MAP,
};
