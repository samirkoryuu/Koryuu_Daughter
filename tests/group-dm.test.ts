import assert from "node:assert/strict";
import { test } from "node:test";
import {
  processGroupDmCampaigns,
  startGroupDmCampaign
} from "../src/group-dm.js";
import { VERIFICATION_REMINDER_MODERATOR_ROLE_ID } from "../src/verification-reminder.js";
import { makeTestEnv } from "./helpers.js";

const GUILD_ID = "100000000000000010";
const MODERATOR_ID = "100000000000000031";
const MEMBER_ONE = "100000000000000032";
const MEMBER_TWO = "100000000000000033";
const BOT_MEMBER = "100000000000000034";

function installDiscordMock(options: { moderator: boolean }): {
  restore: () => void;
  sentRecipients: string[];
} {
  const originalFetch = globalThis.fetch;
  const sentRecipients: string[] = [];
  let nextDmRecipient = "";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname === `/api/v10/guilds/${GUILD_ID}/roles` && method === "GET") {
      return Response.json([
        { id: GUILD_ID, name: "@everyone" },
        { id: VERIFICATION_REMINDER_MODERATOR_ROLE_ID, name: "Moderator" }
      ]);
    }
    if (url.pathname === `/api/v10/guilds/${GUILD_ID}/members/${MODERATOR_ID}` && method === "GET") {
      return Response.json({
        user: { id: MODERATOR_ID, username: "Moderator" },
        roles: options.moderator ? [VERIFICATION_REMINDER_MODERATOR_ROLE_ID] : [],
        nick: null
      });
    }
    if (url.pathname === `/api/v10/guilds/${GUILD_ID}/members` &&
      url.searchParams.get("limit") === "100" && method === "GET") {
      return Response.json([
        { user: { id: MODERATOR_ID, username: "Moderator", bot: false }, roles: [] },
        { user: { id: MEMBER_ONE, username: "First", bot: false }, roles: [] },
        { user: { id: BOT_MEMBER, username: "Bot", bot: true }, roles: [] }
      ]);
    }
    const memberMatch = new RegExp(`^/api/v10/guilds/${GUILD_ID}/members/(\\d+)$`).exec(url.pathname);
    if (memberMatch && method === "GET") {
      const memberId = memberMatch[1];
      return Response.json({
        user: { id: memberId, username: memberId, bot: memberId === BOT_MEMBER },
        roles: [],
        nick: null
      });
    }
    if (url.pathname === "/api/v10/users/@me/channels" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { recipient_id: string };
      nextDmRecipient = body.recipient_id;
      return Response.json({ id: `2000000000000000${body.recipient_id.slice(-2)}` });
    }
    if (/^\/api\/v10\/channels\/\d+\/messages$/.test(url.pathname) && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { allowed_mentions: unknown };
      assert.deepEqual(body.allowed_mentions, { parse: [] });
      sentRecipients.push(nextDmRecipient);
      return Response.json({ id: "200000000000000099" });
    }
    return Response.json({ message: `Unexpected request ${method} ${url.pathname}` }, { status: 500 });
  };
  return {
    restore: () => { globalThis.fetch = originalFetch; },
    sentRecipients
  };
}

test("only current moderators can queue a group DM", async () => {
  const { env, database } = makeTestEnv();
  const mock = installDiscordMock({ moderator: false });
  try {
    await assert.rejects(
      startGroupDmCampaign(env, GUILD_ID, MODERATOR_ID, {
        allMembers: false,
        recipientUserIds: [MEMBER_ONE, MEMBER_TWO],
        mentionedUserIds: [MEMBER_ONE, MEMBER_TWO],
        everyoneMentioned: false,
        message: "The meeting starts soon."
      }),
      /Moderator role/
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM group_dm_campaigns").get()?.count, 0);
  } finally {
    mock.restore();
  }
});

test("@everyone queues separate DMs to current humans and excludes bots and the requester", async () => {
  const { env, database } = makeTestEnv();
  const mock = installDiscordMock({ moderator: true });
  try {
    const campaign = await startGroupDmCampaign(env, GUILD_ID, MODERATOR_ID, {
      allMembers: true,
      recipientUserIds: [],
      mentionedUserIds: [],
      everyoneMentioned: true,
      message: "The event starts at 8."
    });
    assert.equal(campaign.audience, "everyone");
    assert.equal(campaign.targetCount, null);
    assert.equal(database.prepare("SELECT status FROM group_dm_campaigns WHERE id = ?").get(campaign.campaignId)?.status, "scanning");

    await processGroupDmCampaigns(env, new Date(Date.now() + 60_000));

    assert.deepEqual(mock.sentRecipients, [MEMBER_ONE]);
    assert.equal(database.prepare(
      "SELECT status FROM group_dm_campaigns WHERE id = ?"
    ).get(campaign.campaignId)?.status, "completed");
    assert.equal(database.prepare(
      "SELECT status FROM group_dm_recipients WHERE campaign_id = ? AND member_id = ?"
    ).get(campaign.campaignId, MEMBER_ONE)?.status, "sent");
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM group_dm_recipients WHERE campaign_id = ? AND member_id IN (?, ?)"
    ).get(campaign.campaignId, MODERATOR_ID, BOT_MEMBER)?.count, 0);
  } finally {
    mock.restore();
  }
});

test("moderators can queue individual DMs to multiple explicitly mentioned members", async () => {
  const { env, database } = makeTestEnv();
  const mock = installDiscordMock({ moderator: true });
  try {
    const campaign = await startGroupDmCampaign(env, GUILD_ID, MODERATOR_ID, {
      allMembers: false,
      recipientUserIds: [MEMBER_ONE, MEMBER_TWO],
      mentionedUserIds: [MEMBER_ONE, MEMBER_TWO],
      everyoneMentioned: false,
      message: "The event starts at 8."
    });

    await processGroupDmCampaigns(env, new Date(Date.now() + 60_000));

    assert.deepEqual(mock.sentRecipients, [MEMBER_ONE, MEMBER_TWO]);
    assert.equal(database.prepare(
      "SELECT status FROM group_dm_campaigns WHERE id = ?"
    ).get(campaign.campaignId)?.status, "completed");
  } finally {
    mock.restore();
  }
});

test("group DM recipients must be explicitly mentioned unless @everyone was requested", async () => {
  const { env } = makeTestEnv();
  const mock = installDiscordMock({ moderator: true });
  try {
    await assert.rejects(
      startGroupDmCampaign(env, GUILD_ID, MODERATOR_ID, {
        allMembers: false,
        recipientUserIds: [MEMBER_ONE, MEMBER_TWO],
        mentionedUserIds: [MEMBER_ONE],
        everyoneMentioned: false,
        message: "The meeting starts soon."
      }),
      /explicitly mentioned/
    );
    await assert.rejects(
      startGroupDmCampaign(env, GUILD_ID, MODERATOR_ID, {
        allMembers: true,
        recipientUserIds: [],
        mentionedUserIds: [],
        everyoneMentioned: false,
        message: "The meeting starts soon."
      }),
      /Use @everyone/
    );
  } finally {
    mock.restore();
  }
});
