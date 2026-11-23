import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import worker from "../src/worker.js";
import { verifyDiscordSignature, verifyGatewayRequest } from "../src/security.js";
import { makeTestEnv } from "./helpers.js";
import { authenticateAdmin, stageAdminChange } from "../src/domain.js";

test("Discord interactions require a valid recent Ed25519 signature", async () => {
  const { env } = makeTestEnv();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  env.DISCORD_PUBLIC_KEY = publicDer.subarray(publicDer.length - 32).toString("hex");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({ type: 1 });
  const signature = sign(null, Buffer.from(`${timestamp}${body}`), privateKey).toString("hex");
  assert.equal(await verifyDiscordSignature(env, timestamp, signature, body), true);
  assert.equal(await verifyDiscordSignature(env, timestamp, "00".repeat(64), body), false);
  assert.equal(await verifyDiscordSignature(env, "1", signature, body), false);
});

test("Gateway signatures bind the request and reject replayed nonces", async () => {
  const { env } = makeTestEnv();
  const body = Buffer.from('{"actorId":"100000000000000002","text":"hello","isDm":true}');
  const actorId = env.ASTERION_USER_ID;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = "12345678-1234-4234-8234-123456789abc";
  const contentType = "application/json";
  const pathname = "/api/chat";
  const canonical = `${timestamp}.${nonce}.POST.${pathname}.${actorId}.${contentType}..`;
  const signature = createHmac("sha256", env.GATEWAY_SHARED_SECRET)
    .update(canonical)
    .update(body)
    .digest("hex");
  const request = new Request(`https://koryuu.example${pathname}`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-koryuu-timestamp": timestamp,
      "x-koryuu-nonce": nonce,
      "x-koryuu-actor": actorId,
      "x-koryuu-signature": signature
    },
    body
  });

  assert.equal(await verifyGatewayRequest(env, request, body), true);
  assert.equal(await verifyGatewayRequest(env, request, body), false);
});

test("signed Gateway activity reports store only one privacy-minimized guild day record", async () => {
  const { env, database } = makeTestEnv();
  const path = "/api/community/member-activity";
  const body = Buffer.from(JSON.stringify({
    guildId: "100000000000000010",
    memberId: "100000000000000030"
  }));
  let nonceIndex = 0;
  const send = async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = `12345678-1234-4234-8234-1234567890${String(++nonceIndex).padStart(2, "0")}`;
    const actorId = env.LILITH_USER_ID;
    const contentType = "application/json";
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
  const first = await send();
  const second = await send();
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { recorded: boolean }).recorded, true);
  assert.equal(second.status, 200);
  assert.equal((await second.json() as { recorded: boolean }).recorded, false);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM community_member_activity_days").get()?.count, 1);
});

test("Worker verifies Discord signatures and processes each interaction once", async () => {
  const { env } = makeTestEnv();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  env.DISCORD_PUBLIC_KEY = publicDer.subarray(publicDer.length - 32).toString("hex");
  const body = JSON.stringify({
    id: "123456789012345678",
    type: 2,
    member: { user: { id: "100000000000000003" } },
    data: { name: "dprint" }
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = sign(null, Buffer.from(`${timestamp}${body}`), privateKey).toString("hex");
  const makeRequest = () => new Request("https://koryuu.example/discord/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-timestamp": timestamp,
        "x-signature-ed25519": signature
      },
      body
    });

  const response = await worker.fetch(makeRequest(), env);
  const payload = await response.json() as { type: number; data: { content: string; flags: number } };
  assert.equal(response.status, 200);
  assert.equal(payload.type, 4);
  assert.equal(payload.data.flags, 64);
  assert.match(payload.data.content, /only available to Asterion/);
  assert.equal((await worker.fetch(makeRequest(), env)).status, 409);
});

test("private admin authentication grants only an expiring verified session", async () => {
  const { env, database } = makeTestEnv();
  const password = "test-only-admin-password";
  env.ADMIN_PASSWORD_SHA256 = createHash("sha256").update(password).digest("hex");

  await assert.rejects(authenticateAdmin(env, env.LILITH_USER_ID, "wrong-password"), /authentication failed/i);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM admin_sessions").get()?.count, 0);
  await authenticateAdmin(env, "100000000000000003", password);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM admin_sessions").get()?.count, 1);
  await assert.rejects(
    stageAdminChange(env, "100000000000000003", {
      operation: "add_knowledge",
      scope: "general",
      title: "Test",
      content: "Admin session works."
    }, false),
    /direct message/
  );
  const staged = await stageAdminChange(env, "100000000000000003", {
    operation: "add_knowledge",
    scope: "general",
    title: "Test",
    content: "Admin session works."
  }, true);
  assert.ok(staged.pendingAction.id);
});
