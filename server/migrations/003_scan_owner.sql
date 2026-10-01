ALTER TABLE scans ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS scans_workspace_owner ON scans(workspace_id,created_by,queued_at);
