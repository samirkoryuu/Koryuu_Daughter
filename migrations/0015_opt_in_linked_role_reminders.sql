CREATE TABLE linked_role_reminder_subscriptions (
  guild_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'verified', 'left', 'failed')),
  subscribed_at TEXT NOT NULL,
  next_reminder_at TEXT,
  last_reminded_at TEXT,
  reminder_count INTEGER NOT NULL DEFAULT 0 CHECK (reminder_count >= 0),
  result TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, member_id)
);

CREATE INDEX linked_role_reminder_subscriptions_due
  ON linked_role_reminder_subscriptions(status, next_reminder_at)
  WHERE status = 'active';

UPDATE linked_role_onboarding
SET next_reminder_at = NULL
WHERE next_reminder_at IS NOT NULL;
