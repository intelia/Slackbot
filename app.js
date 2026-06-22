'use strict';

require('dotenv').config();
const { createApp } = require('./src/slack/index');
const loader = require('./src/data/loader');

// @slack/socket-mode's finity state machine throws synchronously when Slack
// sends 'server explicit disconnect' in the 'connecting' state — a known SDK
// bug. This prevents that from crashing the process; Bolt's own reconnect
// logic handles the retry. All other uncaught exceptions still exit normally.
process.on('uncaughtException', (err) => {
  if (err.message && err.message.startsWith("Unhandled event '")) {
    console.error('[socket-mode] State machine error (Slack disconnected — will retry):', err.message);
  } else {
    console.error('[fatal] Uncaught exception:', err);
    process.exit(1);
  }
});

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
