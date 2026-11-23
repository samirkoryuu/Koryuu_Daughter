import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import worker from "../src/worker.js";
import {
  processDueLinkedRoleReminderSubscriptions,
  setLinkedRoleReminderSubscription
} from "../src/linked-roles.js";
import { makeTestEnv } from "./helpers.js";

const GUILD_ID = "100000000000000010";
const MEMBER_ID = "100000000000000030";
const ROLE_ID = "1566823723305271428";
const PATH = "/api/community/linked-role-join";

function installDiscordMock(options: { linkedOnMemberRead?: (readCount: number) => boolean; failDm?: boolean } = {}): {
  restore: () => void;
  calls: Array<{ path: string; method: string; body?: Record<string, unknown> }>;
  getMemberReads: () => number;
} {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  let memberReads = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/v10/users/@me/channels" ||
      url.pathname === "/api/v10/channels/100000000000000070/messages") {
      assert.equal(init?.redirect, "manual");
    }
    const body = init?.body
      ? JSON.parse(String(init.body)) as Record<string, unknown>
      : undefined;
    calls.push({ path: url.pathname, method, body });
    if (method === "GET" && url.pathname === `/api/v10/guilds/${GUILD_ID}/roles`) {
      return Response.json([
        { id: GUILD_ID, name: "@everyone", permissions: "0", position: 0, managed: false, hoist: false, mentionable: false, color: 0 },
        { id: ROLE_ID, name: "100% Organic", permissions: "0", position: 1, managed: false, hoist: false, mentionable: false, color: 0 }
      ]);
    }
    if (method === "GET" && url.pathname === `/api/v10/guilds/${GUILD_ID}/members/${MEMBER_ID}`) {
      memberReads++;
      const hasRole = options.linkedOnMemberRead?.(memberReads) ?? false;
      return Response.json({
        user: { id: MEMBER_ID, username: "member", global_name: null },
        roles: hasRole ? [ROLE_ID] : [],
        nick: null
      });
    }
    if (method === "POST" && url.pathname === "/api/v10/users/@me/channels") {
      if (options.failDm) return Response.json({ message: "DMs are disabled." }, { status: 403 });
      return Response.json({ id: "100000000000000070" });
    }
    if (method === "POST" && url.pathname === "/api/v10/channels/100000000000000070/messages") {
      return Response.json({ id: "100000000000000071" });
    }
    return Response.json({ message: `Unexpected Discord request: ${method} ${url.pathname}` }, { status: 500 });
  };
  return {
    restore: () => { globalThis.fetch = originalFetch; },
    calls,
    getMemberReads: () => memberReads
  };
}

async function postJoin(env: ReturnType<typeof makeTestEnv>["env"], actorId = env.LILITH_USER_ID): Promise<Response> {
  const body = Buffer.from(JSON.stringify({
    guildId: GUILD_ID,
    memberId: MEMBER_ID,
    joinedAt: "2026-11-09T00:00:00.000Z"
  }));
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const contentType = "application/json";
  const canonical = `${timestamp}.${nonce}.POST.${PATH}.${actorId}.${contentType}..`;
  const signature = createHmac("sha256", env.GATEWAY_SHARED_SECRET)
    .update(canonical)
    .update(body)
    .digest("hex");
  return worker.fetch(new Request(`https://koryuu.example${PATH}`, {
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
}

test("unlinked join receives one onboarding DM; duplicate joins cannot resend", async () => {
  const { env, database } = makeTestEnv();
  env.WORKER_PUBLIC_URL = "https://koryuu.example";
  const mock = installDiscordMock();
  try {
    const first = await postJoin(env);
    assert.equal(first.status, 200);
    assert.equal((await first.json() as { status: string }).status, "sent");
    const dmCalls = mock.calls.filter(call => call.path.endsWith("/users/@me/channels"));
    const messageCalls = mock.calls.filter(call => call.path.endsWith("/channels/100000000000000070/messages"));
    assert.equal(dmCalls.length, 1);
    assert.equal(messageCalls.length, 1);
    assert.match(String(messageCalls[0].body?.content), /100% Organic/);
    assert.match(String(messageCalls[0].body?.content), /discord\/linked-role/);
    assert.match(String(messageCalls[0].body?.content), /imgflip\.com\/gif\/b5dv6n/);
    assert.equal(database.prepare(
      "SELECT status FROM linked_role_onboarding WHERE guild_id = ? AND member_id = ?"
    ).get(GUILD_ID, MEMBER_ID)?.status, "sent");

    const second = await postJoin(env);
    assert.equal(second.status, 200);
    assert.equal((await second.json() as { status: string }).status, "duplicate");
    assert.equal(mock.calls.filter(call => call.path.endsWith("/users/@me/channels")).length, 1);
  } finally {
    mock.restore();
  }
});

test("join onboarding is one-time and never enrolls members into recurring reminders", async () => {
  const { env, database } = makeTestEnv();
  env.WORKER_PUBLIC_URL = "https://koryuu.example";
  const mock = installDiscordMock();
  try {
    const response = await postJoin(env);
    assert.equal((await response.json() as { status: string }).status, "sent");
    await worker.scheduled({ scheduledTime: Date.now(), cron: "* * * * *", noRetry() {} }, env);
    assert.equal(mock.calls.filter(call => call.path.endsWith("/channels/100000000000000070/messages")).length, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM linked_role_reminder_subscriptions").get()?.count, 0);
  } finally {
    mock.restore();
  }
});

test("an unverified member can explicitly opt in to reminders and receives them every 20 minutes", async () => {
  const { env, database } = makeTestEnv();
  env.WORKER_PUBLIC_URL = "https://koryuu.example";
  const mock = installDiscordMock();
  try {
    const now = new Date("2026-11-12T10:00:00.000Z");
    const subscription = await setLinkedRoleReminderSubscription(env, GUILD_ID, MEMBER_ID, true, now);
    assert.equal(subscription.status, "active");
    assert.match(subscription.message, /every 20 minutes/);
    assert.equal(mock.calls.some(call => call.path.endsWith("/users/@me/channels")), false);
    database.prepare(
      "UPDATE linked_role_reminder_subscriptions SET next_reminder_at = ? WHERE guild_id = ? AND member_id = ?"
    ).run(new Date(now.getTime() + 20 * 60 * 1000).toISOString(), GUILD_ID, MEMBER_ID);
    await processDueLinkedRoleReminderSubscriptions(env, new Date(now.getTime() + 20 * 60 * 1000));
    assert.equal(mock.calls.filter(call => call.path.endsWith("/channels/100000000000000070/messages")).length, 1);
    const row = database.prepare(
      "SELECT status, reminder_count, last_reminded_at, next_reminder_at FROM linked_role_reminder_subscriptions WHERE guild_id = ? AND member_id = ?"
    ).get(GUILD_ID, MEMBER_ID) as { status: string; reminder_count: number; last_reminded_at: string; next_reminder_at: string };
    assert.equal(row.status, "active");
    assert.equal(row.reminder_count, 1);
    assert.ok(row.last_reminded_at);
    assert.equal(Date.parse(row.next_reminder_at), now.getTime() + 40 * 60 * 1000);
    assert.match(String(mock.calls.find(call => call.path.endsWith("/channels/100000000000000070/messages"))?.body?.content), /You asked me to remind you/);
  } finally {
    mock.restore();
  }
});

test("opt-in reminders stop after verification and can be disabled by the member", async () => {
  const { env, database } = makeTestEnv();
  env.WORKER_PUBLIC_URL = "https://koryuu.example";
  const mock = installDiscordMock({ linkedOnMemberRead: count => count >= 2 });
  try {
    await setLinkedRoleReminderSubscription(env, GUILD_ID, MEMBER_ID, true);
    database.prepare(
      "UPDATE linked_role_reminder_subscriptions SET next_reminder_at = ? WHERE guild_id = ? AND member_id = ?"
    ).run(new Date(Date.now() - 60_000).toISOString(), GUILD_ID, MEMBER_ID);
    await processDueLinkedRoleReminderSubscriptions(env);
    const verified = database.prepare(
      "SELECT status, next_reminder_at FROM linked_role_reminder_subscriptions WHERE guild_id = ? AND member_id = ?"
    ).get(GUILD_ID, MEMBER_ID) as { status: string; next_reminder_at: string | null };
    assert.equal(verified.status, "verified");
    assert.equal(verified.next_reminder_at, null);
    assert.equal(mock.calls.filter(call => call.path.endsWith("/channels/100000000000000070/messages")).length, 0);

    await setLinkedRoleReminderSubscription(env, GUILD_ID, MEMBER_ID, false);
    const disabled = database.prepare(
      "SELECT status FROM linked_role_reminder_subscriptions WHERE guild_id = ? AND member_id = ?"
    ).get(GUILD_ID, MEMBER_ID) as { status: string };
    assert.equal(disabled.status, "disabled");
  } finally {
    mock.restore();
  }
});

test("linked members and members who link before delivery receive no onboarding DM", async () => {
  const { env, database } = makeTestEnv();
  const mock = installDiscordMock({ linkedOnMemberRead: count => count === 1 });
  try {
    const response = await postJoin(env);
    assert.equal((await response.json() as { status: string }).status, "already_linked");
    assert.equal(mock.calls.some(call => call.path.endsWith("/users/@me/channels")), false);
    assert.equal(database.prepare("SELECT status FROM linked_role_onboarding").get()?.status, "already_linked");
  } finally {
    mock.restore();
  }
});

test("onboarding rechecks the Linked Role immediately before sending", async () => {
  const { env, database } = makeTestEnv();
  const mock = installDiscordMock({ linkedOnMemberRead: count => count >= 2 });
  try {
    const response = await postJoin(env);
    assert.equal((await response.json() as { status: string }).status, "already_linked");
    assert.equal(mock.getMemberReads(), 2);
    assert.equal(mock.calls.some(call => call.path.endsWith("/users/@me/channels")), false);
    assert.equal(database.prepare("SELECT status FROM linked_role_onboarding").get()?.status, "already_linked");
  } finally {
    mock.restore();
  }
});

test("failed onboarding DM is recorded and never automatically retried", async () => {
  const { env, database } = makeTestEnv();
  env.WORKER_PUBLIC_URL = "https://koryuu.example";
  const mock = installDiscordMock({ failDm: true });
  try {
    const response = await postJoin(env);
    assert.equal((await response.json() as { status: string }).status, "failed");
    assert.equal(database.prepare("SELECT status FROM linked_role_onboarding").get()?.status, "failed");
    assert.equal(mock.calls.filter(call => call.path.endsWith("/users/@me/channels")).length, 1);
    const duplicate = await postJoin(env);
    assert.equal((await duplicate.json() as { status: string }).status, "duplicate");
    assert.equal(mock.calls.filter(call => call.path.endsWith("/users/@me/channels")).length, 1);
  } finally {
    mock.restore();
  }
});

test("only the signed Gateway service identity can trigger Linked Role onboarding", async () => {
  const { env, database } = makeTestEnv();
  const response = await postJoin(env, MEMBER_ID);
  assert.equal(response.status, 403);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM linked_role_onboarding").get()?.count, 0);
});

test("Worker scheduled cleanup fails stale onboarding attempts without a running Gateway", async () => {
  const { env, database } = makeTestEnv();
  const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  database.prepare(
    `INSERT INTO linked_role_onboarding(guild_id, member_id, joined_at, status, created_at, updated_at)
     VALUES (?, ?, ?, 'checking', ?, ?)`
  ).run(GUILD_ID, MEMBER_ID, stale, stale, stale);
  await worker.scheduled({
    scheduledTime: Date.now(),
    cron: "* * * * *",
    noRetry() {}
  }, env);
  assert.equal(database.prepare(
    "SELECT status FROM linked_role_onboarding WHERE guild_id = ? AND member_id = ?"
  ).get(GUILD_ID, MEMBER_ID)?.status, "failed");
});
