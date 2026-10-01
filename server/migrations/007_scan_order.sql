ALTER TABLE scans ADD COLUMN client_order INTEGER;
CREATE INDEX IF NOT EXISTS scans_review_order ON scans(workspace_id,client_order,queued_at);
