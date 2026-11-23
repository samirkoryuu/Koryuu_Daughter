import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { test } from "node:test";
import { closeAdminTicket, cleanupExpiredAdminTickets, createAdminTicket } from "../src/admin-ticket.js";
import { hasActiveAdminTicket } from "../src/domain.js";
import worker from "../src/worker.js";
import { makeTestEnv } from "./helpers.js";

const guildId = "200000000000000001";
const userId = "200000000000000002";
const botId = "200000000000000003";
const markerRoleId = "200000000000000004";
const channelId = "200000000000000005";

interface ApiCall {
  path: string;
  method: string;
  body?: Record<string, unknown>;
  authorization: string | null;
}

async function withDiscordMock<T>(run: (calls: ApiCall[]) => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  const calls: ApiCall[] = [];
  globalThis.fetch = async (input, init): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({
      path: url.pathname,
      method,
      body,
      authorization: new Headers(init?.headers).get("authorization")
    });

    if (url.pathname === "/api/v10/users/@me") return Response.json({ id: botId });
    if (url.pathname === `/api/v10/guilds/${guildId}/roles` && method === "GET") {
      return Response.json([{ id: guildId }, { id: "200000000000000006" }]);
    }
    if (url.pathname === `/api/v10/guilds/${guildId}/roles` && method === "POST") {
      return Response.json({ id: markerRoleId });
    }
    if (method === "PUT" || method === "DELETE") return new Response(null, { status: 204 });
    if (url.pathname === `/api/v10/guilds/${guildId}/channels` && method === "POST") {
      return Response.json({ id: channelId });
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`Unexpected Discord API request: ${method} ${url.pathname}`);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("admin ticket provisions a no-permissions marker and an owner-only private channel", async () => {
  const { env, database } = makeTestEnv();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  await withDiscordMock(async calls => {
    assert.equal(await createAdminTicket(env, guildId, userId, expiresAt), channelId);
    const roleCall = calls.find(call => call.method === "POST" && call.path.endsWith("/roles"));
    assert.equal(roleCall?.body?.name, "creator15");
    assert.equal(roleCall?.body?.permissions, "0");

    const channelCall = calls.find(call => call.method === "POST" && call.path.endsWith("/channels"));
    const overwrites = channelCall?.body?.permission_overwrites as Array<{
      id: string;
      type: number;
      allow: string;
      deny: string;
    }>;
    assert.ok(overwrites.some(overwrite =>
      overwrite.id === guildId && overwrite.type === 0 && overwrite.deny === "1024"
    ));
    assert.ok(overwrites.some(overwrite =>
      overwrite.id === markerRoleId && overwrite.type === 0 && overwrite.deny === "1024"
    ));
    assert.ok(overwrites.some(overwrite =>
      overwrite.id === userId && overwrite.type === 1 && overwrite.allow === "68608"
    ));
    assert.ok(overwrites.some(overwrite =>
      overwrite.id === botId && overwrite.type === 1 && overwrite.allow === "68608"
    ));
    assert.ok(calls.every(call => call.authorization === "Bot test-bot-token"));
    assert.equal(database.prepare("SELECT channel_id FROM temporary_admin_access WHERE user_id = ?")
      .get(userId)?.channel_id, channelId);
  });
});

test("admin ticket access requires the matching user, guild, channel, and active session", async () => {
  const { env } = makeTestEnv();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await env.DB.prepare("INSERT INTO admin_sessions(user_id, expires_at, created_at) VALUES (?, ?, ?)")
    .bind(userId, expiresAt, new Date().toISOString()).run();
  await env.DB.prepare(
    `INSERT INTO temporary_admin_access(user_id, guild_id, role_id, channel_id, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(userId, guildId, markerRoleId, channelId, expiresAt).run();

  assert.equal(await hasActiveAdminTicket(env, userId, guildId, channelId), true);
  assert.equal(await hasActiveAdminTicket(env, userId, guildId, "200000000000000099"), false);
  assert.equal(await hasActiveAdminTicket(env, "200000000000000008", guildId, channelId), false);

  await env.DB.prepare("DELETE FROM admin_sessions WHERE user_id = ?").bind(userId).run();
  assert.equal(await hasActiveAdminTicket(env, userId, guildId, channelId), false);
});

test("expired tickets delete channel and role, while logout closes an active ticket", async () => {
  const { env, database } = makeTestEnv();
  await env.DB.prepare(
    `INSERT INTO temporary_admin_access(user_id, guild_id, role_id, channel_id, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(userId, guildId, markerRoleId, channelId, "2000-01-01T00:00:00.000Z").run();

  await withDiscordMock(async calls => {
    await cleanupExpiredAdminTickets(env);
    assert.deepEqual(
      calls.filter(call => call.method === "DELETE").map(call => call.path),
      [
        `/api/v10/guilds/${guildId}/channels/${channelId}`,
        `/api/v10/guilds/${guildId}/members/${userId}/roles/${markerRoleId}`,
        `/api/v10/guilds/${guildId}/roles/${markerRoleId}`
      ]
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM temporary_admin_access").get()?.count, 0);
  });

  await env.DB.prepare(
    `INSERT INTO temporary_admin_access(user_id, guild_id, role_id, channel_id, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(userId, guildId, markerRoleId, channelId, new Date(Date.now() + 60_000).toISOString()).run();
  await withDiscordMock(async calls => {
    await closeAdminTicket(env, userId);
    assert.equal(calls.filter(call => call.method === "DELETE").length, 3);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM temporary_admin_access").get()?.count, 0);
  });
});

test("Worker recognizes the authenticated user in their exact ticket channel", async () => {
  const { env, database } = makeTestEnv();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await env.DB.prepare("INSERT INTO admin_sessions(user_id, expires_at, created_at) VALUES (?, ?, ?)")
    .bind(userId, expiresAt, new Date().toISOString()).run();
  await env.DB.prepare(
    `INSERT INTO temporary_admin_access(user_id, guild_id, role_id, channel_id, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(userId, guildId, markerRoleId, channelId, expiresAt).run();

  const originalFetch = globalThis.fetch;
  const modelRequests: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    modelRequests.push(body);
    const messages = body.messages as Array<{ role: string }>;
    if (messages.some(message => message.role === "tool")) {
      return Response.json({ choices: [{ message: { role: "assistant", content: "The private admin preview is ready." } }] });
    }
    return Response.json({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "ticket-call",
            type: "function",
            function: {
              name: "stage_admin_change",
              arguments: JSON.stringify({
                operation: "add_knowledge",
                scope: "general",
                title: "Ticket integration",
                content: "Only the authorized ticket user may stage this."
              })
            }
          }]
        }
      }]
    });
  };

  try {
    const input = {
      actorId: userId,
      text: "Add this fact.",
      isDm: false,
      guildId,
      channelId
    };
    const body = Buffer.from(JSON.stringify(input));
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID();
    const path = "/api/chat";
    const contentType = "application/json";
    const canonical = `${timestamp}.${nonce}.POST.${path}.${userId}.${contentType}..`;
    const signature = createHmac("sha256", env.GATEWAY_SHARED_SECRET)
      .update(canonical)
      .update(body)
      .digest("hex");
    const response = await worker.fetch(new Request(`https://koryuu.example${path}`, {
      method: "POST",
      headers: {
        "content-type": contentType,
        "x-koryuu-timestamp": timestamp,
        "x-koryuu-nonce": nonce,
        "x-koryuu-actor": userId,
        "x-koryuu-signature": signature
      },
      body
    }), env);

    assert.equal(response.status, 200);
    const result = await response.json() as { reply: string; pendingAction?: { id: string } };
    assert.ok(result.pendingAction);
    assert.match(result.reply, /Confirm only if these exact details are correct/);
    const system = (modelRequests[0].messages as Array<{ role: string; content: string }>)
      .find(message => message.role === "system");
    assert.match(system?.content ?? "", /active, verified administrator session in a private context/);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pending_actions WHERE action_type = 'admin'").get()?.count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Worker immediately defers admin modal submission and privately reports ticket setup", async () => {
  const { env, database } = makeTestEnv();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  env.DISCORD_PUBLIC_KEY = publicDer.subarray(publicDer.length - 32).toString("hex");
  env.ADMIN_PASSWORD_SHA256 = createHash("sha256").update("secure-test-password").digest("hex");
  const interaction = {
    id: "200000000000000010",
    application_id: "200000000000000011",
    token: "interaction-secret-test-token",
    type: 5,
    guild_id: guildId,
    member: { user: { id: userId } },
    data: {
      custom_id: "koryuu_admin_auth",
      components: [{ components: [{ custom_id: "password", value: "secure-test-password" }] }]
    }
  };
  const body = JSON.stringify(interaction);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = sign(null, Buffer.from(`${timestamp}${body}`), privateKey).toString("hex");
  const originalFetch = globalThis.fetch;
  const calls: ApiCall[] = [];
  globalThis.fetch = async (input, init): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const requestBody = init?.body
      ? JSON.parse(String(init.body)) as Record<string, unknown>
      : undefined;
    calls.push({
      path: url.pathname,
      method,
      body: requestBody,
      authorization: new Headers(init?.headers).get("authorization")
    });
    if (url.pathname === "/api/v10/users/@me") return Response.json({ id: botId });
    if (url.pathname === `/api/v10/guilds/${guildId}/roles` && method === "GET") {
      return Response.json([{ id: guildId }]);
    }
    if (url.pathname === `/api/v10/guilds/${guildId}/roles` && method === "POST") {
      return Response.json({ id: markerRoleId });
    }
    if (method === "PUT" || method === "DELETE") return new Response(null, { status: 204 });
    if (url.pathname === `/api/v10/guilds/${guildId}/channels` && method === "POST") {
      return Response.json({ id: channelId });
    }
    if (url.pathname.includes("/webhooks/") && method === "PATCH") return new Response(null, { status: 200 });
    throw new Error(`Unexpected Discord API request: ${method} ${url.pathname}`);
  };

  try {
    let backgroundTask: Promise<unknown> | undefined;
    const response = await worker.fetch(new Request("https://koryuu.example/discord/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-timestamp": timestamp,
        "x-signature-ed25519": signature
      },
      body
    }), env, {
      waitUntil(promise) {
        backgroundTask = promise;
      }
    });

    const deferred = await response.json() as { type: number; data: { flags: number } };
    assert.equal(deferred.type, 5);
    assert.equal(deferred.data.flags, 64);
    assert.ok(backgroundTask);
    await backgroundTask;
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM admin_sessions WHERE user_id = ?").get(userId)?.count, 1);
    assert.equal(database.prepare("SELECT channel_id FROM temporary_admin_access WHERE user_id = ?").get(userId)?.channel_id, channelId);
    assert.ok(calls.some(call => call.path.includes("/webhooks/") && call.method === "PATCH"));
    assert.ok(calls.every(call => call.authorization === null || call.authorization === "Bot test-bot-token"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
