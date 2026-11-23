import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/worker.js";
import { makeTestEnv } from "./helpers.js";

const APPLICATION_ID = "100000000000000020";
const LINKED_USER_ID = "100000000000000030";

test("Linked Roles OAuth records one-time state and updates the user's application role connection", async () => {
  const { env, database } = makeTestEnv();
  env.DISCORD_CLIENT_SECRET = "test-client-secret";
  env.WORKER_PUBLIC_URL = "https://koryuu.example";
  const originalFetch = globalThis.fetch;
  let connectionUpdates = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v10/users/@me" && init?.headers &&
      new Headers(init.headers).get("authorization") === `Bot ${env.DISCORD_BOT_TOKEN}`) {
      return Response.json({ id: APPLICATION_ID });
    }
    if (url.pathname === "/api/v10/oauth2/token" && init?.method === "POST") {
      assert.equal(init.redirect, "manual");
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get("client_id"), APPLICATION_ID);
      assert.equal(body.get("client_secret"), env.DISCORD_CLIENT_SECRET);
      assert.equal(body.get("scope"), "identify role_connections.write");
      assert.equal(body.get("redirect_uri"), "https://koryuu.example/discord/linked-role/callback");
      return Response.json({ access_token: "sensitive-access-token", token_type: "Bearer" });
    }
    if (url.pathname === "/api/v10/users/@me" && new Headers(init?.headers).get("authorization") === "Bearer sensitive-access-token") {
      return Response.json({ id: LINKED_USER_ID, username: "samir" });
    }
    if (url.pathname === `/api/v10/users/@me/applications/${APPLICATION_ID}/role-connection`) {
      assert.equal(init?.method, "PUT");
      assert.equal(init.redirect, "manual");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sensitive-access-token");
      const body = JSON.parse(String(init?.body)) as {
        platform_name: string;
        platform_username: string;
        metadata: { linked: string };
      };
      assert.equal(body.platform_name, "Koryuu");
      assert.equal(body.platform_username, "samir");
      assert.equal(body.metadata.linked, "1");
      connectionUpdates++;
      return Response.json({ metadata: body.metadata });
    }
    return Response.json({ message: `Unexpected Discord request: ${url.pathname}` }, { status: 500 });
  };
  try {
    const start = await worker.fetch(new Request("https://koryuu.example/discord/linked-role"), env);
    assert.equal(start.status, 302);
    const location = new URL(start.headers.get("location") ?? "");
    assert.equal(location.origin, "https://discord.com");
    assert.equal(location.searchParams.get("scope"), "identify role_connections.write");
    assert.equal(location.searchParams.get("redirect_uri"), "https://koryuu.example/discord/linked-role/callback");
    const state = location.searchParams.get("state");
    assert.ok(state);

    const callbackUrl = `https://koryuu.example/discord/linked-role/callback?state=${state}&code=authorization-code`;
    const callback = await worker.fetch(new Request(callbackUrl), env);
    assert.equal(callback.status, 200);
    assert.match(await callback.text(), /Your Discord account is linked/);
    assert.equal(connectionUpdates, 1);
    assert.equal(database.prepare(
      "SELECT status FROM linked_role_oauth_states WHERE state = ?"
    ).get(state)?.status, "completed");
    assert.equal(database.prepare("SELECT discord_user_id FROM linked_role_events").get()?.discord_user_id, LINKED_USER_ID);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM linked_role_oauth_states WHERE state = ? AND discord_user_id = ?"
    ).get(state, LINKED_USER_ID)?.count, 1);

    const replay = await worker.fetch(new Request(callbackUrl), env);
    assert.equal(replay.status, 410);
    assert.equal(connectionUpdates, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Linked Roles refuses to start when the OAuth client secret is missing", async () => {
  const { env } = makeTestEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id: APPLICATION_ID });
  try {
    const response = await worker.fetch(new Request("https://koryuu.example/discord/linked-role"), env);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /not configured/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
