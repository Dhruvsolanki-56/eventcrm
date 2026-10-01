CREATE TABLE IF NOT EXISTS email_send_limits (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS email_send_limits_actor_time_idx ON email_send_limits(actor_user_id, created_at);
CREATE INDEX IF NOT EXISTS email_send_limits_workspace_time_idx ON email_send_limits(workspace_id, created_at);
