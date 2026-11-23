CREATE TABLE community_teams (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  leader_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  source_request_id TEXT REFERENCES community_requests(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE UNIQUE INDEX community_teams_active_name
  ON community_teams(guild_id, name COLLATE NOCASE) WHERE status = 'active';
CREATE UNIQUE INDEX community_teams_by_role
  ON community_teams(guild_id, role_id);
CREATE UNIQUE INDEX community_teams_by_channel
  ON community_teams(guild_id, channel_id);

CREATE TABLE community_team_members (
  team_id TEXT NOT NULL REFERENCES community_teams(id),
  user_id TEXT NOT NULL,
  member_role TEXT NOT NULL CHECK (member_role IN ('leader', 'member')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  joined_at TEXT NOT NULL,
  left_at TEXT,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX community_team_members_active
  ON community_team_members(team_id, active, member_role);

CREATE TABLE community_team_events (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES community_teams(id),
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX community_team_events_by_team
  ON community_team_events(team_id, created_at DESC);
