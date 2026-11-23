CREATE TABLE temporary_admin_access (
  user_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL
);

CREATE INDEX temporary_admin_access_by_expiry ON temporary_admin_access(expires_at);
