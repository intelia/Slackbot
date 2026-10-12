'use strict';

// Shared mutable data store.
// Populated by loader.js on startup from the API.
// Static clean files are optional local fallbacks (not committed to git).

let _products = [];
let _cities   = { namedZones: [], rideHailTiers: [], pickupRows: [] };
let _branches = [];

try { _products = require('./products.clean.json'); } catch (_) {}
try { _cities   = require('./cities.clean.json');   } catch (_) {}

const store = {
  getProducts()          { return _products; },
  getCities()            { return _cities; },
  setData(products, cities) {
    _products = products;
    _cities   = cities;
  },
  getBranches()           { return _branches; },
  setBranches(branches)  { _branches = Array.isArray(branches) ? branches : []; },
  // Resolves a branch display name (e.g. "Lekki") to its Zupa branch UUID.
  // Returns null if branches haven't loaded yet or nothing matches.
  getBranchId(name) {
    if (!name) return null;
    const needle = name.trim().toLowerCase();
    const match = _branches.find(
      (b) => (b.slug || '').toLowerCase() === needle || (b.name || '').toLowerCase() === needle,
    );
    return match ? match.id : null;
  },
};

module.exports = store;
