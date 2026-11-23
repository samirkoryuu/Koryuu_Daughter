CREATE TABLE linked_role_onboarding (
  guild_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('checking', 'sent', 'already_linked', 'failed')),
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, member_id)
);
CREATE INDEX linked_role_onboarding_by_status
  ON linked_role_onboarding(status, updated_at);
