CREATE TABLE IF NOT EXISTS user_workspace_preferences (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  preference_key TEXT NOT NULL CHECK(preference_key IN ('capture_after_save_email')),
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(workspace_id,user_id,preference_key),
  FOREIGN KEY(workspace_id,user_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE
);
