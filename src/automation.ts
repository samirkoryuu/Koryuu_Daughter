import type { Env } from "./platform.js";
import {
  executeAutomationDiscordAction,
  getDiscordBotId,
  readMemberRoleState,
  validateAutomationDiscordAction
} from "./discord-server.js";

type TriggerType = "shop.purchase" | "member.join";
type ConditionOperator = "equals" | "not_equals" | "contains" | "greater_than" | "less_than";
type RuleCondition = { field: string; operator: ConditionOperator; value: string | number | boolean };
type RuleAction =
  | { type: "add_role"; role_id: string; duration_minutes?: number }
  | { type: "remove_role"; role_id: string }
  | { type: "send_message"; channel_id: string; content: string };

interface RuleDefinition {
  name: string;
  trigger_type: TriggerType;
  conditions: RuleCondition[];
  actions: RuleAction[];
}

interface RuleRow extends RuleDefinition {
  id: string;
  guild_id: string;
  trigger_config: string;
  condition_config: string;
  action_config: string;
  enabled: number;
  version: number;
  approved_by: string;
  created_at: string;
}

interface AutomationEvent {
  id: string;
  guild_id: string;
  event_type: TriggerType;
  payload: string;
  source_event_key: string;
  attempts: number;
}

interface AutomationRun {
  id: string;
  status: "running" | "completed" | "failed";
  started_at: string;
}

const CONDITION_FIELDS: Record<TriggerType, Set<string>> = {
  "shop.purchase": new Set(["purchase_id", "buyer_id", "member_id", "unique_id", "item_title", "price_paid"]),
  "member.join": new Set(["member_id", "username", "display_name", "joined_at"])
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function snowflake(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{17,20}$/.test(value)) {
    throw new Error(`${label} must be a valid Discord ID.`);
  }
  return value;
}

function ruleUuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Rule ID must be a valid automation rule ID.");
  }
  return value;
}

function parseRuleDefinition(input: Record<string, unknown>): RuleDefinition {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 100) throw new Error("Automation name must be 1-100 characters.");
  if (input.trigger_type !== "shop.purchase" && input.trigger_type !== "member.join") {
    throw new Error("Trigger must be shop.purchase or member.join.");
  }
  const triggerType = input.trigger_type;
  const conditionsInput = input.conditions ?? [];
  if (!Array.isArray(conditionsInput) || conditionsInput.length > 10) {
    throw new Error("Automation rules can have at most 10 conditions.");
  }
  const conditions = conditionsInput.map((condition, index): RuleCondition => {
    if (!isRecord(condition)) throw new Error(`Condition ${index + 1} is invalid.`);
    const field = condition.field;
    if (typeof field !== "string" || !CONDITION_FIELDS[triggerType].has(field)) {
      throw new Error(`Condition ${index + 1} uses a field not available for ${triggerType}.`);
    }
    const operator = condition.operator;
    if (operator !== "equals" && operator !== "not_equals" && operator !== "contains" &&
      operator !== "greater_than" && operator !== "less_than") {
      throw new Error(`Condition ${index + 1} uses an unsupported comparison.`);
    }
    const rawValue = condition.value;
    if (typeof rawValue !== "string" && typeof rawValue !== "number" && typeof rawValue !== "boolean") {
      throw new Error(`Condition ${index + 1} must compare against a string, number, or boolean.`);
    }
    let value: string | number | boolean = rawValue;
    if ((field === "purchase_id" || field === "price_paid") && typeof value === "string" && /^\d+$/.test(value)) {
      value = Number(value);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Condition ${index + 1} has an invalid number.`);
    }
    if (operator === "contains" && typeof value !== "string") {
      throw new Error(`Condition ${index + 1} contains comparisons require a string.`);
    }
    if ((operator === "greater_than" || operator === "less_than") && typeof value !== "number") {
      throw new Error(`Condition ${index + 1} numeric comparisons require a number.`);
    }
    return { field, operator, value };
  });
  const actionsInput = input.actions;
  if (!Array.isArray(actionsInput) || actionsInput.length < 1 || actionsInput.length > 10) {
    throw new Error("Automation rules need between 1 and 10 actions.");
  }
  const actions = actionsInput.map((action, index): RuleAction => {
    if (!isRecord(action)) throw new Error(`Action ${index + 1} is invalid.`);
    if (action.type === "add_role") {
      const duration = action.duration_minutes;
      if (duration !== undefined && (!Number.isInteger(duration) || Number(duration) < 1 || Number(duration) > 10080)) {
        throw new Error(`Action ${index + 1} duration must be between 1 and 10080 minutes.`);
      }
      return {
        type: "add_role",
        role_id: snowflake(action.role_id, `Action ${index + 1} role ID`),
        ...(duration === undefined ? {} : { duration_minutes: Number(duration) })
      };
    }
    if (action.type === "remove_role") {
      return { type: "remove_role", role_id: snowflake(action.role_id, `Action ${index + 1} role ID`) };
    }
    if (action.type === "send_message") {
      if (typeof action.content !== "string" || !action.content.trim() || action.content.length > 1800) {
        throw new Error(`Action ${index + 1} message must contain 1-1800 characters.`);
      }
      return {
        type: "send_message",
        channel_id: snowflake(action.channel_id, `Action ${index + 1} channel ID`),
        content: action.content
      };
    }
    throw new Error(`Action ${index + 1} has an unsupported action type.`);
  });
  return { name, trigger_type: triggerType, conditions, actions };
}

function renderRulePreview(operation: string, rule: RuleDefinition, targetLabels: string[] = []): string {
  const conditions = rule.conditions.length
    ? rule.conditions.map(condition => `${condition.field} ${condition.operator} ${JSON.stringify(condition.value)}`).join(" AND ")
    : "none";
  const actions = rule.actions.map((action, index) => {
    const target = targetLabels[index];
    if (action.type === "add_role") {
      return `add role ${target ?? action.role_id}${action.duration_minutes ? ` for ${action.duration_minutes} minutes` : " permanently"}`;
    }
    if (action.type === "remove_role") return `remove role ${target ?? action.role_id}`;
    return `send message to ${target ?? action.channel_id}: ${action.content}`;
  }).join("; ");
  return `${operation} automation **${rule.name}**. Trigger: \`${rule.trigger_type}\`; conditions: ${conditions}; actions: ${actions}.`;
}

async function validateRuleTargets(env: Env, guildId: string, rule: RuleDefinition): Promise<string[]> {
  const labels: string[] = [];
  for (const action of rule.actions) {
    if (action.type === "send_message") {
      labels.push(await validateAutomationDiscordAction(env, guildId, {
        type: "send_message",
        channel_id: action.channel_id
      }));
    } else {
      labels.push(await validateAutomationDiscordAction(env, guildId, {
        type: action.type,
        role_id: action.role_id
      }));
    }
  }
  return labels;
}

export async function stageAutomationRuleChange(
  env: Env,
  actorId: string,
  guildId: string,
  input: unknown
): Promise<{ id: string; preview: string }> {
  if (actorId !== env.LILITH_USER_ID) throw new Error("Only the configured server owner can change automation rules.");
  snowflake(guildId, "Guild ID");
  if (!isRecord(input)) throw new Error("Invalid automation rule operation.");
  const operation = input.operation;
  if (operation !== "create" && operation !== "update" && operation !== "delete" && operation !== "set_enabled") {
    throw new Error("Automation operation must be create, update, delete, or set_enabled.");
  }

  let ruleId: string | null = null;
  let payload: Record<string, unknown>;
  let preview: string;
  if (operation === "create" || operation === "update") {
    const rule = parseRuleDefinition(input);
    const targetLabels = await validateRuleTargets(env, guildId, rule);
    if (operation === "create") {
      ruleId = crypto.randomUUID();
      payload = { ruleId, rule };
    } else {
      ruleId = ruleUuid(input.rule_id);
      const current = await env.DB.prepare(
        "SELECT version FROM automation_rules WHERE id = ? AND guild_id = ? AND deleted_at IS NULL"
      ).bind(ruleId, guildId).first<{ version: number }>();
      if (!current) throw new Error("That automation rule does not exist in this server.");
      payload = { ruleId, expectedVersion: current.version, rule };
    }
    preview = renderRulePreview(operation, rule, targetLabels);
  } else {
    ruleId = ruleUuid(input.rule_id);
    const current = await env.DB.prepare(
      `SELECT id, name, trigger_type, trigger_config, condition_config, action_config,
              enabled, version, created_by, approved_by, created_at
       FROM automation_rules WHERE id = ? AND guild_id = ? AND deleted_at IS NULL`
    ).bind(ruleId, guildId).first<Omit<RuleRow, "conditions" | "actions">>();
    if (!current) throw new Error("That automation rule does not exist in this server.");
    payload = { ruleId, expectedVersion: current.version };
    if (operation === "delete") {
      preview = `Disable and archive automation **${current.name}** (${ruleId}); its execution history will remain.`;
    } else {
      if (typeof input.enabled !== "boolean") throw new Error("The enabled value must be true or false.");
      payload.enabled = input.enabled;
      preview = `${input.enabled ? "Enable" : "Disable"} automation **${current.name}** (${ruleId}).`;
    }
  }

  const id = crypto.randomUUID();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 2 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO automation_rule_proposals(
        id, guild_id, requester_id, operation_type, rule_id, payload, preview, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      guildId,
      actorId,
      operation,
      ruleId,
      JSON.stringify(payload),
      preview,
      createdAt.toISOString(),
      expiresAt
    ),
    env.DB.prepare(
      "INSERT INTO system_logs(actor_id, action, details) VALUES (?, ?, ?)"
    ).bind(actorId, "automation.rule.proposed", JSON.stringify({ proposalId: id, operation, ruleId, guildId }))
  ]);
  return { id, preview };
}

export async function confirmAutomationRuleChange(
  env: Env,
  actorId: string,
  proposalId: string
): Promise<string> {
  if (actorId !== env.LILITH_USER_ID) throw new Error("Only the configured server owner can approve automation changes.");
  const now = new Date().toISOString();
  const proposal = await env.DB.prepare(
    `SELECT guild_id, operation_type, rule_id, payload, preview
     FROM automation_rule_proposals
     WHERE id = ? AND requester_id = ? AND status = 'pending' AND expires_at > ?`
  ).bind(proposalId, actorId, now).first<{
    guild_id: string;
    operation_type: string;
    rule_id: string | null;
    payload: string;
    preview: string;
  }>();
  if (!proposal) throw new Error("This automation confirmation has expired or was already used.");
  const claimed = await env.DB.prepare(
    `UPDATE automation_rule_proposals SET status = 'confirmed', authorized_by = ?
     WHERE id = ? AND requester_id = ? AND status = 'pending' AND expires_at > ?`
  ).bind(actorId, proposalId, actorId, now).run();
  if (claimed.meta?.changes !== 1) throw new Error("This automation confirmation has already been used.");

  const executorId = "koryuu-worker";
  let result: string;
  try {
    const payload = JSON.parse(proposal.payload) as Record<string, unknown>;
    const expectedVersion = payload.expectedVersion;
    const ruleId = proposal.rule_id;
    if (proposal.operation_type === "create") {
      if (typeof payload.ruleId !== "string" || !isRecord(payload.rule)) throw new Error("Invalid create-rule proposal.");
      const rule = parseRuleDefinition(payload.rule);
      await validateRuleTargets(env, proposal.guild_id, rule);
      const timestamp = new Date().toISOString();
      const stored = await env.DB.prepare(
        `INSERT INTO automation_rules(
          id, guild_id, name, trigger_type, trigger_config, condition_config, action_config,
          enabled, version, created_by, approved_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '{}', ?, ?, 1, 1, ?, ?, ?, ?)`
      ).bind(
        payload.ruleId,
        proposal.guild_id,
        rule.name,
        rule.trigger_type,
        JSON.stringify(rule.conditions),
        JSON.stringify(rule.actions),
        actorId,
        actorId,
        timestamp,
        timestamp
      ).run();
      if (stored.meta?.changes !== 1) throw new Error("Automation rule was not saved.");
      result = `Created and enabled automation **${rule.name}** (${payload.ruleId}).`;
    } else {
      if (!ruleId || typeof expectedVersion !== "number") throw new Error("Invalid automation update proposal.");
      let updated: { meta?: { changes?: number } };
      if (proposal.operation_type === "update") {
        if (!isRecord(payload.rule)) throw new Error("Invalid update-rule proposal.");
        const rule = parseRuleDefinition(payload.rule);
        await validateRuleTargets(env, proposal.guild_id, rule);
        updated = await env.DB.prepare(
          `UPDATE automation_rules SET name = ?, trigger_type = ?, condition_config = ?,
             action_config = ?, version = version + 1, approved_by = ?, updated_at = ?
           WHERE id = ? AND guild_id = ? AND version = ? AND deleted_at IS NULL`
        ).bind(
          rule.name,
          rule.trigger_type,
          JSON.stringify(rule.conditions),
          JSON.stringify(rule.actions),
          actorId,
          new Date().toISOString(),
          ruleId,
          proposal.guild_id,
          expectedVersion
        ).run();
        result = `Updated automation **${rule.name}** (${ruleId}).`;
      } else if (proposal.operation_type === "set_enabled") {
        if (typeof payload.enabled !== "boolean") throw new Error("Invalid enable-rule proposal.");
        updated = await env.DB.prepare(
          `UPDATE automation_rules SET enabled = ?, version = version + 1,
             approved_by = ?, updated_at = ?
           WHERE id = ? AND guild_id = ? AND version = ? AND deleted_at IS NULL`
        ).bind(
          payload.enabled ? 1 : 0,
          actorId,
          new Date().toISOString(),
          ruleId,
          proposal.guild_id,
          expectedVersion
        ).run();
        result = `${payload.enabled ? "Enabled" : "Disabled"} automation ${ruleId}.`;
      } else if (proposal.operation_type === "delete") {
        updated = await env.DB.prepare(
          `UPDATE automation_rules SET enabled = 0, deleted_at = ?, version = version + 1,
             approved_by = ?, updated_at = ?
           WHERE id = ? AND guild_id = ? AND version = ? AND deleted_at IS NULL`
        ).bind(
          new Date().toISOString(),
          actorId,
          new Date().toISOString(),
          ruleId,
          proposal.guild_id,
          expectedVersion
        ).run();
        result = `Archived automation ${ruleId}; history is retained.`;
      } else {
        throw new Error("Unsupported automation proposal.");
      }
      if (updated.meta?.changes !== 1) throw new Error("The automation rule changed since its preview. Prepare a new proposal.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Automation update failed.";
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE automation_rule_proposals SET status = 'failed', executed_by = ?, executed_at = ?, result = ?
         WHERE id = ? AND status = 'confirmed'`
      ).bind(executorId, new Date().toISOString(), message, proposalId),
      env.DB.prepare(
        "INSERT INTO system_logs(actor_id, action, details) VALUES (?, ?, ?)"
      ).bind(executorId, "automation.rule.failed", JSON.stringify({
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
        `UPDATE automation_rule_proposals SET executed_by = ?, executed_at = ?, result = ?
         WHERE id = ? AND status = 'confirmed'`
      ).bind(executorId, executedAt, result, proposalId),
      env.DB.prepare(
        "INSERT INTO system_logs(actor_id, action, details) VALUES (?, ?, ?)"
      ).bind(executorId, "automation.rule.changed", JSON.stringify({
        proposalId,
        guildId: proposal.guild_id,
        authorizedBy: actorId,
        executedBy: executorId,
        result
      }))
    ]);
  } catch (error) {
    console.error("Automation rule changed but its result could not be fully persisted:", error);
    throw new Error("The automation change was saved, but Koryuu could not record the result.");
  }
  return result;
}

export async function cancelAutomationRuleChange(
  env: Env,
  actorId: string,
  proposalId: string
): Promise<void> {
  if (actorId !== env.LILITH_USER_ID) throw new Error("Only the configured server owner can cancel automation changes.");
  const cancelled = await env.DB.prepare(
    `UPDATE automation_rule_proposals SET status = 'cancelled'
     WHERE id = ? AND requester_id = ? AND status = 'pending' AND expires_at > ?`
  ).bind(proposalId, actorId, new Date().toISOString()).run();
  if (cancelled.meta?.changes !== 1) throw new Error("This automation confirmation is no longer available.");
}

export async function listAutomationRules(env: Env, guildId: string): Promise<unknown[]> {
  snowflake(guildId, "Guild ID");
  const rows = await env.DB.prepare(
    `SELECT id, name, trigger_type, condition_config, action_config, enabled, version,
            created_by, approved_by, created_at, updated_at
     FROM automation_rules WHERE guild_id = ? AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 50`
  ).bind(guildId).all<{
    id: string;
    name: string;
    trigger_type: string;
    condition_config: string;
    action_config: string;
    enabled: number;
    version: number;
    created_by: string;
    approved_by: string;
    created_at: string;
    updated_at: string;
  }>();
  return rows.results.map(rule => ({
    ...rule,
    conditions: JSON.parse(rule.condition_config),
    actions: JSON.parse(rule.action_config),
    condition_config: undefined,
    action_config: undefined
  }));
}

export async function inspectAutomationRuns(
  env: Env,
  guildId: string,
  limit = 20
): Promise<unknown[]> {
  snowflake(guildId, "Guild ID");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Execution history page size must be between 1 and 50.");
  }
  const rows = await env.DB.prepare(
    `SELECT runs.id, runs.rule_id, rules.name AS rule_name, runs.rule_version,
            events.event_type, events.source_event_key, runs.status, runs.result,
            runs.error, runs.started_at, runs.completed_at, runs.authorized_by
     FROM automation_runs runs
     JOIN automation_events events ON events.id = runs.event_id
     JOIN automation_rules rules ON rules.id = runs.rule_id
     WHERE events.guild_id = ?
     ORDER BY runs.started_at DESC LIMIT ?`
  ).bind(guildId, limit).all();
  return rows.results;
}

export async function enqueueAutomationEvent(
  env: Env,
  guildId: string,
  eventType: TriggerType,
  payload: Record<string, unknown>,
  sourceEventKey: string
): Promise<string> {
  snowflake(guildId, "Guild ID");
  if (eventType !== "shop.purchase" && eventType !== "member.join") {
    throw new Error("Unsupported automation event.");
  }
  if (!sourceEventKey || sourceEventKey.length > 200) throw new Error("Invalid automation event key.");
  const serialized = JSON.stringify(payload);
  if (serialized.length > 6000) throw new Error("Automation event payload is too large.");
  const id = crypto.randomUUID();
  const inserted = await env.DB.prepare(
    `INSERT INTO automation_events(id, guild_id, event_type, payload, source_event_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_event_key) DO NOTHING`
  ).bind(id, guildId, eventType, serialized, sourceEventKey, new Date().toISOString()).run();
  if (inserted.meta?.changes === 1) return id;
  const existing = await env.DB.prepare(
    "SELECT id FROM automation_events WHERE source_event_key = ?"
  ).bind(sourceEventKey).first<{ id: string }>();
  if (!existing) throw new Error("Could not confirm whether the automation event was queued.");
  return existing.id;
}

function conditionMatches(condition: RuleCondition, payload: Record<string, unknown>): boolean {
  const actual = payload[condition.field];
  if (condition.operator === "equals") return actual === condition.value;
  if (condition.operator === "not_equals") return actual !== condition.value;
  if (condition.operator === "contains") {
    return typeof actual === "string" && typeof condition.value === "string" &&
      actual.toLocaleLowerCase().includes(condition.value.toLocaleLowerCase());
  }
  if (typeof actual !== "number" || typeof condition.value !== "number") return false;
  return condition.operator === "greater_than"
    ? actual > condition.value
    : actual < condition.value;
}

function renderMessage(template: string, payload: Record<string, unknown>): string {
  const values: Record<string, string> = {};
  for (const key of ["member_id", "username", "display_name", "unique_id", "item_title", "price_paid"]) {
    const value = payload[key];
    if (typeof value === "string" || typeof value === "number") values[key] = String(value);
  }
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_match, field: string) => values[field] ?? "");
}

async function startRuleRun(
  env: Env,
  eventId: string,
  rule: RuleRow,
  now: string
): Promise<AutomationRun | null> {
  const current = await env.DB.prepare(
    `SELECT id, status, started_at FROM automation_runs WHERE event_id = ? AND rule_id = ?`
  ).bind(eventId, rule.id).first<AutomationRun>();
  if (!current) {
    const id = crypto.randomUUID();
    const inserted = await env.DB.prepare(
      `INSERT INTO automation_runs(
        id, event_id, rule_id, rule_version, status, started_at, authorized_by
      ) VALUES (?, ?, ?, ?, 'running', ?, ?)
      ON CONFLICT(event_id, rule_id) DO NOTHING`
    ).bind(id, eventId, rule.id, rule.version, now, rule.approved_by).run();
    if (inserted.meta?.changes === 1) return { id, status: "running", started_at: now };
    return null;
  }
  if (current.status === "completed" ||
    (current.status === "running" && Date.parse(current.started_at) > Date.now() - 5 * 60 * 1000)) {
    return null;
  }
  const claimed = await env.DB.prepare(
    `UPDATE automation_runs SET status = 'running', rule_version = ?, result = NULL,
       error = NULL, started_at = ?, completed_at = NULL
     WHERE id = ? AND (
       status = 'failed' OR (status = 'running' AND started_at <= ?)
     )`
  ).bind(rule.version, now, current.id, new Date(Date.now() - 5 * 60 * 1000).toISOString()).run();
  return claimed.meta?.changes === 1
    ? { id: current.id, status: "running", started_at: now }
    : null;
}

async function applyRuleAction(
  env: Env,
  event: AutomationEvent,
  payload: Record<string, unknown>,
  rule: RuleRow,
  run: AutomationRun,
  action: RuleAction,
  actionIndex: number,
  now: string
): Promise<string> {
  const memberId = typeof payload.member_id === "string"
    ? payload.member_id
    : typeof payload.buyer_id === "string" ? payload.buyer_id : null;
  if (action.type === "send_message") {
    const nonce = `${run.id.replaceAll("-", "").slice(0, 18)}${actionIndex}`;
    return executeAutomationDiscordAction(env, event.guild_id, {
      type: "send_message",
      channel_id: action.channel_id,
      content: renderMessage(action.content, payload),
      nonce
    });
  }
  if (!memberId) throw new Error("This event does not include a member ID required by the role action.");
  snowflake(memberId, "Event member ID");
  if (action.type === "remove_role") {
    const result = await executeAutomationDiscordAction(env, event.guild_id, {
      type: "remove_role",
      member_id: memberId,
      role_id: action.role_id
    });
    await env.DB.prepare(
      `UPDATE temporary_effects SET status = 'expired', expired_at = ?
       WHERE guild_id = ? AND member_id = ? AND effect_target_id = ? AND status = 'active'`
    ).bind(now, event.guild_id, memberId, action.role_id).run();
    return result;
  }
  if (action.duration_minutes === undefined) {
    return executeAutomationDiscordAction(env, event.guild_id, {
      type: "add_role",
      member_id: memberId,
      role_id: action.role_id
    });
  }

  const state = await readMemberRoleState(env, event.guild_id, memberId, action.role_id);
  if (!state.memberExists || !state.roleExists) {
    throw new Error("The event member or automation role no longer exists.");
  }
  const existingLease = await env.DB.prepare(
    `SELECT 1 AS active FROM temporary_effects
     WHERE guild_id = ? AND member_id = ? AND effect_target_id = ?
       AND status = 'active' LIMIT 1`
  ).bind(event.guild_id, memberId, action.role_id).first<{ active: number }>();
  if (state.hasRole && !existingLease) {
    return `Skipped temporary role ${action.role_id}; the member already had it before this automation.`;
  }

  const expiresAt = new Date(Date.parse(now) + action.duration_minutes * 60 * 1000).toISOString();
  const effectId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO temporary_effects(
      id, guild_id, member_id, effect_type, effect_target_id, rule_id, expires_at,
      status, created_at, source_run_id, action_index
    ) VALUES (?, ?, ?, 'role', ?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT(source_run_id, action_index) DO UPDATE SET
      status = 'active', expires_at = excluded.expires_at, expired_at = NULL`
  ).bind(
    effectId,
    event.guild_id,
    memberId,
    action.role_id,
    rule.id,
    expiresAt,
    now,
    run.id,
    actionIndex
  ).run();
  if (!state.hasRole) {
    await executeAutomationDiscordAction(env, event.guild_id, {
      type: "add_role",
      member_id: memberId,
      role_id: action.role_id
    });
  }
  return `Granted role ${action.role_id} until ${expiresAt}.`;
}

async function runRule(
  env: Env,
  event: AutomationEvent,
  rule: RuleRow,
  payload: Record<string, unknown>
): Promise<void> {
  const now = new Date().toISOString();
  const run = await startRuleRun(env, event.id, rule, now);
  if (!run) return;
  let executorId = "koryuu-worker";
  try {
    executorId = await getDiscordBotId(env);
    await env.DB.prepare("UPDATE automation_runs SET executed_by = ? WHERE id = ?")
      .bind(executorId, run.id).run();
    const actions = JSON.parse(rule.action_config) as RuleAction[];
    const results: string[] = [];
    for (let index = 0; index < actions.length; index++) {
      results.push(await applyRuleAction(env, event, payload, rule, run, actions[index], index, now));
    }
    const result = JSON.stringify(results);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE automation_runs SET status = 'completed', result = ?, completed_at = ?
         WHERE id = ? AND status = 'running'`
      ).bind(result, new Date().toISOString(), run.id),
      env.DB.prepare(
        "INSERT INTO system_logs(actor_id, action, details) VALUES (?, ?, ?)"
      ).bind(executorId, "automation.run.completed", JSON.stringify({
        runId: run.id,
        eventId: event.id,
        ruleId: rule.id,
        guildId: event.guild_id,
        authorizedBy: rule.approved_by,
        executedBy: executorId,
        result: results
      }))
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Automation action failed.";
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE automation_runs SET status = 'failed', error = ?, completed_at = ?, executed_by = ?
         WHERE id = ? AND status = 'running'`
      ).bind(message, new Date().toISOString(), executorId, run.id),
      env.DB.prepare(
        "INSERT INTO system_logs(actor_id, action, details) VALUES (?, ?, ?)"
      ).bind(executorId, "automation.run.failed", JSON.stringify({
        runId: run.id,
        eventId: event.id,
        ruleId: rule.id,
        guildId: event.guild_id,
        authorizedBy: rule.approved_by,
        executedBy: executorId,
        error: message
      }))
    ]);
    throw error;
  }
}

async function executeAutomationEvent(env: Env, event: AutomationEvent): Promise<void> {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const rows = await env.DB.prepare(
    `SELECT id, guild_id, name, trigger_type, trigger_config, condition_config, action_config,
            enabled, version, approved_by, created_at
     FROM automation_rules
     WHERE guild_id = ? AND trigger_type = ? AND enabled = 1 AND deleted_at IS NULL
     ORDER BY created_at, id`
  ).bind(event.guild_id, event.event_type).all<Omit<RuleRow, "conditions" | "actions">>();
  for (const row of rows.results) {
    const rule: RuleRow = {
      ...row,
      conditions: JSON.parse(row.condition_config) as RuleCondition[],
      actions: JSON.parse(row.action_config) as RuleAction[]
    };
    if (!rule.conditions.every(condition => conditionMatches(condition, payload))) continue;
    await runRule(env, event, rule, payload);
  }
}

export async function processAutomationEvents(env: Env, limit = 20): Promise<void> {
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const queued = await env.DB.prepare(
    `SELECT id FROM automation_events
     WHERE status = 'pending' OR (status = 'failed' AND attempts < 5)
        OR (status = 'running' AND locked_at < ?)
     ORDER BY created_at LIMIT ?`
  ).bind(staleBefore, limit).all<{ id: string }>();
  for (const queuedEvent of queued.results) {
    const claimed = await env.DB.prepare(
      `UPDATE automation_events SET status = 'running', attempts = attempts + 1, locked_at = ?
       WHERE id = ? AND (
         status = 'pending' OR (status = 'failed' AND attempts < 5)
         OR (status = 'running' AND locked_at < ?)
       )`
    ).bind(now, queuedEvent.id, staleBefore).run();
    if (claimed.meta?.changes !== 1) continue;
    const event = await env.DB.prepare(
      `SELECT id, guild_id, event_type, payload, source_event_key, attempts
       FROM automation_events WHERE id = ?`
    ).bind(queuedEvent.id).first<AutomationEvent>();
    if (!event) throw new Error(`Claimed automation event ${queuedEvent.id} could not be reloaded.`);
    try {
      await executeAutomationEvent(env, event);
      await env.DB.prepare(
        `UPDATE automation_events SET status = 'completed', processed_at = ?, last_error = NULL
         WHERE id = ? AND status = 'running'`
      ).bind(new Date().toISOString(), event.id).run();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Automation event failed.";
      console.error(`Automation event ${event.id} failed:`, error);
      await env.DB.prepare(
        `UPDATE automation_events SET status = 'failed', last_error = ?, processed_at = ?
         WHERE id = ? AND status = 'running'`
      ).bind(message, new Date().toISOString(), event.id).run();
    }
  }
}

export async function expireTemporaryEffects(env: Env, limit = 50): Promise<void> {
  const now = new Date().toISOString();
  const due = await env.DB.prepare(
    `SELECT id, guild_id, member_id, effect_target_id, rule_id
     FROM temporary_effects WHERE status = 'active' AND expires_at <= ?
     ORDER BY expires_at LIMIT ?`
  ).bind(now, limit).all<{
    id: string;
    guild_id: string;
    member_id: string;
    effect_target_id: string;
    rule_id: string;
  }>();
  for (const effect of due.results) {
    const remaining = await env.DB.prepare(
      `SELECT 1 AS active FROM temporary_effects
       WHERE guild_id = ? AND member_id = ? AND effect_target_id = ?
         AND status = 'active' AND expires_at > ? AND id != ? LIMIT 1`
    ).bind(effect.guild_id, effect.member_id, effect.effect_target_id, now, effect.id)
      .first<{ active: number }>();
    if (remaining) {
      await env.DB.prepare(
        "UPDATE temporary_effects SET status = 'expired', expired_at = ? WHERE id = ? AND status = 'active'"
      ).bind(now, effect.id).run();
      continue;
    }
    try {
      const executorId = await getDiscordBotId(env);
      const state = await readMemberRoleState(
        env,
        effect.guild_id,
        effect.member_id,
        effect.effect_target_id
      );
      if (state.memberExists && state.roleExists && state.hasRole) {
        await executeAutomationDiscordAction(env, effect.guild_id, {
          type: "remove_role",
          member_id: effect.member_id,
          role_id: effect.effect_target_id
        });
      }
      await env.DB.prepare(
        "UPDATE temporary_effects SET status = 'expired', expired_at = ? WHERE id = ? AND status = 'active'"
      ).bind(now, effect.id).run();
      await env.DB.prepare(
        "INSERT INTO system_logs(actor_id, action, details) VALUES (?, ?, ?)"
      ).bind(executorId, "automation.effect.expired", JSON.stringify({
        effectId: effect.id,
        guildId: effect.guild_id,
        memberId: effect.member_id,
        roleId: effect.effect_target_id,
        authorizedBy: await env.DB.prepare(
          "SELECT approved_by FROM automation_rules WHERE id = ?"
        ).bind(effect.rule_id).first<{ approved_by: string }>().then(row => row?.approved_by ?? null),
        executedBy: executorId
      })).run();
    } catch (error) {
      console.error(`Could not expire temporary automation effect ${effect.id}:`, error);
    }
  }
}
