"use strict";

// Add a new entry at the TOP whenever a new version is deployed.
// version must be a semver string; notes is an array of short bullet strings.
const CHANGELOG = [
  {
    version: "1.11.0",
    notes: [
      "Mark as Complete button added to OTP order confirmation cards — managers can close the receipt linking flow once all receipts are linked or payment was made outside the system (e.g. cash)",
      "Marking complete updates the OTP Slack notification to ✅ Payment complete so managers can track status at a glance",
      "Mark as Complete is restricted to managers only, same as receipt linking",
    ],
  },
  {
    version: "1.10.0",
    notes: [
      "OTP authorize button — managers can approve a payment override directly from the Slack OTP notification without navigating back to the order thread",
      "OTP message status tracking — the OTP notification updates live: shows who authorised, then ⏳ Receipt not yet linked after order is pushed, then 🧾 Receipt linked after a receipt is matched",
      "Thread link in OTP notification — the OTP message includes a direct link back to the order thread (slackThreadLink field sent to Zupa)",
      "Receipt linking restricted to managers — only authorised managers can open the Link Payment Receipt modal on confirmation cards",
    ],
  },
  {
    version: "1.9.0",
    notes: [
      'OTP receipt linking — OTP-confirmed orders now show a "🧾 Link Payment Receipt" button on the confirmation card',
      "Managers can search for a pending receipt by transaction reference or by payer name and amount",
      'After linking, the receipt is shown on the confirmation card and a "Link Another Receipt" button appears for split-payment situations',
      "Receipts are locked via confirm-match so the same receipt cannot be linked to two orders",
    ],
  },
  {
    version: "1.8.1",
    notes: [
      "Combined payment matching — orders paid in two transfers are now detected and both refs sent to Zupa",
      'Amount adjustment — "Adjust Amount" button lets CSRs enter ±difference (max ±₦1,000) when the customer paid slightly more or less than the order total',
      "CSR initials — /set-initial BB Bimbo maps a hashtag initial to a name; the poster is identified from the message and shown on review and confirmation cards",
      "/available command — shows live stock quantities per branch for all products, searchable by name, category, or size",
      "Delivery city change option added to order modifications",
      "Payment verification now required for modifications that increase the order total (difference only)",
    ],
  },
  {
    version: "1.7.0",
    notes: [
      "Pending orders now survive bot restarts — review messages are automatically restored on startup",
      "Restart notification now shows a changelog whenever the bot is updated to a new version",
    ],
  },
  {
    version: "1.6.0",
    notes: [
      "End-of-day summary posts to every channel at 9pm Lagos time with cross-channel user stats",
      "/daily-summary command added for on-demand channel-wide summaries",
      "Bot restart posts a warning so the team knows pending orders may be affected",
    ],
  },
  {
    version: "1.5.0",
    notes: [
      "Pickup location option added to the zone picker modal",
      'AI parser now prevents product substitution (e.g. "fried rice" is never swapped for "jollof rice")',
    ],
  },
  {
    version: "1.4.0",
    notes: [
      "Order confirmation replaced with a full receipt showing all items, totals, customer, and fulfillment details",
      "Unique client reference (GT-YYYYMMDD-XXXXXX) generated for every order and passed to Zupa",
    ],
  },
  {
    version: "1.3.0",
    notes: [
      "Delivery date calendar picker added to the review message — set or change date inline without editing the original text",
    ],
  },
  {
    version: "1.2.0",
    notes: [
      "Mod review now shows matched products as prominent text instead of hiding them inside dropdowns",
      '"Search all products" button added to both add and remove flows in modification review',
    ],
  },
];

const CURRENT_VERSION = CHANGELOG[0].version;

// Returns changelog entries for versions NEWER than `fromVersion`, oldest-first.
// If fromVersion is null/undefined, returns all entries oldest-first (first deploy).
function getChangesSince(fromVersion) {
  if (!fromVersion) return [...CHANGELOG].reverse();
  const fromIdx = CHANGELOG.findIndex((e) => e.version === fromVersion);
  // fromIdx === -1 means unknown version (e.g. pre-changelog deploy) → return all
  // fromIdx === 0 means already on latest → nothing to show
  if (fromIdx === 0) return [];
  const cutoff = fromIdx === -1 ? CHANGELOG.length : fromIdx;
  return CHANGELOG.slice(0, cutoff).reverse();
}

module.exports = { CHANGELOG, CURRENT_VERSION, getChangesSince };
