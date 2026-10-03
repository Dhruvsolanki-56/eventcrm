import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Building2, Mic, UserRound } from 'lucide-react';
import { statusWords } from '../shared/contracts.js';
import { request, requestDownload, saveDownload } from './api.js';
import { useWorkspace } from './workspace-context.js';

export default function SettingsPage() {
  const { session, csrfToken, notify } = useWorkspace();
  const personal = session.workspace.kind === 'personal';
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void request<Record<string, Record<string, unknown> | null>>('/api/settings', {}, { workspaceId: session.workspace.id })
      .then((values) => setForm((values[personal ? 'aboutMe' : 'knowledge'] as Record<string, unknown>) ?? {}))
      .catch((error) => notify((error as Error).message))
      .finally(() => setLoading(false));
  }, [session.workspace.id, personal, notify]);
  function update(key: string, value: unknown) { setForm((current) => ({ ...current, [key]: value })); setSaved(false); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true);
    try {
      const key = personal ? 'aboutMe' : 'knowledge';
      await request('/api/settings', { method: 'PUT', body: JSON.stringify({ key, value: form }) }, { csrfToken, workspaceId: session.workspace.id });
      setSaved(true); notify('Your changes are saved.');
    } catch (error) { notify((error as Error).message); }
    finally { setSaving(false); }
  }
  return <section className="settings-view">
    <div className="page-heading-row"><div><p className="eyebrow">SETTINGS</p><h1>{personal ? 'About me' : 'What your team sells'}</h1><p className="page-lede">Only the details used for follow-up and email drafts.</p></div></div>
    {loading ? <div className="surface-card skeleton-block">Loading your settings…</div> : <form className="surface-card settings-form" onSubmit={(event) => void submit(event)}>
      {personal ? <>
        <div className="form-section-intro"><UserRound size={19} /><div><strong>A little about you</strong><p>Used only to personalize your own messages.</p></div></div>
        <div className="field-grid"><label>Your name<input value={String(form.name ?? session.user.name)} onChange={(event) => update('name', event.target.value)} maxLength={100} /></label><label>Your role<input value={String(form.role ?? '')} onChange={(event) => update('role', event.target.value)} maxLength={100} /></label></div>
        <label>Your company<input value={String(form.company ?? '')} onChange={(event) => update('company', event.target.value)} maxLength={120} /></label>
        <label>What are you looking for?<input value={String(form.lookingFor ?? '')} onChange={(event) => update('lookingFor', event.target.value)} maxLength={200} placeholder="One short line" /></label>
        <label>Email signature<textarea rows={3} value={String(form.signature ?? '')} onChange={(event) => update('signature', event.target.value)} maxLength={600} /></label>
      </> : <>
        <div className="form-section-intro"><Building2 size={19} /><div><strong>Help your drafts sound like your team</strong><p>Keep this short. The AI uses these details and notes for that person only.</p></div></div>
        <label>What do you sell?<textarea rows={3} value={String(form.whatYouSell ?? '')} onChange={(event) => update('whatYouSell', event.target.value)} maxLength={500} placeholder="One or two sentences" /></label>
        <div className="field-grid"><label>Tone<select value={String(form.tone ?? 'Friendly')} onChange={(event) => update('tone', event.target.value)}><option>Friendly</option><option>Professional</option><option>Short</option></select></label><label>Email signature<textarea rows={2} value={String(form.signature ?? '')} onChange={(event) => update('signature', event.target.value)} maxLength={600} /></label></div>
        <label>Never promise<textarea rows={2} value={String(form.neverPromise ?? '')} onChange={(event) => update('neverPromise', event.target.value)} maxLength={500} placeholder="For example, prices or delivery dates" /></label>
        <label>Products <span className="optional-label">one per line: name — short description</span><textarea rows={4} value={String(form.productsText ?? '')} onChange={(event) => update('productsText', event.target.value)} maxLength={2000} placeholder="Flexible cartons — Made for short production runs" /></label>
      </>}
      <div className="form-footer"><p>If an AI key is set up, card photos may be sent for reading, and saved notes or workspace details may be sent to prepare email and next-step suggestions.</p><button className="button primary" disabled={saving}>{saving ? 'Saving…' : saved ? 'Saved' : 'Save changes'}</button></div>
    </form>}
    {(!personal && session.workspace.role === 'admin') || personal ? <EmailSettingsPanel /> : null}
    {(!personal && session.workspace.role === 'admin') || personal ? <DraftAutomationSettings /> : null}
    {(!personal && session.workspace.role === 'admin') && <DataExportPanel personal={false} />}
    {personal && <DataExportPanel personal />}
    {(!personal && session.workspace.role === 'admin') || personal ? <ClearSampleDataPanel /> : null}
    {personal && <DeletePrivateDataPanel />}
    {personal || session.workspace.role === 'admin' ? <ReminderSettings /> : null}
    {!personal && session.workspace.role === 'admin' && <><EventSettings /><TeamSettings /></>}
    <ProblemsPanel />
    <p className="settings-note"><Mic size={16} /> Voice recordings stay attached to the person you save them with. Transcription is optional; you can type a short note when it is not set up.</p>
  </section>;
}

function DraftAutomationSettings() {
  const { session, csrfToken, notify } = useWorkspace();
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void request<{ draftAutomation?: { autoDraftAfterConversation?: boolean } | null }>('/api/settings', {}, { workspaceId: session.workspace.id })
      .then((settings) => setEnabled(Boolean(settings.draftAutomation?.autoDraftAfterConversation)))
      .catch((error) => notify((error as Error).message))
      .finally(() => setLoading(false));
  }, [session.workspace.id, notify]);
  async function save() {
    setSaving(true);
    try {
      await request('/api/settings', { method: 'PUT', body: JSON.stringify({ key: 'draftAutomation', value: { autoDraftAfterConversation: enabled } }) }, { csrfToken, workspaceId: session.workspace.id });
      notify(enabled ? 'New conversations will prepare an unsent draft.' : 'Automatic draft preparation is off.');
    } catch (error) { notify((error as Error).message); }
    finally { setSaving(false); }
  }
  return <section className="surface-card draft-automation-settings" aria-labelledby="draft-automation-title"><p className="eyebrow">EMAIL WORKFLOW</p><h2 id="draft-automation-title">Have a draft ready after each conversation.</h2><p className="subtle">Gather uses the latest saved conversation and earlier context to prepare an editable template. Nothing is sent automatically. People without an email address or who opted out get no draft.</p>{!loading && <><label className="draft-automation-choice"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span><strong>Prepare a draft when a conversation is saved</strong><small>One draft for that conversation. You decide whether to send it.</small></span></label><button type="button" className="button primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save email workflow'}</button></>}</section>;
}

function EmailSettingsPanel() {
  const { session, csrfToken } = useWorkspace();
  const [sender, setSender] = useState({ fromName: 'Gather', fromAddress: session.user.email, testRecipient: session.user.email });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mailReady, setMailReady] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    let active = true;
    void Promise.all([
      request<Record<string, Record<string, unknown> | null>>('/api/settings', {}, { workspaceId: session.workspace.id }),
      request<{ mailReady: boolean; senderName: string; senderAddress: string | null; demoEmailAddress: string | null }>('/api/onboarding', {}, { workspaceId: session.workspace.id }),
    ]).then(([settings, mail]) => {
      if (!active) return;
      const saved = settings.email ?? {};
      setSender({ fromName: String(saved.fromName ?? mail.senderName), fromAddress: String(saved.fromAddress ?? mail.demoEmailAddress ?? mail.senderAddress ?? session.user.email), testRecipient: String(saved.testRecipient ?? mail.demoEmailAddress ?? session.user.email) });
      setMailReady(mail.mailReady);
    }).catch((issue) => { if (active) setError((issue as Error).message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [session.workspace.id, session.user.email]);
  async function save() {
    setBusy(true); setError(''); setStatus('');
    try {
      await request('/api/settings', { method: 'PUT', body: JSON.stringify({ key: 'email', value: sender }) }, { csrfToken, workspaceId: session.workspace.id });
      setStatus('Sender details saved for this workspace.');
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  async function testEmail() {
    setBusy(true); setError(''); setStatus('');
    try {
      await request('/api/settings', { method: 'PUT', body: JSON.stringify({ key: 'email', value: sender }) }, { csrfToken, workspaceId: session.workspace.id });
      const result = await request<{ message: string }>('/api/onboarding/test-email', { method: 'POST', body: JSON.stringify({ recipient: sender.testRecipient }) }, { csrfToken, workspaceId: session.workspace.id });
      setStatus(result.message);
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="surface-card email-settings-panel">
    <p className="eyebrow">EMAIL</p><h2>Choose how your messages appear.</h2>
    <p>These details are used for lead and reminder email in this workspace. SMTP host and credentials are set by the server administrator and are never shown here.</p>
    {loading ? <p className="task-group-empty">Checking mail settings…</p> : <>
      <div className="field-grid"><label>From name<input value={sender.fromName} maxLength={100} onChange={(event) => setSender({ ...sender, fromName: event.target.value })} /></label><label>From email<input type="email" value={sender.fromAddress} maxLength={254} onChange={(event) => setSender({ ...sender, fromAddress: event.target.value })} /></label></div>
      <label className="email-test-recipient">Test email recipient<input type="email" value={sender.testRecipient} maxLength={254} onChange={(event) => setSender({ ...sender, testRecipient: event.target.value })} /><small>Only the test button uses this address. Lead emails go to the person you review.</small></label>
      <p className={`email-settings-status${mailReady ? ' ready' : ''}`} role="status">{mailReady ? 'Mail service is configured. A successful test means the mail server accepted the message, not that it reached the inbox.' : 'Mail service is not configured. Gather will save drafts as not sent and offer copy/open-in-email-app options.'}</p>
      {error && <p className="form-error" role="alert">{error}</p>}{status && <p className="form-status" role="status">{status}</p>}
      <div className="form-footer"><span>Test email goes to {sender.testRecipient || 'the address above'}.</span><div><button type="button" className="button secondary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save email details'}</button> <button type="button" className="button primary" disabled={busy} onClick={() => void testEmail()}>{busy ? 'Sending…' : 'Send a test email'}</button></div></div>
    </>}
  </section>;
}

function DataExportPanel({ personal }: { personal: boolean }) {
  const { session } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function downloadExport() {
    setBusy(true); setError('');
    try {
      const result = await requestDownload('/api/export/data.json', session.workspace.id);
      saveDownload(result.blob, result.fileName);
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="surface-card data-export-panel">
    <div><p className="eyebrow">YOUR DATA</p><h2>Keep a copy of your work.</h2><p>The file includes people, companies, events, notes, emails, follow-ups, settings, and stored photos or voice notes when those files are available.</p></div>
    <div>{error && <p className="form-error" role="alert">{error}</p>}<button type="button" className="button secondary" disabled={busy} onClick={() => void downloadExport()}>{busy ? 'Preparing…' : `Export ${personal ? 'my data' : 'company data'}`}</button></div>
  </section>;
}

function ClearSampleDataPanel() {
  const { session, csrfToken } = useWorkspace();
  const [sampleData, setSampleData] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    let active = true;
    void request<{ sampleData: boolean }>('/api/workspace', {}, { workspaceId: session.workspace.id })
      .then((result) => { if (active) setSampleData(result.sampleData); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [session.workspace.id]);
  async function clearData() {
    setBusy(true); setError('');
    try {
      const result = await request<{ mediaCleanupPending: number }>('/api/settings/clear-sample-data', {
        method: 'POST', body: JSON.stringify({ confirmation }),
      }, { csrfToken, workspaceId: session.workspace.id });
      setDone(true); setConfirmation('');
      if (result.mediaCleanupPending) setError('Sample records were removed, but some files still need cleanup. Check the server logs.');
      else window.location.assign('/home');
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  if (!sampleData || done) return null;
  return <section className="surface-card data-delete-panel sample-clear-panel">
    <div><p className="eyebrow">SAMPLE WORKSPACE</p><h2>Clear sample data.</h2><p>This removes sample people, companies, notes, recordings, card photos, emails, follow-ups, events, products and settings from this workspace only. Your sign-in, team and other workspaces stay in place. This action is for development sample accounts; it is not shown in production.</p></div>
    <label>Type CLEAR to confirm<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button type="button" className="button danger" disabled={busy || confirmation !== 'CLEAR'} onClick={() => void clearData()}>{busy ? 'Clearing…' : 'Clear sample data'}</button>
  </section>;
}

function DeletePrivateDataPanel() {
  const { session, csrfToken } = useWorkspace();
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function removeData() {
    setBusy(true); setError('');
    try {
      const result = await request<{ deleted: boolean; mediaCleanupPending: number }>('/api/settings/delete-my-data', { method: 'POST', body: JSON.stringify({ confirmation }) }, { csrfToken, workspaceId: session.workspace.id });
      if (result.mediaCleanupPending) setError('Your saved details were removed, but some private files still need cleanup. Contact your administrator.');
      else window.location.assign('/home');
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="surface-card data-delete-panel">
    <div><p className="eyebrow">REMOVE PRIVATE DATA</p><h2>Clear this private space.</h2><p>This permanently removes its people, event notes, recordings, card photos, emails, follow-ups, events, and settings. Your sign-in and any company space are kept. Copies you exported or backups already made are not erased.</p></div>
    <label>Type DELETE to confirm<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button type="button" className="button danger" disabled={busy || confirmation !== 'DELETE'} onClick={() => void removeData()}>{busy ? 'Removing…' : 'Delete private-space data'}</button>
  </section>;
}

type ReminderSettingsData = {
  settings: { inAppEnabled: boolean; dailyDigestEnabled: boolean; digestTime: string; timeZone: string };
  recentDigests: Array<{ local_date: string; status: string; last_error: string | null; sent_to_server_at: string | null }>;
  emailSending: boolean;
};
function ReminderSettings() {
  const { session, csrfToken, notify } = useWorkspace();
  const [settings, setSettings] = useState<ReminderSettingsData['settings']>({ inAppEnabled: false, dailyDigestEnabled: false, digestTime: '09:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
  const [latest, setLatest] = useState<ReminderSettingsData['recentDigests'][number] | null>(null);
  const [emailSending, setEmailSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const load = useCallback(async () => {
    const value = await request<ReminderSettingsData>('/api/reminders', {}, { workspaceId: session.workspace.id });
    setSettings(value.settings); setLatest(value.recentDigests[0] ?? null); setEmailSending(value.emailSending);
  }, [session.workspace.id]);
  useEffect(() => { void load().catch((issue) => setError((issue as Error).message)).finally(() => setLoading(false)); }, [load]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      await request('/api/settings', { method: 'PUT', body: JSON.stringify({ key: 'reminders', value: settings }) }, { csrfToken, workspaceId: session.workspace.id });
      setSaved(true); notify('Reminder settings saved.'); await load();
    } catch (issue) { setError((issue as Error).message); }
    finally { setSaving(false); }
  }
  const digestStatus = !latest ? 'No daily digest has run yet.' : latest.status === 'sent_to_server' ? `${statusWords.email.sent} (${latest.local_date} digest)` : latest.status === 'queued' ? `The ${latest.local_date} digest is being prepared.` : latest.status === 'failed' ? `The ${latest.local_date} digest failed. Open Problems below to retry it.` : latest.last_error || 'No email was sent.';
  return <section className="surface-card reminder-settings">
    <p className="eyebrow">FOLLOW-UP REMINDERS</p><h2>Choose how Gather nudges you.</h2>
    {loading ? <p className="task-group-empty">Loading reminder settings…</p> : <form onSubmit={(event) => void submit(event)}>
      <label className="reminder-choice"><input type="checkbox" checked={settings.inAppEnabled} onChange={(event) => { setSettings({ ...settings, inAppEnabled: event.target.checked }); setSaved(false); }} /><span><strong>Show an in-app reminder</strong><small>When an open follow-up is due and no reply is logged.</small></span></label>
      <label className="reminder-choice"><input type="checkbox" checked={settings.dailyDigestEnabled} onChange={(event) => { setSettings({ ...settings, dailyDigestEnabled: event.target.checked }); setSaved(false); }} /><span><strong>Email me a daily digest</strong><small>{emailSending ? 'A digest is sent only after you turn this on.' : 'Mail is not set up, so Gather will save a “not sent” status and send no email.'}</small></span></label>
      <div className="field-grid reminder-fields"><label>Send after<input type="time" value={settings.digestTime} disabled={!settings.dailyDigestEnabled} onChange={(event) => { setSettings({ ...settings, digestTime: event.target.value }); setSaved(false); }} /></label><label>Time zone<input value={settings.timeZone} maxLength={100} onChange={(event) => { setSettings({ ...settings, timeZone: event.target.value }); setSaved(false); }} placeholder="America/Los_Angeles" /><small>Use a name such as America/Los_Angeles.</small></label></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="reminder-footer"><p className="subtle" role="status">{digestStatus}</p><button className="button primary" disabled={saving}>{saving ? 'Saving…' : saved ? 'Saved' : 'Save reminders'}</button></div>
    </form>}
  </section>;
}

type TeamSettingsData = {
  events: Array<{ id: string; name: string; starts_at: string; ends_at: string; time_zone: string; spend_minor: number | null; is_active: number }>;
  members: Array<{ user_id: string; name: string; email: string; role: 'admin' | 'manager' | 'representative'; event_names: string | null; event_ids: string[] }>;
  invites: Array<{ id: string; role: string; eventIds: string[]; expiresAt: string; expired: boolean }>;
};
type EventEditorState = { id?: string; name: string; startDate: string; endDate: string; timeZone: string; spend: string; active: boolean };
function eventEditor(event: TeamSettingsData['events'][number]): EventEditorState {
  return { id: event.id, name: event.name, startDate: event.starts_at.slice(0, 10), endDate: event.ends_at.slice(0, 10), timeZone: event.time_zone, spend: event.spend_minor === null ? '' : (event.spend_minor / 100).toFixed(2), active: Boolean(event.is_active) };
}

function EventSettings() {
  const { session, csrfToken, notify } = useWorkspace();
  const [events, setEvents] = useState<TeamSettingsData['events']>([]);
  const [draft, setDraft] = useState<EventEditorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const result = await request<TeamSettingsData>('/api/team', {}, { workspaceId: session.workspace.id });
    setEvents(result.events);
    setDraft((current) => current?.id ? (result.events.find((event) => event.id === current.id) ? eventEditor(result.events.find((event) => event.id === current.id)!) : current) : current ?? (result.events[0] ? eventEditor(result.events[0]) : null));
  }, [session.workspace.id]);
  useEffect(() => { void load().catch((issue) => setError((issue as Error).message)).finally(() => setLoading(false)); }, [load]);
  function newEvent() {
    const today = new Date().toISOString().slice(0, 10);
    setDraft({ name: '', startDate: today, endDate: today, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', spend: '', active: false });
    setError('');
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!draft) return;
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
      await load();
      setDraft((current) => current ? { ...current, id: result.id } : current);
      window.dispatchEvent(new Event('gather:workspace-changed'));
      notify('Event details saved.');
    } catch (issue) { setError((issue as Error).message); }
    finally { setSaving(false); }
  }
  return <section className="surface-card event-settings">
    <div className="section-head"><div><p className="eyebrow">COMPANY ONLY</p><h2>Events</h2><p>Keep each event’s dates, local time zone, and optional spend.</p></div><button type="button" className="button secondary" onClick={newEvent}>Add event</button></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {loading ? <p className="task-group-empty">Loading events…</p> : <>
      <div className="event-choice-list">{events.map((event) => <button className={`event-choice${draft?.id === event.id ? ' selected' : ''}`} type="button" key={event.id} onClick={() => { setDraft(eventEditor(event)); setError(''); }}><span><strong>{event.name}</strong><small>{event.starts_at.slice(0, 10)} to {event.ends_at.slice(0, 10)} · {event.time_zone}</small></span>{event.is_active ? <span className="active-event-label">Active</span> : null}</button>)}{!events.length && <p className="task-group-empty">No events yet. Add the event you are attending.</p>}</div>
      {draft && <form className="event-edit-form" onSubmit={(event) => void submit(event)}>
        <div className="field-grid"><label>Event name<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} maxLength={160} required /></label><label>Time zone<input value={draft.timeZone} onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })} maxLength={80} placeholder="America/Los_Angeles" required /><small>Use a time zone name such as America/Los_Angeles.</small></label></div>
        <div className="field-grid"><label>Starts<input type="date" value={draft.startDate} onChange={(event) => setDraft({ ...draft, startDate: event.target.value })} required /></label><label>Ends<input type="date" value={draft.endDate} onChange={(event) => setDraft({ ...draft, endDate: event.target.value })} required /></label></div>
        <label>Event spend (USD)<input type="number" min="0" step="0.01" value={draft.spend} onChange={(event) => setDraft({ ...draft, spend: event.target.value })} placeholder="Not set" /></label>
        <label className="active-event-toggle"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /> Make this the active event</label>
        <div className="event-form-footer"><p>Events are kept for their conversations and reports. The active event appears in your workspace strip and is used for new captures.</p><button className="button primary" disabled={saving}>{saving ? 'Saving…' : draft.id ? 'Save event' : 'Add event'}</button></div>
      </form>}
    </>}
  </section>;
}

function TeamSettings() {
  const { session, csrfToken, notify } = useWorkspace();
  const [data, setData] = useState<TeamSettingsData | null>(null);
  const [role, setRole] = useState<'representative' | 'manager'>('representative');
  const [eventIds, setEventIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [editingMemberId, setEditingMemberId] = useState('');
  const [memberRole, setMemberRole] = useState<'manager' | 'representative'>('representative');
  const [memberEventIds, setMemberEventIds] = useState<string[]>([]);
  const load = useCallback(async () => {
    const result = await request<TeamSettingsData>('/api/team', {}, { workspaceId: session.workspace.id });
    setData(result);
    setEventIds((selected) => selected.filter((id) => result.events.some((event) => event.id === id)));
  }, [session.workspace.id]);
  useEffect(() => { void load().catch((issue) => setError((issue as Error).message)); }, [load]);
  async function createInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setLink(''); setCopied(false);
    try {
      if (data?.events.length && !eventIds.length) throw new Error('Choose at least one event for this person.');
      const result = await request<{ id: string; token: string }>('/api/team/invites', { method: 'POST', body: JSON.stringify({ role, eventIds }) }, { csrfToken, workspaceId: session.workspace.id });
      setLink(`${window.location.origin}/?invite=${encodeURIComponent(result.token)}`);
      await load();
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  async function cancelInvite(id: string) {
    setBusy(true); setError('');
    try { await request(`/api/team/invites/${id}`, { method: 'DELETE' }, { csrfToken, workspaceId: session.workspace.id }); await load(); notify('Invite cancelled.'); }
    catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  async function removeMember(id: string) {
    if (!window.confirm('Remove this person from the company? They will lose access on their next request.')) return;
    setBusy(true); setError('');
    try { await request(`/api/team/members/${id}`, { method: 'DELETE' }, { csrfToken, workspaceId: session.workspace.id }); await load(); notify('Team access removed.'); }
    catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  function startMemberEdit(member: TeamSettingsData['members'][number]) {
    setEditingMemberId(member.user_id);
    setMemberRole(member.role === 'manager' ? 'manager' : 'representative');
    setMemberEventIds(member.event_ids);
    setError('');
  }
  async function saveMemberAccess(userId: string) {
    setBusy(true); setError('');
    try {
      await request(`/api/team/members/${encodeURIComponent(userId)}/access`, { method: 'PUT', body: JSON.stringify({ role: memberRole, eventIds: memberEventIds }) }, { csrfToken, workspaceId: session.workspace.id });
      await load(); setEditingMemberId(''); notify('Team access updated.');
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(link); setCopied(true); }
    catch { setError('Could not copy the link. Select it and copy it yourself.'); }
  }
  return <section className="surface-card team-settings">
    <div className="section-head"><div><p className="eyebrow">COMPANY ONLY</p><h2>Team access</h2><p>Invite people to only the events they work at.</p></div></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!data ? <p className="task-group-empty">Loading team access…</p> : <>
      <form className="team-invite-form" onSubmit={(event) => void createInvite(event)}>
        <label>Role<select value={role} onChange={(event) => setRole(event.target.value as typeof role)}><option value="representative">Representative</option><option value="manager">Manager</option></select></label>
        {data.events.length > 0 && <fieldset><legend>Events they can access</legend>{data.events.map((event) => <label className="team-event-choice" key={event.id}><input type="checkbox" checked={eventIds.includes(event.id)} onChange={(change) => setEventIds((items) => change.target.checked ? [...items, event.id] : items.filter((id) => id !== event.id))} /><span>{event.name}{event.is_active ? ' · active' : ''}</span></label>)}</fieldset>}
        <button className="button primary" disabled={busy}>{busy ? 'Making invite…' : 'Create invite link'}</button>
      </form>
      {link && <div className="invite-link-box"><label>Share this link. It expires in 7 days.<input readOnly value={link} onFocus={(event) => event.currentTarget.select()} /></label><button type="button" className="button secondary" onClick={() => void copyLink()}>{copied ? 'Copied' : 'Copy link'}</button></div>}
      <div className="team-list"><h3>People on this team</h3>{data.members.map((member) => <article className="team-row" key={member.user_id}><div className="team-member-summary"><strong>{member.name}</strong><small>{member.email} · {member.role}{member.event_names ? ` · ${member.event_names}` : ''}</small></div>{editingMemberId === member.user_id && <div className="member-access-editor"><label>Role<select value={memberRole} onChange={(event) => setMemberRole(event.target.value as typeof memberRole)}><option value="representative">Representative</option><option value="manager">Manager</option></select></label><fieldset><legend>Events they can access</legend>{data.events.map((event) => <label className="team-event-choice" key={event.id}><input type="checkbox" checked={memberEventIds.includes(event.id)} onChange={(change) => setMemberEventIds((items) => change.target.checked ? [...items, event.id] : items.filter((id) => id !== event.id))} /><span>{event.name}{event.is_active ? ' · active' : ''}</span></label>)}</fieldset><div className="member-access-actions"><button type="button" className="button primary" disabled={busy} onClick={() => void saveMemberAccess(member.user_id)}>{busy ? 'Saving…' : 'Save access'}</button><button type="button" className="button secondary" disabled={busy} onClick={() => setEditingMemberId('')}>Cancel</button></div></div>}<div className="team-member-actions">{member.role !== 'admin' && member.user_id !== session.user.id && <button type="button" className="text-button" disabled={busy} onClick={() => startMemberEdit(member)}>Edit access</button>}<button type="button" className="text-button danger-text" disabled={busy || member.user_id === session.user.id} onClick={() => void removeMember(member.user_id)}>{member.user_id === session.user.id ? 'You' : 'Remove'}</button></div></article>)}</div>
      {!!data.invites.length && <div className="team-list"><h3>Open invite links</h3>{data.invites.map((invite) => <article className="team-row" key={invite.id}><div><strong>{invite.role}{invite.expired ? ' · expired' : ''}</strong><small>{invite.eventIds.length ? `${invite.eventIds.length} event${invite.eventIds.length === 1 ? '' : 's'}` : 'No event access'} · expires {new Date(invite.expiresAt).toLocaleDateString()}</small></div><button type="button" className="text-button danger-text" disabled={busy} onClick={() => void cancelInvite(invite.id)}>Cancel</button></article>)}</div>}
    </>}
  </section>;
}

function ProblemsPanel() {
  const { session, csrfToken, notify } = useWorkspace();
  const [jobs, setJobs] = useState<Array<{ id: string; type: string; attempts: number; max_attempts: number; created_at: string; message: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const result = await request<{ jobs: typeof jobs }>('/api/problems', {}, { workspaceId: session.workspace.id });
    setJobs(result.jobs);
  }, [session.workspace.id]);
  useEffect(() => { void load().catch((issue) => setError((issue as Error).message)).finally(() => setLoading(false)); }, [load]);
  async function retry(jobId: string) {
    setBusyId(jobId); setError('');
    try { await request(`/api/jobs/${jobId}/retry`, { method: 'POST' }, { csrfToken, workspaceId: session.workspace.id }); await load(); notify('Retry started. You can keep working while it runs.'); }
    catch (issue) { setError((issue as Error).message); }
    finally { setBusyId(''); }
  }
  return <section className="surface-card problems-panel"><div className="section-head"><div><p className="eyebrow">PROBLEMS</p><h2>Work that needs another try.</h2></div><button type="button" className="text-button" onClick={() => void load()}>Refresh</button></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {loading ? <p className="task-group-empty">Checking for failed work…</p> : jobs.length ? jobs.map((job) => <article className="problem-row" key={job.id}><div><strong>{job.type === 'email_send' ? 'Email' : job.type === 'daily_digest' ? 'Daily digest' : 'Card reading'}</strong><p>{job.message}</p><small>Try {job.attempts} of {job.max_attempts}</small></div><button type="button" className="button secondary" disabled={busyId === job.id} onClick={() => void retry(job.id)}>{busyId === job.id ? 'Retrying…' : 'Retry'}</button></article>) : <p className="task-group-empty">{error ? 'Could not check failed work. Refresh to try again.' : 'Nothing needs your attention right now.'}</p>}
  </section>;
}
