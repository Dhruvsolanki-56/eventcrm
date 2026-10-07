ALTER TABLE emails ADD COLUMN IF NOT EXISTS send_at text;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS campaign_id text;

CREATE TABLE IF NOT EXISTS email_campaigns (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'marketing' CHECK (kind IN ('marketing','follow_up')),
  audience_json text NOT NULL DEFAULT '{}',
  subject_template text NOT NULL,
  body_template text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','cancelled')),
  send_at text,
  recipient_count integer NOT NULL DEFAULT 0,
  created_by text NOT NULL REFERENCES users(id),
  created_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  approved_at text
);
CREATE INDEX IF NOT EXISTS email_campaigns_by_workspace ON email_campaigns(workspace_id,created_at);
CREATE INDEX IF NOT EXISTS emails_by_campaign ON emails(campaign_id);
CREATE INDEX IF NOT EXISTS emails_by_send_at ON emails(workspace_id,status,send_at);

CREATE TABLE IF NOT EXISTS rate_limit_hits (
  key text PRIMARY KEY,
  hits integer NOT NULL,
  reset_ms bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limit_hits_reset ON rate_limit_hits(reset_ms);

CREATE TABLE IF NOT EXISTS ai_cache (
  cache_key text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  result_json text NOT NULL,
  created_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  expires_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_cache_expires ON ai_cache(expires_at);
CREATE INDEX IF NOT EXISTS ai_cache_workspace ON ai_cache(workspace_id);
CREATE TABLE IF NOT EXISTS ai_usage (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day text NOT NULL,
  kind text NOT NULL,
  calls integer NOT NULL DEFAULT 0,
  cache_hits integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0,
  PRIMARY KEY(workspace_id,day,kind)
);
