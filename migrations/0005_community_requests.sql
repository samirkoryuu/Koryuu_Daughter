CREATE TABLE community_requests (
  id TEXT PRIMARY KEY,
  guild_id TEXT,
  submitter_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'commission', 'development_service', 'creative_service', 'professional_service',
    'complaint', 'suggestion', 'important_information', 'personal_channel',
    'team', 'role_access', 'verification', 'development_application',
    'staff_application', 'supporter_application', 'investor_proposal',
    'minecraft_access', 'discount'
  )),
  title TEXT NOT NULL,
  details TEXT NOT NULL,
  involved_people TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN (
    'submitted', 'under_review', 'negotiating', 'approved', 'declined',
    'in_progress', 'resolved', 'closed'
  )),
  routed_to TEXT NOT NULL,
  assigned_to TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX community_requests_by_submitter
  ON community_requests(submitter_id, status, created_at DESC);
CREATE INDEX community_requests_review_queue
  ON community_requests(guild_id, status, category, created_at);
CREATE INDEX community_requests_by_assignee
  ON community_requests(assigned_to, status, created_at);

CREATE TABLE community_request_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES community_requests(id),
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'submitted', 'status_changed', 'assigned', 'note_added', 'notification_failed'
  )),
  details TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX community_request_events_by_request
  ON community_request_events(request_id, created_at);
