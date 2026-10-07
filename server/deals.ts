import { randomUUID } from 'node:crypto';
import { AccessDeniedError, assertContactAccess, assertWorkspaceAccess, contactVisibleSql, database as db, syncContactStage, workspaceForActor } from './db.js';

export const DEAL_STAGES = ['new', 'contacted', 'replied', 'meeting', 'won', 'lost'] as const;
export type DealStage = typeof DEAL_STAGES[number];

/** A deal can be worth up to this many paise (about 9 trillion rupees); anything above is a typing slip. */
export const MAX_DEAL_VALUE_MINOR = 900_000_000_000_000;

export type DealRow = {
  id: string; title: string; value_minor: number | null; stage: DealStage; lost_reason: string | null; version: number;
  contact_id: string; contact_name: string; company_id: string; company_name: string; quality: string | null;
  encounter_id: string | null; conversation_at: string | null; event_id: string | null; event_name: string | null;
  created_at: string; updated_at: string;
};

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

// Deals are listed through the person they belong to, so a deal is visible exactly when its person is.
const dealFrom = `FROM deals d JOIN contacts c ON c.id=d.contact_id AND c.workspace_id=d.workspace_id
  JOIN companies co ON co.id=d.company_id AND co.workspace_id=d.workspace_id
  LEFT JOIN encounters en ON en.id=d.encounter_id AND en.workspace_id=d.workspace_id
  LEFT JOIN events e ON e.id=d.event_id AND e.workspace_id=d.workspace_id
  LEFT JOIN event_access dea ON dea.workspace_id=d.workspace_id AND dea.event_id=d.event_id AND dea.user_id=?`;
const dealColumns = `d.id,d.title,d.value_minor,d.stage,d.lost_reason,d.version,d.contact_id,c.name AS contact_name,d.company_id,co.name AS company_name,c.quality,
  d.encounter_id,en.occurred_at AS conversation_at,d.event_id,CASE WHEN dea.user_id IS NOT NULL THEN e.name ELSE NULL END AS event_name,d.created_at,d.updated_at`;

export type DealFilter = { stage?: string; search?: string; contactId?: string; eventId?: string };

function dealWhere(actorId: string, workspaceId: string, filter: DealFilter) {
  const term = `%${(filter.search ?? '').trim().replace(/[\\%_]/g, '\\$&')}%`;
  const sql = `${dealFrom}
    WHERE d.workspace_id=? AND d.archived_at IS NULL AND c.deleted_at IS NULL AND c.archived_at IS NULL AND ${contactVisibleSql('c')}
      AND (?='' OR d.stage=?) AND (?='' OR d.contact_id=?) AND (?='' OR d.event_id=?)
      AND (?='' OR c.name LIKE ? ESCAPE '\\' OR co.name LIKE ? ESCAPE '\\' OR d.title LIKE ? ESCAPE '\\')`;
  const stage = filter.stage ?? '', contactId = filter.contactId ?? '', eventId = filter.eventId ?? '', search = (filter.search ?? '').trim();
  return { sql, args: [actorId, workspaceId, actorId, actorId, actorId, stage, stage, contactId, contactId, eventId, eventId, search, term, term, term] };
}

export async function listDeals(actorId: string, workspaceId: string, filter: DealFilter = {}, limit = 100, offset = 0): Promise<DealRow[]> {
  await assertWorkspaceAccess(actorId, workspaceId);
  const where = dealWhere(actorId, workspaceId, filter);
  return await db.prepare(`SELECT ${dealColumns} ${where.sql} ORDER BY d.updated_at DESC,d.id LIMIT ? OFFSET ?`)
    .all(...where.args, Math.min(Math.max(limit, 1), 500), Math.max(offset, 0)) as DealRow[];
}

/** How many deals are in each stage and what they add up to, for the pipeline column headers. */
export async function countDealsByStage(actorId: string, workspaceId: string, filter: Omit<DealFilter, 'stage'> = {}) {
  await assertWorkspaceAccess(actorId, workspaceId);
  const where = dealWhere(actorId, workspaceId, { ...filter, stage: '' });
  const rows = await db.prepare(`SELECT d.stage,COUNT(*) AS deal_count,SUM(COALESCE(d.value_minor,0)) AS total ${where.sql} GROUP BY d.stage`)
    .all(...where.args) as Array<{ stage: DealStage; deal_count: number; total: number | null }>;
  const stages = Object.fromEntries(DEAL_STAGES.map((stage) => [stage, { count: 0, value: 0 }])) as Record<DealStage, { count: number; value: number }>;
  for (const row of rows) stages[row.stage] = { count: Number(row.deal_count), value: Number(row.total ?? 0) };
  return { stages, total: rows.reduce((sum, row) => sum + Number(row.deal_count), 0) };
}

export async function getDeal(actorId: string, workspaceId: string, dealId: string): Promise<DealRow | undefined> {
  await assertWorkspaceAccess(actorId, workspaceId);
  const where = dealWhere(actorId, workspaceId, {});
  return await db.prepare(`SELECT ${dealColumns} ${where.sql} AND d.id=?`).get(...where.args, dealId) as DealRow | undefined;
}

async function conversationFor(actorId: string, workspaceId: string, contactId: string, encounterId: string) {
  const row = await db.prepare(`SELECT en.id,en.event_id FROM encounters en WHERE en.workspace_id=? AND en.contact_id=? AND en.id=?
    AND (en.event_id IS NULL OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id AND ea.user_id=?))`)
    .get(workspaceId, contactId, encounterId, actorId) as { id: string; event_id: string | null } | undefined;
  if (!row) throw new Error('Choose a conversation with this person that you can access.');
  return row;
}

/** In a company space only an admin or manager puts a value on a deal; anyone with access to the person can still name it, link it and move it. */
async function assertCanSetValue(actorId: string, workspaceId: string) {
  const workspace = await workspaceForActor(actorId, workspaceId);
  if (workspace?.kind === 'company' && workspace.role !== 'admin' && workspace.role !== 'manager') throw new AccessDeniedError('An admin or manager sets deal values.');
}

export type NewDeal = { contactId: string; title: string; valueMinor: number | null; encounterId: string | null; clientDealId?: string };

export async function createDeal(actorId: string, workspaceId: string, input: NewDeal) {
  await assertWorkspaceAccess(actorId, workspaceId);
  await assertContactAccess(actorId, workspaceId, input.contactId);
  if (input.valueMinor !== null && (!Number.isSafeInteger(input.valueMinor) || input.valueMinor < 0 || input.valueMinor > MAX_DEAL_VALUE_MINOR)) throw new Error('Enter a deal value that is zero or more.');
  if (input.valueMinor !== null) await assertCanSetValue(actorId, workspaceId);
  const contact = await db.prepare(`SELECT company_id,owner_user_id FROM contacts WHERE workspace_id=? AND id=? AND deleted_at IS NULL AND archived_at IS NULL`).get(workspaceId, input.contactId) as { company_id: string; owner_user_id: string | null } | undefined;
  if (!contact) throw new Error('This person is no longer available.');
  const conversation = input.encounterId ? await conversationFor(actorId, workspaceId, input.contactId, input.encounterId) : null;
  const id = input.clientDealId ?? randomUUID();
  return await (db.transaction(async () => {
    // The same request twice (a double click, a retry after a lost response) answers with the deal already made.
    const existing = await db.prepare(`SELECT id,contact_id FROM deals WHERE workspace_id=? AND id=?`).get(workspaceId, id) as { id: string; contact_id: string } | undefined;
    if (existing) {
      if (existing.contact_id !== input.contactId) throw new Error('This deal request was already used for another person.');
      return { id, duplicate: true };
    }
    await db.prepare(`INSERT INTO deals(id,workspace_id,contact_id,company_id,encounter_id,event_id,title,value_minor,stage,owner_user_id,created_by) VALUES (?,?,?,?,?,?,?,?,'new',?,?)`)
      .run(id, workspaceId, input.contactId, contact.company_id, conversation?.id ?? null, conversation?.event_id ?? null, input.title.trim(), input.valueMinor, contact.owner_user_id ?? actorId, actorId);
    await syncContactStage(workspaceId, input.contactId);
    await db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'deal_created','deal',?,?)`)
      .run(randomUUID(), workspaceId, actorId, id, JSON.stringify({ contactId: input.contactId, valueMinor: input.valueMinor, encounterId: conversation?.id ?? null }));
    return { id, duplicate: false };
  })()) as { id: string; duplicate: boolean };
}

export type DealChanges = { title?: string; valueMinor?: number | null; encounterId?: string | null };

/** Edits one deal. `version` is the version the person saw; if someone else changed the deal first, nothing is saved. */
export async function updateDeal(actorId: string, workspaceId: string, dealId: string, version: number, changes: DealChanges) {
  await assertWorkspaceAccess(actorId, workspaceId);
  const deal = await db.prepare(`SELECT id,contact_id,title,value_minor,encounter_id FROM deals WHERE workspace_id=? AND id=? AND archived_at IS NULL`).get(workspaceId, dealId) as
    { id: string; contact_id: string; title: string; value_minor: number | null; encounter_id: string | null } | undefined;
  if (!deal) return false;
  await assertContactAccess(actorId, workspaceId, deal.contact_id);
  if (changes.valueMinor !== undefined && changes.valueMinor !== null && (!Number.isSafeInteger(changes.valueMinor) || changes.valueMinor < 0 || changes.valueMinor > MAX_DEAL_VALUE_MINOR)) throw new Error('Enter a deal value that is zero or more.');
  if (changes.valueMinor !== undefined && changes.valueMinor !== deal.value_minor) await assertCanSetValue(actorId, workspaceId);
  let encounterId = deal.encounter_id;
  let eventId: string | null | undefined;
  if (changes.encounterId !== undefined) {
    if (changes.encounterId === null) { encounterId = null; eventId = null; }
    else { const conversation = await conversationFor(actorId, workspaceId, deal.contact_id, changes.encounterId); encounterId = conversation.id; eventId = conversation.event_id; }
  }
  const title = changes.title === undefined ? deal.title : changes.title.trim();
  const value = changes.valueMinor === undefined ? deal.value_minor : changes.valueMinor;
  return await (db.transaction(async () => {
    const result = eventId === undefined
      ? await db.prepare(`UPDATE deals SET title=?,value_minor=?,encounter_id=?,version=version+1,updated_at=${NOW} WHERE workspace_id=? AND id=? AND version=? AND archived_at IS NULL`).run(title, value, encounterId, workspaceId, dealId, version)
      : await db.prepare(`UPDATE deals SET title=?,value_minor=?,encounter_id=?,event_id=?,version=version+1,updated_at=${NOW} WHERE workspace_id=? AND id=? AND version=? AND archived_at IS NULL`).run(title, value, encounterId, eventId, workspaceId, dealId, version);
    if (!result.changes) return false;
    await db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'deal_updated','deal',?,?)`)
      .run(randomUUID(), workspaceId, actorId, dealId, JSON.stringify({ valueMinor: value, encounterId }));
    return true;
  })()) as boolean;
}

/** Moves one deal to another stage. Other deals with the same person are not touched. */
export async function moveDeal(actorId: string, workspaceId: string, dealId: string, stage: DealStage, version: number, lostReason = '') {
  await assertWorkspaceAccess(actorId, workspaceId);
  if (stage === 'lost' && !lostReason.trim()) return false;
  const deal = await db.prepare(`SELECT contact_id,stage FROM deals WHERE workspace_id=? AND id=? AND archived_at IS NULL`).get(workspaceId, dealId) as { contact_id: string; stage: DealStage } | undefined;
  if (!deal) return false;
  await assertContactAccess(actorId, workspaceId, deal.contact_id);
  return await (db.transaction(async () => {
    const closed = stage === 'won' || stage === 'lost';
    const result = await db.prepare(`UPDATE deals SET stage=?,lost_reason=?,closed_at=${closed ? NOW : 'NULL'},version=version+1,updated_at=${NOW} WHERE workspace_id=? AND id=? AND version=? AND archived_at IS NULL`)
      .run(stage, stage === 'lost' ? lostReason.trim() : null, workspaceId, dealId, version);
    if (!result.changes) return false;
    await syncContactStage(workspaceId, deal.contact_id);
    await db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'deal_stage_changed','deal',?,?)`)
      .run(randomUUID(), workspaceId, actorId, dealId, JSON.stringify({ from: deal.stage, stage, ...(stage === 'lost' ? { lostReason: lostReason.trim() } : {}) }));
    return true;
  })()) as boolean;
}

/** Removes a deal from the pipeline. The person, their conversations and their other deals stay. */
export async function archiveDeal(actorId: string, workspaceId: string, dealId: string) {
  await assertWorkspaceAccess(actorId, workspaceId);
  const deal = await db.prepare(`SELECT contact_id FROM deals WHERE workspace_id=? AND id=? AND archived_at IS NULL`).get(workspaceId, dealId) as { contact_id: string } | undefined;
  if (!deal) return false;
  await assertContactAccess(actorId, workspaceId, deal.contact_id);
  return await (db.transaction(async () => {
    const result = await db.prepare(`UPDATE deals SET archived_at=${NOW},version=version+1 WHERE workspace_id=? AND id=? AND archived_at IS NULL`).run(workspaceId, dealId);
    if (!result.changes) return false;
    await syncContactStage(workspaceId, deal.contact_id);
    await db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'deal_removed','deal',?,?)`)
      .run(randomUUID(), workspaceId, actorId, dealId, JSON.stringify({ contactId: deal.contact_id }));
    return true;
  })()) as boolean;
}

export { AccessDeniedError };
