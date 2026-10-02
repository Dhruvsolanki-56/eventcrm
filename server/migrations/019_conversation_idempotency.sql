ALTER TABLE encounters ADD COLUMN client_conversation_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS encounters_client_conversation_unique
  ON encounters(workspace_id, client_conversation_id)
  WHERE client_conversation_id IS NOT NULL;
