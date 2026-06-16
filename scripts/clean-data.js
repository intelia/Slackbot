'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'data');
const RAW_PRODUCTS = path.join(__dirname, '..', 'products.json');
const RAW_CITIES = path.join(__dirname, '..', 'cities.json');

function normalizeStr(s) {
  return (s || '').toUpperCase().trim().replace(/\s+/g, ' ').replace(/[-–—]+/g, ' ').replace(/\s+/g, ' ');
}

// Normalize size name: unify quote styles, trim
function normalizeSizeName(name) {
  if (!name) return null;
  return name.trim()
    .replace(/'{2}/g, '"')  // '' → "
    .replace(/’{2}/g, '"')
    .replace(/“|”/g, '"');
}

// ── Products ─────────────────────────────────────────────────────────────────

function cleanProducts(raw) {
  const seen = new Map();
  const cleaned = [];
  let nullCount = 0;

  for (const product of raw) {
    const name = (product.name || '').trim();
    if (!name) continue;

    const sizes = (product.sizes || [])
      .filter(s => s && s.id && s.name && s.price != null)
      .map(s => ({
        name: normalizeSizeName(s.name),
        id: s.id,
        price: s.price,
      }));

    nullCount += (product.sizes || []).length - sizes.length;

    const normalized = normalizeStr(name);

    if (seen.has(normalized)) {
      // Merge sizes into existing entry if it has more complete size data
      const existing = seen.get(normalized);
      if (sizes.length > existing.sizes.length) {
        existing.sizes = sizes;
        existing.name = name; // keep cleaner name (no trailing space)
      }
      continue;
    }

    const entry = { name, normalized, sizes };
    seen.set(normalized, entry);
    cleaned.push(entry);
  }

  console.log(`Products: ${raw.length} raw → ${cleaned.length} clean, ${nullCount} null sizes stripped`);
  return cleaned;
}

// ── Cities ────────────────────────────────────────────────────────────────────

const RIDE_HAIL_RE = /\buber\b|\bbolt\b/i;
const PICKUP_RE = /\bgtfree\b|\bpick\s*up\b|\bpickup\b/i;
const SURGE_RE = /\bsurge\b/i;
const MAINLAND_RE = /\(mainland store\)/i;
const OPEBI_RE = /\(opebi store\)/i;

function extractBranch(name) {
  if (MAINLAND_RE.test(name)) return 'Mainland';
  if (OPEBI_RE.test(name)) return 'Opebi';
  return 'Lekki';
}

function extractBaseNameNormalized(name) {
  // Remove surge suffix variants to get the base zone normalized name
  return normalizeStr(
    name
      .replace(/\(\s*surge\s*\)/gi, '')
      .replace(/\bsurge\b/gi, '')
      .replace(/\(mainland store\)/gi, '')
      .replace(/\(opebi store\)/gi, '')
      .trim()
  );
}

function cleanCities(raw) {
  const namedZones = [];
  const rideHailTiers = [];
  const pickupRows = [];

  for (const city of raw) {
    const name = (city.name || '').trim();
    if (!name) continue;

    const entry = {
      id: city.id,
      name,
      normalized: normalizeStr(name),
      price: city.price,
      branch: extractBranch(name),
      isSurge: SURGE_RE.test(name),
      baseNameNormalized: extractBaseNameNormalized(name),
    };

    if (PICKUP_RE.test(name)) {
      pickupRows.push(entry);
    } else if (RIDE_HAIL_RE.test(name)) {
      rideHailTiers.push(entry);
    } else {
      namedZones.push(entry);
    }
  }

  // Build surge twin links: for each non-surge zone, find its surge variants
  for (const zone of namedZones) {
    if (!zone.isSurge) {
      zone.surgeTwinIds = namedZones
        .filter(z => z.isSurge && z.baseNameNormalized === zone.normalized)
        .map(z => z.id);
    }
  }

  console.log(`Cities: ${raw.length} raw → ${namedZones.length} named zones, ${rideHailTiers.length} ride-hail tiers, ${pickupRows.length} pickup rows`);
  return { namedZones, rideHailTiers, pickupRows };
}

// ── Alias map seed ────────────────────────────────────────────────────────────
// Sub-areas customers use that are NOT zone names themselves.
// Populated from SOW examples + common Lagos sub-area knowledge.
// Staff corrections during Phase 2 will grow this automatically.

const ALIAS_MAP_SEED = {
  // Ketu area (Mainland)
  'ALAPERE': { zoneId: 'b161e54b-ac1d-450d-993b-6138b8678a62', zoneName: 'Ketu (Mainland Store)', branch: 'Mainland' },
  'MILE 12': { zoneId: 'b161e54b-ac1d-450d-993b-6138b8678a62', zoneName: 'Ketu (Mainland Store)', branch: 'Mainland' },
  'MILE12': { zoneId: 'b161e54b-ac1d-450d-993b-6138b8678a62', zoneName: 'Ketu (Mainland Store)', branch: 'Mainland' },

  // Ologolo
  'OLOGOLO': { zoneId: 'b12e8159-90a3-4c15-af96-29ac0aa14955', zoneName: 'Lekki - Ologolo Spg', branch: 'Lekki' },
  'SPG': { zoneId: 'b12e8159-90a3-4c15-af96-29ac0aa14955', zoneName: 'Lekki - Ologolo Spg', branch: 'Lekki' },

  // VGC
  'VGC': { zoneId: '675cfe9d-f9f7-454d-9833-89cfe40d4c8f', zoneName: 'LEKKI -VGC', branch: 'Lekki' },
  'VICTORIA GARDEN CITY': { zoneId: '675cfe9d-f9f7-454d-9833-89cfe40d4c8f', zoneName: 'LEKKI -VGC', branch: 'Lekki' },

  // Ajah sub-areas
  'THOMAS ESTATE': { zoneId: '0ab4d802-2f7d-468e-9327-22f96d4ab8b3', zoneName: 'Ajah - Thomas', branch: 'Lekki' },
  'LANGBASA': { zoneId: 'f5936103-53ac-415c-84c9-ec03d7793686', zoneName: 'Ajah - Langbasa', branch: 'Lekki' },
  'ILAJE AJAH': { zoneId: 'ce8237e2-85d5-4a2a-84c0-496afafa5496', zoneName: 'Ajah - Ilaje', branch: 'Lekki' },
  'OGOMBO': { zoneId: '643bfda5-d096-485d-8a35-1ab57ae10281', zoneName: 'Ajah  - Ogombo', branch: 'Lekki' },
  'ABRAHAM ADESANYA': { zoneId: '27497f9e-6aa0-4947-b8a7-ef595ede7fa3', zoneName: 'Ajah - Abraham Adesanya', branch: 'Lekki' },

  // VI / Oniru
  'VI': { zoneId: '54c06455-2438-4bed-b0a1-7e75a968353e', zoneName: 'Victoria Island', branch: 'Lekki' },
  'VICTORIA ISLAND': { zoneId: '54c06455-2438-4bed-b0a1-7e75a968353e', zoneName: 'Victoria Island', branch: 'Lekki' },
  'ONIRU': { zoneId: 'efbf0479-4fbf-4cd9-8084-1b478bcf45cd', zoneName: 'LEKKI-ONIRU ESTATE', branch: 'Lekki' },

  // Freedom Way
  'FREEDOM WAY': { zoneId: 'f8eb67d6-5b93-46dc-a891-04f483784695', zoneName: 'Lekki - Freedom Way', branch: 'Lekki' },
  'ADMIRALTY WAY': { zoneId: 'f8eb67d6-5b93-46dc-a891-04f483784695', zoneName: 'Lekki - Freedom Way', branch: 'Lekki' },

  // Lekki Phase 1
  'PHASE 1': { zoneId: '7bf20cf6-4ab7-4a35-9a0b-05c04384a9fb', zoneName: 'Lekki Phase 1', branch: 'Lekki' },
  'LEKKI PHASE 1': { zoneId: '7bf20cf6-4ab7-4a35-9a0b-05c04384a9fb', zoneName: 'Lekki Phase 1', branch: 'Lekki' },

  // Chevron area
  'CHEVRON': { zoneId: 'eb3ab97e-4475-41d0-a3be-4fd56d107c5d', zoneName: 'Lekki - Chevron', branch: 'Lekki' },
  'CHEVRON DRIVE': { zoneId: 'eb3ab97e-4475-41d0-a3be-4fd56d107c5d', zoneName: 'Lekki - Chevron', branch: 'Lekki' },

  // Osapa London
  'OSAPA': { zoneId: 'c91b26e1-2774-48dd-ba3e-1c102e3eb956', zoneName: 'LEKKI-OSAPA LONDON', branch: 'Lekki' },
  'OSAPA LONDON': { zoneId: 'c91b26e1-2774-48dd-ba3e-1c102e3eb956', zoneName: 'LEKKI-OSAPA LONDON', branch: 'Lekki' },

  // Sangotedo
  'SANGOTEDO': { zoneId: 'aa561227-dcb4-40e4-a66d-3e711c375dcb', zoneName: 'Ajah - Sangotedo', branch: 'Lekki' },

  // Gbagada
  'GBAGADA': { zoneId: '79c94848-354f-46ac-a4b6-006276d5b9c7', zoneName: 'Gbagada (Mainland Store)', branch: 'Mainland' },

  // Ikeja
  'IKEJA': { zoneId: '3bd8bea2-36f9-4b2a-87d5-8ed5613462c8', zoneName: 'Ikeja (Mainland Store)', branch: 'Mainland' },
  'GRA IKEJA': { zoneId: '31e8870e-a56a-4de0-848a-9622fd2ef74c', zoneName: 'Ikeja Gra (Mainland Store)', branch: 'Mainland' },
  'IKEJA GRA': { zoneId: '31e8870e-a56a-4de0-848a-9622fd2ef74c', zoneName: 'Ikeja Gra (Mainland Store)', branch: 'Mainland' },

  // Opebi
  'OPEBI': { zoneId: '0ffff8de-0cfd-4999-b63c-6d0100047fd4', zoneName: 'Opebi ( Mainland Store)', branch: 'Mainland' },

  // Maryland
  'MARYLAND': { zoneId: '6f68fde9-ea12-4c1b-9295-6660231fff3a', zoneName: 'Maryland (Mainland Store)', branch: 'Mainland' },

  // Yaba
  'YABA': { zoneId: '6a3ea9c0-c3b1-4f4c-9b59-14581a2e1970', zoneName: 'Yaba (Mainland Store)', branch: 'Mainland' },
};

// ── Write outputs ─────────────────────────────────────────────────────────────

function main() {
  const rawProducts = JSON.parse(fs.readFileSync(RAW_PRODUCTS, 'utf8'));
  const rawCities = JSON.parse(fs.readFileSync(RAW_CITIES, 'utf8'));

  const cleanedProducts = cleanProducts(rawProducts);
  const cleanedCities = cleanCities(rawCities);

  fs.writeFileSync(
    path.join(SRC, 'products.clean.json'),
    JSON.stringify(cleanedProducts, null, 2)
  );
  console.log('✓ Wrote src/data/products.clean.json');

  fs.writeFileSync(
    path.join(SRC, 'cities.clean.json'),
    JSON.stringify(cleanedCities, null, 2)
  );
  console.log('✓ Wrote src/data/cities.clean.json');

  const aliasMapPath = path.join(SRC, 'alias-map.json');
  if (!fs.existsSync(aliasMapPath)) {
    fs.writeFileSync(aliasMapPath, JSON.stringify(ALIAS_MAP_SEED, null, 2));
    console.log('✓ Wrote src/data/alias-map.json (seed)');
  } else {
    console.log('  alias-map.json already exists, skipping (edit manually to extend)');
  }
}

main();
