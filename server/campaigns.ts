import { randomUUID } from 'node:crypto';
import { AccessDeniedError, approveEmailDraft, assertWorkspaceAccess, contactVisibleSql, database as db, workspaceForActor } from './db.js';

/** One batch of email to a chosen group of people. Each person gets their own draft, made from one template. */
export const MAX_CAMPAIGN_RECIPIENTS = 500;
const RECENT_CONTACT_DAYS = 7;
export const MERGE_FIELDS = ['firstName', 'name', 'company', 'event'] as const;

export type Audience = { eventId?: string; stages?: string[]; quality?: string[]; companyId?: string; contactIds?: string[] };
export class CampaignLimitError extends Error { constructor(message: string, readonly retryAfterSeconds = 3600) { super(message); this.name = 'CampaignLimitError'; } }

const clean = (list: string[] | undefined) => [...new Set((list ?? []).filter(Boolean))].slice(0, 500);

/** Marketing to a group is for admins and managers in a company space; anyone in their own private space. */
async function assertCanRunCampaigns(actorId: string, workspaceId: string) {
  const workspace = await workspaceForActor(actorId, workspaceId);
  if (!workspace) throw new AccessDeniedError('You do not have access to this workspace.');
  if (workspace.kind === 'company' && workspace.role !== 'admin' && workspace.role !== 'manager') throw new AccessDeniedError('An admin or manager sends emails to a group.');
}

export function unknownMergeFields(...templates: string[]) {
  const found = new Set<string>();
  for (const template of templates) for (const match of template.matchAll(/\{\{\s*([A-Za-z]+)\s*\}\}/g)) if (!(MERGE_FIELDS as readonly string[]).includes(match[1]!)) found.add(match[1]!);
  return [...found];
}

export function renderTemplate(template: string, values: { name: string; company: string; event: string }) {
  const first = values.name.trim().split(/\s+/)[0] || 'there';
  const map: Record<string, string> = { firstName: first, name: values.name.trim() || 'there', company: values.company || 'your company', event: values.event || 'our recent event' };
  return template.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (_all, key: string) => map[key] ?? '');
}

type Candidate = { id: string; name: string; email: string | null; company: string; do_not_contact: number; recent: number; event_name: string | null };

async function candidates(actorId: string, workspaceId: string, audience: Audience, limit: number): Promise<Candidate[]> {
  const stages = clean(audience.stages), quality = clean(audience.quality), ids = clean(audience.contactIds);
  const marks = (list: string[]) => list.map(() => '?').join(',');
  const eventName = audience.eventId ? `(SELECT e.name FROM events e WHERE e.workspace_id=c.workspace_id AND e.id=?)` : `(SELECT e.name FROM encounters en JOIN events e ON e.id=en.event_id AND e.workspace_id=en.workspace_id WHERE en.workspace_id=c.workspace_id AND en.contact_id=c.id ORDER BY en.occurred_at DESC LIMIT 1)`;
  const sql = `SELECT c.id,c.name,c.email,co.name AS company,c.do_not_contact,${eventName} AS event_name,
      (SELECT COUNT(*) FROM emails m WHERE m.workspace_id=c.workspace_id AND m.contact_id=c.id AND m.status IN ('sent','queued') AND COALESCE(m.sent_to_server_at,m.approved_at)>?) AS recent
    FROM contacts c JOIN companies co ON co.id=c.company_id AND co.workspace_id=c.workspace_id
    WHERE c.workspace_id=? AND c.deleted_at IS NULL AND c.archived_at IS NULL AND ${contactVisibleSql('c')}
      ${audience.eventId ? 'AND EXISTS (SELECT 1 FROM encounters en WHERE en.workspace_id=c.workspace_id AND en.contact_id=c.id AND en.event_id=?)' : ''}
      ${stages.length ? `AND c.stage IN (${marks(stages)})` : ''}
      ${quality.length ? `AND c.quality IN (${marks(quality)})` : ''}
      ${audience.companyId ? 'AND c.company_id=?' : ''}
      ${ids.length ? `AND c.id IN (${marks(ids)})` : ''}
    ORDER BY c.updated_at DESC,c.id LIMIT ?`;
  const since = new Date(Date.now() - RECENT_CONTACT_DAYS * 86400000).toISOString();
  const args = [...(audience.eventId ? [audience.eventId] : []), since, workspaceId, actorId, actorId, actorId, ...(audience.eventId ? [audience.eventId] : []), ...stages, ...quality, ...(audience.companyId ? [audience.companyId] : []), ...ids, limit];
  return await db.prepare(sql).all(...args) as Candidate[];
}

/** Who a group would reach, and who is left out and why. Nothing is saved. */
export async function previewAudience(actorId: string, workspaceId: string, audience: Audience) {
  await assertWorkspaceAccess(actorId, workspaceId);
  await assertCanRunCampaigns(actorId, workspaceId);
  const found = await candidates(actorId, workspaceId, audience, MAX_CAMPAIGN_RECIPIENTS + 1);
  const matched = found.length > MAX_CAMPAIGN_RECIPIENTS ? MAX_CAMPAIGN_RECIPIENTS : found.length;
  const pool = found.slice(0, MAX_CAMPAIGN_RECIPIENTS);
  const noEmail = pool.filter((person) => !person.email).length;
  const optedOut = pool.filter((person) => person.email && person.do_not_contact).length;
  const recentlyEmailed = pool.filter((person) => person.email && !person.do_not_contact && person.recent > 0).length;
  const eligible = pool.filter((person) => person.email && !person.do_not_contact && person.recent === 0);
  return {
    matched, capped: found.length > MAX_CAMPAIGN_RECIPIENTS, limit: MAX_CAMPAIGN_RECIPIENTS,
    excluded: { noEmail, optedOut, recentlyEmailed, recentDays: RECENT_CONTACT_DAYS },
    eligible: eligible.length,
    sample: eligible.slice(0, 12).map((person) => ({ id: person.id, name: person.name, company: person.company, email: person.email })),
  };
}

export type NewCampaign = { clientCampaignId: string; name: string; subject: string; body: string; audience: Audience };

/** Makes the campaign and one draft per person who can be emailed. Nothing is sent until the campaign is approved. */
export async function createCampaign(actorId: string, workspaceId: string, input: NewCampaign) {
  await assertWorkspaceAccess(actorId, workspaceId);
  await assertCanRunCampaigns(actorId, workspaceId);
  const unknown = unknownMergeFields(input.subject, input.body);
  if (unknown.length) throw new Error(`Unknown placeholder ${unknown.map((name) => `{{${name}}}`).join(', ')}. Use ${MERGE_FIELDS.map((name) => `{{${name}}}`).join(', ')}.`);
  const existing = await db.prepare(`SELECT id,recipient_count FROM email_campaigns WHERE workspace_id=? AND id=?`).get(workspaceId, input.clientCampaignId) as { id: string; recipient_count: number } | undefined;
  if (existing) return { id: existing.id, recipients: existing.recipient_count, duplicate: true };
  const people = (await candidates(actorId, workspaceId, input.audience, MAX_CAMPAIGN_RECIPIENTS))
    .filter((person) => person.email && !person.do_not_contact && person.recent === 0);
  if (!people.length) throw new Error('No one in this group can be emailed right now. Check the preview for why people were left out.');
  await db.transaction(async () => {
    await db.prepare(`INSERT INTO email_campaigns(id,workspace_id,name,kind,audience_json,subject_template,body_template,recipient_count,created_by) VALUES (?,?,?,'marketing',?,?,?,?,?)`)
      .run(input.clientCampaignId, workspaceId, input.name, JSON.stringify(input.audience), input.subject, input.body, people.length, actorId);
    for (const person of people) {
      const values = { name: person.name, company: person.company, event: person.event_name ?? '' };
      await db.prepare(`INSERT INTO emails(id,workspace_id,contact_id,encounter_id,recipient,subject,body,status,created_by,sources_json,campaign_id) VALUES (?,?,?,NULL,?,?,?,'draft',?,'[]',?)`)
        .run(randomUUID(), workspaceId, person.id, person.email, renderTemplate(input.subject, values), renderTemplate(input.body, values), actorId, input.clientCampaignId);
    }
    await db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'campaign_created','campaign',?,?)`)
      .run(randomUUID(), workspaceId, actorId, input.clientCampaignId, JSON.stringify({ recipients: people.length }));
  })();
  return { id: input.clientCampaignId, recipients: people.length, duplicate: false };
}

type CampaignRow = { id: string; name: string; kind: string; status: string; audience_json: string; subject_template: string; body_template: string; send_at: string | null; recipient_count: number; created_by: string; created_at: string; approved_at: string | null };

async function loadCampaign(workspaceId: string, campaignId: string) {
  return await db.prepare(`SELECT id,name,kind,status,audience_json,subject_template,body_template,send_at,recipient_count,created_by,created_at,approved_at FROM email_campaigns WHERE workspace_id=? AND id=?`).get(workspaceId, campaignId) as CampaignRow | undefined;
}

async function counts(workspaceId: string, campaignId: string) {
  const rows = await db.prepare(`SELECT status,COUNT(*) AS n,SUM(CASE WHEN status='queued' AND send_at IS NOT NULL THEN 1 ELSE 0 END) AS scheduled FROM emails WHERE workspace_id=? AND campaign_id=? GROUP BY status`)
    .all(workspaceId, campaignId) as Array<{ status: string; n: number; scheduled: number | null }>;
  const by = Object.fromEntries(rows.map((row) => [row.status, Number(row.n)])) as Record<string, number>;
  return {
    draft: by.draft ?? 0, queued: by.queued ?? 0, sent: (by.sent ?? 0) + (by.replied ?? 0), replied: by.replied ?? 0, failed: by.failed ?? 0, outbox: by.outbox ?? 0,
    scheduled: rows.reduce((sum, row) => sum + Number(row.scheduled ?? 0), 0),
  };
}

export async function listCampaigns(actorId: string, workspaceId: string) {
  await assertWorkspaceAccess(actorId, workspaceId);
  await assertCanRunCampaigns(actorId, workspaceId);
  const rows = await db.prepare(`SELECT id,name,status,send_at,recipient_count,created_at,approved_at FROM email_campaigns WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100`).all(workspaceId) as Array<Omit<CampaignRow, 'kind' | 'audience_json' | 'subject_template' | 'body_template' | 'created_by'>>;
  return await Promise.all(rows.map(async (row) => ({ ...row, counts: await counts(workspaceId, row.id) })));
}

export async function getCampaign(actorId: string, workspaceId: string, campaignId: string) {
  await assertWorkspaceAccess(actorId, workspaceId);
  await assertCanRunCampaigns(actorId, workspaceId);
  const campaign = await loadCampaign(workspaceId, campaignId);
  if (!campaign) return undefined;
  const recipients = await db.prepare(`SELECT m.id,m.contact_id,m.recipient,m.subject,m.status,m.send_at,m.sent_to_server_at,c.name AS person_name,co.name AS company_name
    FROM emails m JOIN contacts c ON c.id=m.contact_id AND c.workspace_id=m.workspace_id JOIN companies co ON co.id=c.company_id AND co.workspace_id=c.workspace_id
    WHERE m.workspace_id=? AND m.campaign_id=? ORDER BY c.name,m.id LIMIT 500`).all(workspaceId, campaignId);
  return { campaign: { ...campaign, audience: JSON.parse(campaign.audience_json) as Audience }, counts: await counts(workspaceId, campaignId), recipients };
}

/** Rewrites every unsent draft from new wording. */
export async function updateCampaignTemplate(actorId: string, workspaceId: string, campaignId: string, subject: string, body: string) {
  await assertWorkspaceAccess(actorId, workspaceId);
  await assertCanRunCampaigns(actorId, workspaceId);
  const unknown = unknownMergeFields(subject, body);
  if (unknown.length) throw new Error(`Unknown placeholder ${unknown.map((name) => `{{${name}}}`).join(', ')}.`);
  const campaign = await loadCampaign(workspaceId, campaignId);
  if (!campaign || campaign.status !== 'draft') throw new Error('This campaign can no longer be edited.');
  const audience = JSON.parse(campaign.audience_json) as Audience;
  const rows = await db.prepare(`SELECT m.id,c.name,co.name AS company,${audience.eventId ? `(SELECT e.name FROM events e WHERE e.workspace_id=c.workspace_id AND e.id=?)` : `(SELECT e.name FROM encounters en JOIN events e ON e.id=en.event_id AND e.workspace_id=en.workspace_id WHERE en.workspace_id=c.workspace_id AND en.contact_id=c.id ORDER BY en.occurred_at DESC LIMIT 1)`} AS event_name
    FROM emails m JOIN contacts c ON c.id=m.contact_id AND c.workspace_id=m.workspace_id JOIN companies co ON co.id=c.company_id AND co.workspace_id=c.workspace_id
    WHERE m.workspace_id=? AND m.campaign_id=? AND m.status='draft'`).all(...(audience.eventId ? [audience.eventId] : []), workspaceId, campaignId) as Array<{ id: string; name: string; company: string; event_name: string | null }>;
  await db.transaction(async () => {
    await db.prepare(`UPDATE email_campaigns SET subject_template=?,body_template=? WHERE workspace_id=? AND id=? AND status='draft'`).run(subject, body, workspaceId, campaignId);
    for (const row of rows) {
      const values = { name: row.name, company: row.company, event: row.event_name ?? '' };
      await db.prepare(`UPDATE emails SET subject=?,body=? WHERE workspace_id=? AND id=? AND status='draft'`).run(renderTemplate(subject, values), renderTemplate(body, values), workspaceId, row.id);
    }
  })();
  return rows.length;
}

export async function removeCampaignRecipient(actorId: string, workspaceId: string, campaignId: string, emailId: string) {
  await assertWorkspaceAccess(actorId, workspaceId);
  await assertCanRunCampaigns(actorId, workspaceId);
  return await db.transaction(async () => {
    const removed = await db.prepare(`DELETE FROM emails WHERE workspace_id=? AND campaign_id=? AND id=? AND status='draft'`).run(workspaceId, campaignId, emailId);
    if (removed.changes) await db.prepare(`UPDATE email_campaigns SET recipient_count=recipient_count-1 WHERE workspace_id=? AND id=? AND status='draft'`).run(workspaceId, campaignId);
    return removed.changes > 0;
  })();
}

function dailyLimit() {
  const value = Number(process.env.CAMPAIGN_DAILY_LIMIT);
  return Number.isInteger(value) && value > 0 ? value : 500;
}

/** Approves every draft in the campaign. Sends are spread out so a big batch never goes out in one burst. */
export async function approveCampaign(actorId: string, workspaceId: string, campaignId: string, options: { sendAt?: Date; staggerSeconds: number; smtpReady: boolean; publicBaseUrl: string }) {
  await assertWorkspaceAccess(actorId, workspaceId);
  await assertCanRunCampaigns(actorId, workspaceId);
  const campaign = await loadCampaign(workspaceId, campaignId);
  if (!campaign || campaign.status !== 'draft') throw new Error('This campaign was already approved or cancelled.');
  const drafts = await db.prepare(`SELECT m.id,c.do_not_contact FROM emails m JOIN contacts c ON c.id=m.contact_id AND c.workspace_id=m.workspace_id
    WHERE m.workspace_id=? AND m.campaign_id=? AND m.status='draft' ORDER BY m.id`).all(workspaceId, campaignId) as Array<{ id: string; do_not_contact: number }>;
  const today = new Date(Date.now() - 86400000).toISOString();
  const used = Number((await db.prepare(`SELECT COUNT(*) AS n FROM emails WHERE workspace_id=? AND campaign_id IS NOT NULL AND approved_at>?`).get(workspaceId, today) as { n: number }).n);
  if (used + drafts.length > dailyLimit()) throw new CampaignLimitError(`Group emails are limited to ${dailyLimit()} a day for each workspace. ${Math.max(0, dailyLimit() - used)} more can be approved today.`);
  const claimed = await db.prepare(`UPDATE email_campaigns SET status='approved',approved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),send_at=? WHERE workspace_id=? AND id=? AND status='draft'`)
    .run((options.sendAt ?? new Date()).toISOString(), workspaceId, campaignId);
  if (!claimed.changes) throw new Error('This campaign was already approved or cancelled.');
  const start = Math.max((options.sendAt ?? new Date()).getTime(), Date.now());
  let approved = 0, skipped = 0, index = 0;
  for (const draft of drafts) {
    if (draft.do_not_contact) { await db.prepare(`DELETE FROM emails WHERE workspace_id=? AND id=? AND status='draft'`).run(workspaceId, draft.id); skipped += 1; continue; }
    try {
      await approveEmailDraft(actorId, workspaceId, draft.id, options.smtpReady, options.publicBaseUrl, new Date(start + index * options.staggerSeconds * 1000), { bulk: true });
      approved += 1; index += 1;
    } catch { skipped += 1; }
  }
  await db.prepare(`UPDATE email_campaigns SET recipient_count=? WHERE workspace_id=? AND id=?`).run(approved, workspaceId, campaignId);
  await db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'campaign_approved','campaign',?,?)`)
    .run(randomUUID(), workspaceId, actorId, campaignId, JSON.stringify({ approved, skipped, staggerSeconds: options.staggerSeconds }));
  return { approved, skipped, lastSendAt: new Date(start + Math.max(0, index - 1) * options.staggerSeconds * 1000).toISOString() };
}

/** Stops a campaign: drafts are removed, and emails that have not gone out yet are taken back. Emails already sent stay as a record. */
export async function cancelCampaign(actorId: string, workspaceId: string, campaignId: string) {
  await assertWorkspaceAccess(actorId, workspaceId);
  await assertCanRunCampaigns(actorId, workspaceId);
  return await db.transaction(async () => {
    const campaign = await loadCampaign(workspaceId, campaignId);
    if (!campaign || campaign.status === 'cancelled') return undefined;
    await db.prepare(`DELETE FROM jobs WHERE workspace_id=? AND type='email_send' AND status='queued' AND json_extract(payload_json,'$.emailId') IN (SELECT id FROM emails WHERE workspace_id=? AND campaign_id=? AND status='queued')`).run(workspaceId, workspaceId, campaignId);
    const removed = await db.prepare(`DELETE FROM emails WHERE workspace_id=? AND campaign_id=? AND status IN ('draft','queued','outbox') AND id NOT IN (SELECT json_extract(payload_json,'$.emailId') FROM jobs WHERE workspace_id=? AND type='email_send' AND status IN ('running','succeeded'))`).run(workspaceId, campaignId, workspaceId);
    await db.prepare(`UPDATE email_campaigns SET status='cancelled' WHERE workspace_id=? AND id=?`).run(workspaceId, campaignId);
    await db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'campaign_cancelled','campaign',?,?)`).run(randomUUID(), workspaceId, actorId, campaignId, JSON.stringify({ removed: removed.changes }));
    return { removed: removed.changes };
  })();
}
