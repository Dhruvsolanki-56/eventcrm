import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import './deals.css';
import { request } from './api.js';
import { askConfirm } from './confirm.js';
import { formatMoney } from './money.js';
import { Skeleton } from './skeletons.js';
import { useWorkspace } from './workspace-context.js';

export const pipelineStages = ['new', 'contacted', 'replied', 'meeting', 'won', 'lost'] as const;
export const stageLabel = (stage: string) => stage.charAt(0).toUpperCase() + stage.slice(1);

export type DealView = {
  id: string; title: string; value_minor: number | null; stage: string; lost_reason: string | null; version: number;
  contact_id: string; contact_name: string; company_id: string; company_name: string; quality: string | null;
  encounter_id: string | null; conversation_at: string | null; event_id: string | null; event_name: string | null;
  created_at: string; updated_at: string;
};
export type ConversationOption = { id: string; occurred_at: string; summary: string; event_name: string | null };

/** A deal made before names existed has none; it is shown by its company so a card is never blank. */
export const dealTitle = (deal: { title: string; company_name: string }) => deal.title.trim() || `Deal with ${deal.company_name}`;
const valueText = (minor: number | null) => minor === null ? 'No value yet' : formatMoney(minor);
const shortDay = (value: string) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
export const conversationLabel = (conversation: { event_name: string | null; occurred_at: string }) => `${conversation.event_name || 'Conversation'} · ${shortDay(conversation.occurred_at)}`;
const relativeDay = (value: string) => {
  const days = Math.round((Date.now() - new Date(value).getTime()) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return shortDay(value);
};

/** Rupees typed by a person, to paise. Empty means no value. */
function parseRupees(text: string): { ok: true; minor: number | null } | { ok: false } {
  if (!text.trim()) return { ok: true, minor: null };
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0 || amount > 9_000_000_000_000) return { ok: false };
  return { ok: true, minor: Math.round(amount * 100) };
}

function StageDot({ stage }: { stage: string }) { return <span className={`stage-dot ${stage}`} aria-hidden="true" />; }

function ConversationSelect({ id, options, value, onChange }: { id: string; options: ConversationOption[]; value: string; onChange: (value: string) => void }) {
  return <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
    <option value="">Not linked to a conversation</option>
    {options.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversationLabel(conversation)}{conversation.summary ? ` — ${conversation.summary.slice(0, 50)}` : ''}</option>)}
  </select>;
}

function useConversations(contactId: string, enabled: boolean) {
  const { session } = useWorkspace();
  const [options, setOptions] = useState<ConversationOption[]>([]);
  useEffect(() => {
    if (!enabled || !contactId) { setOptions([]); return; }
    let active = true;
    void request<{ conversations: ConversationOption[] }>(`/api/contacts/${contactId}/conversations`, {}, { workspaceId: session.workspace.id })
      .then((result) => { if (active) setOptions(result.conversations); }).catch(() => { if (active) setOptions([]); });
    return () => { active = false; };
  }, [contactId, enabled, session.workspace.id]);
  return options;
}

type DealDraft = { title: string; value: string; encounterId: string };
const emptyDraft: DealDraft = { title: '', value: '', encounterId: '' };

function DealFields({ idPrefix, draft, onChange, conversations, canSetValue }: { idPrefix: string; draft: DealDraft; onChange: (draft: DealDraft) => void; conversations: ConversationOption[]; canSetValue: boolean }) {
  return <>
    <label htmlFor={`${idPrefix}-title`}>Deal name<input id={`${idPrefix}-title`} value={draft.title} maxLength={120} onChange={(event) => onChange({ ...draft, title: event.target.value })} placeholder="For example: Recycled mailers, first order" /></label>
    {canSetValue && <label htmlFor={`${idPrefix}-value`}>Value (₹)<input id={`${idPrefix}-value`} type="number" inputMode="decimal" min="0" step="0.01" value={draft.value} onChange={(event) => onChange({ ...draft, value: event.target.value })} placeholder="Not set" /></label>}
    <label htmlFor={`${idPrefix}-conversation`}>Linked conversation <span className="optional-label">· optional</span><ConversationSelect id={`${idPrefix}-conversation`} options={conversations} value={draft.encounterId} onChange={(encounterId) => onChange({ ...draft, encounterId })} /></label>
  </>;
}

/** The deals of one person: each has its own stage and value, and may be linked to one of their conversations. */
export function DealsPanel({ contactId, deals, canSetValue, onChanged }: { contactId: string; deals: DealView[]; canSetValue: boolean; onChanged: () => void }) {
  const { session, csrfToken, notify } = useWorkspace();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [draft, setDraft] = useState<DealDraft>(emptyDraft);
  const [lostFor, setLostFor] = useState('');
  const [lostReason, setLostReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const requestId = useRef(crypto.randomUUID());
  const conversations = useConversations(contactId, adding || Boolean(editingId));
  const ctx = { csrfToken, workspaceId: session.workspace.id };

  function openAdd() { setAdding(true); setEditingId(''); setDraft(emptyDraft); setError(''); requestId.current = crypto.randomUUID(); }
  function openEdit(deal: DealView) {
    setEditingId(deal.id); setAdding(false); setError('');
    setDraft({ title: deal.title, value: deal.value_minor === null ? '' : String(deal.value_minor / 100), encounterId: deal.encounter_id ?? '' });
  }
  const change = (next: DealDraft) => { setDraft(next); requestId.current = crypto.randomUUID(); };

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = parseRupees(draft.value);
    if (!value.ok) { setError('Enter a value in rupees, ₹0 or more.'); return; }
    setBusy('new'); setError('');
    try {
      await request('/api/deals', { method: 'POST', body: JSON.stringify({ contactId, title: draft.title, valueMinor: value.minor, encounterId: draft.encounterId || null, clientDealId: requestId.current }) }, ctx);
      setAdding(false); notify('Deal added.'); onChanged();
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(''); }
  }
  async function save(event: FormEvent<HTMLFormElement>, deal: DealView) {
    event.preventDefault();
    const value = parseRupees(draft.value);
    if (!value.ok) { setError('Enter a value in rupees, ₹0 or more.'); return; }
    setBusy(deal.id); setError('');
    try {
      await request(`/api/deals/${deal.id}`, { method: 'PATCH', body: JSON.stringify({ version: deal.version, title: draft.title, ...(canSetValue ? { valueMinor: value.minor } : {}), encounterId: draft.encounterId || null }) }, ctx);
      setEditingId(''); notify('Deal saved.'); onChanged();
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(''); }
  }
  async function move(deal: DealView, stage: string, reason = '') {
    setBusy(deal.id); setError('');
    try {
      await request(`/api/deals/${deal.id}/stage`, { method: 'PATCH', body: JSON.stringify({ stage, version: deal.version, ...(stage === 'lost' ? { lostReason: reason } : {}) }) }, ctx);
      setLostFor(''); setLostReason(''); notify(`Deal moved to ${stageLabel(stage)}.`); onChanged();
    } catch (issue) { setError((issue as Error).message); onChanged(); }
    finally { setBusy(''); }
  }
  async function remove(deal: DealView) {
    if (!await askConfirm({ title: `Remove “${dealTitle(deal)}”?`, body: 'The person, their conversations and their other deals stay.', confirmLabel: 'Remove deal', danger: true })) return;
    setBusy(deal.id); setError('');
    try { await request(`/api/deals/${deal.id}`, { method: 'DELETE' }, ctx); notify('Deal removed.'); onChanged(); }
    catch (issue) { setError((issue as Error).message); }
    finally { setBusy(''); }
  }

  return <section id="person-deals" className="surface-card deals-panel" aria-labelledby="person-deals-title">
    <div className="section-head"><div><h2 id="person-deals-title">Deals</h2><p className="subtle">One person can have several. Each deal has its own stage and value.</p></div>
      {!adding && <button type="button" className="button secondary" onClick={openAdd}><Plus size={15} aria-hidden="true" /> Add deal</button>}</div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {adding && <form className="deal-edit-form" aria-label="New deal" onSubmit={(event) => void create(event)}>
      <DealFields idPrefix="new-deal" draft={draft} onChange={change} conversations={conversations} canSetValue={canSetValue} />
      <div className="deal-form-actions"><button type="button" className="button secondary" onClick={() => setAdding(false)}>Cancel</button><button className="button primary" disabled={busy === 'new'}>{busy === 'new' ? 'Saving…' : 'Add deal'}</button></div>
    </form>}
    {deals.length === 0 && !adding && <p className="task-group-empty">No deals yet. Add one when there is something to win.</p>}
    <ul className="deal-list">
      {deals.map((deal) => <li className="deal-row" key={deal.id}>
        {editingId === deal.id ? <form className="deal-edit-form" aria-label={`Edit ${dealTitle(deal)}`} onSubmit={(event) => void save(event, deal)}>
          <DealFields idPrefix={`deal-${deal.id}`} draft={draft} onChange={setDraft} conversations={conversations} canSetValue={canSetValue} />
          <div className="deal-form-actions"><button type="button" className="button secondary" onClick={() => setEditingId('')}>Cancel</button><button className="button primary" disabled={busy === deal.id}>{busy === deal.id ? 'Saving…' : 'Save deal'}</button></div>
        </form> : <>
          <div className="deal-row-main">
            <strong>{dealTitle(deal)}</strong>
            <span className="deal-row-meta"><span className="deal-value">{valueText(deal.value_minor)}</span><span>{deal.encounter_id ? `From ${conversationLabel({ event_name: deal.event_name, occurred_at: deal.conversation_at ?? deal.created_at })}` : 'No conversation linked'}</span></span>
            {deal.stage === 'lost' && deal.lost_reason && <span className="lost-reason-display">Lost because: {deal.lost_reason}</span>}
          </div>
          <div className="deal-row-actions">
            <label className="deal-stage-pick"><span className="sr-only">Stage of {dealTitle(deal)}</span><StageDot stage={deal.stage} />
              <select value={deal.stage} disabled={busy === deal.id} aria-label={`Stage of ${dealTitle(deal)}`} onChange={(event) => { if (event.target.value === 'lost') { setLostFor(deal.id); setLostReason(''); } else void move(deal, event.target.value); }}>
                {pipelineStages.map((stage) => <option key={stage} value={stage}>{stageLabel(stage)}</option>)}
              </select></label>
            <button type="button" className="text-button" onClick={() => openEdit(deal)}>Edit</button>
            <button type="button" className="text-button danger" disabled={busy === deal.id} onClick={() => void remove(deal)}>Remove</button>
          </div>
          {lostFor === deal.id && <div className="lost-reason-form">
            <label htmlFor={`lost-${deal.id}`}>Why was this deal lost?<textarea id={`lost-${deal.id}`} rows={2} maxLength={500} value={lostReason} onChange={(event) => setLostReason(event.target.value)} placeholder="A short reason" /></label>
            <button type="button" className="button primary" disabled={!lostReason.trim() || busy === deal.id} onClick={() => void move(deal, 'lost', lostReason)}>Save as lost</button>
            <button type="button" className="text-button" onClick={() => { setLostFor(''); setLostReason(''); }}>Cancel</button>
          </div>}
        </>}
      </li>)}
    </ul>
  </section>;
}

type StageSummary = Record<string, { count: number; value: number }>;
type DealsResponse = { deals: DealView[]; stages: StageSummary; total: number };
type PersonHit = { id: string; name: string; company_name: string };

/** Starting a deal from the pipeline: pick the person, then name it, value it, and link a conversation if there is one. */
function NewDealDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { session, csrfToken, notify } = useWorkspace();
  const canSetValue = session.workspace.kind !== 'company' || session.workspace.role === 'admin' || session.workspace.role === 'manager';
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PersonHit[]>([]);
  const [person, setPerson] = useState<PersonHit | null>(null);
  const [draft, setDraft] = useState<DealDraft>(emptyDraft);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const conversations = useConversations(person?.id ?? '', Boolean(person));
  useEffect(() => {
    if (person || query.trim().length < 1) { setHits([]); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      void request<{ people: PersonHit[] }>(`/api/contacts?${new URLSearchParams({ q: query.trim(), pageSize: '6' })}`, {}, { workspaceId: session.workspace.id })
        .then((result) => { if (active) setHits(result.people); }).catch(() => { if (active) setHits([]); });
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, person, session.workspace.id]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!person) return;
    const value = parseRupees(draft.value);
    if (!value.ok) { setError('Enter a value in rupees, ₹0 or more.'); return; }
    setSaving(true); setError('');
    try {
      await request('/api/deals', { method: 'POST', body: JSON.stringify({ contactId: person.id, title: draft.title, valueMinor: value.minor, encounterId: draft.encounterId || null, clientDealId: requestId.current }) }, { csrfToken, workspaceId: session.workspace.id });
      notify('Deal added.'); onCreated();
    } catch (issue) { setError((issue as Error).message); }
    finally { setSaving(false); }
  }
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="lost-dialog new-deal-dialog" role="dialog" aria-modal="true" aria-labelledby="new-deal-title" onSubmit={(event) => void submit(event)}>
      <h2 id="new-deal-title">New deal</h2>
      {!person ? <div className="deal-person-search">
        <label htmlFor="new-deal-person">Who is it with?<input id="new-deal-person" autoFocus autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, company or email" /></label>
        {hits.length > 0 && <ul className="deal-person-hits" aria-label="People found">{hits.map((hit) => <li key={hit.id}><button type="button" onClick={() => setPerson(hit)}><strong>{hit.name}</strong><small>{hit.company_name}</small></button></li>)}</ul>}
        {query.trim() && hits.length === 0 && <p className="subtle">No one matches yet.</p>}
      </div> : <>
        <p className="deal-person-chosen"><strong>{person.name}</strong><span>{person.company_name}</span><button type="button" className="text-button" onClick={() => { setPerson(null); setDraft(emptyDraft); }}>Change</button></p>
        <DealFields idPrefix="pipeline-new-deal" draft={draft} onChange={(next) => { setDraft(next); requestId.current = crypto.randomUUID(); }} conversations={conversations} canSetValue={canSetValue} />
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="lost-dialog-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={!person || saving}>{saving ? 'Saving…' : 'Add deal'}</button></div>
    </form>
  </div>;
}

/** The pipeline: every card is one deal. Moving a card moves that deal and nothing else about the person. */
export function PipelinePage() {
  const { session, csrfToken, notify } = useWorkspace();
  const [deals, setDeals] = useState<DealView[] | null>(null);
  const [filter, setFilter] = useState('');
  const [dragId, setDragId] = useState('');
  const [overStage, setOverStage] = useState('');
  const [movingId, setMovingId] = useState('');
  const [lostDraft, setLostDraft] = useState<{ deal: DealView; reason: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [phoneStage, setPhoneStage] = useState('new');
  // Each column loads its own most recent deals and can show more, so no stage is cut off by another stage's size.
  const [summary, setSummary] = useState<StageSummary>({});
  const [limits, setLimits] = useState<Record<string, number>>({});
  const limitsRef = useRef<Record<string, number>>({});
  const [loadingMore, setLoadingMore] = useState('');
  const boardStep = 40, boardMax = 200;
  const searchRef = useRef('');
  const fetchStage = useCallback((stage: string, limit: number) => request<DealsResponse>(`/api/deals?${new URLSearchParams({ stage, pageSize: String(limit), search: searchRef.current })}`, {}, { workspaceId: session.workspace.id }), [session.workspace.id]);
  const load = useCallback(async () => {
    const results = await Promise.all(pipelineStages.map((stage) => fetchStage(stage, limitsRef.current[stage] ?? boardStep)));
    setDeals(results.flatMap((result) => result.deals));
    setSummary(results[0]?.stages ?? {});
  }, [fetchStage]);
  useEffect(() => { limitsRef.current = limits; }, [limits]);
  // Searching asks the server, so a deal beyond the first screenful of its column can still be found.
  useEffect(() => {
    searchRef.current = filter.trim();
    const timer = window.setTimeout(() => { void load().catch((issue) => { setDeals((current) => current ?? []); notify((issue as Error).message); }); }, filter ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, notify, filter]);
  async function showMore(stage: string) {
    const next = Math.min(boardMax, (limits[stage] ?? boardStep) + boardStep);
    setLoadingMore(stage);
    try {
      const result = await fetchStage(stage, next);
      limitsRef.current = { ...limitsRef.current, [stage]: next };
      setLimits((current) => ({ ...current, [stage]: next }));
      setDeals((current) => [...(current ?? []).filter((deal) => deal.stage !== stage), ...result.deals]);
      setSummary(result.stages);
    } catch (issue) { notify((issue as Error).message); }
    finally { setLoadingMore(''); }
  }
  const countFor = (stage: string) => summary[stage]?.count ?? 0;
  const active = pipelineStages.filter((stage) => stage !== 'won' && stage !== 'lost').reduce((sum, stage) => sum + countFor(stage), 0);
  const openValue = pipelineStages.filter((stage) => stage !== 'won' && stage !== 'lost').reduce((sum, stage) => sum + (summary[stage]?.value ?? 0), 0);

  async function move(deal: DealView, stage: string, reason = '') {
    if (deal.stage === stage) return;
    setMovingId(deal.id);
    setDeals((current) => current?.map((item) => item.id === deal.id ? { ...item, stage } : item) ?? current);
    setSummary((current) => ({ ...current,
      [deal.stage]: { count: Math.max(0, (current[deal.stage]?.count ?? 1) - 1), value: Math.max(0, (current[deal.stage]?.value ?? 0) - (deal.value_minor ?? 0)) },
      [stage]: { count: (current[stage]?.count ?? 0) + 1, value: (current[stage]?.value ?? 0) + (deal.value_minor ?? 0) } }));
    try {
      const result = await request<{ version: number }>(`/api/deals/${deal.id}/stage`, { method: 'PATCH', body: JSON.stringify({ stage, version: deal.version, ...(stage === 'lost' ? { lostReason: reason } : {}) }) }, { csrfToken, workspaceId: session.workspace.id });
      setDeals((current) => current?.map((item) => item.id === deal.id ? { ...item, stage, version: result.version } : item) ?? current);
      notify(`${dealTitle(deal)} moved to ${stageLabel(stage)}.`);
    } catch (issue) {
      notify((issue as Error).message);
      await load().catch(() => undefined);
    } finally { setMovingId(''); }
  }
  const ask = (deal: DealView, stage: string) => { if (stage === 'lost') setLostDraft({ deal, reason: '' }); else void move(deal, stage); };
  function drop(stage: string) {
    const deal = deals?.find((item) => item.id === dragId);
    setDragId(''); setOverStage('');
    if (deal && deal.stage !== stage) ask(deal, stage);
  }

  return <section className="records-view pipeline-view">
    <div className="page-heading-row"><div><h1>Pipeline</h1>
      <p className="page-lede">{deals ? `${active} open ${active === 1 ? 'deal' : 'deals'}${openValue ? ` · ${formatMoney(openValue)} open` : ''} · ${countFor('won')} won · ${countFor('lost')} lost` : 'Loading…'}</p></div>
      <div className="pipeline-actions">
        <label className="search-box pipeline-search"><Search size={18} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter by deal, person or company" aria-label="Filter by deal, person or company" /></label>
        <button type="button" className="button primary" onClick={() => setAdding(true)}><Plus size={16} aria-hidden="true" /> New deal</button>
      </div></div>
    <p className="pipeline-explainer" role="note"><strong>Each card is one deal</strong> with one person. A person can have several deals, each with its own value and stage, and moving a card moves only that deal.</p>
    {deals && <div className="pipeline-stage-switch" role="group" aria-label="Show one stage">{pipelineStages.map((stage) => <button type="button" key={stage} aria-pressed={phoneStage === stage} onClick={() => setPhoneStage(stage)}>{stageLabel(stage)}<span>{countFor(stage)}</span></button>)}</div>}
    {!deals ? <Skeleton variant="board" label="Loading pipeline" /> : <div className={`pipeline-grid${dragId ? ' is-dragging' : ''}`}>{pipelineStages.map((stage) => {
      const column = deals.filter((deal) => deal.stage === stage);
      const columnValue = summary[stage]?.value ?? 0;
      return <section className={`pipeline-column${overStage === stage ? ' is-over' : ''}${phoneStage === stage ? ' is-shown' : ''}`} key={stage} aria-label={`${stageLabel(stage)}, ${countFor(stage)} ${countFor(stage) === 1 ? 'deal' : 'deals'}`}
        onDragOver={(event) => { if (!dragId) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; if (overStage !== stage) setOverStage(stage); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOverStage(''); }}
        onDrop={(event) => { event.preventDefault(); drop(stage); }}>
        <div className="pipeline-column-head"><h2>{stageLabel(stage)}</h2><span className="pipeline-count">{countFor(stage)}</span></div>
        {columnValue > 0 && <p className="pipeline-column-value">{formatMoney(columnValue)}</p>}
        <div className="pipeline-cards">{column.map((deal) => <div className="pipeline-item" key={deal.id}>
          <Link className={`pipeline-person${dragId === deal.id ? ' is-dragged' : ''}${movingId === deal.id ? ' is-moving' : ''}`} to={`/people/${deal.contact_id}`} draggable
            onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', deal.id); setDragId(deal.id); }}
            onDragEnd={() => { setDragId(''); setOverStage(''); }}>
            <strong>{dealTitle(deal)}</strong>
            <small>{deal.contact_name} · {deal.company_name}</small>
            <span className="pipeline-deal-value">{valueText(deal.value_minor)}</span>
            <span className="pipeline-person-meta"><span className="pipeline-conversation">{deal.encounter_id ? conversationLabel({ event_name: deal.event_name, occurred_at: deal.conversation_at ?? deal.created_at }) : 'No conversation linked'}</span><span>{relativeDay(deal.updated_at)}</span></span>
          </Link>
          <label className="pipeline-move"><span>Move to</span><select value={deal.stage} disabled={movingId === deal.id} aria-label={`Move ${dealTitle(deal)} to`} onChange={(event) => ask(deal, event.target.value)}>{pipelineStages.map((option) => <option key={option} value={option}>{stageLabel(option)}</option>)}</select></label>
        </div>)}
        {!column.length && <p className="pipeline-empty">{dragId ? 'Drop here' : filter.trim() ? 'No match' : 'No deals yet'}</p>}
        {column.length < countFor(stage) && ((limits[stage] ?? boardStep) < boardMax
          ? <button type="button" className="pipeline-more" disabled={loadingMore === stage} onClick={() => void showMore(stage)}>{loadingMore === stage ? 'Loading…' : `Show more (${countFor(stage) - column.length} more)`}</button>
          : <p className="pipeline-empty" role="note">Showing the {column.length} most recent of {countFor(stage)}. Search to find the rest.</p>)}</div>
      </section>;
    })}</div>}
    <p className="pipeline-footnote"><span className="on-wide">Drag a card to change that deal’s stage, or open the person to manage all of their deals.</span><span className="on-phone">Pick a stage above to see its deals. Use Move to on a card to change that deal’s stage.</span> Deal values are set by an admin or manager.</p>
    {lostDraft && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setLostDraft(null); }}>
      <form className="lost-dialog" role="dialog" aria-modal="true" aria-labelledby="lost-dialog-title" onSubmit={(event) => { event.preventDefault(); const draft = lostDraft; setLostDraft(null); void move(draft.deal, 'lost', draft.reason.trim()); }}>
        <h2 id="lost-dialog-title">Mark {dealTitle(lostDraft.deal)} as lost</h2>
        <label>Why was this lost?<textarea rows={3} maxLength={500} autoFocus value={lostDraft.reason} onChange={(event) => setLostDraft({ ...lostDraft, reason: event.target.value })} placeholder="A short reason, for example: budget moved to next year" /></label>
        <div className="lost-dialog-actions"><button type="button" className="button secondary" onClick={() => setLostDraft(null)}>Cancel</button><button className="button primary" disabled={!lostDraft.reason.trim()}>Save as lost</button></div>
      </form>
    </div>}
    {adding && <NewDealDialog onClose={() => setAdding(false)} onCreated={() => { setAdding(false); void load().catch(() => undefined); }} />}
  </section>;
}

