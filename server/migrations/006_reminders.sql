ALTER TABLE notifications ADD COLUMN dedupe_key TEXT;
ALTER TABLE notifications ADD COLUMN contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe ON notifications(workspace_id,user_id,dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS digest_runs (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','sent_to_server','failed','not_sent')),
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  last_error TEXT,
  sent_to_server_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(workspace_id,user_id,local_date)
);
