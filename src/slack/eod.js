'use strict';

const cron = require('node-cron');
const {
  getAllOrdersToday,
  getOrdersForPeriod,
  getOtpOverridesForPeriod,
  lagosWeekBounds,
  lagosMonthBounds,
  isLastDayOfLagosMonth,
  getMetaValue,
  setMetaValue,
} = require('../data/db');
const { buildDailyReportBlocks, buildWeeklyReportBlocks, buildMonthlyReportBlocks } = require('./blocks');
const { clearExpiredPendingOrders } = require('./handlers');
const { fetchKitchenSummary } = require('../zupa');
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

// ── Date helpers ──────────────────────────────────────────────────────────────

function lagosDateString(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86_400_000)
    .toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }); // YYYY-MM-DD
}

// Returns the day-of-week (0=Sun…6=Sat) for the current Lagos date.
function lagosDow() {
  const [y, m, d] = lagosDateString(0).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function lagosWeekLabel() {
  const [y, m, d] = lagosDateString(0).split('-').map(Number);
  const todayUtc  = new Date(Date.UTC(y, m - 1, d));
  const dow       = todayUtc.getUTCDay();
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  const mondayUtc      = new Date(Date.UTC(y, m - 1, d - daysFromMonday));
  const thursday       = new Date(mondayUtc.getTime() + 3 * 86_400_000);
  const yearStart      = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNum        = Math.ceil((((thursday - yearStart) / 86_400_000) + 1) / 7);
  const endStr         = todayUtc.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
  return `Week ${weekNum}  ·  Ending ${endStr}`;
}

function lagosMonthLabel() {
  const [y, m] = lagosDateString(0).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-NG', { month: 'long', year: 'numeric' });
}

// ── Shared channel-targeting helper ──────────────────────────────────────────

function _resolveTargets(allOrders) {
  const byChannel = new Map();
  for (const order of allOrders) {
    const ch = order._channelId;
    if (!ch) continue;
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch).push(order);
  }
  const targets = byChannel.size > 0
    ? Array.from(byChannel.keys())
    : (process.env.NOTIFY_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
  return { byChannel, targets };
}

// ── Daily Operations Report ───────────────────────────────────────────────────

async function postEodSummaries(client) {
  const allOrders = getAllOrdersToday();
  const dateLabel = new Date().toLocaleDateString('en-NG', {
    timeZone: 'Africa/Lagos', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const today     = lagosDateString(0);
  const yesterday = lagosDateString(-1);

  let kitchenData   = null;
  let yesterdayData = null;
  try {
    [kitchenData, yesterdayData] = await Promise.all([
      fetchKitchenSummary(today, today),
      fetchKitchenSummary(yesterday, yesterday).catch(() => null),
    ]);
  } catch (err) {
    console.error('[eod] Daily kitchen API failed:', err.message);
  }

  if (!kitchenData && allOrders.length === 0) {
    console.log('[eod] No data today — skipping daily report.');
    return;
  }

  const { byChannel, targets } = _resolveTargets(allOrders);
  if (targets.length === 0) { console.log('[eod] No channels for daily report.'); return; }

  console.log(`[eod] Posting daily report to ${targets.length} channel(s).`);
  await Promise.allSettled(targets.map(async channelId => {
    const channelOrders = byChannel.get(channelId) || [];
    await client.chat.postMessage({
      channel: channelId,
      text: `📊 Daily Operations Report — ${dateLabel}`,
      blocks: buildDailyReportBlocks(kitchenData, yesterdayData, channelOrders, dateLabel),
    });
    console.log(`[eod] ✓ Daily posted to ${channelId}`);
  }));

  const cleared = await clearExpiredPendingOrders(client);
  if (cleared > 0) console.log(`[eod] Auto-cleared ${cleared} expired pending order(s).`);
}

// ── Weekly Operations Report ──────────────────────────────────────────────────

async function postWeeklySummary(client) {
  const dow = lagosDow(); // should be 0 (Sunday) when cron fires
  const daysFromMonday = dow === 0 ? 6 : dow - 1;

  // This week: Monday → today (Sunday)
  const thisStart = lagosDateString(-daysFromMonday);
  const thisEnd   = lagosDateString(0);
  // Last week: previous Monday → previous Sunday
  const prevStart = lagosDateString(-daysFromMonday - 7);
  const prevEnd   = lagosDateString(-7);

  const { startMs, endMs } = lagosWeekBounds();
  const allOrders  = getOrdersForPeriod(startMs, endMs);
  const otpOrders  = getOtpOverridesForPeriod(startMs, endMs);
  const periodLabel = lagosWeekLabel();

  let kitchenData = null;
  let prevData    = null;
  try {
    [kitchenData, prevData] = await Promise.all([
      fetchKitchenSummary(thisStart, thisEnd),
      fetchKitchenSummary(prevStart, prevEnd).catch(() => null),
    ]);
  } catch (err) {
    console.error('[eod] Weekly kitchen API failed:', err.message);
  }

  if (!kitchenData && allOrders.length === 0) {
    console.log('[eod] No data for weekly report — skipping.');
    return;
  }

  const { byChannel, targets } = _resolveTargets(allOrders);
  if (targets.length === 0) { console.log('[eod] No channels for weekly report.'); return; }

  console.log(`[eod] Posting weekly report to ${targets.length} channel(s).`);
  await Promise.allSettled(targets.map(async channelId => {
    const channelOrders = byChannel.get(channelId) || [];
    await client.chat.postMessage({
      channel: channelId,
      text: `📊 Weekly Operations Report — ${periodLabel}`,
      blocks: buildWeeklyReportBlocks(kitchenData, prevData, channelOrders, otpOrders, periodLabel),
    });
    console.log(`[eod] ✓ Weekly posted to ${channelId}`);
  }));
}

// ── Monthly Operations Report ─────────────────────────────────────────────────

async function postMonthlySummary(client) {
  if (!isLastDayOfLagosMonth()) return; // guard: only runs on the last day

  const [year, month] = lagosDateString(0).split('-').map(Number);
  const thisStart = `${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-01`;
  const thisEnd   = lagosDateString(0);

  // Last month date range
  const lastMonthDate  = new Date(Date.UTC(year, month - 2, 1));
  const lmy = lastMonthDate.getUTCFullYear();
  const lmm = lastMonthDate.getUTCMonth() + 1;
  const prevStart = `${String(lmy).padStart(4,'0')}-${String(lmm).padStart(2,'0')}-01`;
  const lastDay   = new Date(Date.UTC(year, month - 1, 0)); // day 0 = last day of prev month
  const prevEnd   = lastDay.toLocaleDateString('en-CA', { timeZone: 'UTC' });

  const { startMs, endMs } = lagosMonthBounds();
  const allOrders   = getOrdersForPeriod(startMs, endMs);
  const monthLabel  = lagosMonthLabel();
  const dateLabel   = new Date().toLocaleDateString('en-NG', {
    timeZone: 'Africa/Lagos', day: 'numeric', month: 'long', year: 'numeric',
  });
  const periodLabel = `${monthLabel}  ·  ${dateLabel}`;

  let kitchenData = null;
  let prevData    = null;
  try {
    [kitchenData, prevData] = await Promise.all([
      fetchKitchenSummary(thisStart, thisEnd),
      fetchKitchenSummary(prevStart, prevEnd).catch(() => null),
    ]);
  } catch (err) {
    console.error('[eod] Monthly kitchen API failed:', err.message);
  }

  if (!kitchenData && allOrders.length === 0) {
    console.log('[eod] No data for monthly report — skipping.');
    return;
  }

  const { byChannel, targets } = _resolveTargets(allOrders);
  if (targets.length === 0) { console.log('[eod] No channels for monthly report.'); return; }

  console.log(`[eod] Posting monthly report to ${targets.length} channel(s).`);
  await Promise.allSettled(targets.map(async channelId => {
    const channelOrders = byChannel.get(channelId) || [];
    await client.chat.postMessage({
      channel: channelId,
      text: `📊 Monthly Operations Report — ${monthLabel}`,
      blocks: buildMonthlyReportBlocks(kitchenData, prevData, channelOrders, periodLabel),
    });
    console.log(`[eod] ✓ Monthly posted to ${channelId}`);
  }));
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function scheduleEodSummary(client) {
  // Daily report at 9:00pm
  cron.schedule('0 21 * * *', async () => {
    console.log('[eod] 9:00pm Lagos — running daily report…');
    try { await postEodSummaries(client); } catch (err) { console.error('[eod] Daily report failed:', err); }
  }, { timezone: 'Africa/Lagos' });

  // Weekly report at 9:05pm every Sunday
  cron.schedule('5 21 * * 0', async () => {
    console.log('[eod] 9:05pm Sunday Lagos — running weekly report…');
    try { await postWeeklySummary(client); } catch (err) { console.error('[eod] Weekly report failed:', err); }
  }, { timezone: 'Africa/Lagos' });

  // Monthly report at 9:10pm — fires daily but postMonthlySummary guards on last-day-of-month
  cron.schedule('10 21 * * *', async () => {
    console.log('[eod] 9:10pm Lagos — checking monthly report…');
    try { await postMonthlySummary(client); } catch (err) { console.error('[eod] Monthly report failed:', err); }
  }, { timezone: 'Africa/Lagos' });

  console.log('[eod] Scheduled: daily 9:00pm, weekly (Sun) 9:05pm, monthly (last-day) 9:10pm — all Africa/Lagos.');
}

module.exports = {
  scheduleEodSummary,
  postEodSummaries,
  postWeeklySummary,
  postMonthlySummary,
  postRestartNotification,
};
