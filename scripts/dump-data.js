"use strict";

/**
 * Fetches the live products and cities from the Zupa API and writes them
 * to dump-products.json and dump-cities.json in the project root.
 *
 * Usage:
 *   node scripts/dump-data.js
 *
 * Reads credentials from .env (same as the bot).
 */

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const SystemProducts = require(path.join(__dirname, "..", "systemProducts"));

async function main() {
  console.log("Fetching products…");
  const rawProducts = await SystemProducts.fetchProducts();

  console.log("Fetching cities…");
  const rawCities = await SystemProducts.getDeliveryCities();

  if (!rawProducts || rawProducts.length === 0) {
    console.error(
      "No products returned — check ZUPA_API / ZUPA_API_TOKEN in .env",
    );
    process.exit(1);
  }

  // ── Products ─────────────────────────────────────────────────────────────────

  // Group by category for readability
  const byCategory = {};
  for (const p of rawProducts) {
    const cat = p.category || "Other";
    if (!byCategory[cat]) byCategory[cat] = [];
    const sizes = (p.sizes || [])
      .filter(Boolean)
      .map(
        (s) =>
          `${s.name} — ₦${Number(s.price || 0).toLocaleString("en-NG")} (id: ${s.id})`,
      );
    byCategory[cat].push({ name: p.name, sizes });
  }

  const productOut = path.join(__dirname, "..", "dump-products.json");
  fs.writeFileSync(productOut, JSON.stringify(byCategory, null, 2), "utf8");
  console.log(`✅  ${rawProducts.length} products → ${productOut}`);

  // Also write a flat name-only list (what the AI catalogue sees)
  const catalogueOut = path.join(__dirname, "..", "dump-catalogue.txt");
  const catalogueLines = rawProducts.map((p) => p.name).sort();
  fs.writeFileSync(catalogueOut, catalogueLines.join("\n"), "utf8");
  console.log(`✅  Catalogue (name list only) → ${catalogueOut}`);

  // ── Cities ───────────────────────────────────────────────────────────────────

  if (rawCities && rawCities.length > 0) {
    const cityOut = path.join(__dirname, "..", "dump-cities.json");
    fs.writeFileSync(cityOut, JSON.stringify(rawCities, null, 2), "utf8");
    console.log(`✅  ${rawCities.length} cities → ${cityOut}`);
  } else {
    console.warn("No cities returned.");
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
