import { useState } from 'react';
import { Globe, Sparkles } from 'lucide-react';
import { request } from './api.js';
import './company-about.css';

type Props = { companyId: string; companyName: string; initial: string; hasWebsite: boolean; csrfToken: string; workspaceId: string; notify: (message: string) => void; onSaved: (about: string) => void };

/** A short, checked description of the person's company. The email writer uses it only after it is saved. */
export function CompanyAbout({ companyId, companyName, initial, hasWebsite, csrfToken, workspaceId, notify, onSaved }: Props) {
  const [text, setText] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [source, setSource] = useState('');
  const changed = text.trim() !== saved.trim();

  async function suggest() {
    setReading(true); setMessage(''); setSource('');
    try {
      const result = await request<{ about: string; source: string }>(`/api/companies/${companyId}/about-suggestion`, { method: 'POST' }, { csrfToken, workspaceId });
      setText(result.about); setSource(result.source);
      setMessage('Suggested from the company website. Check it, then save.');
    } catch (issue) { setMessage((issue as Error).message); }
    finally { setReading(false); }
  }
  async function save() {
    setSaving(true); setMessage('');
    try {
      await request(`/api/companies/${companyId}/about`, { method: 'PUT', body: JSON.stringify({ about: text.trim() }) }, { csrfToken, workspaceId });
      setSaved(text.trim()); setText(text.trim()); setSource(''); onSaved(text.trim());
      notify('Company description saved. Email drafts will use it.');
    } catch (issue) { setMessage((issue as Error).message); }
    finally { setSaving(false); }
  }

  return <section className="company-about" aria-labelledby={`about-${companyId}`}>
    <div className="company-about-head"><div><p className="eyebrow">ABOUT THE COMPANY</p><h3 id={`about-${companyId}`}>What {companyName} does</h3></div>
      <button type="button" className="button secondary" disabled={reading} onClick={() => void suggest()}>{reading ? <><Sparkles size={14} className="status-spin" aria-hidden="true" /> Reading website…</> : <><Globe size={14} aria-hidden="true" /> {hasWebsite ? 'Suggest from website' : 'Try from their email'}</>}</button></div>
    <label className="sr-only" htmlFor={`about-text-${companyId}`}>Short description of {companyName}</label>
    <textarea id={`about-text-${companyId}`} rows={3} maxLength={400} value={text} onChange={(event) => setText(event.target.value)} placeholder="One or two sentences, for example: Makes packaging for beauty brands." />
    {message && <p className="company-about-note" role="status">{message}</p>}
    {source && <p className="company-about-note">Read from {source}. AI can be wrong; edit anything that is off.</p>}
    <p className="subtle">Used to make emails to {companyName} more relevant. It is never sent as text on its own.</p>
    {changed && <button type="button" className="button primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save description'}</button>}
  </section>;
}
