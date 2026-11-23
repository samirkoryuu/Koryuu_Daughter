CREATE TABLE community_member_activity_days (
  guild_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  activity_date TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, member_id, activity_date)
);
CREATE INDEX community_member_activity_by_member
  ON community_member_activity_days(guild_id, member_id, activity_date DESC);
