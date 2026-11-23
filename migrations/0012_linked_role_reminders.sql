ALTER TABLE linked_role_onboarding
  ADD COLUMN next_reminder_at TEXT;
ALTER TABLE linked_role_onboarding
  ADD COLUMN last_reminded_at TEXT;
ALTER TABLE linked_role_onboarding
  ADD COLUMN reminder_count INTEGER NOT NULL DEFAULT 0 CHECK (reminder_count >= 0);

UPDATE linked_role_onboarding
SET next_reminder_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+20 minutes')
WHERE status = 'sent';

CREATE INDEX linked_role_onboarding_due_reminders
  ON linked_role_onboarding(status, next_reminder_at)
  WHERE status = 'sent';
