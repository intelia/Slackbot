# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Slack bot (Slack Bolt v3, Socket Mode) that turns raw WhatsApp/Instagram DM order text into structured Zupa orders for Gourmet Twist. Staff paste a raw message via `/parse-order`, the bot parses it with OpenAI + fuzzy matching against the live product/zone catalogue, staff resolve any ambiguous items in a Slack UI, then confirm to push the order to the Zupa API.

## Commands

```bash
npm start              # run the bot (node app.js)
npm run dev             # run with --watch (auto-restart on file change)
npm run clean-data      # regenerate src/data/*.clean.json fallback files from products.json/cities.json
npm run dump-data       # scripts/dump-data.js — dumps live API data for inspection
```

There is no test suite, linter, or build step in this repo — don't invent one when verifying a change; instead run the bot with `npm run dev` and exercise the relevant Slack command/flow manually.

Required env vars (see `.env.example`): `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`, `ZUPA_API`, `ZUPA_API_TOKEN`, `OPENAI_API_KEY`. `.env` / `.env.production` are gitignored — `process.env.ENV === "dev"` switches `MANAGER_USER_IDS` (in `src/constants.js`) to a dev-only Slack user for testing manager-gated flows.

## Architecture

### Data flow: catalogue → parse → resolve → confirm → push

1. **`src/data/loader.js`** fetches live products/cities from the Zupa API (`systemProducts.js`) on startup and every 24h (`app.js`), cleans/normalizes them, and writes them into **`src/data/store.js`** (an in-memory singleton). If the API is unreachable, it falls back to `src/data/*.clean.json` (gitignored, regenerated via `npm run clean-data` from the raw `products.json`/`cities.json` dumps).
2. **`src/parser/ai-segmenter.js`** calls OpenAI to segment the raw pasted text into customer info, fulfillment (pickup/delivery + address), item lines, stated total, and recipient. `src/parser/segmenter.js` and `mod-segmenter.js` handle non-AI/regex-based segmentation paths (e.g. for order modifications).
3. **`src/parser/matcher.js`** fuzzy-matches each item phrase against the product store and matches addresses against delivery zones (including ride-hail tiers, pickup rows, and surge-zone twins).
4. **`src/parser/index.js`** (`parse()`) orchestrates segment → resolve items → reconcile totals (`src/parser/reconciler.js` infers delivery fee/surge from the gap between stated total and items subtotal) and returns a `DraftOrder` with a `status` of `auto_accepted` or `needs_confirmation`, plus a generated `clientReference` (`GT-YYYYMMDD-XXXXXX`).
5. **`src/slack/handlers.js`** (huge — ~3200 lines, one handler per Slack command/action/view) renders the DraftOrder as a Block Kit "Review Order" message (built by **`src/slack/blocks.js`**) and handles every follow-up interaction: resolving ambiguous items, changing zones/dates, payment verification/OTP, order modification, receipt linking, etc. **`src/slack/index.js`** just wires each handler to its Bolt command/action/view/options binding — start there to find which handler owns a given interaction.
6. On confirm, **`src/zupa.js`** (`buildZupaPayload` / `pushToZupa`) converts the internal order shape into the Zupa API payload (`size_id` per item and `zone_id` for fulfillment are the authoritative join keys Zupa consumes — all name fields are display-only) and posts it via `systemProducts.js`.

### Order state persistence (`src/data/db.js`)

A `better-sqlite3` DB (`zupa-orders.db`, gitignored) is the source of truth for order state across bot restarts — there is no in-memory order store beyond what's cached per-request:
- `pending_orders` — unconfirmed review messages in flight; restored to Slack on startup by `restorePendingOrders` (`app.js` → `src/slack/handlers.js`) so a restart doesn't lose an in-progress order.
- `live_orders` — confirmed orders (keyed by `channel:ts`), used for daily/weekly/monthly summaries, duplicate detection, and OTP-override reporting.
- `confirmed_orders` — a hash of the normalized raw message text, used to warn staff when they paste a duplicate order (`parse_anyway`/`cancel_parse` actions).
- `csr_initials` — maps a `#XX` hashtag initial (via `/set-initial`) to a staff name, so orders posted with an initial show who parsed them.
- `bot_meta` — tracks the last-deployed version so restart notifications can show a changelog diff (`src/changelog.js`).

All "day/week/month" boundaries are computed in Africa/Lagos local time (`LAGOS_OFFSET_MS`, fixed UTC+1 — no DST), not server time or UTC.

### Manager-gated flows

`MANAGER_USER_IDS` (`src/constants.js`) gates: OTP payment-override authorization, receipt linking, and marking an OTP order's payment complete. The OTP flow spans multiple Slack surfaces — a DM notification sent to every manager (via `otp_authorize` action) that must all update in sync when any one manager acts (see `_updateOtpMessageStatus` in `handlers.js`), plus the order's own confirmation card in-channel.

### Versioning

Bump `version` in `package.json` and add a matching entry at the top of `CHANGELOG` in `src/changelog.js` whenever shipping a change — `getChangesSince()` diffs against the version stored in `bot_meta` to show what's new in the restart notification. Keep changelog notes user-facing (what staff will notice), not implementation detail.
