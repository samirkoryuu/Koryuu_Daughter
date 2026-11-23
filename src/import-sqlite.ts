import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

type Row = Record<string, SQLInputValue>;

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  throw new Error("Usage: npm run import:sqlite -- <existing-sqlite-file> <output-sql-file>");
}

const inputPath = resolve(inputArg);
const outputPath = resolve(outputArg);
const source = new DatabaseSync(inputPath, { readOnly: true });

function tableExists(name: string): boolean {
  return source.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) !== undefined;
}

function rows(name: string): Row[] {
  return tableExists(name) ? source.prepare(`SELECT * FROM "${name}"`).all() as Row[] : [];
}

function value(row: Row, name: string, fallback: SQLInputValue = null): SQLInputValue {
  return row[name] === undefined ? fallback : row[name];
}

function sqlValue(input: SQLInputValue): string {
  if (input === null) return "NULL";
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error("SQLite import found a non-finite numeric value.");
    return String(input);
  }
  if (typeof input === "bigint") return input.toString();
  if (typeof input === "boolean") return input ? "1" : "0";
  if (input instanceof Uint8Array) throw new Error("Binary SQLite fields are not supported by this importer.");
  return `'${String(input).replace(/'/g, "''")}'`;
}

function insert(table: string, columns: string[], values: SQLInputValue[]): string {
  return `INSERT INTO "${table}" (${columns.map(column => `"${column}"`).join(", ")}) VALUES (${values.map(sqlValue).join(", ")});`;
}

const memories = rows("memories");
const shopItems = rows("shop_items");
const wallets = rows("wallets");
const transactions = rows("rp_transactions");
const purchases = rows("purchases");
const logs = rows("system_logs");
if (![memories, shopItems, wallets, transactions, purchases, logs].some(list => list.length)) {
  source.close();
  throw new Error("The source database has no supported Koryuu tables or rows to import.");
}

const purchasedShopIds = new Set(purchases.map(row => Number(row.item_id)));
const statements: string[] = [
  "-- Generated from the legacy SQLite database. Run only against a fresh D1 database.",
  "-- Keep this file private: it contains the source database's stored records."
];

for (const row of memories) {
  statements.push(insert("memories", [
    "id", "title", "content", "category", "created_by", "created_at", "archived"
  ], [
    value(row, "id"), value(row, "title", ""), value(row, "content", ""),
    value(row, "category", "general"), value(row, "created_by", ""),
    value(row, "created_at"), value(row, "archived", 0)
  ]));
}

for (const row of shopItems) {
  const id = Number(value(row, "id", 0));
  const wasPurchased = purchasedShopIds.has(id);
  statements.push(insert("shop_storage", [
    "id", "unique_id", "category", "title", "description", "price_rp",
    "status", "active", "created_by", "created_at"
  ], [
    id, `LEGACY-SHOP-${id}`, "memories", value(row, "name", ""),
    value(row, "description", ""), value(row, "price", 0),
    wasPurchased ? "sold" : "on_sell", value(row, "active", 1),
    value(row, "created_by", ""), value(row, "created_at")
  ]));
}

for (const row of wallets) {
  statements.push(insert("rp_wallets", ["user_id", "balance"], [
    value(row, "user_id", ""), value(row, "balance", 0)
  ]));
}

for (const row of transactions) {
  statements.push(insert("rp_transactions", [
    "id", "user_id", "amount", "kind", "note", "actor_id", "legacy_import", "created_at"
  ], [
    value(row, "id"), value(row, "user_id", ""), value(row, "amount", 0),
    value(row, "kind", "award"), value(row, "note", ""), value(row, "actor_id", ""),
    1, value(row, "created_at")
  ]));
}

const shopById = new Map(shopItems.map(row => [Number(value(row, "id", 0)), row]));
for (const row of purchases) {
  const purchaseId = Number(value(row, "id", 0));
  const itemId = Number(value(row, "item_id", 0));
  const shop = shopById.get(itemId);
  if (!shop) throw new Error(`Legacy purchase ${purchaseId} refers to missing shop item ${itemId}.`);
  const uniqueId = `LEGACY-PURCHASE-${purchaseId}`;
  const itemName = value(row, "item_name", value(shop, "name", ""));
  const price = value(row, "price_paid", value(shop, "price", 0));
  const acquiredAt = value(row, "created_at");
  statements.push(insert("purchases", [
    "id", "shop_item_id", "unique_id", "item_title", "price_paid",
    "buyer_id", "legacy_import", "created_at"
  ], [
    purchaseId, itemId, uniqueId, itemName, price,
    value(row, "buyer_id", ""), 1, acquiredAt
  ]));
  statements.push(insert("astri_collection", [
    "shop_item_id", "unique_id", "category", "title", "description",
    "price_paid", "acquired_at"
  ], [
    itemId, `LEGACY-OWNED-${purchaseId}`, "memories", itemName,
    value(shop, "description", ""), price, acquiredAt
  ]));
}

for (const row of logs) {
  statements.push(insert("system_logs", [
    "id", "actor_id", "action", "details", "created_at"
  ], [
    value(row, "id"), value(row, "actor_id", ""), value(row, "action", ""),
    value(row, "details", "{}"), value(row, "created_at")
  ]));
}

source.close();
writeFileSync(outputPath, `${statements.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
console.log(`Created ${outputPath}. Review it, then apply it once to a fresh D1 database.`);
