import {
  authenticateAdmin,
  cancelPendingAction,
  confirmPendingAction,
  consumeChatRateLimit,
  endAdminSession,
  getAchievements,
  getCollectionStatistics,
  getDreamprint,
  getPrivateMedia,
  getRelationshipStatistics,
  hasActiveAdminTicket,
  listCollection,
  listMemories,
  listShop,
  getVisibleBalance,
  stageAdminChange,
  stagePurchase,
  refreshChatHistory,
  storePrivateMedia
} from "./domain.js";
import { closeAdminTicket, cleanupExpiredAdminTickets, createAdminTicket } from "./admin-ticket.js";
import { replyWithGroq } from "./groq.js";
import { cancelServerChange, confirmServerChange } from "./discord-server.js";
import {
  archiveServerMessage,
  deleteArchivedMessages,
  registerClientMemoryMember,
  removeClientMemoryMembership
} from "./message-archive.js";
import {
  beginLinkedRoleVerification,
  finishLinkedRoleVerification,
  linkedRoleInstructionText,
  markStaleOnboardingAttempts,
  processDueLinkedRoleReminderSubscriptions,
  processLinkedRoleJoin,
  pruneLinkedRoleOAuthStates,
  setLinkedRoleReminderSubscription
} from "./linked-roles.js";
import {
  processVerificationReminderCampaigns,
  startVerificationReminderCampaign
} from "./verification-reminder.js";
import { processGroupDmCampaigns } from "./group-dm.js";
import {
  afkConfirmationEmbed,
  afkStatusPicker,
  customAfkModal,
  processAfkMessage,
  resolveAfkStatus,
  setAfkStatus
} from "./afk.js";
import {
  cancelAutomationRuleChange,
  confirmAutomationRuleChange,
  enqueueAutomationEvent,
  expireTemporaryEffects,
  processAutomationEvents
} from "./automation.js";
import type { ChatRequest, Env, PendingActionView, ScheduledController } from "./platform.js";
import { discordResponse, jsonResponse, verifyDiscordSignature, verifyGatewayRequest } from "./security.js";

interface InteractionOption {
  name: string;
  type?: number;
  value?: string | number | boolean;
  options?: InteractionOption[];
}

interface DiscordInteraction {
  type: number;
  id?: string;
  token?: string;
  guild_id?: string;
  application_id?: string;
  user?: { id: string };
  member?: { user?: { id?: string } };
  data?: {
    name?: string;
    custom_id?: string;
    values?: string[];
    options?: InteractionOption[];
    components?: Array<{ components?: Array<{ custom_id?: string; value?: string; values?: string[] }> }>;
  };
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

function actorIdOf(interaction: DiscordInteraction): string | null {
  const actorId = interaction.member?.user?.id ?? interaction.user?.id;
  return actorId && /^\d{17,20}$/.test(actorId) ? actorId : null;
}

function optionValue(interaction: DiscordInteraction, name: string): string | null {
  const options = interaction.data?.options ?? [];
  const nested = options.find(item => item.options)?.options ?? options;
  const option = nested.find(item => item.name === name);
  return typeof option?.value === "string" ? option.value : null;
}

function optionInteger(interaction: DiscordInteraction, name: string): number | null {
  const options = interaction.data?.options ?? [];
  const nested = options.find(item => item.options)?.options ?? options;
  const option = nested.find(item => item.name === name);
  return typeof option?.value === "number" && Number.isSafeInteger(option.value)
    ? option.value
    : null;
}

function optionBoolean(interaction: DiscordInteraction, name: string): boolean | null {
  const option = (interaction.data?.options ?? []).find(item => item.name === name);
  return typeof option?.value === "boolean" ? option.value : null;
}

function subcommand(interaction: DiscordInteraction): string | null {
  return interaction.data?.options?.[0]?.name ?? null;
}

function ephemeral(content: string, components?: unknown[]): Response {
  return discordResponse({
    type: 4,
    data: {
      content: content.slice(0, 1950),
      flags: 64,
      ...(components ? { components } : {}),
      allowed_mentions: { parse: [] }
    }
  });
}

function actionButtons(action: PendingActionView): unknown[] {
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, label: "Confirm", custom_id: `action_confirm:${action.id}` },
      { type: 2, style: 4, label: "Cancel", custom_id: `action_cancel:${action.id}` }
    ]
  }];
}

function authModal(): Response {
  return discordResponse({
    type: 9,
    data: {
      custom_id: "koryuu_admin_auth",
      title: "Administrator authentication",
      components: [{
        type: 1,
        components: [{
          type: 4,
          custom_id: "password",
          style: 1,
          label: "Administrator password",
          min_length: 1,
          max_length: 256,
          required: true
        }]
      }]
    }
  });
}

async function handleCommand(env: Env, interaction: DiscordInteraction, actorId: string): Promise<Response> {
  const name = interaction.data?.name;
  try {
    switch (name) {
      case "koryuu":
        return ephemeral(`**KORYUU // SYSTEM ONLINE**\nGroq keys: ${[env.GROQ_API_KEY, env.GROQ_API_KEY_2, env.GROQ_API_KEY_3, env.GROQ_API_KEY_4, env.GROQ_API_KEY_5, env.GROQ_API_KEY_6, env.GROQ_API_KEY_7, env.GROQ_API_KEY_8].filter(Boolean).length} configured\nD1: available\nMedia storage: ${env.MEDIA ? "available" : "temporarily unavailable"}.`);
      case "linked-role": {
        const reminders = optionBoolean(interaction, "reminders");
        if (reminders === null) return ephemeral(`${linkedRoleInstructionText(env)}\n\nOpt in to 20-minute verification DMs with \`/linked-role reminders:true\`; stop them with \`/linked-role reminders:false\`.`);
        if (!interaction.guild_id) return ephemeral("Run this command in the server where the 100% Organic role is assigned.");
        const subscription = await setLinkedRoleReminderSubscription(env, interaction.guild_id, actorId, reminders);
        return ephemeral(subscription.message);
      }
      case "verification_reminder": {
        if (!interaction.guild_id) return ephemeral("Run this command in the configured server.");
        const campaign = await startVerificationReminderCampaign(env, interaction.guild_id, actorId);
        return ephemeral(campaign.alreadyRunning
          ? `A verification reminder campaign is already running (ID: \`${campaign.campaignId}\`). Each unverified member is queued at most once.`
          : `Verification reminder campaign \`${campaign.campaignId}\` is queued. Koryuu will check current members and DM each unverified member once. The message includes the previous reminder time, if any, and the current time.`);
      }
      case "afk":
        if (!interaction.guild_id) return ephemeral("Use /afk in a server to set your AFK status.");
        return ephemeral("Choose a preset or set a custom AFK status.", afkStatusPicker());
      case "dprint":
        return ephemeral(`Honorable bastard — ${await getDreamprint(env, actorId)}\n\nFor more details, use /dprint_r for relationship statistics, /dprint_c for collection statistics, or /dprint_a for achievements.`);
      case "dprint_r":
        return ephemeral(`Honorable bastard — ${await getRelationshipStatistics(env, actorId)}`);
      case "dprint_c":
        return ephemeral(`Honorable bastard — ${await getCollectionStatistics(env, actorId)}`);
      case "dprint_a":
        return ephemeral(`Honorable bastard — Achievements\n${await getAchievements(env, actorId)}`);
      case "memory": {
        const action = subcommand(interaction);
        if (action === "list") return ephemeral(`Honorable bastard — Shared memories\n${await listMemories(env, actorId) || "No memories have been recorded yet."}`);
        if (action === "add") {
          const title = optionValue(interaction, "title");
          const content = optionValue(interaction, "content");
          if (!title || !content) return ephemeral("Memory title and content are required.");
          const staged = await stageAdminChange(env, actorId, { operation: "add_memory", title, content }, true);
          return ephemeral(staged.preview, actionButtons(staged.pendingAction));
        }
        return ephemeral("Unknown memory command.");
      }
      case "shop":
        return ephemeral(await listShop(env, actorId));
      case "collection":
        return ephemeral(`Honorable bastard — ${await listCollection(env, actorId)}`);
      case "balance":
        return ephemeral(`**[ RP WALLET ]** Your current balance: **${await getVisibleBalance(env, actorId)} RP**.`);
      case "rp": {
        const action = subcommand(interaction);
        if (action !== "award" && action !== "deduct") return ephemeral("Unknown RP command.");
        const userId = optionValue(interaction, "user");
        const amount = optionInteger(interaction, "amount");
        const note = optionValue(interaction, "note");
        if (!userId || amount === null || !note) return ephemeral("Recipient, positive amount, and reason are required.");
        const staged = await stageAdminChange(env, actorId, {
          operation: action === "award" ? "award_rp" : "deduct_rp",
          user_id: userId,
          amount,
          note
        }, true);
        return ephemeral(staged.preview, actionButtons(staged.pendingAction));
      }
      case "buy": {
        const uniqueId = optionValue(interaction, "unique_id");
        if (!uniqueId) return ephemeral("A shop item's unique ID is required.");
        const staged = await stagePurchase(env, actorId, uniqueId, interaction.guild_id ?? null);
        return ephemeral(staged.preview, actionButtons(staged.pendingAction));
      }
      case "admin": {
        const subcommand = interaction.data?.options?.[0]?.name;
        if (subcommand === "authenticate") {
          if (!interaction.guild_id) return ephemeral("Run /admin authenticate in the server where you want the private admin ticket.");
          return authModal();
        }
        if (subcommand === "logout") {
          await endAdminSession(env, actorId);
          await closeAdminTicket(env, actorId);
          return ephemeral("Your temporary administrator session has ended.");
        }
        return ephemeral("Unknown administrator command.");
      }
      default:
        return ephemeral("Unknown Koryuu command.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "The operation failed.";
    console.error(`Discord command ${name ?? "unknown"} failed:`, error);
    return ephemeral(`**[ SYSTEM DENIED ]** ${message}`);
  }
}

function modalPassword(interaction: DiscordInteraction): string | null {
  const value = interaction.data?.components?.[0]?.components?.[0]?.value;
  return typeof value === "string" ? value : null;
}

function modalAfkStatus(interaction: DiscordInteraction): string | null {
  const value = interaction.data?.components?.[0]?.components?.[0]?.value;
  return typeof value === "string" ? value : null;
}

function selectedAfkStatus(interaction: DiscordInteraction): string | null {
  const value = interaction.data?.values?.[0] ??
    interaction.data?.components?.[0]?.components?.[0]?.values?.[0];
  return typeof value === "string" ? value : null;
}

function publicAfkResponse(userId: string, status: string): Response {
  return discordResponse({
    type: 4,
    data: {
      embeds: [afkConfirmationEmbed(userId, status)],
      allowed_mentions: { parse: [] }
    }
  });
}

async function completeAdminAuthentication(env: Env, interaction: DiscordInteraction): Promise<string> {
  const actorId = actorIdOf(interaction);
  const guildId = interaction.guild_id;
  if (!actorId) return "Koryuu could not verify your Discord identity.";
  if (!guildId || !/^\d{17,20}$/.test(guildId)) {
    return "Run /admin authenticate in the server where you want the private admin ticket.";
  }

  try {
    const password = modalPassword(interaction);
    if (!password) return "The private password field was empty.";
    const expiresAt = await authenticateAdmin(env, actorId, password);
    try {
      await closeAdminTicket(env, actorId);
      const channelId = await createAdminTicket(env, guildId, actorId, expiresAt);
      return `Administrator access verified for 15 minutes. Your private ticket is <#${channelId}>. Supported changes still require your separate confirmation.`;
    } catch (error) {
      await endAdminSession(env, actorId);
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Authentication failed.";
    console.error("Administrator authentication failed:", error);
    return `**[ ACCESS DENIED ]** ${message}`;
  }
}

async function editDeferredInteraction(
  interaction: DiscordInteraction,
  content: string
): Promise<void> {
  if (!interaction.application_id || !interaction.token) {
    console.error("Deferred administrator authentication is missing interaction credentials.");
    return;
  }
  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${interaction.application_id}/${encodeURIComponent(interaction.token)}/messages/@original`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 1950), allowed_mentions: { parse: [] } })
    }
  );
  if (!response.ok) {
    console.error(`Could not deliver the private administrator authentication result (HTTP ${response.status}).`);
  }
}

async function handleInteraction(env: Env, interaction: DiscordInteraction): Promise<Response> {
  if (interaction.type === 1) return discordResponse({ type: 1 });
  const actorId = actorIdOf(interaction);
  if (!actorId) return ephemeral("Koryuu could not verify your Discord identity.");

  if (interaction.type === 2) return handleCommand(env, interaction, actorId);
  if (interaction.type === 5 && interaction.data?.custom_id === "koryuu_afk_custom") {
    if (!interaction.guild_id) return ephemeral("Use /afk in a server to set your AFK status.");
    const status = modalAfkStatus(interaction);
    if (!status) return ephemeral("Your custom AFK status cannot be empty.");
    try {
      await setAfkStatus(env, interaction.guild_id, actorId, status);
      return publicAfkResponse(actorId, `💬 Custom — ${status.trim()}`);
    } catch (error) {
      console.error("Could not save a custom AFK status:", error);
      return ephemeral(error instanceof Error ? error.message : "Could not save your AFK status.");
    }
  }
  if (interaction.type === 5 && interaction.data?.custom_id === "koryuu_admin_auth") {
    return ephemeral(await completeAdminAuthentication(env, interaction));
  }
  if (interaction.type === 3) {
    const customId = interaction.data?.custom_id ?? "";
    if (customId === "koryuu_afk_status") {
      if (!interaction.guild_id) return ephemeral("Use /afk in a server to set your AFK status.");
      const selected = selectedAfkStatus(interaction);
      if (selected === "custom") return customAfkModal();
      const status = selected ? resolveAfkStatus(selected) : null;
      if (!status) return ephemeral("Choose one of the listed AFK statuses.");
      try {
        await setAfkStatus(env, interaction.guild_id, actorId, status);
        return publicAfkResponse(actorId, status);
      } catch (error) {
        console.error("Could not save an AFK status:", error);
        return ephemeral(error instanceof Error ? error.message : "Could not save your AFK status.");
      }
    }
    const match = /^(action_confirm|action_cancel):([0-9a-f-]{36})$/i.exec(customId);
    if (!match) return discordResponse({ type: 7, data: { content: "Unknown or expired action.", components: [] } });
    try {
      if (match[1] === "action_confirm") {
        const ruleProposal = await env.DB.prepare(
          "SELECT 1 AS pending FROM automation_rule_proposals WHERE id = ? AND requester_id = ?"
        ).bind(match[2], actorId).first<{ pending: number }>();
        const serverProposal = await env.DB.prepare(
          "SELECT 1 AS pending FROM server_change_proposals WHERE id = ? AND requester_id = ?"
        ).bind(match[2], actorId).first<{ pending: number }>();
        const result = ruleProposal
          ? await confirmAutomationRuleChange(env, actorId, match[2])
          : serverProposal
            ? await confirmServerChange(env, actorId, match[2])
            : await confirmPendingAction(env, actorId, match[2]);
        return discordResponse({
          type: 7,
          data: { content: `**[ CONFIRMED ]** ${result}`.slice(0, 1950), components: [], allowed_mentions: { parse: [] } }
        });
      }
      const ruleProposal = await env.DB.prepare(
        "SELECT 1 AS pending FROM automation_rule_proposals WHERE id = ? AND requester_id = ?"
      ).bind(match[2], actorId).first<{ pending: number }>();
      const serverProposal = await env.DB.prepare(
        "SELECT 1 AS pending FROM server_change_proposals WHERE id = ? AND requester_id = ?"
      ).bind(match[2], actorId).first<{ pending: number }>();
      if (ruleProposal) await cancelAutomationRuleChange(env, actorId, match[2]);
      else if (serverProposal) await cancelServerChange(env, actorId, match[2]);
      else await cancelPendingAction(env, actorId, match[2]);
      return discordResponse({ type: 7, data: { content: "Action cancelled.", components: [] } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The action failed.";
      console.error("Discord confirmation failed:", error);
      return discordResponse({ type: 7, data: { content: `**[ SYSTEM DENIED ]** ${message}`.slice(0, 1950), components: [] } });
    }
  }
  return ephemeral("Unsupported Discord interaction.");
}

async function handleGatewayApi(
  request: Request,
  env: Env,
  body: Uint8Array
): Promise<Response> {
  if (!(await verifyGatewayRequest(env, request, body))) {
    return jsonResponse({ error: "Unauthorized gateway request." }, 401);
  }
  const actorId = request.headers.get("x-koryuu-actor") ?? "";
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/api/afk/message") {
    if (body.byteLength > 12000) return jsonResponse({ error: "AFK message event is too large." }, 413);
    let input: { guildId?: unknown; authorId?: unknown; mentionedUserIds?: unknown };
    try {
      input = JSON.parse(new TextDecoder().decode(body)) as typeof input;
    } catch {
      return jsonResponse({ error: "Invalid AFK message event." }, 400);
    }
    if (
      typeof input.guildId !== "string" || !/^\d{17,20}$/.test(input.guildId) ||
      typeof input.authorId !== "string" || input.authorId !== actorId || !/^\d{17,20}$/.test(input.authorId) ||
      !Array.isArray(input.mentionedUserIds) || input.mentionedUserIds.length > 100 ||
      input.mentionedUserIds.some(userId => typeof userId !== "string" || !/^\d{17,20}$/.test(userId))
    ) return jsonResponse({ error: "Invalid AFK message event fields." }, 400);
    try {
      return jsonResponse(await processAfkMessage(env, input.guildId, input.authorId, input.mentionedUserIds as string[]));
    } catch (error) {
      console.error("Could not process AFK status for a server message:", error);
      return jsonResponse({ error: error instanceof Error ? error.message : "Could not process AFK message." }, 503);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/archive/message") {
    if (!env.ARCHIVE_GUILD_ID) return jsonResponse({ error: "Server archive is not configured." }, 503);
    if (body.byteLength > 16000) return jsonResponse({ error: "Archived message is too large." }, 413);
    let input: {
      guildId?: unknown;
      channelId?: unknown;
      messageId?: unknown;
      authorId?: unknown;
      authorName?: unknown;
      content?: unknown;
      createdAt?: unknown;
      editedAt?: unknown;
    };
    try {
      input = JSON.parse(new TextDecoder().decode(body)) as typeof input;
    } catch {
      return jsonResponse({ error: "Invalid archived message." }, 400);
    }
    if (
      typeof input.guildId !== "string" || input.guildId !== env.ARCHIVE_GUILD_ID ||
      typeof input.channelId !== "string" || !/^\d{17,20}$/.test(input.channelId) ||
      typeof input.messageId !== "string" || !/^\d{17,20}$/.test(input.messageId) ||
      typeof input.authorId !== "string" || input.authorId !== actorId || !/^\d{17,20}$/.test(input.authorId) ||
      typeof input.authorName !== "string" || input.authorName.length > 100 ||
      typeof input.content !== "string" || input.content.length > 8000 ||
      typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt)) ||
      (input.editedAt !== undefined && input.editedAt !== null &&
        (typeof input.editedAt !== "string" || !Number.isFinite(Date.parse(input.editedAt))))
    ) return jsonResponse({ error: "Invalid archived message fields." }, 400);
    try {
      await archiveServerMessage(env, {
        guildId: input.guildId,
        channelId: input.channelId,
        messageId: input.messageId,
        authorId: input.authorId,
        authorName: input.authorName,
        content: input.content,
        createdAt: input.createdAt,
        editedAt: typeof input.editedAt === "string" ? input.editedAt : null
      });
      return jsonResponse({ archived: true });
    } catch (error) {
      console.error(`Could not archive message ${input.messageId}:`, error);
      return jsonResponse({ error: error instanceof Error ? error.message : "Could not archive message." }, 503);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/archive/delete") {
    if (actorId !== env.LILITH_USER_ID) return jsonResponse({ error: "Unauthorized archive deletion event." }, 403);
    if (body.byteLength > 10000) return jsonResponse({ error: "Archive deletion event is too large." }, 413);
    let input: { guildId?: unknown; channelId?: unknown; messageIds?: unknown };
    try {
      input = JSON.parse(new TextDecoder().decode(body)) as typeof input;
    } catch {
      return jsonResponse({ error: "Invalid archive deletion event." }, 400);
    }
    if (
      typeof input.guildId !== "string" || input.guildId !== env.ARCHIVE_GUILD_ID ||
      typeof input.channelId !== "string" || !/^\d{17,20}$/.test(input.channelId) ||
      !Array.isArray(input.messageIds) || input.messageIds.length > 100 ||
      input.messageIds.some(id => typeof id !== "string" || !/^\d{17,20}$/.test(id))
    ) return jsonResponse({ error: "Invalid archive deletion fields." }, 400);
    try {
      await deleteArchivedMessages(env, input.guildId, input.channelId, input.messageIds as string[]);
      return jsonResponse({ deleted: input.messageIds.length });
    } catch (error) {
      console.error("Could not remove deleted messages from the archive:", error);
      return jsonResponse({ error: error instanceof Error ? error.message : "Could not synchronize message deletion." }, 503);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/archive/member-leave") {
    if (actorId !== env.LILITH_USER_ID) return jsonResponse({ error: "Unauthorized member departure event." }, 403);
    let input: { guildId?: unknown; memberId?: unknown };
    try {
      input = JSON.parse(new TextDecoder().decode(body)) as typeof input;
    } catch {
      return jsonResponse({ error: "Invalid member departure event." }, 400);
    }
    if (
      typeof input.guildId !== "string" || input.guildId !== env.ARCHIVE_GUILD_ID ||
      typeof input.memberId !== "string" || !/^\d{17,20}$/.test(input.memberId)
    ) return jsonResponse({ error: "Invalid member departure fields." }, 400);
    await removeClientMemoryMembership(env, input.guildId, input.memberId);
    return jsonResponse({ removed: true });
  }

  if (request.method === "POST" && url.pathname === "/api/automation/member-join") {
    if (actorId !== env.LILITH_USER_ID) return jsonResponse({ error: "Unauthorized automation event source." }, 403);
    if (body.byteLength > 6000) return jsonResponse({ error: "Automation event is too large." }, 413);
    let input: {
      guildId?: unknown;
      memberId?: unknown;
      username?: unknown;
      displayName?: unknown;
      joinedAt?: unknown;
    };
    try {
      input = JSON.parse(new TextDecoder().decode(body)) as typeof input;
    } catch {
      return jsonResponse({ error: "Invalid automation event." }, 400);
    }
    if (
      typeof input.guildId !== "string" || !/^\d{17,20}$/.test(input.guildId) ||
      typeof input.memberId !== "string" || !/^\d{17,20}$/.test(input.memberId) ||
      typeof input.joinedAt !== "string" || !Number.isFinite(Date.parse(input.joinedAt)) ||
      (input.username !== undefined && typeof input.username !== "string") ||
      (input.displayName !== undefined && typeof input.displayName !== "string")
    ) return jsonResponse({ error: "Invalid member-join event fields." }, 400);
    try {
      const eventId = await enqueueAutomationEvent(
        env,
        input.guildId,
        "member.join",
        {
          member_id: input.memberId,
          username: typeof input.username === "string" ? input.username.slice(0, 100) : "",
          display_name: typeof input.displayName === "string" ? input.displayName.slice(0, 100) : "",
          joined_at: input.joinedAt
        },
        `member.join:${input.guildId}:${input.memberId}:${input.joinedAt}`
      );
      return jsonResponse({ queued: true, eventId });
    } catch (error) {
      console.error("Could not queue member-join automation event:", error);
      return jsonResponse({ error: error instanceof Error ? error.message : "Could not queue automation event." }, 500);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/community/member-activity") {
    if (actorId !== env.LILITH_USER_ID) return jsonResponse({ error: "Unauthorized activity source." }, 403);
    if (body.byteLength > 1000) return jsonResponse({ error: "Activity record is too large." }, 413);
    let input: { guildId?: unknown; memberId?: unknown };
    try {
      input = JSON.parse(new TextDecoder().decode(body)) as typeof input;
    } catch {
      return jsonResponse({ error: "Invalid activity record." }, 400);
    }
    if (
      typeof input.guildId !== "string" || !/^\d{17,20}$/.test(input.guildId) ||
      typeof input.memberId !== "string" || !/^\d{17,20}$/.test(input.memberId)
    ) return jsonResponse({ error: "Invalid activity record fields." }, 400);
    const now = new Date();
    try {
      const recorded = await env.DB.prepare(
        `INSERT OR IGNORE INTO community_member_activity_days(guild_id, member_id, activity_date, first_seen_at)
         VALUES (?, ?, ?, ?)`
      ).bind(input.guildId, input.memberId, now.toISOString().slice(0, 10), now.toISOString()).run();
      return jsonResponse({ recorded: recorded.meta?.changes === 1 });
    } catch (error) {
      console.error("Could not record member activity:", error);
      return jsonResponse({ error: error instanceof Error ? error.message : "Could not record activity." }, 500);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/community/linked-role-join") {
    if (actorId !== env.LILITH_USER_ID) return jsonResponse({ error: "Unauthorized onboarding event source." }, 403);
    if (body.byteLength > 1000) return jsonResponse({ error: "Onboarding event is too large." }, 413);
    let input: { guildId?: unknown; memberId?: unknown; joinedAt?: unknown };
    try {
      input = JSON.parse(new TextDecoder().decode(body)) as typeof input;
    } catch {
      return jsonResponse({ error: "Invalid onboarding event." }, 400);
    }
    if (typeof input.guildId !== "string" || !/^\d{17,20}$/.test(input.guildId) ||
      typeof input.memberId !== "string" || !/^\d{17,20}$/.test(input.memberId) ||
      typeof input.joinedAt !== "string" || !Number.isFinite(Date.parse(input.joinedAt))) {
      return jsonResponse({ error: "Invalid onboarding event fields." }, 400);
    }
    try {
      return jsonResponse(await processLinkedRoleJoin(env, input.guildId, input.memberId, input.joinedAt));
    } catch (error) {
      console.error("Could not process Linked Role onboarding event:", error);
      return jsonResponse({ error: error instanceof Error ? error.message : "Could not process onboarding." }, 500);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/chat") {
    if (body.byteLength > 20000) return jsonResponse({ error: "Message is too large." }, 413);
    let input: ChatRequest;
    try {
      input = JSON.parse(new TextDecoder().decode(body)) as ChatRequest;
    } catch {
      return jsonResponse({ error: "Invalid chat request." }, 400);
    }
    if (
      input.actorId !== actorId ||
      typeof input.text !== "string" ||
      input.text.trim().length === 0 ||
      input.text.length > 8000 ||
      typeof input.isDm !== "boolean" ||
      (input.mentionedUsers !== undefined && (!Array.isArray(input.mentionedUsers) ||
        input.mentionedUsers.length > 100 ||
        input.mentionedUsers.some(user => !user || typeof user.id !== "string" ||
          !/^\d{17,20}$/.test(user.id) || typeof user.displayName !== "string" || user.displayName.length > 100))) ||
      (input.everyoneMentioned !== undefined && typeof input.everyoneMentioned !== "boolean") ||
      (input.recentMessages !== undefined && (!Array.isArray(input.recentMessages) ||
        input.recentMessages.length > 12 ||
        input.recentMessages.some(message => !message || typeof message.authorId !== "string" ||
          !/^\d{17,20}$/.test(message.authorId) || typeof message.authorName !== "string" ||
          message.authorName.length > 100 || typeof message.content !== "string" ||
          message.content.length > 600 || typeof message.createdAt !== "string" ||
          !Number.isFinite(Date.parse(message.createdAt))))) ||
      (input.recentMessagesUnavailable !== undefined && typeof input.recentMessagesUnavailable !== "boolean") ||
      (input.guildId !== undefined && input.guildId !== null && (typeof input.guildId !== "string" || !/^\d{17,20}$/.test(input.guildId))) ||
      (input.channelId !== undefined && (typeof input.channelId !== "string" || !/^\d{17,20}$/.test(input.channelId)))
    ) {
      return jsonResponse({ error: "Invalid chat request fields." }, 400);
    }
    if (!(await consumeChatRateLimit(env, actorId))) {
      return jsonResponse({ error: "Koryuu is receiving messages too quickly. Please wait a moment and try again." }, 429);
    }
    try {
      if (!input.isDm && typeof input.guildId === "string" &&
        input.guildId === env.ARCHIVE_GUILD_ID && input.channelId) {
        await registerClientMemoryMember(env, input.guildId, actorId);
      }
      await refreshChatHistory(env, actorId);
      const isAdminTicket = !input.isDm && typeof input.guildId === "string" && typeof input.channelId === "string"
        ? await hasActiveAdminTicket(env, actorId, input.guildId, input.channelId)
        : false;
      const response = await replyWithGroq(
        env,
        actorId,
        input.text.trim(),
        input.isDm || isAdminTicket,
        isAdminTicket,
        input.guildId ?? null,
        {
        guildId: input.guildId ?? null,
        mentionedUsers: input.mentionedUsers ?? [],
          everyoneMentioned: input.everyoneMentioned ?? false,
          recentMessages: input.recentMessages ?? [],
          recentMessagesUnavailable: input.recentMessagesUnavailable ?? false,
          channelId: input.channelId ?? null
        }
      );
      return jsonResponse(response);
    } catch (error) {
      console.error("Chat processing failed:", error);
      return jsonResponse({ error: error instanceof Error ? error.message : "Chat processing failed." }, 502);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/confirm") {
    let input: { actionId?: unknown; confirm?: unknown };
    try {
      input = JSON.parse(new TextDecoder().decode(body)) as { actionId?: unknown; confirm?: unknown };
    } catch {
      return jsonResponse({ error: "Invalid confirmation request." }, 400);
    }
    if (typeof input.actionId !== "string" || typeof input.confirm !== "boolean") {
      return jsonResponse({ error: "Invalid confirmation request fields." }, 400);
    }
    try {
      const ruleProposal = await env.DB.prepare(
        "SELECT 1 AS pending FROM automation_rule_proposals WHERE id = ? AND requester_id = ?"
      ).bind(input.actionId, actorId).first<{ pending: number }>();
      const serverProposal = await env.DB.prepare(
        "SELECT 1 AS pending FROM server_change_proposals WHERE id = ? AND requester_id = ?"
      ).bind(input.actionId, actorId).first<{ pending: number }>();
      if (input.confirm) {
        return jsonResponse({
          result: ruleProposal
            ? await confirmAutomationRuleChange(env, actorId, input.actionId)
            : serverProposal
              ? await confirmServerChange(env, actorId, input.actionId)
              : await confirmPendingAction(env, actorId, input.actionId)
        });
      }
      if (ruleProposal) await cancelAutomationRuleChange(env, actorId, input.actionId);
      else if (serverProposal) await cancelServerChange(env, actorId, input.actionId);
      else await cancelPendingAction(env, actorId, input.actionId);
      return jsonResponse({ result: "Action cancelled." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The action failed.";
      return jsonResponse({ error: message }, 400);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/media") {
    if (!env.MEDIA) return jsonResponse({ error: "Media storage is temporarily unavailable." }, 503);
    if (body.byteLength > 8 * 1024 * 1024) return jsonResponse({ error: "Images must be 8 MB or smaller." }, 413);
    const contentType = request.headers.get("content-type") ?? "";
    const fileName = request.headers.get("x-koryuu-file-name") ?? "image";
    try {
      const bytes = new ArrayBuffer(body.byteLength);
      new Uint8Array(bytes).set(body);
      return jsonResponse(await storePrivateMedia(env, actorId, fileName, contentType, bytes));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Image upload failed.";
      return jsonResponse({ error: message }, 400);
    }
  }

  const mediaMatch = /^\/api\/media\/([0-9a-f-]{36})$/i.exec(url.pathname);
  if (request.method === "GET" && mediaMatch) {
    if (!env.MEDIA) return jsonResponse({ error: "Media storage is temporarily unavailable." }, 503);
    const media = await getPrivateMedia(env, actorId, mediaMatch[1]);
    if (!media) return jsonResponse({ error: "Private image not found or access denied." }, 404);
    const headers = new Headers();
    media.object.writeHttpMetadata(headers);
    headers.set("cache-control", "private, no-store");
    headers.set("x-content-type-options", "nosniff");
    headers.set("content-disposition", `attachment; filename="${media.fileName.replace(/["\\]/g, "_")}"`);
    return new Response(media.object.body, { headers });
  }
  return jsonResponse({ error: "Not found." }, 404);
}

export default {
  async fetch(request: Request, env: Env, context?: WorkerExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      try {
        await env.DB.prepare("SELECT 1 AS online").first();
        return jsonResponse({ status: "ok", service: "koryuu-worker" });
      } catch (error) {
        console.error("Health check failed:", error);
        return jsonResponse({ status: "error", service: "koryuu-worker" }, 503);
      }
    }

    if (request.method === "GET" && url.pathname === "/discord/linked-role") {
      try {
        return await beginLinkedRoleVerification(env);
      } catch (error) {
        console.error("Could not start Linked Roles OAuth:", error);
        return new Response("Linked Roles is not configured. Please contact a server administrator.", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
        });
      }
    }

    if (request.method === "GET" && url.pathname === "/discord/linked-role/callback") {
      return finishLinkedRoleVerification(env, url);
    }

    if (request.method === "POST" && url.pathname === "/discord/interactions") {
      const rawBody = await request.text();
      if (rawBody.length > 64000) return jsonResponse({ error: "Interaction payload is too large." }, 413);
      const valid = await verifyDiscordSignature(
        env,
        request.headers.get("x-signature-timestamp"),
        request.headers.get("x-signature-ed25519"),
        rawBody
      );
      if (!valid) return jsonResponse({ error: "Invalid Discord request signature." }, 401);
      let interaction: DiscordInteraction;
      try {
        interaction = JSON.parse(rawBody) as DiscordInteraction;
      } catch {
        return jsonResponse({ error: "Invalid interaction payload." }, 400);
      }
      if (!interaction.id || !/^\d{17,20}$/.test(interaction.id)) {
        return jsonResponse({ error: "Invalid Discord interaction ID." }, 400);
      }
      const claimed = await env.DB.prepare(
        "INSERT INTO discord_interaction_nonces(interaction_id, created_at) VALUES (?, ?) ON CONFLICT(interaction_id) DO NOTHING"
      ).bind(interaction.id, Math.floor(Date.now() / 1000)).run();
      if (claimed.meta?.changes !== 1) {
        return jsonResponse({ error: "This Discord interaction has already been processed." }, 409);
      }
      if (interaction.type === 5 && interaction.data?.custom_id === "koryuu_admin_auth") {
        const deferred = discordResponse({ type: 5, data: { flags: 64 } });
        const completion = completeAdminAuthentication(env, interaction)
          .then(content => editDeferredInteraction(interaction, content))
          .catch(error => {
            console.error("Could not complete deferred administrator authentication:", error);
          });
        if (context) context.waitUntil(completion);
        else await completion;
        return deferred;
      }
      return handleInteraction(env, interaction);
    }

    if (url.pathname.startsWith("/api/")) {
      const contentLength = Number(request.headers.get("content-length") ?? 0);
      if (contentLength > 8 * 1024 * 1024) return jsonResponse({ error: "Request is too large." }, 413);
      const body = new Uint8Array(await request.arrayBuffer());
      return handleGatewayApi(request, env, body);
    }

    return jsonResponse({ error: "Not found." }, 404);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM conversations WHERE expires_at <= ?").bind(now),
      env.DB.prepare("UPDATE pending_actions SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").bind(now),
      env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").bind(now),
      env.DB.prepare("DELETE FROM gateway_request_nonces WHERE created_at < ?").bind(Math.floor(Date.now() / 1000) - 120),
      env.DB.prepare("DELETE FROM discord_interaction_nonces WHERE created_at < ?").bind(Math.floor(Date.now() / 1000) - 10 * 60),
      env.DB.prepare("DELETE FROM admin_auth_attempts WHERE locked_until = 0 AND window_started_at < ?").bind(Date.now() - 15 * 60 * 1000),
      env.DB.prepare("DELETE FROM chat_rate_limits WHERE window_started_at < ?").bind(Date.now() - 60 * 1000),
      env.DB.prepare("DELETE FROM community_member_activity_days WHERE activity_date < date('now', '-90 days')"),
      env.DB.prepare("UPDATE server_change_proposals SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").bind(now),
      env.DB.prepare("UPDATE automation_rule_proposals SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").bind(now)
    ]);
    await markStaleOnboardingAttempts(env, new Date(Date.now() - 10 * 60 * 1000).toISOString());
    await processDueLinkedRoleReminderSubscriptions(env);
    await processVerificationReminderCampaigns(env);
    await processGroupDmCampaigns(env);
    await pruneLinkedRoleOAuthStates(env, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    await cleanupExpiredAdminTickets(env);
    await processAutomationEvents(env);
    await expireTemporaryEffects(env);
  }
};
