import assert from "node:assert/strict";
import { test } from "node:test";
import {
  listCommunityRequests,
  decideDiscountRequest,
  listMinecraftWhitelistQueue,
  submitCommunityRequest,
  updateCommunityRequest
} from "../src/community-requests.js";
import { appendChatMessage } from "../src/domain.js";
import { confirmServerChange, stagePersonalChannelForRequest } from "../src/discord-server.js";
import { replyWithGroq } from "../src/groq.js";
import { makeTestEnv } from "./helpers.js";

const GUILD_ID = "100000000000000010";
const MEMBER_ID = "100000000000000030";

test("requests are saved, privately forwarded to the owner, and visible to submitter/reviewers", async () => {
  const { env, database } = makeTestEnv();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, body });
    if (url.endsWith("/users/@me/channels")) return Response.json({ id: "100000000000000070" });
    if (url.endsWith("/channels/100000000000000070/messages")) return Response.json({ id: "100000000000000071" });
    return Response.json({ message: "Unexpected request." }, { status: 500 });
  };
  try {
    const submitted = await submitCommunityRequest(env, MEMBER_ID, GUILD_ID, {
      category: "professional_service",
      title: "Website project",
      details: "I would like to discuss a small website.",
      service_type: "website"
    });
    assert.equal(submitted.status, "submitted");
    assert.equal(submitted.owner_notified, true);
    assert.match(submitted.summary, /forwarded it to the owner/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.recipient_id, env.LILITH_USER_ID);
    assert.deepEqual(calls[1].body.allowed_mentions, { parse: [] });

    const ownRequests = await listCommunityRequests(env, MEMBER_ID, GUILD_ID);
    assert.equal(ownRequests.length, 1);
    assert.equal((ownRequests[0] as { id: string }).id, submitted.id);
    assert.equal((await listCommunityRequests(env, "100000000000000031", GUILD_ID)).length, 0);

    const reviewer = await updateCommunityRequest(env, env.LILITH_USER_ID, {
      request_id: submitted.id,
      status: "negotiating",
      outcome: "Discussing timeline and scope."
    });
    assert.equal(reviewer.status, "negotiating");
    assert.equal(reviewer.outcome, "Discussing timeline and scope.");
    assert.equal(reviewer.submitter_notified, true);
    assert.equal((await listCommunityRequests(env, env.LILITH_USER_ID, GUILD_ID)).length, 1);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM community_request_events WHERE request_id = ?"
    ).get(submitted.id)?.count, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Groq collects a natural-language request and marks its result private", async () => {
  const { env, database } = makeTestEnv();
  const text = "I want to request a website project.";
  await appendChatMessage(env, MEMBER_ID, "user", text);
  const originalFetch = globalThis.fetch;
  const modelResponses: unknown[] = [
    {
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "request-call",
            type: "function",
            function: {
              name: "submit_community_request",
              arguments: JSON.stringify({
                category: "professional_service",
                title: "Website project",
                details: "I would like to discuss a small website.",
                service_type: "website"
              })
            }
          }]
        }
      }]
    },
    { choices: [{ message: { role: "assistant", content: "Your request was forwarded privately." } }] }
  ];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("api.groq.com")) {
      const response = modelResponses.shift();
      return Response.json(response);
    }
    if (url.endsWith("/users/@me/channels")) return Response.json({ id: "100000000000000070" });
    if (url.endsWith("/channels/100000000000000070/messages")) return Response.json({ id: "100000000000000071" });
    return Response.json({ message: "Unexpected request." }, { status: 500 });
  };
  try {
    const result = await replyWithGroq(env, MEMBER_ID, text, false, false, GUILD_ID);
    assert.equal(result.private, true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM community_requests").get()?.count, 1);
    assert.equal(database.prepare("SELECT category FROM community_requests").get()?.category, "professional_service");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("complaints resolve mentioned server members to verified Discord IDs", async () => {
  const { env, database } = makeTestEnv();
  const submitterId = "100000000000000032";
  const channelId = "100000000000000040";
  const originalFetch = globalThis.fetch;
  const modelResponses: unknown[] = [
    {
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "complaint-call",
            type: "function",
            function: {
              name: "submit_community_request",
              arguments: JSON.stringify({
                category: "complaint",
                title: "Repeated disruption",
                details: "The member repeatedly disrupted the discussion."
              })
            }
          }]
        }
      }]
    },
    { choices: [{ message: { role: "assistant", content: "I forwarded your complaint privately." } }] }
  ];
  const apiCalls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    apiCalls.push({ path: url.pathname, body });
    if (url.hostname === "api.groq.com") return Response.json(modelResponses.shift());
    if (url.pathname === `/api/v10/guilds/${GUILD_ID}/members/${MEMBER_ID}`) {
      return Response.json({
        user: { id: MEMBER_ID, username: "target", global_name: "Target Member" },
        roles: [],
        nick: null
      });
    }
    if (url.pathname === `/api/v10/guilds/${GUILD_ID}/roles`) {
      return Response.json([{
        id: GUILD_ID,
        name: "@everyone",
        permissions: "0",
        position: 0,
        managed: false,
        hoist: false,
        mentionable: false,
        color: 0
      }]);
    }
    if (url.pathname === "/api/v10/users/@me/channels") return Response.json({ id: "100000000000000070" });
    if (url.pathname === "/api/v10/channels/100000000000000070/messages") return Response.json({ id: "100000000000000071" });
    return Response.json({ message: `Unexpected request ${url.pathname}` }, { status: 500 });
  };
  try {
    const result = await replyWithGroq(
      env,
      submitterId,
      `Please file a complaint about <@${MEMBER_ID}>.`,
      false,
      false,
      GUILD_ID,
      {
        guildId: GUILD_ID,
        mentionedUsers: [{ id: MEMBER_ID, displayName: "Target Member" }],
        recentMessages: [],
        recentMessagesUnavailable: false,
        channelId
      }
    );
    assert.equal(result.private, true);
    const saved = database.prepare("SELECT involved_people FROM community_requests WHERE category = 'complaint'").get() as { involved_people: string };
    assert.deepEqual(JSON.parse(saved.involved_people), [MEMBER_ID]);
    const notification = apiCalls.find(call => call.path === "/api/v10/channels/100000000000000070/messages");
    assert.match(String(notification?.body?.content), /Target Member/);
    assert.match(String(notification?.body?.content), new RegExp(MEMBER_ID));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request intake enforces category-specific minimum information and never loses failed forwarding", async () => {
  const { env, database } = makeTestEnv();
  await assert.rejects(submitCommunityRequest(env, MEMBER_ID, GUILD_ID, {
    category: "complaint",
    title: "A complaint",
    details: "I need help with an incident.",
    involved_people: []
  }), /Mention the member/);
  await assert.rejects(submitCommunityRequest(env, MEMBER_ID, GUILD_ID, {
    category: "personal_channel",
    title: "Personal channel",
    details: "I gathered people.",
    partner_ids: ["100000000000000041", "100000000000000042"]
  }), /at least three gathered/);
  await assert.rejects(submitCommunityRequest(env, MEMBER_ID, GUILD_ID, {
    category: "discount",
    title: "Discount request",
    details: "Please consider a discount.",
    requested_discount_percent: 50
  }), /between 10 and 35/);
  await assert.rejects(submitCommunityRequest(env, MEMBER_ID, GUILD_ID, {
    category: "minecraft_access",
    title: "Minecraft access",
    details: "I want to join.",
    partner_ids: []
  }), /at least one partner/);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ message: "DMs unavailable." }, { status: 403 });
  try {
    const submitted = await submitCommunityRequest(env, MEMBER_ID, GUILD_ID, {
      category: "suggestion",
      title: "Add a book club",
      details: "A monthly book club might be fun."
    });
    assert.equal(submitted.owner_notified, false);
    assert.match(submitted.summary, /notification failed/);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM community_requests WHERE id = ?"
    ).get(submitted.id)?.count, 1);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM community_request_events WHERE request_id = ? AND event_type = 'notification_failed'"
    ).get(submitted.id)?.count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("staff applications require complete details and cannot be approved before three observed activity days", async () => {
  const { env, database } = makeTestEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    if (String(input).endsWith("/users/@me/channels")) return Response.json({ id: "100000000000000070" });
    if (String(input).endsWith("/channels/100000000000000070/messages")) return Response.json({ id: "100000000000000071" });
    return Response.json({ message: "Unexpected request." }, { status: 500 });
  };
  try {
    await assert.rejects(submitCommunityRequest(env, MEMBER_ID, GUILD_ID, {
      category: "staff_application",
      title: "Moderator application",
      details: "I would like to help."
    }), /experience, motivation, intended responsibilities, and an activity summary/);

    const submitted = await submitCommunityRequest(env, MEMBER_ID, GUILD_ID, {
      category: "staff_application",
      title: "Moderator application",
      details: "I would like to help keep the community welcoming.",
      experience: "I have helped moderate another community.",
      motivation: "I want to support new members.",
      responsibilities: "I can help with reports and onboarding.",
      activity_summary: "I have been active in the server."
    });
    await assert.rejects(updateCommunityRequest(env, env.LILITH_USER_ID, {
      request_id: submitted.id,
      status: "approved"
    }), /observed activity on 0 of the required 3 days/);

    for (const activityDate of ["2026-11-06", "2026-11-07", "2026-11-08"]) {
      database.prepare(
        `INSERT INTO community_member_activity_days(guild_id, member_id, activity_date, first_seen_at)
         VALUES (?, ?, ?, ?)`
      ).run(GUILD_ID, MEMBER_ID, activityDate, `${activityDate}T12:00:00.000Z`);
    }
    const result = await updateCommunityRequest(env, env.LILITH_USER_ID, {
      request_id: submitted.id,
      status: "approved",
      outcome: "Minimum observed activity days met; reviewed by owner."
    });
    assert.equal(result.status, "approved");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("approved Minecraft requests are transactionally queued for the external whitelist worker", async () => {
  const { env, database } = makeTestEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    if (String(input).endsWith("/users/@me/channels")) return Response.json({ id: "100000000000000070" });
    if (String(input).endsWith("/channels/100000000000000070/messages")) return Response.json({ id: "100000000000000071" });
    return Response.json({ message: "Unexpected request." }, { status: 500 });
  };
  try {
    const submitted = await submitCommunityRequest(env, MEMBER_ID, GUILD_ID, {
      category: "minecraft_access",
      title: "Minecraft access",
      details: "Please add me to the server.",
      minecraft_username: "BuilderSam",
      partner_ids: ["100000000000000041"]
    });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM minecraft_whitelist_queue").get()?.count, 0);

    const approved = await updateCommunityRequest(env, env.LILITH_USER_ID, {
      request_id: submitted.id,
      status: "approved",
      outcome: "Approved for whitelist processing."
    });
    assert.equal(approved.minecraft_whitelist_queued, true);
    const jobs = await listMinecraftWhitelistQueue(env, env.LILITH_USER_ID, GUILD_ID) as Array<{
      request_id: string;
      discord_user_id: string;
      minecraft_username: string;
      partner_ids: string[];
      status: string;
    }>;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].request_id, submitted.id);
    assert.equal(jobs[0].discord_user_id, MEMBER_ID);
    assert.equal(jobs[0].minecraft_username, "BuilderSam");
    assert.deepEqual(jobs[0].partner_ids, ["100000000000000041"]);
    assert.equal(jobs[0].status, "queued");

    await updateCommunityRequest(env, env.LILITH_USER_ID, {
      request_id: submitted.id,
      status: "declined",
      outcome: "Application declined before whitelist processing."
    });
    assert.equal(database.prepare(
      "SELECT status FROM minecraft_whitelist_queue WHERE request_id = ?"
    ).get(submitted.id)?.status, "cancelled");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("only authorized reviewers can update requests or view other users' queue", async () => {
  const { env } = makeTestEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    if (String(input).endsWith("/users/@me/channels")) return Response.json({ id: "100000000000000070" });
    if (String(input).endsWith("/channels/100000000000000070/messages")) return Response.json({ id: "100000000000000071" });
    return Response.json({ message: "Unexpected request." }, { status: 500 });
  };
  try {
    const submitted = await submitCommunityRequest(env, MEMBER_ID, GUILD_ID, {
      category: "important_information",
      title: "Notice",
      details: "A relevant detail."
    });
    await assert.rejects(updateCommunityRequest(env, "100000000000000031", {
      request_id: submitted.id,
      status: "approved"
    }), /authorized reviewer/);
    assert.equal((await listCommunityRequests(env, "100000000000000031", GUILD_ID)).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discount offers can only be decided by the owner and are recorded as offers, not checkout changes", async () => {
  const { env, database } = makeTestEnv();
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async input => {
    calls.push(String(input));
    if (String(input).endsWith("/users/@me/channels")) return Response.json({ id: "100000000000000070" });
    if (String(input).endsWith("/channels/100000000000000070/messages")) return Response.json({ id: "100000000000000071" });
    return Response.json({ message: "Unexpected request." }, { status: 500 });
  };
  try {
    const submitted = await submitCommunityRequest(env, MEMBER_ID, GUILD_ID, {
      category: "discount",
      title: "Rank discount",
      details: "I helped with community events and moderation.",
      contribution: "Helped run events for six months.",
      target_service: "Supporter rank",
      requested_discount_percent: 25
    });
    await assert.rejects(decideDiscountRequest(env, "100000000000000031", {
      request_id: submitted.id,
      approved_percent: 20,
      decision_note: "Thank you for contributing."
    }), /configured owner/);
    const result = await decideDiscountRequest(env, env.LILITH_USER_ID, {
      request_id: submitted.id,
      approved_percent: 20,
      decision_note: "Approved for the supporter rank based on prior event contributions."
    });
    assert.equal(result.status, "approved");
    assert.equal(result.approved_percent, 20);
    assert.equal(result.submitter_notified, true);
    assert.equal(database.prepare(
      "SELECT requested_percent FROM community_discount_decisions WHERE request_id = ?"
    ).get(submitted.id)?.requested_percent, 25);
    assert.equal(database.prepare(
      "SELECT approved_percent FROM community_discount_decisions WHERE request_id = ?"
    ).get(submitted.id)?.approved_percent, 20);
    assert.equal(database.prepare(
      "SELECT status FROM community_requests WHERE id = ?"
    ).get(submitted.id)?.status, "approved");
    assert.equal(calls.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("personal channels require approval and are created privately for the applicant and partners", async () => {
  const { env, database } = makeTestEnv();
  const partnerIds = ["100000000000000041", "100000000000000042", "100000000000000043"];
  const botId = "100000000000000020";
  const botRoleId = "100000000000000050";
  const channelId = "100000000000000080";
  const originalFetch = globalThis.fetch;
  let createBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/v10/users/@me") return Response.json({ id: botId });
    if (method === "GET" && path === `/api/v10/guilds/${GUILD_ID}/roles`) {
      return Response.json([
        { id: GUILD_ID, name: "@everyone", permissions: "0", position: 0, managed: false, hoist: false, mentionable: false, color: 0 },
        { id: botRoleId, name: "Koryuu", permissions: String(1n << 4n), position: 10, managed: false, hoist: false, mentionable: false, color: 0 }
      ]);
    }
    if (method === "GET" && path === `/api/v10/guilds/${GUILD_ID}/channels`) {
      return Response.json([{ id: "100000000000000060", name: "welcome", type: 0, parent_id: null, permission_overwrites: [] }]);
    }
    if (method === "GET" && new RegExp(`^/api/v10/guilds/${GUILD_ID}/members/\\d+$`).test(path)) {
      const memberId = path.split("/").pop();
      return Response.json({
        user: { id: memberId, username: "member", global_name: null },
        roles: memberId === botId ? [botRoleId] : [],
        nick: null
      });
    }
    if (method === "POST" && path === `/api/v10/guilds/${GUILD_ID}/channels`) {
      createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        id: channelId,
        name: createBody.name,
        type: 0,
        parent_id: null,
        permission_overwrites: createBody.permission_overwrites
      });
    }
    if (path.endsWith("/users/@me/channels")) return Response.json({ id: "100000000000000070" });
    if (path.endsWith("/channels/100000000000000070/messages")) return Response.json({ id: "100000000000000071" });
    return Response.json({ message: "Unexpected Discord request." }, { status: 500 });
  };
  try {
    const submitted = await submitCommunityRequest(env, MEMBER_ID, GUILD_ID, {
      category: "personal_channel",
      title: "Study Group",
      details: "A private study group channel.",
      partner_ids: partnerIds
    });
    await assert.rejects(
      stagePersonalChannelForRequest(env, env.LILITH_USER_ID, GUILD_ID, submitted.id),
      /approved personal-channel request/
    );
    await updateCommunityRequest(env, env.LILITH_USER_ID, {
      request_id: submitted.id,
      status: "approved",
      outcome: "Approved for channel provisioning."
    });
    const staged = await stagePersonalChannelForRequest(env, env.LILITH_USER_ID, GUILD_ID, submitted.id);
    assert.match(staged.preview, /@everyone will be denied View Channel/);
    await confirmServerChange(env, env.LILITH_USER_ID, staged.id);
    assert.equal(createBody?.name, "personal-study-group");
    const overwrites = createBody?.permission_overwrites as Array<{ id: string; allow: string; deny: string }>;
    assert.equal(overwrites[0].id, GUILD_ID);
    assert.equal(BigInt(overwrites[0].deny) & (1n << 10n), 1n << 10n);
    assert.equal(overwrites.length, 6);
    assert.equal(database.prepare("SELECT status FROM community_requests WHERE id = ?").get(submitted.id)?.status, "in_progress");
    assert.match(String(database.prepare("SELECT outcome FROM community_requests WHERE id = ?").get(submitted.id)?.outcome), new RegExp(channelId));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
