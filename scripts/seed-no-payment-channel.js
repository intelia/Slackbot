"use strict";

/**
 * Seeds (or removes) a payment-exempt channel directly in the local DB —
 * this is deliberately not a runtime Slack command. Which channel(s) skip
 * payment verification/OTP entirely is a one-time setup decision for a
 * specific dedicated channel, not something meant to be toggled casually
 * by anyone with Slack access.
 *
 * Usage:
 *   npm run seed-no-payment-channel -- add <channelId> ["channel name"]
 *   npm run seed-no-payment-channel -- remove <channelId>
 *   npm run seed-no-payment-channel -- list
 *
 * Find a channel's ID in Slack via its channel details ("Copy channel ID"),
 * or from the URL when viewing it in a browser (.../C0123456789).
 */

const {
  setNoPaymentChannel,
  removeNoPaymentChannel,
  isNoPaymentChannel,
  getAllNoPaymentChannels,
} = require("../src/data/db");

function usageAndExit() {
  console.error(
    "Usage:\n" +
      "  npm run seed-no-payment-channel -- add <channelId> [\"channel name\"]\n" +
      "  npm run seed-no-payment-channel -- remove <channelId>\n" +
      "  npm run seed-no-payment-channel -- list",
  );
  process.exit(1);
}

function main() {
  const [action, channelId, ...rest] = process.argv.slice(2);

  if (action === "list") {
    const all = getAllNoPaymentChannels();
    if (all.length === 0) {
      console.log("No payment-exempt channels configured.");
      return;
    }
    for (const row of all) {
      console.log(
        `${row.channel_id}${row.channel_name ? `  (#${row.channel_name})` : ""}  — set by ${row.set_by || "unknown"}`,
      );
    }
    return;
  }

  if (!channelId || !/^[CDG][A-Z0-9]+$/i.test(channelId)) {
    console.error(`⚠️  "${channelId || ""}" doesn't look like a Slack channel ID (expected something like C0123456789).\n`);
    usageAndExit();
  }

  if (action === "add") {
    const channelName = rest.join(" ").trim() || null;
    setNoPaymentChannel(channelId, channelName, "seed-script");
    console.log(
      `✅ ${channelId}${channelName ? ` (#${channelName})` : ""} is now exempt from payment verification/OTP.`,
    );
    return;
  }

  if (action === "remove") {
    const removed = removeNoPaymentChannel(channelId);
    console.log(
      removed
        ? `✅ ${channelId} is no longer exempt.`
        : `${channelId} wasn't marked exempt.`,
    );
    return;
  }

  usageAndExit();
}

main();
