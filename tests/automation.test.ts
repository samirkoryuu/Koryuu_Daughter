import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  confirmAutomationRuleChange,
  enqueueAutomationEvent,
  expireTemporaryEffects,
  inspectAutomationRuns,
  listAutomationRules,
  processAutomationEvents,
  stageAutomationRuleChange
} from "../src/automation.js";
import {
  confirmServerChange,
  stageServerChange
} from "../src/discord-server.js";
import { appendChatMessage } from "../src/domain.js";
import { replyWithGroq } from "../src/groq.js";
import worker from "../src/worker.js";
import { makeTestEnv } from "./helpers.js";

const GUILD_ID = "100000000000000010";
const BOT_ID = "100000000000000020";
const MEMBER_ID = "100000000000000030";
const ROLE_ID = "100000000000000040";
const BOT_ROLE_ID = "100000000000000050";
const CHANNEL_ID = "100000000000000060";

function installDiscordMock(groqResponses: unknown[] = []): () => void {
  const originalFetch = globalThis.fetch;
  const assignedRoles = new Set<string>();
  const permissionBits = (1n << 10n) | (1n << 11n) | (1n << 28n) | (1n << 4n);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.groq.com") {
      const response = groqResponses.shift();
      if (!response) return Response.json({ error: "Unexpected Groq request." }, { status: 500 });
      return Response.json(response);
    }
    const path = url.pathname;
    const method = init?.method ?? "GET";
    if (method === "GET" && path === "/api/v10/users/@me") {
      return Response.json({ id: BOT_ID });
    }
    if (method === "GET" && path === `/api/v10/guilds/${GUILD_ID}/roles`) {
      return Response.json([
        { id: GUILD_ID, name: "@everyone", permissions: "0", position: 0, managed: false, hoist: false, mentionable: false, color: 0 },
        { id: ROLE_ID, name: "VIP", permissions: "0", position: 2, managed: false, hoist: false, mentionable: false, color: 0 },
        { id: BOT_ROLE_ID, name: "Koryuu", permissions: permissionBits.toString(), position: 10, managed: false, hoist: false, mentionable: false, color: 0 }
      ]);
    }
    if (method === "GET" && path === `/api/v10/guilds/${GUILD_ID}/channels`) {
      return Response.json([
        { id: CHANNEL_ID, name: "welcome", type: 0, parent_id: null, permission_overwrites: [] }
      ]);
    }
    const memberMatch = new RegExp(`^/api/v10/guilds/${GUILD_ID}/members/([^/]+)$`).exec(path);
    if (method === "GET" && memberMatch) {
      const userId = memberMatch[1];
      return Response.json({
        user: { id: userId, username: userId === BOT_ID ? "Koryuu" : "member", global_name: null },
        roles: userId === BOT_ID ? [BOT_ROLE_ID] : assignedRoles.has(ROLE_ID) ? [ROLE_ID] : [],
        nick: null
      });
    }
    if (method === "PUT" && path === `/api/v10/guilds/${GUILD_ID}/members/${MEMBER_ID}/roles/${ROLE_ID}`) {
      assignedRoles.add(ROLE_ID);
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE" && path === `/api/v10/guilds/${GUILD_ID}/members/${MEMBER_ID}/roles/${ROLE_ID}`) {
      assignedRoles.delete(ROLE_ID);
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path === `/api/v10/channels/${CHANNEL_ID}/messages`) {
      return Response.json({ id: "100000000000000070" });
    }
    if (method === "PUT" && path === `/api/v10/channels/${CHANNEL_ID}/permissions/${ROLE_ID}`) {
      return new Response(null, { status: 204 });
    }
    return Response.json({ message: `Unexpected Discord request: ${method} ${path}` }, { status: 500 });
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("Discord server changes require owner confirmation and are revalidated", async () => {
  const { env, database } = makeTestEnv();
  const restoreFetch = installDiscordMock();
  try {
    await assert.rejects(
      stageServerChange(env, MEMBER_ID, GUILD_ID, {
        operation: "set_channel_overwrite",
        channel_id: CHANNEL_ID,
        target_type: "role",
        target_id: ROLE_ID,
        allow: ["VIEW_CHANNEL"],
        deny: []
      }),
      /configured server owner/
    );
    const staged = await stageServerChange(env, env.LILITH_USER_ID, GUILD_ID, {
      operation: "set_channel_overwrite",
      channel_id: CHANNEL_ID,
      target_type: "role",
      target_id: ROLE_ID,
      allow: ["VIEW_CHANNEL"],
      deny: []
    });
    assert.match(staged.preview, /welcome/);
    await assert.rejects(confirmServerChange(env, MEMBER_ID, staged.id), /configured server owner/);
    const result = await confirmServerChange(env, env.LILITH_USER_ID, staged.id);
    assert.match(result, /VIEW_CHANNEL/);
    assert.equal(
      database.prepare("SELECT status FROM server_change_proposals WHERE id = ?").get(staged.id)?.status,
      "confirmed"
    );
    await assert.rejects(confirmServerChange(env, env.LILITH_USER_ID, staged.id), /expired or was already used/);
  } finally {
    restoreFetch();
  }
});

test("Groq stages server changes privately instead of applying them", async () => {
  const { env, database } = makeTestEnv();
  const text = "Give VIPs access to the welcome channel.";
  await appendChatMessage(env, env.LILITH_USER_ID, "user", text);
  const groqResponses = [
    {
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "server-change-call",
            type: "function",
            function: {
              name: "stage_server_change",
              arguments: JSON.stringify({
                operation: {
                  operation: "set_channel_overwrite",
                  channel_id: CHANNEL_ID,
                  target_type: "role",
                  target_id: ROLE_ID,
                  allow: ["VIEW_CHANNEL"],
                  deny: []
                }
              })
            }
          }]
        }
      }]
    },
    { choices: [{ message: { role: "assistant", content: "Review this change." } }] }
  ];
  const restoreFetch = installDiscordMock(groqResponses);
  try {
    const response = await replyWithGroq(env, env.LILITH_USER_ID, text, false, false, GUILD_ID);
    assert.equal(response.private, true);
    assert.ok(response.pendingAction?.id);
    assert.match(response.reply, /replace the permissions/);
    assert.equal(database.prepare("SELECT status FROM server_change_proposals").get()?.status, "pending");
  } finally {
    restoreFetch();
  }
});

test("automation rules execute generic join events and expire temporary roles", async () => {
  const { env, database } = makeTestEnv();
  const restoreFetch = installDiscordMock();
  try {
    const staged = await stageAutomationRuleChange(env, env.LILITH_USER_ID, GUILD_ID, {
      operation: "create",
      name: "Welcome newcomer",
      trigger_type: "member.join",
      conditions: [],
      actions: [
        { type: "add_role", role_id: ROLE_ID, duration_minutes: 15 },
        { type: "send_message", channel_id: CHANNEL_ID, content: "Welcome {{display_name}}!" }
      ]
    });
    assert.match(staged.preview, /member\.join/);
    await assert.rejects(confirmAutomationRuleChange(env, MEMBER_ID, staged.id), /configured server owner/);
    const confirmation = await confirmAutomationRuleChange(env, env.LILITH_USER_ID, staged.id);
    assert.match(confirmation, /Created and enabled automation/);

    await enqueueAutomationEvent(
      env,
      GUILD_ID,
      "member.join",
      { member_id: MEMBER_ID, username: "member", display_name: "New Member" },
      `member.join:${GUILD_ID}:${MEMBER_ID}:2026-11-06T12:00:00.000Z`
    );
    await processAutomationEvents(env);

    const run = database.prepare("SELECT status FROM automation_runs").get() as { status: string };
    assert.equal(run.status, "completed");
    const effect = database.prepare("SELECT id, status FROM temporary_effects").get() as { id: string; status: string };
    assert.equal(effect.status, "active");
    assert.equal(database.prepare("SELECT status FROM automation_events").get()?.status, "completed");

    database.prepare("UPDATE temporary_effects SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), effect.id);
    await expireTemporaryEffects(env);
    assert.equal(database.prepare("SELECT status FROM temporary_effects WHERE id = ?").get(effect.id)?.status, "expired");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM system_logs WHERE action = 'automation.effect.expired'").get()?.count, 1);
  } finally {
    restoreFetch();
  }
});

test("automation rules can be updated, toggled, and archived through owner confirmation", async () => {
  const { env, database } = makeTestEnv();
  const restoreFetch = installDiscordMock();
  try {
    const create = await stageAutomationRuleChange(env, env.LILITH_USER_ID, GUILD_ID, {
      operation: "create",
      name: "Original rule",
      trigger_type: "member.join",
      conditions: [],
      actions: [{ type: "add_role", role_id: ROLE_ID }]
    });
    await confirmAutomationRuleChange(env, env.LILITH_USER_ID, create.id);
    const ruleId = database.prepare("SELECT id FROM automation_rules").get()?.id as string;
    assert.match(ruleId, /^[0-9a-f-]{36}$/i);

    await assert.rejects(stageAutomationRuleChange(env, MEMBER_ID, GUILD_ID, {
      operation: "set_enabled",
      rule_id: ruleId,
      enabled: false
    }), /configured server owner/);

    const update = await stageAutomationRuleChange(env, env.LILITH_USER_ID, GUILD_ID, {
      operation: "update",
      rule_id: ruleId,
      name: "Updated rule",
      trigger_type: "member.join",
      conditions: [{ field: "username", operator: "contains", value: "guest" }],
      actions: [{ type: "add_role", role_id: ROLE_ID, duration_minutes: 20 }]
    });
    await confirmAutomationRuleChange(env, env.LILITH_USER_ID, update.id);
    assert.equal(database.prepare("SELECT version FROM automation_rules WHERE id = ?").get(ruleId)?.version, 2);

    const disable = await stageAutomationRuleChange(env, env.LILITH_USER_ID, GUILD_ID, {
      operation: "set_enabled",
      rule_id: ruleId,
      enabled: false
    });
    await confirmAutomationRuleChange(env, env.LILITH_USER_ID, disable.id);
    assert.equal(database.prepare("SELECT enabled FROM automation_rules WHERE id = ?").get(ruleId)?.enabled, 0);

    const archive = await stageAutomationRuleChange(env, env.LILITH_USER_ID, GUILD_ID, {
      operation: "delete",
      rule_id: ruleId
    });
    await confirmAutomationRuleChange(env, env.LILITH_USER_ID, archive.id);
    assert.equal(await listAutomationRules(env, GUILD_ID).then(rules => rules.length), 0);
    assert.equal(await inspectAutomationRuns(env, GUILD_ID).then(runs => runs.length), 0);
  } finally {
    restoreFetch();
  }
});

test("purchase records enqueue a generic guild-scoped shop event", async () => {
  const { env, database } = makeTestEnv();
  database.prepare(
    `INSERT INTO shop_storage(unique_id, category, title, description, price_rp, created_by)
     VALUES ('EVENT-ITEM', 'memories', 'Event item', 'Test', 1, ?)`
  ).run(env.LILITH_USER_ID);
  database.prepare("INSERT INTO rp_wallets(user_id, balance) VALUES (?, 5)")
    .run(env.ASTERION_USER_ID);
  database.prepare(
    `INSERT INTO purchases(shop_item_id, unique_id, item_title, price_paid, buyer_id, guild_id)
     VALUES (1, 'EVENT-ITEM', 'Event item', 1, ?, ?)`
  ).run(env.ASTERION_USER_ID, GUILD_ID);
  const event = database.prepare(
    "SELECT event_type, payload, source_event_key FROM automation_events"
  ).get() as { event_type: string; payload: string; source_event_key: string };
  assert.equal(event.event_type, "shop.purchase");
  assert.equal(event.source_event_key, "purchase:1");
  assert.equal(JSON.parse(event.payload).unique_id, "EVENT-ITEM");
});

test("signed Gateway member-join events are validated and deduplicated", async () => {
  const { env, database } = makeTestEnv();
  const payload = JSON.stringify({
    guildId: GUILD_ID,
    memberId: MEMBER_ID,
    username: "new-member",
    displayName: "New Member",
    joinedAt: "2026-11-06T12:00:00.000Z"
  });
  const body = Buffer.from(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const path = "/api/automation/member-join";
  const contentType = "application/json";
  const actorId = env.LILITH_USER_ID;
  const sendEvent = async (): Promise<Response> => {
    const nonce = randomUUID();
    const canonical = `${timestamp}.${nonce}.POST.${path}.${actorId}.${contentType}..`;
    const signature = createHmac("sha256", env.GATEWAY_SHARED_SECRET)
      .update(canonical)
      .update(body)
      .digest("hex");
    return worker.fetch(new Request(`https://koryuu.example${path}`, {
      method: "POST",
      headers: {
        "content-type": contentType,
        "x-koryuu-timestamp": timestamp,
        "x-koryuu-nonce": nonce,
        "x-koryuu-actor": actorId,
        "x-koryuu-signature": signature
      },
      body
    }), env);
  };
  const response = await sendEvent();
  assert.equal(response.status, 200);
  assert.equal((await sendEvent()).status, 200);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM automation_events").get()?.count, 1);
});
