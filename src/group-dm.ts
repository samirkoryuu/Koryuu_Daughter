import type { Env } from "./platform.js";
import { readMemberRoleState } from "./discord-server.js";
import { VERIFICATION_REMINDER_MODERATOR_ROLE_ID } from "./verification-reminder.js";

const DISCORD_API = "https://discord.com/api/v10";
const MEMBER_PAGE_SIZE = 100;
const MAX_RECIPIENTS_PER_TICK = 10;
const MAX_SCAN_PAGES_PER_TICK = 5;
const MAX_DELIVERY_ATTEMPTS = 5;
const DELIVERY_RETRY_MS = 5 * 60 * 1000;
const MAX_SELECTED_RECIPIENTS = 100;

interface Campaign {
  id: string;
  guild_id: string;
  requested_by: string;
  message: string;
  audience: "everyone" | "selected";
  status: "scanning" | "sending";
  after_user_id: string | null;
}

interface GuildMember {
  user?: { id?: unknown; bot?: unknown };
  roles?: unknown;
}

class DiscordGroupDmApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "DiscordGroupDmApiError";
  }
}

function assertSnowflake(value: string, label: string): void {
  if (!/^\d{17,20}$/.test(value)) throw new Error(`${label} must be a valid Discord ID.`);
}

async function discordFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!init.headers) init.headers = {};
  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) {
    throw new Error("Discord bot token is not configured.");
  }
  const response = await fetch(`${DISCORD_API}${path}`, { ...init, headers, redirect: "manual" });
  if (!response.ok) {
    throw new DiscordGroupDmApiError(`Discord rejected the group DM operation (HTTP ${response.status}).`, response.status);
  }
  return response;
}

async function botFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  if (!env.DISCORD_BOT_TOKEN) throw new Error("Discord bot token is not configured.");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bot ${env.DISCORD_BOT_TOKEN}`);
  return discordFetch(path, { ...init, headers });
}

function validateMessage(value: string): string {
  const message = value.trim();
  if (!message || message.length > 1000 || /@(everyone|here)/i.test(message)) {
    throw new Error("Group DM text must be 1-1000 characters and cannot use @everyone or @here.");
  }
  return message;
}

export async function startGroupDmCampaign(
  env: Env,
  guildId: string,
  actorId: string,
  input: {
    allMembers: boolean;
    recipientUserIds: string[];
    mentionedUserIds: string[];
    everyoneMentioned: boolean;
    message: string;
  }
): Promise<{ campaignId: string; audience: "everyone" | "selected"; targetCount: number | null }> {
  assertSnowflake(guildId, "Server ID");
  assertSnowflake(actorId, "Moderator ID");
  const message = validateMessage(input.message);
  if (input.allMembers !== input.everyoneMentioned) {
    throw new Error("Use @everyone in your current server message to target all members.");
  }

  const moderator = await readMemberRoleState(
    env,
    guildId,
    actorId,
    VERIFICATION_REMINDER_MODERATOR_ROLE_ID
  );
  if (!moderator.memberExists || !moderator.roleExists || !moderator.hasRole) {
    throw new Error("Only a current member with the configured Moderator role can send group DMs.");
  }

  const recipientIds = [...new Set(input.recipientUserIds)];
  if (input.allMembers) {
    if (recipientIds.length) throw new Error("Choose either @everyone or specific members, not both.");
  } else {
    if (recipientIds.some(id => !input.mentionedUserIds.includes(id) || id === actorId)) {
      throw new Error("Every group-DM recipient must be another member explicitly mentioned in your current request.");
    }
    if (recipientIds.length < 2 || recipientIds.length > MAX_SELECTED_RECIPIENTS) {
      throw new Error(`Choose between 2 and ${MAX_SELECTED_RECIPIENTS} explicitly mentioned members.`);
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const audience = input.allMembers ? "everyone" : "selected";
  const status = input.allMembers ? "scanning" : "sending";
  const statements = [
    env.DB.prepare(
      `INSERT INTO group_dm_campaigns(
         id, guild_id, requested_by, message, audience, status, created_at, updated_at, result
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      guildId,
      actorId,
      message,
      audience,
      status,
      now,
      now,
      input.allMembers
        ? "Campaign accepted; scanning current human server members."
        : "Campaign accepted; sending to explicitly mentioned members."
    )
  ];
  if (!input.allMembers) {
    for (const recipientId of recipientIds) {
      statements.push(env.DB.prepare(
        `INSERT INTO group_dm_recipients(campaign_id, member_id, status, next_attempt_at)
         VALUES (?, ?, 'pending', ?)`
      ).bind(id, recipientId, now));
    }
  }
  await env.DB.batch(statements);
  return {
    campaignId: id,
    audience,
    targetCount: input.allMembers ? null : recipientIds.length
  };
}

async function discordMembersPage(env: Env, guildId: string, after: string | null): Promise<GuildMember[]> {
  const query = new URLSearchParams({ limit: String(MEMBER_PAGE_SIZE) });
  if (after) query.set("after", after);
  const response = await botFetch(env, `/guilds/${guildId}/members?${query}`);
  const members: unknown = await response.json();
  if (!Array.isArray(members)) throw new Error("Discord returned an invalid server member page.");
  for (const member of members) {
    const row = member as GuildMember;
    if (!row.user || typeof row.user.id !== "string" || !/^\d{17,20}$/.test(row.user.id) ||
      !Array.isArray(row.roles) ||
      row.roles.some(role => typeof role !== "string")) {
      throw new Error("Discord returned an invalid server member.");
    }
  }
  return members as GuildMember[];
}

async function scanCampaignPage(env: Env, campaign: Campaign, nowIso: string): Promise<void> {
  const members = await discordMembersPage(env, campaign.guild_id, campaign.after_user_id);
  const eligible = members.filter(member =>
    member.user?.bot !== true && member.user?.id !== campaign.requested_by
  );
  const statements = eligible.map(member => env.DB.prepare(
    `INSERT OR IGNORE INTO group_dm_recipients(campaign_id, member_id, status, next_attempt_at)
     VALUES (?, ?, 'pending', ?)`
  ).bind(campaign.id, member.user?.id, nowIso));
  let insertedCount = 0;
  for (let index = 0; index < statements.length; index += 50) {
    const results = await env.DB.batch(statements.slice(index, index + 50));
    insertedCount += results.reduce((sum, result) => sum + (result.meta?.changes ?? 0), 0);
  }
  const nextAfter = members.length === MEMBER_PAGE_SIZE
    ? members[members.length - 1]?.user?.id as string
    : null;
  const status = nextAfter ? "scanning" : "sending";
  await env.DB.prepare(
    `UPDATE group_dm_campaigns
     SET status = ?, after_user_id = ?, scanned_count = scanned_count + ?,
         target_count = target_count + ?, updated_at = ?,
         result = CASE WHEN ? = 'sending' THEN 'Member scan complete; sending individual DMs.' ELSE 'Member scan in progress.' END
     WHERE id = ? AND status = 'scanning' AND after_user_id IS ?`
  ).bind(status, nextAfter, members.length, insertedCount, nowIso, status, campaign.id, campaign.after_user_id).run();
}

async function markRecipient(
  env: Env,
  campaignId: string,
  memberId: string,
  status: "pending" | "sent" | "skipped" | "failed",
  nowIso: string,
  result: string,
  nextAttemptAt = nowIso
): Promise<void> {
  await env.DB.prepare(
    `UPDATE group_dm_recipients
     SET status = ?, result = ?, next_attempt_at = ?, claimed_at = NULL,
         attempt_count = attempt_count + 1
     WHERE campaign_id = ? AND member_id = ?`
  ).bind(status, result.slice(0, 1000), nextAttemptAt, campaignId, memberId).run();
}

async function getCurrentMember(env: Env, guildId: string, memberId: string): Promise<GuildMember | null> {
  try {
    const response = await botFetch(env, `/guilds/${guildId}/members/${memberId}`);
    return await response.json() as GuildMember;
  } catch (error) {
    if (error instanceof DiscordGroupDmApiError && error.status === 404) return null;
    throw error;
  }
}

async function sendGroupDm(env: Env, campaign: Campaign, recipientId: string): Promise<void> {
  const channelResponse = await botFetch(env, "/users/@me/channels", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipient_id: recipientId })
  });
  const channel = await channelResponse.json() as { id?: unknown };
  if (typeof channel.id !== "string" || !/^\d{17,20}$/.test(channel.id)) {
    throw new Error("Discord returned an invalid direct-message channel.");
  }
  const messageResponse = await botFetch(env, `/channels/${channel.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: `${campaign.message}\n\n— sent by Koryuu at the request of <@${campaign.requested_by}>`,
      nonce: `${campaign.id.slice(0, 20)}${recipientId.slice(-4)}`,
      enforce_nonce: true,
      allowed_mentions: { parse: [] }
    })
  });
  await messageResponse.body?.cancel();
}

async function deliverCampaignBatch(env: Env, campaign: Campaign, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  await env.DB.prepare(
    `UPDATE group_dm_recipients
     SET status = 'pending', claimed_at = NULL, next_attempt_at = ?
     WHERE campaign_id = ? AND status = 'sending' AND claimed_at < ?`
  ).bind(nowIso, campaign.id, new Date(now.getTime() - 15 * 60 * 1000).toISOString()).run();
  const due = await env.DB.prepare(
    `SELECT member_id, attempt_count
     FROM group_dm_recipients
     WHERE campaign_id = ? AND status = 'pending' AND next_attempt_at <= ?
     ORDER BY member_id LIMIT ?`
  ).bind(campaign.id, nowIso, MAX_RECIPIENTS_PER_TICK).all<{
    member_id: string;
    attempt_count: number;
  }>();

  for (const recipient of due.results) {
    const claim = await env.DB.prepare(
      `UPDATE group_dm_recipients
       SET status = 'sending', claimed_at = ?
       WHERE campaign_id = ? AND member_id = ? AND status = 'pending' AND next_attempt_at <= ?`
    ).bind(nowIso, campaign.id, recipient.member_id, nowIso).run();
    if (claim.meta?.changes !== 1) continue;

    try {
      const member = await getCurrentMember(env, campaign.guild_id, recipient.member_id);
      if (!member || member.user?.bot === true) {
        await markRecipient(env, campaign.id, recipient.member_id, "skipped", nowIso, "Member is no longer eligible.");
        continue;
      }
      await sendGroupDm(env, campaign, recipient.member_id);
      await markRecipient(env, campaign.id, recipient.member_id, "sent", nowIso, "Direct message delivered.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Discord delivery failed.";
      const retryable = error instanceof TypeError ||
        (error instanceof DiscordGroupDmApiError &&
          (error.status === 408 || error.status === 429 || error.status >= 500));
      if (retryable && recipient.attempt_count + 1 < MAX_DELIVERY_ATTEMPTS) {
        await markRecipient(
          env,
          campaign.id,
          recipient.member_id,
          "pending",
          nowIso,
          `${reason} Will retry.`,
          new Date(now.getTime() + DELIVERY_RETRY_MS).toISOString()
        );
      } else {
        await markRecipient(env, campaign.id, recipient.member_id, "failed", nowIso, reason);
      }
      console.error(`Group DM campaign ${campaign.id} could not message ${recipient.member_id}:`, error);
    }
  }
}

async function processCampaign(env: Env, campaign: Campaign, now: Date): Promise<void> {
  const authorization = await readMemberRoleState(
    env,
    campaign.guild_id,
    campaign.requested_by,
    VERIFICATION_REMINDER_MODERATOR_ROLE_ID
  );
  if (!authorization.memberExists || !authorization.roleExists || !authorization.hasRole) {
    await env.DB.prepare(
      `UPDATE group_dm_campaigns SET status = 'failed', updated_at = ?,
         result = 'Campaign stopped: the requester no longer has the Moderator role.'
       WHERE id = ? AND status IN ('scanning', 'sending')`
    ).bind(now.toISOString(), campaign.id).run();
    return;
  }

  let cursor = campaign;
  if (cursor.status === "scanning") {
    for (let page = 0; page < MAX_SCAN_PAGES_PER_TICK && cursor.status === "scanning"; page++) {
      await scanCampaignPage(env, cursor, now.toISOString());
      const updated = await env.DB.prepare(
        "SELECT id, guild_id, requested_by, message, audience, status, after_user_id FROM group_dm_campaigns WHERE id = ?"
      ).bind(cursor.id).first<Campaign>();
      if (!updated) throw new Error("Group DM campaign disappeared during its member scan.");
      cursor = updated;
    }
    if (cursor.status === "scanning") return;
  }

  await deliverCampaignBatch(env, cursor, now);
  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM group_dm_recipients
     WHERE campaign_id = ? AND status IN ('pending', 'sending')`
  ).bind(cursor.id).first<{ count: number }>();
  if ((remaining?.count ?? 0) === 0) {
    await env.DB.prepare(
      `UPDATE group_dm_campaigns
       SET status = 'completed', updated_at = ?,
           result = 'Campaign completed; each eligible member received at most one DM.'
       WHERE id = ? AND status = 'sending'`
    ).bind(now.toISOString(), cursor.id).run();
  }
}

export async function processGroupDmCampaigns(env: Env, now = new Date()): Promise<void> {
  const campaign = await env.DB.prepare(
    `SELECT id, guild_id, requested_by, message, audience, status, after_user_id
     FROM group_dm_campaigns
     WHERE status IN ('scanning', 'sending')
     ORDER BY created_at LIMIT 1`
  ).first<Campaign>();
  if (campaign) await processCampaign(env, campaign, now);
}
