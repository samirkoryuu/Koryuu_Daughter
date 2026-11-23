import type { Env } from "./platform.js";

export const AFK_PRESETS = [
  { value: "sleeping", label: "🌙 Sleeping", description: "Gone to recharge." },
  { value: "studying", label: "📚 Studying", description: "Academic suffering. Will return." },
  { value: "eating", label: "🍽️ Eating", description: "Food comes first." },
  { value: "gaming", label: "🎮 Gaming", description: "One more match..." },
  { value: "away", label: "🚶 Away from Keyboard", description: "Just busy with real life." }
] as const;

const CUSTOM_MAX_LENGTH = 200;

export function resolveAfkStatus(value: string): string | null {
  const preset = AFK_PRESETS.find(option => option.value === value);
  if (!preset) return null;
  return `${preset.label} — ${preset.description}`;
}

export async function setAfkStatus(
  env: Env,
  guildId: string,
  userId: string,
  status: string,
  now = new Date()
): Promise<void> {
  if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(userId)) {
    throw new Error("AFK status requires a valid server and user.");
  }
  const cleaned = status.trim();
  if (!cleaned || cleaned.length > CUSTOM_MAX_LENGTH) {
    throw new Error(`AFK status must be between 1 and ${CUSTOM_MAX_LENGTH} characters.`);
  }
  const timestamp = now.toISOString();
  await env.DB.prepare(
    `INSERT INTO afk_statuses(guild_id, user_id, status, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET
       status = excluded.status, started_at = excluded.started_at, updated_at = excluded.updated_at`
  ).bind(guildId, userId, cleaned, timestamp, timestamp).run();
}

export async function processAfkMessage(
  env: Env,
  guildId: string,
  authorId: string,
  mentionedUserIds: string[]
): Promise<{ mentionedAfkUsers: Array<{ userId: string; status: string }>; clearedStatus: string | null }> {
  const mentionedAfkUsers: Array<{ userId: string; status: string }> = [];
  const uniqueMentions = [...new Set(mentionedUserIds)].filter(userId => userId !== authorId);
  const userIds = [...new Set([...uniqueMentions, authorId])];
  if (!/^\d{17,20}$/.test(guildId) || userIds.some(userId => !/^\d{17,20}$/.test(userId))) {
    throw new Error("AFK message requires valid server and user IDs.");
  }

  const placeholders = userIds.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `SELECT user_id, status FROM afk_statuses WHERE guild_id = ? AND user_id IN (${placeholders})`
  ).bind(guildId, ...userIds).all<{ user_id: string; status: string }>();
  const statuses = new Map(result.results.map(row => [row.user_id, row.status]));
  for (const userId of uniqueMentions) {
    const status = statuses.get(userId);
    if (status) mentionedAfkUsers.push({ userId, status });
  }

  const clearedStatus = statuses.get(authorId) ?? null;
  if (clearedStatus) {
    await env.DB.prepare("DELETE FROM afk_statuses WHERE guild_id = ? AND user_id = ?")
      .bind(guildId, authorId).run();
  }
  return { mentionedAfkUsers, clearedStatus };
}

export function afkConfirmationEmbed(userId: string, status: string): {
  title: string;
  description: string;
  color: number;
} {
  return {
    title: "AFK",
    description: `<@${userId}> You're now AFK with the status: **${status}**`,
    color: 0xe5a83b
  };
}

export function afkStatusPicker(): unknown[] {
  return [{
    type: 1,
    components: [{
      type: 3,
      custom_id: "koryuu_afk_status",
      placeholder: "Choose an AFK status",
      min_values: 1,
      max_values: 1,
      options: [
        ...AFK_PRESETS.map(option => ({
          label: option.label,
          value: option.value,
          description: option.description
        })),
        {
          label: "✏️ Custom",
          value: "custom",
          description: "Write your own AFK status"
        }
      ]
    }]
  }];
}

export function customAfkModal(): Response {
  return new Response(JSON.stringify({
    type: 9,
    data: {
      custom_id: "koryuu_afk_custom",
      title: "Set a custom AFK status",
      components: [{
        type: 1,
        components: [{
          type: 4,
          custom_id: "status",
          style: 2,
          label: "Your AFK status",
          placeholder: "What are you up to?",
          min_length: 1,
          max_length: CUSTOM_MAX_LENGTH,
          required: true
        }]
      }]
    }
  }), {
    headers: { "content-type": "application/json" }
  });
}
