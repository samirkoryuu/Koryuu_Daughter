ALTER TABLE automation_rules ADD COLUMN deleted_at TEXT;
ALTER TABLE automation_events ADD COLUMN locked_at TEXT;
ALTER TABLE automation_runs ADD COLUMN executed_by TEXT NOT NULL DEFAULT 'koryuu-worker';
ALTER TABLE temporary_effects ADD COLUMN source_run_id TEXT REFERENCES automation_runs(id);
ALTER TABLE temporary_effects ADD COLUMN action_index INTEGER;

CREATE UNIQUE INDEX temporary_effects_by_action
  ON temporary_effects(source_run_id, action_index);

CREATE TABLE automation_rule_proposals (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  operation_type TEXT NOT NULL
    CHECK (operation_type IN ('create', 'update', 'delete', 'set_enabled')),
  rule_id TEXT,
  payload TEXT NOT NULL,
  preview TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired', 'failed')),
  authorized_by TEXT,
  executed_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  executed_at TEXT,
  result TEXT
);
CREATE INDEX automation_rule_proposals_pending
  ON automation_rule_proposals(status, expires_at, guild_id);
