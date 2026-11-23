import { hasAdminAccess } from "./domain.js";
import type { Env } from "./platform.js";
import { inspectGuildMember } from "./discord-server.js";

export const REQUEST_CATEGORIES = [
  "commission",
  "development_service",
  "creative_service",
  "professional_service",
  "complaint",
  "suggestion",
  "important_information",
  "personal_channel",
  "team",
  "role_access",
  "verification",
  "development_application",
  "staff_application",
  "supporter_application",
  "investor_proposal",
  "minecraft_access",
  "discount"
] as const;

export const REQUEST_STATUSES = [
  "submitted",
  "under_review",
  "negotiating",
  "approved",
  "declined",
  "in_progress",
  "resolved",
  "closed"
] as const;

type RequestCategory = typeof REQUEST_CATEGORIES[number];
type RequestStatus = typeof REQUEST_STATUSES[number];

interface RequestMetadata {
  service_type?: string;
  contribution?: string;
  minecraft_username?: string;
  partner_ids?: string[];
  activity_summary?: string;
  experience?: string;
  motivation?: string;
  responsibilities?: string;
  skills?: string;
  requested_discount_percent?: number;
  target_service?: string;
  team_name?: string;
}

interface RequestRow {
  id: string;
  guild_id: string | null;
  submitter_id: string;
  category: RequestCategory;
  title: string;
  details: string;
  involved_people: string;
  metadata: string;
  status: RequestStatus;
  routed_to: string;
  assigned_to: string | null;
  outcome: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${name} must be 1-${maximum} characters.`);
  }
  return value.trim();
}

function optionalText(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireText(value, name, maximum);
}

function parseMetadata(input: Record<string, unknown>): RequestMetadata {
  const metadata: RequestMetadata = {};
  const serviceType = optionalText(input.service_type, "Service type", 100);
  const contribution = optionalText(input.contribution, "Contribution", 2000);
  const minecraftUsername = optionalText(input.minecraft_username, "Minecraft username", 32);
  const activitySummary = optionalText(input.activity_summary, "Activity summary", 2000);
  const experience = optionalText(input.experience, "Relevant experience", 2000);
  const motivation = optionalText(input.motivation, "Motivation", 2000);
  const responsibilities = optionalText(input.responsibilities, "Intended responsibilities", 2000);
  const skills = optionalText(input.skills, "Skills", 2000);
  const targetService = optionalText(input.target_service, "Discount target", 200);
  const teamName = optionalText(input.team_name, "Team name", 100);
  if (serviceType) metadata.service_type = serviceType;
  if (contribution) metadata.contribution = contribution;
  if (minecraftUsername) metadata.minecraft_username = minecraftUsername;
  if (activitySummary) metadata.activity_summary = activitySummary;
  if (experience) metadata.experience = experience;
  if (motivation) metadata.motivation = motivation;
  if (responsibilities) metadata.responsibilities = responsibilities;
  if (skills) metadata.skills = skills;
  if (targetService) metadata.target_service = targetService;
  if (teamName) metadata.team_name = teamName;
  if (input.partner_ids !== undefined) {
    if (!Array.isArray(input.partner_ids) || input.partner_ids.length > 20 ||
      input.partner_ids.some(id => typeof id !== "string" || !/^\d{17,20}$/.test(id))) {
      throw new Error("Partner IDs must be Discord user IDs (up to 20).");
    }
    metadata.partner_ids = [...new Set(input.partner_ids as string[])];
  }
  if (input.requested_discount_percent !== undefined) {
    if (typeof input.requested_discount_percent !== "number" ||
      !Number.isInteger(input.requested_discount_percent) ||
      input.requested_discount_percent < 0 ||
      input.requested_discount_percent > 100) {
      throw new Error("Requested discount percentage must be an integer from 0 to 100.");
    }
    metadata.requested_discount_percent = input.requested_discount_percent;
  }
  return metadata;
}

export async function sendCommunityRequestDm(env: Env, userId: string, content: string): Promise<void> {
  if (!env.DISCORD_BOT_TOKEN) throw new Error("The Worker bot token is not configured for Discord notifications.");
  const dmResponse = await fetch("https://discord.com/api/v10/users/@me/channels", {
    method: "POST",
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ recipient_id: userId })
  });
  if (!dmResponse.ok) throw new Error(`Discord could not open a notification DM (HTTP ${dmResponse.status}).`);
  const dm = await dmResponse.json() as { id?: unknown };
  if (typeof dm.id !== "string" || !/^\d{17,20}$/.test(dm.id)) {
    throw new Error("Discord returned an invalid notification DM channel.");
  }
  const sent = await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } })
  });
  if (!sent.ok) throw new Error(`Discord could not deliver a notification (HTTP ${sent.status}).`);
}

async function notifyOwner(
  env: Env,
  request: {
    id: string;
    category: string;
    title: string;
    details: string;
    submitterId: string;
    involvedPeople?: Array<{ id: string; displayName: string }>;
  }
): Promise<void> {
  const message = [
    `New Koryuu request: **${request.category}**`,
    `Title: ${request.title}`,
    `Request ID: \`${request.id}\``,
    `Submitted by: <@${request.submitterId}>`,
    ...(request.involvedPeople?.length
      ? [`Involved members: ${request.involvedPeople.map(person => `${person.displayName} (<@${person.id}>)`).join(", ")}`]
      : []),
    "",
    request.details
  ].join("\n").slice(0, 1900);
  await sendCommunityRequestDm(env, env.LILITH_USER_ID, message);
}

async function logRequestEvent(
  env: Env,
  requestId: string,
  actorId: string,
  eventType: string,
  details: unknown
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO community_request_events(id, request_id, actor_id, event_type, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    requestId,
    actorId,
    eventType,
    JSON.stringify(details),
    new Date().toISOString()
  ).run();
}

export async function submitCommunityRequest(
  env: Env,
  actorId: string,
  guildId: string | null,
  input: unknown,
  mentionedUsers: Array<{ id: string; displayName: string }> = []
): Promise<{ id: string; status: string; summary: string; owner_notified: boolean }> {
  if (!isRecord(input)) throw new Error("Invalid request.");
  if (typeof input.category !== "string" ||
    !REQUEST_CATEGORIES.includes(input.category as RequestCategory)) {
    throw new Error("Choose a supported request category.");
  }
  const category = input.category as RequestCategory;
  const title = requireText(input.title, "Title", 160);
  const details = requireText(input.details, "Details", 5000);
  const people = input.involved_people ?? (category === "complaint" ? mentionedUsers.map(user => user.id) : []);
  if (!Array.isArray(people) || people.length > 20 ||
    people.some(person => typeof person !== "string" || !person.trim() || person.length > 100)) {
    throw new Error("Involved people must be names or Discord IDs, up to 20 entries.");
  }
  if (category === "complaint" && people.length === 0) {
    throw new Error("Mention the member(s) involved in the complaint in your message so Koryuu can resolve their server IDs.");
  }
  let involvedPeople: Array<{ id: string; displayName: string }> = [];
  if (category === "complaint") {
    if (!guildId) throw new Error("Submit complaints in the server where the involved members can be checked.");
    const mentionedIds = new Set(mentionedUsers.map(user => user.id));
    if (people.some(person => typeof person !== "string" || !mentionedIds.has(person) || person === actorId)) {
      throw new Error("For a complaint, mention each involved member in this message; Koryuu only accepts IDs from those resolved mentions.");
    }
    involvedPeople = await Promise.all((people as string[]).map(async id => {
      const member = await inspectGuildMember(env, guildId, id);
      return { id: member.id, displayName: member.display_name };
    }));
  }
  const metadata = parseMetadata(input);
  if (category === "personal_channel" && (!metadata.partner_ids || metadata.partner_ids.length < 3)) {
    throw new Error("A personal-channel application needs at least three gathered Discord user IDs before it can be submitted.");
  }
  if (category === "team" && !metadata.team_name) {
    throw new Error("A team application must include the proposed team name.");
  }
  if (category === "staff_application" &&
    (!metadata.experience || !metadata.motivation || !metadata.responsibilities || !metadata.activity_summary)) {
    throw new Error("A staff application must include relevant experience, motivation, intended responsibilities, and an activity summary.");
  }
  if (category === "development_application" && (!metadata.skills || !metadata.contribution)) {
    throw new Error("A development application must include relevant skills and the contributions the applicant can make.");
  }
  if ((category === "supporter_application" || category === "investor_proposal") && !metadata.contribution) {
    throw new Error("A supporter or investor proposal must describe its proposed contribution.");
  }
  if (category === "minecraft_access" && (!metadata.partner_ids || metadata.partner_ids.length < 1)) {
    throw new Error("A Minecraft access request needs at least one partner's Discord user ID.");
  }
  if (category === "minecraft_access" && !metadata.minecraft_username) {
    throw new Error("A Minecraft access request must include the applicant's Minecraft username.");
  }
  if (category === "discount" &&
    (metadata.requested_discount_percent === undefined ||
      metadata.requested_discount_percent < 10 ||
      metadata.requested_discount_percent > 35 ||
      !metadata.target_service ||
      !metadata.contribution)) {
    throw new Error("A discount request must specify a target service, contribution history, and requested percentage between 10 and 35.");
  }
  const requestId = crypto.randomUUID();
  const now = new Date().toISOString();
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO community_requests(
        id, guild_id, submitter_id, category, title, details, involved_people, metadata,
        routed_to, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requestId,
      guildId,
      actorId,
      category,
      title,
      details,
      JSON.stringify(category === "complaint" ? involvedPeople.map(person => person.id) : people.map(person => person.trim())),
      JSON.stringify(metadata),
      env.LILITH_USER_ID,
      now,
      now
    ),
    env.DB.prepare(
      `INSERT INTO community_request_events(id, request_id, actor_id, event_type, details, created_at)
       VALUES (?, ?, ?, 'submitted', ?, ?)`
    ).bind(
      crypto.randomUUID(),
      requestId,
      actorId,
      JSON.stringify({ category, title, routedTo: env.LILITH_USER_ID }),
      now
    )
  ]);
  if (inserted?.meta?.changes !== 1) throw new Error("Koryuu could not save the request.");

  let ownerNotified = false;
  try {
    await notifyOwner(env, { id: requestId, category, title, details, submitterId: actorId, involvedPeople });
    ownerNotified = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Owner notification failed.";
    console.error(`Request ${requestId} was saved but could not be forwarded to the owner:`, error);
    try {
      await logRequestEvent(env, requestId, actorId, "notification_failed", { message });
    } catch (auditError) {
      console.error(`Could not record the owner notification failure for request ${requestId}:`, auditError);
    }
  }
  return {
    id: requestId,
    status: "submitted",
    summary: ownerNotified
      ? `Saved request ${requestId} and forwarded it to the owner for review.`
      : `Saved request ${requestId}, but owner notification failed. Please alert the owner manually.`,
    owner_notified: ownerNotified
  };
}

export async function listCommunityRequests(
  env: Env,
  actorId: string,
  guildId: string | null,
  options: { status?: string; category?: string; limit?: number } = {}
): Promise<unknown[]> {
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Request page size must be between 1 and 50.");
  }
  if (options.status !== undefined && !REQUEST_STATUSES.includes(options.status as RequestStatus)) {
    throw new Error("Unknown request status.");
  }
  if (options.category !== undefined && !REQUEST_CATEGORIES.includes(options.category as RequestCategory)) {
    throw new Error("Unknown request category.");
  }
  const canReview = await hasAdminAccess(env, actorId);
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (!canReview) {
    conditions.push("submitter_id = ?");
    values.push(actorId);
  } else if (guildId) {
    conditions.push("(guild_id = ? OR guild_id IS NULL)");
    values.push(guildId);
  }
  if (options.status) {
    conditions.push("status = ?");
    values.push(options.status);
  }
  if (options.category) {
    conditions.push("category = ?");
    values.push(options.category);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await env.DB.prepare(
    `SELECT id, guild_id, submitter_id, category, title, details, involved_people,
            metadata, status, routed_to, assigned_to, outcome, created_at, updated_at, closed_at
     FROM community_requests ${where}
     ORDER BY updated_at DESC LIMIT ?`
  ).bind(...values, limit).all<RequestRow>();
  return rows.results.map(row => ({
    ...row,
    involved_people: JSON.parse(row.involved_people),
    metadata: JSON.parse(row.metadata)
  }));
}

export async function inspectMemberActivity(
  env: Env,
  actorId: string,
  guildId: string,
  memberId: string
): Promise<{
  member_id: string;
  observed_active_days: number;
  active_dates: string[];
  three_day_minimum_met: boolean;
  note: string;
}> {
  if (actorId !== env.LILITH_USER_ID) throw new Error("Only the configured owner can inspect recruitment activity evidence.");
  if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(memberId)) {
    throw new Error("Guild and member IDs must be valid Discord IDs.");
  }
  const rows = await env.DB.prepare(
    `SELECT activity_date FROM community_member_activity_days
     WHERE guild_id = ? AND member_id = ? ORDER BY activity_date DESC LIMIT 90`
  ).bind(guildId, memberId).all<{ activity_date: string }>();
  const activeDates = rows.results.map(row => row.activity_date);
  return {
    member_id: memberId,
    observed_active_days: activeDates.length,
    active_dates: activeDates,
    three_day_minimum_met: activeDates.length >= 3,
    note: "This counts days with at least one observed guild message in the last 90 days. It does not judge whether the activity was meaningful; a human reviewer must assess that."
  };
}

export async function listMinecraftWhitelistQueue(
  env: Env,
  actorId: string,
  guildId: string,
  limit = 25
): Promise<unknown[]> {
  if (actorId !== env.LILITH_USER_ID) throw new Error("Only the configured owner can inspect whitelist handoffs.");
  if (!/^\d{17,20}$/.test(guildId)) throw new Error("Guild ID must be a valid Discord ID.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Queue page size must be from 1 to 50.");
  const rows = await env.DB.prepare(
    `SELECT id, request_id, guild_id, discord_user_id, minecraft_username, partner_ids,
            status, authorized_by, worker_result, created_at, updated_at
     FROM minecraft_whitelist_queue WHERE guild_id = ?
     ORDER BY CASE status WHEN 'queued' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END,
              created_at DESC LIMIT ?`
  ).bind(guildId, limit).all<{
    id: string;
    request_id: string;
    guild_id: string;
    discord_user_id: string;
    minecraft_username: string;
    partner_ids: string;
    status: string;
    authorized_by: string;
    worker_result: string | null;
    created_at: string;
    updated_at: string;
  }>();
  return rows.results.map(row => ({ ...row, partner_ids: JSON.parse(row.partner_ids) }));
}

export async function updateCommunityRequest(
  env: Env,
  actorId: string,
  input: unknown
): Promise<{
  id: string;
  status: string;
  outcome: string | null;
  submitter_notified?: boolean;
  minecraft_whitelist_queued?: boolean;
}> {
  if (!(await hasAdminAccess(env, actorId))) {
    throw new Error("Request review requires an authorized reviewer.");
  }
  if (!isRecord(input) || typeof input.request_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.request_id)) {
    throw new Error("A valid request ID is required.");
  }
  const current = await env.DB.prepare(
    "SELECT status, assigned_to, outcome, category, guild_id, submitter_id, metadata FROM community_requests WHERE id = ?"
  ).bind(input.request_id).first<{
    status: RequestStatus;
    assigned_to: string | null;
    outcome: string | null;
    category: RequestCategory;
    guild_id: string | null;
    submitter_id: string;
    metadata: string;
  }>();
  if (!current) throw new Error("That request does not exist.");
  const hasStatus = input.status !== undefined;
  const hasOutcome = input.outcome !== undefined;
  const hasAssignee = input.assigned_to !== undefined;
  if (!hasStatus && !hasOutcome && !hasAssignee) throw new Error("Provide a status, outcome, or assignee update.");
  if (hasStatus && (typeof input.status !== "string" ||
    !REQUEST_STATUSES.includes(input.status as RequestStatus))) {
    throw new Error("Choose a supported request status.");
  }
  if (hasStatus && input.status === "approved" && current.category === "staff_application") {
    if (!current.guild_id) throw new Error("Staff applications must be submitted in a server to verify activity.");
    const activity = await inspectMemberActivity(env, env.LILITH_USER_ID, current.guild_id, current.submitter_id);
    if (!activity.three_day_minimum_met) {
      throw new Error(`This applicant has observed activity on ${activity.observed_active_days} of the required 3 days. Approval is blocked until the minimum is met.`);
    }
  }
  const outcome = hasOutcome ? requireText(input.outcome, "Outcome", 2000) : undefined;
  let assignedTo: string | null | undefined;
  if (hasAssignee) {
    if (input.assigned_to === null || input.assigned_to === "") assignedTo = null;
    else if (typeof input.assigned_to === "string" && /^\d{17,20}$/.test(input.assigned_to)) {
      assignedTo = input.assigned_to;
    } else {
      throw new Error("Assignee must be a Discord user ID or null.");
    }
  }
  const status = hasStatus ? input.status as RequestStatus : current.status;
  const now = new Date().toISOString();
  const closedAt = status === "closed" || status === "resolved" ? now : null;
  const minecraftMetadata = current.category === "minecraft_access"
    ? JSON.parse(current.metadata) as RequestMetadata
    : undefined;
  if (status === "approved" && current.category === "minecraft_access") {
    if (!current.guild_id || !minecraftMetadata?.minecraft_username ||
      !minecraftMetadata.partner_ids || minecraftMetadata.partner_ids.length < 1) {
      throw new Error("This Minecraft request is missing its server, username, or partner information.");
    }
  }
  const statements = [
    env.DB.prepare(
      `UPDATE community_requests SET status = ?,
         outcome = CASE WHEN ? THEN ? ELSE outcome END,
         assigned_to = CASE WHEN ? THEN ? ELSE assigned_to END,
         updated_at = ?, closed_at = ?
       WHERE id = ?`
    ).bind(
      status,
      hasOutcome ? 1 : 0,
      outcome ?? null,
      hasAssignee ? 1 : 0,
      assignedTo ?? null,
      now,
      closedAt,
      input.request_id
    )
  ];
  if (status === "approved" && current.category === "minecraft_access" && current.guild_id && minecraftMetadata) {
    statements.push(env.DB.prepare(
      `INSERT INTO minecraft_whitelist_queue(
        id, request_id, guild_id, discord_user_id, minecraft_username, partner_ids,
        status, authorized_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET
        status = CASE WHEN minecraft_whitelist_queue.status = 'cancelled' THEN 'queued'
                      ELSE minecraft_whitelist_queue.status END,
        authorized_by = excluded.authorized_by,
        updated_at = excluded.updated_at`
    ).bind(
      crypto.randomUUID(),
      input.request_id,
      current.guild_id,
      current.submitter_id,
      minecraftMetadata.minecraft_username,
      JSON.stringify(minecraftMetadata.partner_ids),
      actorId,
      now,
      now
    ));
  } else if (current.category === "minecraft_access" &&
    (status === "declined" || status === "closed" || status === "resolved")) {
    statements.push(env.DB.prepare(
      `UPDATE minecraft_whitelist_queue SET status = 'cancelled', updated_at = ?
       WHERE request_id = ? AND status = 'queued'`
    ).bind(now, input.request_id));
  }
  if (hasStatus && status !== current.status) {
    statements.push(env.DB.prepare(
      `INSERT INTO community_request_events(id, request_id, actor_id, event_type, details, created_at)
       VALUES (?, ?, ?, 'status_changed', ?, ?)`
    ).bind(
      crypto.randomUUID(),
      input.request_id,
      actorId,
      JSON.stringify({ from: current.status, to: status, outcome: outcome ?? null }),
      now
    ));
  }
  if (hasAssignee && assignedTo !== current.assigned_to) {
    statements.push(env.DB.prepare(
      `INSERT INTO community_request_events(id, request_id, actor_id, event_type, details, created_at)
       VALUES (?, ?, ?, 'assigned', ?, ?)`
    ).bind(crypto.randomUUID(), input.request_id, actorId, JSON.stringify({ assignedTo: assignedTo ?? null }), now));
  }
  const results = await env.DB.batch(statements);
  if (results[0]?.meta?.changes !== 1) throw new Error("The request was not updated.");
  const row = await env.DB.prepare(
    "SELECT id, status, outcome, submitter_id, category, title FROM community_requests WHERE id = ?"
  ).bind(input.request_id).first<{
    id: string;
    status: string;
    outcome: string | null;
    submitter_id: string;
    category: string;
    title: string;
  }>();
  if (!row) throw new Error("The updated request could not be reloaded.");
  const result: {
    id: string;
    status: string;
    outcome: string | null;
    submitter_notified?: boolean;
    minecraft_whitelist_queued?: boolean;
  } = {
    id: row.id,
    status: row.status,
    outcome: row.outcome
  };
  if (row.category === "minecraft_access" && row.status === "approved") {
    result.minecraft_whitelist_queued = true;
  }
  const notifySubmitter = (hasStatus && status !== current.status) ||
    (hasOutcome && outcome !== current.outcome);
  if (notifySubmitter) {
    try {
      await sendCommunityRequestDm(
        env,
        row.submitter_id,
        `Update for your **${row.category}** request “${row.title}” (\`${row.id}\`): status is now **${row.status}**.${row.outcome ? `\nOutcome: ${row.outcome}` : ""}`
      );
      result.submitter_notified = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Submitter notification failed.";
      console.error(`Request ${row.id} was updated but the submitter could not be notified:`, error);
      try {
        await logRequestEvent(env, row.id, actorId, "notification_failed", { recipient: "submitter", message });
      } catch (auditError) {
        console.error(`Could not record the submitter notification failure for request ${row.id}:`, auditError);
      }
      result.submitter_notified = false;
    }
  }
  return result;
}

export async function decideDiscountRequest(
  env: Env,
  actorId: string,
  input: unknown
): Promise<{ request_id: string; status: "approved" | "declined"; approved_percent: number | null; submitter_notified: boolean }> {
  if (actorId !== env.LILITH_USER_ID) {
    throw new Error("Only the configured owner can approve, decline, or override a discount.");
  }
  if (!isRecord(input) || typeof input.request_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.request_id)) {
    throw new Error("A valid discount request ID is required.");
  }
  const decisionNote = requireText(input.decision_note, "Decision note", 2000);
  if (typeof input.approved_percent !== "number" ||
    !Number.isInteger(input.approved_percent) ||
    (input.approved_percent !== 0 &&
      (input.approved_percent < 10 || input.approved_percent > 35))) {
    throw new Error("Set approved_percent to 0 to decline or to a whole-number discount from 10 to 35.");
  }
  const request = await env.DB.prepare(
    `SELECT submitter_id, category, status, title, metadata
     FROM community_requests WHERE id = ?`
  ).bind(input.request_id).first<{
    submitter_id: string;
    category: string;
    status: RequestStatus;
    title: string;
    metadata: string;
  }>();
  if (!request || request.category !== "discount") throw new Error("That discount request does not exist.");
  if (request.status === "closed" || request.status === "resolved") {
    throw new Error("Reopen the discount request before recording a new decision.");
  }
  const metadata = JSON.parse(request.metadata) as RequestMetadata;
  if (!metadata.target_service || metadata.requested_discount_percent === undefined) {
    throw new Error("This request is missing its service or requested discount details.");
  }
  const approvedPercent = input.approved_percent === 0 ? null : input.approved_percent;
  const status = approvedPercent === null ? "declined" : "approved";
  const outcome = approvedPercent === null
    ? `Discount declined for ${metadata.target_service}. ${decisionNote}`
    : `${approvedPercent}% discount offer approved for ${metadata.target_service}. ${decisionNote}`;
  const now = new Date().toISOString();
  const decisionId = crypto.randomUUID();
  const [decision] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO community_discount_decisions(
        id, request_id, submitter_id, target_service, requested_percent,
        approved_percent, status, decision_note, decided_by, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      decisionId,
      input.request_id,
      request.submitter_id,
      metadata.target_service,
      metadata.requested_discount_percent,
      approvedPercent,
      status,
      decisionNote,
      actorId,
      now
    ),
    env.DB.prepare(
      `UPDATE community_requests SET status = ?, outcome = ?, updated_at = ?, closed_at = NULL
       WHERE id = ?`
    ).bind(status, outcome, now, input.request_id),
    env.DB.prepare(
      `INSERT INTO community_request_events(id, request_id, actor_id, event_type, details, created_at)
       VALUES (?, ?, ?, 'status_changed', ?, ?)`
    ).bind(
      crypto.randomUUID(),
      input.request_id,
      actorId,
      JSON.stringify({
        from: request.status,
        to: status,
        decisionId,
        requestedPercent: metadata.requested_discount_percent,
        approvedPercent
      }),
      now
    )
  ]);
  if (decision?.meta?.changes !== 1) throw new Error("The discount decision was not recorded.");
  let submitterNotified = false;
  try {
    await sendCommunityRequestDm(
      env,
      request.submitter_id,
      `Update for your discount request “${request.title}” (\`${input.request_id}\`): ${outcome}\nThis records an offer only; it is not automatically applied to a purchase or checkout.`
    );
    submitterNotified = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Submitter notification failed.";
    console.error(`Discount decision for request ${input.request_id} was saved but the submitter could not be notified:`, error);
    try {
      await logRequestEvent(env, input.request_id, actorId, "notification_failed", { recipient: "submitter", message });
    } catch (auditError) {
      console.error(`Could not record the discount notification failure for request ${input.request_id}:`, auditError);
    }
  }
  return {
    request_id: input.request_id,
    status,
    approved_percent: approvedPercent,
    submitter_notified: submitterNotified
  };
}
