import type { Env } from "./platform.js";
import { readMemberRoleState } from "./discord-server.js";
import { ORGANIC_ROLE_ID } from "./linked-roles.js";

const DISCORD_API = "https://discord.com/api/v10";
const VERIFICATION_GIF_URL = "https://i.imgflip.com/b5dv6n.gif";
const VERIFICATION_GIF_PAGE_URL = "https://imgflip.com/gif/b5dv6n";
export const VERIFICATION_REMINDER_MODERATOR_ROLE_ID = "1568982117176713398";
const MEMBER_PAGE_SIZE = 100;
const MAX_SCAN_PAGES_PER_TICK = 5;
const MAX_DMS_PER_TICK = 10;
const MAX_DELIVERY_ATTEMPTS = 5;
const DELIVERY_RETRY_MS = 5 * 60 * 1000;

interface Campaign {
  id: string;
  guild_id: string;
  status: "scanning" | "sending";
  after_user_id: string | null;
}

interface GuildMember {
  user?: { id?: unknown; bot?: unknown };
  roles?: unknown;
}

class DiscordReminderApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "DiscordReminderApiError";
  }
}

function assertSnowflake(value: string, label: string): void {
  if (!/^\d{17,20}$/.test(value)) throw new Error(`${label} must be a valid Discord ID.`);
}

async function discordMembersPage(
  env: Env,
  guildId: string,
  after: string | null
): Promise<GuildMember[]> {
  if (!env.DISCORD_BOT_TOKEN) throw new Error("Discord bot token is not configured.");
  const url = new URL(`${DISCORD_API}/guilds/${guildId}/members`);
  url.searchParams.set("limit", String(MEMBER_PAGE_SIZE));
  if (after) url.searchParams.set("after", after);
  const response = await fetch(url, {
    headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    redirect: "manual"
  });
  if (!response.ok) throw new Error(`Discord member listing failed (HTTP ${response.status}).`);
  const members: unknown = await response.json();
  if (!Array.isArray(members)) throw new Error("Discord returned an invalid member page.");
  for (const member of members) {
    const row = member as GuildMember;
    if (!row.user || typeof row.user.id !== "string" || !/^\d{17,20}$/.test(row.user.id) ||
      !Array.isArray(row.roles) || row.roles.some(role => typeof role !== "string")) {
      throw new Error("Discord returned an invalid server member.");
    }
  }
  return members as GuildMember[];
}

export async function startVerificationReminderCampaign(
  env: Env,
  guildId: string,
  actorId: string
): Promise<{ campaignId: string; alreadyRunning: boolean }> {
  assertSnowflake(guildId, "Server ID");
  assertSnowflake(actorId, "Moderator ID");
  if (!env.ARCHIVE_GUILD_ID || env.ARCHIVE_GUILD_ID !== guildId) {
    throw new Error("Verification reminder campaigns are only available in the configured server.");
  }
  const moderatorState = await readMemberRoleState(
    env,
    guildId,
    actorId,
    VERIFICATION_REMINDER_MODERATOR_ROLE_ID
  );
  if (!moderatorState.memberExists || !moderatorState.roleExists || !moderatorState.hasRole) {
    throw new Error("Only a current member with the configured Moderator role can start this campaign.");
  }
  const organicRoleState = await readMemberRoleState(env, guildId, actorId, ORGANIC_ROLE_ID);
  if (!organicRoleState.roleExists) throw new Error("The 100% Organic role is not available in this server.");

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO verification_reminder_campaigns(id, guild_id, requested_by, status, created_at, updated_at, result)
       VALUES (?, ?, ?, 'scanning', ?, ?, 'Campaign accepted; scanning server members.')`
    ).bind(id, guildId, actorId, now, now).run();
    return { campaignId: id, alreadyRunning: false };
  } catch (error) {
    const active = await env.DB.prepare(
      `SELECT id FROM verification_reminder_campaigns
       WHERE guild_id = ? AND status IN ('scanning', 'sending') LIMIT 1`
    ).bind(guildId).first<{ id: string }>();
    if (active) return { campaignId: active.id, alreadyRunning: true };
    throw error;
  }
}

function reminderMessage(previousSentAt: string | null, now: Date, memberId: string): string {
  const versions = [
    "Quick verification reminder: please complete Discord Linked Roles to receive the **100% Organic** role.",
    "When you have a moment, please finish the Linked Roles check and claim your **100% Organic** role.",
    "A friendly nudge to complete Linked Roles for **100% Organic**. It helps us finish your server verification.",
    "Still need verification? Complete the Linked Roles check to get **100% Organic**. Thanks!"
  ];
  const seed = memberId.charCodeAt(memberId.length - 1) + Number(memberId.slice(-2));
  const text = versions[seed % versions.length];
  const lastSent = previousSentAt ? new Date(previousSentAt).toISOString() : "No previous reminder recorded.";
  return [
    text,
    `Last reminder sent: ${lastSent}`,
    `This reminder: ${now.toISOString()}`,
    "Complete the check from the server's Linked Roles settings.",
    `Verification guide: ${VERIFICATION_GIF_PAGE_URL}`
  ].join("\n");
}

async function stableDiscordNonce(campaignId: string, memberId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${campaignId}:${memberId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.slice(0, 12), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function sendCampaignDm(
  env: Env,
  campaignId: string,
  memberId: string,
  previousSentAt: string | null,
  now: Date
): Promise<void> {
  if (!env.DISCORD_BOT_TOKEN) throw new Error("Discord bot token is not configured.");
  const dmResponse = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: "POST",
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ recipient_id: memberId }),
    redirect: "manual"
  });
  if (!dmResponse.ok) {
    throw new DiscordReminderApiError(
      `Discord rejected DM channel creation (HTTP ${dmResponse.status}).`,
      dmResponse.status
    );
  }
  const dmChannel = await dmResponse.json() as { id?: unknown };
  if (typeof dmChannel.id !== "string" || !/^\d{17,20}$/.test(dmChannel.id)) {
    throw new Error("Discord returned an invalid DM channel.");
  }
  const messageResponse = await fetch(`${DISCORD_API}/channels/${dmChannel.id}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      content: reminderMessage(previousSentAt, now, memberId),
      embeds: [{ image: { url: VERIFICATION_GIF_URL } }],
      nonce: await stableDiscordNonce(campaignId, memberId),
      enforce_nonce: true,
      allowed_mentions: { parse: [] }
    }),
    redirect: "manual"
  });
  if (!messageResponse.ok) {
    throw new DiscordReminderApiError(
      `Discord rejected the verification reminder (HTTP ${messageResponse.status}).`,
      messageResponse.status
    );
  }
}

async function scanCampaignPage(env: Env, campaign: Campaign, nowIso: string): Promise<void> {
  const members = await discordMembersPage(env, campaign.guild_id, campaign.after_user_id);
  const eligible = members.filter(member =>
    member.user?.bot !== true && !(member.roles as string[]).includes(ORGANIC_ROLE_ID)
  );
  const statements = eligible.map(member => env.DB.prepare(
    `INSERT OR IGNORE INTO verification_reminder_recipients(
       campaign_id, member_id, status, previous_sent_at, next_attempt_at
     ) VALUES (?, ?, 'pending', (
       SELECT MAX(r.sent_at)
       FROM verification_reminder_recipients r
       JOIN verification_reminder_campaigns c ON c.id = r.campaign_id
       WHERE c.guild_id = ? AND r.member_id = ? AND r.status = 'sent'
     ), ?)`
  ).bind(campaign.id, member.user?.id, campaign.guild_id, member.user?.id, nowIso));
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
    `UPDATE verification_reminder_campaigns
     SET status = ?, after_user_id = ?, scanned_count = scanned_count + ?,
         target_count = target_count + ?, updated_at = ?,
         result = CASE WHEN ? = 'sending' THEN 'Member scan complete; sending one DM per eligible member.' ELSE 'Member scan in progress.' END
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
    `UPDATE verification_reminder_recipients
     SET status = ?, result = ?, next_attempt_at = ?, claimed_at = NULL,
         sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END,
         attempt_count = attempt_count + 1
     WHERE campaign_id = ? AND member_id = ?`
  ).bind(status, result.slice(0, 1000), nextAttemptAt, status, nowIso, campaignId, memberId).run();
}

async function deliverCampaignBatch(env: Env, campaign: Campaign, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  await env.DB.prepare(
    `UPDATE verification_reminder_recipients
     SET status = 'pending', claimed_at = NULL, next_attempt_at = ?
     WHERE campaign_id = ? AND status = 'sending' AND claimed_at < ?`
  ).bind(nowIso, campaign.id, new Date(now.getTime() - 15 * 60 * 1000).toISOString()).run();
  const due = await env.DB.prepare(
    `SELECT member_id, previous_sent_at, attempt_count
     FROM verification_reminder_recipients
     WHERE campaign_id = ? AND status = 'pending' AND next_attempt_at <= ?
     ORDER BY member_id LIMIT ?`
  ).bind(campaign.id, nowIso, MAX_DMS_PER_TICK).all<{
    member_id: string;
    previous_sent_at: string | null;
    attempt_count: number;
  }>();

  for (const recipient of due.results) {
    const claim = await env.DB.prepare(
      `UPDATE verification_reminder_recipients
       SET status = 'sending', claimed_at = ?
       WHERE campaign_id = ? AND member_id = ? AND status = 'pending' AND next_attempt_at <= ?`
    ).bind(nowIso, campaign.id, recipient.member_id, nowIso).run();
    if (claim.meta?.changes !== 1) continue;

    try {
      const state = await readMemberRoleState(env, campaign.guild_id, recipient.member_id, ORGANIC_ROLE_ID);
      if (!state.memberExists) {
        await markRecipient(env, campaign.id, recipient.member_id, "skipped", nowIso, "Member left the server.");
        continue;
      }
      if (!state.roleExists) {
        await env.DB.prepare(
          `UPDATE verification_reminder_campaigns SET status = 'failed', updated_at = ?,
             result = 'Campaign stopped: the 100% Organic role no longer exists.'
           WHERE id = ? AND status IN ('scanning', 'sending')`
        ).bind(nowIso, campaign.id).run();
        await markRecipient(env, campaign.id, recipient.member_id, "failed", nowIso, "The target role no longer exists.");
        return;
      }
      if (state.hasRole) {
        await markRecipient(env, campaign.id, recipient.member_id, "skipped", nowIso, "Member verified before delivery.");
        continue;
      }
      await sendCampaignDm(env, campaign.id, recipient.member_id, recipient.previous_sent_at, now);
      await markRecipient(env, campaign.id, recipient.member_id, "sent", nowIso, "Reminder delivered.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Discord delivery failed.";
      const retryable = error instanceof TypeError ||
        (error instanceof DiscordReminderApiError &&
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
      console.error(`Verification reminder campaign ${campaign.id} could not message ${recipient.member_id}:`, error);
    }
  }
}

export async function processVerificationReminderCampaigns(env: Env, now = new Date()): Promise<void> {
  const nowIso = now.toISOString();
  const campaign = await env.DB.prepare(
    `SELECT id, guild_id, status, after_user_id
     FROM verification_reminder_campaigns
     WHERE status IN ('scanning', 'sending')
     ORDER BY created_at LIMIT 1`
  ).first<Campaign>();
  if (!campaign) return;

  if (campaign.status === "scanning") {
    let cursor = campaign;
    for (let page = 0; page < MAX_SCAN_PAGES_PER_TICK && cursor.status === "scanning"; page++) {
      await scanCampaignPage(env, cursor, nowIso);
      const updated = await env.DB.prepare(
        "SELECT id, guild_id, status, after_user_id FROM verification_reminder_campaigns WHERE id = ?"
      ).bind(cursor.id).first<Campaign>();
      if (!updated) throw new Error("Verification reminder campaign disappeared during its member scan.");
      cursor = updated;
    }
    if (cursor.status === "scanning") return;
  }

  const sendingCampaign = await env.DB.prepare(
    "SELECT id, guild_id, status, after_user_id FROM verification_reminder_campaigns WHERE id = ?"
  ).bind(campaign.id).first<Campaign>();
  if (!sendingCampaign || sendingCampaign.status !== "sending") return;
  await deliverCampaignBatch(env, sendingCampaign, now);
  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM verification_reminder_recipients
     WHERE campaign_id = ? AND status IN ('pending', 'sending')`
  ).bind(campaign.id).first<{ count: number }>();
  if ((remaining?.count ?? 0) === 0) {
    await env.DB.prepare(
      `UPDATE verification_reminder_campaigns
       SET status = 'completed', updated_at = ?,
           result = 'Campaign completed; recipients were sent at most one DM each.'
       WHERE id = ? AND status = 'sending'`
    ).bind(nowIso, campaign.id).run();
  }
}
