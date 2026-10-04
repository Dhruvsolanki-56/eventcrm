import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { CircleHelp, Sparkles } from 'lucide-react';
import type { DemoAccount } from '../../shared/contracts.js';
import { getCsrfToken, request } from '../api.js';

export function AuthScreen({ onSignedIn, onCsrf, onPasswordReset }: { onSignedIn: (preferredWorkspaceId?: string) => Promise<void>; onCsrf: (value: string) => void; onPasswordReset: () => void }) {
  const location = useLocation();
  const showDemoAccounts = import.meta.env.DEV || import.meta.env.VITE_PUBLIC_DEMO === 'true';
  const [searchParams] = useSearchParams();
  const inviteToken = searchParams.get('invite') ?? '';
  const [recoveryMode, setRecoveryMode] = useState<'request' | 'reset' | 'verify' | null>(() => location.pathname === '/reset-password' ? 'reset' : location.pathname === '/verify-email' ? 'verify' : null);
  const [resetToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('reset') ?? '');
  const [verificationToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('verify') ?? '');
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const [verificationEmail, setVerificationEmail] = useState('');
  const [mode, setMode] = useState<'signin' | 'signup'>(inviteToken ? 'signup' : 'signin');
  const [csrfToken, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [accounts, setAccounts] = useState<DemoAccount[]>([]);
  const [accountLoading, setAccountLoading] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    void getCsrfToken().then((token) => { setToken(token); onCsrf(token); });
    if (showDemoAccounts) {
      setAccountLoading(true);
      void request<{ accounts: DemoAccount[] }>('/api/dev/demo-accounts')
        .then((result) => setAccounts(result.accounts))
        .catch(() => setAccounts([]))
        .finally(() => setAccountLoading(false));
    }
  }, [onCsrf]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError('');
    const data = new FormData(event.currentTarget);
    try {
      const result = await request<{ csrfToken: string }>('/api/auth/login', {
        method: 'POST', body: JSON.stringify({ email: data.get('email'), password: data.get('password') }),
      }, { csrfToken });
      onCsrf(result.csrfToken);
      const invite = inviteToken ? await request<{ workspaceId: string }>('/api/invites/accept', {
        method: 'POST', body: JSON.stringify({ token: inviteToken }),
      }, { csrfToken: result.csrfToken }) : null;
      await onSignedIn(invite?.workspaceId);
      navigate('/scan', { replace: true });
    } catch (issue) {
      if ((issue as { code?: string }).code === 'email_unverified') {
        setVerificationEmail(String(data.get('email')));
        setRecoveryMessage((issue as Error).message);
        setError('');
      } else setError((issue as Error).message);
    }
    finally { setBusy(false); }
  }
  async function signUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError('');
    const data = new FormData(event.currentTarget);
    const workspaceKind = inviteToken ? 'company' : String(data.get('workspaceKind'));
    try {
      const result = await request<{ csrfToken?: string; workspaceId?: string; requiresVerification?: boolean; message?: string }>('/api/auth/signup', {
        method: 'POST', body: JSON.stringify({
          name: data.get('name'), email: data.get('email'), password: data.get('password'),
          workspaceKind, workspaceName: data.get('workspaceName') || undefined,
          inviteToken: inviteToken || undefined,
        }),
      }, { csrfToken });
      if (result.requiresVerification) {
        setVerificationEmail(String(data.get('email')));
        setRecoveryMessage(result.message ?? 'Check your email for a one-time verification link.');
        setMode('signin');
        return;
      }
      if (result.csrfToken) onCsrf(result.csrfToken);
      navigate('/setup', { replace: true });
      await onSignedIn(result.workspaceId);
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  async function requestPasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(''); setRecoveryMessage('');
    const data = new FormData(event.currentTarget);
    try {
      const result = await request<{ message: string }>('/api/auth/password-reset', {
        method: 'POST', body: JSON.stringify({ email: data.get('email') }),
      }, { csrfToken });
      setRecoveryMessage(result.message);
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError('');
    const data = new FormData(event.currentTarget);
    try {
      const result = await request<{ message: string }>('/api/auth/password-reset/confirm', {
        method: 'POST', body: JSON.stringify({ token: resetToken, password: data.get('password') }),
      }, { csrfToken });
      const freshCsrfToken = await getCsrfToken();
      setToken(freshCsrfToken);
      onCsrf(freshCsrfToken);
      onPasswordReset();
      setRecoveryMode(null); setMode('signin'); setRecoveryMessage(result.message);
      navigate('/', { replace: true });
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  async function resendVerification() {
    setBusy(true); setError(''); setRecoveryMessage('');
    try {
      const result = await request<{ message: string }>('/api/auth/email-verification/resend', {
        method: 'POST', body: JSON.stringify({ email: verificationEmail }),
      }, { csrfToken });
      setRecoveryMessage(result.message);
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  async function verifyEmail() {
    setBusy(true); setError('');
    try {
      if (!verificationToken) throw new Error('This verification link is missing or expired. Request a new one.');
      const result = await request<{ csrfToken: string }>('/api/auth/email-verification/confirm', {
        method: 'POST', body: JSON.stringify({ token: verificationToken }),
      }, { csrfToken });
      setToken(result.csrfToken); onCsrf(result.csrfToken);
      await onSignedIn();
      navigate('/setup', { replace: true });
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  async function loginAs(account: DemoAccount) {
    setBusy(true); setError('');
    try {
      const result = await request<{ csrfToken: string; workspaceId: string }>('/api/dev/login-as', {
        method: 'POST', body: JSON.stringify({ accountId: account.id, workspaceId: account.workspaceId }),
      }, { csrfToken });
      onCsrf(result.csrfToken);
      await onSignedIn(result.workspaceId);
      navigate('/scan', { replace: true });
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }

  const heading = recoveryMode === 'reset' ? 'Choose a new password.' : recoveryMode === 'verify' ? 'Verify your email.' : recoveryMode === 'request' ? 'Get back into Gather.' : mode === 'signin' ? 'Good to see you.' : 'Start with one good conversation.';
  return <main className="au-page">
    <section className="au-panel">
      <div className="au-brand"><span className="brand-mark">G</span><span>Gather</span></div>
      <div className="au-main">
        <header className="au-head">
          <p className="eyebrow">FROM CONVERSATION TO FOLLOW-UP</p>
          <h1 key={heading} className="au-title">{heading}</h1>
          <p className="page-lede">{recoveryMode ? 'Use a one-time link sent to your account email.' : 'Capture the conversation, review the details, and prepare a personal email.'}</p>
        </header>
        <div className="au-form" key={`${recoveryMode}-${mode}`}>
      {recoveryMode === 'request' ? <form className="stack-form" onSubmit={requestPasswordReset}>
        <label>Email<input name="email" type="email" autoComplete="email" required placeholder="you@company.com" /></label>
        {recoveryMessage && <p className="form-status" role="status">{recoveryMessage}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button primary full" disabled={busy}>{busy ? 'Requesting…' : 'Request a reset link'}</button>
        <p className="switch-copy"><button className="text-button" type="button" onClick={() => { setRecoveryMode(null); setRecoveryMessage(''); setError(''); }}>Back to sign in</button></p>
      </form> : recoveryMode === 'reset' ? <form className="stack-form" onSubmit={resetPassword}>
        {resetToken ? <label>New password<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={200} required /><small>Use at least 12 characters. The reset link works once and expires after one hour.</small></label> : <p className="form-error" role="alert">This reset link is missing or expired. Request a new one.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {resetToken && <button className="button primary full" disabled={busy}>{busy ? 'Updating…' : 'Update password'}</button>}
        <p className="switch-copy"><button className="text-button" type="button" onClick={() => { setRecoveryMode('request'); setError(''); }}>Request another link</button></p>
      </form> : recoveryMode === 'verify' ? <div className="stack-form">
        {verificationToken ? <p>Verify your email to finish setting up your Gather space.</p> : <p className="form-error" role="alert">This verification link is missing or expired. Ask for another one.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {verificationToken && <button className="button primary full" type="button" disabled={busy} onClick={() => void verifyEmail()}>{busy ? 'Verifying…' : 'Verify email'}</button>}
        <p className="switch-copy"><button className="text-button" type="button" onClick={() => { setRecoveryMode(null); setMode('signin'); }}>Back to sign in</button></p>
      </div> : mode === 'signin' ? <form key="sign-in" className="stack-form" onSubmit={signIn}>
        <label>Email<input name="email" type="email" autoComplete="email" required placeholder="you@company.com" defaultValue={verificationEmail} /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
        {recoveryMessage && <div className="form-status" role="status">{recoveryMessage}{verificationEmail && <button className="text-button" type="button" disabled={busy} onClick={() => void resendVerification()}>Resend verification email</button>}</div>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button primary full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="switch-copy"><button className="text-button" type="button" onClick={() => { setRecoveryMode('request'); setError(''); setRecoveryMessage(''); }}>Forgot password?</button></p>
        <p className="switch-copy">New to Gather? <button className="text-button" type="button" onClick={() => { setMode('signup'); setError(''); }}>Create an account</button></p>
      </form> : <form key="sign-up" className="stack-form" onSubmit={signUp}>
        <label>Your name<input name="name" autoComplete="name" required maxLength={100} /></label>
        <label>Email<input name="email" type="email" autoComplete="email" required /></label>
        <label>Password<input name="password" type="password" autoComplete="new-password" minLength={12} required /><small>Use at least 12 characters.</small></label>
        {!inviteToken && <><label>Your space<select name="workspaceKind" defaultValue="company"><option value="company">My company at an event</option><option value="personal">My private attendee space</option></select></label>
        <label>Company name <span className="optional-label">(for company use)</span><input name="workspaceName" maxLength={120} /></label></>}
        {inviteToken && <p className="invite-context">You’re joining a company team. Your admin chose which events you can see.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button primary full" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</button>
        <p className="switch-copy">Already have an account? <button className="text-button" type="button" onClick={() => { setMode('signin'); setError(''); }}>Sign in</button></p>
      </form>}
        </div>
      {showDemoAccounts && <section className="demo-box" aria-label="Sample accounts">
        <div className="demo-heading"><div><strong>Try a sample account</strong><span>{import.meta.env.DEV ? 'Sample data · development only' : 'Public demo · shared sample data'}</span></div><CircleHelp size={18} aria-hidden="true" /></div>
        {accountLoading ? <p className="subtle">Loading sample accounts…</p> : accounts.length ? <div className="demo-list">
          {accounts.map((account) => <button key={`${account.id}:${account.workspaceId}`} className="demo-account" disabled={busy} onClick={() => void loginAs(account)}>
            <span className="avatar small">{account.name.split(' ').map((part) => part[0]).join('').slice(0, 2)}</span>
            <span><strong>{account.name}</strong><small>{account.workspaceKind === 'personal' ? 'Attendee · private space' : `${account.role} · ${account.workspaceName}`}</small></span>
            <span className="demo-open">Open</span>
          </button>)}
        </div> : <p className="subtle">No sample accounts yet. Run the seed command to add them.</p>}
      </section>}
      </div>
      <p className="au-foot">Your event notes stay in the space where you saved them.</p>
    </section>
    <aside className="au-art">
      <div className="au-glow" aria-hidden="true" />
      <div className="au-stage" aria-hidden="true">
        <div className="au-bizcard">
          <span className="au-logo">N</span>
          <div className="au-lines"><i /><i /><i /></div>
          <span className="au-beam" />
          <b className="c tl" /><b className="c tr" /><b className="c bl" /><b className="c br" />
        </div>
        <div className="au-chip au-chip-a"><span className="avatar small">TM</span><div><strong>Tessa Morgan</strong><small>Procurement Director</small></div></div>
        <div className="au-chip au-chip-b"><span className="au-tick" />Saved to Acme Packaging</div>
        <div className="au-draft"><strong><Sparkles size={13} /> Draft ready</strong><i /><i /><i className="short" /></div>
      </div>
      <div className="au-copy">
        <h2>Start with the person in front of you.</h2>
        <p>Keep the card and conversation together, then review a draft before anything goes out.</p>
        <div className="au-flow"><span>Capture</span><i /><span>Review</span><i /><span>Draft email</span></div>
      </div>
    </aside>
  </main>;
}

