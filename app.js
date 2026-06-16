'use strict';

require('dotenv').config();
const { createApp } = require('./src/slack/index');
const loader = require('./src/data/loader');

(async () => {
  // Fetch live products + cities from Zupa API before starting.
  // Falls back to static clean files if the API is unreachable.
  await loader.init();

  // Refresh data every hour while the bot is running
  setInterval(() => loader.refreshIfStale(), 24 * 60 * 60 * 1000); // check every 24 hours

  const app = createApp();
  const port = parseInt(process.env.PORT || '3000', 10);
  await app.start(port);
  console.log(`⚡ Zupa Order Bot running on port ${port} (Socket Mode)`);
})();
