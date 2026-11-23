export interface D1Result {
  success: boolean;
  meta?: { changes?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface R2ObjectBody {
  body: ReadableStream<Uint8Array>;
  httpMetadata?: { contentType?: string };
  writeHttpMetadata(headers: Headers): void;
}

export interface R2Bucket {
  put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string): Promise<void>;
}

export interface Env {
  DB: D1Database;
  MEDIA?: R2Bucket;
  LILITH_USER_ID: string;
  ASTERION_USER_ID: string;
  DISCORD_PUBLIC_KEY: string;
  GATEWAY_SHARED_SECRET: string;
  GROQ_API_KEY: string;
  GROQ_API_KEY_2?: string;
  GROQ_API_KEY_3?: string;
  GROQ_API_KEY_4?: string;
  GROQ_API_KEY_5?: string;
  GROQ_API_KEY_6?: string;
  GROQ_API_KEY_7?: string;
  GROQ_API_KEY_8?: string;
  GROQ_MODEL?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_CLIENT_SECRET?: string;
  WORKER_PUBLIC_URL?: string;
  ADMIN_PASSWORD_SHA256?: string;
  ARCHIVE_GUILD_ID?: string;
}

export interface ScheduledController {
  scheduledTime: number;
  cron: string;
  noRetry(): void;
}

export interface ChatRequest {
  actorId: string;
  text: string;
  isDm: boolean;
  guildId?: string | null;
  channelId?: string;
  mentionedUsers?: Array<{ id: string; displayName: string }>;
  everyoneMentioned?: boolean;
  recentMessages?: Array<{ authorId: string; authorName: string; content: string; createdAt: string }>;
  recentMessagesUnavailable?: boolean;
}

export interface PendingActionView {
  id: string;
  label: string;
}

export interface ChatResponse {
  reply: string;
  pendingAction?: PendingActionView;
  private: boolean;
  mediaIds?: string[];
}
