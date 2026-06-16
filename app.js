'use strict';

require('dotenv').config();
const { createApp } = require('./src/slack/index');

(async () => {
  const app = createApp();
  const port = parseInt(process.env.PORT || '3000', 10);
  await app.start(port);
  console.log(`⚡ Zupa Order Bot running on port ${port} (Socket Mode)`);
})();
