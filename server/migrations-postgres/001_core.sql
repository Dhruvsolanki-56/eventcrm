CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  password_hash text NOT NULL,
  email_verified_at text,
  disabled_at text,
  created_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users(lower(email));

CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('company','personal')),
  name text NOT NULL,
  owner_user_id text NOT NULL REFERENCES users(id),
  created_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS memberships (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin','manager','representative','attendee')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  PRIMARY KEY (workspace_id,user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_hash text NOT NULL,
  expires_at text NOT NULL,
  revoked_at text,
  created_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE TABLE IF NOT EXISTS invites (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('manager','representative')),
  event_ids_json text NOT NULL DEFAULT '[]',
  expires_at text NOT NULL,
  accepted_at text,
  revoked_at text,
  created_by text NOT NULL REFERENCES users(id),
  created_at text
);
CREATE INDEX IF NOT EXISTS invites_workspace_created ON invites(workspace_id,created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  starts_at text NOT NULL,
  ends_at text NOT NULL,
  time_zone text NOT NULL,
  spend_minor integer CHECK (spend_minor IS NULL OR spend_minor >= 0),
  is_active integer NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
  created_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE TABLE IF NOT EXISTS event_access (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(event_id,user_id)
);

CREATE TABLE IF NOT EXISTS products (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  url text,
  archived_at text
);
CREATE TABLE IF NOT EXISTS companies (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  normalized_name text NOT NULL,
  website text,
  normalized_domain text,
  deal_value_minor integer CHECK (deal_value_minor IS NULL OR deal_value_minor >= 0),
  deal_status text CHECK (deal_status IS NULL OR deal_status IN ('open','won','lost')),
  archived_at text,
  created_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  UNIQUE(workspace_id,normalized_name)
);
CREATE UNIQUE INDEX IF NOT EXISTS companies_domain_unique ON companies(workspace_id,normalized_domain) WHERE normalized_domain IS NOT NULL AND normalized_domain <> '';
CREATE INDEX IF NOT EXISTS companies_workspace_name ON companies(workspace_id,normalized_name);

CREATE TABLE IF NOT EXISTS contacts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  title text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  email_normalized text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  phone_normalized text NOT NULL DEFAULT '',
  quality text CHECK (quality IS NULL OR quality IN ('hot','warm','cold')),
  stage text NOT NULL DEFAULT 'new' CHECK (stage IN ('new','contacted','replied','meeting','won','lost')),
  lost_reason text,
  do_not_contact integer NOT NULL DEFAULT 0 CHECK (do_not_contact IN (0,1)),
  owner_user_id text REFERENCES users(id),
  version integer NOT NULL DEFAULT 1,
  archived_at text,
  deleted_at text,
  created_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  website text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS contacts_workspace_company ON contacts(workspace_id,company_id);
CREATE INDEX IF NOT EXISTS contacts_email_match ON contacts(workspace_id,email_normalized) WHERE email_normalized <> '';
CREATE INDEX IF NOT EXISTS contacts_phone_match ON contacts(workspace_id,phone_normalized) WHERE phone_normalized <> '';
CREATE INDEX IF NOT EXISTS contacts_workspace_stage ON contacts(workspace_id,stage,created_at);

CREATE TABLE IF NOT EXISTS scans (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id text REFERENCES events(id),
  client_scan_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('camera','gallery','qr','manual')),
  image_path text,
  image_mime text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','reading','ready','saved','failed','discarded')),
  extracted_json text,
  uncertain_json text NOT NULL DEFAULT '[]',
  error_message text,
  contact_id text REFERENCES contacts(id) ON DELETE SET NULL,
  queued_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  reading_started_at text,
  ready_at text,
  saved_at text,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  client_order bigint,
  material_company_id text REFERENCES companies(id) ON DELETE SET NULL,
  image_bytes bigint NOT NULL DEFAULT 0 CHECK (image_bytes >= 0),
  content_sha256 text,
  visual_hash text,
  UNIQUE(workspace_id,client_scan_id)
);
CREATE INDEX IF NOT EXISTS scans_workspace_owner ON scans(workspace_id,created_by,queued_at);
CREATE INDEX IF NOT EXISTS scans_review_order ON scans(workspace_id,client_order,queued_at);
CREATE INDEX IF NOT EXISTS scans_company_materials ON scans(workspace_id,material_company_id,saved_at DESC) WHERE material_company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scans_source_workspace ON scans(source,workspace_id);

CREATE TABLE IF NOT EXISTS encounters (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id text NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  event_id text REFERENCES events(id),
  scan_id text REFERENCES scans(id) ON DELETE SET NULL UNIQUE,
  occurred_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  client_conversation_id text
);
CREATE TABLE IF NOT EXISTS notes (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id text NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  encounter_id text REFERENCES encounters(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('text','audio')),
  body text NOT NULL DEFAULT '',
  transcript text NOT NULL DEFAULT '',
  transcript_status text NOT NULL DEFAULT 'manual' CHECK (transcript_status IN ('manual','queued','complete','failed','unavailable')),
  audio_path text,
  audio_mime text,
  duration_seconds integer,
  created_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  audio_bytes bigint NOT NULL DEFAULT 0 CHECK (audio_bytes >= 0),
  created_by text REFERENCES users(id),
  summary text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS notes_by_creator ON notes(workspace_id,created_by,contact_id);
CREATE TABLE IF NOT EXISTS contact_products (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id text NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY(contact_id,product_id)
);
CREATE TABLE IF NOT EXISTS emails (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id text NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  encounter_id text REFERENCES encounters(id) ON DELETE SET NULL,
  recipient text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','queued','sent','failed','outbox','replied')),
  provider_message_id text,
  error_message text,
  unsubscribe_token_hash text,
  approved_at text,
  sent_to_server_at text,
  created_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  created_by text REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id text NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  event_id text REFERENCES events(id),
  kind text NOT NULL CHECK (kind IN ('follow_up','meeting')),
  status text NOT NULL CHECK (status IN ('proposed','confirmed','open','done','no_show','cancelled')),
  due_at text NOT NULL,
  time_zone text NOT NULL,
  title text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  snoozed_until text,
  created_by text NOT NULL REFERENCES users(id),
  created_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload_json text NOT NULL,
  run_at text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  lease_until text,
  last_error text,
  created_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  finished_at text
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status,run_at,lease_until);
CREATE TABLE IF NOT EXISTS notifications (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  message text NOT NULL,
  read_at text,
  created_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  dedupe_key text,
  contact_id text REFERENCES contacts(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe ON notifications(workspace_id,user_id,dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS digest_runs (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','sent_to_server','failed','not_sent')),
  job_id text REFERENCES jobs(id) ON DELETE SET NULL,
  last_error text,
  sent_to_server_at text,
  created_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  PRIMARY KEY(workspace_id,user_id,local_date)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id text NOT NULL REFERENCES users(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  details_json text NOT NULL DEFAULT '{}',
  created_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  value_json text NOT NULL,
  updated_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  PRIMARY KEY(workspace_id,key)
);
CREATE TABLE IF NOT EXISTS user_workspace_preferences (
  workspace_id text NOT NULL,
  user_id text NOT NULL,
  preference_key text NOT NULL CHECK (preference_key IN ('capture_after_save_email','onboarding')),
  value_json text NOT NULL,
  updated_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  PRIMARY KEY(workspace_id,user_id,preference_key),
  FOREIGN KEY(workspace_id,user_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS account_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('password_reset','email_verification')),
  token_hash text NOT NULL UNIQUE,
  expires_at text NOT NULL,
  used_at text,
  created_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS account_tokens_user_kind ON account_tokens(user_id,kind,created_at);
CREATE INDEX IF NOT EXISTS account_tokens_valid ON account_tokens(token_hash,kind,expires_at) WHERE used_at IS NULL;
CREATE TABLE IF NOT EXISTS email_send_limits (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS email_send_limits_actor_time_idx ON email_send_limits(actor_user_id,created_at);
CREATE INDEX IF NOT EXISTS email_send_limits_workspace_time_idx ON email_send_limits(workspace_id,created_at);
CREATE TABLE IF NOT EXISTS voice_note_usage (
  scope_id text PRIMARY KEY,
  created_count integer NOT NULL DEFAULT 0 CHECK (created_count >= 0)
);
CREATE TABLE IF NOT EXISTS company_aliases (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  alias_type text NOT NULL CHECK (alias_type IN ('name','domain')),
  alias_value text NOT NULL,
  PRIMARY KEY(workspace_id,alias_type,alias_value)
);
CREATE INDEX IF NOT EXISTS company_aliases_by_company ON company_aliases(workspace_id,company_id);
