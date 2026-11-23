import assert from "node:assert/strict";
import { test } from "node:test";
import {
  archiveServerMessage,
  deleteArchivedMessages,
  getArchivedChannelMessages,
  registerClientMemoryMember,
  removeClientMemoryMembership,
  searchClientMemoryMessages,
  SERVER_ARCHIVE_BUDGET_BYTES
} from "../src/message-archive.js";
import { makeTestEnv } from "./helpers.js";
import { commitChatTurn } from "../src/domain.js";

const GUILD_ID = "100000000000000010";
const CHANNEL_ID = "100000000000000020";
const SYSTEM_CHANNEL_ID = "100000000000000021";
const BOT_ID = "100000000000000090";
const BOT_ROLE_ID = "100000000000000091";
const USER_ONE = "100000000000000030";
const USER_TWO = "100000000000000031";

function installDiscordMock(): { restore: () => void; notices: number } {
  const originalFetch = globalThis.fetch;
  const roles: Array<Record<string, unknown>> = [
    { id: GUILD_ID, name: "@everyone", permissions: "0", position: 0, managed: false, hoist: false, mentionable: false, color: 0 },
    { id: BOT_ROLE_ID, name: "Koryuu", permissions: "268435456", position: 10, managed: true, hoist: false, mentionable: false, color: 0 }
  ];
  const assignedRoles = new Map<string, Set<string>>();
  let notices = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === `/api/v10/guilds/${GUILD_ID}/roles`) {
      return Response.json(roles);
    }
    if (method === "GET" && url.pathname === "/api/v10/users/@me") {
      return Response.json({ id: BOT_ID });
    }
    if (method === "GET" && url.pathname === `/api/v10/guilds/${GUILD_ID}/members/${BOT_ID}`) {
      return Response.json({ user: { id: BOT_ID, username: "Koryuu" }, roles: [BOT_ROLE_ID], nick: null });
    }
    const memberMatch = new RegExp(`^/api/v10/guilds/${GUILD_ID}/members/(\\d{17,20})$`).exec(url.pathname);
    if (method === "GET" && memberMatch) {
      const userId = memberMatch[1];
      return Response.json({
        user: { id: userId, username: userId, global_name: userId === USER_ONE ? "First" : "Second" },
        roles: [...(assignedRoles.get(userId) ?? new Set<string>())],
        nick: null
      });
    }
    if (method === "POST" && url.pathname === `/api/v10/guilds/${GUILD_ID}/roles`) {
      const role = {
        id: "100000000000000092",
        name: "client-koryuu",
        permissions: "0",
        position: 1,
        managed: false,
        hoist: false,
        mentionable: false,
        color: 0
      };
      roles.push(role);
      return Response.json(role);
    }
    const assignMatch = new RegExp(`^/api/v10/guilds/${GUILD_ID}/members/(\\d{17,20})/roles/(\\d{17,20})$`).exec(url.pathname);
    if (method === "PUT" && assignMatch) {
      const existing = assignedRoles.get(assignMatch[1]) ?? new Set<string>();
      existing.add(assignMatch[2]);
      assignedRoles.set(assignMatch[1], existing);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && url.pathname === `/api/v10/guilds/${GUILD_ID}`) {
      assert.equal(init?.redirect, "manual");
      return Response.json({ system_channel_id: SYSTEM_CHANNEL_ID });
    }
    if (method === "POST" && url.pathname === `/api/v10/channels/${SYSTEM_CHANNEL_ID}/messages`) {
      assert.equal(init?.redirect, "manual");
      notices++;
      return Response.json({ id: "100000000000000093" });
    }
    return Response.json({ message: `Unexpected request ${method} ${url.pathname}` }, { status: 500 });
  };
  return {
    restore: () => { globalThis.fetch = originalFetch; },
    get notices() { return notices; }
  };
}

test("archive posts the approved notice once, upserts edits, and removes deleted messages", async () => {
  const { env, database } = makeTestEnv();
  const mock = installDiscordMock();
  try {
    const base = {
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      messageId: "100000000000000040",
      authorId: USER_ONE,
      authorName: "First",
      createdAt: "2026-11-12T10:00:00.000Z"
    };
    await archiveServerMessage(env, { ...base, content: "The event begins at 8 PM." });
    await archiveServerMessage(env, {
      ...base,
      content: "The event begins at 9 PM.",
      editedAt: "2026-11-12T10:01:00.000Z"
    });
    assert.equal(mock.notices, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM server_message_archive").get()?.count, 1);
    assert.equal(database.prepare("SELECT content FROM server_message_archive").get()?.content, "The event begins at 9 PM.");
    const usage = database.prepare("SELECT used_bytes FROM server_archive_usage WHERE guild_id = ?").get(GUILD_ID) as { used_bytes: number };
    assert.ok(usage.used_bytes > 0);

    await deleteArchivedMessages(env, GUILD_ID, CHANNEL_ID, [base.messageId]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM server_message_archive").get()?.count, 0);
    assert.equal(database.prepare("SELECT used_bytes FROM server_archive_usage WHERE guild_id = ?").get(GUILD_ID)?.used_bytes, 0);
  } finally {
    mock.restore();
  }
});

test("archive cursor pages messages from oldest boundary without crossing channels", async () => {
  const { env, database } = makeTestEnv();
  database.prepare(
    `INSERT INTO server_message_archive(message_id, guild_id, channel_id, author_id, author_name, content, created_at, storage_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("100000000000000040", GUILD_ID, CHANNEL_ID, USER_ONE, "First", "one", "2026-11-12T10:00:00.000Z", 200);
  database.prepare(
    `INSERT INTO server_message_archive(message_id, guild_id, channel_id, author_id, author_name, content, created_at, storage_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("100000000000000041", GUILD_ID, CHANNEL_ID, USER_TWO, "Second", "two", "2026-11-12T10:01:00.000Z", 200);
  database.prepare(
    `INSERT INTO server_message_archive(message_id, guild_id, channel_id, author_id, author_name, content, created_at, storage_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("100000000000000042", GUILD_ID, "100000000000000022", USER_TWO, "Second", "elsewhere", "2026-11-12T10:02:00.000Z", 200);

  const first = await getArchivedChannelMessages(env, GUILD_ID, CHANNEL_ID, { limit: 1 });
  assert.equal(first.messages[0].content, "two");
  assert.equal(first.has_more, true);
  assert.ok(first.next_before);
  const second = await getArchivedChannelMessages(env, GUILD_ID, CHANNEL_ID, {
    limit: 1,
    beforeCreatedAt: first.next_before?.created_at,
    beforeMessageId: first.next_before?.message_id
  });
  assert.deepEqual(second.messages.map(message => message.content), ["one"]);
  assert.equal(second.has_more, false);
  assert.equal(second.stored_messages, 2);
});

test("server archive keeps newest messages within its shared 150MB cap", async () => {
  const { env, database } = makeTestEnv();
  const mock = installDiscordMock();
  try {
    database.prepare(
      `INSERT INTO server_message_archive(message_id, guild_id, channel_id, author_id, author_name, content, created_at, storage_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("100000000000000040", GUILD_ID, CHANNEL_ID, USER_ONE, "First", "old", "2026-11-10T10:00:00.000Z", SERVER_ARCHIVE_BUDGET_BYTES);
    await archiveServerMessage(env, {
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      messageId: "100000000000000041",
      authorId: USER_TWO,
      authorName: "Second",
      content: "new message",
      createdAt: "2026-11-12T10:00:00.000Z"
    });
    const remaining = database.prepare(
      "SELECT message_id, content FROM server_message_archive WHERE guild_id = ?"
    ).all(GUILD_ID) as Array<{ message_id: string; content: string }>;
    assert.deepEqual(remaining.map(row => row.message_id), ["100000000000000041"]);
    const usage = database.prepare(
      "SELECT used_bytes FROM server_archive_usage WHERE guild_id = ?"
    ).get(GUILD_ID) as { used_bytes: number };
    assert.ok(usage.used_bytes <= SERVER_ARCHIVE_BUDGET_BYTES);
  } finally {
    mock.restore();
  }
});

test("adding a client role divides the 150MB memory pool and evicts oldest history", async () => {
  const { env, database } = makeTestEnv();
  const mock = installDiscordMock();
  try {
    const first = await registerClientMemoryMember(env, GUILD_ID, USER_ONE);
    assert.equal(first.clientCount, 1);
    assert.equal(first.memoryQuotaBytes, 150_000_000);
    database.prepare(
      `INSERT INTO client_memory_messages(user_id, role, content, storage_bytes, created_at)
       VALUES (?, 'user', 'old history', 60000000, '2026-11-10T10:00:00.000Z')`
    ).run(USER_ONE);
    database.prepare(
      `INSERT INTO client_memory_messages(user_id, role, content, storage_bytes, created_at)
       VALUES (?, 'assistant', 'new history', 30000000, '2026-11-12T10:00:00.000Z')`
    ).run(USER_ONE);
    const second = await registerClientMemoryMember(env, GUILD_ID, USER_TWO);
    assert.equal(second.clientCount, 2);
    assert.equal(second.memoryQuotaBytes, 75_000_000);
    const remaining = database.prepare(
      "SELECT content FROM client_memory_messages WHERE user_id = ? ORDER BY created_at"
    ).all(USER_ONE) as Array<{ content: string }>;
    assert.deepEqual(remaining.map(row => row.content), ["new history"]);

    await removeClientMemoryMembership(env, GUILD_ID, USER_ONE);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM client_memory_messages WHERE user_id = ?").get(USER_ONE)?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(DISTINCT user_id) AS count FROM client_memory_members").get()?.count, 1);
  } finally {
    mock.restore();
  }
});

test("per-user memory search cannot return another member's messages", async () => {
  const { env, database } = makeTestEnv();
  database.prepare(
    `INSERT INTO client_memory_messages(user_id, role, content, storage_bytes, created_at)
     VALUES (?, 'user', 'Remember the silver dragon event', 188, '2026-11-12T10:00:00.000Z')`
  ).run(USER_ONE);
  database.prepare(
    `INSERT INTO client_memory_messages(user_id, role, content, storage_bytes, created_at)
     VALUES (?, 'user', 'Remember the silver dragon secret', 188, '2026-11-12T10:00:01.000Z')`
  ).run(USER_TWO);

  const result = await searchClientMemoryMessages(env, USER_ONE, "silver dragon");
  assert.deepEqual(result.map(message => message.content), ["Remember the silver dragon event"]);
  assert.equal(SERVER_ARCHIVE_BUDGET_BYTES, 150_000_000);
});

test("successful chat turns enter only the registered member's persistent memory", async () => {
  const { env, database } = makeTestEnv();
  database.prepare(
    "INSERT INTO client_memory_members(guild_id, user_id, role_id, registered_at) VALUES (?, ?, ?, ?)"
  ).run(GUILD_ID, USER_ONE, "100000000000000092", "2026-11-12T10:00:00.000Z");
  await commitChatTurn(env, USER_ONE, "Remember the astronomy meeting.", "The astronomy meeting is Friday.");
  await commitChatTurn(env, USER_TWO, "Private unregistered message.", "Transient reply.");

  const firstUser = database.prepare(
    "SELECT role, content FROM client_memory_messages WHERE user_id = ? ORDER BY id"
  ).all(USER_ONE) as Array<{ role: string; content: string }>;
  const secondUserCount = database.prepare(
    "SELECT COUNT(*) AS count FROM client_memory_messages WHERE user_id = ?"
  ).get(USER_TWO) as { count: number };
  assert.deepEqual(firstUser.map(message => message.role), ["user", "assistant"]);
  assert.equal(firstUser[0].content, "Remember the astronomy meeting.");
  assert.equal(secondUserCount.count, 0);
});
