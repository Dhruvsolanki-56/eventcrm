import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import './campaigns.css';
import { request } from './api.js';
import { askConfirm } from './confirm.js';
import { stageLabel } from './deals.js';
import { Skeleton } from './skeletons.js';
import { useWorkspace } from './workspace-context.js';
import { describeMoment } from '../shared/send-schedule.js';

type Counts = { draft: number; queued: number; sent: number; replied: number; failed: number; outbox: number; scheduled: number };
type CampaignSummary = { id: string; name: string; status: string; send_at: string | null; recipient_count: number; created_at: string; counts: Counts };
type Preview = { matched: number; capped: boolean; limit: number; eligible: number; excluded: { noEmail: number; optedOut: number; recentlyEmailed: number; recentDays: number }; sample: Array<{ id: string; name: string; company: string }> };
type Audience = { eventId?: string; stages?: string[]; quality?: string[] };
type Detail = {
  campaign: { id: string; name: string; status: string; subject_template: string; body_template: string; send_at: string | null; recipient_count: number; audience: Audience };
  counts: Counts;
  recipients: Array<{ id: string; person_name: string; company_name: string; recipient: string; subject: string; status: string; send_at: string | null }>;
};

const stages = ['new', 'contacted', 'replied', 'meeting', 'won', 'lost'];
const qualities = ['hot', 'warm', 'cold'];
const mergeHint = 'Placeholders: {{firstName}}, {{name}}, {{company}}, {{event}}';
const statusText = (status: string) => status === 'sent' ? 'Mail server accepted' : status === 'outbox' ? 'In outbox' : status === 'queued' ? 'Waiting to send' : status === 'draft' ? 'Draft' : status;

export function CampaignsPage() {
  const { session, csrfToken, notify } = useWorkspace();
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void request<{ campaigns: CampaignSummary[] }>('/api/campaigns', {}, { workspaceId: session.workspace.id }).then((result) => setCampaigns(result.campaigns)).catch((issue) => { setError((issue as Error).message); setCampaigns([]); });
  }, [session.workspace.id]);
  return <section className="campaigns-page">
    <div className="page-heading-row"><div><h1>Group emails</h1><p className="page-lede">Write one email for a chosen group of people, such as everyone you met at an event. Each person gets their own copy. Nothing is sent until you approve it.</p></div>
      {!creating && <button className="button primary" onClick={() => setCreating(true)}><Plus size={16} /> New group email</button>}</div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {creating && <NewCampaign csrfToken={csrfToken} workspaceId={session.workspace.id} onCancel={() => setCreating(false)} onCreated={(id) => { notify('Drafts are ready. Check them before you approve.'); navigate(`/campaigns/${id}`); }} />}
    {campaigns === null ? <Skeleton variant="list" label="Loading group emails" rows={4} /> : campaigns.length === 0 && !creating ? <div className="surface-card records-empty"><strong>No group emails yet</strong><p>Choose an event or a stage, and Encore shows who would get it before anything is made.</p></div>
      : <ul className="campaign-list" aria-label="Group emails">{campaigns.map((campaign) => <li key={campaign.id}><Link to={`/campaigns/${campaign.id}`} className="campaign-card"><div><strong>{campaign.name}</strong><small>{campaign.status === 'draft' ? 'Draft, not sent' : campaign.status === 'cancelled' ? 'Cancelled' : campaign.send_at ? `Approved, starts ${describeMoment(new Date(campaign.send_at))}` : 'Approved'}</small></div>
        <dl><div><dt>People</dt><dd>{campaign.recipient_count}</dd></div><div><dt>Sent</dt><dd>{campaign.counts.sent}</dd></div><div><dt>Waiting</dt><dd>{campaign.counts.queued + campaign.counts.outbox}</dd></div><div><dt>Replied</dt><dd>{campaign.counts.replied}</dd></div></dl></Link></li>)}</ul>}
  </section>;
}

function NewCampaign({ csrfToken, workspaceId, onCancel, onCreated }: { csrfToken: string; workspaceId: string; onCancel: () => void; onCreated: (id: string) => void }) {
  const requestId = useRef(crypto.randomUUID());
  const [events, setEvents] = useState<Array<{ id: string; name: string }>>([]);
  const [audience, setAudience] = useState<Audience>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void request<{ events: Array<{ id: string; name: string }> }>('/api/events', {}, { workspaceId }).then((result) => setEvents(result.events)).catch(() => undefined); }, [workspaceId]);
  useEffect(() => {
    let current = true;
    setPreview(null);
    const handle = setTimeout(() => {
      void request<Preview>('/api/campaigns/preview', { method: 'POST', body: JSON.stringify(audience) }, { csrfToken, workspaceId }).then((result) => { if (current) setPreview(result); }).catch((issue) => { if (current) setError((issue as Error).message); });
    }, 250);
    return () => { current = false; clearTimeout(handle); };
  }, [audience, csrfToken, workspaceId]);
  const toggle = (key: 'stages' | 'quality', value: string) => setAudience((existing) => {
    const list = existing[key] ?? [];
    const next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
    return { ...existing, [key]: next.length ? next : undefined };
  });
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const made = await request<{ id: string }>('/api/campaigns', { method: 'POST', body: JSON.stringify({ clientCampaignId: requestId.current, name, subject, body, audience }) }, { csrfToken, workspaceId });
      onCreated(made.id);
    } catch (issue) { setError((issue as Error).message); } finally { setBusy(false); }
  }
  return <form className="surface-card campaign-form" onSubmit={submit}>
    <h2>Who is it for?</h2>
    <div className="campaign-audience">
      <label>Event<select aria-label="Event for this group email" value={audience.eventId ?? ''} onChange={(event) => setAudience({ ...audience, eventId: event.target.value || undefined })}><option value="">Any event</option>{events.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <fieldset><legend>Stage</legend>{stages.map((stage) => <label key={stage} className="inline-check"><input type="checkbox" checked={audience.stages?.includes(stage) ?? false} onChange={() => toggle('stages', stage)} /> {stageLabel(stage)}</label>)}</fieldset>
      <fieldset><legend>Lead quality</legend>{qualities.map((quality) => <label key={quality} className="inline-check"><input type="checkbox" checked={audience.quality?.includes(quality) ?? false} onChange={() => toggle('quality', quality)} /> {quality.charAt(0).toUpperCase() + quality.slice(1)}</label>)}</fieldset>
    </div>
    <div className="campaign-preview" role="status" aria-live="polite">{preview === null ? 'Checking who this reaches…' : <>
      <strong>{preview.eligible} {preview.eligible === 1 ? 'person' : 'people'} will get this email</strong>
      <span>{preview.matched} matched{preview.capped ? ` (the first ${preview.limit} are used)` : ''}. Left out: {preview.excluded.noEmail} with no email address, {preview.excluded.optedOut} who opted out, {preview.excluded.recentlyEmailed} emailed in the last {preview.excluded.recentDays} days.</span>
      {preview.sample.length > 0 && <small>For example: {preview.sample.map((person) => person.name).join(', ')}{preview.eligible > preview.sample.length ? '…' : ''}</small>}</>}</div>
    <h2>What do you want to say?</h2>
    <label>Name of this group email<input value={name} maxLength={120} required onChange={(event) => setName(event.target.value)} placeholder="Thank you after Pacific Packaging Expo" /></label>
    <label>Subject<input value={subject} maxLength={200} required onChange={(event) => setSubject(event.target.value)} placeholder="Good to meet you at {{event}}, {{firstName}}" /></label>
    <label>Message<textarea rows={8} maxLength={8000} required value={body} onChange={(event) => setBody(event.target.value)} /></label>
    <small className="subtle">{mergeHint}. Each person’s own details fill them in. Every email carries an unsubscribe link.</small>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="campaign-actions"><button type="button" className="button secondary" onClick={onCancel}>Cancel</button><button className="button primary" disabled={busy || !preview?.eligible}>{busy ? 'Preparing…' : 'Prepare drafts'}</button></div>
  </form>;
}

export function CampaignDetailPage() {
  const { campaignId } = useParams();
  const { session, csrfToken, notify } = useWorkspace();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [timing, setTiming] = useState<'now' | 'custom'>('now');
  const [customTime, setCustomTime] = useState('');
  const [spacing, setSpacing] = useState(30);
  const workspaceId = session.workspace.id;
  const load = useCallback(async () => {
    try {
      const result = await request<Detail>(`/api/campaigns/${campaignId}`, {}, { workspaceId });
      setDetail(result); setSubject(result.campaign.subject_template); setBody(result.campaign.body_template);
    } catch { setMissing(true); }
  }, [campaignId, workspaceId]);
  useEffect(() => { void load(); }, [load]);
  if (missing) return <section className="surface-card records-empty"><strong>This group email is not available</strong><Link to="/campaigns">← Group emails</Link></section>;
  if (!detail) return <Skeleton variant="detail" label="Loading group email" />;
  const { campaign, counts, recipients } = detail;
  const editable = campaign.status === 'draft';
  const act = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work(); await load(); } catch (issue) { setError((issue as Error).message); } finally { setBusy(false); } };
  const reword = () => act(async () => { await request(`/api/campaigns/${campaign.id}`, { method: 'PUT', body: JSON.stringify({ subject, body }) }, { csrfToken, workspaceId }); notify('Every draft was updated.'); });
  const approve = async () => {
    const when = timing === 'custom' && customTime ? new Date(customTime) : null;
    if (!await askConfirm({ title: `Approve ${counts.draft} emails?`, body: `${when ? `They start going out on ${describeMoment(when)}` : 'They start going out now'}, one every ${spacing} seconds. You can cancel the rest until then. Encore cannot confirm that they reach inboxes.`, confirmLabel: 'Approve all' })) return;
    await act(async () => {
      const result = await request<{ approved: number; skipped: number }>(`/api/campaigns/${campaign.id}/approve`, { method: 'POST', body: JSON.stringify({ staggerSeconds: spacing, ...(when ? { sendAt: when.toISOString() } : {}) }) }, { csrfToken, workspaceId });
      notify(`${result.approved} approved${result.skipped ? `, ${result.skipped} left out` : ''}.`);
    });
  };
  const cancel = async () => {
    if (!await askConfirm({ title: 'Cancel this group email?', body: 'Drafts and anything that has not gone out yet are removed. Emails already sent stay as a record.', confirmLabel: 'Cancel group email', cancelLabel: 'Keep it', danger: true })) return;
    await act(async () => { await request(`/api/campaigns/${campaign.id}/cancel`, { method: 'POST' }, { csrfToken, workspaceId }); notify('Group email cancelled.'); });
  };
  return <section className="campaigns-page campaign-detail">
    <Link className="back-link" to="/campaigns">← Group emails</Link>
    <div className="page-heading-row"><div><h1>{campaign.name}</h1><p className="page-lede">{editable ? 'Draft. Check the wording and the people, then approve.' : campaign.status === 'cancelled' ? 'Cancelled.' : 'Approved.'}</p></div>
      {campaign.status !== 'cancelled' && <button className="button secondary danger" disabled={busy} onClick={() => void cancel()}>Cancel group email</button>}</div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <dl className="campaign-stats"><div><dt>People</dt><dd>{campaign.recipient_count}</dd></div><div><dt>Draft</dt><dd>{counts.draft}</dd></div><div><dt>Waiting to send</dt><dd>{counts.queued}</dd></div><div><dt>In outbox</dt><dd>{counts.outbox}</dd></div><div><dt>Mail server accepted</dt><dd>{counts.sent}</dd></div><div><dt>Replied</dt><dd>{counts.replied}</dd></div><div><dt>Failed</dt><dd>{counts.failed}</dd></div></dl>
    {editable && <div className="surface-card campaign-form">
      <h2>Wording</h2>
      <label>Subject<input value={subject} maxLength={200} onChange={(event) => setSubject(event.target.value)} /></label>
      <label>Message<textarea rows={8} maxLength={8000} value={body} onChange={(event) => setBody(event.target.value)} /></label>
      <small className="subtle">{mergeHint}. Saving rewrites every draft below.</small>
      <div className="campaign-actions"><button className="button secondary" disabled={busy || (subject === campaign.subject_template && body === campaign.body_template)} onClick={() => void reword()}>Save wording</button></div>
      <h2>When should they go out?</h2>
      <div className="send-timing"><label>Start<select value={timing} onChange={(event) => setTiming(event.target.value as 'now' | 'custom')}><option value="now">Right away</option><option value="custom">Pick a time…</option></select></label>
        {timing === 'custom' && <label>Start at<input type="datetime-local" value={customTime} onChange={(event) => setCustomTime(event.target.value)} /></label>}
        <label>Spacing<select value={spacing} onChange={(event) => setSpacing(Number(event.target.value))}>{[[10, '10 seconds apart'], [30, '30 seconds apart'], [120, '2 minutes apart'], [600, '10 minutes apart']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      <div className="campaign-actions"><button className="button primary" disabled={busy || counts.draft === 0 || (timing === 'custom' && !customTime)} onClick={() => void approve()}>{busy ? 'Working…' : `Approve ${counts.draft} emails`}</button></div>
    </div>}
    <h2>People</h2>
    <ul className="campaign-recipients" aria-label="People in this group email">{recipients.map((row) => <li key={row.id}><div><strong>{row.person_name}</strong><small>{row.company_name} · {row.recipient}</small><em>{row.subject}</em></div><span className="email-desk-status">{row.status === 'queued' && row.send_at ? `Scheduled ${describeMoment(new Date(row.send_at))}` : statusText(row.status)}</span>
      {editable && row.status === 'draft' && <button className="button secondary" disabled={busy} aria-label={`Remove ${row.person_name}`} onClick={() => void act(async () => { await request(`/api/campaigns/${campaign.id}/recipients/${row.id}`, { method: 'DELETE' }, { csrfToken, workspaceId }); })}>Remove</button>}</li>)}</ul>
  </section>;
}
