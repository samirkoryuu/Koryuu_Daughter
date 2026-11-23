import type { Env } from "./platform.js";

const DISCORD_API = "https://discord.com/api/v10";
const VIEW_CHANNEL = 1 << 10;
const SEND_MESSAGES = 1 << 11;
const READ_MESSAGE_HISTORY = 1 << 16;
const TICKET_PERMISSIONS = String(VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY);

interface TicketRecord {
  user_id: string;
  guild_id: string;
  role_id: string;
  channel_id: string;
  expires_at: string;
}

interface DiscordRole {
  id: string;
}

interface DiscordUser {
  id: string;
}

interface DiscordChannel {
  id: string;
}

async function discordRequest(env: Env, path: string, init: RequestInit): Promise<Response> {
  if (!env.DISCORD_BOT_TOKEN) {
    throw new Error("Temporary admin channels are not configured. Set the DISCORD_BOT_TOKEN Worker secret.");
  }
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bot ${env.DISCORD_BOT_TOKEN}`);
  headers.set("content-type", "application/json");
  return fetch(`${DISCORD_API}${path}`, { ...init, headers });
}

async function requireSuccess(response: Response, action: string): Promise<void> {
  if (!response.ok) throw new Error(`Discord could not ${action} (HTTP ${response.status}).`);
}

async function discordJson<T>(response: Response, action: string): Promise<T> {
  await requireSuccess(response, action);
  try {
    return await response.json() as T;
  } catch {
    throw new Error(`Discord returned an unreadable response while trying to ${action}.`);
  }
}

async function deleteDiscordResource(env: Env, path: string, action: string): Promise<void> {
  const response = await discordRequest(env, path, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Discord could not ${action} (HTTP ${response.status}).`);
  }
}

async function removeTicketResources(env: Env, ticket: TicketRecord): Promise<void> {
  await deleteDiscordResource(
    env,
    `/guilds/${ticket.guild_id}/channels/${ticket.channel_id}`,
    "delete the temporary admin channel"
  );
  await deleteDiscordResource(
    env,
    `/guilds/${ticket.guild_id}/members/${ticket.user_id}/roles/${ticket.role_id}`,
    "remove the temporary admin role"
  );
  await deleteDiscordResource(
    env,
    `/guilds/${ticket.guild_id}/roles/${ticket.role_id}`,
    "delete the temporary admin role"
  );
}

export async function closeAdminTicket(env: Env, userId: string): Promise<void> {
  const ticket = await env.DB.prepare(
    `SELECT user_id, guild_id, role_id, channel_id, expires_at
     FROM temporary_admin_access WHERE user_id = ?`
  ).bind(userId).first<TicketRecord>();
  if (!ticket) return;

  await removeTicketResources(env, ticket);
  await env.DB.prepare("DELETE FROM temporary_admin_access WHERE user_id = ? AND channel_id = ?")
    .bind(userId, ticket.channel_id).run();
}

export async function createAdminTicket(
  env: Env,
  guildId: string,
  userId: string,
  expiresAt: string
): Promise<string> {
  const guildPath = `/guilds/${guildId}`;
  let roleId: string | undefined;
  let channelId: string | undefined;
  let roleAssigned = false;
  const ticket: TicketRecord = {
    user_id: userId,
    guild_id: guildId,
    role_id: "",
    channel_id: "",
    expires_at: expiresAt
  };

  try {
    const bot = await discordJson<DiscordUser>(
      await discordRequest(env, "/users/@me", { method: "GET" }),
      "identify itself"
    );
    if (!/^\d{17,20}$/.test(bot.id)) throw new Error("Discord returned an invalid bot identity.");

    const roles = await discordJson<DiscordRole[]>(
      await discordRequest(env, `${guildPath}/roles`, { method: "GET" }),
      "read server roles"
    );
    const roleIds = [...new Set([...roles.map(role => role.id), guildId])];

    const role = await discordJson<DiscordRole>(
      await discordRequest(env, `${guildPath}/roles`, {
        method: "POST",
        body: JSON.stringify({ name: "creator15", permissions: "0", hoist: false, mentionable: false })
      }),
      "create the temporary marker role"
    );
    if (!/^\d{17,20}$/.test(role.id)) throw new Error("Discord returned an invalid role ID.");
    roleId = role.id;
    ticket.role_id = roleId;

    const assignment = await discordRequest(
      env,
      `${guildPath}/members/${userId}/roles/${roleId}`,
      { method: "PUT" }
    );
    await requireSuccess(assignment, "assign the temporary marker role");
    roleAssigned = true;

    const permissionOverwrites = [
      ...[...roleIds, roleId].map(id => ({
        id,
        type: 0,
        allow: "0",
        deny: String(VIEW_CHANNEL)
      })),
      {
        id: userId,
        type: 1,
        allow: TICKET_PERMISSIONS,
        deny: "0"
      },
      {
        id: bot.id,
        type: 1,
        allow: TICKET_PERMISSIONS,
        deny: "0"
      }
    ];
    const channel = await discordJson<DiscordChannel>(
      await discordRequest(env, `${guildPath}/channels`, {
        method: "POST",
        body: JSON.stringify({
          name: `creator15-${userId.slice(-6)}`,
          type: 0,
          topic: `Private Koryuu admin ticket; expires ${expiresAt}.`,
          permission_overwrites: permissionOverwrites
        })
      }),
      "create the private admin channel"
    );
    if (!/^\d{17,20}$/.test(channel.id)) throw new Error("Discord returned an invalid channel ID.");
    channelId = channel.id;
    ticket.channel_id = channelId;

    const stored = await env.DB.prepare(
      `INSERT INTO temporary_admin_access(user_id, guild_id, role_id, channel_id, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(userId, guildId, roleId, channelId, expiresAt).run();
    if (stored.meta?.changes !== 1) throw new Error("Could not store temporary admin channel access.");
    return channelId;
  } catch (error) {
    const cleanupFailures: string[] = [];
    if (channelId) {
      try {
        await deleteDiscordResource(env, `${guildPath}/channels/${channelId}`, "roll back the temporary admin channel");
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError instanceof Error ? cleanupError.message : "Channel cleanup failed.");
      }
    }
    if (roleId && roleAssigned) {
      try {
        await deleteDiscordResource(
          env,
          `${guildPath}/members/${userId}/roles/${roleId}`,
          "roll back the temporary admin role assignment"
        );
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError instanceof Error ? cleanupError.message : "Role assignment cleanup failed.");
      }
    }
    if (roleId) {
      try {
        await deleteDiscordResource(env, `${guildPath}/roles/${roleId}`, "roll back the temporary admin role");
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError instanceof Error ? cleanupError.message : "Role cleanup failed.");
      }
    }
    if (cleanupFailures.length) {
      console.error("Discord temporary admin setup rollback was incomplete:", cleanupFailures);
    }
    throw error;
  }
}

export async function cleanupExpiredAdminTickets(env: Env): Promise<void> {
  const expired = await env.DB.prepare(
    `SELECT user_id, guild_id, role_id, channel_id, expires_at
     FROM temporary_admin_access WHERE expires_at <= ?`
  ).bind(new Date().toISOString()).all<TicketRecord>();

  for (const ticket of expired.results) {
    try {
      await removeTicketResources(env, ticket);
      await env.DB.prepare("DELETE FROM temporary_admin_access WHERE user_id = ? AND channel_id = ?")
        .bind(ticket.user_id, ticket.channel_id).run();
    } catch (error) {
      console.error(`Could not clean up expired admin ticket for user ${ticket.user_id}:`, error);
    }
  }
}
