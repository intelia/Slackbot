'use strict';

// Shared mutable data store.
// Populated by loader.js on startup from the API.
// Static clean files are optional local fallbacks (not committed to git).

let _products = [];
let _cities   = { namedZones: [], rideHailTiers: [], pickupRows: [] };

try { _products = require('./products.clean.json'); } catch (_) {}
try { _cities   = require('./cities.clean.json');   } catch (_) {}

const store = {
  getProducts()          { return _products; },
  getCities()            { return _cities; },
  setData(products, cities) {
    _products = products;
    _cities   = cities;
  },
};

module.exports = store;
