'use strict';

// Shared mutable data store.
// Seeded from static clean files on first require; refreshed by loader.js after API fetch.

let _products = require('./products.clean.json');
let _cities   = require('./cities.clean.json');

const store = {
  getProducts()          { return _products; },
  getCities()            { return _cities; },
  setData(products, cities) {
    _products = products;
    _cities   = cities;
  },
};

module.exports = store;
