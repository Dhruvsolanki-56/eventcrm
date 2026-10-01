CREATE TABLE IF NOT EXISTS account_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('password_reset','email_verification')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS account_tokens_user_kind ON account_tokens(user_id,kind,created_at);
CREATE INDEX IF NOT EXISTS account_tokens_valid ON account_tokens(token_hash,kind,expires_at) WHERE used_at IS NULL;
