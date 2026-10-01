ALTER TABLE notes ADD COLUMN created_by TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS notes_by_creator ON notes(workspace_id,created_by,contact_id);
