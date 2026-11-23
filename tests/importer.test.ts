import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

test("legacy importer preserves source data and produces D1-compatible inserts", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "koryuu-import-test-"));
  const sourcePath = join(temporaryDirectory, "legacy.sqlite");
  const outputPath = join(temporaryDirectory, "legacy.sql");
  const source = new DatabaseSync(sourcePath);
  source.exec(`
    CREATE TABLE memories(id INTEGER PRIMARY KEY, title TEXT, content TEXT, category TEXT, created_by TEXT, created_at TEXT, archived INTEGER);
    CREATE TABLE shop_items(id INTEGER PRIMARY KEY, name TEXT, description TEXT, price INTEGER, active INTEGER, created_by TEXT, created_at TEXT);
    CREATE TABLE wallets(user_id TEXT PRIMARY KEY, balance INTEGER);
    CREATE TABLE rp_transactions(id INTEGER PRIMARY KEY, user_id TEXT, amount INTEGER, kind TEXT, note TEXT, actor_id TEXT, created_at TEXT);
    CREATE TABLE purchases(id INTEGER PRIMARY KEY, item_id INTEGER, item_name TEXT, price_paid INTEGER, buyer_id TEXT, created_at TEXT);
    CREATE TABLE system_logs(id INTEGER PRIMARY KEY, actor_id TEXT, action TEXT, details TEXT, created_at TEXT);
    INSERT INTO memories VALUES (1, 'Shared day', 'A remembered evening.', 'relationship', 'lilith', '2026-01-01', 0);
    INSERT INTO shop_items VALUES (1, 'A star pin', 'A silver star.', 25, 1, 'lilith', '2026-01-01');
    INSERT INTO wallets VALUES ('asterion', 75);
    INSERT INTO rp_transactions VALUES (1, 'asterion', 100, 'award', 'Starting points', 'lilith', '2026-01-01');
    INSERT INTO rp_transactions VALUES (2, 'asterion', -25, 'purchase', 'Bought A star pin', 'asterion', '2026-01-02');
    INSERT INTO purchases VALUES (1, 1, 'A star pin', 25, 'asterion', '2026-01-02');
    INSERT INTO system_logs VALUES (1, 'lilith', 'shop.add', '{}', '2026-01-01');
  `);
  source.close();

  try {
    execFileSync(process.execPath, [
      "--experimental-sqlite",
      "--import",
      "tsx",
      "src/import-sqlite.ts",
      sourcePath,
      outputPath
    ], { cwd: resolve("."), stdio: "pipe" });

    const target = new DatabaseSync(":memory:");
    target.exec(readFileSync("migrations/0001_initial.sql", "utf8"));
    target.exec(readFileSync(outputPath, "utf8"));

    assert.equal(target.prepare("SELECT balance FROM rp_wallets WHERE user_id = 'asterion'").get()?.balance, 75);
    assert.equal(target.prepare("SELECT title FROM memories WHERE id = 1").get()?.title, "Shared day");
    assert.equal(target.prepare("SELECT status FROM shop_storage WHERE id = 1").get()?.status, "sold");
    assert.equal(target.prepare("SELECT COUNT(*) AS count FROM purchases").get()?.count, 1);
    assert.equal(target.prepare("SELECT COUNT(*) AS count FROM astri_collection").get()?.count, 1);
    assert.equal(target.prepare("SELECT amount FROM rp_transactions WHERE id = 1").get()?.amount, 100);
    target.close();

    const unchanged = new DatabaseSync(sourcePath, { readOnly: true });
    assert.equal(unchanged.prepare("SELECT balance FROM wallets WHERE user_id = 'asterion'").get()?.balance, 75);
    unchanged.close();
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

