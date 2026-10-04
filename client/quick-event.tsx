import { useState } from 'react';
import { CalendarPlus, Check } from 'lucide-react';
import { request } from './api.js';
import './quick-event.css';

const kinds = ['Expo', 'Exhibition', 'Conference', 'Trade show', 'Function', 'Meetup'];
const lengths = [{ label: '1 day', days: 0 }, { label: '2 days', days: 1 }, { label: '3 days', days: 2 }, { label: '1 week', days: 6 }];
const dayText = (date: Date) => date.toISOString().slice(0, 10);

type Props = { csrfToken: string; workspaceId: string; onCreated: (event: { id: string; name: string; is_active: number }) => void; notify: (message: string) => void };

/** Make an event in a few taps: pick a kind, a length, and go. The new event is used for the next captures. */
export function QuickEvent({ csrfToken, workspaceId, onCreated, notify }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [days, setDays] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function pickKind(kind: string) {
    if (!name.trim() || kinds.some((item) => name.startsWith(`${item} `))) setName(`${kind} ${new Date().toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`);
  }
  async function create() {
    const title = name.trim();
    if (!title) { setError('Give the event a name, or tap a kind above.'); return; }
    setSaving(true); setError('');
    try {
      const start = new Date(); const end = new Date(); end.setDate(end.getDate() + days);
      const payload = { name: title, startsAt: new Date(`${dayText(start)}T00:00:00.000Z`).toISOString(), endsAt: new Date(`${dayText(end)}T23:59:59.000Z`).toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', spendMinor: null, active: true };
      const created = await request<{ id: string }>('/api/events', { method: 'POST', body: JSON.stringify(payload) }, { csrfToken, workspaceId });
      onCreated({ id: created.id, name: title, is_active: 1 });
      window.dispatchEvent(new Event('gather:workspace-changed'));
      notify(`${title} is ready. New captures go to it.`);
      setOpen(false); setName(''); setDays(0);
    } catch (issue) { setError((issue as Error).message); }
    finally { setSaving(false); }
  }

  if (!open) return <button type="button" className="button secondary quick-event-open" onClick={() => setOpen(true)}><CalendarPlus size={16} aria-hidden="true" /> New event</button>;
  return <div className="quick-event" role="group" aria-label="Create an event">
    <div className="quick-event-chips" role="group" aria-label="Kind of event">{kinds.map((kind) => <button type="button" key={kind} className="chip" onClick={() => pickKind(kind)}>{kind}</button>)}</div>
    <label>Event name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} placeholder="For example, Pacific Packaging Expo" autoFocus /></label>
    <div className="quick-event-chips" role="group" aria-label="How long it runs">{lengths.map((item) => <button type="button" key={item.label} className="chip" aria-pressed={days === item.days} onClick={() => setDays(item.days)}>{item.label}</button>)}</div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="quick-event-actions"><button type="button" className="button primary" disabled={saving} onClick={() => void create()}><Check size={16} aria-hidden="true" /> {saving ? 'Creating…' : 'Create and use'}</button><button type="button" className="text-button" onClick={() => { setOpen(false); setError(''); }}>Cancel</button></div>
    <p className="subtle">Starts today. You can change dates, time zone or spend later in Settings.</p>
  </div>;
}
