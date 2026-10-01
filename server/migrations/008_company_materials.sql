ALTER TABLE scans ADD COLUMN material_company_id TEXT REFERENCES companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS scans_company_materials ON scans(workspace_id,material_company_id,saved_at DESC) WHERE material_company_id IS NOT NULL;
