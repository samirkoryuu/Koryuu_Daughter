import type { Env } from "./platform.js";
import { getDiscordBotId, readMemberRoleState } from "./discord-server.js";

const DISCORD_API = "https://discord.com/api/v10";
const LINKED_ROLE_SCOPE = "identify role_connections.write";
export const ORGANIC_ROLE_ID = "1566823723305271428";
const ONBOARDING_GIF_URL = "https://imgflip.com/gif/b5dv6n";
const REMINDER_INTERVAL_MS = 20 * 60 * 1000;

interface OAuthTokenResponse {
  access_token?: unknown;
  token_type?: unknown;
}

interface OAuthUser {
  id?: unknown;
  username?: unknown;
  global_name?: unknown;
}

function workerOrigin(env: Env): string {
  if (!env.WORKER_PUBLIC_URL) throw new Error("WORKER_PUBLIC_URL is not configured for Linked Roles.");
  let url: URL;
  try {
    url = new URL(env.WORKER_PUBLIC_URL);
  } catch {
    throw new Error("WORKER_PUBLIC_URL must be a valid HTTP(S) URL.");
  }
  const isLocalDevelopment = url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLocalDevelopment) {
    throw new Error("WORKER_PUBLIC_URL must use HTTPS outside local development.");
  }
  return url.origin;
}

function htmlResponse(message: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Koryuu Linked Roles</title><body><main><h1>Koryuu Linked Roles</h1><p>${message}</p><p>You may close this window and return to Discord.</p></main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff"
      }
    }
  );
}

export function linkedRoleInstructionText(env: Env): string {
  const verificationUrl = new URL("/discord/linked-role", workerOrigin(env)).toString();
  return [
    "To link your account and get the **100% Organic** role:",
    `1. Open ${verificationUrl} and authorize Koryuu's Discord account link.`,
    "2. Return to Discord and complete the **Linked Roles** check for this server.",
    `If needed, [view the onboarding GIF](${ONBOARDING_GIF_URL}).`
  ].join("\n");
}

async function updateOnboarding(
  env: Env,
  guildId: string,
  memberId: string,
  status: "sent" | "already_linked" | "failed",
  result: string
): Promise<void> {
  const updated = await env.DB.prepare(
    `UPDATE linked_role_onboarding SET status = ?, result = ?, updated_at = ?
     WHERE guild_id = ? AND member_id = ? AND status = 'checking'`
  ).bind(status, result.slice(0, 1000), new Date().toISOString(), guildId, memberId).run();
  if (updated.meta?.changes !== 1) throw new Error("The Linked Role onboarding attempt changed before its result was recorded.");
}

async function sendDirectMessage(env: Env, memberId: string, content: string): Promise<void> {
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
  if (!dmResponse.ok) throw new Error(`Discord rejected onboarding DM creation (HTTP ${dmResponse.status}).`);
  const channel = await dmResponse.json() as { id?: unknown };
  if (typeof channel.id !== "string" || !/^\d{17,20}$/.test(channel.id)) {
    throw new Error("Discord returned an invalid onboarding DM channel.");
  }
  const messageResponse = await fetch(`${DISCORD_API}/channels/${channel.id}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [] }
    }),
    redirect: "manual"
  });
  if (!messageResponse.ok) throw new Error(`Discord rejected the onboarding message (HTTP ${messageResponse.status}).`);
}

async function sendOnboardingDm(env: Env, memberId: string): Promise<void> {
  await sendDirectMessage(env, memberId, `Welcome to the server!\n${linkedRoleInstructionText(env)}`);
}

async function sendLinkedRoleReminder(env: Env, memberId: string): Promise<void> {
  const verificationUrl = new URL("/discord/linked-role", workerOrigin(env)).toString();
  await sendDirectMessage(
    env,
    memberId,
    `You asked me to remind you: complete Linked Roles to get the **100% Organic** role. I'll stop when you have it.\n${verificationUrl}`
  );
}

export async function processLinkedRoleJoin(
  env: Env,
  guildId: string,
  memberId: string,
  joinedAt: string
): Promise<{ status: "sent" | "already_linked" | "failed" | "duplicate"; result: string }> {
  if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(memberId) ||
    !Number.isFinite(Date.parse(joinedAt))) {
    throw new Error("Invalid Linked Role onboarding event.");
  }
  const now = new Date().toISOString();
  const inserted = await env.DB.prepare(
    `INSERT INTO linked_role_onboarding(guild_id, member_id, joined_at, status, created_at, updated_at)
     VALUES (?, ?, ?, 'checking', ?, ?)
     ON CONFLICT(guild_id, member_id) DO NOTHING`
  ).bind(guildId, memberId, joinedAt, now, now).run();
  if (inserted.meta?.changes !== 1) {
    return { status: "duplicate", result: "An onboarding attempt was already recorded for this member and server." };
  }

  try {
    const roleState = await readMemberRoleState(env, guildId, memberId, ORGANIC_ROLE_ID);
    if (!roleState.memberExists) {
      await updateOnboarding(env, guildId, memberId, "failed", "The member is no longer in the server.");
      return { status: "failed", result: "The member is no longer in the server." };
    }
    if (roleState.hasRole) {
      await updateOnboarding(env, guildId, memberId, "already_linked", "The member already had the target Linked Role.");
      return { status: "already_linked", result: "The member already has the target Linked Role." };
    }
    if (!roleState.roleExists) {
      await updateOnboarding(env, guildId, memberId, "failed", `Target role ${ORGANIC_ROLE_ID} does not exist in this server.`);
      return { status: "failed", result: "The target Linked Role does not exist in this server." };
    }

    const refreshedRoleState = await readMemberRoleState(env, guildId, memberId, ORGANIC_ROLE_ID);
    if (refreshedRoleState.hasRole) {
      await updateOnboarding(env, guildId, memberId, "already_linked", "The member obtained the target Linked Role before onboarding delivery.");
      return { status: "already_linked", result: "The member obtained the target Linked Role before onboarding delivery." };
    }
    await sendOnboardingDm(env, memberId);
    const updated = await env.DB.prepare(
      `UPDATE linked_role_onboarding
       SET status = 'sent', result = 'One-time onboarding DM delivered; reminders require a separate opt-in.',
           next_reminder_at = NULL, updated_at = ?
       WHERE guild_id = ? AND member_id = ? AND status = 'checking'`
    ).bind(new Date().toISOString(), guildId, memberId).run();
    if (updated.meta?.changes !== 1) throw new Error("The Linked Role onboarding attempt changed before its result was recorded.");
    return { status: "sent", result: "One-time onboarding DM was delivered." };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Discord onboarding failed.";
    await updateOnboarding(env, guildId, memberId, "failed", reason);
    console.error(`Linked Role onboarding failed for member ${memberId} in guild ${guildId}:`, error);
    return { status: "failed", result: "The one-time onboarding DM could not be delivered; no automatic retry will be made." };
  }
}

export async function setLinkedRoleReminderSubscription(
  env: Env,
  guildId: string,
  memberId: string,
  enabled: boolean,
  now = new Date()
): Promise<{ status: "active" | "disabled" | "already_linked"; message: string }> {
  if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(memberId)) {
    throw new Error("Invalid Linked Role reminder subscription.");
  }
  if (!env.ARCHIVE_GUILD_ID || guildId !== env.ARCHIVE_GUILD_ID) {
    throw new Error("Verification reminder subscriptions are available only in the configured server.");
  }
  const nowIso = now.toISOString();
  if (!enabled) {
    await env.DB.prepare(
      `INSERT INTO linked_role_reminder_subscriptions(
         guild_id, member_id, status, subscribed_at, next_reminder_at, result, updated_at
       ) VALUES (?, ?, 'disabled', ?, NULL, 'Member opted out.', ?)
       ON CONFLICT(guild_id, member_id) DO UPDATE SET
         status = 'disabled', next_reminder_at = NULL,
         result = 'Member opted out.', updated_at = excluded.updated_at`
    ).bind(guildId, memberId, nowIso, nowIso).run();
    return { status: "disabled", message: "Verification reminders are off." };
  }
  const roleState = await readMemberRoleState(env, guildId, memberId, ORGANIC_ROLE_ID);
  if (!roleState.memberExists) throw new Error("You must still be a member of this server to subscribe.");
  if (!roleState.roleExists) throw new Error("The 100% Organic role is not available in this server.");
  if (roleState.hasRole) {
    await env.DB.prepare(
      `INSERT INTO linked_role_reminder_subscriptions(
         guild_id, member_id, status, subscribed_at, next_reminder_at, result, updated_at
       ) VALUES (?, ?, 'verified', ?, NULL, 'Already has the 100% Organic role.', ?)
       ON CONFLICT(guild_id, member_id) DO UPDATE SET
         status = 'verified', next_reminder_at = NULL,
         result = 'Already has the 100% Organic role.', updated_at = excluded.updated_at`
    ).bind(guildId, memberId, nowIso, nowIso).run();
    return { status: "already_linked", message: "You already have the 100% Organic role, so no reminders are needed." };
  }
  const nextReminderAt = new Date(now.getTime() + REMINDER_INTERVAL_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO linked_role_reminder_subscriptions(
       guild_id, member_id, status, subscribed_at, next_reminder_at, result, updated_at
     ) VALUES (?, ?, 'active', ?, ?, 'Opted in; reminders start in 20 minutes.', ?)
     ON CONFLICT(guild_id, member_id) DO UPDATE SET
       status = 'active', subscribed_at = excluded.subscribed_at,
       next_reminder_at = excluded.next_reminder_at, result = excluded.result,
       updated_at = excluded.updated_at`
  ).bind(guildId, memberId, nowIso, nextReminderAt, nowIso).run();
  return { status: "active", message: "You're opted in. I'll DM you every 20 minutes until you get the 100% Organic role. Use /linked-role reminders:false to stop." };
}

export async function processDueLinkedRoleReminderSubscriptions(env: Env, now = new Date()): Promise<void> {
  const nowIso = now.toISOString();
  const due = await env.DB.prepare(
    `SELECT guild_id, member_id
     FROM linked_role_reminder_subscriptions
     WHERE status = 'active' AND next_reminder_at <= ?
     ORDER BY next_reminder_at
     LIMIT 100`
  ).bind(nowIso).all<{ guild_id: string; member_id: string }>();

  for (const reminder of due.results) {
    const nextReminderAt = new Date(now.getTime() + REMINDER_INTERVAL_MS).toISOString();
    const claimed = await env.DB.prepare(
      `UPDATE linked_role_reminder_subscriptions
       SET next_reminder_at = ?, updated_at = ?
       WHERE guild_id = ? AND member_id = ? AND status = 'active' AND next_reminder_at <= ?`
    ).bind(nextReminderAt, nowIso, reminder.guild_id, reminder.member_id, nowIso).run();
    if (claimed.meta?.changes !== 1) continue;

    try {
      const roleState = await readMemberRoleState(env, reminder.guild_id, reminder.member_id, ORGANIC_ROLE_ID);
      if (!roleState.memberExists) {
        await env.DB.prepare(
          `UPDATE linked_role_reminder_subscriptions
           SET status = 'left', result = 'Member left the server; opted-in reminders stopped.',
               next_reminder_at = NULL, updated_at = ?
           WHERE guild_id = ? AND member_id = ? AND status = 'active'`
        ).bind(nowIso, reminder.guild_id, reminder.member_id).run();
        continue;
      }
      if (!roleState.roleExists) {
        await env.DB.prepare(
          `UPDATE linked_role_reminder_subscriptions
           SET status = 'failed', result = 'Target Linked Role no longer exists; reminders stopped.',
               next_reminder_at = NULL, updated_at = ?
           WHERE guild_id = ? AND member_id = ? AND status = 'active'`
        ).bind(nowIso, reminder.guild_id, reminder.member_id).run();
        continue;
      }
      if (roleState.hasRole) {
        await env.DB.prepare(
          `UPDATE linked_role_reminder_subscriptions
           SET status = 'verified', result = 'Member obtained the target Linked Role; reminders stopped.',
               next_reminder_at = NULL, updated_at = ?
           WHERE guild_id = ? AND member_id = ? AND status = 'active'`
        ).bind(nowIso, reminder.guild_id, reminder.member_id).run();
        continue;
      }
      await sendLinkedRoleReminder(env, reminder.member_id);
      await env.DB.prepare(
        `UPDATE linked_role_reminder_subscriptions
         SET last_reminded_at = ?, reminder_count = reminder_count + 1,
             result = 'Opted-in Linked Role reminder delivered; subscription remains active.', updated_at = ?
         WHERE guild_id = ? AND member_id = ? AND status = 'active'`
      ).bind(nowIso, nowIso, reminder.guild_id, reminder.member_id).run();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Discord reminder failed.";
      await env.DB.prepare(
        `UPDATE linked_role_reminder_subscriptions SET result = ?, updated_at = ?
         WHERE guild_id = ? AND member_id = ? AND status = 'active'`
      ).bind(`Opted-in Linked Role reminder failed; it will be retried after the reminder interval. ${reason}`.slice(0, 1000),
        nowIso, reminder.guild_id, reminder.member_id).run();
      console.error(`Linked Role reminder failed for member ${reminder.member_id} in guild ${reminder.guild_id}:`, error);
    }
  }
}

export async function markStaleOnboardingAttempts(env: Env, olderThan: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE linked_role_onboarding
     SET status = 'failed', result = 'Onboarding attempt expired before a result was recorded; no automatic retry will be made.',
         updated_at = ?
     WHERE status = 'checking' AND updated_at < ?`
  ).bind(new Date().toISOString(), olderThan).run();
}

export async function beginLinkedRoleVerification(env: Env): Promise<Response> {
  if (!env.DISCORD_CLIENT_SECRET) throw new Error("The Worker Discord OAuth client secret is not configured.");
  const applicationId = await getDiscordBotId(env);
  const origin = workerOrigin(env);
  const redirectUri = new URL("/discord/linked-role/callback", origin).toString();
  const state = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO linked_role_oauth_states(state, redirect_uri, created_at, expires_at)
     VALUES (?, ?, ?, ?)`
  ).bind(state, redirectUri, now.toISOString(), expiresAt).run();

  const authorizationUrl = new URL("https://discord.com/oauth2/authorize");
  authorizationUrl.searchParams.set("client_id", applicationId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", LINKED_ROLE_SCOPE);
  authorizationUrl.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: {
      location: authorizationUrl.toString(),
      "cache-control": "no-store"
    }
  });
}

async function markOAuthStateFailed(env: Env, state: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE linked_role_oauth_states SET status = 'failed'
     WHERE state = ? AND status = 'processing'`
  ).bind(state).run();
}

export async function finishLinkedRoleVerification(env: Env, requestUrl: URL): Promise<Response> {
  const state = requestUrl.searchParams.get("state") ?? "";
  const code = requestUrl.searchParams.get("code") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(state)) {
    return htmlResponse("This verification link is invalid or expired.", 400);
  }
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT redirect_uri FROM linked_role_oauth_states
     WHERE state = ? AND status = 'pending' AND expires_at > ?`
  ).bind(state, now).first<{ redirect_uri: string }>();
  if (!row) return htmlResponse("This verification link is expired or has already been used.", 410);
  const claimed = await env.DB.prepare(
    `UPDATE linked_role_oauth_states SET status = 'processing'
     WHERE state = ? AND status = 'pending' AND expires_at > ?`
  ).bind(state, now).run();
  if (claimed.meta?.changes !== 1) return htmlResponse("This verification link has already been used.", 409);

  try {
    if (requestUrl.searchParams.has("error") || !code || code.length > 2048) {
      throw new Error("Discord authorization was not completed.");
    }
    if (!env.DISCORD_CLIENT_SECRET) throw new Error("Linked Roles OAuth is not configured.");
    const applicationId = await getDiscordBotId(env);
    const tokenBody = new URLSearchParams({
      client_id: applicationId,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: row.redirect_uri,
      scope: LINKED_ROLE_SCOPE
    });
    const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody,
      redirect: "manual"
    });
    if (!tokenResponse.ok) throw new Error(`Discord OAuth token exchange failed (HTTP ${tokenResponse.status}).`);
    const token = await tokenResponse.json() as OAuthTokenResponse;
    if (typeof token.access_token !== "string" || token.token_type !== "Bearer") {
      throw new Error("Discord returned an invalid OAuth token response.");
    }
    const userResponse = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { authorization: `Bearer ${token.access_token}` },
      redirect: "manual"
    });
    if (!userResponse.ok) throw new Error(`Discord could not verify the linked account (HTTP ${userResponse.status}).`);
    const user = await userResponse.json() as OAuthUser;
    if (typeof user.id !== "string" || !/^\d{17,20}$/.test(user.id) ||
      typeof user.username !== "string" || user.username.length > 100) {
      throw new Error("Discord returned an invalid linked account.");
    }
    const connectionResponse = await fetch(
      `${DISCORD_API}/users/@me/applications/${applicationId}/role-connection`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token.access_token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          platform_name: "Koryuu",
          platform_username: user.username,
          metadata: { linked: "1" }
        }),
        redirect: "manual"
      }
    );
    if (!connectionResponse.ok) {
      throw new Error(`Discord could not save the linked role connection (HTTP ${connectionResponse.status}).`);
    }
    const completedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE linked_role_oauth_states SET status = 'completed', completed_at = ?, discord_user_id = ?
         WHERE state = ? AND status = 'processing'`
      ).bind(completedAt, user.id, state),
      env.DB.prepare(
        `INSERT INTO linked_role_events(id, discord_user_id, event_type, authorized_by, executed_by, created_at)
         VALUES (?, ?, 'linked', ?, 'koryuu-worker', ?)`
      ).bind(crypto.randomUUID(), user.id, env.LILITH_USER_ID, completedAt)
    ]);
    return htmlResponse("Your Discord account is linked. Return to the server's Linked Roles screen to receive any matching role.");
  } catch (error) {
    try {
      await markOAuthStateFailed(env, state);
    } catch (stateError) {
      console.error("Could not record a failed Linked Roles OAuth attempt:", stateError);
    }
    console.error("Linked Roles verification failed:", error);
    return htmlResponse("Koryuu could not complete account linking. Return to Discord and try again.", 502);
  }
}

export async function pruneLinkedRoleOAuthStates(env: Env, cutoff: string): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM linked_role_oauth_states
     WHERE (status IN ('completed', 'failed') AND created_at < ?)
        OR (status IN ('pending', 'processing') AND expires_at < ?)`
  ).bind(cutoff, new Date().toISOString()).run();
}
