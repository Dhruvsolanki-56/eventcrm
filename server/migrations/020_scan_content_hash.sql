ALTER TABLE scans ADD COLUMN content_sha256 TEXT;
CREATE INDEX IF NOT EXISTS scans_content_hash ON scans(workspace_id,content_sha256)
  WHERE content_sha256 IS NOT NULL AND status<>'discarded';
