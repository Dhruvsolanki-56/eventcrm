import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, CalendarDays, Pencil, Plus } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import './events.css';
import { request } from './api.js';
import { formatMoney } from './money.js';
import { Skeleton } from './skeletons.js';
import { useWorkspace } from './workspace-context.js';

type EventSummary = {
  id: string; name: string; starts_at: string; ends_at: string; time_zone: string; is_active: number; spend_minor: number | null;
  people: number; conversations: number;
  deals: { open: number; won: number; lost: number; openValue: number; wonValue: number };
  emails: { drafted: number; sent: number; replied: number };
};
type EventsResponse = { events: EventSummary[]; canManage: boolean; canSeeMoney: boolean };
type EventDetail = {
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

const shortDate = (value: string) => new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const percent = (value: number) => new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(value);

type EditorState = { id?: string; name: string; startDate: string; endDate: string; timeZone: string; spend: string; active: boolean };
function editorFor(event: EventSummary | EventDetail['event']): EditorState {
  return { id: event.id, name: event.name, startDate: event.starts_at.slice(0, 10), endDate: event.ends_at.slice(0, 10), timeZone: event.time_zone, spend: event.spend_minor === null ? '' : (event.spend_minor / 100).toFixed(2), active: Boolean(event.is_active) };
}

/** Create or change an event. Only a company admin can; the server checks too. */
function EventForm({ initial, canSeeMoney, onSaved, onClose }: { initial: EditorState | null; canSeeMoney: boolean; onSaved: (id: string) => void; onClose: () => void }) {
  const { session, csrfToken, notify } = useWorkspace();
  const [draft, setDraft] = useState<EditorState>(() => initial ?? { name: '', startDate: new Date().toISOString().slice(0, 10), endDate: new Date().toISOString().slice(0, 10), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', spend: '', active: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true); setError('');
    try {
      const startsAt = new Date(`${draft.startDate}T00:00:00.000Z`).toISOString();
      const endsAt = new Date(`${draft.endDate}T23:59:59.000Z`).toISOString();
      const spendMinor = draft.spend.trim() ? Math.round(Number(draft.spend) * 100) : null;
      if (draft.spend.trim() && (!Number.isFinite(spendMinor) || spendMinor! < 0)) throw new Error('Enter a valid event spend.');
      const payload = { name: draft.name, startsAt, endsAt, timeZone: draft.timeZone, spendMinor, active: draft.active };
      const result = draft.id
        ? await request<{ id: string }>(`/api/events/${draft.id}`, { method: 'PUT', body: JSON.stringify(payload) }, { csrfToken, workspaceId: session.workspace.id })
        : await request<{ id: string }>('/api/events', { method: 'POST', body: JSON.stringify(payload) }, { csrfToken, workspaceId: session.workspace.id });
      window.dispatchEvent(new Event('gather:workspace-changed'));
      notify('Event details saved.');
      onSaved(result.id);
    } catch (issue) { setError((issue as Error).message); }
    finally { setSaving(false); }
  }
  return <form className="event-edit-form event-form-card" onSubmit={(event) => void submit(event)} aria-label={draft.id ? `Edit ${draft.name}` : 'New event'}>
    <div className="field-grid"><label>Event name<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} maxLength={160} required autoFocus={!draft.id} /></label><label>Time zone<input value={draft.timeZone} onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })} maxLength={80} placeholder="America/Los_Angeles" required /><small>Use a time zone name such as America/Los_Angeles.</small></label></div>
    <div className="field-grid three"><label>Starts<input type="date" value={draft.startDate} onChange={(event) => setDraft({ ...draft, startDate: event.target.value })} required /></label><label>Ends<input type="date" value={draft.endDate} onChange={(event) => setDraft({ ...draft, endDate: event.target.value })} required /></label>
      {canSeeMoney && <label>Event spend (₹)<input type="number" min="0" step="0.01" value={draft.spend} onChange={(event) => setDraft({ ...draft, spend: event.target.value })} placeholder="Not set" /></label>}</div>
    <label className="active-event-toggle"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /> Make this the active event</label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="event-form-footer"><button type="button" className="button secondary" onClick={onClose}>Close</button><button className="button primary" disabled={saving}>{saving ? 'Saving…' : draft.id ? 'Save event' : 'Add event'}</button></div>
  </form>;
}

function Stat({ name, value, note }: { name: string; value: string; note?: string }) {
  return <div className="event-stat"><span>{name}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
}

export function EventsPage() {
  const { session } = useWorkspace();
  const navigate = useNavigate();
  const [data, setData] = useState<EventsResponse | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => { setData(await request<EventsResponse>('/api/events', {}, { workspaceId: session.workspace.id })); }, [session.workspace.id]);
  useEffect(() => { void load().catch((issue) => setError((issue as Error).message)); }, [load]);
  return <section className="records-view events-view">
    <div className="page-heading-row"><div><h1>Events</h1><p className="page-lede">Where you meet people, what came of it, and what it cost. The active event is used for new captures.</p></div>
      {data?.canManage && !adding && <button type="button" className="button primary" onClick={() => setAdding(true)}><Plus size={16} aria-hidden="true" /> Add event</button>}</div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {adding && data && <EventForm initial={null} canSeeMoney={data.canSeeMoney} onClose={() => setAdding(false)} onSaved={(id) => { setAdding(false); navigate(`/events/${id}`); }} />}
    {!data ? (error ? null : <Skeleton variant="table" label="Loading events" rows={4} />) : data.events.length === 0 && !adding
      ? <div className="surface-card records-empty"><CalendarDays size={22} aria-hidden="true" /><p>No events yet.{data.canManage ? ' Add the event you are attending.' : ' An admin adds the events you can capture at.'}</p></div>
      : <div className="event-card-list">{data.events.map((event) => <Link className="surface-card event-card" key={event.id} to={`/events/${event.id}`}>
        <div className="event-card-head"><div><strong>{event.name}</strong>{event.is_active ? <span className="active-event-label">Active</span> : null}</div>
          <span className="event-card-dates">{shortDate(event.starts_at)} – {shortDate(event.ends_at)} · {event.time_zone}</span></div>
        <dl className="event-card-stats">
          <div><dt>People met</dt><dd>{event.people}</dd></div>
          <div><dt>Conversations</dt><dd>{event.conversations}</dd></div>
          <div><dt>Open deals</dt><dd>{event.deals.open}{event.deals.openValue > 0 && <small>{formatMoney(event.deals.openValue)}</small>}</dd></div>
          <div><dt>Won</dt><dd>{event.deals.won}{event.deals.wonValue > 0 && <small>{formatMoney(event.deals.wonValue)}</small>}</dd></div>
          <div><dt>Emails sent</dt><dd>{event.emails.sent}<small>{event.emails.replied} replied</small></dd></div>
          {data.canSeeMoney && <div><dt>Spend</dt><dd>{event.spend_minor === null ? '—' : formatMoney(event.spend_minor)}{event.spend_minor !== null && event.people > 0 && <small>{formatMoney(Math.round(event.spend_minor / event.people))} a person</small>}</dd></div>}
        </dl>
        <span className="event-card-open">Open <ArrowRight size={14} aria-hidden="true" /></span>
      </Link>)}</div>}
  </section>;
}

function Bars({ rows, format }: { rows: Array<{ key: string; name: string; value: number; note?: string }>; format?: (value: number) => string }) {
  const top = Math.max(1, ...rows.map((row) => row.value));
  return <ul className="event-bars">{rows.map((row) => <li key={row.key}>
    <span className="event-bar-name">{row.name}</span>
    <span className="event-bar-track"><span className={`event-bar-fill ${row.key}`} style={{ width: `${Math.round((row.value / top) * 100)}%` }} /></span>
    <span className="event-bar-value">{format ? format(row.value) : row.value}{row.note && <small>{row.note}</small>}</span>
  </li>)}</ul>;
}

export function EventDetailPage() {
  const { eventId = '' } = useParams();
  const { session } = useWorkspace();
  const [data, setData] = useState<EventDetail | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const load = useCallback(async () => { setData(await request<EventDetail>(`/api/events/${eventId}`, {}, { workspaceId: session.workspace.id })); }, [eventId, session.workspace.id]);
  useEffect(() => { setData(null); setError(''); void load().catch((issue) => setError((issue as Error).message)); }, [load]);
  if (!data) return error ? <section className="surface-card skeleton-block">{error}<p><Link className="subtle-link" to="/events">Back to Events</Link></p></section> : <Skeleton variant="detail" label="Loading event" />;
  const { event, metrics, cost } = data;
  const openDeals = data.deals.filter((row) => row.stage !== 'won' && row.stage !== 'lost');
  const open = { count: openDeals.reduce((sum, row) => sum + row.count, 0), value: openDeals.reduce((sum, row) => sum + row.value, 0) };
  const won = data.deals.find((row) => row.stage === 'won')!;
  const lost = data.deals.find((row) => row.stage === 'lost')!;
  const emailRows = [
    { key: 'drafted', name: 'Drafts prepared', value: data.emails.drafted }, { key: 'approved', name: 'Approved', value: data.emails.approved },
    { key: 'sent', name: 'Sent', value: data.emails.sent }, { key: 'replied', name: 'Replied', value: data.emails.replied },
  ];
  return <section className="records-view event-detail">
    <div className="page-heading-row"><div><Link className="back-link" to="/events">← Events</Link><h1>{event.name}{event.is_active ? <span className="active-event-label">Active</span> : null}</h1>
      <p className="page-lede">{shortDate(event.starts_at)} – {shortDate(event.ends_at)} · {event.time_zone}</p></div>
      {data.canManage && !editing && <button type="button" className="button secondary" onClick={() => setEditing(true)}><Pencil size={15} aria-hidden="true" /> Edit event</button>}</div>
    {editing && <EventForm initial={editorFor(event)} canSeeMoney={data.canSeeMoney} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void load(); }} />}

    <div className="event-stats" aria-label="Event totals">
      <Stat name="People met" value={String(metrics.people)} note={`${metrics.companies} ${metrics.companies === 1 ? 'company' : 'companies'}`} />
      <Stat name="Conversations" value={String(metrics.conversations)} note={`${metrics.contactable} can be contacted`} />
      <Stat name="Meetings" value={String(metrics.meetings)} note="Confirmed or held" />
      <Stat name="Open deals" value={String(open.count)} note={open.value > 0 ? formatMoney(open.value) : 'No value yet'} />
      <Stat name="Won deals" value={String(won.count)} note={won.value > 0 ? formatMoney(won.value) : `${lost.count} lost`} />
      {data.canSeeMoney && <Stat name="Spend" value={cost.spend === null ? '—' : formatMoney(cost.spend)} note={cost.perPerson !== null ? `${formatMoney(cost.perPerson)} a person` : 'Add the spend to see cost per person'} />}
      {data.canSeeMoney && <Stat name="Won value ÷ spend" value={cost.wonValuePerSpend === null ? '—' : percent(cost.wonValuePerSpend)} note={cost.perWonDeal !== null ? `${formatMoney(cost.perWonDeal)} per won deal` : 'Not event attribution or net ROI'} />}
    </div>

    <div className="event-grid">
      <article className="insight-panel event-panel event-wide"><div className="insight-heading"><div><h2>Captures by day</h2><p>People met and conversations each day, in the event’s time zone</p></div></div>
        <div className="analytics-chart" role="img" aria-label={`Daily captures for ${event.name}. ${metrics.people} people and ${metrics.conversations} conversations in total.`}>
          <ResponsiveContainer width="100%" height="100%"><AreaChart data={data.daily} margin={{ top: 12, right: 8, left: -24, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#e9ece9" strokeDasharray="3 4" />
            <XAxis dataKey="day" axisLine={false} tickLine={false} minTickGap={32} tick={{ fill: '#6b726d', fontSize: 11 }} tickFormatter={(day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} />
            <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fill: '#6b726d', fontSize: 11 }} />
            <Tooltip contentStyle={{ border: '1px solid #dfe5df', borderRadius: 8, fontSize: 12 }} />
            <Area type="linear" dataKey="people" name="People met" stroke="#447767" strokeWidth={2.2} fill="#eaf1ec" fillOpacity={1} />
            <Area type="linear" dataKey="conversations" name="Conversations" stroke="#9eb7aa" strokeWidth={1.6} fill="none" />
          </AreaChart></ResponsiveContainer>
        </div></article>

      <article className="insight-panel event-panel"><div className="insight-heading"><div><h2>Deals by stage</h2><p>Each deal counts once</p></div></div>
        <Bars rows={data.deals.map((row) => ({ key: row.stage, name: label(row.stage), value: row.count, note: row.value > 0 ? formatMoney(row.value) : undefined }))} /></article>
      <article className="insight-panel event-panel"><div className="insight-heading"><div><h2>Where people are now</h2><p>The furthest stage reached by each person</p></div></div>
        <Bars rows={data.stages.map((row) => ({ key: row.stage, name: label(row.stage), value: row.people }))} /></article>
      <article className="insight-panel event-panel"><div className="insight-heading"><div><h2>Lead quality</h2><p>From the ratings your team saved</p></div></div>
        <Bars rows={data.quality.map((row) => ({ key: row.quality, name: label(row.quality), value: row.people }))} /></article>
      <article className="insight-panel event-panel"><div className="insight-heading"><div><h2>Email follow-up</h2><p>Emails about conversations at this event</p></div></div>
        <Bars rows={emailRows} /></article>

      {data.team.length > 0 && <article className="insight-panel event-panel event-wide"><div className="insight-heading"><div><h2>By team member</h2><p>People are credited to their owner</p></div></div>
        <div className="analytics-table-wrap"><table className="analytics-table"><thead><tr><th>Team member</th><th>People</th><th>Conversations</th><th>Won value</th></tr></thead><tbody>
          {data.team.map((member) => <tr key={member.userId}><td>{member.name}</td><td>{member.people}</td><td>{member.conversations}</td><td>{member.wonValue > 0 ? formatMoney(member.wonValue) : '—'}</td></tr>)}
        </tbody></table></div></article>}

      {data.products.length > 0 && <article className="insight-panel event-panel"><div className="insight-heading"><div><h2>Products people asked about</h2><p>People interested in each</p></div></div>
        <Bars rows={data.products.map((row, index) => ({ key: `p${index % 4}`, name: row.name, value: row.people }))} /></article>}

      <article className="insight-panel event-panel event-wide"><div className="insight-heading"><div><h2>Recently met</h2><p>The latest people captured here</p></div><Link to={`/people`} className="subtle-link">All people <ArrowRight size={14} aria-hidden="true" /></Link></div>
        <div className="analytics-table-wrap"><table className="analytics-table"><thead><tr><th>Person</th><th>Company</th><th>Stage</th><th>Met</th></tr></thead><tbody>
          {data.recent.map((person) => <tr key={person.id}><td><Link to={`/people/${person.id}`}>{person.name}</Link></td><td>{person.company}</td><td>{label(person.stage)}</td><td>{shortDate(person.metAt)}</td></tr>)}
          {!data.recent.length && <tr><td colSpan={4} className="analytics-empty">Nobody has been captured at this event yet.</td></tr>}
        </tbody></table></div></article>
    </div>
    <p className="analytics-footnote">A deal counts toward the event of the conversation it is linked to. A deal with no linked conversation counts toward the event where the person was first met. {data.canSeeMoney ? 'Won value ÷ spend is a simple ratio, not event attribution or net ROI.' : ''}</p>
  </section>;
}
