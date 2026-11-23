import type { Env } from "./platform.js";

const DISCORD_API = "https://discord.com/api/v10";
const PERMISSION_BITS: Record<string, bigint> = {
  CREATE_INSTANT_INVITE: 0n,
  KICK_MEMBERS: 1n,
  BAN_MEMBERS: 2n,
  ADMINISTRATOR: 3n,
  MANAGE_CHANNELS: 4n,
  MANAGE_GUILD: 5n,
  ADD_REACTIONS: 6n,
  VIEW_AUDIT_LOG: 7n,
  PRIORITY_SPEAKER: 8n,
  STREAM: 9n,
  VIEW_CHANNEL: 10n,
  SEND_MESSAGES: 11n,
  SEND_TTS_MESSAGES: 12n,
  MANAGE_MESSAGES: 13n,
  EMBED_LINKS: 14n,
  ATTACH_FILES: 15n,
  READ_MESSAGE_HISTORY: 16n,
  MENTION_EVERYONE: 17n,
  USE_EXTERNAL_EMOJIS: 18n,
  VIEW_GUILD_INSIGHTS: 19n,
  CONNECT: 20n,
  SPEAK: 21n,
  MUTE_MEMBERS: 22n,
  DEAFEN_MEMBERS: 23n,
  MOVE_MEMBERS: 24n,
  USE_VAD: 25n,
  CHANGE_NICKNAME: 26n,
  MANAGE_NICKNAMES: 27n,
  MANAGE_ROLES: 28n,
  MANAGE_WEBHOOKS: 29n,
  MANAGE_GUILD_EXPRESSIONS: 30n,
  USE_APPLICATION_COMMANDS: 31n,
  REQUEST_TO_SPEAK: 32n,
  MANAGE_EVENTS: 33n,
  MANAGE_THREADS: 34n,
  CREATE_PUBLIC_THREADS: 35n,
  CREATE_PRIVATE_THREADS: 36n,
  USE_EXTERNAL_STICKERS: 37n,
  SEND_MESSAGES_IN_THREADS: 38n,
  USE_EMBEDDED_ACTIVITIES: 39n,
  MODERATE_MEMBERS: 40n,
  VIEW_CREATOR_MONETIZATION_ANALYTICS: 41n,
  USE_SOUNDBOARD: 42n,
  CREATE_GUILD_EXPRESSIONS: 43n,
  CREATE_EVENTS: 44n,
  USE_EXTERNAL_SOUNDS: 45n,
  SEND_VOICE_MESSAGES: 46n,
  SET_VOICE_CHANNEL_STATUS: 48n,
  SEND_POLLS: 49n,
  USE_EXTERNAL_APPS: 50n,
  PIN_MESSAGES: 51n,
  BYPASS_SLOWMODE: 52n
};

interface DiscordRole {
  id: string;
  name: string;
  permissions: string;
  position: number;
  managed: boolean;
  hoist: boolean;
  mentionable: boolean;
  color: number;
}

interface DiscordOverwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  parent_id: string | null;
  permission_overwrites: DiscordOverwrite[];
}

interface DiscordMember {
  user: { id: string; username: string; global_name?: string | null };
  roles: string[];
  nick: string | null;
}

class DiscordApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "DiscordApiError";
  }
}

export type ServerOperation =
  | { operation: "create_role"; name: string; permissions: string[]; color: number; hoist: boolean; mentionable: boolean }
  | { operation: "set_role_permissions"; role_id: string; permissions: string[] }
  | { operation: "delete_role"; role_id: string }
  | { operation: "create_channel"; name: string; channel_type: "text" | "voice" | "category"; parent_id?: string }
  | { operation: "delete_channel"; channel_id: string }
  | {
      operation: "create_team";
      team_name: string;
      role_name: string;
      channel_name: string;
      leader_id: string;
      member_ids: string[];
      request_id?: string;
    }
  | {
      operation: "update_team";
      team_id: string;
      action: "add_member" | "remove_member" | "set_leader";
      member_id: string;
    }
  | { operation: "archive_team"; team_id: string }
  | { operation: "create_private_channel"; name: string; request_id: string; member_ids: string[] }
  | { operation: "set_channel_overwrite"; channel_id: string; target_type: "role" | "member"; target_id: string; allow: string[]; deny: string[] }
  | { operation: "assign_member_role"; member_id: string; role_id: string }
  | { operation: "remove_member_role"; member_id: string; role_id: string }
  | { operation: "kick_member"; member_id: string }
  | { operation: "ban_member"; member_id: string }
  | { operation: "timeout_member"; member_id: string; duration_minutes: number };

function assertSnowflake(value: string, label: string): void {
  if (!/^\d{17,20}$/.test(value)) throw new Error(`${label} must be a valid Discord ID.`);
}

function assertGuildId(guildId: string): void {
  assertSnowflake(guildId, "Guild ID");
}

async function discordRequest<T>(
  env: Env,
  path: string,
  method = "GET",
  body?: unknown
): Promise<T> {
  if (!env.DISCORD_BOT_TOKEN) {
    throw new Error("Live Discord server access is not configured.");
  }
  const response = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  if (!response.ok) {
    let reason = "";
    try {
      const error = await response.json() as { message?: unknown; code?: unknown };
      if (typeof error.message === "string") reason = `: ${error.message.slice(0, 180)}`;
      else if (typeof error.code === "number") reason = ` (Discord code ${error.code})`;
    } catch (error) {
      console.error("Could not parse a Discord REST error response:", error);
    }
    throw new DiscordApiError(`Discord request failed with HTTP ${response.status}${reason}.`, response.status);
  }
  if (response.status === 204) return undefined as T;
  try {
    return await response.json() as T;
  } catch {
    throw new Error("Discord returned an unreadable server response.");
  }
}

function decodePermissions(value: string | bigint): string[] {
  const permissions = BigInt(value);
  return Object.entries(PERMISSION_BITS)
    .filter(([, bit]) => (permissions & (1n << bit)) !== 0n)
    .map(([name]) => name);
}

function encodePermissions(names: string[]): bigint {
  let permissions = 0n;
  for (const name of names) {
    const bit = PERMISSION_BITS[name];
    if (bit === undefined) throw new Error(`Unsupported Discord permission: ${name}.`);
    permissions |= 1n << bit;
  }
  return permissions;
}

async function getRoles(env: Env, guildId: string): Promise<DiscordRole[]> {
  assertGuildId(guildId);
  return discordRequest<DiscordRole[]>(env, `/guilds/${guildId}/roles`);
}

async function getChannels(env: Env, guildId: string): Promise<DiscordChannel[]> {
  assertGuildId(guildId);
  return discordRequest<DiscordChannel[]>(env, `/guilds/${guildId}/channels`);
}

async function getMember(env: Env, guildId: string, userId: string): Promise<DiscordMember> {
  assertGuildId(guildId);
  assertSnowflake(userId, "Member ID");
  return discordRequest<DiscordMember>(env, `/guilds/${guildId}/members/${userId}`);
}

export async function readMemberRoleState(
  env: Env,
  guildId: string,
  userId: string,
  roleId: string
): Promise<{ memberExists: boolean; roleExists: boolean; hasRole: boolean }> {
  assertGuildId(guildId);
  assertSnowflake(userId, "Member ID");
  assertSnowflake(roleId, "Role ID");
  const [roles, member] = await Promise.all([
    getRoles(env, guildId),
    getMember(env, guildId, userId).catch(error => {
      if (error instanceof DiscordApiError && error.status === 404) return null;
      throw error;
    })
  ]);
  return {
    memberExists: member !== null,
    roleExists: roles.some(role => role.id === roleId),
    hasRole: member?.roles.includes(roleId) ?? false
  };
}

async function getBotState(env: Env, guildId: string): Promise<{
  botId: string;
  member: DiscordMember;
  roles: DiscordRole[];
}> {
  const [user, roles] = await Promise.all([
    discordRequest<{ id: string }>(env, "/users/@me"),
    getRoles(env, guildId)
  ]);
  assertSnowflake(user.id, "Bot ID");
  return {
    botId: user.id,
    roles,
    member: await getMember(env, guildId, user.id)
  };
}

export async function getDiscordBotId(env: Env): Promise<string> {
  const bot = await discordRequest<{ id: string }>(env, "/users/@me");
  assertSnowflake(bot.id, "Bot ID");
  return bot.id;
}

export async function inspectGuildRoles(env: Env, guildId: string): Promise<unknown> {
  const roles = await getRoles(env, guildId);
  return roles
    .sort((left, right) => right.position - left.position)
    .map(role => ({
      id: role.id,
      name: role.name,
      position: role.position,
      managed: role.managed,
      permissions: role.permissions,
      permission_names: decodePermissions(role.permissions),
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable
    }));
}

export async function inspectGuildChannels(env: Env, guildId: string): Promise<unknown> {
  const [channels, roles] = await Promise.all([getChannels(env, guildId), getRoles(env, guildId)]);
  const roleNames = new Map(roles.map(role => [role.id, role.name]));
  return channels.map(channel => ({
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parent_id: channel.parent_id,
    permission_overwrites: channel.permission_overwrites.map(overwrite => ({
      id: overwrite.id,
      target_type: overwrite.type === 0 ? "role" : "member",
      target_name: overwrite.type === 0 ? roleNames.get(overwrite.id) ?? null : null,
      allow: overwrite.allow,
      allow_names: decodePermissions(overwrite.allow),
      deny: overwrite.deny,
      deny_names: decodePermissions(overwrite.deny)
    }))
  }));
}

export async function inspectGuildMembers(
  env: Env,
  guildId: string,
  limit = 100,
  after?: string
): Promise<{ members: unknown[]; next_after: string | null }> {
  assertGuildId(guildId);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Member page size must be between 1 and 100.");
  }
  if (after !== undefined) assertSnowflake(after, "Member cursor");
  const members = await discordRequest<DiscordMember[]>(
    env,
    `/guilds/${guildId}/members?limit=${limit}${after ? `&after=${after}` : ""}`
  );
  const roles = await getRoles(env, guildId);
  const roleNames = new Map(roles.map(role => [role.id, role.name]));
  return {
    members: members.map(member => ({
      id: member.user.id,
      username: member.user.username,
      display_name: member.nick ?? member.user.global_name ?? member.user.username,
      role_ids: member.roles,
      roles: member.roles.map(id => ({ id, name: roleNames.get(id) ?? null }))
    })),
    next_after: members.length === limit ? members[members.length - 1]?.user.id ?? null : null
  };
}

export async function inspectGuildMember(
  env: Env,
  guildId: string,
  userId: string
): Promise<{
  id: string;
  username: string;
  display_name: string;
  role_ids: string[];
  roles: Array<{ id: string; name: string | null }>;
}> {
  const [member, roles] = await Promise.all([getMember(env, guildId, userId), getRoles(env, guildId)]);
  const roleNames = new Map(roles.map(role => [role.id, role.name]));
  return {
    id: member.user.id,
    username: member.user.username,
    display_name: member.nick ?? member.user.global_name ?? member.user.username,
    role_ids: member.roles,
    roles: member.roles.map(id => ({ id, name: roleNames.get(id) ?? null }))
  };
}

export async function ensureClientKoryuuRole(
  env: Env,
  guildId: string,
  userId: string
): Promise<string> {
  assertGuildId(guildId);
  assertSnowflake(userId, "Member ID");
  let roles = await getRoles(env, guildId);
  let role = roles.find(item => item.name.toLocaleLowerCase() === "client-koryuu");
  if (!role) {
    const botState = await getBotState(env, guildId);
    const botPermissions = effectiveGuildPermissions(guildId, botState.roles, botState.member);
    const canManageRoles = (botPermissions & (1n << PERMISSION_BITS.MANAGE_ROLES)) !== 0n ||
      (botPermissions & (1n << PERMISSION_BITS.ADMINISTRATOR)) !== 0n;
    if (!canManageRoles) throw new Error("Koryuu needs Manage Roles permission to create the client-koryuu role.");
    role = await discordRequest<DiscordRole>(env, `/guilds/${guildId}/roles`, "POST", {
      name: "client-koryuu",
      permissions: "0",
      hoist: false,
      mentionable: false
    });
    roles = [...roles, role];
  }
  if (role.managed || BigInt(role.permissions) !== 0n) {
    throw new Error("The existing client-koryuu role must be unmanaged and have no permissions before Koryuu can assign it.");
  }

  const [botState, member] = await Promise.all([
    getBotState(env, guildId),
    getMember(env, guildId, userId)
  ]);
  if (member.roles.includes(role.id)) return role.id;
  const botPermissions = effectiveGuildPermissions(guildId, botState.roles, botState.member);
  const canManageRoles = (botPermissions & (1n << PERMISSION_BITS.MANAGE_ROLES)) !== 0n ||
    (botPermissions & (1n << PERMISSION_BITS.ADMINISTRATOR)) !== 0n;
  if (!canManageRoles) throw new Error("Koryuu needs Manage Roles permission to assign client-koryuu.");
  const botHighest = Math.max(0, ...botState.roles
    .filter(item => botState.member.roles.includes(item.id))
    .map(item => item.position));
  const memberHighest = Math.max(0, ...roles
    .filter(item => member.roles.includes(item.id))
    .map(item => item.position));
  if (role.position >= botHighest || memberHighest >= botHighest) {
    throw new Error("Koryuu's highest role must be above both client-koryuu and the member's highest role.");
  }
  await discordRequest<void>(
    env,
    `/guilds/${guildId}/members/${userId}/roles/${role.id}`,
    "PUT"
  );
  return role.id;
}

export async function sendMessageToMentionedMember(
  env: Env,
  actorId: string,
  guildId: string,
  channelId: string,
  recipientId: string,
  message: string,
  mentionedUserIds: string[]
): Promise<string> {
  assertGuildId(guildId);
  assertSnowflake(channelId, "Channel ID");
  assertSnowflake(actorId, "Sender ID");
  assertSnowflake(recipientId, "Recipient ID");
  if (recipientId === actorId || !mentionedUserIds.includes(recipientId)) {
    throw new Error("The recipient must be another server member explicitly mentioned in your current message.");
  }
  const content = message.trim();
  if (!content || content.length > 1000 || /@(everyone|here)/i.test(content)) {
    throw new Error("Message text must be 1-1000 characters and cannot use @everyone or @here.");
  }
  const [recipient, botPermissions, channels] = await Promise.all([
    inspectGuildMember(env, guildId, recipientId),
    inspectBotPermissions(env, guildId, channelId),
    getChannels(env, guildId)
  ]);
  if (!channels.some(channel => channel.id === channelId)) {
    throw new Error("The destination channel does not exist in this server.");
  }
  const permissionNames = (botPermissions as { effective_permissions?: unknown }).effective_permissions;
  if (!Array.isArray(permissionNames) ||
    !permissionNames.includes("VIEW_CHANNEL") || !permissionNames.includes("SEND_MESSAGES")) {
    throw new Error("Koryuu does not have permission to send messages in this channel.");
  }
  await discordRequest(env, `/channels/${channelId}/messages`, "POST", {
    content: `<@${recipientId}> ${content}\n\n— sent by request from <@${actorId}>`,
    allowed_mentions: { parse: [], users: [recipientId] }
  });
  return `Sent your message to ${recipient.display_name} (<@${recipient.id}>) in this channel.`;
}

export async function sendDirectMessageOnRequest(
  env: Env,
  actorId: string,
  recipientId: string,
  message: string,
  guildId: string | null,
  mentionedUserIds: string[]
): Promise<string> {
  assertSnowflake(actorId, "Sender ID");
  assertSnowflake(recipientId, "Recipient ID");
  if (recipientId !== actorId && !mentionedUserIds.includes(recipientId)) {
    throw new Error("To DM someone else, explicitly mention them in your request. You can ask Koryuu to DM you without mentioning yourself.");
  }
  const content = message.trim();
  if (!content || content.length > 1000 || /@(everyone|here)/i.test(content)) {
    throw new Error("Message text must be 1-1000 characters and cannot use @everyone or @here.");
  }
  let recipientName = "you";
  if (guildId && recipientId !== actorId) {
    const recipient = await inspectGuildMember(env, guildId, recipientId);
    recipientName = recipient.display_name;
  }
  const channel = await discordRequest<{ id: string }>(
    env,
    "/users/@me/channels",
    "POST",
    { recipient_id: recipientId }
  );
  assertSnowflake(channel.id, "Direct-message channel ID");
  await discordRequest(
    env,
    `/channels/${channel.id}/messages`,
    "POST",
    {
      content: `${content}\n\n— sent by Koryuu at the request of <@${actorId}>`,
      allowed_mentions: { parse: [] }
    }
  );
  return `Sent your direct message to ${recipientName}${recipientId === actorId ? "" : ` (<@${recipientId}>)`}.`;
}

export async function listGuildTeams(env: Env, actorId: string, guildId: string): Promise<unknown[]> {
  if (actorId !== env.LILITH_USER_ID) throw new Error("Only the configured owner can inspect team records.");
  assertGuildId(guildId);
  const teams = await env.DB.prepare(
    `SELECT id, name, leader_id, role_id, channel_id, status, source_request_id, created_at, updated_at
     FROM community_teams WHERE guild_id = ? ORDER BY status, name COLLATE NOCASE LIMIT 100`
  ).bind(guildId).all<{
    id: string;
    name: string;
    leader_id: string;
    role_id: string;
    channel_id: string;
    status: string;
    source_request_id: string | null;
    created_at: string;
    updated_at: string;
  }>();
  return Promise.all(teams.results.map(async team => {
    const members = await env.DB.prepare(
      `SELECT user_id, member_role, joined_at FROM community_team_members
       WHERE team_id = ? AND active = 1 ORDER BY member_role, joined_at`
    ).bind(team.id).all<{ user_id: string; member_role: string; joined_at: string }>();
    return { ...team, members: members.results };
  }));
}

function effectiveGuildPermissions(
  guildId: string,
  roles: DiscordRole[],
  member: DiscordMember
): bigint {
  const everyone = roles.find(role => role.id === guildId);
  let permissions = BigInt(everyone?.permissions ?? "0");
  const roleIds = new Set(member.roles);
  for (const role of roles) {
    if (roleIds.has(role.id)) permissions |= BigInt(role.permissions);
  }
  return permissions;
}

export async function inspectBotPermissions(
  env: Env,
  guildId: string,
  channelId?: string
): Promise<unknown> {
  const state = await getBotState(env, guildId);
  let permissions = effectiveGuildPermissions(guildId, state.roles, state.member);
  const administrator = (permissions & (1n << PERMISSION_BITS.ADMINISTRATOR)) !== 0n;
  if (channelId) {
    assertSnowflake(channelId, "Channel ID");
    const channel = (await getChannels(env, guildId)).find(item => item.id === channelId);
    if (!channel) throw new Error("That channel does not exist in this server.");
    if (!administrator) {
      const overwrites = channel.permission_overwrites;
      const everyone = overwrites.find(item => item.id === guildId && item.type === 0);
      if (everyone) permissions = (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
      let roleDeny = 0n;
      let roleAllow = 0n;
      const memberRoleIds = new Set(state.member.roles);
      for (const overwrite of overwrites) {
        if (overwrite.type === 0 && memberRoleIds.has(overwrite.id)) {
          roleDeny |= BigInt(overwrite.deny);
          roleAllow |= BigInt(overwrite.allow);
        }
      }
      permissions = (permissions & ~roleDeny) | roleAllow;
      const memberOverwrite = overwrites.find(item => item.id === state.botId && item.type === 1);
      if (memberOverwrite) {
        permissions = (permissions & ~BigInt(memberOverwrite.deny)) | BigInt(memberOverwrite.allow);
      }
    }
  }
  const botRoles = state.roles.filter(role => state.member.roles.includes(role.id));
  const highestRole = botRoles.sort((left, right) => right.position - left.position)[0] ?? null;
  return {
    bot_id: state.botId,
    role_ids: state.member.roles,
    highest_role: highestRole ? { id: highestRole.id, name: highestRole.name, position: highestRole.position } : null,
    administrator,
    channel_id: channelId ?? null,
    effective_permissions: decodePermissions(permissions.toString()),
    effective_permissions_value: permissions.toString()
  };
}

function validateId(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is required.`);
  assertSnowflake(value, label);
  return value;
}

function validateUuid(value: unknown, label: string): string {
  if (typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} must be a valid ID.`);
  }
  return value;
}

function validatePermissionNames(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new Error(`${label} must be a list of supported permission names.`);
  }
  const names = [...new Set(value as string[])];
  for (const name of names) {
    if (!(name in PERMISSION_BITS)) throw new Error(`Unsupported Discord permission: ${name}.`);
  }
  return names;
}

export function parseServerOperation(value: unknown): ServerOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid server operation.");
  }
  const input = value as Record<string, unknown>;
  switch (input.operation) {
    case "create_role": {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name || name.length > 100) throw new Error("Role name must be 1-100 characters.");
      const color = input.color === undefined ? 0 : input.color;
      if (!Number.isInteger(color) || Number(color) < 0 || Number(color) > 0xffffff) {
        throw new Error("Role color must be a valid RGB integer.");
      }
      return {
        operation: "create_role",
        name,
        permissions: validatePermissionNames(input.permissions ?? [], "Permissions"),
        color: Number(color),
        hoist: input.hoist === true,
        mentionable: input.mentionable === true
      };
    }
    case "set_role_permissions":
      return {
        operation: "set_role_permissions",
        role_id: validateId(input.role_id, "Role ID"),
        permissions: validatePermissionNames(input.permissions, "Permissions")
      };
    case "delete_role":
      return { operation: "delete_role", role_id: validateId(input.role_id, "Role ID") };
    case "create_channel": {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name || name.length > 100 || !/^[a-z0-9_-]+$/i.test(name)) {
        throw new Error("Channel name must be 1-100 letters, numbers, underscores, or hyphens.");
      }
      if (input.channel_type !== "text" && input.channel_type !== "voice" && input.channel_type !== "category") {
        throw new Error("Channel type must be text, voice, or category.");
      }
      return {
        operation: "create_channel",
        name,
        channel_type: input.channel_type,
        ...(input.parent_id === undefined ? {} : { parent_id: validateId(input.parent_id, "Parent channel ID") })
      };
    }
    case "delete_channel":
      return { operation: "delete_channel", channel_id: validateId(input.channel_id, "Channel ID") };
    case "create_team": {
      const teamName = typeof input.team_name === "string" ? input.team_name.trim() : "";
      const roleName = typeof input.role_name === "string" ? input.role_name.trim() : "";
      const channelName = typeof input.channel_name === "string" ? input.channel_name.trim() : "";
      if (!teamName || teamName.length > 100) throw new Error("Team name must be 1-100 characters.");
      if (!roleName || roleName.length > 100) throw new Error("Team role name must be 1-100 characters.");
      if (!channelName || channelName.length > 100 || !/^[a-z0-9_-]+$/i.test(channelName)) {
        throw new Error("Team channel name must use 1-100 letters, numbers, underscores, or hyphens.");
      }
      if (!Array.isArray(input.member_ids) || input.member_ids.length > 50 ||
        input.member_ids.some(id => typeof id !== "string" || !/^\d{17,20}$/.test(id))) {
        throw new Error("Team members must be a list of up to 50 valid Discord user IDs.");
      }
      const memberIds = [...new Set(input.member_ids as string[])];
      if (memberIds.length !== input.member_ids.length) throw new Error("Team member IDs must be unique.");
      const leaderId = validateId(input.leader_id, "Team leader ID");
      if (!memberIds.includes(leaderId)) memberIds.unshift(leaderId);
      if (input.request_id !== undefined &&
        (typeof input.request_id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.request_id))) {
        throw new Error("Team application ID must be a valid request ID.");
      }
      return {
        operation: "create_team",
        team_name: teamName,
        role_name: roleName,
        channel_name: channelName,
        leader_id: leaderId,
        member_ids: memberIds,
        ...(typeof input.request_id === "string" ? { request_id: input.request_id } : {})
      };
    }
    case "update_team": {
      if (typeof input.action !== "string" ||
        !["add_member", "remove_member", "set_leader"].includes(input.action)) {
        throw new Error("Team update action must add_member, remove_member, or set_leader.");
      }
      return {
        operation: "update_team",
        team_id: validateUuid(input.team_id, "Team ID"),
        action: input.action as "add_member" | "remove_member" | "set_leader",
        member_id: validateId(input.member_id, "Member ID")
      };
    }
    case "archive_team":
      return {
        operation: "archive_team",
        team_id: validateUuid(input.team_id, "Team ID")
      };
    case "create_private_channel":
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        typeof input.request_id === "string" ? input.request_id : ""
      )) {
        throw new Error("Personal-channel request ID must be a valid request ID.");
      }
      if (!Array.isArray(input.member_ids) || input.member_ids.length < 4 ||
        input.member_ids.length > 21 ||
        input.member_ids.some(id => typeof id !== "string" || !/^\d{17,20}$/.test(id))) {
        throw new Error("A personal channel must include the applicant and at least three valid invited member IDs.");
      }
      {
        const memberIds = [...new Set(input.member_ids as string[])];
        if (memberIds.length !== input.member_ids.length) throw new Error("Personal-channel member IDs must be unique.");
        const name = typeof input.name === "string" ? input.name.trim() : "";
        if (!name || name.length > 100 || !/^[a-z0-9_-]+$/i.test(name)) {
          throw new Error("Private channel name must use 1-100 letters, numbers, underscores, or hyphens.");
        }
        return {
          operation: "create_private_channel",
          name,
          request_id: input.request_id as string,
          member_ids: memberIds
        };
      }
    case "set_channel_overwrite": {
      const allow = validatePermissionNames(input.allow, "Allowed permissions");
      const deny = validatePermissionNames(input.deny, "Denied permissions");
      if (allow.some(name => deny.includes(name))) {
        throw new Error("A permission cannot be both allowed and denied.");
      }
      if (input.target_type !== "role" && input.target_type !== "member") {
        throw new Error("Overwrite target type must be role or member.");
      }
      return {
        operation: "set_channel_overwrite",
        channel_id: validateId(input.channel_id, "Channel ID"),
        target_type: input.target_type,
        target_id: validateId(input.target_id, "Overwrite target ID"),
        allow,
        deny
      };
    }
    case "assign_member_role":
    case "remove_member_role":
      return {
        operation: input.operation,
        member_id: validateId(input.member_id, "Member ID"),
        role_id: validateId(input.role_id, "Role ID")
      };
    case "kick_member":
    case "ban_member":
      return {
        operation: input.operation,
        member_id: validateId(input.member_id, "Member ID")
      };
    case "timeout_member":
      if (!Number.isInteger(input.duration_minutes) || Number(input.duration_minutes) < 0 ||
        Number(input.duration_minutes) > 40320) {
        throw new Error("Timeout duration must be 0 (clear) or a whole number from 1 to 40320 minutes.");
      }
      return {
        operation: "timeout_member",
        member_id: validateId(input.member_id, "Member ID"),
        duration_minutes: Number(input.duration_minutes)
      };
    default:
      throw new Error("Unsupported server operation.");
  }
}

async function requireBotPermission(env: Env, guildId: string, permission: string): Promise<{
  roles: DiscordRole[];
  member: DiscordMember;
  highestPosition: number;
}> {
  const state = await getBotState(env, guildId);
  const effective = effectiveGuildPermissions(guildId, state.roles, state.member);
  const hasAdministrator = (effective & (1n << PERMISSION_BITS.ADMINISTRATOR)) !== 0n;
  const bit = PERMISSION_BITS[permission];
  if (bit === undefined || (!hasAdministrator && (effective & (1n << bit)) === 0n)) {
    throw new Error(`Koryuu is missing the ${permission} permission in this server.`);
  }
  const highestPosition = state.roles
    .filter(role => state.member.roles.includes(role.id))
    .reduce((highest, role) => Math.max(highest, role.position), 0);
  return { roles: state.roles, member: state.member, highestPosition };
}

async function requireManageableMember(
  env: Env,
  guildId: string,
  memberId: string,
  permission: string
): Promise<DiscordMember> {
  const [bot, member, guild] = await Promise.all([
    requireBotPermission(env, guildId, permission),
    getMember(env, guildId, memberId),
    discordRequest<{ owner_id: string }>(env, `/guilds/${guildId}`)
  ]);
  if (guild.owner_id === memberId) throw new Error("The server owner cannot be moderated by Koryuu.");
  const memberHighestPosition = bot.roles
    .filter(role => member.roles.includes(role.id))
    .reduce((highest, role) => Math.max(highest, role.position), 0);
  if (memberHighestPosition >= bot.highestPosition) {
    throw new Error("Koryuu cannot moderate a member at or above her highest role.");
  }
  return member;
}

async function prepareOperation(env: Env, guildId: string, operation: ServerOperation): Promise<string> {
  switch (operation.operation) {
    case "create_role": {
      const bot = await requireBotPermission(env, guildId, "MANAGE_ROLES");
      if (bot.roles.some(role => role.name.toLocaleLowerCase() === operation.name.toLocaleLowerCase())) {
        throw new Error("A role with that name already exists in this server.");
      }
      return `Create role **${operation.name}** with permissions: ${operation.permissions.join(", ") || "none"}; color ${operation.color}; hoisted ${operation.hoist}; mentionable ${operation.mentionable}.`;
    }
    case "set_role_permissions": {
      const bot = await requireBotPermission(env, guildId, "MANAGE_ROLES");
      const role = bot.roles.find(item => item.id === operation.role_id);
      if (!role) throw new Error("That role does not exist in this server.");
      if (role.managed || role.id === guildId) throw new Error("Managed roles and the @everyone role cannot be edited.");
      if (role.position >= bot.highestPosition) throw new Error("Koryuu cannot manage a role at or above her highest role.");
      return `Replace the entire permission set for **${role.name}** (<@&${role.id}>); currently recognized permissions: ${decodePermissions(role.permissions).join(", ") || "none"} (raw ${role.permissions}); set to: ${operation.permissions.join(", ") || "none"}.`;
    }
    case "delete_role": {
      const bot = await requireBotPermission(env, guildId, "MANAGE_ROLES");
      const role = bot.roles.find(item => item.id === operation.role_id);
      if (!role) throw new Error("That role does not exist in this server.");
      if (role.id === guildId || role.managed) throw new Error("The @everyone role and managed roles cannot be deleted.");
      if (role.position >= bot.highestPosition) throw new Error("Koryuu cannot delete a role at or above her highest role.");
      return `Delete role **${role.name}** (<@&${role.id}>). This removes the role from all members and cannot be undone.`;
    }
    case "create_channel": {
      await requireBotPermission(env, guildId, "MANAGE_CHANNELS");
      if (operation.channel_type === "category" && operation.parent_id) {
        throw new Error("A category channel cannot have a parent category.");
      }
      const channels = await getChannels(env, guildId);
      if (channels.some(channel =>
        channel.name.toLocaleLowerCase() === operation.name.toLocaleLowerCase() &&
        (channel.parent_id ?? null) === (operation.parent_id ?? null)
      )) {
        throw new Error("A channel with that name already exists in the requested category.");
      }
      if (operation.parent_id) {
        const parent = channels.find(item => item.id === operation.parent_id);
        if (!parent || parent.type !== 4) throw new Error("The requested parent must be an existing category channel.");
      }
      return `Create ${operation.channel_type} channel **${operation.name}**${operation.parent_id ? ` under <#${operation.parent_id}>` : ""}.`;
    }
    case "delete_channel": {
      await requireBotPermission(env, guildId, "MANAGE_CHANNELS");
      const channel = (await getChannels(env, guildId)).find(item => item.id === operation.channel_id);
      if (!channel) throw new Error("That channel does not exist in this server.");
      return `Delete **#${channel.name}** (<#${channel.id}>). This permanently removes the channel and its contents.`;
    }
    case "create_team": {
      const bot = await requireBotPermission(env, guildId, "MANAGE_ROLES");
      await requireBotPermission(env, guildId, "MANAGE_CHANNELS");
      if (bot.roles.some(role => role.name.toLocaleLowerCase() === operation.role_name.toLocaleLowerCase())) {
        throw new Error("A role with that name already exists in this server.");
      }
      const [channels, existingTeam] = await Promise.all([
        getChannels(env, guildId),
        env.DB.prepare(
          "SELECT id FROM community_teams WHERE guild_id = ? AND name = ? COLLATE NOCASE AND status = 'active'"
        ).bind(guildId, operation.team_name).first<{ id: string }>()
      ]);
      if (existingTeam) throw new Error("An active team with that name already exists in this server.");
      if (channels.some(channel => channel.name.toLocaleLowerCase() === operation.channel_name.toLocaleLowerCase())) {
        throw new Error("A channel with that name already exists in this server.");
      }
      if (operation.request_id) {
        const request = await env.DB.prepare(
          "SELECT submitter_id, category, status, metadata FROM community_requests WHERE id = ? AND guild_id = ?"
        ).bind(operation.request_id, guildId).first<{
          submitter_id: string;
          category: string;
          status: string;
          metadata: string;
        }>();
        if (!request || request.category !== "team" || request.status !== "approved" ||
          request.submitter_id !== operation.leader_id) {
          throw new Error("A linked team application must be approved and its submitter must be the team leader.");
        }
        const metadata = JSON.parse(request.metadata) as { partner_ids?: unknown; team_name?: unknown };
        const expected = [...new Set([request.submitter_id, ...(Array.isArray(metadata.partner_ids)
          ? metadata.partner_ids.filter((id): id is string => typeof id === "string")
          : [])])].sort();
        if (operation.member_ids.slice().sort().join(",") !== expected.join(",")) {
          throw new Error("Team members must match the approved applicant and the members listed in that application.");
        }
        if (typeof metadata.team_name === "string" &&
          metadata.team_name.toLocaleLowerCase() !== operation.team_name.toLocaleLowerCase()) {
          throw new Error("Team name must match the approved team application.");
        }
      }
      await Promise.all(operation.member_ids.map(id => getMember(env, guildId, id)));
      return `Create team **${operation.team_name}** with a no-permissions role **${operation.role_name}**, a private text channel **#${operation.channel_name}**, and role assignment for ${operation.member_ids.length} member(s). ${operation.member_ids.length === 1 ? "The applicant" : "The listed leader and members"} will have access; @everyone will be denied View Channel.${operation.request_id ? ` This fulfills approved application ${operation.request_id}.` : ""}`;
    }
    case "update_team": {
      const bot = await requireBotPermission(env, guildId, "MANAGE_ROLES");
      const team = await env.DB.prepare(
        `SELECT name, leader_id, role_id, channel_id, status FROM community_teams
         WHERE id = ? AND guild_id = ?`
      ).bind(operation.team_id, guildId).first<{
        name: string;
        leader_id: string;
        role_id: string;
        channel_id: string;
        status: string;
      }>();
      if (!team || team.status !== "active") throw new Error("That active team does not exist in this server.");
      const role = bot.roles.find(item => item.id === team.role_id);
      if (!role || role.managed || role.id === guildId || role.position >= bot.highestPosition) {
        throw new Error("Koryuu cannot manage the Discord role linked to this team.");
      }
      const [channel, membership] = await Promise.all([
        getChannels(env, guildId).then(channels => channels.find(item => item.id === team.channel_id)),
        env.DB.prepare(
          "SELECT member_role FROM community_team_members WHERE team_id = ? AND user_id = ? AND active = 1"
        ).bind(operation.team_id, operation.member_id).first<{ member_role: string }>()
      ]);
      if (!channel) throw new Error("The Discord channel linked to this team no longer exists.");
      if (operation.action === "add_member") {
        if (membership) throw new Error("That user is already an active team member.");
        await getMember(env, guildId, operation.member_id);
        return `Add <@${operation.member_id}> to team **${team.name}** and assign its role ${role.name} (<@&${role.id}>).`;
      }
      if (!membership) throw new Error("That user is not an active member of this team.");
      if (operation.action === "remove_member") {
        if (operation.member_id === team.leader_id) throw new Error("Assign another active member as leader before removing the current leader.");
        return `Remove <@${operation.member_id}> from team **${team.name}** and remove role ${role.name} (<@&${role.id}>).`;
      }
      return `Make <@${operation.member_id}> the leader of team **${team.name}**. The previous leader <@${team.leader_id}> remains a regular member.`;
    }
    case "archive_team": {
      const bot = await requireBotPermission(env, guildId, "MANAGE_ROLES");
      const team = await env.DB.prepare(
        `SELECT name, role_id, status FROM community_teams WHERE id = ? AND guild_id = ?`
      ).bind(operation.team_id, guildId).first<{ name: string; role_id: string; status: string }>();
      if (!team || team.status !== "active") throw new Error("That active team does not exist in this server.");
      const role = bot.roles.find(item => item.id === team.role_id);
      if (!role || role.managed || role.id === guildId || role.position >= bot.highestPosition) {
        throw new Error("Koryuu cannot manage the Discord role linked to this team.");
      }
      const members = await env.DB.prepare(
        "SELECT user_id FROM community_team_members WHERE team_id = ? AND active = 1"
      ).bind(operation.team_id).all<{ user_id: string }>();
      return `Archive team **${team.name}**: remove role ${role.name} (<@&${role.id}>) from ${members.results.length} active member(s) and retain the role and channel for audit/history.`;
    }
    case "create_private_channel": {
      await requireBotPermission(env, guildId, "MANAGE_CHANNELS");
      const request = await env.DB.prepare(
        `SELECT submitter_id, category, status, metadata
         FROM community_requests WHERE id = ? AND guild_id = ?`
      ).bind(operation.request_id, guildId).first<{
        submitter_id: string;
        category: string;
        status: string;
        metadata: string;
      }>();
      if (!request || request.category !== "personal_channel" || request.status !== "approved") {
        throw new Error("Only an approved personal-channel request in this server can provision a channel.");
      }
      const metadata = JSON.parse(request.metadata) as { partner_ids?: unknown };
      if (!Array.isArray(metadata.partner_ids) ||
        metadata.partner_ids.some(id => typeof id !== "string")) {
        throw new Error("The approved request has invalid partner data.");
      }
      const expectedMembers = [...new Set([request.submitter_id, ...(metadata.partner_ids as string[])])].sort();
      if (expectedMembers.length < 4 ||
        [...operation.member_ids].sort().join(",") !== expectedMembers.join(",")) {
        throw new Error("The private channel must include exactly the approved applicant and gathered partners.");
      }
      const channels = await getChannels(env, guildId);
      if (channels.some(channel => channel.name.toLocaleLowerCase() === operation.name.toLocaleLowerCase())) {
        throw new Error("A channel with that name already exists in this server.");
      }
      await Promise.all(operation.member_ids.map(id => getMember(env, guildId, id)));
      return `Create private text channel **${operation.name}** for the approved request. Only the applicant, the three or more approved partners, and Koryuu will receive explicit channel access; @everyone will be denied View Channel.`;
    }
    case "set_channel_overwrite": {
      const bot = await requireBotPermission(env, guildId, "MANAGE_CHANNELS");
      const [channels] = await Promise.all([getChannels(env, guildId)]);
      const channel = channels.find(item => item.id === operation.channel_id);
      if (!channel) throw new Error("That channel does not exist in this server.");
      let targetLabel: string;
      if (operation.target_type === "role") {
        const role = bot.roles.find(item => item.id === operation.target_id);
        if (!role) throw new Error("That role does not exist in this server.");
        if (role.id !== guildId && role.position >= bot.highestPosition) {
          throw new Error("Koryuu cannot manage permissions for a role at or above her highest role.");
        }
        targetLabel = `<@&${operation.target_id}>`;
      } else {
        const member = await getMember(env, guildId, operation.target_id);
        const name = member.nick ?? member.user.global_name ?? member.user.username;
        targetLabel = `${name} <@${operation.target_id}>`;
      }
      const overwrite = channel.permission_overwrites.find(item =>
        item.id === operation.target_id && item.type === (operation.target_type === "role" ? 0 : 1)
      );
      const current = overwrite
        ? `Current allow: ${decodePermissions(overwrite.allow).join(", ") || "none"}; current deny: ${decodePermissions(overwrite.deny).join(", ") || "none"}.`
        : "There is no current explicit overwrite for this target.";
      return `In <#${channel.id}> (${channel.name}), replace the permissions for ${targetLabel}. ${current} New allow: ${operation.allow.join(", ") || "none"}; new deny: ${operation.deny.join(", ") || "none"}.`;
    }
    case "assign_member_role":
    case "remove_member_role": {
      const bot = await requireBotPermission(env, guildId, "MANAGE_ROLES");
      const [role, member] = await Promise.all([
        Promise.resolve(bot.roles.find(item => item.id === operation.role_id)),
        getMember(env, guildId, operation.member_id)
      ]);
      if (!role) throw new Error("That role does not exist in this server.");
      if (role.managed || role.id === guildId) throw new Error("Managed roles and the @everyone role cannot be assigned or removed.");
      if (role.position >= bot.highestPosition) throw new Error("Koryuu cannot manage a role at or above her highest role.");
      const alreadyAssigned = member.roles.includes(role.id);
      return `${operation.operation === "assign_member_role" ? "Assign" : "Remove"} **${role.name}** (<@&${role.id}>) ${operation.operation === "assign_member_role" ? "to" : "from"} <@${member.user.id}>; the member ${alreadyAssigned ? "currently has" : "does not currently have"} this role.`;
    }
    case "kick_member":
    case "ban_member":
    case "timeout_member": {
      const permission = operation.operation === "kick_member"
        ? "KICK_MEMBERS"
        : operation.operation === "ban_member"
          ? "BAN_MEMBERS"
          : "MODERATE_MEMBERS";
      const member = await requireManageableMember(env, guildId, operation.member_id, permission);
      const displayName = member.nick ?? member.user.global_name ?? member.user.username;
      if (operation.operation === "kick_member") return `Kick ${displayName} (<@${member.user.id}>) from this server.`;
      if (operation.operation === "ban_member") return `Ban ${displayName} (<@${member.user.id}>) from this server without deleting message history.`;
      return operation.duration_minutes === 0
        ? `Remove the communication timeout from ${displayName} (<@${member.user.id}>).`
        : `Timeout ${displayName} (<@${member.user.id}>) for ${operation.duration_minutes} minute(s).`;
    }
  }
}

async function applyServerOperation(env: Env, guildId: string, operation: ServerOperation): Promise<string> {
  const preview = await prepareOperation(env, guildId, operation);
  switch (operation.operation) {
    case "create_role": {
      const role = await discordRequest<DiscordRole>(env, `/guilds/${guildId}/roles`, "POST", {
        name: operation.name,
        permissions: encodePermissions(operation.permissions).toString(),
        color: operation.color,
        hoist: operation.hoist,
        mentionable: operation.mentionable
      });
      return `${preview}\nCreated role ID: ${role.id}.`;
    }
    case "set_role_permissions":
      await discordRequest<DiscordRole>(env, `/guilds/${guildId}/roles/${operation.role_id}`, "PATCH", {
        permissions: encodePermissions(operation.permissions).toString()
      });
      return preview;
    case "delete_role":
      await discordRequest<void>(env, `/guilds/${guildId}/roles/${operation.role_id}`, "DELETE");
      return preview;
    case "create_channel": {
      const channel = await discordRequest<DiscordChannel>(env, `/guilds/${guildId}/channels`, "POST", {
        name: operation.name,
        type: operation.channel_type === "text" ? 0 : operation.channel_type === "voice" ? 2 : 4,
        ...(operation.parent_id ? { parent_id: operation.parent_id } : {})
      });
      return `${preview}\nCreated channel ID: ${channel.id}.`;
    }
    case "delete_channel":
      await discordRequest<void>(env, `/channels/${operation.channel_id}`, "DELETE");
      return preview;
    case "create_team": {
      const botId = await getDiscordBotId(env);
      let role: DiscordRole | undefined;
      let channel: DiscordChannel | undefined;
      try {
        role = await discordRequest<DiscordRole>(env, `/guilds/${guildId}/roles`, "POST", {
          name: operation.role_name,
          permissions: "0",
          color: 0,
          hoist: false,
          mentionable: false
        });
        channel = await discordRequest<DiscordChannel>(env, `/guilds/${guildId}/channels`, "POST", {
          name: operation.channel_name,
          type: 0,
          permission_overwrites: [
            { id: guildId, type: 0, allow: "0", deny: (1n << PERMISSION_BITS.VIEW_CHANNEL).toString() },
            {
              id: role.id,
              type: 0,
              allow: encodePermissions(["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY"]).toString(),
              deny: "0"
            },
            {
              id: botId,
              type: 1,
              allow: encodePermissions(["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY"]).toString(),
              deny: "0"
            }
          ]
        });
        for (const memberId of operation.member_ids) {
          await discordRequest<void>(
            env,
            `/guilds/${guildId}/members/${memberId}/roles/${role.id}`,
            "PUT"
          );
        }

        const teamId = crypto.randomUUID();
        const now = new Date().toISOString();
        const outcome = `Created team ${operation.team_name}; role ${role.id}; private channel ${channel.id}.`;
        const statements = operation.request_id
          ? [
              env.DB.prepare(
                `UPDATE community_requests SET status = 'in_progress', outcome = ?, updated_at = ?
                 WHERE id = ? AND guild_id = ? AND category = 'team' AND status = 'approved'`
              ).bind(outcome, now, operation.request_id, guildId),
              env.DB.prepare(
                `INSERT INTO community_teams(
                  id, guild_id, name, leader_id, role_id, channel_id, source_request_id,
                  created_by, created_at, updated_at
                )
                SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                WHERE EXISTS (
                  SELECT 1 FROM community_requests
                  WHERE id = ? AND guild_id = ? AND status = 'in_progress' AND outcome = ?
                )`
              ).bind(
                teamId, guildId, operation.team_name, operation.leader_id, role.id, channel.id,
                operation.request_id, env.LILITH_USER_ID, now, now,
                operation.request_id, guildId, outcome
              )
            ]
          : [
              env.DB.prepare(
                `INSERT INTO community_teams(
                  id, guild_id, name, leader_id, role_id, channel_id, created_by, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
              ).bind(
                teamId, guildId, operation.team_name, operation.leader_id, role.id, channel.id,
                env.LILITH_USER_ID, now, now
              )
            ];
        for (const memberId of operation.member_ids) {
          statements.push(env.DB.prepare(
            `INSERT INTO community_team_members(team_id, user_id, member_role, joined_at)
             VALUES (?, ?, ?, ?)`
          ).bind(teamId, memberId, memberId === operation.leader_id ? "leader" : "member", now));
        }
        statements.push(env.DB.prepare(
          `INSERT INTO community_team_events(id, team_id, actor_id, event_type, details, created_at)
           VALUES (?, ?, ?, 'created', ?, ?)`
        ).bind(
          crypto.randomUUID(),
          teamId,
          env.LILITH_USER_ID,
          JSON.stringify({ guildId, leaderId: operation.leader_id, memberIds: operation.member_ids, roleId: role.id, channelId: channel.id }),
          now
        ));
        if (operation.request_id) {
          statements.push(env.DB.prepare(
            `INSERT INTO community_request_events(id, request_id, actor_id, event_type, details, created_at)
             VALUES (?, ?, ?, 'status_changed', ?, ?)`
          ).bind(
            crypto.randomUUID(),
            operation.request_id,
            env.LILITH_USER_ID,
            JSON.stringify({ from: "approved", to: "in_progress", teamId, channelId: channel.id, roleId: role.id }),
            now
          ));
        }
        const results = await env.DB.batch(statements);
        const teamInsertIndex = operation.request_id ? 1 : 0;
        if (results[teamInsertIndex]?.meta?.changes !== 1) {
          throw new Error("The team record was not created; the linked application may no longer be approved.");
        }
        return `${preview}\nCreated team ID: ${teamId}; role ID: ${role.id}; private channel ID: ${channel.id}.`;
      } catch (error) {
        const rollbackErrors: string[] = [];
        if (channel) {
          try {
            await discordRequest<void>(env, `/channels/${channel.id}`, "DELETE");
          } catch (rollbackError) {
            rollbackErrors.push(`could not remove channel ${channel.id}: ${rollbackError instanceof Error ? rollbackError.message : "unknown error"}`);
          }
        }
        if (role) {
          try {
            await discordRequest<void>(env, `/guilds/${guildId}/roles/${role.id}`, "DELETE");
          } catch (rollbackError) {
            rollbackErrors.push(`could not remove role ${role.id}: ${rollbackError instanceof Error ? rollbackError.message : "unknown error"}`);
          }
        }
        if (rollbackErrors.length) {
          console.error("Team creation failed and Discord cleanup was incomplete:", rollbackErrors);
          throw new Error(`Team setup failed. Discord cleanup was incomplete (${rollbackErrors.join("; ")}). Inspect the server before retrying.`);
        }
        throw error;
      }
    }
    case "update_team": {
      const team = await env.DB.prepare(
        "SELECT name, leader_id, role_id FROM community_teams WHERE id = ? AND guild_id = ? AND status = 'active'"
      ).bind(operation.team_id, guildId).first<{ name: string; leader_id: string; role_id: string }>();
      if (!team) throw new Error("That active team does not exist in this server.");
      const now = new Date().toISOString();
      const eventId = crypto.randomUUID();
      if (operation.action === "add_member") {
        await discordRequest<void>(
          env,
          `/guilds/${guildId}/members/${operation.member_id}/roles/${team.role_id}`,
          "PUT"
        );
        try {
          await env.DB.batch([
            env.DB.prepare(
              `INSERT INTO community_team_members(team_id, user_id, member_role, active, joined_at, left_at)
               VALUES (?, ?, 'member', 1, ?, NULL)
               ON CONFLICT(team_id, user_id) DO UPDATE SET
                 member_role = 'member', active = 1, joined_at = excluded.joined_at, left_at = NULL`
            ).bind(operation.team_id, operation.member_id, now),
            env.DB.prepare(
              `INSERT INTO community_team_events(id, team_id, actor_id, event_type, details, created_at)
               VALUES (?, ?, ?, 'member_added', ?, ?)`
            ).bind(eventId, operation.team_id, env.LILITH_USER_ID, JSON.stringify({ memberId: operation.member_id }), now)
          ]);
        } catch (error) {
          try {
            await discordRequest<void>(
              env,
              `/guilds/${guildId}/members/${operation.member_id}/roles/${team.role_id}`,
              "DELETE"
            );
          } catch (rollbackError) {
            console.error("Team member was assigned a Discord role but the database update and rollback failed:", rollbackError);
            throw new Error("Discord assigned the team role, but Koryuu could not record or roll back the membership. Inspect the team before retrying.");
          }
          throw error;
        }
        return `Added <@${operation.member_id}> to team **${team.name}**.`;
      }
      if (operation.action === "remove_member") {
        await discordRequest<void>(
          env,
          `/guilds/${guildId}/members/${operation.member_id}/roles/${team.role_id}`,
          "DELETE"
        );
        try {
          const results = await env.DB.batch([
            env.DB.prepare(
              `UPDATE community_team_members SET active = 0, left_at = ?, member_role = 'member'
               WHERE team_id = ? AND user_id = ? AND active = 1`
            ).bind(now, operation.team_id, operation.member_id),
            env.DB.prepare(
              `INSERT INTO community_team_events(id, team_id, actor_id, event_type, details, created_at)
               VALUES (?, ?, ?, 'member_removed', ?, ?)`
            ).bind(eventId, operation.team_id, env.LILITH_USER_ID, JSON.stringify({ memberId: operation.member_id }), now)
          ]);
          if (results[0]?.meta?.changes !== 1) throw new Error("Team membership changed before it could be removed.");
        } catch (error) {
          try {
            await discordRequest<void>(
              env,
              `/guilds/${guildId}/members/${operation.member_id}/roles/${team.role_id}`,
              "PUT"
            );
          } catch (rollbackError) {
            console.error("Team member role was removed but the database update and rollback failed:", rollbackError);
            throw new Error("Discord removed the team role, but Koryuu could not record or roll back the membership. Inspect the team before retrying.");
          }
          throw error;
        }
        return `Removed <@${operation.member_id}> from team **${team.name}**.`;
      }
      const results = await env.DB.batch([
        env.DB.prepare(
          "UPDATE community_teams SET leader_id = ?, updated_at = ? WHERE id = ? AND guild_id = ? AND status = 'active'"
        ).bind(operation.member_id, now, operation.team_id, guildId),
        env.DB.prepare(
          `UPDATE community_team_members SET member_role = 'member'
           WHERE team_id = ? AND member_role = 'leader' AND active = 1`
        ).bind(operation.team_id),
        env.DB.prepare(
          `UPDATE community_team_members SET member_role = 'leader'
           WHERE team_id = ? AND user_id = ? AND active = 1`
        ).bind(operation.team_id, operation.member_id),
        env.DB.prepare(
          `INSERT INTO community_team_events(id, team_id, actor_id, event_type, details, created_at)
           VALUES (?, ?, ?, 'leader_changed', ?, ?)`
        ).bind(
          eventId, operation.team_id, env.LILITH_USER_ID,
          JSON.stringify({ previousLeaderId: team.leader_id, leaderId: operation.member_id }), now
        )
      ]);
      if (results[0]?.meta?.changes !== 1 || results[2]?.meta?.changes !== 1) {
        throw new Error("Team leadership changed before the new leader could be recorded.");
      }
      return `Assigned <@${operation.member_id}> as leader of team **${team.name}**; <@${team.leader_id}> remains a member.`;
    }
    case "archive_team": {
      const team = await env.DB.prepare(
        "SELECT name, role_id FROM community_teams WHERE id = ? AND guild_id = ? AND status = 'active'"
      ).bind(operation.team_id, guildId).first<{ name: string; role_id: string }>();
      if (!team) throw new Error("That active team does not exist in this server.");
      const members = await env.DB.prepare(
        "SELECT user_id FROM community_team_members WHERE team_id = ? AND active = 1"
      ).bind(operation.team_id).all<{ user_id: string }>();
      const removed: string[] = [];
      try {
        for (const member of members.results) {
          await discordRequest<void>(
            env,
            `/guilds/${guildId}/members/${member.user_id}/roles/${team.role_id}`,
            "DELETE"
          );
          removed.push(member.user_id);
        }
      } catch (error) {
        const rollbackErrors: string[] = [];
        for (const memberId of removed) {
          try {
            await discordRequest<void>(
              env,
              `/guilds/${guildId}/members/${memberId}/roles/${team.role_id}`,
              "PUT"
            );
          } catch (rollbackError) {
            rollbackErrors.push(`${memberId}: ${rollbackError instanceof Error ? rollbackError.message : "unknown error"}`);
          }
        }
        if (rollbackErrors.length) {
          console.error("Team archive failed and member-role rollback was incomplete:", rollbackErrors);
          throw new Error(`Team archive failed and some roles could not be restored (${rollbackErrors.join(", ")}). Inspect the roster.`);
        }
        throw error;
      }
      const now = new Date().toISOString();
      try {
        const results = await env.DB.batch([
          env.DB.prepare(
            `UPDATE community_teams SET status = 'archived', archived_at = ?, updated_at = ?
             WHERE id = ? AND guild_id = ? AND status = 'active'`
          ).bind(now, now, operation.team_id, guildId),
          env.DB.prepare(
            `UPDATE community_team_members SET active = 0, left_at = ?, member_role = 'member'
             WHERE team_id = ? AND active = 1 AND changes() = 1`
          ).bind(now, operation.team_id),
          env.DB.prepare(
            `INSERT INTO community_team_events(id, team_id, actor_id, event_type, details, created_at)
             SELECT ?, ?, ?, 'archived', ?, ?
             WHERE EXISTS (
               SELECT 1 FROM community_teams WHERE id = ? AND status = 'archived' AND archived_at = ?
             )`
          ).bind(
            crypto.randomUUID(), operation.team_id, env.LILITH_USER_ID,
            JSON.stringify({ removedMemberIds: removed }), now, operation.team_id, now
          )
        ]);
        if (results[0]?.meta?.changes !== 1) throw new Error("The team was changed before it could be archived.");
      } catch (error) {
        const rollbackErrors: string[] = [];
        for (const memberId of removed) {
          try {
            await discordRequest<void>(
              env,
              `/guilds/${guildId}/members/${memberId}/roles/${team.role_id}`,
              "PUT"
            );
          } catch (rollbackError) {
            rollbackErrors.push(`${memberId}: ${rollbackError instanceof Error ? rollbackError.message : "unknown error"}`);
          }
        }
        if (rollbackErrors.length) {
          console.error("Team archive persistence failed and member-role rollback was incomplete:", rollbackErrors);
          throw new Error(`The archive was not recorded and some roles could not be restored (${rollbackErrors.join(", ")}). Inspect the roster.`);
        }
        throw error;
      }
      return `Archived team **${team.name}** and removed its role from ${removed.length} active member(s). Its role and private channel remain for audit/history.`;
    }
    case "create_private_channel": {
      const botId = await getDiscordBotId(env);
      const channel = await discordRequest<DiscordChannel>(env, `/guilds/${guildId}/channels`, "POST", {
        name: operation.name,
        type: 0,
        permission_overwrites: [
          { id: guildId, type: 0, allow: "0", deny: (1n << PERMISSION_BITS.VIEW_CHANNEL).toString() },
          {
            id: botId,
            type: 1,
            allow: encodePermissions(["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY"]).toString(),
            deny: "0"
          },
          ...operation.member_ids.map(id => ({
            id,
            type: 1,
            allow: encodePermissions(["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY"]).toString(),
            deny: "0"
          }))
        ]
      });
      const outcome = `Created private channel <#${channel.id}> for the approved personal-channel request.`;
      try {
        const now = new Date().toISOString();
        const updated = await env.DB.prepare(
          `UPDATE community_requests SET status = 'in_progress', outcome = ?, updated_at = ?
           WHERE id = ? AND guild_id = ? AND category = 'personal_channel' AND status = 'approved'`
        ).bind(outcome, now, operation.request_id, guildId).run();
        if (updated.meta?.changes !== 1) {
          throw new Error("The approved request status changed before it could be updated.");
        }
        await env.DB.prepare(
          `INSERT INTO community_request_events(id, request_id, actor_id, event_type, details, created_at)
           VALUES (?, ?, ?, 'status_changed', ?, ?)`
        ).bind(
          crypto.randomUUID(),
          operation.request_id,
          env.LILITH_USER_ID,
          JSON.stringify({ from: "approved", to: "in_progress", channelId: channel.id }),
          now
        ).run();
      } catch (error) {
        console.error(`Private channel ${channel.id} was created but request ${operation.request_id} could not be updated:`, error);
        throw new Error(`Discord created channel ${channel.id}, but the request record was not updated. Check that channel before retrying.`);
      }
      return `${preview}\nCreated channel ID: ${channel.id}.`;
    }
    case "set_channel_overwrite":
      await discordRequest<void>(
        env,
        `/channels/${operation.channel_id}/permissions/${operation.target_id}`,
        "PUT",
        {
          type: operation.target_type === "role" ? 0 : 1,
          allow: encodePermissions(operation.allow).toString(),
          deny: encodePermissions(operation.deny).toString()
        }
      );
      return preview;
    case "assign_member_role":
      await discordRequest<void>(
        env,
        `/guilds/${guildId}/members/${operation.member_id}/roles/${operation.role_id}`,
        "PUT"
      );
      return preview;
    case "remove_member_role":
      await discordRequest<void>(
        env,
        `/guilds/${guildId}/members/${operation.member_id}/roles/${operation.role_id}`,
        "DELETE"
      );
      return preview;
    case "kick_member":
      await discordRequest<void>(env, `/guilds/${guildId}/members/${operation.member_id}`, "DELETE");
      return preview;
    case "ban_member":
      await discordRequest<void>(env, `/guilds/${guildId}/bans/${operation.member_id}`, "PUT", {
        delete_message_seconds: 0
      });
      return preview;
    case "timeout_member":
      await discordRequest<DiscordMember>(env, `/guilds/${guildId}/members/${operation.member_id}`, "PATCH", {
        communication_disabled_until: operation.duration_minutes === 0
          ? null
          : new Date(Date.now() + operation.duration_minutes * 60_000).toISOString()
      });
      return preview;
  }
}

export async function stageServerChange(
  env: Env,
  actorId: string,
  guildId: string,
  input: unknown
): Promise<{ id: string; preview: string }> {
  if (actorId !== env.LILITH_USER_ID) throw new Error("Only the configured server owner can approve server changes.");
  assertGuildId(guildId);
  const operation = parseServerOperation(input);
  const preview = await prepareOperation(env, guildId, operation);
  const id = crypto.randomUUID();
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 2 * 60 * 1000).toISOString();
  const details = { guildId, operation, preview, expiresAt };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO server_change_proposals(
        id, guild_id, requester_id, operation_type, payload, preview, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      guildId,
      actorId,
      operation.operation,
      JSON.stringify(operation),
      preview,
      createdAt,
      expiresAt
    ),
    env.DB.prepare(
      "INSERT INTO system_logs(actor_id, action, details) VALUES (?, ?, ?)"
    ).bind(actorId, "server.change.proposed", JSON.stringify({ proposalId: id, ...details }))
  ]);
  return { id, preview };
}

export async function stagePersonalChannelForRequest(
  env: Env,
  actorId: string,
  guildId: string,
  requestId: string
): Promise<{ id: string; preview: string }> {
  if (actorId !== env.LILITH_USER_ID) throw new Error("Only the configured owner can provision a personal channel.");
  assertGuildId(guildId);
  const request = await env.DB.prepare(
    `SELECT id, submitter_id, title, category, status, metadata
     FROM community_requests WHERE id = ? AND guild_id = ?`
  ).bind(requestId, guildId).first<{
    id: string;
    submitter_id: string;
    title: string;
    category: string;
    status: string;
    metadata: string;
  }>();
  if (!request || request.category !== "personal_channel" || request.status !== "approved") {
    throw new Error("Only an approved personal-channel request in this server can be provisioned.");
  }
  const metadata = JSON.parse(request.metadata) as { partner_ids?: unknown };
  if (!Array.isArray(metadata.partner_ids) || metadata.partner_ids.length < 3 ||
    metadata.partner_ids.some(id => typeof id !== "string")) {
    throw new Error("The approved request does not contain at least three valid partners.");
  }
  const baseName = request.title.toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const name = `personal-${baseName || request.id.slice(0, 8)}`.slice(0, 100);
  return stageServerChange(env, actorId, guildId, {
    operation: "create_private_channel",
    name,
    request_id: request.id,
    member_ids: [...new Set([request.submitter_id, ...(metadata.partner_ids as string[])])]
  });
}

export async function cancelServerChange(env: Env, actorId: string, proposalId: string): Promise<void> {
  if (actorId !== env.LILITH_USER_ID) throw new Error("Only the configured server owner can cancel server changes.");
  const result = await env.DB.prepare(
    `UPDATE server_change_proposals SET status = 'cancelled'
     WHERE id = ? AND requester_id = ? AND status = 'pending' AND expires_at > ?`
  ).bind(proposalId, actorId, new Date().toISOString()).run();
  if (result.meta?.changes !== 1) throw new Error("This server-change confirmation is no longer available.");
}

export async function confirmServerChange(
  env: Env,
  actorId: string,
  proposalId: string
): Promise<string> {
  if (actorId !== env.LILITH_USER_ID) throw new Error("Only the configured server owner can approve server changes.");
  const now = new Date().toISOString();
  const proposal = await env.DB.prepare(
    `SELECT guild_id, payload, preview FROM server_change_proposals
     WHERE id = ? AND requester_id = ? AND status = 'pending' AND expires_at > ?`
  ).bind(proposalId, actorId, now).first<{ guild_id: string; payload: string; preview: string }>();
  if (!proposal) throw new Error("This server-change confirmation has expired or was already used.");
  const claim = await env.DB.prepare(
    `UPDATE server_change_proposals SET status = 'confirmed', authorized_by = ?
     WHERE id = ? AND requester_id = ? AND status = 'pending' AND expires_at > ?`
  ).bind(actorId, proposalId, actorId, now).run();
  if (claim.meta?.changes !== 1) throw new Error("This server-change confirmation has already been used.");
  let executorId = "koryuu-worker";
  let result: string;
  try {
    executorId = await getDiscordBotId(env);
    const operation = parseServerOperation(JSON.parse(proposal.payload));
    result = await applyServerOperation(env, proposal.guild_id, operation);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Server change execution failed.";
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE server_change_proposals SET status = 'failed', executed_by = ?, executed_at = ?, result = ?
         WHERE id = ? AND status = 'confirmed'`
      ).bind(executorId, new Date().toISOString(), message, proposalId),
      env.DB.prepare(
        "INSERT INTO system_logs(actor_id, action, details) VALUES (?, ?, ?)"
      ).bind(executorId, "server.change.failed", JSON.stringify({
        proposalId,
        guildId: proposal.guild_id,
        authorizedBy: actorId,
        executedBy: executorId,
        error: message
      }))
    ]);
    throw error;
  }
  const executedAt = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE server_change_proposals SET executed_by = ?, executed_at = ?, result = ?
         WHERE id = ? AND status = 'confirmed'`
      ).bind(executorId, executedAt, result, proposalId),
      env.DB.prepare(
        "INSERT INTO system_logs(actor_id, action, details) VALUES (?, ?, ?)"
      ).bind(executorId, "server.change.executed", JSON.stringify({
        proposalId,
        guildId: proposal.guild_id,
        authorizedBy: actorId,
        executedBy: executorId,
        result
      }))
    ]);
  } catch (error) {
    console.error("Discord change succeeded but its result could not be fully persisted:", error);
    throw new Error("Discord applied the change, but Koryuu could not record the result. Inspect the server before retrying.");
  }
  return result;
}

export async function executeAutomationDiscordAction(
  env: Env,
  guildId: string,
  action: { type: "add_role"; member_id: string; role_id: string } |
    { type: "remove_role"; member_id: string; role_id: string } |
    { type: "send_message"; channel_id: string; content: string; nonce?: string }
): Promise<string> {
  assertGuildId(guildId);
  if (action.type === "send_message") {
    if (action.content.length > 1800) throw new Error("Automation message exceeds the Discord message limit.");
    assertSnowflake(action.channel_id, "Channel ID");
    const permissions = await inspectBotPermissions(env, guildId, action.channel_id) as {
      effective_permissions: string[];
    };
    if (!permissions.effective_permissions.includes("VIEW_CHANNEL") ||
      !permissions.effective_permissions.includes("SEND_MESSAGES")) {
      throw new Error("Koryuu needs View Channel and Send Messages permissions for the automation action.");
    }
    await discordRequest(env, `/channels/${action.channel_id}/messages`, "POST", {
      content: action.content,
      ...(action.nonce ? { nonce: action.nonce, enforce_nonce: true } : {}),
      allowed_mentions: { parse: [] }
    });
    return `Sent a message to channel ${action.channel_id}.`;
  }
  const operation: ServerOperation = action.type === "add_role"
    ? { operation: "assign_member_role", member_id: action.member_id, role_id: action.role_id }
    : { operation: "remove_member_role", member_id: action.member_id, role_id: action.role_id };
  return applyServerOperation(env, guildId, operation);
}

export async function validateAutomationDiscordAction(
  env: Env,
  guildId: string,
  action: { type: "add_role" | "remove_role"; role_id: string } |
    { type: "send_message"; channel_id: string }
): Promise<string> {
  if (action.type === "send_message") {
    assertSnowflake(action.channel_id, "Channel ID");
    const channel = (await getChannels(env, guildId)).find(item => item.id === action.channel_id);
    if (!channel || ![0, 5].includes(channel.type)) {
      throw new Error("Automation message target must be an existing text-based server channel.");
    }
    const report = await inspectBotPermissions(env, guildId, channel.id) as {
      effective_permissions: string[];
    };
    if (!report.effective_permissions.includes("VIEW_CHANNEL") ||
      !report.effective_permissions.includes("SEND_MESSAGES")) {
      throw new Error("Koryuu needs View Channel and Send Messages permissions in the automation channel.");
    }
    return `#${channel.name} (${channel.id})`;
  }
  const bot = await requireBotPermission(env, guildId, "MANAGE_ROLES");
  const role = bot.roles.find(item => item.id === action.role_id);
  if (!role) throw new Error("An automation target role does not exist in this server.");
  if (role.managed || role.id === guildId) throw new Error("An automation cannot assign or remove a managed or @everyone role.");
  if (role.position >= bot.highestPosition) {
    throw new Error("Koryuu cannot manage an automation role at or above her highest role.");
  }
  return `@${role.name} (${role.id})`;
}
