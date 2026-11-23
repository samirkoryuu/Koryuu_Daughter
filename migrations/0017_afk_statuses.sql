CREATE TABLE afk_statuses (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (length(status) BETWEEN 1 AND 200),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX afk_statuses_by_guild
  ON afk_statuses(guild_id, updated_at DESC);
