CREATE TABLE IF NOT EXISTS deals (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id text NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  company_id text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  encounter_id text REFERENCES encounters(id) ON DELETE SET NULL,
  event_id text REFERENCES events(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT '',
  value_minor bigint CHECK (value_minor IS NULL OR value_minor >= 0),
  stage text NOT NULL DEFAULT 'new' CHECK (stage IN ('new','contacted','replied','meeting','won','lost')),
  lost_reason text,
  owner_user_id text REFERENCES users(id),
  created_by text REFERENCES users(id),
  version integer NOT NULL DEFAULT 1,
  closed_at text,
  archived_at text,
  created_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  updated_at text NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS deals_by_stage ON deals(workspace_id,stage,updated_at);
CREATE INDEX IF NOT EXISTS deals_by_contact ON deals(workspace_id,contact_id);
CREATE INDEX IF NOT EXISTS deals_by_event ON deals(workspace_id,event_id);
CREATE INDEX IF NOT EXISTS deals_by_encounter ON deals(encounter_id);
CREATE INDEX IF NOT EXISTS deals_by_company ON deals(workspace_id,company_id);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deal_id text REFERENCES deals(id) ON DELETE SET NULL;

INSERT INTO deals(id,workspace_id,contact_id,company_id,encounter_id,event_id,title,value_minor,stage,lost_reason,owner_user_id,created_by,closed_at,created_at,updated_at)
SELECT 'deal-'||c.id, c.workspace_id, c.id, c.company_id,
  (SELECT en.id FROM encounters en WHERE en.workspace_id=c.workspace_id AND en.contact_id=c.id ORDER BY en.occurred_at DESC, en.id LIMIT 1),
  (SELECT en.event_id FROM encounters en WHERE en.workspace_id=c.workspace_id AND en.contact_id=c.id ORDER BY en.occurred_at DESC, en.id LIMIT 1),
  '', NULL, c.stage, c.lost_reason, c.owner_user_id, c.owner_user_id,
  CASE WHEN c.stage IN ('won','lost') THEN c.updated_at ELSE NULL END, c.created_at, c.updated_at
FROM contacts c WHERE c.deleted_at IS NULL
ON CONFLICT (id) DO NOTHING;

UPDATE deals SET value_minor=(SELECT co.deal_value_minor FROM companies co WHERE co.workspace_id=deals.workspace_id AND co.id=deals.company_id)
WHERE id IN (SELECT (SELECT d2.id FROM deals d2 WHERE d2.workspace_id=co.workspace_id AND d2.company_id=co.id ORDER BY d2.updated_at DESC, d2.id LIMIT 1)
  FROM companies co WHERE co.deal_value_minor IS NOT NULL);
UPDATE deals SET stage='won',closed_at=COALESCE(closed_at,updated_at)
WHERE id IN (SELECT (SELECT d2.id FROM deals d2 WHERE d2.workspace_id=co.workspace_id AND d2.company_id=co.id ORDER BY d2.updated_at DESC, d2.id LIMIT 1)
  FROM companies co WHERE co.deal_status='won');
UPDATE contacts SET stage='won' WHERE id IN (SELECT contact_id FROM deals WHERE stage='won') AND stage NOT IN ('won','lost');
