import type { D1PreparedStatement, D1Result, Env } from "./platform.js";
import { persistentTurnStatements, pruneClientMemoryAfterTurn } from "./message-archive.js";

const CHAT_TTL_MS = 5 * 60 * 1000;
const ACTION_TTL_MS = 2 * 60 * 1000;
const ADMIN_SESSION_MS = 15 * 60 * 1000;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const MAX_AUTH_ATTEMPTS = 5;
const CHAT_RATE_WINDOW_MS = 30 * 1000;
const MAX_CHAT_REQUESTS_PER_WINDOW = 6;

type KnowledgeScope = "general" | "relationship";
type TokenType = "date" | "food" | "visual" | "creative";
type ShopCategory = "memories" | "pins" | "traits" | "tokens" | "letters" | "portraits" | "titles";

interface KnowledgeRow {
  id: number;
  title: string;
  content: string;
  tags: string;
}

interface StatusRow {
  name: string | null;
  true_name: string | null;
  title_name: string | null;
  title: string | null;
  partner: string | null;
  relationship_since: string | null;
  account_created: string | null;
  relationship_level: number;
  status: string;
}

interface ShopItem {
  id: number;
  unique_id: string;
  category: ShopCategory;
  title: string;
  description: string;
  price_rp: number;
  opt_story: string | null;
  opt_link: string | null;
  opt_name: string | null;
  token_type: TokenType | null;
  token_amount: number;
  duration_minutes: number | null;
  r2_key: string | null;
}

interface AdminOperation {
  operation: string;
  [key: string]: unknown;
}

function nowIso(): string {
  return new Date().toISOString();
}

function logAction(env: Env, actorId: string, action: string, details: unknown): Promise<unknown> {
  return env.DB.prepare(
    "INSERT INTO system_logs(actor_id, action, details) VALUES (?, ?, ?)"
  ).bind(actorId, action, JSON.stringify(details)).run();
}

async function runAudited(
  env: Env,
  actorId: string,
  action: string,
  details: unknown,
  mutation: D1PreparedStatement
): Promise<D1Result> {
  const [result] = await env.DB.batch([
    mutation,
    env.DB.prepare(
      "INSERT INTO system_logs(actor_id, action, details) VALUES (?, ?, ?)"
    ).bind(actorId, action, JSON.stringify(details))
  ]);
  if (!result?.success) throw new Error("The audited operation did not complete successfully.");
  return result;
}

export function isAsterion(env: Env, actorId: string): boolean {
  return actorId === env.ASTERION_USER_ID;
}

export async function assertAsterion(env: Env, actorId: string): Promise<void> {
  if (!isAsterion(env, actorId)) throw new Error("This private record is only available to Asterion.");
}

async function ensureWallet(env: Env, userId: string): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO rp_wallets(user_id, balance) VALUES (?, 0)")
    .bind(userId).run();
}

async function getBalance(env: Env, userId: string): Promise<number> {
  await ensureWallet(env, userId);
  const row = await env.DB.prepare("SELECT balance FROM rp_wallets WHERE user_id = ?")
    .bind(userId).first<{ balance: number }>();
  if (!row) throw new Error("Could not load RP balance.");
  return row.balance;
}

export async function getVisibleBalance(env: Env, actorId: string): Promise<number> {
  if (actorId !== env.ASTERION_USER_ID && actorId !== env.LILITH_USER_ID) {
    throw new Error("I don't recognize your identity. Access denied.");
  }
  return getBalance(env, actorId);
}

function relevantTerms(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])].slice(0, 6);
}

async function knowledgeRows(
  env: Env,
  table: "general_kn" | "relationship_kn",
  question: string
): Promise<KnowledgeRow[]> {
  const terms = relevantTerms(question);
  if (!terms.length) {
    const result = await env.DB.prepare(
      `SELECT id, title, content, tags FROM ${table} WHERE active = 1 ORDER BY updated_at DESC LIMIT 6`
    ).all<KnowledgeRow>();
    return result.results;
  }
  const conditions = terms.map(() => "(title LIKE ? OR content LIKE ? OR tags LIKE ?)").join(" OR ");
  const bindings = terms.flatMap(term => {
    const like = `%${term}%`;
    return [like, like, like];
  });
  const result = await env.DB.prepare(
    `SELECT id, title, content, tags FROM ${table}
     WHERE active = 1 AND (${conditions})
     ORDER BY updated_at DESC LIMIT 6`
  ).bind(...bindings).all<KnowledgeRow>();
  return result.results;
}

export async function buildKnowledgeContext(
  env: Env,
  actorId: string,
  question: string,
  includePrivateRelationship = true
): Promise<string> {
  const general = await knowledgeRows(env, "general_kn", question);
  const blocks = general.map(row => `General knowledge — ${row.title}:\n${row.content}`);

  if (isAsterion(env, actorId) && includePrivateRelationship) {
    const relationship = await knowledgeRows(env, "relationship_kn", question);
    blocks.push(...relationship.map(row => `Private relationship knowledge — ${row.title}:\n${row.content}`));
  }
  return blocks.join("\n\n");
}

export async function buildAsterionContext(env: Env, actorId: string): Promise<string> {
  await assertAsterion(env, actorId);
  const [status, relationshipStats, collectionStats, memories] = await Promise.all([
    env.DB.prepare("SELECT * FROM status_astri WHERE id = 1").first<StatusRow>(),
    getRelationshipStatistics(env, actorId),
    getCollectionStatistics(env, actorId),
    listMemories(env, actorId)
  ]);
  if (!status) throw new Error("Asterion's profile record is missing.");

  const profile = [
    `Name: ${status.name ?? "Not set"}`,
    `True name: ${status.true_name ?? "Not set"}`,
    `Title name: ${status.title_name ?? "Not set"}`,
    `Title: ${status.title ?? "Not set"}`,
    `Partner: ${status.partner ?? "Not set"}`,
    `Relationship since: ${status.relationship_since ?? "Not set"}`,
    `Account created: ${status.account_created ?? "Not set"}`,
    `Relationship level: ${status.relationship_level}`,
    `Status: ${status.status}`
  ].join("\n");
  const activeTrait = await getActiveTraitContext(env, actorId);
  return [
    `Asterion profile:\n${profile}`,
    `Relationship statistics:\n${relationshipStats}`,
    `Collection statistics:\n${collectionStats}`,
    memories ? `Shared memories:\n${memories}` : "",
    activeTrait ? `Current temporary personality mode:\n${activeTrait}` : ""
  ].filter(Boolean).join("\n\n");
}

export async function getActiveTraitContext(env: Env, actorId: string): Promise<string> {
  await assertAsterion(env, actorId);
  const row = await env.DB.prepare(
    `SELECT t.personality_mode
     FROM active_traits a JOIN traits t ON t.collection_id = a.collection_id
     WHERE a.id = 1 AND a.expires_at > ?`
  ).bind(nowIso()).first<{ personality_mode: string }>();
  return row?.personality_mode ?? "";
}

export async function getDreamprint(env: Env, actorId: string): Promise<string> {
  await assertAsterion(env, actorId);
  const status = await env.DB.prepare("SELECT * FROM status_astri WHERE id = 1")
    .first<StatusRow>();
  if (!status) throw new Error("Asterion's profile record is missing.");
  return [
    "**KORYUU // DREAMPRINT**",
    `Name: ${status.name ?? "Not set"}`,
    `True Name: ${status.true_name ?? "Not set"}`,
    `Title Name: ${status.title_name ?? "Not set"}`,
    `Title: ${status.title ?? "Not set"}`,
    `Partner: ${status.partner ?? "Not set"}`,
    `Relationship Since: ${status.relationship_since ?? "Not set"}`,
    `Account Created: ${status.account_created ?? "Not set"}`,
    `Relationship Level: ${status.relationship_level}`,
    `Status: ${status.status}`
  ].join("\n");
}

export async function getRelationshipStatistics(env: Env, actorId: string): Promise<string> {
  await assertAsterion(env, actorId);
  const [wallet, totals, missions, milestones] = await Promise.all([
    getBalance(env, actorId),
    env.DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS earned,
         COALESCE(SUM(CASE WHEN kind = 'purchase' THEN -amount ELSE 0 END), 0) AS spent
       FROM rp_transactions WHERE user_id = ?`
    ).bind(actorId).first<{ earned: number; spent: number }>(),
    env.DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
         COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending
       FROM mission_completions WHERE user_id = ?`
    ).bind(actorId).first<{ completed: number; pending: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM relationship_milestones WHERE achieved_at IS NOT NULL"
    ).first<{ count: number }>()
  ]);
  return [
    "Relationship Statistics",
    `Relationship Level: ${await getRelationshipLevel(env)}`,
    `Total RP Earned: ${totals?.earned ?? 0}`,
    `Available RP: ${wallet}`,
    `Total RP Spent: ${totals?.spent ?? 0}`,
    `Missions Completed: ${missions?.completed ?? 0}`,
    `Missions Pending: ${missions?.pending ?? 0}`,
    `Rewards Redeemed: ${await countPurchases(env, actorId)}`,
    `Relationship Milestones: ${milestones?.count ?? 0}`
  ].join("\n");
}

async function getRelationshipLevel(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT relationship_level FROM status_astri WHERE id = 1"
  ).first<{ relationship_level: number }>();
  return row?.relationship_level ?? 1;
}

async function countPurchases(env: Env, actorId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM purchases WHERE buyer_id = ?")
    .bind(actorId).first<{ count: number }>();
  return row?.count ?? 0;
}

export async function getCollectionStatistics(env: Env, actorId: string): Promise<string> {
  await assertAsterion(env, actorId);
  const [counts, tokens, traits] = await Promise.all([
    env.DB.prepare(
      `SELECT c.category, COUNT(*) AS count FROM astri_collection c
       LEFT JOIN titles t ON t.collection_id = c.id
       WHERE c.category != 'titles' OR t.expires_at IS NULL OR t.expires_at > CURRENT_TIMESTAMP
       GROUP BY c.category`
    ).all<{ category: string; count: number }>(),
    env.DB.prepare(
      `SELECT 'date' AS token_type, COALESCE(SUM(quantity), 0) AS quantity FROM date_tokens
       UNION ALL SELECT 'food', COALESCE(SUM(quantity), 0) FROM food_tokens
       UNION ALL SELECT 'visual', COALESCE(SUM(quantity), 0) FROM visual_tokens
       UNION ALL SELECT 'creative', COALESCE(SUM(quantity), 0) FROM creative_tokens`
    ).all<{ token_type: string; quantity: number }>(),
    env.DB.prepare(
      "SELECT title FROM astri_collection WHERE category = 'traits' ORDER BY acquired_at DESC LIMIT 10"
    ).all<{ title: string }>()
  ]);
  const countFor = (category: string) => counts.results.find(row => row.category === category)?.count ?? 0;
  const tokenInventory = tokens.results.map(row => `${row.token_type}: ${row.quantity}`).join(", ");
  const previousTraits = traits.results.map(row => row.title).join(", ") || "None";
  return [
    "Collection Statistics",
    `Memories: ${countFor("memories")}`,
    `Pins: ${countFor("pins")}`,
    `Letters: ${countFor("letters")}`,
    `Titles: ${countFor("titles")}`,
    `Portraits: ${countFor("portraits")}`,
    `Tokens: ${tokenInventory}`,
    `Previously unlocked traits: ${previousTraits}`
  ].join("\n");
}

export async function getAchievements(env: Env, actorId: string): Promise<string> {
  await assertAsterion(env, actorId);
  const rows = await env.DB.prepare(
    `SELECT a.title, a.description, aa.awarded_at
     FROM achievement_awards aa JOIN achievements a ON a.id = aa.achievement_id
     WHERE aa.user_id = ? ORDER BY aa.awarded_at DESC`
  ).bind(actorId).all<{ title: string; description: string; awarded_at: string }>();
  if (!rows.results.length) return "No achievements have been recorded yet.";
  return rows.results.map(item => `**${item.title}** — ${item.description} (${item.awarded_at})`).join("\n");
}

export async function listMemories(env: Env, actorId: string): Promise<string> {
  await assertAsterion(env, actorId);
  const rows = await env.DB.prepare(
    `SELECT id, title, content, category, created_at FROM memories
     WHERE archived = 0 ORDER BY id DESC LIMIT 10`
  ).all<{ id: number; title: string; content: string; category: string; created_at: string }>();
  return rows.results.map(memory =>
    `#${memory.id} **${memory.title}** [${memory.category}]\n${memory.content}`
  ).join("\n\n").slice(0, 5000);
}

export async function listShopMediaIds(env: Env, _actorId: string): Promise<string[]> {
  if (!env.MEDIA) return [];
  const rows = await env.DB.prepare(
    `SELECT media_id FROM shop_storage WHERE status = 'on_sell' AND active = 1
     AND media_id IS NOT NULL ORDER BY category, id LIMIT 3`
  ).all<{ media_id: string }>();
  return rows.results.map(row => row.media_id);
}

export async function listShop(env: Env, actorId: string): Promise<string> {
  const rows = await env.DB.prepare(
    `SELECT unique_id, category, title, description, price_rp, opt_name, token_type
     FROM shop_storage WHERE status = 'on_sell' AND active = 1 ORDER BY category, id LIMIT 25`
  ).all<Pick<ShopItem, "unique_id" | "category" | "title" | "description" | "price_rp" | "opt_name" | "token_type">>();
  if (!rows.results.length) return "The Koryuu shop has no items currently on sale.";
  return rows.results.map(item =>
    `**${item.opt_name ?? item.title}** · ${item.price_rp} RP [${item.category}${item.token_type ? `/${item.token_type}` : ""}] · ID \`${item.unique_id}\`\n${item.description}`
  ).join("\n\n").slice(0, 1850);
}

export async function listCollection(env: Env, actorId: string): Promise<string> {
  await assertAsterion(env, actorId);
  const rows = await env.DB.prepare(
    `SELECT unique_id, category, title, description, acquired_at, r2_key
     FROM astri_collection ORDER BY acquired_at DESC LIMIT 30`
  ).all<{ unique_id: string; category: string; title: string; description: string; acquired_at: string; r2_key: string | null }>();
  if (!rows.results.length) return "Your collection is currently empty.";
  return rows.results.map(item =>
    `**${item.title}** [${item.category}] · \`${item.unique_id}\` — ${item.description}${item.r2_key ? " [image attached when available]" : ""}`
  ).join("\n").slice(0, 1850);
}

export async function listCollectionMediaIds(env: Env, actorId: string): Promise<string[]> {
  await assertAsterion(env, actorId);
  if (!env.MEDIA) return [];
  const rows = await env.DB.prepare(
    `SELECT media_id FROM astri_collection
     WHERE media_id IS NOT NULL ORDER BY acquired_at DESC LIMIT 3`
  ).all<{ media_id: string }>();
  return rows.results.map(row => row.media_id);
}

async function createPendingAction(
  env: Env,
  actorId: string,
  actionType: string,
  payload: unknown,
  label: string
): Promise<{ id: string; label: string }> {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  await env.DB.prepare(
    `INSERT INTO pending_actions(id, actor_id, action_type, payload, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    actorId,
    actionType,
    JSON.stringify(payload),
    new Date(createdAt).toISOString(),
    new Date(createdAt + ACTION_TTL_MS).toISOString()
  ).run();
  return { id, label };
}

export async function stagePurchase(
  env: Env,
  actorId: string,
  uniqueId: string,
  guildId: string | null = null
): Promise<{ pendingAction: { id: string; label: string }; preview: string }> {
  await assertAsterion(env, actorId);
  if (guildId !== null && !/^\d{17,20}$/.test(guildId)) {
    throw new Error("The purchase guild ID is invalid.");
  }
  const item = await env.DB.prepare(
    `SELECT unique_id, title, price_rp, status FROM shop_storage WHERE unique_id = ? AND active = 1`
  ).bind(uniqueId.trim()).first<{ unique_id: string; title: string; price_rp: number; status: string }>();
  if (!item || item.status !== "on_sell") throw new Error("That item is not currently for sale.");
  const balance = await getBalance(env, actorId);
  if (balance < item.price_rp) throw new Error(`Not enough RP. You have ${balance}; this item costs ${item.price_rp}.`);
  const pendingAction = await createPendingAction(env, actorId, "purchase", {
    uniqueId: item.unique_id,
    title: item.title,
    price: item.price_rp,
    guildId
  }, item.title);
  return {
    pendingAction,
    preview: `Purchase **${item.title}** for ${item.price_rp} RP? Your current balance is ${balance} RP.`
  };
}

async function isAdmin(env: Env, actorId: string): Promise<boolean> {
  if (actorId === env.LILITH_USER_ID) return true;
  const row = await env.DB.prepare(
    "SELECT 1 AS authorized FROM admin_sessions WHERE user_id = ? AND expires_at > ?"
  ).bind(actorId, nowIso()).first<{ authorized: number }>();
  return row !== null;
}

export async function hasAdminAccess(env: Env, actorId: string): Promise<boolean> {
  return isAdmin(env, actorId);
}

export async function hasActiveAdminTicket(
  env: Env,
  actorId: string,
  guildId: string,
  channelId: string
): Promise<boolean> {
  const now = nowIso();
  const ticket = await env.DB.prepare(
    `SELECT 1 AS active FROM temporary_admin_access
     WHERE user_id = ? AND guild_id = ? AND channel_id = ? AND expires_at > ?`
  ).bind(actorId, guildId, channelId, now).first<{ active: number }>();
  return ticket !== null && await isAdmin(env, actorId);
}

function requireString(value: unknown, name: string, maxLength = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${name} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

function requireInteger(value: unknown, name: string, minimum = 0): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < minimum) {
    throw new Error(`${name} must be a whole number greater than or equal to ${minimum}.`);
  }
  return Number(parsed);
}

function parseAdminOperation(input: unknown): AdminOperation {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid administrator operation.");
  const operation = (input as Record<string, unknown>).operation;
  if (typeof operation !== "string") throw new Error("Administrator operation is missing.");
  return input as AdminOperation;
}

export async function stageAdminChange(
  env: Env,
  actorId: string,
  input: unknown,
  isDm = true
): Promise<{ pendingAction: { id: string; label: string }; preview: string }> {
  if (!isDm) throw new Error("Administrator changes can only be staged in a direct message.");
  if (!(await isAdmin(env, actorId))) throw new Error("Administrator access is required.");
  const operation = parseAdminOperation(input);
  const serializedOperation = JSON.stringify(operation);
  if (serializedOperation.length > 1100) {
    throw new Error("This change is too large to safely preview in Discord. Split it into smaller changes.");
  }
  const label = operation.operation.replaceAll("_", " ");
  const pendingAction = await createPendingAction(env, actorId, "admin", operation, label);
  const previewDetails = serializedOperation.replace(/`/g, "\\u0060");
  return {
    pendingAction,
    preview: `Administrator change requested (**${label}**):\n\`\`\`json\n${previewDetails}\n\`\`\`\nConfirm only if these exact details are correct.`
  };
}

export async function cancelPendingAction(
  env: Env,
  actorId: string,
  actionId: string
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE pending_actions SET status = 'cancelled'
     WHERE id = ? AND actor_id = ? AND status = 'pending' AND expires_at > ?`
  ).bind(actionId, actorId, nowIso()).run();
  if (result.meta?.changes !== 1) throw new Error("This confirmation is no longer available.");
}

async function applyAdminOperation(env: Env, actorId: string, input: unknown): Promise<string> {
  if (!(await isAdmin(env, actorId))) throw new Error("Administrator authorization expired; authenticate again.");
  const operation = parseAdminOperation(input);

  switch (operation.operation) {
    case "add_knowledge": {
      const scope = operation.scope;
      if (scope !== "general" && scope !== "relationship") throw new Error("Knowledge scope must be general or relationship.");
      const title = requireString(operation.title, "Title", 200);
      const content = requireString(operation.content, "Content", 10000);
      const tags = typeof operation.tags === "string" ? operation.tags.slice(0, 500) : "";
      const table = scope === "general" ? "general_kn" : "relationship_kn";
      await runAudited(
        env, actorId, "knowledge.add", { scope, title },
        env.DB.prepare(`INSERT INTO ${table}(title, content, tags, created_by) VALUES (?, ?, ?, ?)`)
          .bind(title, content, tags, actorId)
      );
      return `Added ${scope} knowledge “${title}”.`;
    }
    case "add_memory": {
      const title = requireString(operation.title, "Memory title", 200);
      const content = requireString(operation.content, "Memory content", 10000);
      const category = typeof operation.category === "string" ? operation.category.slice(0, 100) : "general";
      await runAudited(
        env, actorId, "memory.add", { title, category },
        env.DB.prepare(
          "INSERT INTO memories(title, content, category, created_by) VALUES (?, ?, ?, ?)"
        ).bind(title, content, category || "general", actorId)
      );
      return `Added shared memory “${title}”.`;
    }
    case "update_memory": {
      const id = requireInteger(operation.id, "Memory ID", 1);
      const title = requireString(operation.title, "Memory title", 200);
      const content = requireString(operation.content, "Memory content", 10000);
      const category = typeof operation.category === "string" ? operation.category.slice(0, 100) : "general";
      const result = await runAudited(
        env, actorId, "memory.update", { id, title, category },
        env.DB.prepare(
          `UPDATE memories SET title = ?, content = ?, category = ?
           WHERE id = ? AND archived = 0`
        ).bind(title, content, category || "general", id)
      );
      if (result.meta?.changes !== 1) throw new Error("Active memory not found.");
      return `Updated shared memory #${id}.`;
    }
    case "archive_memory": {
      const id = requireInteger(operation.id, "Memory ID", 1);
      const result = await runAudited(
        env, actorId, "memory.archive", { id },
        env.DB.prepare("UPDATE memories SET archived = 1 WHERE id = ? AND archived = 0").bind(id)
      );
      if (result.meta?.changes !== 1) throw new Error("Active memory not found.");
      return `Archived shared memory #${id}.`;
    }
    case "update_knowledge": {
      const scope = operation.scope;
      if (scope !== "general" && scope !== "relationship") throw new Error("Knowledge scope must be general or relationship.");
      const id = requireInteger(operation.id, "Knowledge ID", 1);
      const title = requireString(operation.title, "Title", 200);
      const content = requireString(operation.content, "Content", 10000);
      const tags = typeof operation.tags === "string" ? operation.tags.slice(0, 500) : "";
      const table = scope === "general" ? "general_kn" : "relationship_kn";
      const result = await runAudited(
        env, actorId, "knowledge.update", { scope, id, title },
        env.DB.prepare(
          `UPDATE ${table} SET title = ?, content = ?, tags = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND active = 1`
        ).bind(title, content, tags, id)
      );
      if (result.meta?.changes !== 1) throw new Error("Active knowledge record not found.");
      return `Updated ${scope} knowledge #${id}.`;
    }
    case "archive_knowledge": {
      const scope = operation.scope;
      if (scope !== "general" && scope !== "relationship") throw new Error("Knowledge scope must be general or relationship.");
      const id = requireInteger(operation.id, "Knowledge ID", 1);
      const table = scope === "general" ? "general_kn" : "relationship_kn";
      const result = await runAudited(
        env, actorId, "knowledge.archive", { scope, id },
        env.DB.prepare(
          `UPDATE ${table} SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND active = 1`
        ).bind(id)
      );
      if (result.meta?.changes !== 1) throw new Error("Active knowledge record not found.");
      return `Archived ${scope} knowledge #${id}.`;
    }
    case "add_shop_item": {
      const category = operation.category;
      const categories: ShopCategory[] = ["memories", "pins", "traits", "tokens", "letters", "portraits", "titles"];
      if (typeof category !== "string" || !categories.includes(category as ShopCategory)) {
        throw new Error("Unknown shop category.");
      }
      const tokenType = operation.token_type;
      if (category === "tokens" && !["date", "food", "visual", "creative"].includes(String(tokenType))) {
        throw new Error("Token items require a date, food, visual, or creative token type.");
      }
      if (category !== "tokens" && tokenType != null) throw new Error("Only token items may specify a token type.");
      const uniqueId = requireString(operation.unique_id, "Unique ID", 100);
      const title = requireString(operation.title, "Title", 200);
      const description = requireString(operation.description, "Description", 3000);
      const price = requireInteger(operation.price_rp, "Price");
      const tokenAmount = category === "tokens" ? requireInteger(operation.token_amount ?? 1, "Token amount", 1) : 1;
      const durationMinutes = category === "traits"
        ? requireInteger(operation.duration_minutes, "Trait duration", 1)
        : category === "titles" && operation.duration_minutes != null
          ? requireInteger(operation.duration_minutes, "Title duration", 1)
          : null;
      if (durationMinutes !== null && durationMinutes > 10080) {
        throw new Error("Trait or title duration cannot exceed 10080 minutes (7 days).");
      }
      const mediaId = operation.media_id == null ? null : requireString(operation.media_id, "Media ID", 36);
      if ((category === "pins" || category === "portraits") && !mediaId) {
        throw new Error("Pin and portrait items require a private uploaded image.");
      }
      let r2Key: string | null = null;
      if (mediaId) {
        const media = await env.DB.prepare(
          "SELECT r2_key, owner_id FROM media_objects WHERE id = ?"
        ).bind(mediaId).first<{ r2_key: string; owner_id: string }>();
        if (!media || (media.owner_id !== actorId && actorId !== env.LILITH_USER_ID)) {
          throw new Error("That image is not available to this administrator.");
        }
        r2Key = media.r2_key;
      }
      await runAudited(
        env, actorId, "shop.add", { uniqueId, category, title, price },
        env.DB.prepare(
          `INSERT INTO shop_storage(
             unique_id, category, title, description, price_rp, opt_story, opt_link,
             opt_name, token_type, token_amount, duration_minutes, media_id, r2_key, created_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          uniqueId,
          category,
          title,
          description,
          price,
          typeof operation.opt_story === "string" ? operation.opt_story.slice(0, 5000) : null,
          typeof operation.opt_link === "string" ? operation.opt_link.slice(0, 2000) : null,
          typeof operation.opt_name === "string" ? operation.opt_name.slice(0, 200) : null,
          category === "tokens" ? tokenType : null,
          tokenAmount,
          durationMinutes,
          mediaId,
          r2Key,
          actorId
        )
      );
      return `Added **${title}** to the shop with ID \`${uniqueId}\`.`;
    }
    case "update_shop_item": {
      const uniqueId = requireString(operation.unique_id, "Unique ID", 100);
      const title = requireString(operation.title, "Title", 200);
      const description = requireString(operation.description, "Description", 3000);
      const price = requireInteger(operation.price_rp, "Price");
      const optStory = typeof operation.opt_story === "string" ? operation.opt_story.slice(0, 5000) : null;
      const optLink = typeof operation.opt_link === "string" ? operation.opt_link.slice(0, 2000) : null;
      const optName = typeof operation.opt_name === "string" ? operation.opt_name.slice(0, 200) : null;
      const result = await runAudited(
        env, actorId, "shop.update", { uniqueId, title, price },
        env.DB.prepare(
          `UPDATE shop_storage SET title = ?, description = ?, price_rp = ?,
             opt_story = ?, opt_link = ?, opt_name = ? WHERE unique_id = ? AND status = 'on_sell' AND active = 1`
        ).bind(title, description, price, optStory, optLink, optName, uniqueId)
      );
      if (result.meta?.changes !== 1) throw new Error("Active on-sale item not found.");
      return `Updated on-sale item \`${uniqueId}\`.`;
    }
    case "deactivate_shop_item": {
      const uniqueId = requireString(operation.unique_id, "Unique ID", 100);
      const result = await runAudited(
        env, actorId, "shop.deactivate", { uniqueId },
        env.DB.prepare(
          `UPDATE shop_storage SET active = 0 WHERE unique_id = ? AND status = 'on_sell' AND active = 1`
        ).bind(uniqueId)
      );
      if (result.meta?.changes !== 1) throw new Error("Active on-sale item not found.");
      return `Removed item \`${uniqueId}\` from the shop.`;
    }
    case "relist_shop_item": {
      const uniqueId = requireString(operation.unique_id, "Unique ID", 100);
      const result = await runAudited(
        env, actorId, "shop.relist", { uniqueId },
        env.DB.prepare(
          `UPDATE shop_storage SET active = 1 WHERE unique_id = ? AND status = 'on_sell' AND active = 0`
        ).bind(uniqueId)
      );
      if (result.meta?.changes !== 1) throw new Error("Only previously removed, unsold items can be relisted.");
      return `Relisted item \`${uniqueId}\`.`;
    }
    case "activate_trait": {
      const uniqueId = requireString(operation.unique_id, "Trait unique ID", 100);
      const row = await env.DB.prepare(
        `SELECT c.id, t.duration_minutes FROM astri_collection c
         JOIN traits t ON t.collection_id = c.id WHERE c.unique_id = ?`
      ).bind(uniqueId).first<{ id: number; duration_minutes: number }>();
      if (!row) throw new Error("That trait is not in Asterion's collection.");
      const minutes = operation.duration_minutes == null
        ? row.duration_minutes
        : requireInteger(operation.duration_minutes, "Activation duration", 1);
      if (minutes > row.duration_minutes || minutes > 10080) {
        throw new Error("Activation duration cannot exceed the trait's configured duration.");
      }
      const startedAt = Date.now();
      const expiresAt = new Date(startedAt + minutes * 60 * 1000).toISOString();
      await runAudited(
        env, actorId, "trait.activate", { uniqueId, minutes, expiresAt },
        env.DB.prepare(
          `INSERT INTO active_traits(id, collection_id, activated_by, started_at, expires_at)
           VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET collection_id = excluded.collection_id,
             activated_by = excluded.activated_by, started_at = excluded.started_at, expires_at = excluded.expires_at`
        ).bind(row.id, actorId, new Date(startedAt).toISOString(), expiresAt)
      );
      return `Activated trait \`${uniqueId}\` for ${minutes} minutes.`;
    }
    case "deactivate_trait": {
      await runAudited(
        env, actorId, "trait.deactivate", {},
        env.DB.prepare("DELETE FROM active_traits WHERE id = 1")
      );
      return "Deactivated the current temporary trait.";
    }
    case "update_status": {
      const allowedFields: Record<string, string> = {
        name: "name",
        true_name: "true_name",
        title_name: "title_name",
        title: "title",
        partner: "partner",
        relationship_since: "relationship_since",
        account_created: "account_created",
        relationship_level: "relationship_level",
        status: "status"
      };
      const field = operation.field;
      if (typeof field !== "string" || !(field in allowedFields)) throw new Error("Unknown Asterion profile field.");
      const value = field === "relationship_level"
        ? requireInteger(operation.value, "Relationship level", 1)
        : requireString(operation.value, "Profile value", 500);
      if (field === "status" && (typeof value !== "string" || !["active", "away", "offline"].includes(value))) {
        throw new Error("Status must be active, away, or offline.");
      }
      await runAudited(
        env, actorId, "status.update", { field, value },
        env.DB.prepare(
          `UPDATE status_astri SET ${allowedFields[field]} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`
        ).bind(value)
      );
      return `Updated Asterion's ${field.replaceAll("_", " ")}.`;
    }
    case "award_rp":
    case "deduct_rp": {
      const userId = requireString(operation.user_id, "User ID", 30);
      if (userId !== env.ASTERION_USER_ID && userId !== env.LILITH_USER_ID) {
        throw new Error("RP can only be changed for the configured users.");
      }
      const amount = requireInteger(operation.amount, "Amount", 1);
      const note = requireString(operation.note, "Reason", 1000);
      const kind = operation.operation === "award_rp" ? "award" : "deduction";
      await ensureWallet(env, userId);
      await runAudited(
        env, actorId, "rp.change", { userId, amount, kind, note },
        env.DB.prepare(
          `INSERT INTO rp_transactions(user_id, amount, kind, note, actor_id)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(userId, kind === "award" ? amount : -amount, kind, note, actorId)
      );
      return `${kind === "award" ? "Awarded" : "Deducted"} ${amount} RP. New balance: ${await getBalance(env, userId)} RP.`;
    }
    case "create_mission": {
      const uniqueId = requireString(operation.unique_id, "Unique ID", 100);
      const title = requireString(operation.title, "Title", 200);
      const description = requireString(operation.description, "Description", 3000);
      await runAudited(
        env, actorId, "mission.create", { uniqueId, title },
        env.DB.prepare(
          "INSERT INTO missions(unique_id, title, description) VALUES (?, ?, ?)"
        ).bind(uniqueId, title, description)
      );
      return `Created mission **${title}**.`;
    }
    case "record_mission": {
      const uniqueId = requireString(operation.unique_id, "Mission ID", 100);
      const userId = requireString(operation.user_id, "User ID", 30);
      if (userId !== env.ASTERION_USER_ID) throw new Error("Mission progress can only be recorded for Asterion.");
      const status = operation.status;
      if (status !== "pending" && status !== "completed") throw new Error("Mission status must be pending or completed.");
      const result = await runAudited(
        env, actorId, "mission.record", { uniqueId, userId, status },
        env.DB.prepare(
          `INSERT INTO mission_completions(mission_id, user_id, status, completed_at)
           SELECT id, ?, ?, CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END
           FROM missions WHERE unique_id = ?
           ON CONFLICT(mission_id, user_id) DO UPDATE SET
             status = excluded.status, completed_at = excluded.completed_at`
        ).bind(userId, status, status, uniqueId)
      );
      if (result.meta?.changes !== 1) throw new Error("Mission not found.");
      return `Recorded mission \`${uniqueId}\` as ${status}.`;
    }
    case "create_achievement": {
      const uniqueId = requireString(operation.unique_id, "Unique ID", 100);
      const title = requireString(operation.title, "Title", 200);
      const description = requireString(operation.description, "Description", 3000);
      await runAudited(
        env, actorId, "achievement.create", { uniqueId, title },
        env.DB.prepare(
          "INSERT INTO achievements(unique_id, title, description) VALUES (?, ?, ?)"
        ).bind(uniqueId, title, description)
      );
      return `Created achievement **${title}**.`;
    }
    case "award_achievement": {
      const uniqueId = requireString(operation.unique_id, "Achievement ID", 100);
      const userId = requireString(operation.user_id, "User ID", 30);
      if (userId !== env.ASTERION_USER_ID) throw new Error("Achievements can only be awarded to Asterion.");
      const result = await runAudited(
        env, actorId, "achievement.award", { uniqueId, userId },
        env.DB.prepare(
          `INSERT INTO achievement_awards(achievement_id, user_id)
           SELECT id, ? FROM achievements WHERE unique_id = ?
           ON CONFLICT(achievement_id, user_id) DO NOTHING`
        ).bind(userId, uniqueId)
      );
      if (result.meta?.changes !== 1) throw new Error("Achievement not found or already awarded.");
      return `Awarded achievement \`${uniqueId}\` to Asterion.`;
    }
    case "add_milestone": {
      const title = requireString(operation.title, "Title", 200);
      const description = typeof operation.description === "string" ? operation.description.slice(0, 3000) : "";
      await runAudited(
        env, actorId, "milestone.add", { title },
        env.DB.prepare(
          "INSERT INTO relationship_milestones(title, description, achieved_at) VALUES (?, ?, CURRENT_TIMESTAMP)"
        ).bind(title, description)
      );
      return `Recorded relationship milestone **${title}**.`;
    }
    default:
      throw new Error("That administrator operation is not supported.");
  }
}

async function executePurchase(
  env: Env,
  actorId: string,
  expected: { uniqueId: string; title: string; price: number; guildId: string | null }
): Promise<string> {
  await assertAsterion(env, actorId);
  await ensureWallet(env, actorId);
  const item = await env.DB.prepare(
    `SELECT id, unique_id, title, price_rp FROM shop_storage
     WHERE unique_id = ? AND title = ? AND price_rp = ? AND status = 'on_sell' AND active = 1`
  ).bind(expected.uniqueId, expected.title, expected.price)
    .first<{ id: number; unique_id: string; title: string; price_rp: number }>();
  if (!item) throw new Error("This item is no longer for sale.");
  await env.DB.prepare(
    `INSERT INTO purchases(shop_item_id, unique_id, item_title, price_paid, buyer_id, guild_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(item.id, item.unique_id, item.title, item.price_rp, actorId, expected.guildId).run();
  return `Purchase confirmed: **${item.title}** for ${item.price_rp} RP. Remaining balance: ${await getBalance(env, actorId)} RP.`;
}

export async function confirmPendingAction(
  env: Env,
  actorId: string,
  actionId: string
): Promise<string> {
  const now = nowIso();
  const action = await env.DB.prepare(
    `SELECT action_type, payload FROM pending_actions
     WHERE id = ? AND actor_id = ? AND status = 'pending' AND expires_at > ?`
  ).bind(actionId, actorId, now).first<{ action_type: string; payload: string }>();
  if (!action) throw new Error("This confirmation has expired or was already used.");

  const claimed = await env.DB.prepare(
    `UPDATE pending_actions SET status = 'confirmed'
     WHERE id = ? AND actor_id = ? AND status = 'pending' AND expires_at > ?`
  ).bind(actionId, actorId, now).run();
  if (claimed.meta?.changes !== 1) throw new Error("This confirmation has already been used.");

  try {
    const payload: unknown = JSON.parse(action.payload);
    if (action.action_type === "purchase") {
      const expected = payload as { uniqueId?: unknown; title?: unknown; price?: unknown; guildId?: unknown };
      if (
        typeof expected.uniqueId !== "string" ||
        typeof expected.title !== "string" ||
        !Number.isSafeInteger(expected.price) ||
        (expected.guildId !== null && expected.guildId !== undefined &&
          (typeof expected.guildId !== "string" || !/^\d{17,20}$/.test(expected.guildId)))
      ) throw new Error("Invalid purchase confirmation.");
      return await executePurchase(env, actorId, {
        uniqueId: expected.uniqueId,
        title: expected.title,
        price: Number(expected.price),
        guildId: typeof expected.guildId === "string" ? expected.guildId : null
      });
    }
    if (action.action_type === "admin") {
      return await applyAdminOperation(env, actorId, payload);
    }
    throw new Error("Unsupported pending operation.");
  } catch (error) {
    await env.DB.prepare("UPDATE pending_actions SET status = 'failed' WHERE id = ?")
      .bind(actionId).run();
    throw error;
  }
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function authenticateAdmin(
  env: Env,
  actorId: string,
  password: string
): Promise<string> {
  if (!env.ADMIN_PASSWORD_SHA256) throw new Error("Private administrator authentication is not configured.");
  const now = Date.now();
  const attempt = await env.DB.prepare(
    `INSERT INTO admin_auth_attempts(user_id, window_started_at, attempts, locked_until)
     VALUES (?, ?, 1, 0)
     ON CONFLICT(user_id) DO UPDATE SET
       window_started_at = CASE
         WHEN excluded.window_started_at - admin_auth_attempts.window_started_at >= ? THEN excluded.window_started_at
         ELSE admin_auth_attempts.window_started_at
       END,
       attempts = CASE
         WHEN excluded.window_started_at - admin_auth_attempts.window_started_at >= ? THEN 1
         ELSE admin_auth_attempts.attempts + 1
       END
     RETURNING window_started_at, attempts, locked_until`
  ).bind(actorId, now, AUTH_WINDOW_MS, AUTH_WINDOW_MS)
    .first<{ window_started_at: number; attempts: number; locked_until: number }>();
  if (!attempt) throw new Error("Could not verify administrator access.");
  if (attempt.locked_until && attempt.locked_until > now) {
    throw new Error("Administrator authentication is temporarily locked. Try again later.");
  }
  if (attempt.attempts > MAX_AUTH_ATTEMPTS) {
    await env.DB.prepare(
      "UPDATE admin_auth_attempts SET locked_until = ? WHERE user_id = ?"
    ).bind(now + AUTH_WINDOW_MS, actorId).run();
    throw new Error("Too many administrator authentication attempts. Try again later.");
  }

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password)));
  const hex = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  if (!constantTimeHexEqual(hex, env.ADMIN_PASSWORD_SHA256.trim().toLowerCase())) {
    if (attempt.attempts >= MAX_AUTH_ATTEMPTS) {
      await env.DB.prepare(
        "UPDATE admin_auth_attempts SET locked_until = ? WHERE user_id = ?"
      ).bind(now + AUTH_WINDOW_MS, actorId).run();
    }
    await logAction(env, actorId, "admin.auth.failure", { attempts: attempt.attempts });
    throw new Error("Administrator authentication failed.");
  }

  const expiresAt = new Date(now + ADMIN_SESSION_MS).toISOString();
  const [sessionResult] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO admin_sessions(user_id, expires_at, created_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET expires_at = excluded.expires_at, created_at = excluded.created_at`
    ).bind(actorId, expiresAt, new Date(now).toISOString()),
    env.DB.prepare(
      `INSERT INTO admin_auth_attempts(user_id, window_started_at, attempts, locked_until)
       VALUES (?, ?, 0, 0)
       ON CONFLICT(user_id) DO UPDATE SET window_started_at = excluded.window_started_at, attempts = 0, locked_until = 0`
    ).bind(actorId, now),
    env.DB.prepare(
      "INSERT INTO system_logs(actor_id, action, details) VALUES (?, ?, ?)"
    ).bind(actorId, "admin.auth.success", JSON.stringify({ expiresAt }))
  ]);
  if (!sessionResult?.success) throw new Error("Could not establish an administrator session.");
  return expiresAt;
}

export async function endAdminSession(env: Env, actorId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM admin_sessions WHERE user_id = ?").bind(actorId).run();
}

export async function appendChatMessage(
  env: Env,
  actorId: string,
  role: "user" | "assistant",
  content: string
): Promise<void> {
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + CHAT_TTL_MS).toISOString();
  await env.DB.prepare("DELETE FROM conversations WHERE expires_at <= ?")
    .bind(createdAt).run();
  await env.DB.prepare(
    `UPDATE conversations SET expires_at = ? WHERE user_id = ? AND expires_at > ?`
  ).bind(expiresAt, actorId, createdAt).run();
  await env.DB.prepare(
    "INSERT INTO conversations(user_id, role, content, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(actorId, role, content.slice(0, 8000), createdAt, expiresAt).run();
}

export async function refreshChatHistory(env: Env, actorId: string): Promise<void> {
  const now = new Date();
  const current = now.toISOString();
  const expiresAt = new Date(now.getTime() + CHAT_TTL_MS).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM conversations WHERE expires_at <= ?").bind(current),
    env.DB.prepare(
      "UPDATE conversations SET expires_at = ? WHERE user_id = ? AND expires_at > ?"
    ).bind(expiresAt, actorId, current)
  ]);
}

export async function commitChatTurn(
  env: Env,
  actorId: string,
  userContent: string,
  assistantContent: string,
  userMessageAlreadyStored = false
): Promise<void> {
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + CHAT_TTL_MS).toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM conversations WHERE expires_at <= ?").bind(createdAt),
    env.DB.prepare(
      "UPDATE conversations SET expires_at = ? WHERE user_id = ? AND expires_at > ?"
    ).bind(expiresAt, actorId, createdAt)
  ];
  if (!userMessageAlreadyStored) {
    statements.push(env.DB.prepare(
      "INSERT INTO conversations(user_id, role, content, created_at, expires_at) VALUES (?, 'user', ?, ?, ?)"
    ).bind(actorId, userContent.slice(0, 8000), createdAt, expiresAt));
  }
  const persistentStatements = await persistentTurnStatements(
    env,
    actorId,
    userContent,
    assistantContent,
    createdAt
  );
  statements.push(...persistentStatements);
  statements.push(env.DB.prepare(
    "INSERT INTO conversations(user_id, role, content, created_at, expires_at) VALUES (?, 'assistant', ?, ?, ?)"
  ).bind(actorId, assistantContent.slice(0, 8000), createdAt, expiresAt));
  await env.DB.batch(statements);
  if (persistentStatements.length) await pruneClientMemoryAfterTurn(env, actorId);
}

export async function consumeChatRateLimit(env: Env, actorId: string): Promise<boolean> {
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO chat_rate_limits(user_id, window_started_at, message_count)
     VALUES (?, ?, 1)
     ON CONFLICT(user_id) DO UPDATE SET
       window_started_at = CASE
         WHEN excluded.window_started_at - chat_rate_limits.window_started_at >= ? THEN excluded.window_started_at
         ELSE chat_rate_limits.window_started_at
       END,
       message_count = CASE
         WHEN excluded.window_started_at - chat_rate_limits.window_started_at >= ? THEN 1
         ELSE chat_rate_limits.message_count + 1
       END
     RETURNING message_count`
  ).bind(actorId, now, CHAT_RATE_WINDOW_MS, CHAT_RATE_WINDOW_MS)
    .first<{ message_count: number }>();
  return (row?.message_count ?? MAX_CHAT_REQUESTS_PER_WINDOW + 1) <= MAX_CHAT_REQUESTS_PER_WINDOW;
}

export async function getChatHistory(
  env: Env,
  actorId: string
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const current = nowIso();
  await env.DB.prepare("DELETE FROM conversations WHERE expires_at <= ?").bind(current).run();
  const rows = await env.DB.prepare(
    `SELECT role, content FROM conversations
     WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC, id DESC LIMIT 20`
  ).bind(actorId, current).all<{ role: "user" | "assistant"; content: string }>();
  return rows.results.reverse();
}

export async function getPrivateMedia(
  env: Env,
  actorId: string,
  mediaId: string
): Promise<{ object: import("./platform.js").R2ObjectBody; fileName: string } | null> {
  if (!env.MEDIA) return null;
  const media = await env.DB.prepare(
    "SELECT r2_key, file_name, owner_id FROM media_objects WHERE id = ?"
  ).bind(mediaId).first<{ r2_key: string; file_name: string; owner_id: string }>();
  if (!media) return null;
  const isOwner = media.owner_id === actorId || actorId === env.LILITH_USER_ID;
  if (!isOwner && actorId !== env.ASTERION_USER_ID) {
    const listedForSale = await env.DB.prepare(
      `SELECT 1 AS visible FROM shop_storage
       WHERE media_id = ? AND status = 'on_sell' AND active = 1 LIMIT 1`
    ).bind(mediaId).first<{ visible: number }>();
    if (!listedForSale) return null;
  }
  if (!isOwner && actorId === env.ASTERION_USER_ID) {
    const owned = await env.DB.prepare(
      "SELECT 1 AS visible FROM astri_collection WHERE media_id = ? LIMIT 1"
    ).bind(mediaId).first<{ visible: number }>();
    const listedForSale = await env.DB.prepare(
      `SELECT 1 AS visible FROM shop_storage
       WHERE media_id = ? AND status = 'on_sell' AND active = 1 LIMIT 1`
    ).bind(mediaId).first<{ visible: number }>();
    if (!owned && !listedForSale) return null;
  }
  const object = await env.MEDIA.get(media.r2_key);
  return object ? { object, fileName: media.file_name } : null;
}

export async function storePrivateMedia(
  env: Env,
  actorId: string,
  fileName: string,
  contentType: string,
  bytes: ArrayBuffer
): Promise<{ id: string }> {
  if (!env.MEDIA) throw new Error("Media storage is temporarily unavailable.");
  if (actorId !== env.ASTERION_USER_ID && actorId !== env.LILITH_USER_ID) {
    throw new Error("Only configured users may store private media.");
  }
  if (!/^image\/(?:png|jpeg|gif|webp)$/.test(contentType)) throw new Error("Only PNG, JPEG, GIF, and WebP images are supported.");
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("Images must be 8 MB or smaller.");
  if (!hasImageSignature(contentType, new Uint8Array(bytes))) throw new Error("The uploaded image does not match its declared file type.");
  const id = crypto.randomUUID();
  const key = `private/${id}`;
  const safeName = fileName.replace(/[^\w.-]/g, "_").slice(0, 120) || "image";
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType } });
  try {
    await env.DB.prepare(
      "INSERT INTO media_objects(id, r2_key, owner_id, content_type, file_name) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, key, actorId, contentType, safeName).run();
  } catch (error) {
    try {
      await env.MEDIA.delete(key);
    } catch (cleanupError) {
      console.error("Could not remove an orphaned R2 upload:", cleanupError);
    }
    throw error;
  }
  return { id };
}

function hasImageSignature(contentType: string, bytes: Uint8Array): boolean {
  if (contentType === "image/png") {
    return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  }
  if (contentType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  }
  if (contentType === "image/gif") {
    return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(new TextDecoder().decode(bytes.slice(0, 6)));
  }
  if (contentType === "image/webp") {
    return bytes.length >= 12 &&
      new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  }
  return false;
}

export async function listKnowledge(
  env: Env,
  actorId: string,
  scope: KnowledgeScope
): Promise<KnowledgeRow[]> {
  if (scope === "relationship") await assertAsterion(env, actorId);
  const table = scope === "general" ? "general_kn" : "relationship_kn";
  const result = await env.DB.prepare(
    `SELECT id, title, content, tags FROM ${table} WHERE active = 1 ORDER BY updated_at DESC LIMIT 20`
  ).all<KnowledgeRow>();
  return result.results;
}

export function isTokenType(value: unknown): value is TokenType {
  return value === "date" || value === "food" || value === "visual" || value === "creative";
}
