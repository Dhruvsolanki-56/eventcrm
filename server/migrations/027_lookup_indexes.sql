-- People lists, person pages and contact deletes looked these up by scanning the whole table.
CREATE INDEX IF NOT EXISTS encounters_by_contact ON encounters(workspace_id,contact_id);
CREATE INDEX IF NOT EXISTS encounters_by_event ON encounters(workspace_id,event_id);
CREATE INDEX IF NOT EXISTS notes_by_contact ON notes(workspace_id,contact_id);
CREATE INDEX IF NOT EXISTS tasks_by_contact ON tasks(workspace_id,contact_id);
CREATE INDEX IF NOT EXISTS emails_by_contact ON emails(workspace_id,contact_id);
