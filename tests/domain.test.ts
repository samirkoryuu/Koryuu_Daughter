import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendChatMessage,
  buildKnowledgeContext,
  confirmPendingAction,
  consumeChatRateLimit,
  getChatHistory,
  getDreamprint,
  getPrivateMedia,
  listCollectionMediaIds,
  listShopMediaIds,
  stageAdminChange,
  stagePurchase,
  storePrivateMedia
} from "../src/domain.js";
import { makeTestEnv } from "./helpers.js";

test("general users cannot retrieve private relationship knowledge or Asterion profile", async () => {
  const { env } = makeTestEnv();
  await env.DB.prepare(
    "INSERT INTO general_kn(title, content, created_by) VALUES (?, ?, ?)"
  ).bind("Bot facts", "Koryuu is a Discord assistant.", env.LILITH_USER_ID).run();
  await env.DB.prepare(
    "INSERT INTO relationship_kn(title, content, created_by) VALUES (?, ?, ?)"
  ).bind("Private", "Relationship-only secret.", env.LILITH_USER_ID).run();

  const general = await buildKnowledgeContext(env, "100000000000000003", "What is Koryuu?");
  assert.match(general, /Koryuu is a Discord assistant/);
  assert.doesNotMatch(general, /Relationship-only secret/);
  await assert.rejects(getDreamprint(env, "100000000000000003"), /only available to Asterion/);

  const asterion = await buildKnowledgeContext(env, env.ASTERION_USER_ID, "relationship");
  assert.match(asterion, /Relationship-only secret/);
});

test("purchases update balance, listing, collection, and token inventory exactly once", async () => {
  const { env, database } = makeTestEnv();
  await env.DB.prepare("INSERT INTO rp_wallets(user_id, balance) VALUES (?, ?)")
    .bind(env.ASTERION_USER_ID, 100).run();
  await env.DB.prepare(
    `INSERT INTO shop_storage(unique_id, category, title, description, price_rp, token_type, token_amount, created_by)
     VALUES (?, 'tokens', ?, ?, ?, 'food', 2, ?)`
  ).bind("FOOD-1", "Dinner token", "A token for a meal.", 25, env.LILITH_USER_ID).run();

  await env.DB.prepare(
    "INSERT INTO purchases(shop_item_id, unique_id, item_title, price_paid, buyer_id) VALUES (1, ?, ?, ?, ?)"
  ).bind("FOOD-1", "Dinner token", 25, env.ASTERION_USER_ID).run();

  assert.equal(database.prepare("SELECT balance FROM rp_wallets WHERE user_id = ?").get(env.ASTERION_USER_ID)?.balance, 75);
  assert.equal(database.prepare("SELECT status FROM shop_storage WHERE id = 1").get()?.status, "sold");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM astri_collection").get()?.count, 1);
  assert.equal(database.prepare("SELECT quantity FROM food_tokens").get()?.quantity, 2);

  assert.throws(() => database.prepare(
    "INSERT INTO purchases(shop_item_id, unique_id, item_title, price_paid, buyer_id) VALUES (1, ?, ?, ?, ?)"
  ).run("FOOD-1", "Dinner token", 25, env.ASTERION_USER_ID), /no longer available/);
  assert.equal(database.prepare("SELECT balance FROM rp_wallets WHERE user_id = ?").get(env.ASTERION_USER_ID)?.balance, 75);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM astri_collection").get()?.count, 1);
});

test("chat history shares identity across channels and expires per user", async () => {
  const { env, database } = makeTestEnv();
  await appendChatMessage(env, env.ASTERION_USER_ID, "user", "from server");
  await appendChatMessage(env, env.ASTERION_USER_ID, "assistant", "reply in DM");
  await appendChatMessage(env, "100000000000000003", "user", "separate user");
  assert.deepEqual((await getChatHistory(env, env.ASTERION_USER_ID)).map(message => ({ ...message })), [
    { role: "user", content: "from server" },
    { role: "assistant", content: "reply in DM" }
  ]);
  assert.deepEqual((await getChatHistory(env, "100000000000000003")).map(message => ({ ...message })), [
    { role: "user", content: "separate user" }
  ]);

  database.prepare("UPDATE conversations SET expires_at = ? WHERE user_id = ?")
    .run("2000-01-01T00:00:00.000Z", env.ASTERION_USER_ID);
  assert.deepEqual(await getChatHistory(env, env.ASTERION_USER_ID), []);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM conversations WHERE user_id = ?")
    .get(env.ASTERION_USER_ID)?.count, 0);
});

test("chat memory expires after five minutes and a new interaction refreshes only that user's timer", async () => {
  const { env, database } = makeTestEnv();
  await appendChatMessage(env, env.LILITH_USER_ID, "user", "creator message");
  await appendChatMessage(env, "100000000000000003", "user", "other user message");
  const before = database.prepare(
    "SELECT expires_at FROM conversations WHERE user_id = ?"
  ).get(env.LILITH_USER_ID)?.expires_at as string;
  assert.ok(Date.parse(before) - Date.now() <= 5 * 60 * 1000);
  assert.ok(Date.parse(before) - Date.now() > 4 * 60 * 1000);

  database.prepare("UPDATE conversations SET expires_at = ? WHERE user_id = ?")
    .run("2000-01-01T00:00:00.000Z", env.LILITH_USER_ID);
  await appendChatMessage(env, env.LILITH_USER_ID, "user", "refreshing message");
  assert.deepEqual((await getChatHistory(env, env.LILITH_USER_ID)).map(message => message.content), ["refreshing message"]);
  assert.deepEqual((await getChatHistory(env, "100000000000000003")).map(message => message.content), ["other user message"]);
});

test("administrator changes require private preview then an explicit confirmation", async () => {
  const { env, database } = makeTestEnv();
  await assert.rejects(
    stageAdminChange(env, "100000000000000003", {
      operation: "add_knowledge",
      scope: "general",
      title: "Test",
      content: "Should not be inserted."
    }),
    /Administrator access/
  );
  await assert.rejects(
    stageAdminChange(env, env.LILITH_USER_ID, {
      operation: "add_knowledge",
      scope: "general",
      title: "Test",
      content: "No staging outside a DM."
    }, false),
    /direct message/
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM general_kn").get()?.count, 0);

  const staged = await stageAdminChange(env, env.LILITH_USER_ID, {
    operation: "add_knowledge",
    scope: "general",
    title: "Test record",
    content: "Confirmed data."
  });
  assert.match(staged.preview, /Test record/);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM general_kn").get()?.count, 0);
  assert.match(await confirmPendingAction(env, env.LILITH_USER_ID, staged.pendingAction.id), /Added general knowledge/);
  assert.equal(database.prepare("SELECT content FROM general_kn").get()?.content, "Confirmed data.");
  await assert.rejects(confirmPendingAction(env, env.LILITH_USER_ID, staged.pendingAction.id), /expired or was already used/);
});

test("purchase confirmation rejects a listing changed after preview", async () => {
  const { env, database } = makeTestEnv();
  await env.DB.prepare("INSERT INTO rp_wallets(user_id, balance) VALUES (?, ?)")
    .bind(env.ASTERION_USER_ID, 100).run();
  await env.DB.prepare(
    `INSERT INTO shop_storage(unique_id, category, title, description, price_rp, created_by)
     VALUES ('MEM-1', 'memories', 'A memory', 'A shared day.', 25, ?)`
  ).bind(env.LILITH_USER_ID).run();

  const staged = await stagePurchase(env, env.ASTERION_USER_ID, "MEM-1");
  await env.DB.prepare("UPDATE shop_storage SET price_rp = 30 WHERE unique_id = 'MEM-1'").run();
  await assert.rejects(
    confirmPendingAction(env, env.ASTERION_USER_ID, staged.pendingAction.id),
    /no longer for sale/
  );
  assert.equal(database.prepare("SELECT balance FROM rp_wallets WHERE user_id = ?")
    .get(env.ASTERION_USER_ID)?.balance, 100);
  assert.equal(database.prepare("SELECT status FROM shop_storage WHERE unique_id = 'MEM-1'").get()?.status, "on_sell");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM purchases").get()?.count, 0);
});

test("administrator data change rolls back if its audit record cannot be stored", async () => {
  const { env, database } = makeTestEnv();
  await env.DB.prepare(
    `CREATE TRIGGER reject_system_log BEFORE INSERT ON system_logs
     BEGIN SELECT RAISE(ABORT, 'audit storage unavailable'); END`
  ).run();
  const staged = await stageAdminChange(env, env.LILITH_USER_ID, {
    operation: "add_knowledge",
    scope: "general",
    title: "Atomic audit",
    content: "This must roll back with the log."
  });
  await assert.rejects(confirmPendingAction(env, env.LILITH_USER_ID, staged.pendingAction.id), /audit storage unavailable/);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM general_kn").get()?.count, 0);
});

test("R2 uploads validate image bytes and media reads remain identity-gated", async () => {
  const { env, database } = makeTestEnv();
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const media = await storePrivateMedia(env, env.ASTERION_USER_ID, "portrait.png", "image/png", png.buffer);
  assert.equal(database.prepare("SELECT owner_id FROM media_objects WHERE id = ?").get(media.id)?.owner_id, env.ASTERION_USER_ID);
  assert.equal(await getPrivateMedia(env, "100000000000000003", media.id), null);
  assert.ok(await getPrivateMedia(env, env.ASTERION_USER_ID, media.id));

  await env.DB.prepare(
    `INSERT INTO shop_storage(
       unique_id, category, title, description, price_rp, media_id, created_by
     ) VALUES ('PIN-1', 'pins', 'A pin', 'A picture pin.', 0, ?, ?)`
  ).bind(media.id, env.LILITH_USER_ID).run();
  assert.ok(await getPrivateMedia(env, "100000000000000003", media.id));
  await env.DB.prepare("UPDATE shop_storage SET active = 0 WHERE unique_id = 'PIN-1'").run();
  assert.equal(await getPrivateMedia(env, "100000000000000003", media.id), null);
  await assert.rejects(
    storePrivateMedia(env, env.ASTERION_USER_ID, "bad.png", "image/png", new Uint8Array([1, 2, 3]).buffer),
    /does not match/
  );
});

test("media operations stay unavailable without an R2 binding", async () => {
  const { env } = makeTestEnv();
  env.MEDIA = undefined;

  assert.deepEqual(await listShopMediaIds(env, env.ASTERION_USER_ID), []);
  assert.deepEqual(await listCollectionMediaIds(env, env.ASTERION_USER_ID), []);
  assert.equal(await getPrivateMedia(env, env.ASTERION_USER_ID, crypto.randomUUID()), null);
  await assert.rejects(
    storePrivateMedia(env, env.ASTERION_USER_ID, "portrait.png", "image/png", new ArrayBuffer(0)),
    /temporarily unavailable/
  );
});

test("chat rate limit caps requests per user without coupling users", async () => {
  const { env } = makeTestEnv();
  for (let attempt = 0; attempt < 6; attempt++) {
    assert.equal(await consumeChatRateLimit(env, env.ASTERION_USER_ID), true);
  }
  assert.equal(await consumeChatRateLimit(env, env.ASTERION_USER_ID), false);
  assert.equal(await consumeChatRateLimit(env, "100000000000000003"), true);
});

test("purchased collectibles populate their category-specific storage", async () => {
  const { env, database } = makeTestEnv();
  await env.DB.prepare("INSERT INTO rp_wallets(user_id, balance) VALUES (?, ?)")
    .bind(env.ASTERION_USER_ID, 100).run();
  await env.DB.prepare(
    `INSERT INTO shop_storage(
       unique_id, category, title, description, price_rp, opt_story,
       duration_minutes, created_by
     ) VALUES ('TRAIT-1', 'traits', 'Playful', 'A playful mode.', 10, 'Playfully cheerful', 30, ?)`
  ).bind(env.LILITH_USER_ID).run();
  await env.DB.prepare(
    "INSERT INTO purchases(shop_item_id, unique_id, item_title, price_paid, buyer_id) VALUES (1, 'TRAIT-1', 'Playful', 10, ?)"
  ).bind(env.ASTERION_USER_ID).run();
  assert.equal(database.prepare("SELECT personality_mode FROM traits").get()?.personality_mode, "Playfully cheerful");
  assert.equal(database.prepare("SELECT duration_minutes FROM traits").get()?.duration_minutes, 30);

  await env.DB.prepare(
    `INSERT INTO shop_storage(
       unique_id, category, title, description, price_rp, opt_name,
       duration_minutes, created_by
     ) VALUES ('TITLE-1', 'titles', 'Stargazer', 'An earned rank.', 0, 'Stargazer', NULL, ?)`
  ).bind(env.LILITH_USER_ID).run();
  await env.DB.prepare(
    "INSERT INTO purchases(shop_item_id, unique_id, item_title, price_paid, buyer_id) VALUES (2, 'TITLE-1', 'Stargazer', 0, ?)"
  ).bind(env.ASTERION_USER_ID).run();
  assert.equal(database.prepare("SELECT title_name FROM titles").get()?.title_name, "Stargazer");
  assert.equal(database.prepare("SELECT expires_at FROM titles").get()?.expires_at, null);
});
