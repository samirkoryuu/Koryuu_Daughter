ALTER TABLE purchases ADD COLUMN guild_id TEXT;

CREATE TABLE server_change_proposals (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,
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
CREATE INDEX server_change_proposals_pending
  ON server_change_proposals(status, expires_at, guild_id);

CREATE TABLE automation_rules (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_config TEXT NOT NULL DEFAULT '{}',
  condition_config TEXT NOT NULL DEFAULT '[]',
  action_config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX automation_rules_by_trigger
  ON automation_rules(guild_id, trigger_type, enabled);

CREATE TABLE automation_events (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  source_event_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT
);
CREATE INDEX automation_events_ready
  ON automation_events(status, created_at, guild_id);

CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES automation_events(id),
  rule_id TEXT NOT NULL REFERENCES automation_rules(id),
  rule_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  result TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  authorized_by TEXT NOT NULL,
  UNIQUE(event_id, rule_id)
);
CREATE INDEX automation_runs_by_rule
  ON automation_runs(rule_id, started_at DESC);

CREATE TABLE temporary_effects (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  effect_target_id TEXT NOT NULL,
  rule_id TEXT NOT NULL REFERENCES automation_rules(id),
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'failed')),
  created_at TEXT NOT NULL,
  expired_at TEXT
);
CREATE INDEX temporary_effects_due
  ON temporary_effects(status, expires_at);

CREATE TRIGGER purchases_create_automation_event
AFTER INSERT ON purchases
WHEN NEW.legacy_import = 0 AND NEW.guild_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO automation_events(
    id, guild_id, event_type, payload, source_event_key, created_at
  ) VALUES (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
      substr(lower(hex(randomblob(2))), 2) || '-a' ||
      substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
    NEW.guild_id,
    'shop.purchase',
    json_object(
      'purchase_id', NEW.id,
      'buyer_id', NEW.buyer_id,
      'member_id', NEW.buyer_id,
      'unique_id', NEW.unique_id,
      'item_title', NEW.item_title,
      'price_paid', NEW.price_paid
    ),
    'purchase:' || NEW.id,
    CURRENT_TIMESTAMP
  );
END;
