ALTER TABLE scans ADD COLUMN visual_hash TEXT;
CREATE INDEX IF NOT EXISTS scans_visual_hash_lookup ON scans(workspace_id, status, saved_at) WHERE visual_hash IS NOT NULL;
