'use strict';

// Add a new entry at the TOP whenever a new version is deployed.
// version must be a semver string; notes is an array of short bullet strings.
const CHANGELOG = [
  {
    version: '1.7.0',
    notes: [
      'Pending orders now survive bot restarts — review messages are automatically restored on startup',
      'Restart notification now shows a changelog whenever the bot is updated to a new version',
    ],
  },
  {
    version: '1.6.0',
    notes: [
      'End-of-day summary posts to every channel at 9pm Lagos time with cross-channel user stats',
      '/daily-summary command added for on-demand channel-wide summaries',
      'Bot restart posts a warning so the team knows pending orders may be affected',
    ],
  },
  {
    version: '1.5.0',
    notes: [
      'Pickup location option added to the zone picker modal',
      'AI parser now prevents product substitution (e.g. "fried rice" is never swapped for "jollof rice")',
    ],
  },
  {
    version: '1.4.0',
    notes: [
      'Order confirmation replaced with a full receipt showing all items, totals, customer, and fulfillment details',
      'Unique client reference (GT-YYYYMMDD-XXXXXX) generated for every order and passed to Zupa',
    ],
  },
  {
    version: '1.3.0',
    notes: [
      'Delivery date calendar picker added to the review message — set or change date inline without editing the original text',
    ],
  },
  {
    version: '1.2.0',
    notes: [
      'Mod review now shows matched products as prominent text instead of hiding them inside dropdowns',
      '"Search all products" button added to both add and remove flows in modification review',
    ],
  },
];

const CURRENT_VERSION = CHANGELOG[0].version;

// Returns changelog entries for versions NEWER than `fromVersion`, oldest-first.
// If fromVersion is null/undefined, returns all entries oldest-first (first deploy).
function getChangesSince(fromVersion) {
  if (!fromVersion) return [...CHANGELOG].reverse();
  const fromIdx = CHANGELOG.findIndex(e => e.version === fromVersion);
  // fromIdx === -1 means unknown version (e.g. pre-changelog deploy) → return all
  // fromIdx === 0 means already on latest → nothing to show
  if (fromIdx === 0) return [];
  const cutoff = fromIdx === -1 ? CHANGELOG.length : fromIdx;
  return CHANGELOG.slice(0, cutoff).reverse();
}

module.exports = { CHANGELOG, CURRENT_VERSION, getChangesSince };
