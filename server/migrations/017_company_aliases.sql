CREATE TABLE IF NOT EXISTS company_aliases (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  alias_type TEXT NOT NULL CHECK(alias_type IN ('name','domain')),
  alias_value TEXT NOT NULL,
  PRIMARY KEY (workspace_id,alias_type,alias_value)
);
CREATE INDEX IF NOT EXISTS company_aliases_by_company ON company_aliases(workspace_id,company_id);
