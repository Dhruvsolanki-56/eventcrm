ALTER TABLE invites ADD COLUMN created_at TEXT;
UPDATE invites SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE created_at IS NULL;
CREATE INDEX IF NOT EXISTS invites_workspace_created ON invites(workspace_id, created_at DESC);
