import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The hosted-database mode, run against a real PostgreSQL engine (PGlite) behind the same compatibility layer the
// server uses with `pg`. It exercises the SQL added for deals, events, scheduling, group emails, rate limits and AI usage.
vi.mock('pg', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = new PGlite();
  const run = async (text: string, values?: unknown[]) => {
    // Like the real driver, text with no values may hold several statements.
    if (!values) { const all = await lite.exec(text); const last = all[all.length - 1]; return { rows: last?.rows ?? [], rowCount: last?.affectedRows ?? 0, fields: last?.fields ?? [] }; }
    const result = await lite.query(text, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length, fields: result.fields };
  };
  class Pool {
    on() { return this; }
    query(text: string, values?: unknown[]) { return run(text, values); }
    async connect() { return { query: run, release() { /* one shared connection */ } }; }
    async end() { await lite.close(); }
  }
  return { default: { Pool, types: { setTypeParser() { /* numbers already */ } } }, Pool };
});

let database: typeof import('./db.js');
let campaigns: typeof import('./campaigns.js');
const ws = 'demo-northstar', maya = 'demo-owner';

beforeAll(async () => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgres://test/test', DATABASE_SSL: 'disable', AI_MODE: 'off', UPLOADS_PATH: 'uploads-pg-test' });
  database = await import('./db.js');
  campaigns = await import('./campaigns.js');
  await database.migrate();
  await database.seedDemoData('not-a-real-hash');
}, 120_000);
afterAll(async () => { await (await import('./postgres-compat.js')).closePostgresPool().catch(() => undefined); });

describe('hosted database mode', () => {
  it('lists deals and moves only one of a person\'s deals', async () => {
    const deals = await import('./deals.js');
    const before = await deals.listDeals(maya, ws, { contactId: 'demo-ns-contact-26' });
    expect(before.length).toBeGreaterThan(0);
    const created = await deals.createDeal(maya, ws, { contactId: 'demo-ns-contact-26', title: 'PG second deal', valueMinor: 123400, encounterId: null });
    const fresh = (await deals.listDeals(maya, ws, { contactId: 'demo-ns-contact-26' })).find((deal) => deal.id === created.id)!;
    const moved = await deals.moveDeal(maya, ws, created.id, 'contacted', fresh.version);
    expect(moved).toBeTruthy();
    const after = await deals.listDeals(maya, ws, { contactId: 'demo-ns-contact-26' });
    expect(after.find((deal) => deal.id === created.id)?.stage).toBe('contacted');
    expect(after.find((deal) => deal.id === before[0]!.id)?.stage).toBe(before[0]!.stage);
    expect(typeof after.find((deal) => deal.id === created.id)?.value_minor).toBe('number');
  });

  it('answers every read the screens make', async () => {
    const deals = await import('./deals.js');
    const reads: Array<[string, () => Promise<unknown>]> = [
      ['dashboard', () => database.getDashboard(maya, ws)],
      ['people', () => database.listPeople(maya, ws, 'a', false, 50, 0, 'new')],
      ['people by stage', () => database.countPeopleByStage(maya, ws, '', false)],
      ['companies', () => database.listCompanies(maya, ws, 'a')],
      ['company', () => database.getCompanyDetail(maya, ws, 'demo-ns-acme')],
      ['person', () => database.getPersonDetail(maya, ws, 'demo-ns-contact-1')],
      ['reports', () => database.getReportData(maya, ws)],
      ['analytics', () => database.getAnalytics(maya, ws, 30)],
      ['analytics by event', () => database.getAnalytics(maya, ws, 30, 'event-main-active')],
      ['export', () => database.getWorkspaceExport(maya, ws)],
      ['tasks', () => database.listTasks(maya, ws)],
      ['notifications', () => database.listNotifications(maya, ws)],
      ['email desk', () => database.listEmailDesk(maya, ws)],
      ['pipeline counts', () => deals.countDealsByStage(maya, ws, { search: 'a' })],
      ['pipeline page', () => deals.listDeals(maya, ws, { stage: 'new', search: 'a' }, 20, 0)],
    ];
    for (const [name, read] of reads) await expect(read(), name).resolves.toBeDefined();
  }, 60_000);

  it('runs the writes the screens make', async () => {
    const deals = await import('./deals.js');
    const id = randomUUID();
    const saved = await database.addConversation(maya, ws, 'demo-ns-contact-12', { eventId: 'event-main-active', body: 'Talked about cartons on the hosted database.', clientConversationId: id });
    expect(saved.duplicate).toBe(false);
    expect((await database.addConversation(maya, ws, 'demo-ns-contact-12', { eventId: 'event-main-active', body: 'Talked about cartons on the hosted database.', clientConversationId: id })).duplicate).toBe(true);
    await database.markContactReplied(maya, ws, 'demo-ns-contact-12');
    const mine = await deals.listDeals(maya, ws, { contactId: 'demo-ns-contact-12' });
    expect(mine.some((deal) => deal.stage === 'replied')).toBe(true);
    const extra = await deals.createDeal(maya, ws, { contactId: 'demo-ns-contact-12', title: 'To remove', valueMinor: null, encounterId: saved.id });
    expect(await deals.archiveDeal(maya, ws, extra.id)).toBe(true);
    await database.setWorkspaceSetting(maya, ws, 'draftAutomation', { autoDraftAfterConversation: true, autoSend: { enabled: false, schedule: { mode: 'delay', minutes: 60 } } });
    expect(await database.getWorkspaceSetting(maya, ws, 'draftAutomation')).toMatchObject({ autoDraftAfterConversation: true });
  });

  it('answers event analytics', async () => {
    const events = await import('./events.js');
    const list = await events.listEventsWithStats(maya, ws);
    expect(list.events.length).toBeGreaterThan(0);
    const detail = await events.getEventDetail(maya, ws, 'event-main-active');
    expect(detail?.metrics.people).toBeGreaterThan(0);
  });

  it('builds, previews, approves and cancels a group email', async () => {
    const preview = await campaigns.previewAudience(maya, ws, { eventId: 'event-main-active' });
    expect(preview.matched).toBeGreaterThan(0);
    const id = randomUUID();
    const made = await campaigns.createCampaign(maya, ws, { clientCampaignId: id, name: 'PG', subject: 'Hi {{firstName}} from {{event}}', body: 'Hello {{company}}', audience: { eventId: 'event-main-active' } });
    expect(made.recipients).toBeGreaterThan(0);
    const detail = await campaigns.getCampaign(maya, ws, id);
    expect(detail?.recipients.length).toBe(made.recipients);
    expect(detail?.recipients[0]?.subject).toContain('Pacific Packaging Expo');
    expect(await campaigns.updateCampaignTemplate(maya, ws, id, 'Hello {{name}}', 'Body')).toBe(made.recipients);
    const approved = await campaigns.approveCampaign(maya, ws, id, { staggerSeconds: 30, smtpReady: true, publicBaseUrl: 'https://crm.example.com' });
    expect(approved.approved).toBe(made.recipients);
    expect((await campaigns.listCampaigns(maya, ws)).find((row) => row.id === id)?.counts.queued).toBe(made.recipients);
    const cancelled = await campaigns.cancelCampaign(maya, ws, id);
    expect(cancelled?.removed).toBe(made.recipients);
  }, 60_000);

  it('schedules an email, then takes it back', async () => {
    const draft = await database.createEmailDraft(maya, ws, 'demo-ns-contact-5');
    const result = await database.approveEmailDraft(maya, ws, draft.id, true, 'https://crm.example.com', new Date(Date.now() + 3600_000));
    expect(result).toMatchObject({ scheduled: true });
    expect(await database.cancelScheduledEmail(maya, ws, draft.id)).toBe(true);
    expect(await database.cancelScheduledEmail(maya, ws, draft.id)).toBe(false);
  });

  it('plans and removes an automatic send', async () => {
    const draft = await database.createEmailDraft(maya, ws, 'demo-ns-contact-6');
    process.env.AUTO_SEND_MIN_DELAY_SECONDS = '0';
    await database.queueAutoSend(ws, draft.id, maya, new Date());
    expect(await database.emailDraftIsImproving(ws, draft.id)).toBe(false);
    expect(await database.cancelAutoSend(ws, draft.id)).toBe(true);
  });

  it('counts requests in the shared limiter and records AI usage', async () => {
    const { DatabaseRateLimitStore } = await import('./rate-limit-store.js');
    const store = new DatabaseRateLimitStore('pg');
    store.init({ windowMs: 60_000 } as never);
    expect((await store.increment('k')).totalHits).toBe(1);
    expect((await store.increment('k')).totalHits).toBe(2);
    const { guardedAI, aiUsageSummary } = await import('./ai-guard.js');
    let calls = 0;
    const ask = () => guardedAI({ workspaceId: ws, kind: 'follow_up', input: 'pg input', run: async () => { calls += 1; return { ok: true }; } });
    await ask(); await ask();
    expect(calls).toBe(1);
    const usage = (await aiUsageSummary(ws)).find((row) => row.kind === 'follow_up');
    expect(Number(usage?.calls)).toBeGreaterThanOrEqual(1);
    expect(Number(usage?.cache_hits)).toBeGreaterThanOrEqual(1);
  });
});
