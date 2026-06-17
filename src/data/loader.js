"use strict";

const path = require("path");
const SystemProducts = require(
  path.join(__dirname, "..", "..", "systemProducts"),
);
const store = require("./store");

const CACHE_TTL_MS = 60 * 60 * 1000; // refresh indexes every hour
let lastLoadedAt = null;

// ── Cleaning helpers (mirror of scripts/clean-data.js) ───────────────────────

function normalizeStr(s) {
  return (s || "")
    .toUpperCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[-–—]+/g, " ")
    .replace(/\s+/g, " ");
}

function normalizeSizeName(name) {
  if (!name) return null;
  return name.trim().replace(/'{2}/g, '"').replace(/"|"/g, '"');
}

function cleanProducts(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const seen = new Map();
  const cleaned = [];

  for (const product of raw) {
    const name = (product.name || "").trim();
    if (!name) continue;

    const sizes = (product.sizes || [])
      .filter((s) => s && s.id && s.name && s.price != null)
      .map((s) => ({
        name: normalizeSizeName(s.name),
        id: s.id,
        price: s.price,
      }));

    if (sizes.length === 0) continue;

    const normalized = normalizeStr(name);
    if (seen.has(normalized)) {
      const existing = seen.get(normalized);
      if (sizes.length > existing.sizes.length) {
        existing.sizes = sizes;
        existing.name = name;
      }
      continue;
    }

    const entry = { name, normalized, category: (product.category || '').trim() || 'Other', sizes };
    seen.set(normalized, entry);
    cleaned.push(entry);
  }

  return cleaned.length > 0 ? cleaned : null;
}

const RIDE_HAIL_RE = /\buber\b|\bbolt\b/i;
const PICKUP_RE = /\bgtfree\b|\bpick\s*up\b|\bpickup\b/i;
const SURGE_RE = /\bsurge\b/i;

function extractBranch(name) {
  if (/\(mainland store\)/i.test(name)) return "Mainland";
  if (/\(opebi store\)/i.test(name)) return "Opebi";
  return "Lekki";
}

function extractBaseNameNormalized(name) {
  return normalizeStr(
    name
      .replace(/\(\s*surge\s*\)/gi, "")
      .replace(/\bsurge\b/gi, "")
      .replace(/\(mainland store\)/gi, "")
      .replace(/\(opebi store\)/gi, "")
      .trim(),
  );
}

function cleanCities(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const namedZones = [];
  const rideHailTiers = [];
  const pickupRows = [];

  for (const city of raw) {
    const name = (city.name || "").trim();
    if (!name) continue;

    const rawBranch = city.closestStore || extractBranch(name);
    const entry = {
      id: city.id,
      name,
      normalized: normalizeStr(name),
      price: city.price,
      branch:
        rawBranch.charAt(0).toUpperCase() + rawBranch.slice(1).toLowerCase(),
      isSurge: SURGE_RE.test(name),
      baseNameNormalized: extractBaseNameNormalized(name),
    };

    if (PICKUP_RE.test(name)) pickupRows.push(entry);
    else if (RIDE_HAIL_RE.test(name)) rideHailTiers.push(entry);
    else namedZones.push(entry);
  }

  for (const zone of namedZones) {
    if (!zone.isSurge) {
      zone.surgeTwinIds = namedZones
        .filter((z) => z.isSurge && z.baseNameNormalized === zone.normalized)
        .map((z) => z.id);
    }
  }

  return namedZones.length > 0
    ? { namedZones, rideHailTiers, pickupRows }
    : null;
}

// ── Fetch and refresh ─────────────────────────────────────────────────────────

async function loadFromAPI() {
  const [rawProducts, rawCities] = await Promise.all([
    SystemProducts.fetchProducts(),
    SystemProducts.getDeliveryCities(),
  ]);

  const products = cleanProducts(rawProducts);
  const cities = cleanCities(rawCities);
  console.log("================", {
    // "products": products,
    cities: JSON.stringify(cities, null, 2),
  });

  if (!products || !cities) {
    throw new Error(
      `API returned incomplete data (products: ${products?.length ?? "null"}, cities namedZones: ${cities?.namedZones?.length ?? "null"})`,
    );
  }

  return { products, cities };
}

// Call once at startup (and periodically via refreshIfStale).
// Falls back to the pre-generated static files if the API is unreachable.
async function init() {
  try {
    const { products, cities } = await loadFromAPI();
    store.setData(products, cities);

    // Rebuild the matcher's product index with fresh data
    const { refreshIndexes } = require("../parser/matcher");
    refreshIndexes();

    lastLoadedAt = Date.now();
    console.log(
      `[loader] Data refreshed from API — ${store.getProducts().length} products, ${store.getCities().namedZones.length} named zones`,
    );
  } catch (err) {
    console.warn(
      `[loader] API fetch failed, using cached/static data: ${err.message}`,
    );
    if (!lastLoadedAt) {
      // First boot with no API — static files are already in the store (via store.js require)
      console.log("[loader] Falling back to static clean files");
    }
  }
}

async function refreshIfStale() {
  if (!lastLoadedAt || Date.now() - lastLoadedAt > CACHE_TTL_MS) {
    await init();
  }
}

module.exports = { init, refreshIfStale };
