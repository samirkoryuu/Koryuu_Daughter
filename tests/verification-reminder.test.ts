import assert from "node:assert/strict";
import { test } from "node:test";
import {
  processVerificationReminderCampaigns,
  startVerificationReminderCampaign,
  VERIFICATION_REMINDER_MODERATOR_ROLE_ID
} from "../src/verification-reminder.js";
import { makeTestEnv } from "./helpers.js";

const GUILD_ID = "100000000000000010";
const MODERATOR_ID = "100000000000000020";
const UNVERIFIED_ID = "100000000000000030";
const VERIFIED_ID = "100000000000000031";
const BOT_ID = "100000000000000032";
const ORGANIC_ROLE_ID = "1566823723305271428";
const BOT_APPLICATION_ID = "100000000000000090";

function installDiscordMock(): {
  restore: () => void;
  sentMessages: Array<{ channelId: string; body: Record<string, unknown> }>;
  recipients: string[];
} {
  const originalFetch = globalThis.fetch;
  const sentMessages: Array<{ channelId: string; body: Record<string, unknown> }> = [];
  const recipients: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname === `/api/v10/guilds/${GUILD_ID}/roles` && method === "GET") {
      return Response.json([
        { id: GUILD_ID, name: "@everyone", permissions: "0", position: 0, managed: false, hoist: false, mentionable: false, color: 0 },
        { id: VERIFICATION_REMINDER_MODERATOR_ROLE_ID, name: "Moderator", permissions: "0", position: 2, managed: false, hoist: false, mentionable: false, color: 0 },
        { id: ORGANIC_ROLE_ID, name: "100% Organic", permissions: "0", position: 1, managed: false, hoist: false, mentionable: false, color: 0 }
      ]);
    }
    if (url.pathname === `/api/v10/guilds/${GUILD_ID}/members/${MODERATOR_ID}` && method === "GET") {
      return Response.json({
        user: { id: MODERATOR_ID, username: "moderator" },
        roles: [VERIFICATION_REMINDER_MODERATOR_ROLE_ID],
        nick: null
      });
    }
    if (url.pathname === `/api/v10/guilds/${GUILD_ID}/members` && method === "GET") {
      assert.equal(url.searchParams.get("limit"), "100");
      const after = url.searchParams.get("after");
      if (!after) {
        return Response.json([
          { user: { id: UNVERIFIED_ID, username: "unverified", bot: false }, roles: [], nick: null },
          { user: { id: VERIFIED_ID, username: "verified", bot: false }, roles: [ORGANIC_ROLE_ID], nick: null },
          { user: { id: BOT_ID, username: "bot", bot: true }, roles: [], nick: null }
        ]);
      }
      return Response.json([]);
    }
    if (url.pathname === `/api/v10/guilds/${GUILD_ID}/members/${UNVERIFIED_ID}` && method === "GET") {
      return Response.json({
        user: { id: UNVERIFIED_ID, username: "unverified", bot: false },
        roles: [],
        nick: null
      });
    }
    if (url.pathname === `/api/v10/users/@me/channels` && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { recipient_id: string };
      recipients.push(body.recipient_id);
      return Response.json({ id: "100000000000000070" });
    }
    if (url.pathname === `/api/v10/channels/100000000000000070/messages` && method === "POST") {
      sentMessages.push({
        channelId: url.pathname.split("/")[4],
        body: JSON.parse(String(init?.body)) as Record<string, unknown>
      });
      return Response.json({ id: "100000000000000071" });
    }
    return Response.json({ message: `Unexpected Discord request: ${method} ${url.pathname}` }, { status: 500 });
  };
  return {
    restore: () => { globalThis.fetch = originalFetch; },
    sentMessages,
    recipients
  };
}

test("only a member with the configured Moderator role may start a campaign", async () => {
  const { env, database } = makeTestEnv();
  const mock = installDiscordMock();
  try {
    await assert.rejects(
      startVerificationReminderCampaign(env, GUILD_ID, UNVERIFIED_ID),
      /Only a current member with the configured Moderator role/
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM verification_reminder_campaigns").get()?.count, 0);
  } finally {
    mock.restore();
  }
});

test("campaign DMs each current unverified human once with prior and current timestamps", async () => {
  const { env, database } = makeTestEnv();
  const mock = installDiscordMock();
  try {
    env.DB.prepare(
      `INSERT INTO verification_reminder_campaigns(id, guild_id, requested_by, status, created_at, updated_at, result)
       VALUES (?, ?, ?, 'completed', ?, ?, 'Previous campaign')`
    ).bind("prior-campaign", GUILD_ID, MODERATOR_ID, "2026-11-11T08:00:00.000Z", "2026-11-11T08:00:00.000Z").run();
    database.prepare(
      `INSERT INTO verification_reminder_recipients(campaign_id, member_id, status, previous_sent_at, sent_at, next_attempt_at)
       VALUES (?, ?, 'sent', NULL, ?, ?)`
    ).run("prior-campaign", UNVERIFIED_ID, "2026-11-11T08:30:00.000Z", "2026-11-11T08:30:00.000Z");

    const campaign = await startVerificationReminderCampaign(env, GUILD_ID, MODERATOR_ID);
    assert.equal(campaign.alreadyRunning, false);
    await processVerificationReminderCampaigns(env, new Date("2026-11-12T10:00:00.000Z"));

    assert.deepEqual(mock.recipients, [UNVERIFIED_ID]);
    assert.equal(mock.sentMessages.length, 1);
    const content = String(mock.sentMessages[0].body.content);
    assert.match(content, /Last reminder sent: 2026-11-11T08:30:00\.000Z/);
    assert.match(content, /This reminder: 2026-11-12T10:00:00\.000Z/);
    assert.match(content, /100% Organic/);
    assert.match(content, /imgflip\.com\/gif\/b5dv6n/);
    assert.deepEqual(mock.sentMessages[0].body.embeds, [
      { image: { url: "https://i.imgflip.com/b5dv6n.gif" } }
    ]);
    assert.equal(mock.sentMessages[0].body.enforce_nonce, true);
    assert.equal(mock.sentMessages[0].body.allowed_mentions && JSON.stringify(mock.sentMessages[0].body.allowed_mentions), JSON.stringify({ parse: [] }));

    const counts = database.prepare(
      `SELECT
         (SELECT COUNT(*) FROM verification_reminder_recipients WHERE campaign_id = ? AND status = 'sent') AS sent,
         (SELECT COUNT(*) FROM verification_reminder_recipients WHERE campaign_id = ? AND status = 'pending') AS pending,
         (SELECT status FROM verification_reminder_campaigns WHERE id = ?) AS campaign_status`
    ).get(campaign.campaignId, campaign.campaignId, campaign.campaignId) as {
      sent: number;
      pending: number;
      campaign_status: string;
    };
    assert.equal(counts.sent, 1);
    assert.equal(counts.pending, 0);
    assert.equal(counts.campaign_status, "completed");
  } finally {
    mock.restore();
  }
});

test("a second start cannot duplicate an active campaign", async () => {
  const { env } = makeTestEnv();
  const mock = installDiscordMock();
  try {
    const first = await startVerificationReminderCampaign(env, GUILD_ID, MODERATOR_ID);
    const second = await startVerificationReminderCampaign(env, GUILD_ID, MODERATOR_ID);
    assert.equal(second.alreadyRunning, true);
    assert.equal(second.campaignId, first.campaignId);
  } finally {
    mock.restore();
  }
});
