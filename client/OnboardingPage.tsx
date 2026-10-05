import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, Mail, ScanLine, SkipForward } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { request } from './api.js';
import { IdeaChips } from './quick-capture-ui.js';
import { roleIdeas } from './quick-capture.js';
import { useWorkspace } from './workspace-context.js';
import './onboarding.css';

const steps = [
  { id: 'knowledge', title: 'What you sell', short: 'Tell Encore what matters' },
  { id: 'email', title: 'Sending email', short: 'Try a message to yourself' },
  { id: 'capture', title: 'Scan your first card', short: 'Capture, review, and save' },
] as const;
type StepId = typeof steps[number]['id'];
type State = { completed: StepId[]; skipped: StepId[] };
type SetupData = {
  state: State;
  canEditKnowledge: boolean;
  canTestEmail: boolean;
  mailReady: boolean;
  senderAddress: string | null;
  senderName: string;
  accountEmail: string;
};

export default function OnboardingPage() {
  const { session, csrfToken } = useWorkspace();
  const navigate = useNavigate();
  const personal = session.workspace.kind === 'personal';
  const [data, setData] = useState<SetupData | null>(null);
  const [selected, setSelected] = useState<StepId | null>(null);
  const [knowledge, setKnowledge] = useState<Record<string, string>>({ whatYouSell: '' });
  const [sourceText, setSourceText] = useState('');
  const [suggestingProfile, setSuggestingProfile] = useState(false);
  const [readingSite, setReadingSite] = useState(false);
  const [emailSettings, setEmailSettings] = useState({ fromName: 'Encore', fromAddress: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    let active = true;
    void request<SetupData>('/api/onboarding', {}, { workspaceId: session.workspace.id }).then(async (result) => {
      if (!active) return;
      setData(result);
      const finished = new Set([...result.state.completed, ...result.state.skipped]);
      setSelected(steps.find((step) => !finished.has(step.id))?.id ?? null);
      if (result.canEditKnowledge) {
        const settings = await request<Record<string, Record<string, unknown> | null>>('/api/settings', {}, { workspaceId: session.workspace.id });
        const source = (settings[personal ? 'aboutMe' : 'knowledge'] ?? {}) as Record<string, unknown>;
        const email = (settings.email ?? {}) as Record<string, unknown>;
        if (active) {
          setKnowledge(Object.fromEntries(Object.entries(source).map(([key, value]) => [key, String(value ?? '')])) as Record<string, string>);
          setEmailSettings({ fromName: String(email.fromName ?? result.senderName), fromAddress: String(email.fromAddress ?? result.senderAddress ?? result.accountEmail) });
        }
      }
    }).catch((issue) => { if (active) setError((issue as Error).message); });
    return () => { active = false; };
  }, [session.workspace.id, personal]);

  const pending = useMemo(() => data ? steps.filter(({ id }) => !data.state.completed.includes(id) && !data.state.skipped.includes(id)) : [], [data]);
  const selectedStep = steps.find(({ id }) => id === selected);

  async function persist(next: State) {
    const result = await request<{ state: State }>('/api/onboarding', { method: 'PUT', body: JSON.stringify(next) }, { csrfToken, workspaceId: session.workspace.id });
    setData((current) => current ? { ...current, state: result.state } : current);
  }
  async function finishStep(step: StepId, completed: boolean) {
    if (!data) return;
    const next: State = {
      completed: [...new Set([...data.state.completed.filter((item) => item !== step), ...(completed ? [step] : [])])],
      skipped: [...new Set([...data.state.skipped.filter((item) => item !== step), ...(!completed ? [step] : [])])],
    };
    await persist(next);
    const finished = new Set([...next.completed, ...next.skipped]);
    setSelected(steps.find((item) => !finished.has(item.id))?.id ?? null);
  }
  async function skipStep(step: StepId) {
    setBusy(true); setError(''); setStatus('');
    try { await finishStep(step, false); }
    catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  async function saveKnowledge() {
    setBusy(true); setError(''); setStatus('');
    try {
      const key = personal ? 'aboutMe' : 'knowledge';
      const value = personal
        ? { name: knowledge.name ?? session.user.name, role: knowledge.role ?? '', company: knowledge.company ?? '', lookingFor: knowledge.lookingFor ?? '', signature: knowledge.signature ?? '' }
        : { website: (knowledge.website ?? '').trim(), whatYouSell: knowledge.whatYouSell ?? '', ourRole: knowledge.ourRole ?? '', tone: knowledge.tone ?? 'Friendly', signature: knowledge.signature ?? '', neverPromise: knowledge.neverPromise ?? '', productsText: knowledge.productsText ?? '' };
      await request('/api/settings', { method: 'PUT', body: JSON.stringify({ key, value }) }, { csrfToken, workspaceId: session.workspace.id });
      await finishStep('knowledge', true);
      setStatus('Saved. You can change these details any time in Settings.');
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  async function suggestProfile() {
    setSuggestingProfile(true); setError(''); setStatus('');
    try {
      const suggestion = await request<{ whatYouSell: string; ourRole: string; productsText: string }>('/api/setup/profile-suggestion', { method: 'POST', body: JSON.stringify({ sourceText }) }, { csrfToken, workspaceId: session.workspace.id });
      setKnowledge((current) => ({ ...current, ...suggestion }));
      setStatus('Suggestions are filled in below. Check every detail, then save.');
    } catch (issue) { setError((issue as Error).message); }
    finally { setSuggestingProfile(false); }
  }
  async function readWebsite() {
    setReadingSite(true); setError(''); setStatus('');
    try {
      const suggestion = await request<{ whatYouSell: string; ourRole: string; productsText: string; website: string }>('/api/setup/profile-from-website', { method: 'POST', body: JSON.stringify({ website: knowledge.website ?? '' }) }, { csrfToken, workspaceId: session.workspace.id });
      setKnowledge((current) => ({ ...current, ...suggestion }));
      setStatus('Filled in from your website. Check each detail, then save.');
    } catch (issue) { setError((issue as Error).message); }
    finally { setReadingSite(false); }
  }
  async function sendTestEmail() {
    setBusy(true); setError(''); setStatus('');
    try {
      await request('/api/settings', { method: 'PUT', body: JSON.stringify({ key: 'email', value: emailSettings }) }, { csrfToken, workspaceId: session.workspace.id });
      const result = await request<{ message: string }>('/api/onboarding/test-email', { method: 'POST' }, { csrfToken, workspaceId: session.workspace.id });
      setStatus(result.message);
      await finishStep('email', true);
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  async function saveEmailSettings() {
    setBusy(true); setError(''); setStatus('');
    try {
      await request('/api/settings', { method: 'PUT', body: JSON.stringify({ key: 'email', value: emailSettings }) }, { csrfToken, workspaceId: session.workspace.id });
      setStatus('Sender details saved. Encore uses them for this workspace’s lead and reminder email.');
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  async function skipRemaining() {
    if (!data) return;
    setBusy(true); setError('');
    try {
      let next = data.state;
      for (const step of pending) {
        next = { completed: next.completed, skipped: [...new Set([...next.skipped, step.id])] };
      }
      await persist(next);
      navigate('/scan');
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }

  if (error && !data) return <section className="onboarding-view"><p className="form-error" role="alert">{error}</p><Link className="button secondary" to="/scan">Continue to Scan</Link></section>;
  if (!data) return <section className="onboarding-view"><div className="surface-card skeleton-block">Opening your setup…</div></section>;

  return <section className="onboarding-view">
    <div className="onboarding-heading"><h1>Make Encore yours.</h1><p className="page-lede">Three small steps. Skip any of them and come back when you’re ready.</p></div>
    <div className="onboarding-layout">
      <nav className="onboarding-steps" aria-label="Setup steps">
        {steps.map((step, index) => {
          const complete = data.state.completed.includes(step.id);
          const skipped = data.state.skipped.includes(step.id);
          const title = step.id === 'knowledge' && personal ? 'About me' : step.title;
          return <button key={step.id} type="button" className={`onboarding-step${selected === step.id ? ' selected' : ''}`} onClick={() => { setError(''); setStatus(''); setSelected(step.id); }}>
            <span className={`onboarding-step-number${complete ? ' complete' : ''}`}>{complete ? <Check size={15} /> : index + 1}</span>
            <span><strong>{title}</strong><small>{complete ? 'Done' : skipped ? 'Skipped — tap to resume' : step.short}</small></span>
          </button>;
        })}
      </nav>
      <div className="surface-card onboarding-panel">
        {selectedStep ? <>
          <div className="onboarding-panel-heading"><span className="onboarding-panel-icon">{selected === 'email' ? <Mail size={19} /> : selected === 'capture' ? <ScanLine size={19} /> : <Check size={19} />}</span><div><p className="eyebrow">Step {steps.findIndex((step) => step.id === selected) + 1} of 3</p><h2>{selected === 'knowledge' && personal ? 'About me' : selectedStep.title}</h2></div></div>
          {selected === 'knowledge' && (data.canEditKnowledge ? <div className="onboarding-form">
            {personal ? <>
              <p>Add only the details you want included in your messages.</p>
              <label>Your name<input value={knowledge.name ?? session.user.name} onChange={(event) => setKnowledge({ ...knowledge, name: event.target.value })} maxLength={100} /></label>
              <label>Your role<input value={knowledge.role ?? ''} onChange={(event) => setKnowledge({ ...knowledge, role: event.target.value })} maxLength={100} placeholder="For example, product designer" /></label>
              <label>Your company<input value={knowledge.company ?? ''} onChange={(event) => setKnowledge({ ...knowledge, company: event.target.value })} maxLength={120} placeholder="Company name" /></label>
              <label>What are you looking for?<input value={knowledge.lookingFor ?? ''} onChange={(event) => setKnowledge({ ...knowledge, lookingFor: event.target.value })} maxLength={200} placeholder="One short line" /></label>
              <label>Email signature<textarea rows={2} value={knowledge.signature ?? ''} onChange={(event) => setKnowledge({ ...knowledge, signature: event.target.value })} maxLength={600} placeholder={`Leave blank to sign with ${session.user.name}`} /></label>
            </> : <>
              <p>Set this up once. Encore uses these checked details to shape editable email drafts.</p>
              <div className="website-assist"><label>Your company website <span className="optional-label">we read it to fill in the rest</span><input value={knowledge.website ?? ''} onChange={(event) => setKnowledge({ ...knowledge, website: event.target.value })} maxLength={200} inputMode="url" autoCapitalize="none" placeholder="yourcompany.com" /></label><button className="button secondary" type="button" disabled={readingSite || (knowledge.website ?? '').trim().length < 3} onClick={() => void readWebsite()}>{readingSite ? 'Reading your website…' : 'Read my website'}</button></div>
              <details className="setup-assist"><summary>Use website or brochure copy to suggest details</summary><p className="subtle">Paste public business copy. This text is sent to the configured AI provider for suggestions and is not saved. Check its output before saving.</p><label>Business copy<textarea rows={4} maxLength={8000} value={sourceText} onChange={(event) => setSourceText(event.target.value)} placeholder="Paste your About page or brochure text" /></label><button type="button" className="button secondary" disabled={suggestingProfile || sourceText.trim().length < 30} onClick={() => void suggestProfile()}>{suggestingProfile ? 'Suggesting…' : 'Suggest my business details'}</button></details>
              <label>What does your team sell?<textarea rows={4} value={knowledge.whatYouSell ?? ''} onChange={(event) => setKnowledge({ ...knowledge, whatYouSell: event.target.value })} maxLength={500} placeholder="Products, services, or the kind of work you do" /></label>
              <label>Our role in client conversations<input value={knowledge.ourRole ?? ''} onChange={(event) => setKnowledge({ ...knowledge, ourRole: event.target.value })} maxLength={240} placeholder="For example, we are their development partner" /></label>
              <IdeaChips ideas={roleIdeas} label="Common roles" onPick={(idea) => setKnowledge({ ...knowledge, ourRole: idea })} />
              <label>Products or services <span className="optional-label">optional, one per line</span><textarea rows={3} value={knowledge.productsText ?? ''} onChange={(event) => setKnowledge({ ...knowledge, productsText: event.target.value })} maxLength={2000} placeholder="Product name — short description" /></label>
            </>}
            <div className="onboarding-actions"><button className="button primary" type="button" disabled={busy} onClick={() => void saveKnowledge()}>{busy ? 'Saving…' : 'Save and continue'} <ArrowRight size={16} /></button><button className="text-button" type="button" disabled={busy} onClick={() => void skipStep('knowledge')}><SkipForward size={15} /> Skip for now</button></div>
          </div> : <div className="onboarding-form"><p>Your company admin looks after shared product details, so your drafts stay consistent.</p><div className="onboarding-actions"><button className="button secondary" type="button" disabled={busy} onClick={() => void skipStep('knowledge')}>Continue <ArrowRight size={16} /></button></div></div>)}
          {selected === 'email' && <div className="onboarding-form"><p>Encore can send a one-time test message to <strong>{data.accountEmail}</strong>. It uses your server’s mail settings and does not contact a lead.</p><label>From name<input value={emailSettings.fromName} maxLength={100} onChange={(event) => setEmailSettings({ ...emailSettings, fromName: event.target.value })} /></label><label>From email<input type="email" value={emailSettings.fromAddress} maxLength={254} onChange={(event) => setEmailSettings({ ...emailSettings, fromAddress: event.target.value })} /></label><div className={`onboarding-mail-status${data.mailReady ? ' ready' : ''}`} role="status">{data.mailReady ? 'Mail service is configured. A successful test means the mail server accepted it; it does not confirm inbox delivery.' : 'Mail service is not configured on this server. Your sender details can be saved, but no email will be sent. Drafts can still be copied.'}</div>{status && <p className="form-status" role="status">{status}</p>}{error && <p className="form-error" role="alert">{error}</p>}<div className="onboarding-actions">{data.canTestEmail ? <><button className="button primary" type="button" disabled={busy} onClick={() => void sendTestEmail()}>{busy ? 'Sending…' : 'Send me a test email'} <Mail size={16} /></button><button className="button secondary" type="button" disabled={busy} onClick={() => void saveEmailSettings()}>Save sender details</button></> : <p className="subtle">Your company admin can set and test the shared sending setup.</p>}<button className="text-button" type="button" disabled={busy} onClick={() => void skipStep('email')}><SkipForward size={15} /> Skip for now</button></div></div>}
          {selected === 'capture' && <div className="onboarding-form"><p>Choose a card photo or take one. Reading starts as soon as the upload begins. Review the details before saving the person.</p><div className="onboarding-actions"><Link className="button primary" to="/scan"><ScanLine size={17} /> Scan your first card</Link><button className="text-button" type="button" disabled={busy} onClick={() => void skipStep('capture')}><SkipForward size={15} /> Skip for now</button></div></div>}
        </> : <div className="onboarding-complete"><span className="onboarding-complete-icon"><Check size={23} /></span><h2>You can come back any time.</h2><p>{data.state.skipped.length ? 'Skipped steps are still here if you want to finish them later.' : 'You’re ready to capture the next conversation.'}</p><div className="onboarding-actions"><Link className="button primary" to="/scan"><ScanLine size={17} /> Go to Scan</Link>{data.state.skipped.length > 0 && <button type="button" className="button secondary" onClick={() => setSelected(data.state.skipped[0])}>Review skipped step</button>}</div></div>}
        {error && selected !== 'email' && <p className="form-error" role="alert">{error}</p>}
        {status && selected !== 'email' && <p className="form-status" role="status">{status}</p>}
        <div className="onboarding-panel-footer"><span>{pending.length} {pending.length === 1 ? 'step' : 'steps'} left</span><button type="button" className="text-button" disabled={busy} onClick={() => void skipRemaining()}><SkipForward size={15} /> Skip setup and go to Scan</button></div>
      </div>
    </div>
  </section>;
}
