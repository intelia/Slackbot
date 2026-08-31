'use strict';

// Reminds the app managers to recharge the OpenAI and/or Claude (Anthropic)
// accounts before the current 30-day top-up runs out. Tracking per provider
// starts once someone runs /mark-recharged for it — there's no billing API
// to query, so there's no way to infer a cycle start otherwise.

const cron = require('node-cron');
const { getMetaValue, setMetaValue } = require('../data/db');
const { APP_MANAGER_USER_IDS } = require('../constants');

const SUBSCRIPTION_DAYS = 30;
const REMINDER_WINDOW_DAYS = 3; // start nudging this many days before expiry

const PROVIDERS = {
  openai: { label: 'OpenAI', metaKey: 'openai_subscription_recharged_at' },
  claude: { label: 'Claude (Anthropic)', metaKey: 'anthropic_subscription_recharged_at' },
};

// Accepts user-typed aliases ("openai", "claude", "anthropic") → canonical key.
function resolveProviderKey(raw) {
  const key = (raw || '').trim().toLowerCase();
  if (key === 'openai') return 'openai';
  if (key === 'claude' || key === 'anthropic') return 'claude';
  return null;
}

function lagosToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }); // YYYY-MM-DD
}

function daysBetween(fromDateStr, toDateStr) {
  const from = new Date(`${fromDateStr}T00:00:00Z`);
  const to = new Date(`${toDateStr}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toLocaleDateString('en-CA', { timeZone: 'UTC' });
}

function markRecharged(providerKey, dateStr = lagosToday()) {
  const provider = PROVIDERS[providerKey];
  if (!provider) throw new Error(`Unknown provider: ${providerKey}`);
  setMetaValue(provider.metaKey, dateStr);
  return dateStr;
}

// Returns { rechargedAt, expiresAt, daysRemaining } or null if never recorded.
function getSubscriptionStatus(providerKey) {
  const provider = PROVIDERS[providerKey];
  if (!provider) throw new Error(`Unknown provider: ${providerKey}`);
  const rechargedAt = getMetaValue(provider.metaKey);
  if (!rechargedAt) return null;
  const today = lagosToday();
  const daysUsed = daysBetween(rechargedAt, today);
  const expiresAt = addDays(rechargedAt, SUBSCRIPTION_DAYS);
  const daysRemaining = SUBSCRIPTION_DAYS - daysUsed;
  return { rechargedAt, expiresAt, daysRemaining };
}

// Returns { openai: status|null, claude: status|null }
function getAllSubscriptionStatuses() {
  const out = {};
  for (const key of Object.keys(PROVIDERS)) out[key] = getSubscriptionStatus(key);
  return out;
}

async function notifyAppManagers(client, text) {
  const managerIds = Array.from(APP_MANAGER_USER_IDS);
  const results = await Promise.allSettled(
    managerIds.map((userId) => client.chat.postMessage({ channel: userId, text })),
  );
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(`[subscription] Failed to DM ${managerIds[i]}:`, result.reason?.message || result.reason);
    }
  });
}

async function checkSubscriptionReminder(client) {
  for (const [providerKey, provider] of Object.entries(PROVIDERS)) {
    const status = getSubscriptionStatus(providerKey);
    if (!status) {
      console.log(`[subscription] No recharge date on record for ${provider.label} — run /mark-recharged ${providerKey} after topping up to start tracking.`);
      continue;
    }

    const { daysRemaining, expiresAt } = status;
    if (daysRemaining > REMINDER_WINDOW_DAYS) continue; // not due yet

    const text = daysRemaining > 0
      ? `⚠️ *${provider.label} subscription reminder* — ${daysRemaining} day${daysRemaining === 1 ? '' : 's'} left on the current 30-day recharge (expires ${expiresAt}). Please recharge ${provider.label} for another 30 days, then run \`/mark-recharged ${providerKey}\`.`
      : `🚨 *${provider.label} subscription expired* — the 30-day recharge ended on ${expiresAt}. AI order parsing may stop working. Please recharge ${provider.label} ASAP, then run \`/mark-recharged ${providerKey}\`.`;

    console.log(`[subscription] Sending ${provider.label} recharge reminder — ${daysRemaining} day(s) remaining.`);
    await notifyAppManagers(client, text);
  }
}

function scheduleSubscriptionReminder(client) {
  // 9:00am Lagos daily
  cron.schedule('0 9 * * *', async () => {
    try { await checkSubscriptionReminder(client); } catch (err) { console.error('[subscription] Reminder check failed:', err); }
  }, { timezone: 'Africa/Lagos' });

  console.log('[subscription] Scheduled: daily 9:00am Africa/Lagos OpenAI + Claude recharge check.');
}

// ── Slash commands ────────────────────────────────────────────────────────────

async function handleMarkRechargedCommand({ command, ack, respond }) {
  await ack();

  if (!APP_MANAGER_USER_IDS.has(command.user_id)) {
    await respond({ response_type: 'ephemeral', text: '⚠️ Only app managers can mark an AI subscription as recharged.' });
    return;
  }

  const [rawProvider, rawDate] = (command.text || '').trim().split(/\s+/);
  const providerKey = resolveProviderKey(rawProvider);
  if (!providerKey) {
    await respond({
      response_type: 'ephemeral',
      text: '⚠️ Please specify which provider. Usage: `/mark-recharged openai [YYYY-MM-DD]` or `/mark-recharged claude [YYYY-MM-DD]`',
    });
    return;
  }

  const today = lagosToday();
  let dateStr = today;
  if (rawDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate) || Number.isNaN(new Date(`${rawDate}T00:00:00Z`).getTime())) {
      await respond({ response_type: 'ephemeral', text: '⚠️ Invalid date — use YYYY-MM-DD, e.g. `/mark-recharged openai 2026-08-25`' });
      return;
    }
    if (rawDate > today) {
      await respond({ response_type: 'ephemeral', text: '⚠️ Recharge date can\'t be in the future.' });
      return;
    }
    dateStr = rawDate;
  }

  const provider = PROVIDERS[providerKey];
  markRecharged(providerKey, dateStr);
  const { expiresAt } = getSubscriptionStatus(providerKey);
  const whenLabel = dateStr === today ? `today (${dateStr})` : dateStr;
  await respond({
    response_type: 'in_channel',
    text: `✅ ${provider.label} subscription marked as recharged ${whenLabel} by <@${command.user_id}> — next recharge due by *${expiresAt}*.`,
  });
}

function formatStatusLine(status) {
  if (!status) return '_No recharge date on record yet._';
  const { rechargedAt, expiresAt, daysRemaining } = status;
  const summary = daysRemaining > REMINDER_WINDOW_DAYS
    ? `✅ ${daysRemaining} day(s) remaining.`
    : daysRemaining > 0
      ? `⚠️ Only ${daysRemaining} day(s) remaining — recharge soon.`
      : `🚨 Expired ${Math.abs(daysRemaining)} day(s) ago — recharge ASAP.`;
  return `Last recharged: ${rechargedAt}\nExpires: ${expiresAt}\n${summary}`;
}

async function handleSubscriptionStatusCommand({ command, ack, respond }) {
  await ack();

  const providerKey = resolveProviderKey(command.text);

  if (providerKey) {
    const provider = PROVIDERS[providerKey];
    const status = getSubscriptionStatus(providerKey);
    await respond({
      response_type: 'ephemeral',
      text: `*${provider.label} Subscription Status*\n${formatStatusLine(status)}`,
    });
    return;
  }

  const sections = Object.entries(PROVIDERS).map(([key, provider]) =>
    `*${provider.label}*\n${formatStatusLine(getSubscriptionStatus(key))}`,
  );
  await respond({
    response_type: 'ephemeral',
    text: `*AI Subscription Status*\n\n${sections.join('\n\n')}`,
  });
}

module.exports = {
  markRecharged,
  getSubscriptionStatus,
  getAllSubscriptionStatuses,
  checkSubscriptionReminder,
  scheduleSubscriptionReminder,
  handleMarkRechargedCommand,
  handleSubscriptionStatusCommand,
};
