ALTER TABLE contacts ADD COLUMN website TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS contacts_workspace_stage ON contacts(workspace_id,stage,created_at);
CREATE INDEX IF NOT EXISTS companies_workspace_name ON companies(workspace_id,normalized_name);
