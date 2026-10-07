import { assertWorkspaceAccess, contactVisibleSql, database as db, workspaceForActor } from './db.js';

// Events are a record of their own: where people were met, what came of it, and what it cost.
// Everything here counts only people this person may see, the same rule the people list uses.

type Role = 'admin' | 'manager' | 'representative' | 'attendee';
const canSeeMoney = (role: Role | undefined, kind: string | undefined) => kind === 'personal' || role === 'admin' || role === 'manager';

export type EventSummary = {
  id: string; name: string; starts_at: string; ends_at: string; time_zone: string; is_active: number; spend_minor: number | null;
  people: number; conversations: number;
  deals: { open: number; won: number; lost: number; openValue: number; wonValue: number };
  emails: { drafted: number; sent: number; replied: number };
};

const emptyDeals = () => ({ open: 0, won: 0, lost: 0, openValue: 0, wonValue: 0 });

/**
 * A deal counts toward the event of the conversation it is linked to. A deal with no linked conversation counts toward
 * the event where the person was first met, so a deal typed in by hand is not lost to every event.
 */
const dealEventSql = `COALESCE(d.event_id,(SELECT en2.event_id FROM encounters en2 WHERE en2.workspace_id=d.workspace_id AND en2.contact_id=d.contact_id ORDER BY en2.occurred_at,en2.id LIMIT 1))`;

const accessibleEvents = `SELECT ea.event_id FROM event_access ea WHERE ea.workspace_id=? AND ea.user_id=?`;

export async function listEventsWithStats(actorId: string, workspaceId: string) {
  await assertWorkspaceAccess(actorId, workspaceId);
  const workspace = await workspaceForActor(actorId, workspaceId);
  const money = canSeeMoney(workspace?.role, workspace?.kind);
  const events = await db.prepare(`SELECT e.id,e.name,e.starts_at,e.ends_at,e.time_zone,e.is_active,e.spend_minor FROM events e
    JOIN event_access ea ON ea.workspace_id=e.workspace_id AND ea.event_id=e.id AND ea.user_id=?
    WHERE e.workspace_id=? ORDER BY e.is_active DESC,e.starts_at DESC,e.name`).all(actorId, workspaceId) as Array<Omit<EventSummary, 'people' | 'conversations' | 'deals' | 'emails'>>;
  if (!events.length) return { events: [] as EventSummary[], canManage: workspace?.kind === 'company' && workspace.role === 'admin', canSeeMoney: money };

  const visible = contactVisibleSql('c');
  const people = await db.prepare(`SELECT en.event_id,COUNT(DISTINCT en.contact_id) AS people,COUNT(*) AS conversations FROM encounters en
    JOIN contacts c ON c.id=en.contact_id AND c.workspace_id=en.workspace_id
    WHERE en.workspace_id=? AND en.event_id IN (${accessibleEvents}) AND c.deleted_at IS NULL AND c.archived_at IS NULL AND ${visible} GROUP BY en.event_id`)
    .all(workspaceId, workspaceId, actorId, actorId, actorId, actorId) as Array<{ event_id: string; people: number; conversations: number }>;
  const dealRows = await db.prepare(`SELECT ${dealEventSql} AS event_id,d.stage,COUNT(*) AS deal_count,SUM(COALESCE(d.value_minor,0)) AS total FROM deals d
    JOIN contacts c ON c.id=d.contact_id AND c.workspace_id=d.workspace_id
    WHERE d.workspace_id=? AND d.archived_at IS NULL AND c.deleted_at IS NULL AND c.archived_at IS NULL AND ${visible}
    GROUP BY 1,2`).all(workspaceId, actorId, actorId, actorId) as Array<{ event_id: string | null; stage: string; deal_count: number; total: number | null }>;
  const mailRows = await db.prepare(`SELECT en.event_id,COUNT(*) AS drafted,
      SUM(CASE WHEN m.sent_to_server_at IS NOT NULL THEN 1 ELSE 0 END) AS sent,SUM(CASE WHEN m.reply_recorded_at IS NOT NULL THEN 1 ELSE 0 END) AS replied
    FROM emails m JOIN encounters en ON en.id=m.encounter_id AND en.workspace_id=m.workspace_id
    JOIN contacts c ON c.id=m.contact_id AND c.workspace_id=m.workspace_id
    WHERE m.workspace_id=? AND en.event_id IN (${accessibleEvents}) AND c.deleted_at IS NULL AND c.archived_at IS NULL AND ${visible} GROUP BY en.event_id`)
    .all(workspaceId, workspaceId, actorId, actorId, actorId, actorId) as Array<{ event_id: string; drafted: number; sent: number | null; replied: number | null }>;

  const summaries = events.map((event): EventSummary => {
    const counts = people.find((row) => row.event_id === event.id);
    const deals = emptyDeals();
    for (const row of dealRows.filter((item) => item.event_id === event.id)) {
      const count = Number(row.deal_count), value = Number(row.total ?? 0);
      if (row.stage === 'won') { deals.won += count; deals.wonValue += value; }
      else if (row.stage === 'lost') deals.lost += count;
      else { deals.open += count; deals.openValue += value; }
    }
    const mail = mailRows.find((row) => row.event_id === event.id);
    return { ...event, spend_minor: money ? event.spend_minor : null, people: Number(counts?.people ?? 0), conversations: Number(counts?.conversations ?? 0), deals,
      emails: { drafted: Number(mail?.drafted ?? 0), sent: Number(mail?.sent ?? 0), replied: Number(mail?.replied ?? 0) } };
  });
  return { events: summaries, canManage: workspace?.kind === 'company' && workspace.role === 'admin', canSeeMoney: money };
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
const dayOf = (iso: string, timeZone: string) => {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); dayFormatters.set(timeZone, formatter); }
  return formatter.format(new Date(iso));
};

export type EventDetail = {
  event: { id: string; name: string; starts_at: string; ends_at: string; time_zone: string; is_active: number; spend_minor: number | null };
  canManage: boolean; canSeeMoney: boolean;
  metrics: { people: number; companies: number; conversations: number; contactable: number; meetings: number };
  quality: Array<{ quality: string; people: number }>;
  stages: Array<{ stage: string; people: number }>;
  deals: Array<{ stage: string; count: number; value: number }>;
  emails: { drafted: number; approved: number; sent: number; replied: number };
  daily: Array<{ day: string; people: number; conversations: number }>;
  team: Array<{ userId: string; name: string; people: number; conversations: number; wonValue: number }>;
  products: Array<{ name: string; people: number }>;
  recent: Array<{ id: string; name: string; company: string; stage: string; quality: string | null; metAt: string }>;
  cost: { spend: number | null; perPerson: number | null; perWonDeal: number | null; wonValuePerSpend: number | null };
};

export async function getEventDetail(actorId: string, workspaceId: string, eventId: string): Promise<EventDetail | undefined> {
  await assertWorkspaceAccess(actorId, workspaceId);
  const workspace = await workspaceForActor(actorId, workspaceId);
  const money = canSeeMoney(workspace?.role, workspace?.kind);
  const event = await db.prepare(`SELECT e.id,e.name,e.starts_at,e.ends_at,e.time_zone,e.is_active,e.spend_minor FROM events e
    JOIN event_access ea ON ea.workspace_id=e.workspace_id AND ea.event_id=e.id AND ea.user_id=? WHERE e.workspace_id=? AND e.id=?`).get(actorId, workspaceId, eventId) as EventDetail['event'] | undefined;
  if (!event) return undefined;
  const visible = contactVisibleSql('c');
  const baseArgs = [workspaceId, eventId, actorId, actorId, actorId];

  const encounterRows = await db.prepare(`SELECT en.occurred_at,c.id AS contact_id,c.stage,c.quality,c.email,c.phone,c.company_id,c.owner_user_id,c.name,co.name AS company_name
    FROM encounters en JOIN contacts c ON c.id=en.contact_id AND c.workspace_id=en.workspace_id JOIN companies co ON co.id=c.company_id AND co.workspace_id=c.workspace_id
    WHERE en.workspace_id=? AND en.event_id=? AND c.deleted_at IS NULL AND c.archived_at IS NULL AND ${visible} ORDER BY en.occurred_at DESC`).all(...baseArgs) as Array<{
      occurred_at: string; contact_id: string; stage: string; quality: string | null; email: string; phone: string; company_id: string; owner_user_id: string | null; name: string; company_name: string }>;
  const person = new Map(encounterRows.map((row) => [row.contact_id, row]));
  const people = [...person.values()];

  const dealRows = await db.prepare(`SELECT d.stage,d.contact_id,COALESCE(d.value_minor,0) AS value_minor FROM deals d JOIN contacts c ON c.id=d.contact_id AND c.workspace_id=d.workspace_id
    WHERE d.workspace_id=? AND d.archived_at IS NULL AND c.deleted_at IS NULL AND c.archived_at IS NULL AND ${visible}
      AND d.contact_id IN (SELECT x.contact_id FROM encounters x WHERE x.workspace_id=d.workspace_id AND x.event_id=?)
      AND ${dealEventSql}=?`).all(workspaceId, actorId, actorId, actorId, eventId, eventId) as Array<{ stage: string; contact_id: string; value_minor: number }>;
  const dealStages = ['new', 'contacted', 'replied', 'meeting', 'won', 'lost'].map((stage) => {
    const rows = dealRows.filter((row) => row.stage === stage);
    return { stage, count: rows.length, value: rows.reduce((sum, row) => sum + Number(row.value_minor), 0) };
  });
  const wonDeals = dealStages.find((row) => row.stage === 'won')!;

  const mail = await db.prepare(`SELECT COUNT(*) AS drafted,SUM(CASE WHEN m.approved_at IS NOT NULL THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN m.sent_to_server_at IS NOT NULL THEN 1 ELSE 0 END) AS sent,SUM(CASE WHEN m.reply_recorded_at IS NOT NULL THEN 1 ELSE 0 END) AS replied
    FROM emails m JOIN encounters en ON en.id=m.encounter_id AND en.workspace_id=m.workspace_id JOIN contacts c ON c.id=m.contact_id AND c.workspace_id=m.workspace_id
    WHERE m.workspace_id=? AND en.event_id=? AND c.deleted_at IS NULL AND c.archived_at IS NULL AND ${visible}`).get(...baseArgs) as { drafted: number; approved: number | null; sent: number | null; replied: number | null };
  const meetings = await db.prepare(`SELECT COUNT(*) AS total FROM tasks t JOIN contacts c ON c.id=t.contact_id AND c.workspace_id=t.workspace_id
    WHERE t.workspace_id=? AND t.event_id=? AND t.kind='meeting' AND t.status IN ('confirmed','done','no_show') AND c.deleted_at IS NULL AND c.archived_at IS NULL AND ${visible}`).get(...baseArgs) as { total: number };
  const productRows = await db.prepare(`SELECT p.name,COUNT(DISTINCT cp.contact_id) AS people FROM contact_products cp JOIN products p ON p.id=cp.product_id AND p.workspace_id=cp.workspace_id
    JOIN contacts c ON c.id=cp.contact_id AND c.workspace_id=cp.workspace_id
    WHERE cp.workspace_id=? AND p.archived_at IS NULL AND c.deleted_at IS NULL AND c.archived_at IS NULL AND ${visible}
      AND cp.contact_id IN (SELECT x.contact_id FROM encounters x WHERE x.workspace_id=cp.workspace_id AND x.event_id=?)
    GROUP BY p.id,p.name ORDER BY people DESC,p.name LIMIT 6`).all(workspaceId, actorId, actorId, actorId, eventId) as Array<{ name: string; people: number }>;

  // One row per day from the start of the event (or the first capture) to its end (or the last capture), the most recent 60 at most.
  const dayCounts = new Map<string, { people: Set<string>; conversations: number }>();
  for (const row of encounterRows) {
    const day = dayOf(row.occurred_at, event.time_zone);
    const entry = dayCounts.get(day) ?? { people: new Set<string>(), conversations: 0 };
    entry.people.add(row.contact_id); entry.conversations++; dayCounts.set(day, entry);
  }
  const firstDay = [dayOf(event.starts_at, event.time_zone), ...dayCounts.keys()].sort()[0]!;
  const lastDay = [dayOf(event.ends_at, event.time_zone), ...dayCounts.keys()].sort().at(-1)!;
  const daily: EventDetail['daily'] = [];
  for (let cursor = Date.parse(`${firstDay}T12:00:00Z`); cursor <= Date.parse(`${lastDay}T12:00:00Z`) && daily.length < 400; cursor += 86400000) {
    const key = new Date(cursor).toISOString().slice(0, 10);
    const entry = dayCounts.get(key);
    daily.push({ day: key, people: entry?.people.size ?? 0, conversations: entry?.conversations ?? 0 });
  }

  const owners = new Map<string, { people: Set<string>; conversations: number }>();
  for (const row of encounterRows) {
    const key = row.owner_user_id ?? 'none';
    const entry = owners.get(key) ?? { people: new Set<string>(), conversations: 0 };
    entry.people.add(row.contact_id); entry.conversations++; owners.set(key, entry);
  }
  const wonByPerson = new Map<string, number>();
  for (const deal of dealRows.filter((row) => row.stage === 'won')) wonByPerson.set(deal.contact_id, (wonByPerson.get(deal.contact_id) ?? 0) + Number(deal.value_minor));
  const names = new Map((await db.prepare(`SELECT u.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=?`).all(workspaceId) as Array<{ id: string; name: string }>).map((row) => [row.id, row.name]));
  const team = canSeeMoney(workspace?.role, workspace?.kind) ? [...owners.entries()].map(([userId, entry]) => ({
    userId, name: names.get(userId) ?? 'Unassigned', people: entry.people.size, conversations: entry.conversations,
    wonValue: [...entry.people].reduce((sum, id) => sum + (wonByPerson.get(id) ?? 0), 0),
  })).sort((a, b) => b.people - a.people) : [];

  const spend = money ? event.spend_minor : null;
  const stageOrder = ['new', 'contacted', 'replied', 'meeting', 'won', 'lost'];
  return {
    event: { ...event, spend_minor: spend },
    canManage: workspace?.kind === 'company' && workspace.role === 'admin', canSeeMoney: money,
    metrics: { people: people.length, companies: new Set(people.map((row) => row.company_id)).size, conversations: encounterRows.length, contactable: people.filter((row) => row.email || row.phone).length, meetings: Number(meetings.total) },
    quality: ['hot', 'warm', 'cold', 'unrated'].map((quality) => ({ quality, people: people.filter((row) => (row.quality ?? 'unrated') === quality).length })),
    stages: stageOrder.map((stage) => ({ stage, people: people.filter((row) => row.stage === stage).length })),
    deals: dealStages,
    emails: { drafted: Number(mail.drafted), approved: Number(mail.approved ?? 0), sent: Number(mail.sent ?? 0), replied: Number(mail.replied ?? 0) },
    daily: daily.slice(-60), team, products: productRows.map((row) => ({ name: row.name, people: Number(row.people) })),
    recent: people.slice(0, 8).map((row) => ({ id: row.contact_id, name: row.name, company: row.company_name, stage: row.stage, quality: row.quality, metAt: row.occurred_at })),
    cost: {
      spend, perPerson: spend !== null && people.length ? Math.round(spend / people.length) : null,
      perWonDeal: spend !== null && wonDeals.count ? Math.round(spend / wonDeals.count) : null,
      wonValuePerSpend: spend !== null && spend > 0 ? wonDeals.value / spend : null,
    },
  };
}
