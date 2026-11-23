CREATE TABLE linked_role_oauth_states (
  state TEXT PRIMARY KEY,
  redirect_uri TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  discord_user_id TEXT
);
CREATE INDEX linked_role_oauth_states_expiry
  ON linked_role_oauth_states(status, expires_at);

CREATE TABLE linked_role_events (
  id TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('linked')),
  authorized_by TEXT NOT NULL,
  executed_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX linked_role_events_by_user
  ON linked_role_events(discord_user_id, created_at DESC);
