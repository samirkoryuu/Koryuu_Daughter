import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmServerChange, stageServerChange } from "../src/discord-server.js";
import { makeTestEnv } from "./helpers.js";

const GUILD_ID = "100000000000000010";
const BOT_ID = "100000000000000020";
const MEMBER_ID = "100000000000000030";
const BOT_ROLE_ID = "100000000000000050";
const CHANNEL_ID = "100000000000000060";

function installDiscordMock(options: { highRole?: boolean } = {}): {
  restore: () => void;
  calls: Array<{ path: string; method: string; body?: Record<string, unknown> }>;
} {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body
      ? JSON.parse(String(init.body)) as Record<string, unknown>
      : undefined;
    calls.push({ path, method, body });
    if (path === "/api/v10/users/@me") return Response.json({ id: BOT_ID });
    if (method === "GET" && path === `/api/v10/guilds/${GUILD_ID}/roles`) {
      return Response.json([
        { id: GUILD_ID, name: "@everyone", permissions: "0", position: 0, managed: false, hoist: false, mentionable: false, color: 0 },
        { id: BOT_ROLE_ID, name: "Koryuu", permissions: String((1n << 1n) | (1n << 2n) | (1n << 4n) | (1n << 28n) | (1n << 40n)), position: 10, managed: false, hoist: false, mentionable: false, color: 0 },
        ...(options.highRole
          ? [{ id: "100000000000000051", name: "High", permissions: "0", position: 20, managed: false, hoist: false, mentionable: false, color: 0 }]
          : [])
      ]);
    }
    if (method === "GET" && path === `/api/v10/guilds/${GUILD_ID}/channels`) {
      return Response.json([{ id: CHANNEL_ID, name: "archive", type: 0, parent_id: null, permission_overwrites: [] }]);
    }
    if (method === "GET" && path === `/api/v10/guilds/${GUILD_ID}`) {
      return Response.json({ owner_id: "100000000000000001" });
    }
    if (method === "GET" && path.startsWith(`/api/v10/guilds/${GUILD_ID}/members/`)) {
      const id = path.split("/").pop();
      return Response.json({
        user: { id, username: "member", global_name: null },
        roles: id === BOT_ID ? [BOT_ROLE_ID] : options.highRole ? ["100000000000000051"] : [],
        nick: null
      });
    }
    if (method === "PATCH" && path === `/api/v10/guilds/${GUILD_ID}/members/${MEMBER_ID}`) {
      return Response.json({ user: { id: MEMBER_ID, username: "member" }, roles: [], nick: null });
    }
    if (method === "DELETE" && path === `/api/v10/channels/${CHANNEL_ID}`) {
      return new Response(null, { status: 204 });
    }
    return Response.json({ message: `Unexpected Discord request: ${method} ${path}` }, { status: 500 });
  };
  return { restore: () => { globalThis.fetch = originalFetch; }, calls };
}

test("member timeouts require owner confirmation and are revalidated against live permissions", async () => {
  const { env } = makeTestEnv();
  const mock = installDiscordMock();
  try {
    const staged = await stageServerChange(env, env.LILITH_USER_ID, GUILD_ID, {
      operation: "timeout_member",
      member_id: MEMBER_ID,
      duration_minutes: 30
    });
    assert.match(staged.preview, /for 30 minute/);
    assert.equal(mock.calls.some(call => call.method === "PATCH"), false);
    await confirmServerChange(env, env.LILITH_USER_ID, staged.id);
    const patch = mock.calls.find(call => call.method === "PATCH");
    assert.ok(patch);
    assert.equal(typeof patch.body?.communication_disabled_until, "string");
    assert.ok(Date.parse(String(patch.body?.communication_disabled_until)) > Date.now());
  } finally {
    mock.restore();
  }
});

test("member moderation rejects targets above Koryuu's role and destructive channel removal is confirmed", async () => {
  const { env } = makeTestEnv();
  const mock = installDiscordMock({ highRole: true });
  try {
    await assert.rejects(stageServerChange(env, env.LILITH_USER_ID, GUILD_ID, {
      operation: "kick_member",
      member_id: MEMBER_ID
    }), /at or above her highest role/);
    const staged = await stageServerChange(env, env.LILITH_USER_ID, GUILD_ID, {
      operation: "delete_channel",
      channel_id: CHANNEL_ID
    });
    assert.match(staged.preview, /permanently removes/);
    assert.equal(mock.calls.some(call => call.method === "DELETE" && call.path.endsWith(CHANNEL_ID)), false);
    await confirmServerChange(env, env.LILITH_USER_ID, staged.id);
    assert.equal(mock.calls.some(call => call.method === "DELETE" && call.path.endsWith(CHANNEL_ID)), true);
  } finally {
    mock.restore();
  }
});
