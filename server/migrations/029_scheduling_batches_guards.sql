-- When an approved email should go out, and the batch (campaign) it belongs to, if any.
ALTER TABLE emails ADD COLUMN send_at TEXT;
ALTER TABLE emails ADD COLUMN campaign_id TEXT;

CREATE TABLE IF NOT EXISTS email_campaigns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'marketing' CHECK(kind IN ('marketing','follow_up')),
  audience_json TEXT NOT NULL DEFAULT '{}',
  subject_template TEXT NOT NULL,
  body_template TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','cancelled')),
  send_at TEXT,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  approved_at TEXT
);
CREATE INDEX IF NOT EXISTS email_campaigns_by_workspace ON email_campaigns(workspace_id,created_at);
CREATE INDEX IF NOT EXISTS emails_by_campaign ON emails(campaign_id);
CREATE INDEX IF NOT EXISTS emails_by_send_at ON emails(workspace_id,status,send_at);

-- Request counters shared by every server instance, so a limit holds when there is more than one.
CREATE TABLE IF NOT EXISTS rate_limit_hits (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  reset_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limit_hits_reset ON rate_limit_hits(reset_ms);

-- Answers from the AI provider, kept briefly so the same question is not paid for twice, and a per-day count per workspace.
CREATE TABLE IF NOT EXISTS ai_cache (
  cache_key TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_cache_expires ON ai_cache(expires_at);
CREATE INDEX IF NOT EXISTS ai_cache_workspace ON ai_cache(workspace_id);
CREATE TABLE IF NOT EXISTS ai_usage (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  cache_hits INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(workspace_id,day,kind)
);
