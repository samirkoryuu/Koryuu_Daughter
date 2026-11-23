import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { D1Database, D1PreparedStatement, D1Result, Env, R2Bucket, R2ObjectBody } from "../src/platform.js";

class LocalStatement implements D1PreparedStatement {
  private values: SQLInputValue[] = [];

  constructor(private readonly database: DatabaseSync, private readonly query: string) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values as SQLInputValue[];
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.query).get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[]; success: boolean }> {
    return {
      results: this.database.prepare(this.query).all(...this.values) as T[],
      success: true
    };
  }

  async run(): Promise<D1Result> {
    const result = this.database.prepare(this.query).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class LocalDatabase implements D1Database {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): D1PreparedStatement {
    return new LocalStatement(this.database, query);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    this.database.exec("BEGIN");
    try {
      const results: D1Result[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class LocalBucket implements R2Bucket {
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<void> {
    const bytes = typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
          : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, {
      bytes,
      contentType: options?.httpMetadata?.contentType ?? "application/octet-stream"
    });
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const body = new ArrayBuffer(stored.bytes.byteLength);
    new Uint8Array(body).set(stored.bytes);
    return {
      body: new Blob([body]).stream(),
      httpMetadata: { contentType: stored.contentType },
      writeHttpMetadata(headers: Headers): void {
        headers.set("content-type", stored.contentType);
      }
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

export function makeTestEnv(): { env: Env; database: DatabaseSync; bucket: R2Bucket } {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("migrations/0001_initial.sql", "utf8"));
  database.exec(readFileSync("migrations/0002_temporary_admin_tickets.sql", "utf8"));
  database.exec(readFileSync("migrations/0003_automation.sql", "utf8"));
  database.exec(readFileSync("migrations/0004_automation_lifecycle.sql", "utf8"));
  database.exec(readFileSync("migrations/0005_community_requests.sql", "utf8"));
  database.exec(readFileSync("migrations/0006_discount_decisions.sql", "utf8"));
  database.exec(readFileSync("migrations/0007_community_teams.sql", "utf8"));
  database.exec(readFileSync("migrations/0008_recruitment_activity.sql", "utf8"));
  database.exec(readFileSync("migrations/0009_minecraft_whitelist_queue.sql", "utf8"));
  database.exec(readFileSync("migrations/0010_linked_role_oauth.sql", "utf8"));
  database.exec(readFileSync("migrations/0011_linked_role_onboarding.sql", "utf8"));
  database.exec(readFileSync("migrations/0012_linked_role_reminders.sql", "utf8"));
  database.exec(readFileSync("migrations/0013_groq_key_rotation.sql", "utf8"));
  database.exec(readFileSync("migrations/0014_persistent_chat_and_message_archive.sql", "utf8"));
  database.exec(readFileSync("migrations/0015_opt_in_linked_role_reminders.sql", "utf8"));
  database.exec(readFileSync("migrations/0016_verification_reminder_campaigns.sql", "utf8"));
  database.exec(readFileSync("migrations/0017_afk_statuses.sql", "utf8"));
  database.exec(readFileSync("migrations/0018_group_dm_campaigns.sql", "utf8"));
  const bucket = new LocalBucket();
  return {
    database,
    bucket,
    env: {
      DB: new LocalDatabase(database),
      MEDIA: bucket,
      LILITH_USER_ID: "100000000000000001",
      ASTERION_USER_ID: "100000000000000002",
      DISCORD_PUBLIC_KEY: "",
      GATEWAY_SHARED_SECRET: "test-secret-test-secret-test-secret",
      GROQ_API_KEY: "test-key",
      GROQ_MODEL: "groq-test-model",
      ARCHIVE_GUILD_ID: "100000000000000010",
      DISCORD_BOT_TOKEN: "test-bot-token",
      ADMIN_PASSWORD_SHA256: ""
    }
  };
}
