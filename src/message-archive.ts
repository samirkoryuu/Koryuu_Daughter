import type { D1PreparedStatement, Env } from "./platform.js";
import { ensureClientKoryuuRole } from "./discord-server.js";

export const CLIENT_MEMORY_BUDGET_BYTES = 150_000_000;
export const SERVER_ARCHIVE_BUDGET_BYTES = 150_000_000;
const ROW_OVERHEAD_BYTES = 160;

export interface ArchivedMessageInput {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
  editedAt?: string | null;
}

function assertSnowflake(value: string, label: string): void {
  if (!/^\d{17,20}$/.test(value)) throw new Error(`${label} must be a valid Discord ID.`);
}

function assertArchiveGuild(env: Env, guildId: string): void {
  assertSnowflake(guildId, "Guild ID");
  if (!env.ARCHIVE_GUILD_ID || env.ARCHIVE_GUILD_ID !== guildId) {
    throw new Error("Message archiving is not enabled for this server.");
  }
}

export async function registerClientMemoryMember(
  env: Env,
  guildId: string,
  userId: string
): Promise<{ registered: boolean; roleId: string; clientCount: number; memoryQuotaBytes: number }> {
  assertArchiveGuild(env, guildId);
  assertSnowflake(userId, "Member ID");
  const existing = await env.DB.prepare(
    "SELECT role_id FROM client_memory_members WHERE guild_id = ? AND user_id = ?"
  ).bind(guildId, userId).first<{ role_id: string }>();
  const roleId = await ensureClientKoryuuRole(env, guildId, userId);
  if (existing) {
    if (existing.role_id !== roleId) {
      await env.DB.prepare(
        "UPDATE client_memory_members SET role_id = ? WHERE guild_id = ? AND user_id = ?"
      ).bind(roleId, guildId, userId).run();
    }
    const counts = await env.DB.prepare(
      "SELECT COUNT(DISTINCT user_id) AS count FROM client_memory_members"
    ).first<{ count: number }>();
    const clientCount = counts?.count ?? 0;
    return {
      registered: false,
      roleId: existing.role_id,
      clientCount,
      memoryQuotaBytes: clientCount > 0 ? Math.floor(CLIENT_MEMORY_BUDGET_BYTES / clientCount) : CLIENT_MEMORY_BUDGET_BYTES
    };
  }
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO client_memory_members(guild_id, user_id, role_id, registered_at)
     VALUES (?, ?, ?, ?)`
  ).bind(guildId, userId, roleId, new Date().toISOString()).run();
  const counts = await env.DB.prepare(
    "SELECT COUNT(DISTINCT user_id) AS count FROM client_memory_members"
  ).first<{ count: number }>();
  const clientCount = counts?.count ?? 0;
  if (inserted.meta?.changes === 1) await pruneAllClientMemories(env, clientCount);
  return {
    registered: inserted.meta?.changes === 1,
    roleId,
    clientCount,
    memoryQuotaBytes: clientCount > 0 ? Math.floor(CLIENT_MEMORY_BUDGET_BYTES / clientCount) : CLIENT_MEMORY_BUDGET_BYTES
  };
}

async function pruneOneClientMemory(env: Env, userId: string, quotaBytes: number): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM client_memory_messages
     WHERE id IN (
       SELECT id FROM (
         SELECT id,
           SUM(storage_bytes) OVER (ORDER BY created_at DESC, id DESC) AS bytes_from_newest
         FROM client_memory_messages
         WHERE user_id = ?
       )
       WHERE bytes_from_newest > ?
     )`
  ).bind(userId, quotaBytes).run();
}

async function pruneAllClientMemories(env: Env, clientCount: number): Promise<void> {
  if (clientCount < 1) return;
  const clients = await env.DB.prepare(
    "SELECT DISTINCT user_id FROM client_memory_members"
  ).all<{ user_id: string }>();
  const quotaBytes = Math.floor(CLIENT_MEMORY_BUDGET_BYTES / clientCount);
  for (const client of clients.results) await pruneOneClientMemory(env, client.user_id, quotaBytes);
}

export async function persistentTurnStatements(
  env: Env,
  userId: string,
  userContent: string,
  assistantContent: string,
  createdAt: string
): Promise<D1PreparedStatement[]> {
  const registration = await env.DB.prepare(
    "SELECT 1 AS registered FROM client_memory_members WHERE user_id = ? LIMIT 1"
  ).bind(userId).first<{ registered: number }>();
  if (!registration) return [];
  const byteSize = (content: string): number => new TextEncoder().encode(content).byteLength + ROW_OVERHEAD_BYTES;
  return [
    env.DB.prepare(
      `INSERT INTO client_memory_messages(user_id, role, content, storage_bytes, created_at)
       VALUES (?, 'user', ?, ?, ?)`
    ).bind(userId, userContent.slice(0, 8000), byteSize(userContent.slice(0, 8000)), createdAt),
    env.DB.prepare(
      `INSERT INTO client_memory_messages(user_id, role, content, storage_bytes, created_at)
       VALUES (?, 'assistant', ?, ?, ?)`
    ).bind(userId, assistantContent.slice(0, 8000), byteSize(assistantContent.slice(0, 8000)), createdAt)
  ];
}

export async function pruneClientMemoryAfterTurn(env: Env, userId: string): Promise<void> {
  const counts = await env.DB.prepare(
    "SELECT COUNT(DISTINCT user_id) AS count FROM client_memory_members"
  ).first<{ count: number }>();
  const clientCount = counts?.count ?? 0;
  if (clientCount < 1) return;
  await pruneOneClientMemory(env, userId, Math.floor(CLIENT_MEMORY_BUDGET_BYTES / clientCount));
}

export async function searchClientMemoryMessages(
  env: Env,
  userId: string,
  query: string,
  limit = 10
): Promise<Array<{ role: "user" | "assistant"; content: string; created_at: string }>> {
  const terms = query.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u)
    .map(term => term.replace(/[%_\\]/g, ""))
    .filter(term => term.length >= 3)
    .slice(0, 5);
  if (!terms.length) throw new Error("Provide at least one search term with three or more letters or digits.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Memory search page size must be 1-20.");
  const conditions = terms.map(() => "content LIKE ? ESCAPE '\\'");
  const values = terms.map(term => `%${term}%`);
  const results = await env.DB.prepare(
    `SELECT role, content, created_at FROM client_memory_messages
     WHERE user_id = ? AND ${conditions.join(" AND ")}
     ORDER BY created_at DESC, id DESC LIMIT ?`
  ).bind(userId, ...values, limit).all<{
    role: "user" | "assistant";
    content: string;
    created_at: string;
  }>();
  return results.results.reverse();
}

export async function removeClientMemoryMembership(env: Env, guildId: string, userId: string): Promise<void> {
  assertArchiveGuild(env, guildId);
  assertSnowflake(userId, "Member ID");
  await env.DB.prepare(
    "DELETE FROM client_memory_members WHERE guild_id = ? AND user_id = ?"
  ).bind(guildId, userId).run();
  const remaining = await env.DB.prepare(
    "SELECT 1 AS registered FROM client_memory_members WHERE user_id = ? LIMIT 1"
  ).bind(userId).first<{ registered: number }>();
  if (!remaining) {
    await env.DB.prepare("DELETE FROM client_memory_messages WHERE user_id = ?").bind(userId).run();
  }
  const counts = await env.DB.prepare(
    "SELECT COUNT(DISTINCT user_id) AS count FROM client_memory_members"
  ).first<{ count: number }>();
  await pruneAllClientMemories(env, counts?.count ?? 0);
}

async function ensureArchiveNotice(env: Env, guildId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO server_archive_settings(guild_id, notice_status, updated_at)
     VALUES (?, 'pending', ?)`
  ).bind(guildId, now).run();
  const claim = await env.DB.prepare(
    `UPDATE server_archive_settings
     SET notice_status = 'posting', updated_at = ?
     WHERE guild_id = ? AND notice_status IN ('pending', 'failed')
     RETURNING guild_id`
  ).bind(now, guildId).first<{ guild_id: string }>();
  if (!claim) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = await env.DB.prepare(
        "SELECT notice_status FROM server_archive_settings WHERE guild_id = ?"
      ).bind(guildId).first<{ notice_status: string }>();
      if (current?.notice_status === "posted") return;
      if (current?.notice_status !== "posting") break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error("The server message archive notice is not yet confirmed; message capture is paused.");
  }

  try {
    if (!env.DISCORD_BOT_TOKEN) throw new Error("The Discord bot token is not configured.");
    const guildResponse = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
      headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
      redirect: "manual"
    });
    if (!guildResponse.ok) throw new Error(`Could not inspect the server notice channel (HTTP ${guildResponse.status}).`);
    const guild = await guildResponse.json() as { system_channel_id?: unknown };
    if (typeof guild.system_channel_id !== "string" || !/^\d{17,20}$/.test(guild.system_channel_id)) {
      throw new Error("Set a system channel in Discord before enabling Koryuu's server archive.");
    }
    const message = [
      "**Koryuu message archive notice**",
      "Koryuu stores text and message metadata from this server's text channels, private channels, and threads so she can answer channel-history and summary requests.",
      "The rolling server archive is capped at 150 MB; when it fills, the oldest archived messages are removed. Edits update archived messages, and deleted Discord messages are removed from the archive.",
      "Messages are also sent to Groq when needed to answer a Koryuu request. Please contact the server owner if you have questions about this feature."
    ].join("\n");
    const posted = await fetch(`https://discord.com/api/v10/channels/${guild.system_channel_id}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ content: message, allowed_mentions: { parse: [] } }),
      redirect: "manual"
    });
    if (!posted.ok) throw new Error(`Could not post the archive notice (HTTP ${posted.status}).`);
    await env.DB.prepare(
      `UPDATE server_archive_settings
       SET notice_status = 'posted', notice_channel_id = ?, notice_posted_at = ?, updated_at = ?
       WHERE guild_id = ? AND notice_status = 'posting'`
    ).bind(guild.system_channel_id, now, new Date().toISOString(), guildId).run();
  } catch (error) {
    await env.DB.prepare(
      `UPDATE server_archive_settings SET notice_status = 'failed', updated_at = ?
       WHERE guild_id = ? AND notice_status = 'posting'`
    ).bind(new Date().toISOString(), guildId).run();
    throw error;
  }
}

async function trimServerArchive(env: Env, guildId: string): Promise<void> {
  const usage = await env.DB.prepare(
    "SELECT used_bytes FROM server_archive_usage WHERE guild_id = ?"
  ).bind(guildId).first<{ used_bytes: number }>();
  if ((usage?.used_bytes ?? 0) <= SERVER_ARCHIVE_BUDGET_BYTES) return;
  await env.DB.prepare(
    `DELETE FROM server_message_archive
     WHERE message_id IN (
       SELECT message_id FROM (
         SELECT message_id,
           SUM(storage_bytes) OVER (ORDER BY created_at DESC, message_id DESC) AS bytes_from_newest
         FROM server_message_archive
         WHERE guild_id = ?
       )
       WHERE bytes_from_newest > ?
     )`
  ).bind(guildId, SERVER_ARCHIVE_BUDGET_BYTES).run();
}

export async function archiveServerMessage(env: Env, input: ArchivedMessageInput): Promise<void> {
  assertArchiveGuild(env, input.guildId);
  assertSnowflake(input.channelId, "Channel ID");
  assertSnowflake(input.messageId, "Message ID");
  assertSnowflake(input.authorId, "Author ID");
  if (input.content.length > 8000 || input.authorName.length > 100 ||
    !Number.isFinite(Date.parse(input.createdAt)) ||
    (input.editedAt !== undefined && input.editedAt !== null && !Number.isFinite(Date.parse(input.editedAt)))) {
    throw new Error("Invalid archived message fields.");
  }
  await ensureArchiveNotice(env, input.guildId);
  const content = input.content;
  const storageBytes = new TextEncoder().encode(
    `${input.guildId}${input.channelId}${input.messageId}${input.authorId}${input.authorName}${content}${input.createdAt}`
  ).byteLength + ROW_OVERHEAD_BYTES;
  await env.DB.prepare(
    `INSERT INTO server_message_archive(
       message_id, guild_id, channel_id, author_id, author_name, content, created_at, edited_at, storage_bytes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       guild_id = excluded.guild_id,
       channel_id = excluded.channel_id,
       author_id = excluded.author_id,
       author_name = excluded.author_name,
       content = excluded.content,
       edited_at = excluded.edited_at,
       storage_bytes = excluded.storage_bytes`
  ).bind(
    input.messageId,
    input.guildId,
    input.channelId,
    input.authorId,
    input.authorName.slice(0, 100),
    content,
    input.createdAt,
    input.editedAt ?? null,
    storageBytes
  ).run();
  await trimServerArchive(env, input.guildId);
}

export async function deleteArchivedMessages(
  env: Env,
  guildId: string,
  channelId: string,
  messageIds: string[]
): Promise<void> {
  assertArchiveGuild(env, guildId);
  assertSnowflake(channelId, "Channel ID");
  if (messageIds.length > 100 || messageIds.some(id => !/^\d{17,20}$/.test(id))) {
    throw new Error("Invalid archived message deletion list.");
  }
  if (!messageIds.length) return;
  const placeholders = messageIds.map(() => "?").join(", ");
  await env.DB.prepare(
    `DELETE FROM server_message_archive WHERE guild_id = ? AND channel_id = ? AND message_id IN (${placeholders})`
  ).bind(guildId, channelId, ...messageIds).run();
}

export async function getArchivedChannelMessages(
  env: Env,
  guildId: string,
  channelId: string,
  options: { limit?: number; beforeCreatedAt?: string; beforeMessageId?: string } = {}
): Promise<{
  messages: Array<{ author_name: string; content: string; created_at: string }>;
  has_more: boolean;
  next_before: { created_at: string; message_id: string } | null;
  stored_messages: number;
}> {
  assertArchiveGuild(env, guildId);
  assertSnowflake(channelId, "Channel ID");
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Archive page size must be 1-50.");
  if ((options.beforeCreatedAt && !Number.isFinite(Date.parse(options.beforeCreatedAt))) ||
    (options.beforeMessageId && !/^\d{17,20}$/.test(options.beforeMessageId))) {
    throw new Error("Invalid archive page cursor.");
  }
  const hasCursor = Boolean(options.beforeCreatedAt && options.beforeMessageId);
  const page = await env.DB.prepare(
    `SELECT message_id, author_name, content, created_at
     FROM server_message_archive
     WHERE guild_id = ? AND channel_id = ?
       AND (? = 0 OR created_at < ? OR (created_at = ? AND message_id < ?))
     ORDER BY created_at DESC, message_id DESC LIMIT ?`
  ).bind(
    guildId,
    channelId,
    hasCursor ? 1 : 0,
    options.beforeCreatedAt ?? "",
    options.beforeCreatedAt ?? "",
    options.beforeMessageId ?? "",
    limit + 1
  ).all<{ message_id: string; author_name: string; content: string; created_at: string }>();
  const hasMore = page.results.length > limit;
  const descending = page.results.slice(0, limit);
  const oldest = descending.at(-1);
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM server_message_archive WHERE guild_id = ? AND channel_id = ?"
  ).bind(guildId, channelId).first<{ count: number }>();
  return {
    messages: descending.reverse().map(({ author_name, content, created_at }) => ({ author_name, content, created_at })),
    has_more: hasMore,
    next_before: hasMore && oldest ? { created_at: oldest.created_at, message_id: oldest.message_id } : null,
    stored_messages: count?.count ?? 0
  };
}
