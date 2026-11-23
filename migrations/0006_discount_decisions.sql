CREATE TABLE community_discount_decisions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES community_requests(id),
  submitter_id TEXT NOT NULL,
  target_service TEXT NOT NULL,
  requested_percent INTEGER NOT NULL CHECK (requested_percent BETWEEN 10 AND 35),
  approved_percent INTEGER CHECK (
    approved_percent IS NULL OR approved_percent BETWEEN 10 AND 35
  ),
  status TEXT NOT NULL CHECK (status IN ('approved', 'declined')),
  decision_note TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
CREATE INDEX community_discount_decisions_by_submitter
  ON community_discount_decisions(submitter_id, decided_at DESC);
CREATE INDEX community_discount_decisions_by_request
  ON community_discount_decisions(request_id, decided_at DESC);
