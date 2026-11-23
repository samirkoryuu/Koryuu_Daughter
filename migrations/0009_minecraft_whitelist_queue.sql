CREATE TABLE minecraft_whitelist_queue (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES community_requests(id),
  guild_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  minecraft_username TEXT NOT NULL,
  partner_ids TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  authorized_by TEXT NOT NULL,
  worker_result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX minecraft_whitelist_queue_ready
  ON minecraft_whitelist_queue(status, created_at);
CREATE INDEX minecraft_whitelist_queue_by_guild
  ON minecraft_whitelist_queue(guild_id, status, created_at DESC);
