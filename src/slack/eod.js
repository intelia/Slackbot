'use strict';

const cron = require('node-cron');
const { getAllOrdersToday, getMetaValue, setMetaValue } = require('../data/db');
const { buildDailyReportBlocks } = require('./blocks');
const { fetchKitchenDailySummary } = require('../zupa');
const { CURRENT_VERSION, getChangesSince } = require('../changelog');

// ── Restart / update notification ─────────────────────────────────────────────

async function postRestartNotification(client, restoreResult = { restored: 0, failed: 0 }) {
  const { restored, failed } = restoreResult;

  // Version check — only announce changes when the deployed version changes
  const lastVersion = getMetaValue('last_version');
  const isNewVersion = lastVersion !== CURRENT_VERSION;
  const newVersionEntries = isNewVersion ? getChangesSince(lastVersion) : [];

  if (isNewVersion) {
    setMetaValue('last_version', CURRENT_VERSION);
  }

  // Channels active today + explicit override list
  const todayOrders = getAllOrdersToday();
  const activeToday  = new Set(todayOrders.map(o => o._channelId).filter(Boolean));
  const envChannels  = (process.env.NOTIFY_CHANNELS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const targets = new Set([...activeToday, ...envChannels]);

  if (targets.size === 0) {
    console.log('[startup] No channels to notify (no activity today and NOTIFY_CHANNELS not set).');
    return;
  }

  const restartedAt = new Date().toLocaleString('en-NG', {
    timeZone: 'Africa/Lagos',
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });

  const blocks = [];

  // ── Changelog section (only on version bump) ─────────────────────────────
  if (isNewVersion && newVersionEntries.length > 0) {
    const versionLabel = newVersionEntries.length === 1
      ? `v${newVersionEntries[newVersionEntries.length - 1].version}`
      : `v${newVersionEntries[0].version} → v${newVersionEntries[newVersionEntries.length - 1].version}`;

    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: `🆕  Gourmet Twist Bot updated — ${versionLabel}` },
    });

    for (const entry of newVersionEntries) {
      const noteLines = entry.notes.map(n => `• ${n}`).join('\n');
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: newVersionEntries.length > 1
            ? `*v${entry.version}*\n${noteLines}`
            : noteLines,
        },
      });
    }

    blocks.push({ type: 'divider' });
  }

  // ── Restore status line ───────────────────────────────────────────────────
  let restoreText;
  if (restored === 0 && failed === 0) {
    restoreText = `🔄  *Bot restarted* — ${restartedAt}  ·  No pending orders in queue.`;
  } else {
    const parts = [];
    if (restored > 0) parts.push(`✅  ${restored} pending order${restored !== 1 ? 's' : ''} restored — review messages refreshed.`);
    if (failed > 0)   parts.push(`⚠️  ${failed} order${failed !== 1 ? 's' : ''} could not be restored (message may have been deleted) — please re-submit if needed.`);
    restoreText = `🔄  *Bot restarted* — ${restartedAt}\n${parts.join('\n')}`;
  }

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: restoreText },
  });

  const fallbackText = isNewVersion
    ? `🆕 Bot updated to ${CURRENT_VERSION} at ${restartedAt}. ${restored} order(s) restored.`
    : `🔄 Bot restarted at ${restartedAt}. ${restored} order(s) restored.`;

  const results = await Promise.allSettled(
    Array.from(targets).map(channelId =>
      client.chat.postMessage({ channel: channelId, text: fallbackText, blocks })
        .then(() => console.log(`[startup] ✓ Notification posted to ${channelId}`))
    )
  );

  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      const ch = Array.from(targets)[i];
      console.error(`[startup] ✗ Failed to notify ${ch}:`, result.reason?.message || result.reason);
    }
  }
}

// ── End-of-day summary ────────────────────────────────────────────────────────

function lagosDateString(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86_400_000)
    .toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }); // YYYY-MM-DD
}

async function postEodSummaries(client) {
  const allOrders = getAllOrdersToday();
  const dateLabel = new Date().toLocaleDateString('en-NG', {
    timeZone: 'Africa/Lagos',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  // Fetch kitchen operational data (today + yesterday for comparison)
  let kitchenData    = null;
  let yesterdayData  = null;
  try {
    [kitchenData, yesterdayData] = await Promise.all([
      fetchKitchenDailySummary(lagosDateString(0)),
      fetchKitchenDailySummary(lagosDateString(-1)).catch(() => null),
    ]);
  } catch (err) {
    console.error('[eod] Kitchen summary API failed:', err.message);
  }

  if (!kitchenData && allOrders.length === 0) {
    console.log('[eod] No kitchen data and no orders today — skipping summary posts.');
    return;
  }

  // Group CSR orders by channel
  const byChannel = new Map();
  for (const order of allOrders) {
    const ch = order._channelId;
    if (!ch) continue;
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch).push(order);
  }

  // Post the same operational report to every active channel;
  // CSR section is filtered per channel
  const targets = byChannel.size > 0
    ? Array.from(byChannel.keys())
    : (process.env.NOTIFY_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);

  if (targets.length === 0) {
    console.log('[eod] No channels to post to.');
    return;
  }

  console.log(`[eod] Posting daily report to ${targets.length} channel(s).`);

  const results = await Promise.allSettled(
    targets.map(async channelId => {
      const channelOrders = byChannel.get(channelId) || [];
      const blocks = buildDailyReportBlocks(kitchenData, yesterdayData, channelOrders, dateLabel);
      await client.chat.postMessage({
        channel: channelId,
        text: `📊 Daily Operations Report — ${dateLabel}`,
        blocks,
      });
      console.log(`[eod] ✓ Posted to ${channelId}`);
    })
  );

  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      console.error(`[eod] ✗ Failed to post to ${targets[i]}:`, result.reason?.message || result.reason);
    }
  }
}

function scheduleEodSummary(client) {
  cron.schedule('0 21 * * *', async () => {
    console.log('[eod] 9pm Lagos — running end-of-day summary job…');
    try {
      await postEodSummaries(client);
    } catch (err) {
      console.error('[eod] Summary job failed unexpectedly:', err);
    }
  }, { timezone: 'Africa/Lagos' });

  console.log('[eod] End-of-day summary scheduled for 9:00pm Lagos time (Africa/Lagos).');
}

module.exports = { scheduleEodSummary, postEodSummaries, postRestartNotification };
