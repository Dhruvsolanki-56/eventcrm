import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, RefreshCw, Search } from 'lucide-react';
import { request } from './api.js';
import { useWorkspace } from './workspace-context.js';
import './email-desk.css';

type Draft = { id: string; contact_id: string; recipient: string; subject: string; body: string; status: string; created_at: string; approved_at: string | null; sent_to_server_at: string | null; sources_json: string; person_name: string; company_name: string; event_name: string | null; summary: string; open_question: string; promised_next_step: string; changed_since_last: string };
type Person = { id: string; name: string; company_name: string; email: string; encounters: number; hasContext: boolean };
type Desk = { drafts: Draft[]; people: Person[] };
const empty: Desk = { drafts: [], people: [] };

function DraftContext({ draft }: { draft: Draft }) {
  let sources: Array<{ label: string; excerpt: string }> = [];
  try { const parsed: unknown = JSON.parse(draft.sources_json); if (Array.isArray(parsed)) sources = parsed.filter((item) => item && typeof item.label === 'string' && typeof item.excerpt === 'string'); } catch { /* Older drafts may have no saved source snapshot. */ }
  return <div className="email-desk-context"><strong>{sources.length ? 'Sources when draft was prepared' : 'Current conversation context'}</strong>{sources.length ? <>{sources.map((source, index) => <p key={`${index}-${source.label}`}><span>{source.label}</span>{source.excerpt}</p>)}<small>Later corrections do not rewrite this draft. Check the message against the person record.</small></> : <>{draft.event_name && <p><span>Event</span>{draft.event_name}</p>}{draft.summary && <p><span>Checked summary</span>{draft.summary}</p>}{draft.open_question && <p><span>Open question</span>{draft.open_question}</p>}{draft.promised_next_step && <p><span>Agreed next step</span>{draft.promised_next_step}</p>}{draft.changed_since_last && <p><span>What changed</span>{draft.changed_since_last}</p>}<small>This older draft has no saved source snapshot. These facts may have changed since it was written.</small></>}</div>;
}

export default function EmailDeskPage() {
  const { session, csrfToken, notify } = useWorkspace();
  const [desk, setDesk] = useState<Desk>(empty);
  const [selectedId, setSelectedId] = useState('');
  const [filter, setFilter] = useState<'draft' | 'reviewed' | 'people'>('draft');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [edit, setEdit] = useState({ subject: '', body: '' });
  const [savedEdit, setSavedEdit] = useState({ subject: '', body: '' });
  const load = async () => {
    setLoading(true); setError('');
    try { setDesk(await request<Desk>('/api/email-desk', {}, { workspaceId: session.workspace.id })); }
    catch (issue) { setError((issue as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [session.workspace.id]);
  const selected = desk.drafts.find((draft) => draft.id === selectedId) ?? null;
  useEffect(() => { if (selected) { setEdit({ subject: selected.subject, body: selected.body }); setSavedEdit({ subject: selected.subject, body: selected.body }); } }, [selected?.id]);
  const visibleDrafts = useMemo(() => desk.drafts.filter((draft) => (filter === 'draft' ? draft.status === 'draft' : draft.status !== 'draft') && `${draft.person_name} ${draft.company_name} ${draft.subject}`.toLowerCase().includes(search.toLowerCase())), [desk.drafts, filter, search]);
  const visiblePeople = useMemo(() => desk.people.filter((person) => `${person.name} ${person.company_name}`.toLowerCase().includes(search.toLowerCase())), [desk.people, search]);
  async function saveDraft() {
    if (!selected || !edit.subject.trim() || !edit.body.trim()) return;
    setBusy(true);
    try {
      await request(`/api/emails/${selected.id}`, { method: 'PUT', body: JSON.stringify(edit) }, { csrfToken, workspaceId: session.workspace.id });
      setSavedEdit(edit); setDesk((current) => ({ ...current, drafts: current.drafts.map((draft) => draft.id === selected.id ? { ...draft, ...edit } : draft) }));
      notify('Draft saved. Nothing was sent.');
    } catch (issue) { setError((issue as Error).message); } finally { setBusy(false); }
  }
  async function prepare(person: Person) {
    setBusy(true); setError('');
    try {
      const draft = await request<{ id: string }>(`/api/contacts/${person.id}/email-draft`, { method: 'POST' }, { csrfToken, workspaceId: session.workspace.id });
      await load(); setSelectedId(draft.id); setFilter('draft'); notify(`Draft prepared for ${person.name}. Review it before any send.`);
    } catch (issue) { setError((issue as Error).message); } finally { setBusy(false); }
  }
  const dirty = selected?.status === 'draft' && (edit.subject !== savedEdit.subject || edit.body !== savedEdit.body);
  return <section className="email-desk"><div className="page-heading-row"><div><p className="eyebrow">WORKSPACE / EMAIL</p><h1>Email Desk</h1><p className="page-lede">Prepare, check and save personal drafts across this workspace. Nothing sends on its own.</p></div><button className="button secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={16} /> Refresh</button></div>
    <div className="email-desk-toolbar"><div className="email-desk-tabs" role="group" aria-label="Email queue"><button aria-pressed={filter === 'draft'} onClick={() => { setFilter('draft'); setSelectedId(''); }}>Drafts <span>{desk.drafts.filter((draft) => draft.status === 'draft').length}</span></button><button aria-pressed={filter === 'reviewed'} onClick={() => { setFilter('reviewed'); setSelectedId(''); }}>Approved &amp; outbox <span>{desk.drafts.filter((draft) => draft.status !== 'draft').length}</span></button><button aria-pressed={filter === 'people'} onClick={() => { setFilter('people'); setSelectedId(''); }}>Prepare next <span>{desk.people.length}</span></button></div><label className="email-desk-search"><Search size={17} /><span className="sr-only">Search email queue</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a person or company" /></label></div>
    {error && <p className="form-error" role="alert">{error}</p>}{loading && <p role="status" className="subtle">Updating email queue…</p>}
    <div className="email-desk-layout"><div className="email-desk-list" aria-label="Email queue">{filter === 'people' ? visiblePeople.map((person) => <article className="email-desk-row" key={person.id}><div><strong>{person.name}</strong><small>{person.company_name} · {person.hasContext ? `${person.encounters} saved conversations` : 'Needs conversation context'}</small></div>{person.hasContext ? <button className="button secondary" disabled={busy} onClick={() => void prepare(person)}>Prepare draft</button> : <Link className="button secondary" to={`/people/${person.id}?newConversation=1`}>Add context</Link>}</article>) : visibleDrafts.map((draft) => <button className={`email-desk-row ${selectedId === draft.id ? 'is-selected' : ''}`} data-draft-id={draft.id} type="button" key={draft.id} onClick={() => { if (dirty && !window.confirm('Leave this unsaved draft?')) return; setSelectedId(draft.id); }}><span><strong>{draft.person_name}</strong><small>{draft.company_name}{draft.event_name ? ` · ${draft.event_name}` : ''}</small><em>{draft.subject}</em></span><span className="email-desk-status">{draft.status === 'sent' ? 'Mail server accepted' : draft.status}</span></button>)}{!loading && (filter === 'people' ? visiblePeople : visibleDrafts).length === 0 && <div className="email-desk-empty"><Mail size={24} /><strong>{filter === 'draft' ? 'No drafts waiting for review' : filter === 'people' ? 'No people ready for a draft' : 'No approved emails yet'}</strong><p>{filter === 'people' ? 'Save a person with an email address, then prepare their draft here.' : 'Use Prepare next to start with a saved conversation.'}</p></div>}</div>
      <aside className="email-desk-preview">{selected && filter !== 'people' ? <><div className="email-desk-preview-head"><p className="eyebrow">{selected.status === 'draft' ? 'REVIEW DRAFT' : 'EMAIL RECORD'}</p><h2>{selected.person_name}</h2><p>{selected.company_name} · {selected.recipient}</p><Link to={`/people/${selected.contact_id}`} className="subtle-link">Open person record →</Link></div><DraftContext draft={selected} /><div className="email-desk-editor"><label>Subject<input maxLength={200} value={edit.subject} disabled={selected.status !== 'draft'} onChange={(event) => setEdit({ ...edit, subject: event.target.value })} /></label><label>Message<textarea rows={14} maxLength={8000} value={edit.body} disabled={selected.status !== 'draft'} onChange={(event) => setEdit({ ...edit, body: event.target.value })} /></label>{selected.status === 'draft' ? <div className="email-desk-editor-footer"><span>{dirty ? 'Unsaved edits' : 'Saved draft · not sent'}</span><button className="button primary" disabled={busy || !dirty || !edit.subject.trim() || !edit.body.trim()} onClick={() => void saveDraft()}>{busy ? 'Saving…' : 'Save draft'}</button></div> : <p className="subtle">{selected.sent_to_server_at ? 'Mail server accepted this message; inbox delivery is not confirmed.' : selected.status === 'outbox' ? 'Approved for outbox. No mail server sent this message.' : `Status: ${selected.status}.`}</p>}</div></> : <div className="email-desk-placeholder"><Mail size={26} /><h2>Keep the context beside the message.</h2><p>Select a draft to check the conversation facts and wording before saving. For a new person, choose Prepare next.</p></div>}</aside></div>
  </section>;
}
