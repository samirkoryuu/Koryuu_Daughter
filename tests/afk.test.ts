import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import worker from "../src/worker.js";
import { makeTestEnv } from "./helpers.js";

test("AFK picker saves preset and custom statuses for the invoking member", async () => {
  const { env, database } = makeTestEnv();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  env.DISCORD_PUBLIC_KEY = publicDer.subarray(publicDer.length - 32).toString("hex");
  const guildId = "100000000000000010";
  let interactionId = 30n;

  const interact = async (payload: Record<string, unknown>) => {
    const body = JSON.stringify({ id: String(100000000000000000n + ++interactionId), ...payload });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = sign(null, Buffer.from(`${timestamp}${body}`), privateKey).toString("hex");
    const response = await worker.fetch(new Request("https://koryuu.example/discord/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-timestamp": timestamp,
        "x-signature-ed25519": signature
      },
      body
    }), env);
    assert.equal(response.status, 200);
    return response.json() as Promise<Record<string, any>>;
  };

  const picker = await interact({
    type: 2,
    guild_id: guildId,
    member: { user: { id: "100000000000000003" } },
    data: { name: "afk" }
  });
  assert.equal(picker.type, 4);
  assert.equal(picker.data.flags, 64);
  assert.equal(picker.data.components[0].components[0].options.length, 6);

  const preset = await interact({
    type: 3,
    guild_id: guildId,
    member: { user: { id: "100000000000000003" } },
    data: { custom_id: "koryuu_afk_status", values: ["sleeping"] }
  });
  assert.equal(preset.type, 4);
  assert.match(preset.data.embeds[0].description, /Sleeping — Gone to recharge/);
  assert.equal(database.prepare(
    "SELECT status FROM afk_statuses WHERE guild_id = ? AND user_id = ?"
  ).get(guildId, "100000000000000003")?.status, "🌙 Sleeping — Gone to recharge.");

  const customPicker = await interact({
    type: 3,
    guild_id: guildId,
    member: { user: { id: "100000000000000004" } },
    data: { custom_id: "koryuu_afk_status", values: ["custom"] }
  });
  assert.equal(customPicker.type, 9);
  assert.equal(customPicker.data.custom_id, "koryuu_afk_custom");

  const customStatus = await interact({
    type: 5,
    guild_id: guildId,
    member: { user: { id: "100000000000000004" } },
    data: {
      custom_id: "koryuu_afk_custom",
      components: [{ components: [{ custom_id: "status", value: "At work" }] }]
    }
  });
  assert.equal(customStatus.type, 4);
  assert.match(customStatus.data.embeds[0].description, /Custom — At work/);
  assert.equal(database.prepare(
    "SELECT status FROM afk_statuses WHERE guild_id = ? AND user_id = ?"
  ).get(guildId, "100000000000000004")?.status, "At work");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM afk_statuses").get()?.count, 2);
});

test("AFK status validation rejects empty, overlong, and cross-server identity input", async () => {
  const { env, database } = makeTestEnv();
  const { setAfkStatus } = await import("../src/afk.js");

  await assert.rejects(setAfkStatus(env, "invalid", "100000000000000003", "Away"), /valid server and user/);
  await assert.rejects(setAfkStatus(env, "100000000000000010", "100000000000000003", "  "), /between 1 and 200/);
  await assert.rejects(setAfkStatus(env, "100000000000000010", "100000000000000003", "x".repeat(201)), /between 1 and 200/);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM afk_statuses").get()?.count, 0);
});

test("AFK message events report each mentioned member and clear the sender's status", async () => {
  const { env, database } = makeTestEnv();
  const guildId = "100000000000000010";
  const authorId = "100000000000000003";
  const firstAfkId = "100000000000000004";
  const secondAfkId = "100000000000000005";
  const ordinaryMemberId = "100000000000000006";
  const { setAfkStatus } = await import("../src/afk.js");
  await setAfkStatus(env, guildId, authorId, "Was away");
  await setAfkStatus(env, guildId, firstAfkId, "Sleeping");
  await setAfkStatus(env, guildId, secondAfkId, "Studying");
  await setAfkStatus(env, guildId, "100000000000000007", "Other server");

  const path = "/api/afk/message";
  const input = {
    guildId,
    authorId,
    mentionedUserIds: [firstAfkId, ordinaryMemberId, secondAfkId, firstAfkId, authorId]
  };
  const body = Buffer.from(JSON.stringify(input));
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = "12345678-1234-4234-8234-123456789abc";
  const method = "POST";
  const contentType = "application/json";
  const canonical = `${timestamp}.${nonce}.${method}.${path}.${authorId}.${contentType}..`;
  const signature = createHmac("sha256", env.GATEWAY_SHARED_SECRET)
    .update(canonical)
    .update(body)
    .digest("hex");
  const response = await worker.fetch(new Request(`https://koryuu.example${path}`, {
    method,
    headers: {
      "content-type": contentType,
      "x-koryuu-timestamp": timestamp,
      "x-koryuu-nonce": nonce,
      "x-koryuu-actor": authorId,
      "x-koryuu-signature": signature
    },
    body
  }), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    mentionedAfkUsers: [
      { userId: firstAfkId, status: "Sleeping" },
      { userId: secondAfkId, status: "Studying" }
    ],
    clearedStatus: "Was away"
  });
  assert.equal(database.prepare(
    "SELECT status FROM afk_statuses WHERE guild_id = ? AND user_id = ?"
  ).get(guildId, authorId), undefined);
  assert.equal(database.prepare(
    "SELECT status FROM afk_statuses WHERE guild_id = ? AND user_id = ?"
  ).get(guildId, "100000000000000007")?.status, "Other server");
});

test("AFK message endpoint requires the signed actor to match the message author", async () => {
  const { env } = makeTestEnv();
  const path = "/api/afk/message";
  const body = Buffer.from(JSON.stringify({
    guildId: "100000000000000010",
    authorId: "100000000000000003",
    mentionedUserIds: []
  }));
  const actorId = "100000000000000004";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = "12345678-1234-4234-8234-123456789abd";
  const contentType = "application/json";
  const canonical = `${timestamp}.${nonce}.POST.${path}.${actorId}.${contentType}..`;
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
      "x-koryuu-actor": actorId,
      "x-koryuu-signature": signature
    },
    body
  }), env);
  assert.equal(response.status, 400);
});
