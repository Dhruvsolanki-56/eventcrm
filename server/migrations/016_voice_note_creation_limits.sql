CREATE TABLE IF NOT EXISTS voice_note_usage (
  scope_id TEXT PRIMARY KEY,
  created_count INTEGER NOT NULL DEFAULT 0 CHECK(created_count >= 0)
);

INSERT OR IGNORE INTO voice_note_usage(scope_id,created_count)
SELECT '__service__',MAX(
  (SELECT COUNT(*) FROM audit_events WHERE action='voice_note_added'),
  (SELECT COUNT(*) FROM notes WHERE kind='audio')
);

INSERT OR IGNORE INTO voice_note_usage(scope_id,created_count)
SELECT w.id,MAX(
  (SELECT COUNT(*) FROM audit_events a WHERE a.workspace_id=w.id AND a.action='voice_note_added'),
  (SELECT COUNT(*) FROM notes n WHERE n.workspace_id=w.id AND n.kind='audio')
)
FROM workspaces w;

UPDATE voice_note_usage SET created_count=MAX(created_count,(
  SELECT COALESCE(SUM(created_count),0) FROM voice_note_usage WHERE scope_id<>'__service__'
)) WHERE scope_id='__service__';
