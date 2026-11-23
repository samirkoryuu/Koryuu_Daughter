CREATE TABLE verification_reminder_campaigns (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scanning', 'sending', 'completed', 'failed')),
  after_user_id TEXT,
  scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
  target_count INTEGER NOT NULL DEFAULT 0 CHECK (target_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX verification_reminder_one_active_campaign
  ON verification_reminder_campaigns(guild_id)
  WHERE status IN ('scanning', 'sending');

CREATE INDEX verification_reminder_campaigns_by_status
  ON verification_reminder_campaigns(status, created_at);

CREATE TABLE verification_reminder_recipients (
  campaign_id TEXT NOT NULL REFERENCES verification_reminder_campaigns(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
  previous_sent_at TEXT,
  sent_at TEXT,
  claimed_at TEXT,
  next_attempt_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  result TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (campaign_id, member_id)
);

CREATE INDEX verification_reminder_recipients_due
  ON verification_reminder_recipients(campaign_id, status, next_attempt_at, member_id);

CREATE INDEX verification_reminder_recipients_member_history
  ON verification_reminder_recipients(member_id, status, sent_at DESC);
