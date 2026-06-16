'use strict';

const path = require('path');
const PRODUCTS = require(path.join(__dirname, '..', 'data', 'products.clean.json'));
const { namedZones, rideHailTiers, pickupRows } = require(path.join(__dirname, '..', 'data', 'cities.clean.json'));
const ALIAS_MAP = require(path.join(__dirname, '..', 'data', 'alias-map.json'));

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

// Build a set of tokens from a normalized string, filtering short/filler words
const STOP_WORDS = new Set(['AND', 'WITH', 'THE', 'OF', 'IN', 'A', 'AN', 'X']);
function tokenize(normalized) {
  return normalized.split(' ').filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

// ── Product matching ──────────────────────────────────────────────────────────

// Pre-compute tokens for all products once
// Re-normalize from name so the / stripping takes effect even if stored .normalized has it
const PRODUCT_INDEX = PRODUCTS.map(p => {
  const n = normalize(p.name);
  return {
    ...p,
    normalized: n,
    tokens: tokenize(n),
    tokensNoBread: tokenize(n.replace(/\bBREAD\b/, '').replace(/\bCAKE\b/, '')),
  };
});

// Score how well a customer phrase matches a product name (0–1)
function scoreProductMatch(phraseNorm, phraseTokens, product) {
  const prodNorm = product.normalized;
  const prodTokens = product.tokens;
  const prodTokensNB = product.tokensNoBread;

  // Exact match
  if (phraseNorm === prodNorm) return 1.0;

  // Phrase is a substring of product name (or vice versa)
  if (prodNorm.includes(phraseNorm)) return 0.9;
  const prodNormNB = prodNorm.replace(/\bBREAD\b/, '').replace(/\bCAKE\b/, '').trim();
  if (prodNormNB === phraseNorm || prodNormNB.includes(phraseNorm)) return 0.88;

  // Token overlap (bidirectional: how many customer tokens appear in product, and vice versa)
  if (phraseTokens.length === 0) return 0;

  let matchCount = 0;
  for (const t of phraseTokens) {
    if (prodTokens.includes(t) || prodTokensNB.includes(t)) {
      matchCount += 1;
    } else if (t.length >= 4) {
      // Fuzzy: customer token is a prefix of a product token (e.g. "WINNER" matches "WINNERS")
      const fuzzy = [...prodTokens, ...prodTokensNB].some(pt => pt.startsWith(t) || t.startsWith(pt));
      if (fuzzy) matchCount += 0.8;
    }
  }
  const forwardScore = matchCount / phraseTokens.length;

  // Partial bonus: product tokens that appear in phrase
  let reverseMatch = 0;
  for (const t of prodTokensNB) {
    if (phraseTokens.includes(t)) reverseMatch++;
    else if (t.length >= 4 && phraseTokens.some(pt => pt.startsWith(t) || t.startsWith(pt))) reverseMatch += 0.5;
  }
  const reverseScore = prodTokensNB.length > 0 ? reverseMatch / prodTokensNB.length : 0;

  const base = forwardScore * 0.7 + reverseScore * 0.3;
  return Math.min(1, base);
}

// Normalize a size token from the segmenter to a canonical size name for lookup
const SIZE_NORM_MAP = {
  'MINI': 'Mini',
  'MIDI': 'Midi',
  'REGULAR': 'Regular',
  'REG': 'Regular',
  'MAXI': 'Maxi',
  'EXTRA LARGE': 'Extra Large',
  'EXTRA-LARGE': 'Extra Large',
  'XL': 'Extra Large',
  'STANDARD': 'Standard',
  'PACK': 'Pack(s)',
  'PACKS': 'Pack(s)',
  '6"': '6"',
  "6''": '6"',
  '6IN': '6"',
  '8"': '8"',
  "8''": '8"',
  '8IN': '8"',
  '10"': '10"',
  "10''": '10"',
  '10IN': '10"',
  '12"': '12"',
  "12''": '12"',
  '12IN': '12"',
  '14"': '14"',
  "14''": '14"',
  '14IN': '14"',
  '25CL': '25CL',
  '50CL': '50CL',
  '1L': '1L',
  '1.5L': '1.5L',
  '2.5L': '2.5L',
  '3.5L': '3.5L',
  'BOWL': 'Bowl',
};

function canonicalSize(sizeToken) {
  if (!sizeToken) return null;
  return SIZE_NORM_MAP[sizeToken.toUpperCase()] || null;
}

// Find a size in a product's size list (case-insensitive)
function findSize(product, sizeName) {
  if (!sizeName) return null;
  const upper = sizeName.toUpperCase();
  return product.sizes.find(s => s.name.toUpperCase() === upper) || null;
}

// Main product match function
// Returns array of candidates sorted by score, best first
function matchProduct(productPhrase, sizeToken, statedPrice) {
  const phraseNorm = normalize(productPhrase);
  const phraseTokens = tokenize(phraseNorm);
  const canonSize = canonicalSize(sizeToken);

  const SCORE_THRESHOLD = 0.25;
  const candidates = [];

  for (const product of PRODUCT_INDEX) {
    if (product.sizes.length === 0) continue;

    let score = scoreProductMatch(phraseNorm, phraseTokens, product);
    if (score < SCORE_THRESHOLD) continue;

    // For each valid size of this product, build a candidate SKU
    const targetSizes = canonSize
      ? product.sizes.filter(s => s.name.toUpperCase() === canonSize.toUpperCase())
      : product.sizes.length === 1 && product.sizes[0].name === 'Standard'
        ? product.sizes   // single-size product
        : product.sizes;  // all sizes

    for (const size of targetSizes) {
      let sku_score = score;
      let priceMatch = false;

      // Price tiebreaker: exact match strongly boosts this candidate
      if (statedPrice && size.price === statedPrice) {
        sku_score = Math.min(1, sku_score + 0.4);
        priceMatch = true;
      } else if (statedPrice && Math.abs(size.price - statedPrice) / statedPrice < 0.05) {
        // Within 5% — mild boost
        sku_score = Math.min(1, sku_score + 0.1);
      }

      candidates.push({
        productName: product.name,
        sizeName: size.name,
        sizeId: size.id,
        price: size.price,
        score: sku_score,
        priceMatch,
      });
    }
  }

  // Sort by score descending; break ties with price match
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.priceMatch && !b.priceMatch) return -1;
    if (b.priceMatch && !a.priceMatch) return 1;
    return 0;
  });

  // Return top 6
  return candidates.slice(0, 6);
}

// ── Zone matching ─────────────────────────────────────────────────────────────

// Detect pickup and return the correct pickup row
function matchPickup(address, branch) {
  const upper = (address || '').toUpperCase();
  const branchUpper = (branch || '').toUpperCase();

  if (branchUpper === 'OPEBI' || upper.includes('OPEBI')) {
    return pickupRows.find(r => /opebi/i.test(r.name)) || pickupRows[0];
  }
  if (branchUpper === 'LEKKI' || upper.includes('LEKKI')) {
    return pickupRows.find(r => /lekki/i.test(r.name)) || pickupRows[0];
  }
  return pickupRows.find(r => /^pickup$/i.test(r.name)) || pickupRows[0];
}

// Try to match an address string to a named delivery zone
// Returns the zone object (preferring base over surge) or null
function matchZone(address) {
  if (!address) return null;
  const addressNorm = normalize(address);
  const addressTokens = tokenize(addressNorm);

  // 1. Alias map lookup (exact key match)
  const aliasKey = addressNorm.replace(/[^A-Z0-9\s]/g, '').trim();
  if (ALIAS_MAP[aliasKey]) {
    const alias = ALIAS_MAP[aliasKey];
    const zone = namedZones.find(z => z.id === alias.zoneId);
    return zone || { id: alias.zoneId, name: alias.zoneName, price: 0, branch: alias.branch, isSurge: false };
  }

  // Also check each word of the address against alias keys
  for (const token of addressTokens) {
    if (ALIAS_MAP[token]) {
      const alias = ALIAS_MAP[token];
      const zone = namedZones.find(z => z.id === alias.zoneId);
      return zone || { id: alias.zoneId, name: alias.zoneName, price: 0, branch: alias.branch, isSurge: false };
    }
  }

  // 2. Direct match against named zones (normalized)
  let bestScore = 0;
  let bestZone = null;

  for (const zone of namedZones) {
    if (zone.isSurge) continue; // prefer base zones from address matching

    const zoneNorm = zone.normalized;
    const zoneTokens = tokenize(zoneNorm);

    // Exact
    if (zoneNorm === addressNorm) return zone;

    // Contains
    if (zoneNorm.includes(addressNorm) || addressNorm.includes(zoneNorm)) {
      const score = 0.85;
      if (score > bestScore) { bestScore = score; bestZone = zone; }
      continue;
    }

    // Token overlap
    let matches = 0;
    for (const t of addressTokens) {
      if (zoneTokens.includes(t)) matches++;
    }
    const score = addressTokens.length > 0 ? matches / addressTokens.length : 0;
    if (score >= 0.5 && score > bestScore) {
      bestScore = score;
      bestZone = zone;
    }
  }

  return bestScore >= 0.5 ? bestZone : null;
}

// Given a base zone, find any surge twin zone
function getSurgeTwins(baseZone) {
  if (!baseZone || !baseZone.surgeTwinIds) return [];
  return baseZone.surgeTwinIds.map(id => namedZones.find(z => z.id === id)).filter(Boolean);
}

// Find a named zone by ID
function getZoneById(id) {
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
  PRODUCTS: PRODUCT_INDEX,
  namedZones,
  rideHailTiers,
  pickupRows,
  ALIAS_MAP,
};
