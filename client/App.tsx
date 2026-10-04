import { Fragment, forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AlertCircle, ArrowRight, BarChart3, Bell, Building2, CalendarDays, Check, ChevronDown, CircleCheck, CircleDot, CircleHelp, CircleX, Clock3, FileChartColumn, Home, ImagePlus, LogOut, Mail, Menu, MessageCircle, Mic, RotateCw, ScanLine, Search, Settings as SettingsIcon, Sparkles, Thermometer, Trash2, UserRound, Users, X } from 'lucide-react';
import { statusWords, type DemoAccount, type SessionData } from '../shared/contracts.js';
import { safeWebsiteHref } from '../shared/website.js';
import { getCsrfToken, getSession, request, requestDownload, saveDownload } from './api.js';
import { needsCardAiFallback, readCardInBrowser, warmCardReader } from './card-ocr.js';
import { askConfirm } from './confirm.js';
import { AiDraftSkeleton, AiWritingBar, useJustFinished } from './ai-motion.js';
import { transcribeLocally, type VoiceLanguage } from './local-transcribe.js';
import { useWorkspace, WorkspaceContext, type ToastAction } from './workspace-context.js';

const ReportChart = lazy(() => import('./ReportChart.js'));
const CaptureChart = lazy(() => import('./CaptureChart.js'));
const SettingsRoute = lazy(() => import('./SettingsPage.js'));
const OnboardingRoute = lazy(() => import('./OnboardingPage.js'));
const AnalyticsRoute = lazy(() => import('./AnalyticsPage.js'));
const EmailDeskRoute = lazy(() => import('./EmailDeskPage.js'));
const OverviewActivity = lazy(() => import('./AnalyticsPage.js').then((module) => ({ default: module.OverviewActivity })));
const TOUR_STEPS = [
  { title: 'Capture one card at a time.', body: 'Take a picture or choose a card photo. Upload starts reading right away, while you can keep adding the next card.' },
  { title: 'Check every detail.', body: 'Open one ready card, correct the name and contact details, and confirm the company before saving.' },
  { title: 'Keep the useful context.', body: 'Add a short note, products of interest, or a voice recording. Gather never invents a transcript.' },
  { title: 'Choose what happens next.', body: 'Save the person, optionally review a suggested email, and press Send only when you approve it.' },
  { title: 'Make a clear next step.', body: 'Choose a follow-up date or meeting. You can change, snooze, complete, or cancel it later.' },
  { title: 'Keep each space separate.', body: 'Company leads stay with the company team. Your private attendee space is visible only to you.' },
] as const;

function photoQualityHint(image: HTMLImageElement): string | null {
  if (Math.min(image.naturalWidth, image.naturalHeight) < 640) return 'This photo is small. Retake it closer to the card if text looks hard to read.';
  try {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) return null;
    context.drawImage(image, 0, 0, 128, 128);
    const data = context.getImageData(0, 0, 128, 128).data;
    const gray = new Float32Array(128 * 128);
    for (let i = 0; i < gray.length; i++) gray[i] = .299 * data[i * 4] + .587 * data[i * 4 + 1] + .114 * data[i * 4 + 2];
    let energy = 0;
    for (let y = 1; y < 127; y++) for (let x = 1; x < 127; x++) { const i = y * 128 + x; energy += Math.abs(4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - 128] - gray[i + 128]); }
    if (energy / (126 * 126) < 8) return 'This photo may be soft or low contrast. Check the small text, or retake it.';
    let darkEdge = 0;
    for (let i = 0; i < 128; i++) for (const index of [i, 127 * 128 + i, i * 128, i * 128 + 127]) if (gray[index] < 85) darkEdge++;
    if (darkEdge > 24 && darkEdge < 180) return 'Dark details reach the photo edge. Check that no text or part of the card was cropped.';
  } catch { /* The visual check is optional; review remains available. */ }
  return null;
}

export default function App() {
  const location = useLocation();
  const [session, setSession] = useState<SessionData | null | undefined>(undefined);
  const [csrfToken, setCsrfToken] = useState('');
  const [toast, setToast] = useState<{ message: string; action?: ToastAction } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const [workspaceId, setWorkspaceId] = useState(localStorage.getItem('gather-workspace') ?? '');
  const notify = useCallback((message: string, action?: ToastAction) => {
    if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
    setToast({ message, action });
    toastTimer.current = window.setTimeout(() => setToast(null), action ? 8000 : 3200);
  }, []);
  useEffect(() => () => { if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current); }, []);
  const refresh = useCallback(async (preferredWorkspaceId?: string) => {
    try {
      const currentCsrf = csrfToken || await getCsrfToken();
      setCsrfToken(currentCsrf);
      const targetWorkspaceId = preferredWorkspaceId || workspaceId;
      const next = await getSession(targetWorkspaceId || undefined);
      if (!next) { setSession(null); return; }
      setSession(next);
      if (preferredWorkspaceId && next.availableWorkspaces.some((item) => item.id === preferredWorkspaceId)) {
        setWorkspaceId(preferredWorkspaceId);
        localStorage.setItem('gather-workspace', preferredWorkspaceId);
      } else if (!workspaceId || !next.availableWorkspaces.some((item) => item.id === workspaceId)) {
        setWorkspaceId(next.workspace.id);
        localStorage.setItem('gather-workspace', next.workspace.id);
      }
      if (next.csrfToken) setCsrfToken(next.csrfToken);
    } catch (error) {
      if ((error as { status?: number }).status === 401) setSession(null);
      else { setSession(null); notify((error as Error).message); }
    }
  }, [csrfToken, notify, workspaceId]);
  useEffect(() => { void refresh(); }, []);

  const switchWorkspace = useCallback(async (id: string) => {
    const next = await getSession(id);
    if (!next) throw new Error('Sign in to switch spaces.');
    setWorkspaceId(id);
    localStorage.setItem('gather-workspace', id);
    setSession(next);
    notify(`You are now in ${next.workspace.kind === 'personal' ? 'your private space' : next.workspace.name}.`);
  }, [notify]);
  const logout = useCallback(async () => {
    const token = csrfToken || await getCsrfToken();
    await request('/api/auth/logout', { method: 'POST' }, { csrfToken: token });
    setSession(null);
    setWorkspaceId('');
    localStorage.removeItem('gather-workspace');
  }, [csrfToken]);

  const resetCompleted = useCallback(() => {
    setSession(null);
    setWorkspaceId('');
    localStorage.removeItem('gather-workspace');
  }, []);

  const context = useMemo(() => session ? { session, csrfToken, refresh, switchWorkspace, logout, notify } : null,
    [session, csrfToken, refresh, switchWorkspace, logout, notify]);
  if (session === undefined) return <main className="loading-screen"><span className="brand-mark">G</span><p>Opening your space…</p></main>;
  return <WorkspaceContext.Provider value={context}>
    {session && !['/reset-password', '/verify-email'].includes(location.pathname) ? <WorkspaceShell /> : <AuthScreen onSignedIn={refresh} onCsrf={setCsrfToken} onPasswordReset={resetCompleted} />}
    {toast && <div className="toast"><span role="status"><Check size={16} />{toast.message}</span>{toast.action && <button type="button" className="toast-action" onClick={() => { const action = toast.action; setToast(null); action?.onClick(); }}>{toast.action.label}</button>}<button aria-label="Dismiss message" onClick={() => setToast(null)}><X size={16} /></button></div>}
  </WorkspaceContext.Provider>;
}

function AuthScreen({ onSignedIn, onCsrf, onPasswordReset }: { onSignedIn: (preferredWorkspaceId?: string) => Promise<void>; onCsrf: (value: string) => void; onPasswordReset: () => void }) {
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

  return <main className="auth-page">
    <section className="auth-panel">
      <div className="brand-lockup"><span className="brand-mark">G</span><span>Gather</span></div>
      <div className="auth-intro">
        <p className="eyebrow">FROM CONVERSATION TO FOLLOW-UP</p>
        <h1>{recoveryMode === 'reset' ? 'Choose a new password.' : recoveryMode === 'verify' ? 'Verify your email.' : recoveryMode === 'request' ? 'Get back into Gather.' : mode === 'signin' ? 'Good to see you.' : 'Start with one good conversation.'}</h1>
        <p>{recoveryMode ? 'Use a one-time link sent to your account email.' : 'Capture the conversation, review the details, and prepare a personal email.'}</p>
      </div>
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
      <p className="auth-foot">Your event notes stay in the space where you saved them.</p>
    </section>
    <aside className="auth-aside">
      <div className="aside-top"><span className="aside-dot"></span> {new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</div>
      <div className="aside-content">
        <div className="aside-card-icon"><ScanLine size={24} /></div>
        <h2>Start with the person in front of you.</h2>
        <p>Keep the card and conversation together, then review a draft before anything goes out.</p>
        <div className="aside-flow"><span>Capture</span><i></i><span>Review</span><i></i><span>Draft email</span></div>
      </div>
      <span className="aside-wordmark">Gather CRM</span>
    </aside>
  </main>;
}

function WorkspaceShell() {
  const location = useLocation();
  const { session, logout, switchWorkspace, notify } = useWorkspace();
  const { workspace, availableWorkspaces, user } = session;
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [tourStep, setTourStep] = useState(0);
  const [workspaceData, setWorkspaceData] = useState<{ event: { name: string } | null; sampleData: boolean } | null>(null);
  const company = workspace.kind === 'company';
  const manager = company && ['admin','manager'].includes(workspace.role);
  const admin = company && workspace.role === 'admin';
  const companyLinks = [
    { to: '/home', label: 'Home', icon: Home },
    { to: '/scan', label: 'Scan', icon: ScanLine },
    { to: '/email', label: 'Email Desk', icon: Mail },
    { to: '/follow-ups', label: 'Follow-ups', icon: Clock3 },
    { to: '/people', label: 'People', icon: Users },
    { to: '/companies', label: 'Companies', icon: Building2 },
    ...(manager ? [{ to: '/pipeline', label: 'Pipeline', icon: ArrowRight }, { to: '/analytics', label: 'Analytics', icon: BarChart3 }, { to: '/reports', label: 'Reports', icon: FileChartColumn }] : []),
    ...(admin ? [{ to: '/settings', label: 'Settings', icon: SettingsIcon }] : []),
  ];
  const links = company ? companyLinks : [
    { to: '/home', label: 'Home', icon: Home },
    { to: '/scan', label: 'Scan', icon: ScanLine },
    { to: '/email', label: 'Email Desk', icon: Mail },
    { to: '/people', label: 'People', icon: Users },
    { to: '/follow-ups', label: 'Follow-ups', icon: Clock3 },
    { to: '/analytics', label: 'Analytics', icon: BarChart3 },
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
  ];
  useEffect(() => {
    const loadWorkspace = () => { void request<{ event: { name: string } | null; sampleData: boolean }>('/api/workspace', {}, { workspaceId: workspace.id })
      .then(setWorkspaceData).catch((error) => notify((error as Error).message)); };
    loadWorkspace();
    window.addEventListener('gather:workspace-changed', loadWorkspace);
    return () => window.removeEventListener('gather:workspace-changed', loadWorkspace);
  }, [workspace.id, notify]);
  useEffect(() => { setMobileMenu(false); setMenuOpen(false); }, [workspace.id]);

  return <div className={`app-frame${location.pathname.startsWith('/review/') ? ' review-mode' : ''}`}>
    <aside className={`sidebar ${mobileMenu ? 'mobile-open' : ''}`}>
      <Link to="/home" className="brand-lockup"><span className="brand-mark">G</span><span>Gather</span></Link>
      <Link to="/scan" className="button primary scan-sidebar"><ScanLine size={18} /> Scan a card</Link>
      <div className="mode-strip"><span className="mode-indicator"><Building2 size={15} /></span><div><small>{company ? `Company: ${workspace.name}` : 'Private space'}</small><strong>{company ? (workspaceData?.event?.name ?? 'Choose an event') : 'Only you can see this'}</strong></div></div>
      <nav className="main-nav" aria-label="Main navigation">
        <span className="nav-caption">WORKSPACE</span>
        {links.map(({ to, label, icon: Icon }) => <Fragment key={to}>{to === '/people' && <span className="nav-caption nav-caption-secondary">RECORDS & INSIGHTS</span>}<NavLink to={to} onClick={() => setMobileMenu(false)} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}><Icon size={18} strokeWidth={1.8} /><span>{label}</span>{label === 'Scan' && <span className="nav-key">S</span>}</NavLink></Fragment>)}
      </nav>
      <div className="sidebar-spacer" />
      <button className="help-link" onClick={() => setHelpOpen(true)}><CircleHelp size={18} /> Help</button>
      <div className="profile-wrap">
        {menuOpen && <div className="account-menu" role="menu">
          <strong className="menu-heading">Your spaces</strong>
          {availableWorkspaces.map((item) => <button key={item.id} role="menuitem" className="space-option" onClick={() => void switchWorkspace(item.id)}>
            <span>{item.kind === 'personal' ? <UserRound size={16} /> : <Building2 size={16} />}</span>
            <span><strong>{item.name}</strong><small>{item.kind === 'personal' ? 'Private attendee space' : item.role}</small></span>
            {item.id === workspace.id && <Check size={16} />}
          </button>)}
          <Link role="menuitem" className="space-option" to="/setup" onClick={() => { setMenuOpen(false); setMobileMenu(false); }}><span><Check size={16} /></span><span><strong>First-time setup</strong><small>Resume or review your setup steps</small></span></Link>
          <CaptureEmailPreferenceMenu />
          <button role="menuitem" className="logout-option" onClick={() => void logout()}><LogOut size={16} /> Sign out</button>
        </div>}
        <button className="profile-button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
          <span className="avatar">{user.name.split(' ').map((part) => part[0]).join('').slice(0, 2)}</span><span className="profile-name"><strong>{user.name}</strong><small>{workspace.role === 'attendee' ? 'Attendee' : workspace.role}</small></span><ChevronDown size={16} />
        </button>
      </div>
    </aside>
    <div className="app-main">
      <header className="topbar">
        <button className="mobile-menu-button" aria-label={mobileMenu ? 'Close navigation' : 'Open navigation'} onClick={() => setMobileMenu((open) => !open)}>{mobileMenu ? <X size={20} /> : <Menu size={20} />}</button>
        <div className="mobile-brand"><span className="brand-mark mini">G</span>Gather</div>
        <div className="topbar-mode"><span className="mode-dot"></span><span className="topbar-workspace-name">{workspace.name}</span><span className="topbar-separator">/</span><strong>{links.find((link) => location.pathname === link.to || (link.to !== '/home' && location.pathname.startsWith(`${link.to}/`)))?.label ?? (location.pathname.startsWith('/review/') ? 'Review' : 'Workspace')}</strong></div>
        {workspaceData?.sampleData && <span className="sample-badge">Sample data</span>}
        <span className="topbar-event">{workspaceData?.event?.name ?? 'No active event'}</span>
        <NotificationsMenu />
        <button className="topbar-avatar" aria-label="Open account menu" onClick={() => { setMobileMenu(true); setMenuOpen(true); }}>{user.name.split(' ').map((part) => part[0]).join('').slice(0, 2)}</button>
      </header>
      <main className="page-content">
        <Routes>
          <Route path="/" element={<Navigate to="/scan" replace />} />
          <Route path="/home" element={<HomePage onShowTour={() => { setTourStep(0); setTourOpen(true); }} />} />
          <Route path="/setup" element={<Suspense fallback={<div className="surface-card records-empty">Opening setup…</div>}><OnboardingRoute /></Suspense>} />
          <Route path="/scan" element={<ScanPage />} />
          <Route path="/email" element={<Suspense fallback={<div className="surface-card records-empty">Opening email desk…</div>}><EmailDeskRoute /></Suspense>} />
          <Route path="/review/:scanId" element={<ReviewPage />} />
          <Route path="/people" element={<PeoplePage />} />
          <Route path="/people/:contactId" element={<PersonPage />} />
          <Route path="/companies" element={company ? <CompaniesPage /> : <NotFoundPage />} />
          <Route path="/companies/:companyId" element={company ? <CompanyPage /> : <NotFoundPage />} />
          <Route path="/pipeline" element={manager ? <PipelinePage /> : <NotFoundPage />} />
          <Route path="/reports" element={manager ? <ReportsPage /> : <NotFoundPage />} />
          <Route path="/analytics" element={manager || !company ? <Suspense fallback={<div className="analytics-loading">Opening analytics…</div>}><AnalyticsRoute /></Suspense> : <NotFoundPage />} />
          <Route path="/follow-ups" element={<TasksPage />} />
          <Route path="/settings" element={!company || admin ? <Suspense fallback={<div className="surface-card records-empty">Opening settings…</div>}><SettingsRoute /></Suspense> : <NotFoundPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
    <nav className="phone-tabs" aria-label="Phone navigation">{['/home','/email','/scan','/people','/follow-ups'].map((path) => links.find((link) => link.to === path)!).map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} className={({ isActive }) => `phone-tab${to === '/scan' ? ' phone-capture' : ''}${isActive ? ' active' : ''}`}><Icon size={19} /><span>{to === '/email' ? 'Email' : label}</span></NavLink>)}</nav>
    {helpOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHelpOpen(false); }}><section className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-dialog-title"><button className="icon-button dialog-close" aria-label="Close help" onClick={() => setHelpOpen(false)}><X size={19} /></button><p className="eyebrow">GATHER HELP</p><h2 id="help-dialog-title">Keep the next conversation.</h2><p>Short answers to the words you see in Gather.</p><dl className="help-terms"><div><dt>Scan</dt><dd>Choose a photo or take one; reading starts when it uploads.</dd></div><div><dt>Company and person</dt><dd>One company can have many people. Each person keeps their own conversations.</dd></div><div><dt>Follow-up</dt><dd>A reminder date you choose. Gather does not contact anyone by itself.</dd></div><div><dt>Saved, not sent</dt><dd>Your email is stored as a draft. Copy it or open it in your email app.</dd></div><div><dt>Private space</dt><dd>Only you can see the people and notes saved in your attendee space.</dd></div></dl><div className="help-actions"><button className="button secondary" onClick={() => setHelpOpen(false)}>Close</button><Link className="button primary" to="/scan" onClick={() => setHelpOpen(false)}>Open Capture <ScanLine size={16} /></Link></div></section></div>}
    {tourOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setTourOpen(false); }}><section className="help-dialog tour-dialog" role="dialog" aria-modal="true" aria-labelledby="help-dialog-title"><button className="icon-button dialog-close" aria-label="Close tour" onClick={() => setTourOpen(false)}><X size={19} /></button><p className="eyebrow">A QUICK TOUR · {tourStep + 1} OF {TOUR_STEPS.length}</p><h2 id="help-dialog-title">{TOUR_STEPS[tourStep].title}</h2><p>{TOUR_STEPS[tourStep].body}</p><div className="tour-progress" aria-label={`Step ${tourStep + 1} of ${TOUR_STEPS.length}`}>{TOUR_STEPS.map((step, index) => <span key={step.title} className={index <= tourStep ? 'active' : ''} />)}</div><div className="help-actions">{tourStep > 0 && <button className="button secondary" onClick={() => setTourStep((step) => Math.max(0, step - 1))}>Previous</button>}{tourStep < TOUR_STEPS.length - 1 ? <button className="button primary" onClick={() => setTourStep((step) => Math.min(TOUR_STEPS.length - 1, step + 1))}>Next step <ArrowRight size={16} /></button> : <><button className="button secondary" onClick={() => setTourOpen(false)}>Done</button><Link className="button primary" to="/scan" onClick={() => setTourOpen(false)}>Open Scan <ScanLine size={16} /></Link></>}</div></section></div>}
  </div>;
}

function CaptureEmailPreferenceMenu() {
  const { session, csrfToken, notify } = useWorkspace();
  const [preference, setPreference] = useState<'ask' | 'never'>('ask');
  const [busy, setBusy] = useState(false);
  const locallyChanged = useRef(false);
  useEffect(() => {
    let active = true;
    locallyChanged.current = false;
    void request<{ afterSaveEmail: 'ask' | 'never' }>('/api/preferences/capture', {}, { workspaceId: session.workspace.id })
      .then((value) => { if (active && !locallyChanged.current) setPreference(value.afterSaveEmail); })
      .catch((error) => { if (active) notify((error as Error).message); });
    return () => { active = false; };
  }, [session.workspace.id, notify]);
  async function save(value: 'ask' | 'never') {
    locallyChanged.current = true;
    setBusy(true);
    try {
      const result = await request<{ afterSaveEmail: 'ask' | 'never' }>('/api/preferences/capture', {
        method: 'PUT', body: JSON.stringify({ afterSaveEmail: value }),
      }, { csrfToken, workspaceId: session.workspace.id });
      setPreference(result.afterSaveEmail);
      notify(value === 'ask' ? 'You’ll be asked before an email draft opens.' : 'Email drafts won’t open automatically after saving.');
    } catch (error) { notify((error as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="account-preference" role="group" aria-label="Email after saving">
    <span>After saving a person</span>
    <div>
      <button type="button" disabled={busy} aria-pressed={preference === 'ask'} onClick={() => void save('ask')}>Ask every time</button>
      <button type="button" disabled={busy} aria-pressed={preference === 'never'} onClick={() => void save('never')}>Never ask</button>
    </div>
  </div>;
}

type UserNotification = { id: string; kind: string; message: string; contact_id: string | null; read_at: string | null; created_at: string };
function NotificationsMenu() {
  const { session, csrfToken, notify } = useWorkspace();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<UserNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    const result = await request<{ notifications: UserNotification[]; unread: number }>('/api/notifications', {}, { workspaceId: session.workspace.id });
    setItems(result.notifications); setUnread(result.unread);
  }, [session.workspace.id]);
  useEffect(() => {
    void load().catch(() => undefined);
    const timer = window.setInterval(() => void load().catch(() => undefined), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);
  async function openReminders() {
    setOpen((value) => !value); setLoading(true);
    try { await load(); } catch (issue) { notify((issue as Error).message); }
    finally { setLoading(false); }
  }
  async function openNotification(item: UserNotification) {
    try {
      if (!item.read_at) await request(`/api/notifications/${item.id}/read`, { method: 'POST' }, { csrfToken, workspaceId: session.workspace.id });
      await load(); setOpen(false);
      navigate(item.contact_id ? `/people/${item.contact_id}` : '/follow-ups');
    } catch (issue) { notify((issue as Error).message); }
  }
  return <div className="notifications-wrap">
    <button type="button" className="notification-trigger" aria-label={unread ? `Open reminders, ${unread} new` : 'Open reminders'} aria-expanded={open} onClick={() => void openReminders()}><Bell size={19} />{unread > 0 && <span className="notification-count">{unread > 99 ? '99+' : unread}</span>}</button>
    {open && <section className="notification-popover" role="dialog" aria-label="Reminders"><div className="notification-heading"><div><p className="eyebrow">YOUR REMINDERS</p><h2>Next steps</h2></div><button type="button" className="icon-button" aria-label="Close reminders" onClick={() => setOpen(false)}><X size={17} /></button></div>
      {loading ? <p className="task-group-empty">Loading reminders…</p> : items.length ? <div className="notification-list">{items.map((item) => <button type="button" className={`notification-item${item.read_at ? '' : ' unread'}`} key={item.id} onClick={() => void openNotification(item)}><span>{item.message}</span><time>{new Date(item.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></button>)}</div> : <p className="task-group-empty">No reminders yet. Due follow-ups will show here when you turn reminders on.</p>}
    </section>}
  </div>;
}

function HomePage({ onShowTour }: { onShowTour: () => void }) {
  const { session, notify } = useWorkspace();
  const isPersonal = session.workspace.kind === 'personal';
  const [dashboard, setDashboard] = useState<{ counts: { captured_today: number; waiting_review: number; drafts_ready: number; follow_ups_due: number; replies: number }; due: Array<{ id: string; title: string; due_at: string; time_zone: string; kind: string; contact_id: string; contact_name: string; company_name: string }>; nextReviewScanId: string | null; hasPersonalizationDetails: boolean; timeZone: string } | null>(null);
  useEffect(() => { void request<NonNullable<typeof dashboard>>('/api/dashboard', {}, { workspaceId: session.workspace.id }).then(setDashboard).catch((error) => notify((error as Error).message)); }, [session.workspace.id, notify]);
  const nextAction = dashboard?.counts.waiting_review
    ? dashboard.nextReviewScanId
      ? { title: `${dashboard.counts.waiting_review} ${dashboard.counts.waiting_review === 1 ? 'card is' : 'cards are'} waiting for review.`, body: 'Check each detail before you save it.', label: 'Review next card', href: `/review/${dashboard.nextReviewScanId}` }
      : { title: 'Your card is being read now.', body: 'You can keep capturing while it finishes.', label: 'Open Capture', href: '/scan' }
    : dashboard?.counts.drafts_ready
      ? { title: `${dashboard.counts.drafts_ready} ${dashboard.counts.drafts_ready === 1 ? 'email draft is' : 'email drafts are'} ready to review.`, body: 'Check the conversation and message before you decide whether to send.', label: 'Review drafts', href: '/email' }
    : dashboard?.counts.follow_ups_due
      ? { title: `${dashboard.counts.follow_ups_due} ${dashboard.counts.follow_ups_due === 1 ? 'follow-up needs' : 'follow-ups need'} attention.`, body: 'Today’s and overdue conversations are ready for you.', label: 'Open follow-ups', href: '/follow-ups' }
      : dashboard && !dashboard.hasPersonalizationDetails
        ? { title: isPersonal ? 'Add a little about yourself.' : 'Add what you sell so emails sound like you.', body: 'A few short details help make your messages more useful.', label: isPersonal ? 'Add your details' : 'Add work details', href: '/settings' }
        : { title: 'Start with the card you just collected.', body: 'Take a photo or choose a picture. Check each detail before it is saved.', label: 'Open camera', href: '/scan' };
  return <section className="home-view">
    <div className="page-heading-row"><div><p className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p><h1>Good morning, {session.user.name.split(' ')[0]}.</h1><p className="page-lede">Capture the conversation, prepare a personal email, and keep moving.</p></div><Link className="button primary desktop-capture" to="/scan"><ScanLine size={18} /> Capture a card</Link></div>
    <section className="next-action-card">
      <div className="action-illustration"><ScanLine size={30} strokeWidth={1.6} /></div>
      <div className="action-copy"><span className="eyebrow">NEXT UP</span><h2>{nextAction.title}</h2><p>{nextAction.body}</p></div>
      <Link className="button primary" to={nextAction.href}>{nextAction.label} <ArrowRight size={16} /></Link>
    </section>
    <section className="metric-grid" aria-label="Today's summary">
      <article className="metric-card"><span>{isPersonal ? 'People saved today' : 'Leads captured today'}</span><strong className="metric-number">{dashboard?.counts.captured_today ?? '—'}</strong><small>In your event’s time zone</small></article>
      <article className="metric-card"><span>Waiting for review</span><strong className="metric-number">{dashboard?.counts.waiting_review ?? '—'}</strong><small>Each one checked by you</small></article>
      <article className="metric-card"><span>Follow-ups due</span><strong className="metric-number">{dashboard?.counts.follow_ups_due ?? '—'}</strong><small>Today and overdue</small></article>
      <article className="metric-card"><span>Drafts to review</span><strong className="metric-number">{dashboard?.counts.drafts_ready ?? '—'}</strong><small>Nothing sends on its own</small></article>
    </section>
    {(isPersonal || ['admin','manager'].includes(session.workspace.role)) && <Suspense fallback={<div className="analytics-loading">Loading activity…</div>}><OverviewActivity /></Suspense>}
    <section className="home-lower-grid">
      <article className="surface-card today-card"><div className="section-head"><div><p className="eyebrow">YOUR EVENT</p><h2>Follow-ups to handle</h2></div><Link to="/scan" className="subtle-link">Add a person</Link></div>{dashboard?.due.length ? <div className="due-list">{dashboard.due.map((task) => <div className="due-item" key={task.id}><span className="due-dot"></span><div><strong>{task.contact_name}</strong><small>{task.title || (task.kind === 'meeting' ? 'Meeting' : 'Follow up')} · {task.company_name}</small></div><time>{new Date(task.due_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: task.time_zone || dashboard.timeZone })}</time></div>)}</div> : <div className="empty-inline"><span className="empty-icon"><Check size={18} /></span><p>{dashboard ? 'No follow-ups due yet. Save a person and choose when to check in.' : 'Loading your follow-ups…'}</p></div>}</article>
      <article className="surface-card setup-card"><div className="section-head"><div><p className="eyebrow">MAKE IT SOUND LIKE YOU</p><h2>{isPersonal ? 'Add a little about yourself' : 'Add what your team sells'}</h2></div></div><p className="card-description">A few useful details help make email drafts feel personal. You can skip this and add them later.</p><Link className="button secondary" to="/setup">Continue first-time setup</Link></article>
    </section>
    <button className="quiet-tour" onClick={onShowTour}>Show me around</button>
  </section>;
}

function NotFoundPage() {
  return <section className="not-found-view"><span className="empty-icon"><AlertCircle size={18} /></span><p className="eyebrow">NOT FOUND</p><h1>That page isn’t here.</h1><p className="page-lede">Go back to your workspace or start with Capture.</p><div><Link className="button secondary" to="/home">Go to Home</Link><Link className="button primary" to="/scan"><ScanLine size={17} /> Open Capture</Link></div></section>;
}

type PersonRow = { id: string; name: string; title: string; email: string; phone: string; quality: string | null; stage: string; version: number; updated_at: string; company_id: string; company_name: string; encounters: number; products: string | null };
type CompanyRow = { id: string; name: string; website: string | null; deal_value_minor: number | null; deal_status: string | null; people: number; encounters: number };

function StageBadge({ stage }: { stage: string }) {
  const icons: Record<string, typeof CircleDot> = { new: CircleDot, contacted: Mail, replied: MessageCircle, meeting: CalendarDays, won: CircleCheck, lost: CircleX };
  const Icon = icons[stage] ?? CircleDot;
  const label = stage.charAt(0).toUpperCase() + stage.slice(1);
  return <span className={`stage-pill ${stage}`}><Icon size={12} aria-hidden="true" />{label}</span>;
}

function QualityBadge({ quality }: { quality: string }) {
  return <span className={`stage-pill ${quality}`}><Thermometer size={12} aria-hidden="true" />{quality.charAt(0).toUpperCase() + quality.slice(1)}</span>;
}

function PeoplePage() {
  const { session, csrfToken, notify } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get('q') ?? '');
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [showArchived, setShowArchived] = useState(searchParams.get('archived') === '1');
  const [restoringId, setRestoringId] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true; setLoading(true);
    const timer = window.setTimeout(() => void Promise.all([
      request<{ people: PersonRow[] }>(`/api/contacts?q=${encodeURIComponent(query)}&archived=${showArchived}`, {}, { workspaceId: session.workspace.id }),
      request<{ companies: CompanyRow[] }>(`/api/companies?q=${encodeURIComponent(query)}`, {}, { workspaceId: session.workspace.id }),
    ]).then(([peopleResult, companyResult]) => {
      if (current) {
        setPeople(peopleResult.people);
        setCompanies(companyResult.companies.map((company) => ({ ...company, website: safeWebsiteHref(company.website) ?? '' })));
      }
    }).catch((error) => { if (current) notify((error as Error).message); }).finally(() => { if (current) setLoading(false); }), 180);
    return () => { current = false; window.clearTimeout(timer); };
  }, [query, session.workspace.id, notify, showArchived]);
  async function restorePerson(personId: string) {
    setRestoringId(personId);
    try {
      await request(`/api/contacts/${personId}/archive`, { method: 'PATCH', body: JSON.stringify({ archived: false }) }, { csrfToken, workspaceId: session.workspace.id });
      setPeople((current) => current.filter((person) => person.id !== personId));
      notify('Person restored to the active people list.');
    } catch (error) { notify((error as Error).message); }
    finally { setRestoringId(''); }
  }
  function toggleArchived() {
    const next = !showArchived;
    setShowArchived(next);
    const params = new URLSearchParams(searchParams);
    if (next) params.set('archived', '1'); else params.delete('archived');
    setSearchParams(params, { replace: true });
  }
  return <section className="records-view">
    <div className="page-heading-row"><div><p className="eyebrow">PEOPLE</p><h1>{showArchived ? 'Archived people.' : 'Keep the person close to the conversation.'}</h1><p className="page-lede">{showArchived ? 'Archived people stay saved with their history. Restore one to work with them again.' : 'Each saved person belongs to one company, with separate event encounters.'}</p></div><div className="people-heading-actions"><button type="button" className="button secondary" onClick={toggleArchived}>{showArchived ? 'Show active people' : 'Show archived people'}</button>{!showArchived && <Link className="button primary" to="/scan"><ScanLine size={17} /> Add a person</Link>}</div></div>
    <label className="search-box"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search companies and people" aria-label="Search companies and people" /></label>
    {!showArchived && query.trim() && companies.length > 0 && <section className="search-company-matches" aria-label="Matching companies"><p className="eyebrow">COMPANIES</p><div className="company-grid">{companies.map((company) => <article className="surface-card company-card" key={company.id}><div className="company-icon"><Building2 size={19} /></div><h2><Link to={`/companies/${company.id}`}>{company.name}</Link></h2>{company.website && <a href={company.website} target="_blank" rel="noreferrer">{company.website}</a>}<div className="company-metrics"><span><strong>{company.people}</strong> people</span><span><strong>{company.encounters}</strong> conversations</span></div><Link className="subtle-link" to={`/companies/${company.id}`}>Company details <ArrowRight size={15} /></Link></article>)}</div></section>}
    <div className="surface-card records-table"><div className="records-header people-row"><span>Person</span><span>Company</span><span>Stage</span><span>Last updated</span></div>
      {loading ? <p className="records-empty">Loading people…</p> : people.length ? people.map((person) => showArchived
        ? <div className="records-row people-row archived-person-row" key={person.id}><span className="person-cell"><span className="avatar small">{person.name.split(' ').map((part) => part[0]).join('').slice(0, 2)}</span><span><strong>{person.name}</strong><small>{person.title || person.email || person.phone || 'No title or contact method'}</small></span></span><span>{person.company_name}</span><span><StageBadge stage={person.stage} /></span><span><button type="button" className="button secondary" disabled={restoringId === person.id} onClick={() => void restorePerson(person.id)}>{restoringId === person.id ? 'Restoring…' : 'Restore'}</button></span></div>
        : <Link className="records-row people-row" key={person.id} to={`/people/${person.id}`}><span className="person-cell"><span className="avatar small">{person.name.split(' ').map((part) => part[0]).join('').slice(0, 2)}</span><span><strong>{person.name}</strong><small>{person.title || person.email || person.phone || 'No title or contact method'}</small></span></span><span>{person.company_name}</span><span><StageBadge stage={person.stage} /></span><span>{new Date(String(person.updated_at)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></Link>) : <p className="records-empty">{showArchived ? 'No archived people. Archived records will stay here until restored.' : 'No people match that search. Try another name or capture a card.'}</p>}
    </div>
  </section>;
}

function CompaniesPage() {
  const { session, notify } = useWorkspace();
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { void request<{ companies: CompanyRow[] }>('/api/companies', {}, { workspaceId: session.workspace.id }).then((result) => setCompanies(result.companies.map((company) => ({ ...company, website: safeWebsiteHref(company.website) ?? '' })))).catch((error) => notify((error as Error).message)).finally(() => setLoading(false)); }, [session.workspace.id, notify]);
  return <section className="records-view">
    <div className="page-heading-row"><div><p className="eyebrow">COMPANIES</p><h1>One company, many people.</h1><p className="page-lede">People stay together under their company, even when you meet them at different events.</p></div><Link className="button primary" to="/scan"><ScanLine size={17} /> Add a person</Link></div>
    {loading ? <div className="surface-card records-empty">Loading companies…</div> : <div className="company-grid">{companies.map((company) => <article className="surface-card company-card" key={company.id}><div className="company-icon"><Building2 size={19} /></div><h2><Link to={`/companies/${company.id}`}>{company.name}</Link></h2>{company.website && <a href={company.website} target="_blank" rel="noreferrer">{company.website}</a>}<div className="company-metrics"><span><strong>{company.people}</strong> people</span><span><strong>{company.encounters}</strong> conversations</span></div>{company.deal_value_minor !== null && <p className="deal-summary">{new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(company.deal_value_minor / 100)} · {company.deal_status ?? 'open'}</p>}<Link className="subtle-link" to={`/companies/${company.id}`}>Company details <ArrowRight size={15} /></Link></article>)}{!companies.length && <div className="surface-card records-empty">No companies yet. They’ll appear when you save a person.</div>}</div>}
  </section>;
}

function CompanyPage() {
  const { companyId = '' } = useParams();
  const { session, csrfToken, notify } = useWorkspace();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<{ company: CompanyRow; people: PersonRow[]; materials: Array<{ scan_id: string; image_mime: string; saved_at: string; event_name: string | null; items: string[] }> } | null>(null);
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<'open' | 'won' | 'lost' | ''>('');
  const [saving, setSaving] = useState(false);
  const [removingMaterialId, setRemovingMaterialId] = useState('');
  const [error, setError] = useState('');
  const canManage = session.workspace.role === 'admin' || session.workspace.role === 'manager';
  const canMerge = session.workspace.kind === 'personal' || session.workspace.role === 'admin';
  const [mergeTargets, setMergeTargets] = useState<CompanyRow[]>([]);
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [mergeConfirmation, setMergeConfirmation] = useState('');
  const [mergeError, setMergeError] = useState('');
  const [merging, setMerging] = useState(false);
  useEffect(() => {
    void request<{ company: CompanyRow; people: PersonRow[]; materials: NonNullable<typeof detail>['materials'] }>(`/api/companies/${companyId}`, {}, { workspaceId: session.workspace.id }).then((result) => {
      setDetail(result); setValue(result.company.deal_value_minor === null ? '' : String(result.company.deal_value_minor / 100)); setStatus((result.company.deal_status as 'open' | 'won' | 'lost') || '');
    }).catch((issue) => setError((issue as Error).message));
  }, [companyId, session.workspace.id]);
  useEffect(() => {
    if (!canMerge) return;
    void request<{ companies: CompanyRow[] }>('/api/companies', {}, { workspaceId: session.workspace.id })
      .then((result) => setMergeTargets(result.companies.filter((company) => company.id !== companyId)))
      .catch(() => setMergeTargets([]));
  }, [canMerge, companyId, session.workspace.id]);
  async function mergeIntoSelected() {
    if (!mergeTargetId || mergeConfirmation !== 'MERGE') return;
    setMerging(true); setMergeError('');
    try {
      const target = mergeTargets.find((company) => company.id === mergeTargetId);
      await request(`/api/companies/${companyId}/merge`, { method: 'POST', body: JSON.stringify({ targetCompanyId: mergeTargetId, confirmation: mergeConfirmation }) }, { csrfToken, workspaceId: session.workspace.id });
      notify(`Combined company records under ${target?.name || 'the selected company'}.`);
      navigate(`/companies/${mergeTargetId}`, { replace: true });
    } catch (issue) { setMergeError((issue as Error).message); }
    finally { setMerging(false); }
  }
  async function saveDeal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!detail) return;
    const parsedAmount = value.trim() ? Number(value) : null;
    if (parsedAmount !== null && (!Number.isFinite(parsedAmount) || parsedAmount < 0 || parsedAmount > 1_000_000_000)) { setError('Enter a positive USD amount.'); return; }
    setSaving(true); setError('');
    try {
      await request(`/api/companies/${companyId}/deal`, { method: 'PUT', body: JSON.stringify({ valueMinor: parsedAmount === null ? null : Math.round(parsedAmount * 100), status: status || null }) }, { csrfToken, workspaceId: session.workspace.id });
      notify('Company deal details saved.');
    } catch (issue) { setError((issue as Error).message); }
    finally { setSaving(false); }
  }
  async function removeMaterial(scanId: string) {
    if (!await askConfirm({ title: 'Remove this brochure from the company?', body: 'Its photo will stay in your capture tray.', confirmLabel: 'Remove brochure', danger: true })) return;
    setRemovingMaterialId(scanId); setError('');
    try {
      await request(`/api/scans/${scanId}/material`, { method: 'DELETE' }, { csrfToken, workspaceId: session.workspace.id });
      setDetail((current) => current ? { ...current, materials: current.materials.filter((item) => item.scan_id !== scanId) } : current);
      notify('Brochure removed from the company.');
    } catch (issue) { setError((issue as Error).message); }
    finally { setRemovingMaterialId(''); }
  }
  if (!detail) return <section className="surface-card skeleton-block">{error || 'Loading company…'}{error && <p><Link className="subtle-link" to="/companies">Back to Companies</Link></p>}</section>;
  return <section className="records-view"><div className="page-heading-row"><div><Link className="subtle-link" to="/companies">← Companies</Link><p className="eyebrow">COMPANY</p><h1>{detail.company.name}</h1><p className="page-lede">One company, {detail.company.people} {detail.company.people === 1 ? 'person' : 'people'}, {detail.company.encounters} event conversations.</p></div><Link className="button primary" to="/scan"><ScanLine size={17} /> Add a person</Link></div>
    <div className="company-detail-grid"><section className="surface-card company-people"><div className="section-head"><div><p className="eyebrow">PEOPLE HERE</p><h2>People and conversations</h2></div><Link className="subtle-link" to={`/people?q=${encodeURIComponent(detail.company.name)}`}>Search people</Link></div>{detail.people.map((person) => <Link className="company-person-row" key={person.id} to={`/people/${person.id}`}><span className="avatar small">{person.name.split(' ').map((part) => part[0]).join('').slice(0, 2)}</span><span><strong>{person.name}</strong><small>{person.title || person.email || 'Contact details not added'}</small></span><span className="stage-pill">{person.encounters} {person.encounters === 1 ? 'conversation' : 'conversations'}</span><ArrowRight size={16} /></Link>)}{!detail.people.length && <p className="records-empty">No people are available in this space.</p>}</section>
      <div className="company-side">{canManage && session.workspace.kind === 'company' && <form className="surface-card deal-form" onSubmit={(event) => void saveDeal(event)}><p className="eyebrow">PIPELINE · COMPANY VALUE</p><h2>Deal value</h2><label>Potential value (USD)<input type="number" min="0" step="0.01" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Not set" /></label><label>Deal status<select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="">Not set</option><option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option></select></label>{error && <p className="form-error">{error}</p>}<p className="subtle">Counted once at company level in reports, not once per person.</p><button className="button primary" disabled={saving}>{saving ? 'Saving…' : 'Save deal'}</button></form>}<article className="surface-card company-side-note"><p className="eyebrow">A CLEAN COMPANY RECORD</p><p>Gather matches companies by website or business email domain, then by name. Similar names ask you to confirm before creating another company.</p></article>{canMerge && mergeTargets.length > 0 && <section className="surface-card company-merge-panel"><p className="eyebrow">DUPLICATE COMPANY?</p><h2>Keep one company record.</h2><p>Move this company’s people and brochures into the company you choose. The old name and website stay as matching clues for later scans. Deal details need review if both records have them.</p><label>Company to keep<select value={mergeTargetId} onChange={(event) => { setMergeTargetId(event.target.value); setMergeConfirmation(''); setMergeError(''); }}><option value="">Choose a company</option>{mergeTargets.map((company) => <option value={company.id} key={company.id}>{company.name} · {company.people} {company.people === 1 ? 'person' : 'people'}</option>)}</select></label>{mergeTargetId && <label>Type MERGE to confirm<input value={mergeConfirmation} onChange={(event) => setMergeConfirmation(event.target.value)} autoComplete="off" /></label>}{mergeError && <p className="form-error" role="alert">{mergeError}</p>}<button type="button" className="button secondary" disabled={merging || !mergeTargetId || mergeConfirmation !== 'MERGE'} onClick={() => void mergeIntoSelected()}>{merging ? 'Combining…' : 'Combine company records'}</button></section>}</div>
    </div>
    <section className="surface-card company-materials"><div className="section-head"><div><p className="eyebrow">COMPANY MATERIALS</p><h2>Brochures and product sheets</h2><p className="subtle">Saved brochure photos stay with this company, separate from people and conversations.</p></div><Link className="button secondary" to="/scan">Capture a brochure</Link></div>
      {detail.materials.length ? <div className="material-grid">{detail.materials.map((material) => <article className="material-card" key={material.scan_id}><a href={`/api/scans/${material.scan_id}/image`} target="_blank" rel="noreferrer"><img src={`/api/scans/${material.scan_id}/image`} alt={`Brochure for ${detail.company.name}`} /></a><div><strong>Brochure photo</strong><small>{material.event_name ? `${material.event_name} · ` : ''}{new Date(material.saved_at).toLocaleDateString()}</small>{material.items.length > 0 && <p className="material-items"><strong>Products or topics</strong><br />{material.items.join(' · ')}</p>}<button type="button" className="text-button danger-text" disabled={removingMaterialId === material.scan_id} onClick={() => void removeMaterial(material.scan_id)}>{removingMaterialId === material.scan_id ? 'Removing…' : 'Remove material'}</button></div></article>)}</div> : <p className="records-empty">No brochures saved yet. Capture a brochure and choose Company brochure during review.</p>}
    </section>
    </section>;
}

function PipelinePage() {
  const { session, notify } = useWorkspace();
  const [people, setPeople] = useState<PersonRow[]>([]);
  useEffect(() => { void request<{ people: PersonRow[] }>('/api/contacts', {}, { workspaceId: session.workspace.id }).then((result) => setPeople(result.people)).catch((issue) => notify((issue as Error).message)); }, [session.workspace.id, notify]);
  const stages = ['new','contacted','replied','meeting','won','lost'];
  return <section className="records-view"><div className="page-heading-row"><div><p className="eyebrow">PIPELINE · PEOPLE</p><h1>Move the conversation forward.</h1><p className="page-lede">A person’s stage is separate from the company’s shared deal value.</p></div></div><div className="pipeline-grid">{stages.map((stage) => { const rows = people.filter((person) => person.stage === stage); return <section className="surface-card pipeline-column" key={stage}><div className="pipeline-column-head"><h2>{stage}</h2><span className="count-pill">{rows.length}</span></div>{rows.map((person) => <Link className="pipeline-person" to={`/people/${person.id}`} key={person.id}><strong>{person.name}</strong><small>{person.company_name}</small>{person.quality && <QualityBadge quality={person.quality} />}</Link>)}{!rows.length && <p className="subtle">No people here yet.</p>}</section>; })}</div></section>;
}

function ReportsPage() {
  const { session, notify } = useWorkspace();
  const [exporting, setExporting] = useState(false);
  const [report, setReport] = useState<{ stages: Record<string, number>; valueByStatus: { open: number; won: number; lost: number }; companies: number; people: number; metrics: { followUpsDone: number; replies: number; meetings: number; wonCount: number }; dailyCaptures: Array<{ day: string; captures: number }>; activeEvent: { id: string; name: string; timeZone: string } | null; events: Array<{ id: string; name: string; spend_minor: number | null; people: number; encounters: number }> } | null>(null);
  useEffect(() => { void request<NonNullable<typeof report>>('/api/reports', {}, { workspaceId: session.workspace.id }).then(setReport).catch((issue) => notify((issue as Error).message)); }, [session.workspace.id, notify]);
  const stageData = report ? ['new','contacted','replied','meeting','won','lost'].map((stage) => ({ stage, people: report.stages[stage] ?? 0 })) : [];
  const money = (minor: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(minor / 100);
  const recordedSpendMinor = report?.events.reduce((total, event) => total + (event.spend_minor === null ? 0 : Number(event.spend_minor)), 0) ?? 0;
  const hasRecordedSpend = report?.events.some((event) => event.spend_minor !== null) ?? false;
  const wonValuePerSpend = hasRecordedSpend && recordedSpendMinor > 0 && report
    ? new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(report.valueByStatus.won / recordedSpendMinor)
    : null;
  async function exportPeople() {
    setExporting(true);
    try { const result = await requestDownload('/api/export/people.csv', session.workspace.id); saveDownload(result.blob, result.fileName); }
    catch (error) { notify((error as Error).message); }
    finally { setExporting(false); }
  }
  return <section className="records-view"><div className="page-heading-row"><div><p className="eyebrow">REPORTS</p><h1>See the work at a glance.</h1><p className="page-lede">Counts follow the people and events you can access. Deal values are counted once per company.</p></div><button type="button" className="button secondary" disabled={exporting} onClick={() => void exportPeople()}>{exporting ? 'Preparing…' : 'Export people CSV'}</button></div>
    {!report ? <div className="surface-card records-empty">Loading report…</div> : <><div className="report-metrics"><article className="metric-card"><span>People</span><strong className="metric-number">{report.people}</strong></article><article className="metric-card"><span>Companies</span><strong className="metric-number">{report.companies}</strong></article><article className="metric-card"><span>Follow-ups done</span><strong className="metric-number">{report.metrics.followUpsDone}</strong></article><article className="metric-card"><span>Replies</span><strong className="metric-number">{report.metrics.replies}</strong></article><article className="metric-card"><span>Meetings</span><strong className="metric-number">{report.metrics.meetings}</strong></article><article className="metric-card"><span>Won companies</span><strong className="metric-number">{report.metrics.wonCount}</strong></article><article className="metric-card"><span>Open deal value</span><strong className="metric-number">{money(report.valueByStatus.open)}</strong><small>USD · company level</small></article><article className="metric-card"><span>Won deal value</span><strong className="metric-number">{money(report.valueByStatus.won)}</strong><small>USD · counted once per company</small></article><article className="metric-card"><span>Won value ÷ event spend</span><strong className="metric-number">{wonValuePerSpend ?? 'Unavailable'}</strong><small>{wonValuePerSpend ? `Visible records: ${money(report.valueByStatus.won)} won ÷ ${money(recordedSpendMinor)} accessible-event spend; not event attribution or net ROI.` : 'Add a non-zero event spend in Settings.'}</small></article></div>
      <div className="report-grid"><article className="surface-card report-chart"><p className="eyebrow">PEOPLE BY STAGE</p><h2>Conversation progress</h2><div className="chart-wrap"><Suspense fallback={<span className="subtle">Loading chart…</span>}><ReportChart data={stageData} /></Suspense></div></article><article className="surface-card report-chart"><p className="eyebrow">CAPTURES · ACTIVE EVENT</p><h2>{report.activeEvent?.name ?? 'No active event yet'}</h2>{report.activeEvent ? <div className="chart-wrap"><Suspense fallback={<span className="subtle">Loading chart…</span>}><CaptureChart data={report.dailyCaptures} /></Suspense></div> : <p className="records-empty">Choose an active event in Settings to see daily captures.</p>}</article><article className="surface-card report-events"><p className="eyebrow">EVENTS YOU CAN ACCESS</p><h2>Conversations by event</h2>{report.events.map((event) => <div className="event-report-row" key={event.id}><strong>{event.name}</strong><span>{event.people} people · {event.encounters} conversations</span><small>{event.spend_minor === null ? 'Spend not set.' : `Event spend: ${money(Number(event.spend_minor))}`}</small></div>)}{!report.events.length && <p className="records-empty">No event activity yet.</p>}</article></div>
    </>}</section>;
}

function PersonPage() {
  const { contactId = '' } = useParams();
  const location = useLocation();
  const requestedConversation = new URLSearchParams(location.search).get('newConversation') === '1';
  const requestedEventId = new URLSearchParams(location.search).get('event');
  const { session, csrfToken, notify } = useWorkspace();
  const [detail, setDetail] = useState<{ person: Record<string, unknown>; timeline: Array<Record<string, unknown>>; products: Array<{ id: string; name: string; description: string }>; voiceNotes: Array<{ id: string; transcript: string; summary: string; duration_seconds: number | null; audio_mime: string | null; created_at: string }>; conversationMemories: Array<{ id: string; summary: string; open_question: string; promised_next_step: string; changed_since_last: string; occurred_at: string; event_name: string | null }> } | null>(null);
  const [note, setNote] = useState('');
  const [conversationMemory, setConversationMemory] = useState({ summary: '', openQuestion: '', promisedNextStep: '', changedSinceLast: '' });
  const [suggestingMemory, setSuggestingMemory] = useState(false);
  const [conversationEvents, setConversationEvents] = useState<Array<{ id: string; name: string; is_active: number }>>([]);
  const [conversationEventId, setConversationEventId] = useState('');
  const conversationRequestId = useRef(crypto.randomUUID());
  const [emailDraftVersion, setEmailDraftVersion] = useState(0);
  const [emailAfterConversation, setEmailAfterConversation] = useState(false);
  const [conversationDraft, setConversationDraft] = useState<EmailDraftView | null>(null);
  const [emailHasOpenDraft, setEmailHasOpenDraft] = useState(false);
  const [saving, setSaving] = useState(false);
  const [stageDraft, setStageDraft] = useState('');
  const [lostReason, setLostReason] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState({ name: '', title: '', email: '', phone: '', website: '' });
  const [editError, setEditError] = useState('');
  const [staleEdit, setStaleEdit] = useState(false);
  const [plannerKind, setPlannerKind] = useState<'follow_up' | 'meeting'>('follow_up');
  const [personPanel, setPersonPanel] = useState('conversation');
  const handleDraftStateChange = useCallback((open: boolean) => {
    setEmailHasOpenDraft(open);
    if (open) setPersonPanel('email');
  }, []);
  const [dealValue, setDealValue] = useState('');
  const [dealStatus, setDealStatus] = useState<'open' | 'won' | 'lost' | ''>('');
  const [savingDeal, setSavingDeal] = useState(false);
  const [dealError, setDealError] = useState('');
  const canManageDeal = session.workspace.kind === 'company' && (session.workspace.role === 'admin' || session.workspace.role === 'manager');
  const load = useCallback(async () => {
    const value = await request<NonNullable<typeof detail>>(`/api/contacts/${contactId}`, {}, { workspaceId: session.workspace.id });
    setDetail({ ...value, person: { ...value.person, website: safeWebsiteHref(value.person.website) ?? '' } });
    setDealValue(value.person.deal_value_minor === null ? '' : String(Number(value.person.deal_value_minor) / 100));
    setDealStatus(['open', 'won', 'lost'].includes(String(value.person.deal_status)) ? value.person.deal_status as 'open' | 'won' | 'lost' : '');
  }, [contactId, session.workspace.id]);
  useEffect(() => { void load().catch((issue) => setError((issue as Error).message)); }, [load]);
  useEffect(() => {
    let active = true;
    void request<{ events: Array<{ id: string; name: string; is_active: number }> }>('/api/events/accessible', {}, { workspaceId: session.workspace.id })
      .then(({ events }) => { if (active) { setConversationEvents(events); setConversationEventId(requestedEventId !== null && (requestedEventId === '' || events.some((item) => item.id === requestedEventId)) ? requestedEventId : events.find((item) => item.is_active)?.id ?? ''); } })
      .catch(() => { if (active) setConversationEvents([]); });
    return () => { active = false; };
  }, [requestedEventId, session.workspace.id]);
  useEffect(() => {
    if (!requestedConversation || !detail) return;
    setPersonPanel('conversation');
    const timer = window.setTimeout(() => {
      document.getElementById('person-conversation')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      document.getElementById('person-note')?.focus({ preventScroll: true });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [requestedConversation, detail?.person.id]);
  async function changeStage(stage: string, reason = '') {
    if (!detail) return;
    try {
      const result = await request<{ version: number }>(`/api/contacts/${contactId}/stage`, { method: 'PATCH', body: JSON.stringify({ stage, version: Number(detail.person.version), ...(stage === 'lost' ? { lostReason: reason } : {}) }) }, { csrfToken, workspaceId: session.workspace.id });
      setDetail((current) => current ? { ...current, person: { ...current.person, stage, lost_reason: stage === 'lost' ? reason : null, version: result.version } } : current);
      setStageDraft(''); setLostReason('');
      notify('Stage updated.');
    } catch (issue) { notify((issue as Error).message); }
  }
  function startEditing() {
    if (!detail) return;
    setEditDraft({ name: String(detail.person.name ?? ''), title: String(detail.person.title ?? ''), email: String(detail.person.email ?? ''), phone: String(detail.person.phone ?? ''), website: String(detail.person.website ?? '') });
    setEditError(''); setStaleEdit(false); setEditing(true);
  }
  async function savePerson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!detail) return;
    setSaving(true); setEditError(''); setStaleEdit(false);
    try {
      const result = await request<{ version: number }>(`/api/contacts/${contactId}`, { method: 'PATCH', body: JSON.stringify({ ...editDraft, version: Number(detail.person.version) }) }, { csrfToken, workspaceId: session.workspace.id });
      setDetail((current) => current ? { ...current, person: { ...current.person, ...editDraft, version: result.version } } : current);
      setEditing(false); notify('Person details saved.');
    } catch (issue) {
      const message = (issue as Error).message;
      setEditError(message); setStaleEdit(message === 'Someone else changed this. Reload to see the latest.');
    } finally { setSaving(false); }
  }
  async function logReply() {
    try {
      await request(`/api/contacts/${contactId}/reply`, { method: 'POST' }, { csrfToken, workspaceId: session.workspace.id });
      await load(); notify('Reply noted. This person moved to Replied.');
    } catch (issue) { notify((issue as Error).message); }
  }
  async function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prepareEmail = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.dataset.action === 'email';
    if (emailHasOpenDraft && !await askConfirm({ title: 'Save this conversation?', body: 'Saving may prepare a new email draft. The draft open here stays saved and unsent, but it will close on this page.', confirmLabel: 'Save conversation' })) return;
    setSaving(true); setError('');
    try { const result = await request<{ autoDraft: EmailDraftView | null }>(`/api/contacts/${contactId}/conversations`, { method: 'POST', body: JSON.stringify({ body: note, eventId: conversationEventId || null, clientConversationId: conversationRequestId.current, ...conversationMemory }) }, { csrfToken, workspaceId: session.workspace.id }); conversationRequestId.current = crypto.randomUUID(); setNote(''); setConversationMemory({ summary: '', openQuestion: '', promisedNextStep: '', changedSinceLast: '' }); await load(); setConversationDraft(result.autoDraft); if (prepareEmail || result.autoDraft) { setEmailAfterConversation(true); setEmailDraftVersion((value) => value + 1); } notify(prepareEmail || result.autoDraft ? 'Conversation saved. Review the new email draft before sending.' : 'Conversation added to this person. Your next email draft can use it.'); }
    catch (issue) { setError((issue as Error).message); } finally { setSaving(false); }
  }
  async function saveCompanyDeal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!detail) return;
    const parsedAmount = dealValue.trim() ? Number(dealValue) : null;
    if (parsedAmount !== null && (!Number.isFinite(parsedAmount) || parsedAmount < 0 || parsedAmount > 1_000_000_000)) { setDealError('Enter a valid USD amount of $0 or more.'); return; }
    setSavingDeal(true); setDealError('');
    const valueMinor = parsedAmount === null ? null : Math.round(parsedAmount * 100);
    try {
      await request(`/api/companies/${String(detail.person.company_id)}/deal`, { method: 'PUT', body: JSON.stringify({ valueMinor, status: dealStatus || null }) }, { csrfToken, workspaceId: session.workspace.id });
      setDetail((current) => current ? { ...current, person: { ...current.person, deal_value_minor: valueMinor, deal_status: dealStatus || null } } : current);
      notify('Company deal details saved.');
    } catch (issue) { setDealError((issue as Error).message); }
    finally { setSavingDeal(false); }
  }
  if (!detail) return <section className="surface-card skeleton-block">{error || 'Loading this person…'}{error && <p><Link className="subtle-link" to="/people">Back to People</Link></p>}</section>;
  const { person, timeline, products } = detail;
  return <section className="person-view"><div className="page-heading-row"><div><Link className="subtle-link" to="/people">← People</Link><p className="eyebrow">PERSON</p><h1>{String(person.name)}</h1><p className="page-lede">{String(person.title || 'Job title not added')} · {String(person.company_name)}</p></div><Link className="button secondary" to="/scan"><ScanLine size={17} /> Add another conversation</Link></div>
    <nav className="person-action-row" aria-label="Actions for this person" data-active={personPanel}>
      <a className="button secondary" href="#person-conversation" aria-current={personPanel === 'conversation' ? 'location' : undefined} onClick={() => setPersonPanel('conversation')}>Conversation</a>
      <a className="button secondary" href="#person-email" aria-current={personPanel === 'email' ? 'location' : undefined} onClick={() => setPersonPanel('email')}>Email</a>
      <a className="button secondary" href="#person-voice-note" aria-current={personPanel === 'voice' ? 'location' : undefined} onClick={() => setPersonPanel('voice')}>Voice note</a>
      <a className="button secondary" href="#person-next-step" aria-current={personPanel === 'follow_up' ? 'location' : undefined} onClick={() => { setPersonPanel('follow_up'); setPlannerKind('follow_up'); }}>Follow-up</a>
      <a className="button secondary" href="#person-next-step" aria-current={personPanel === 'meeting' ? 'location' : undefined} onClick={() => { setPersonPanel('meeting'); setPlannerKind('meeting'); }}>Meeting</a>
      {session.workspace.kind === 'company' && <a className="button secondary" href="#person-deal-value" aria-current={personPanel === 'deal' ? 'location' : undefined} onClick={() => setPersonPanel('deal')}>Deal value</a>}
      <a className="button secondary" href="#person-manage" aria-current={personPanel === 'manage' ? 'location' : undefined} onClick={() => setPersonPanel('manage')}>Manage</a>
    </nav>
    <div className="person-layout"><div className="person-main"><article className="surface-card person-card"><div className="section-head"><div><p className="eyebrow">CONTACT DETAILS</p><h2>{String(person.company_name)}</h2></div><div className="person-head-actions"><StageBadge stage={String(person.stage)} />{!editing && <button type="button" className="button secondary" onClick={startEditing}>Edit details</button>}</div></div>{editing ? <form className="person-edit-form" onSubmit={(event) => void savePerson(event)}><label>Name<input value={editDraft.name} maxLength={160} required onChange={(event) => setEditDraft({ ...editDraft, name: event.target.value })} /></label><label>Job title<input value={editDraft.title} maxLength={160} onChange={(event) => setEditDraft({ ...editDraft, title: event.target.value })} /></label><label>Email<input type="email" value={editDraft.email} maxLength={254} onChange={(event) => setEditDraft({ ...editDraft, email: event.target.value })} /></label><label>Phone<input type="tel" value={editDraft.phone} maxLength={60} onChange={(event) => setEditDraft({ ...editDraft, phone: event.target.value })} /></label><label>Website<input value={editDraft.website} maxLength={300} placeholder="example.com" onChange={(event) => setEditDraft({ ...editDraft, website: event.target.value })} /></label><p className="subtle">Keep at least one email address or phone number.</p>{editError && <div className="form-error" role="alert">{editError}{staleEdit && <button type="button" className="text-button" onClick={() => { setEditing(false); setEditError(''); setStaleEdit(false); void load(); }}>Reload person</button>}</div>}<div className="person-edit-actions"><button type="button" className="button secondary" onClick={() => { setEditing(false); setEditError(''); setStaleEdit(false); }}>Cancel</button><button className="button primary" disabled={saving}>{saving ? 'Saving…' : 'Save details'}</button></div></form> : <dl className="person-fields"><dt>Email</dt><dd>{person.email ? <a href={`mailto:${String(person.email)}`}>{String(person.email)}</a> : 'Not added'}</dd><dt>Phone</dt><dd>{person.phone ? <a href={`tel:${String(person.phone)}`}>{String(person.phone)}</a> : 'Not added'}</dd><dt>Website</dt><dd>{person.website ? <a href={String(person.website)} target="_blank" rel="noreferrer">{String(person.website)}</a> : 'Not added'}</dd><dt>Quality</dt><dd>{String(person.quality || 'Not set')}</dd><dt>Event conversations</dt><dd>{timeline.filter((item) => item.kind === 'encounter').length}</dd></dl>}<label>Change stage<select value={stageDraft || String(person.stage)} onChange={(event) => { const stage = event.target.value; if (stage === 'lost') { setStageDraft('lost'); setLostReason(''); } else { setStageDraft(''); void changeStage(stage); } }}><option value="new">New</option><option value="contacted">Contacted</option><option value="replied">Replied</option><option value="meeting">Meeting</option><option value="won">Won</option><option value="lost">Lost</option></select></label>{stageDraft === 'lost' && <div className="lost-reason-form"><label htmlFor="lost-reason">Why was this marked lost?<textarea id="lost-reason" rows={2} maxLength={500} value={lostReason} onChange={(event) => setLostReason(event.target.value)} placeholder="A short reason" /></label><button type="button" className="button primary" disabled={!lostReason.trim()} onClick={() => void changeStage('lost', lostReason)}>Save as lost</button><button type="button" className="text-button" onClick={() => { setStageDraft(''); setLostReason(''); }}>Cancel</button></div>}{person.stage === 'lost' && Boolean(person.lost_reason) && <p className="lost-reason-display">Lost because: {String(person.lost_reason)}</p>}{person.stage !== 'replied' && <button type="button" className="button secondary reply-action" onClick={() => void logReply()}>They replied</button>}{products.length > 0 && <div className="product-list"><strong>Products of interest</strong><p>{products.map((item) => item.name).join(' · ')}</p></div>}</article>
    <article className="surface-card timeline-card"><p className="eyebrow">HISTORY</p><h2>Conversations and notes</h2>{detail.conversationMemories.length > 0 && <div className="memory-history"><strong>Checked email context</strong>{detail.conversationMemories.map((item) => <ConversationMemoryCard key={item.id} item={item} contactId={contactId} onSaved={() => void load()} />)}</div>}{timeline.length ? <div className="timeline-list">{timeline.map((item) => <div className="timeline-item" key={`${String(item.kind)}-${String(item.id)}`}><span className="timeline-dot"></span><div><strong>{String(item.kind === 'note' ? 'Conversation note' : item.kind === 'encounter' ? 'Conversation' : item.kind === 'email' ? 'Email' : 'Follow-up')}{item.event_name ? ` · ${String(item.event_name)}` : ''}</strong><p>{String(item.detail || '')}</p><time>{new Date(String(item.created_at)).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time></div></div>)}</div> : <p className="records-empty">No notes or event conversations are recorded yet.</p>}</article></div>
    <div className="person-side" data-panel={personPanel}>
      {session.workspace.kind === 'company' && <form id="person-deal-value" className="surface-card deal-form" onSubmit={(event) => void saveCompanyDeal(event)}><p className="eyebrow">PIPELINE · COMPANY VALUE</p><h2>Deal value for {String(person.company_name)}</h2>{canManageDeal ? <><label>Potential value (USD)<input type="number" min="0" step="0.01" value={dealValue} onChange={(event) => setDealValue(event.target.value)} placeholder="Not set" /></label><label>Deal status<select value={dealStatus} onChange={(event) => setDealStatus(event.target.value as typeof dealStatus)}><option value="">Not set</option><option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option></select></label>{dealError && <p className="form-error" role="alert">{dealError}</p>}<p className="subtle">This value belongs to the company and is counted once, even when it has many people.</p><button className="button primary" disabled={savingDeal}>{savingDeal ? 'Saving…' : 'Save deal'}</button></> : <p className="subtle">{person.deal_value_minor === null ? 'No company deal value has been added.' : `${new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(person.deal_value_minor) / 100)} · ${String(person.deal_status || 'open')}. Only an admin or manager can change it.`}</p>}</form>}
      <form id="person-conversation" className="surface-card note-form" onSubmit={(event) => void addNote(event)}>
        <p className="eyebrow">NEW CONVERSATION</p><h2>Pick up where you left off.</h2>
        <p className="subtle">Add this exchange to {String(person.name)}. It will inform the next email draft without creating another person.</p>
        <label htmlFor="conversation-event">Where did you meet?</label>
        <select id="conversation-event" value={conversationEventId} onChange={(event) => { setConversationEventId(event.target.value); conversationRequestId.current = crypto.randomUUID(); }}>
          <option value="">No event / other meeting</option>
          {conversationEvents.map((item) => <option key={item.id} value={item.id}>{item.name}{item.is_active ? ' · active' : ''}</option>)}
        </select>
        <label htmlFor="person-note">What did you discuss?</label>
        <textarea id="person-note" rows={4} maxLength={4000} value={note} onChange={(event) => { setNote(event.target.value); conversationRequestId.current = crypto.randomUUID(); }} placeholder="Their question, current need, or next step — in your own words" required />
        <details className="conversation-memory"><summary>Add checked details (optional)</summary><p className="subtle">Your note alone is enough to prepare a draft. Add only facts you want to explicitly confirm.</p><button type="button" className="button secondary" disabled={suggestingMemory || !note.trim()} onClick={() => { setSuggestingMemory(true); void request<typeof conversationMemory>(`/api/contacts/${contactId}/conversation-context-suggestion`, { method: 'POST', body: JSON.stringify({ text: note }) }, { csrfToken, workspaceId: session.workspace.id }).then((suggestion) => { setConversationMemory(suggestion); notify('AI suggested conversation context. Check every field before saving.'); }).catch((issue) => notify((issue as Error).message)).finally(() => setSuggestingMemory(false)); }}>{suggestingMemory ? 'Understanding…' : 'Suggest conversation context'}</button><p className="subtle">Suggestions send this note and limited workspace context to the configured AI provider. Check anything suggested before saving. It may misunderstand who promised what.</p><label>What matters most<textarea rows={2} maxLength={700} value={conversationMemory.summary} onChange={(event) => setConversationMemory({ ...conversationMemory, summary: event.target.value })} placeholder="A checked summary in your words" /></label><label>Open question<input maxLength={400} value={conversationMemory.openQuestion} onChange={(event) => setConversationMemory({ ...conversationMemory, openQuestion: event.target.value })} placeholder="What still needs an answer?" /></label><label>Agreed next step<input maxLength={400} value={conversationMemory.promisedNextStep} onChange={(event) => setConversationMemory({ ...conversationMemory, promisedNextStep: event.target.value })} placeholder="Only something you actually agreed to do" /></label><label>What changed since last time<input maxLength={400} value={conversationMemory.changedSinceLast} onChange={(event) => setConversationMemory({ ...conversationMemory, changedSinceLast: event.target.value })} placeholder="New need, decision or timing" /></label></details>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button primary" data-action="email" disabled={saving || !note.trim()}>{saving ? 'Saving…' : 'Add & prepare email'}</button>
        <button className="button secondary" data-action="note" disabled={saving || !note.trim()}>{saving ? 'Saving…' : 'Add conversation'}</button>
      </form>
      <FollowUpComposer key={`${contactId}-${emailDraftVersion}`} contactId={contactId} autoOpen={emailAfterConversation} initialDraft={conversationDraft} onDraftStateChange={handleDraftStateChange} />
      <VoiceNotesPanel contactId={contactId} notes={detail.voiceNotes} onChange={() => void load()} />
      <TaskPlanner contactId={contactId} kind={plannerKind} onKindChange={setPlannerKind} onSaved={() => void load()} />
      <div id="person-manage" className="person-manage"><ArchivePersonPanel contactId={contactId} />
      {(session.workspace.kind === 'personal' || session.workspace.role === 'admin') && <DeletePersonPanel contactId={contactId} />}</div>
    </div></div></section>;
}

function ConversationMemoryCard({ item, contactId, onSaved }: { item: { id: string; summary: string; open_question: string; promised_next_step: string; changed_since_last: string; occurred_at: string; event_name: string | null }; contactId: string; onSaved: () => void }) {
  const { csrfToken, session, notify } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ summary: item.summary, openQuestion: item.open_question, promisedNextStep: item.promised_next_step, changedSinceLast: item.changed_since_last });
  async function save() {
    setBusy(true);
    try { await request(`/api/contacts/${contactId}/conversations/${item.id}/context`, { method: 'PUT', body: JSON.stringify(draft) }, { csrfToken, workspaceId: session.workspace.id }); setEditing(false); onSaved(); notify('Conversation context updated. New drafts can use it. Existing drafts are unchanged.'); }
    catch (issue) { notify((issue as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="memory-history-item"><div className="memory-history-heading"><small>{new Date(item.occurred_at).toLocaleDateString()}{item.event_name ? ` · ${item.event_name}` : ''}</small><button type="button" className="text-button" onClick={() => { setDraft({ summary: item.summary, openQuestion: item.open_question, promisedNextStep: item.promised_next_step, changedSinceLast: item.changed_since_last }); setEditing(!editing); }}>{editing ? 'Cancel' : 'Correct context'}</button></div>{editing ? <div className="memory-edit"><label>Checked summary<textarea rows={2} maxLength={700} value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></label><label>Open question<input maxLength={400} value={draft.openQuestion} onChange={(event) => setDraft({ ...draft, openQuestion: event.target.value })} /></label><label>Agreed next step<input maxLength={400} value={draft.promisedNextStep} onChange={(event) => setDraft({ ...draft, promisedNextStep: event.target.value })} /></label><label>What changed<input maxLength={400} value={draft.changedSinceLast} onChange={(event) => setDraft({ ...draft, changedSinceLast: event.target.value })} /></label><button type="button" className="button secondary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save correction'}</button></div> : <>{item.summary && <p>{item.summary}</p>}{item.open_question && <p><b>Open question:</b> {item.open_question}</p>}{item.promised_next_step && <p><b>Agreed next step:</b> {item.promised_next_step}</p>}{item.changed_since_last && <p><b>What changed:</b> {item.changed_since_last}</p>}</>}</div>;
}

function ArchivePersonPanel({ contactId }: { contactId: string }) {
  const { csrfToken, session, notify } = useWorkspace();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  async function archivePerson() {
    if (!await askConfirm({ title: 'Archive this person?', body: 'Their notes, recordings, and history will stay saved. You can restore them later.', confirmLabel: 'Archive person' })) return;
    setBusy(true);
    try {
      await request(`/api/contacts/${contactId}/archive`, { method: 'PATCH', body: JSON.stringify({ archived: true }) }, { csrfToken, workspaceId: session.workspace.id });
      notify('Person archived. Their history is still saved.');
      navigate('/people?archived=1', { replace: true });
    } catch (error) { notify((error as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="surface-card person-archive-panel"><p className="eyebrow">ARCHIVE PERSON</p><h2>Keep this record, out of the active list.</h2><p>The person, notes, recordings, and history stay saved. You can restore them from People whenever needed.</p><button type="button" className="button secondary" disabled={busy} onClick={() => void archivePerson()}>{busy ? 'Archiving…' : 'Archive person'}</button></section>;
}

function DeletePersonPanel({ contactId }: { contactId: string }) {
  const { session, csrfToken, notify } = useWorkspace();
  const navigate = useNavigate();
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function removePerson() {
    setBusy(true); setError('');
    try {
      const result = await request<{ mediaCleanupPending: number }>(`/api/contacts/${contactId}`, {
        method: 'DELETE', body: JSON.stringify({ confirmation }),
      }, { csrfToken, workspaceId: session.workspace.id });
      if (result.mediaCleanupPending) notify('The person was removed, but some private files still need cleanup. Contact your admin.');
      else notify('Person and their attached event history were deleted.');
      navigate('/people', { replace: true });
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="surface-card person-delete-panel">
    <p className="eyebrow">REMOVE PERSON</p><h2>Delete this person?</h2>
    <p>This removes their details, conversations, notes, recordings, emails, and follow-ups from this workspace. Their company and its other people stay. This cannot be undone.</p>
    <label>Type DELETE to confirm<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button type="button" className="button danger" disabled={busy || confirmation !== 'DELETE'} onClick={() => void removePerson()}>{busy ? 'Deleting…' : 'Delete person'}</button>
  </section>;
}

function formatAtTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
}

function dateInTimeZoneDays(timeZone: string, days: number) {
  const today = formatAtTimeZone(new Date(), timeZone).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(today[0], today[1] - 1, today[2] + days)).toISOString().slice(0, 10);
}

function localTimeInZoneToIso(value: string, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('Choose a date and time.');
  const desired = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  let guess = desired;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess));
    const result = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
    const represented = Date.UTC(result.year, result.month - 1, result.day, result.hour, result.minute);
    const delta = desired - represented;
    guess += delta;
    if (!delta) break;
  }
  if (formatAtTimeZone(new Date(guess), timeZone) !== value) throw new Error('That local time does not exist because the clocks change. Choose another time.');
  return new Date(guess).toISOString();
}

function TaskPlanner({ contactId, kind, onKindChange, onSaved }: { contactId: string; kind: 'follow_up' | 'meeting'; onKindChange: (kind: 'follow_up' | 'meeting') => void; onSaved: () => void }) {
  const { session, csrfToken, notify } = useWorkspace();
  const [timeZone, setTimeZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [dueAt, setDueAt] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [overlap, setOverlap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [suggestionBusy, setSuggestionBusy] = useState(false);
  const [aiSuggestionsAvailable, setAiSuggestionsAvailable] = useState<boolean | null>(null);
  const [suggestion, setSuggestion] = useState<{ daysFromNow: number; note: string; reason: string } | null>(null);
  const [suggestionMessage, setSuggestionMessage] = useState('');
  useEffect(() => {
    void request<{ event: { timeZone: string } | null }>('/api/workspace', {}, { workspaceId: session.workspace.id }).then((result) => {
      const zone = result.event?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      setTimeZone(zone);
      const tomorrow = new Date(Date.now() + 86400000);
      const localDay = formatAtTimeZone(tomorrow, zone).slice(0, 10);
      setDueAt(`${localDay}T10:00`);
    }).catch((issue) => setError((issue as Error).message));
    void request<{ followUpSuggestions: boolean }>('/api/capabilities').then((result) => setAiSuggestionsAvailable(result.followUpSuggestions)).catch(() => setAiSuggestionsAvailable(false));
  }, [session.workspace.id]);
  async function askForSuggestion() {
    setSuggestionBusy(true); setSuggestion(null); setSuggestionMessage('');
    try {
      const result = await request<{ available: boolean; daysFromNow?: number; note?: string; reason?: string; message?: string }>(`/api/contacts/${contactId}/follow-up-suggestion`, { method: 'POST' }, { csrfToken, workspaceId: session.workspace.id });
      if (!result.available || typeof result.daysFromNow !== 'number' || !result.note || !result.reason) {
        setSuggestionMessage(result.message || 'A suggestion could not be prepared. Choose a date and write the next step yourself.');
        return;
      }
      setSuggestion({ daysFromNow: result.daysFromNow, note: result.note, reason: result.reason });
    } catch (issue) { setSuggestionMessage((issue as Error).message); }
    finally { setSuggestionBusy(false); }
  }
  function useSuggestion() {
    if (!suggestion) return;
    const day = dateInTimeZoneDays(timeZone, suggestion.daysFromNow);
    const time = dueAt.split('T')[1] || '10:00';
    onKindChange('follow_up'); setDueAt(`${day}T${time}`); setNote(suggestion.note); setSuggestion(null);
  }
  async function save(allowOverlap = false) {
    setBusy(true); setError('');
    try {
      const instant = localTimeInZoneToIso(dueAt, timeZone);
      await request(`/api/contacts/${contactId}/tasks`, { method: 'POST', body: JSON.stringify({ kind, dueAt: instant, timeZone, note, title: kind === 'meeting' ? 'Meeting' : 'Follow up', allowOverlap }) }, { csrfToken, workspaceId: session.workspace.id });
      setOverlap(false); setNote(''); onSaved(); notify(kind === 'meeting' ? 'Meeting added to this person.' : 'Follow-up added to this person.');
    } catch (issue) {
      const apiError = issue as { code?: string; message?: string };
      setError(apiError.message || 'This next step could not be saved.');
      setOverlap(apiError.code === 'meeting_overlap');
    } finally { setBusy(false); }
  }
  return <form id="person-next-step" className="surface-card planner-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <p className="eyebrow">NEXT STEP</p><h2>Keep the conversation moving.</h2>
    <label>What would you like to add?<select value={kind} onChange={(event) => { onKindChange(event.target.value as typeof kind); setError(''); setOverlap(false); }}><option value="follow_up">Follow-up</option><option value="meeting">Meeting</option></select></label>
    <label>{kind === 'meeting' ? 'Meeting time' : 'Follow-up time'}<input aria-label={kind === 'meeting' ? 'Meeting time' : 'Follow-up time'} type="datetime-local" required value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>
    <small>Time shown in {timeZone}.</small>
    <label>Note (optional)<textarea rows={2} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} placeholder={kind === 'meeting' ? 'What should you cover?' : 'What should you follow up about?'} /></label>
    {aiSuggestionsAvailable && <button type="button" className="text-button suggestion-action" disabled={suggestionBusy} onClick={() => void askForSuggestion()}>{suggestionBusy ? <><Sparkles size={14} className="status-spin" aria-hidden="true" /> Preparing a suggestion…</> : 'Suggest a next step'}</button>}
    {!aiSuggestionsAvailable && aiSuggestionsAvailable !== null && <p className="subtle suggestion-message">AI suggestions are not set up. Choose a date and write the next step yourself.</p>}
    {suggestion && <div className="suggestion-card"><strong>Suggested next step · {suggestion.daysFromNow === 0 ? 'today' : suggestion.daysFromNow === 1 ? 'tomorrow' : `in ${suggestion.daysFromNow} days`}</strong><p>{suggestion.note}</p><small>{suggestion.reason} Nothing has been saved.</small><button type="button" className="button secondary" onClick={useSuggestion}>Use this suggestion</button></div>}
    {suggestionMessage && <p className="subtle suggestion-message" role="status">{suggestionMessage}</p>}
    {error && <p className={overlap ? 'task-warning' : 'form-error'} role="alert">{error}</p>}
    <button className="button primary" disabled={busy || !dueAt}>{busy ? 'Saving…' : kind === 'meeting' ? 'Add meeting' : 'Add follow-up'}</button>
    {overlap && <button type="button" className="button secondary" disabled={busy} onClick={() => void save(true)}>Save meeting anyway</button>}
  </form>;
}

function VoiceNotesPanel({ contactId, notes, onChange }: { contactId: string; notes: Array<{ id: string; transcript: string; summary: string; duration_seconds: number | null; created_at: string }>; onChange: () => void }) {
  const { session, csrfToken } = useWorkspace();
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [clip, setClip] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [localTranscribeId, setLocalTranscribeId] = useState('');
  const [localTranscribeProgress, setLocalTranscribeProgress] = useState('');
  const [transcriptSuggestions, setTranscriptSuggestions] = useState<Record<string, string>>({});
  const [summarySuggestions, setSummarySuggestions] = useState<Record<string, string>>({});
  const [summarizingId, setSummarizingId] = useState('');
  const [transcriptionLanguage, setTranscriptionLanguage] = useState<VoiceLanguage>('english');
  useEffect(() => () => { streamRef.current?.getTracks().forEach((track) => track.stop()); if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setSeconds((value) => {
      if (value >= 119) { recorderRef.current?.stop(); return 120; }
      return value + 1;
    }), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);
  async function startRecording() {
    setError(''); setSeconds(0); setClip(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setError('Voice recording is not available here. Type a note instead.'); return; }
    try {
      if (previewUrl) URL.revokeObjectURL(previewUrl); setPreviewUrl('');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = ['audio/webm;codecs=opus','audio/webm','audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder; chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size) { setClip(blob); setPreviewUrl(URL.createObjectURL(blob)); }
        stream.getTracks().forEach((track) => track.stop()); streamRef.current = null; setRecording(false);
      };
      recorder.start(500); setRecording(true);
    } catch { setError('Microphone access was not available. Type a note instead.'); }
  }
  function stopRecording() { if (recorderRef.current?.state === 'recording') recorderRef.current.stop(); }
  async function saveRecording() {
    if (!clip) return;
    setBusy(true); setError('');
    try {
      const mime = clip.type.split(';')[0] || 'audio/webm';
      await request(`/api/contacts/${contactId}/voice`, { method: 'POST', headers: { 'Content-Type': mime, 'X-Recording-Seconds': String(Math.max(1, seconds)) }, body: clip }, { csrfToken, workspaceId: session.workspace.id });
      if (previewUrl) URL.revokeObjectURL(previewUrl); setPreviewUrl(''); setClip(null); onChange();
      setError('Recording saved. No automatic transcript was made. Check a device transcript or type a note; that text can inform future drafts.');
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  async function saveText(noteId: string, text: string) {
    try { await request(`/api/notes/${noteId}/text`, { method: 'PUT', body: JSON.stringify({ text }) }, { csrfToken, workspaceId: session.workspace.id }); setTranscriptSuggestions((current) => { const next = { ...current }; delete next[noteId]; return next; }); setError('Checked text saved. Future email drafts can use it directly.'); onChange(); }
    catch (issue) { setError((issue as Error).message); }
  }
  async function transcribeSavedNote(noteId: string) {
    setLocalTranscribeId(noteId); setLocalTranscribeProgress('Opening the recording…'); setError('');
    try {
      const response = await fetch(`/api/notes/${noteId}/audio`, { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Workspace-Id': session.workspace.id } });
      if (!response.ok) throw new Error('This recording could not be opened.');
      const text = await transcribeLocally(await response.blob(), setLocalTranscribeProgress, transcriptionLanguage);
      if (!text) throw new Error('No speech was found. Listen and type the note if needed.');
      setTranscriptSuggestions((current) => ({ ...current, [noteId]: text.slice(0, 4000) }));
      setLocalTranscribeProgress('Suggested text is ready. Review it before saving.');
    } catch (issue) { setError((issue as Error).message); setLocalTranscribeProgress(''); }
    finally { setLocalTranscribeId(''); }
  }
  async function suggestSummary(noteId: string) {
    setSummarizingId(noteId); setError('');
    try {
      const result = await request<{ summary: string }>(`/api/notes/${noteId}/summary-suggestion`, { method: 'POST' }, { csrfToken, workspaceId: session.workspace.id });
      setSummarySuggestions((current) => ({ ...current, [noteId]: result.summary }));
      setError('AI suggested a takeaway. Check and save it before it can inform an email draft.');
    } catch (issue) { setError((issue as Error).message); }
    finally { setSummarizingId(''); }
  }
  async function saveSummary(noteId: string, summary: string) {
    try {
      await request(`/api/notes/${noteId}/summary`, { method: 'PUT', body: JSON.stringify({ summary }) }, { csrfToken, workspaceId: session.workspace.id });
      setSummarySuggestions((current) => { const next = { ...current }; delete next[noteId]; return next; });
      setError('Checked takeaway saved. Future email drafts can use it.'); onChange();
    } catch (issue) { setError((issue as Error).message); }
  }
  async function removeVoice(noteId: string) {
    if (!await askConfirm({ title: 'Delete this recording?', body: 'The recording and its saved text will be removed.', confirmLabel: 'Delete recording', danger: true })) return;
    try { await request(`/api/notes/${noteId}`, { method: 'DELETE' }, { csrfToken, workspaceId: session.workspace.id }); onChange(); }
    catch (issue) { setError((issue as Error).message); }
  }
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return <section id="person-voice-note" className="surface-card voice-panel"><p className="eyebrow">VOICE NOTE · OPTIONAL</p><h2>Save the detail in your own words.</h2><p className="voice-disclosure">Record up to two minutes. You can transcribe on this device for free, then check the text, or type it yourself. The speech model downloads on first use; your audio is not sent to its host.</p><label className="voice-language">Recording language<select value={transcriptionLanguage} onChange={(event) => setTranscriptionLanguage(event.target.value as VoiceLanguage)}><option value="english">English</option><option value="hindi">Hindi</option><option value="gujarati">Gujarati</option></select></label>
    {notes.map((item) => <article className="saved-voice" key={item.id}><audio controls preload="none" src={`/api/notes/${item.id}/audio`}>Audio playback is not supported by this browser.</audio><small>{Math.floor((item.duration_seconds ?? 0) / 60)}:{String((item.duration_seconds ?? 0) % 60).padStart(2, '0')} · {new Date(item.created_at).toLocaleDateString()}</small><button type="button" className="button secondary" disabled={Boolean(localTranscribeId)} onClick={() => void transcribeSavedNote(item.id)}>{localTranscribeId === item.id ? 'Transcribing…' : 'Transcribe on this device'}</button>{localTranscribeId === item.id && <p role="status">{localTranscribeProgress}</p>}{transcriptSuggestions[item.id] !== undefined ? <div className="local-transcript-review"><label>Suggested transcript · check before saving<textarea rows={4} maxLength={4000} value={transcriptSuggestions[item.id]} onChange={(event) => setTranscriptSuggestions((current) => ({ ...current, [item.id]: event.target.value }))} /></label><div className="local-transcript-actions"><button type="button" className="button primary" onClick={() => void saveText(item.id, transcriptSuggestions[item.id])}>Save checked text</button><button type="button" className="button secondary" onClick={() => setTranscriptSuggestions((current) => { const next = { ...current }; delete next[item.id]; return next; })}>Discard suggestion</button></div></div> : <label>Text you typed<textarea key={`${item.id}-${item.transcript}`} rows={3} maxLength={4000} defaultValue={item.transcript} onBlur={(event) => { if (event.currentTarget.value !== item.transcript) void saveText(item.id, event.currentTarget.value); }} placeholder="Optional. Type what you want to remember." /></label>}{item.transcript && <div className="voice-summary"><p>Optional: ask AI to suggest the main takeaway from your checked text. This sends that text to Google; you must check its suggestion before saving.</p><button type="button" className="button secondary" disabled={Boolean(summarizingId)} onClick={() => void suggestSummary(item.id)}>{summarizingId === item.id ? 'Finding the takeaway…' : 'Suggest a takeaway'}</button><label>Conversation takeaway<textarea rows={3} maxLength={1000} value={summarySuggestions[item.id] ?? item.summary} onChange={(event) => setSummarySuggestions((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="What they need and what happens next" /></label>{summarySuggestions[item.id] !== undefined && summarySuggestions[item.id] !== item.summary && <button type="button" className="button primary" onClick={() => void saveSummary(item.id, summarySuggestions[item.id])}>Save checked takeaway</button>}</div>}<button type="button" className="text-button danger-text" onClick={() => void removeVoice(item.id)}>Delete recording</button></article>)}
    {clip && <div className="recording-preview"><strong>Review your recording · {clock}</strong><audio controls src={previewUrl || undefined}>Audio playback is not supported by this browser.</audio><button type="button" className="button primary" disabled={busy} onClick={() => void saveRecording()}>{busy ? 'Saving…' : 'Save voice note'}</button><button type="button" className="text-button" onClick={() => { setClip(null); if (previewUrl) URL.revokeObjectURL(previewUrl); setPreviewUrl(''); }}>Discard recording</button></div>}
    {recording ? <div className="recording-controls"><span className="recording-live"><i /> Recording · {clock} / 2:00</span><button type="button" className="button secondary" onClick={stopRecording}>Stop recording</button></div> : !clip && <button type="button" className="button secondary" onClick={() => void startRecording()}><Mic size={16} /> Record voice note</button>}
    {error && <p className="voice-feedback" role="status">{error}</p>}
  </section>;
}

function TasksPage() {
  const { session, csrfToken, notify } = useWorkspace();
  const [tasks, setTasks] = useState<Array<{ id: string; kind: string; status: string; due_at: string; time_zone: string; title: string; note: string; snoozed_until: string | null; contact_id: string; contact_name: string; contact_email: string; company_name: string; event_name: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const load = useCallback(async () => {
    const result = await request<{ tasks: typeof tasks }>('/api/tasks', {}, { workspaceId: session.workspace.id }); setTasks(result.tasks);
  }, [session.workspace.id]);
  useEffect(() => { void load().catch((error) => notify((error as Error).message)).finally(() => setLoading(false)); }, [load, notify]);
  async function act(task: typeof tasks[number], action: 'done' | 'snooze_1' | 'snooze_3' | 'snooze_7' | 'confirm' | 'no_show' | 'cancel') {
    setBusyId(task.id);
    try {
      await request(`/api/tasks/${task.id}/action`, { method: 'POST', body: JSON.stringify({ action }) }, { csrfToken, workspaceId: session.workspace.id });
      await load();
      notify(({ done: 'Marked done.', snooze_1: 'Moved to tomorrow.', snooze_3: 'Moved ahead 3 days.', snooze_7: 'Moved ahead 1 week.', confirm: 'Meeting confirmed.', no_show: 'Meeting marked as no-show.', cancel: 'Meeting cancelled.' })[action]);
    }
    catch (error) { notify((error as Error).message); }
    finally { setBusyId(''); }
  }
  const grouped = { overdue: [] as typeof tasks, today: [] as typeof tasks, upcoming: [] as typeof tasks, done: [] as typeof tasks };
  for (const task of tasks) {
    if (task.status === 'done' || task.status === 'no_show') { grouped.done.push(task); continue; }
    const date = formatAtTimeZone(new Date(task.due_at), task.time_zone).slice(0, 10);
    const today = formatAtTimeZone(new Date(), task.time_zone).slice(0, 10);
    if (date < today) grouped.overdue.push(task);
    else if (date === today) grouped.today.push(task);
    else grouped.upcoming.push(task);
  }
  function renderTask(task: typeof tasks[number]) {
    const meeting = task.kind === 'meeting';
    const terminal = task.status === 'done' || task.status === 'no_show';
    return <article className="task-row" data-task-id={task.id} key={task.id}><span className={`task-kind ${task.kind}`}><Clock3 size={17} /></span><div className="task-copy"><strong>{task.title || (meeting ? 'Meeting' : 'Follow up')} <span className={`task-state ${task.status}`}>{task.status === 'no_show' ? 'No-show' : task.status === 'proposed' ? 'Proposed' : task.status === 'confirmed' ? 'Confirmed' : task.status === 'done' ? 'Done' : ''}</span></strong><small><Link to={`/people/${task.contact_id}`}>{task.contact_name}</Link> · {task.company_name}{task.event_name ? ` · ${task.event_name}` : ''}</small>{task.note && <p>{task.note}</p>}<time>{new Date(task.due_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: task.time_zone || undefined })}{task.snoozed_until ? ' · moved' : ''}</time><InlineVoiceNote contactId={task.contact_id} compact /></div>{!terminal && <div className="task-actions">{!meeting && task.contact_email && <a className="button secondary" href={`mailto:${encodeURIComponent(task.contact_email)}`}>Email</a>}{meeting ? task.status === 'proposed' ? <><button className="button secondary" disabled={busyId === task.id} onClick={() => void act(task, 'confirm')}>Confirm</button><button className="text-button" disabled={busyId === task.id} onClick={() => void act(task, 'cancel')}>Cancel</button></> : <><button className="button secondary" disabled={busyId === task.id} onClick={() => void act(task, 'done')}>Mark done</button><button className="text-button" disabled={busyId === task.id} onClick={() => void act(task, 'no_show')}>No-show</button></> : <><button className="button secondary" disabled={busyId === task.id} onClick={() => void act(task, 'snooze_1')}>1 day</button><button className="button secondary" disabled={busyId === task.id} onClick={() => void act(task, 'snooze_3')}>3 days</button><button className="button secondary" disabled={busyId === task.id} onClick={() => void act(task, 'snooze_7')}>1 week</button><button className="button primary" disabled={busyId === task.id} onClick={() => void act(task, 'done')}>Done</button></>}</div>}</article>;
  }
  const groups: Array<[keyof typeof grouped, string]> = [['overdue','Overdue'], ['today','Today'], ['upcoming','Coming up'], ['done','Done']];
  return <section className="records-view"><div className="page-heading-row"><div><p className="eyebrow">FOLLOW-UPS</p><h1>Keep the next step from slipping.</h1><p className="page-lede">Open follow-ups stay with their person and event. Snoozing moves one to tomorrow.</p></div><Link className="button primary" to="/scan"><ScanLine size={17} /> Add a person</Link></div>
    {loading ? <div className="surface-card records-empty">Loading follow-ups…</div> : groups.map(([key, label]) => <section className="task-group" key={key}><div className="task-group-heading"><h2>{label}</h2><span>{grouped[key].length}</span></div><div className="surface-card task-list">{grouped[key].length ? grouped[key].map(renderTask) : <p className="task-group-empty">{key === 'done' ? 'Finished steps will show here.' : key === 'today' ? 'Nothing due today.' : key === 'overdue' ? 'You are all caught up.' : 'Nothing coming up yet.'}</p>}</div></section>)}
  </section>;
}

type ScanView = {
  id: string;
  clientScanId: string;
  source: string;
  status: 'uploading' | 'queued' | 'reading' | 'ready' | 'failed' | 'saved' | 'discarded';
  extracted: Record<string, unknown> | null;
  uncertain: string[];
  error: string | null;
  queuedAt?: string;
  clientOrder?: number;
  file?: File;
  imageUrl?: string | null;
  materialCompanyId?: string | null;
  contactId?: string | null;
};

const displayStatus: Record<ScanView['status'], string> = {
  ...statusWords.scan,
};

async function shrinkPhoto(file: File) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) { bitmap.close(); throw new Error('This photo could not be prepared. Choose another one.'); }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('This photo could not be prepared. Choose another one.')), 'image/jpeg', 0.9));
  return blob;
}

async function readQrFromImage(blob: Blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const NativeDetector = (window as unknown as { BarcodeDetector?: new (options?: { formats: string[] }) => { detect: (image: ImageBitmap) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
    if (NativeDetector) {
      try {
        const codes = await new NativeDetector({ formats: ['qr_code'] }).detect(bitmap);
        if (codes[0]?.rawValue) { bitmap.close(); return codes[0].rawValue; }
      } catch { /* use the local jsQR fallback */ }
    }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx?.drawImage(bitmap, 0, 0);
    bitmap.close();
    if (!ctx) return null;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return (await decodeQrPixels(pixels.data, pixels.width, pixels.height))?.data ?? null;
  } catch { return null; }
}

async function decodeQrPixels(data: Uint8ClampedArray, width: number, height: number) {
  const { default: decode } = await import('jsqr');
  return decode(data, width, height, { inversionAttempts: 'dontInvert' });
}

function qrFields(raw: string) {
  const value = raw.trim();
  const fields = { name: '', title: '', company: '', email: '', phone: '', website: '', products: [] as string[], topics: [] as string[], uncertain: [] as string[] };
  if (/^BEGIN:VCARD/i.test(value)) {
    for (const line of value.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const key = line.slice(0, colon).split(';')[0].split('.')[0].toUpperCase();
      const content = line.slice(colon + 1).trim();
      if (key === 'FN') fields.name = content;
      else if (key === 'N' && !fields.name) { const [last = '', first = ''] = content.split(';'); fields.name = [first, last].filter(Boolean).join(' '); }
      else if (key === 'ORG') fields.company = content.split(';')[0] ?? '';
      else if (key === 'TITLE') fields.title = content;
      else if (key === 'EMAIL') fields.email = content.toLowerCase();
      else if (key === 'TEL') fields.phone = content;
      else if (key === 'URL') fields.website = content;
    }
  } else if (/^mailto:/i.test(value)) fields.email = value.slice(7).split('?')[0].toLowerCase();
  else if (/^tel:/i.test(value)) fields.phone = value.slice(4).split('?')[0];
  else {
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') fields.website = parsed.href;
    } catch { /* not a supported QR contact value */ }
  }
  return fields;
}

function scanFromApi(scan: Record<string, unknown>): ScanView {
  let extracted = scan.extracted && typeof scan.extracted === 'object' ? scan.extracted as Record<string, unknown> : null;
  return {
    id: String(scan.id), clientScanId: String(scan.clientScanId), source: String(scan.source),
    status: scan.status as ScanView['status'], extracted,
    uncertain: Array.isArray(scan.uncertain) ? scan.uncertain.map(String) : [],
    error: typeof scan.error === 'string' ? scan.error : null,
    queuedAt: typeof scan.queuedAt === 'string' ? scan.queuedAt : undefined,
    imageUrl: scan.mimeType ? `/api/scans/${String(scan.id)}/image` : null,
    materialCompanyId: typeof scan.materialCompanyId === 'string' ? scan.materialCompanyId : null,
    contactId: typeof scan.contactId === 'string' ? scan.contactId : null,
  };
}

function sentence(text: string) {
  const clean = text.trim().replace(/[.…]+$/, '');
  return clean ? `${clean.charAt(0).toUpperCase()}${clean.slice(1)}.` : '';
}

function ScanThumbnail({ item }: { item: ScanView }) {
  const [localUrl, setLocalUrl] = useState('');
  useEffect(() => {
    if (!item.file) { setLocalUrl(''); return; }
    const next = URL.createObjectURL(item.file);
    setLocalUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [item.file]);
  return <div className={`tray-thumb${item.status === 'uploading' || item.status === 'queued' || item.status === 'reading' ? ' is-reading' : ''}`}>{(item.imageUrl || localUrl) && <img src={item.imageUrl || localUrl} alt={item.materialCompanyId ? 'Company brochure photo' : 'Card photo'} />}</div>;
}

function ScanPage() {
  const { session, csrfToken, notify } = useWorkspace();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const emailNowContactId = searchParams.get('emailNow') ?? '';
  const [scans, setScans] = useState<ScanView[]>([]);
  const [cameraError, setCameraError] = useState('');
  const [readingMode, setReadingMode] = useState<'demo' | 'provider' | 'browser' | 'manual' | null>(null);
  useEffect(() => { if (readingMode !== 'browser') return; const timer = window.setTimeout(() => { void warmCardReader().catch(() => undefined); }, 250); return () => window.clearTimeout(timer); }, [readingMode]);
  const [geminiCardsAvailable, setGeminiCardsAvailable] = useState<boolean | null>(null);
  const [captureEvents, setCaptureEvents] = useState<Array<{ id: string; name: string; is_active: number }>>([]);
  const [captureEventId, setCaptureEventId] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [trayError, setTrayError] = useState('');
  const [removingId, setRemovingId] = useState('');
  const inputId = 'capture-gallery';
  const cameraInputId = 'capture-camera';
  const qrCreatedAt = useRef(new Map<string, number>());
  const ocrQueue = useRef<Promise<void>>(Promise.resolve());
  const ocrPendingIds = useRef(new Set<string>());
  const reloadScans = useCallback(async () => {
    const response = await request<{ scans: Array<Record<string, unknown>> }>('/api/scans', {}, { workspaceId: session.workspace.id });
    const serverScans = response.scans.map(scanFromApi);
    setScans((current) => {
      const byClientId = new Map(serverScans.map((item) => [item.clientScanId, item]));
      const presentIds = new Set(current.map((item) => item.clientScanId));
      const refreshed = current.map((item) => {
        const serverItem = byClientId.get(item.clientScanId);
        return serverItem ? { ...serverItem, file: item.file, ...(ocrPendingIds.current.has(item.id) ? { status: 'reading' as const } : {}) } : item;
      });
      const newlyVisible = serverScans.filter((item) => !presentIds.has(item.clientScanId));
      return [...newlyVisible, ...refreshed];
    });
  }, [session.workspace.id]);
  useEffect(() => { void request<{ cardReading: 'demo' | 'provider' | 'browser' | 'manual'; aiCardProvider: string | null }>('/api/capabilities').then((data) => { setReadingMode(data.cardReading); setGeminiCardsAvailable(data.aiCardProvider === 'gemini'); }).catch(() => { setReadingMode('browser'); setGeminiCardsAvailable(false); }); }, []);
  useEffect(() => {
    let active = true;
    void request<{ events: Array<{ id: string; name: string; is_active: number }> }>('/api/events/accessible', {}, { workspaceId: session.workspace.id })
      .then(({ events }) => { if (active) { setCaptureEvents(events); setCaptureEventId(events.find((item) => item.is_active)?.id ?? ''); } })
      .catch(() => { if (active) { setCaptureEvents([]); setCaptureEventId(''); } });
    return () => { active = false; };
  }, [session.workspace.id]);
  useEffect(() => { void reloadScans().catch((error) => setTrayError((error as Error).message)); }, [reloadScans]);
  const pending = scans.some((item) => item.status === 'uploading' || item.status === 'queued' || item.status === 'reading');
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => void reloadScans().catch(() => undefined), 900);
    return () => window.clearInterval(timer);
  }, [pending, reloadScans]);
  useEffect(() => () => stream?.getTracks().forEach((track) => track.stop()), [stream]);

  const addQr = useCallback(async (raw: string) => {
    const fields = qrFields(raw);
    if (!Object.values(fields).some((value) => typeof value === 'string' && value.trim())) return;
    const lastAt = qrCreatedAt.current.get(raw) ?? 0;
    if (Date.now() - lastAt < 12_000) return;
    qrCreatedAt.current.set(raw, Date.now());
    try {
      const response = await request<{ scan: Record<string, unknown>; duplicateQr?: boolean }>('/api/scans/qr', {
        method: 'POST', body: JSON.stringify({ clientScanId: crypto.randomUUID(), fields, ...(captureEventId !== null ? { eventId: captureEventId || null } : {}) }),
      }, { csrfToken, workspaceId: session.workspace.id });
      const scan = scanFromApi(response.scan);
      if (response.duplicateQr) {
        if (scan.contactId) {
          notify('This QR contact is already saved. Add the new conversation to that person.');
          navigate(`/people/${scan.contactId}?newConversation=1&event=${encodeURIComponent(captureEventId ?? '')}`);
        } else {
          notify('These QR details are already waiting for review.');
          navigate(`/review/${scan.id}`);
        }
      } else {
        setScans((items) => [scan, ...items]);
        notify('QR details are ready for your review.');
      }
    } catch (error) { setTrayError((error as Error).message); }
  }, [captureEventId, csrfToken, navigate, notify, session.workspace.id]);

  const uploadFile = useCallback(async (file: File, source: 'camera' | 'gallery', localScan?: ScanView, openReview = false) => {
    const clientScanId = localScan?.clientScanId ?? crypto.randomUUID();
    const localId = localScan?.id ?? `local-${clientScanId}`;
    let uploadedId = localScan?.id && !localScan.id.startsWith('local-') ? localScan.id : '';
    if (!localScan) setScans((items) => [{ id: localId, clientScanId, source, status: 'uploading', extracted: null, uncertain: [], error: null, file }, ...items]);
    setTrayError('');
    try {
      const photo = await shrinkPhoto(file);
      const geminiReady = geminiCardsAvailable ?? await request<{ aiCardProvider: string | null }>('/api/capabilities')
        .then((data) => { const available = data.aiCardProvider === 'gemini'; setGeminiCardsAvailable(available); return available; })
        .catch(() => false);
      const qrPromise = readQrFromImage(photo);
      const uploadHeaders = { 'Content-Type': photo.type, 'X-Client-Scan-Id': clientScanId, 'X-Scan-Source': source, 'X-Client-Order': String(localScan?.clientOrder ?? Date.now() * 10), ...(captureEventId !== null ? { 'X-Event-Id': captureEventId || 'none' } : {}) };
      type UploadResult = { scan: Record<string, unknown>; duplicate: boolean; duplicateImage?: boolean; possibleDuplicate?: boolean };
      let result = await request<UploadResult>('/api/scans', {
        method: 'POST',
        headers: uploadHeaders,
        body: photo,
      }, { csrfToken, workspaceId: session.workspace.id });
      if (result.possibleDuplicate) {
        const candidate = scanFromApi(result.scan);
        const same = await askConfirm({ title: 'This card may already be saved', body: 'It looks like a card already saved for this person. No new photo has been stored yet.', confirmLabel: 'Open their conversations', cancelLabel: 'Keep as a different photo' });
        if (same && candidate.contactId) {
          setScans((items) => items.filter((item) => item.id !== localId));
          navigate(`/people/${candidate.contactId}?newConversation=1&event=${encodeURIComponent(captureEventId ?? '')}`);
          return;
        }
        result = await request<UploadResult>('/api/scans', { method: 'POST', headers: { ...uploadHeaders, 'X-Allow-Similar-Scan': 'true' }, body: photo }, { csrfToken, workspaceId: session.workspace.id });
      }
      const uploaded = scanFromApi(result.scan);
      uploadedId = uploaded.id;
      if (result.duplicateImage) {
        setScans((items) => items.filter((item) => item.id !== localId));
        if (uploaded.contactId) {
          notify('This card is already saved. Add the new conversation to the existing person.');
          navigate(`/people/${uploaded.contactId}?newConversation=1&event=${encodeURIComponent(captureEventId ?? '')}`);
        } else {
          notify('This photo is already waiting for review. Opening the existing copy.');
          navigate(`/review/${uploaded.id}?dialog=1`);
        }
        return;
      }
      setScans((items) => items.map((item) => item.id === localId ? { ...uploaded, file } : item));
      if (openReview && !result.duplicate) navigate(`/review/${uploaded.id}?dialog=1`, { state: { ocrFile: photo, useGeminiCards: geminiReady } });
      if (!openReview && !result.duplicate) {
        ocrPendingIds.current.add(uploaded.id);
        const readTask = ocrQueue.current.then(async () => {
          setScans((items) => items.map((item) => item.id === uploaded.id ? { ...item, status: 'reading', error: null } : item));
          try {
            let fields: ReviewLead | null = null;
            let usedGemini = false;
            try { const read = await readCardInBrowser(photo, () => undefined); if (read.confidence >= 20) fields = read.fields; } catch { /* AI may still help with a difficult photo. */ }
            const needsHelp = needsCardAiFallback(fields);
            if (geminiReady && needsHelp) {
              try { const ai = await request<{ fields: ReviewLead }>(`/api/scans/${uploaded.id}/ai-read`, { method: 'POST' }, { csrfToken, workspaceId: session.workspace.id }); if (Object.values(ai.fields).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value))) { fields = ai.fields; usedGemini = true; } }
              catch { /* Keep the local reading if the provider is unavailable. */ }
            }
            if (!fields || !Object.values(fields).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value))) throw new Error('We couldn’t make out enough text. Type the details during review.');
            await request(`/api/scans/${uploaded.id}/ocr`, { method: 'POST', headers: usedGemini ? { 'X-Read-Source': 'ai' } : undefined, body: JSON.stringify(fields) }, { csrfToken, workspaceId: session.workspace.id });
            setScans((items) => items.map((item) => item.id === uploaded.id ? { ...item, status: 'ready', extracted: fields, uncertain: fields.uncertain, error: null } : item));
          } catch (issue) {
            setScans((items) => items.map((item) => item.id === uploaded.id ? { ...item, status: 'failed', error: (issue as Error).message } : item));
            await request(`/api/scans/${uploaded.id}/ocr-failure`, { method: 'POST' }, { csrfToken, workspaceId: session.workspace.id }).catch(() => undefined);
          } finally {
            ocrPendingIds.current.delete(uploaded.id);
          }
        });
        ocrQueue.current = readTask.then(() => undefined, () => undefined);
        await readTask;
      }
      if (!result.duplicate) {
        const raw = await qrPromise;
        if (raw) {
          const fields = qrFields(raw);
          if (Object.values(fields).some((value) => typeof value === 'string' && value.trim())) {
            await request(`/api/scans/${uploaded.id}/qr`, { method: 'POST', body: JSON.stringify(fields) }, { csrfToken, workspaceId: session.workspace.id });
          }
        }
      }
    } catch (error) {
      const message = (error as Error).message;
      if (!uploadedId) setScans((items) => items.map((item) => item.id === localId ? { ...item, status: 'failed', error: `Upload failed. ${message}` } : item));
      setTrayError(message);
    }
  }, [captureEventId, csrfToken, geminiCardsAvailable, navigate, notify, session.workspace.id]);

  async function addFiles(files: File[], source: 'camera' | 'gallery') {
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (!images.length) { setTrayError('Choose a JPEG, PNG or WebP photo.'); return; }
    if (images.length < files.length) setTrayError('Some files were skipped. Choose image files only.');
    const orderBase = Date.now() * 10;
    const localScans: ScanView[] = images.map((file, index) => {
      const clientScanId = crypto.randomUUID();
      return { id: `local-${clientScanId}`, clientScanId, clientOrder: orderBase + images.length - index, source, status: 'uploading', extracted: null, uncertain: [], error: null, file };
    });
    setScans((items) => [...localScans, ...items]);
    await Promise.all(localScans.map((item) => uploadFile(item.file!, source, item, images.length === 1)));
  }
  async function openCamera() {
    setCameraError('');
    if (!navigator.mediaDevices?.getUserMedia) { setCameraError('Live camera needs a secure page or localhost. Choose a photo instead.'); return; }
    try {
      const next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      setStream(next); setCameraOn(true);
    } catch { setCameraError('Camera access was not available. Choose a photo instead.'); }
  }
  function closeCamera() { stream?.getTracks().forEach((track) => track.stop()); setStream(null); setCameraOn(false); }
  function closeEmailNow() {
    const next = new URLSearchParams(searchParams);
    next.delete('emailNow');
    setSearchParams(next, { replace: true });
  }
  async function discard(item: ScanView) {
    if (item.id.startsWith('local-')) { setScans((items) => items.filter((candidate) => candidate.id !== item.id)); return; }
    setRemovingId(item.id);
    try {
      await request(`/api/scans/${item.id}/discard`, { method: 'POST' }, { csrfToken, workspaceId: session.workspace.id });
      setScans((items) => items.filter((candidate) => candidate.id !== item.id));
    } catch (error) { notify((error as Error).message); }
    finally { setRemovingId(''); }
  }
  const readyCount = scans.filter((item) => item.status === 'ready' || item.status === 'failed').length;
  return <section className="scan-view">
    <div className="page-heading-row"><div><p className="eyebrow">CAPTURE</p><h1>Keep the next conversation.</h1><p className="page-lede">Take a photo, check the details, and move straight to the next person.</p></div></div>
    <div className="capture-event-picker"><div className="capture-event-copy"><label htmlFor="capture-event">Event for this capture</label><span>Keep the conversation with the right event.</span></div><select id="capture-event" value={captureEventId ?? ''} disabled={captureEventId === null} onChange={(event) => setCaptureEventId(event.target.value)}><option value="">No event / other meeting</option>{captureEvents.map((item) => <option key={item.id} value={item.id}>{item.name}{item.is_active ? ' · active' : ''}</option>)}</select></div>
    <div className="scan-layout">
      <section className="surface-card viewfinder-card">
        {cameraOn && stream ? <CameraPreview stream={stream} onClose={closeCamera} onCapture={(file) => void uploadFile(file, 'camera', undefined, true)} onQr={(raw) => void addQr(raw)} /> : <>
          <div className="viewfinder-graphic"><div className="viewfinder-corner tl"></div><div className="viewfinder-corner tr"></div><div className="viewfinder-corner bl"></div><div className="viewfinder-corner br"></div><div className="viewfinder-center"><span className="viewfinder-index">01 / CAPTURE</span><ScanLine size={30} /><strong>Card, brochure, or QR</strong><span>Place it in the frame or choose a photo below.</span></div></div>
          <div className="capture-readiness" role="status"><CircleCheck size={16} aria-hidden="true" /><div><strong>{geminiCardsAvailable === null ? 'Checking reading service…' : 'On-device reading starts at upload'}</strong><span>{geminiCardsAvailable ? 'If local reading misses key details, the photo is sent to Gemini for another suggestion. Google may use free-tier data to improve its products. Check everything before saving.' : 'If reading misses details, type or correct them during review. Nothing is saved until you confirm.'}</span></div></div>
          <div className="capture-actions"><button className="button primary open-live-camera" onClick={() => void openCamera()}><ScanLine size={18} /> Open camera</button><label htmlFor={cameraInputId} className="button secondary capture-camera-action">Take photo</label><input id={cameraInputId} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => { void addFiles(Array.from(event.target.files ?? []), 'camera'); event.currentTarget.value = ''; }} /><label htmlFor={inputId} className="button secondary"><ImagePlus size={18} /> Choose photos</label><input id={inputId} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => { void addFiles(Array.from(event.target.files ?? []), 'gallery'); event.currentTarget.value = ''; }} /></div>
          {cameraError && <p className="form-error" role="status">{cameraError}</p>}
          {trayError && <p className="form-error" role="alert">{trayError}</p>}
          <p className="helper-copy">Choose several photos if needed. Review each one separately before saving.</p>
        </>}
      </section>
      <aside className="surface-card tray-card"><div className="section-head"><div><p className="eyebrow">YOUR TRAY</p><h2>Items to review <span className="count-pill">{readyCount}</span></h2></div><span className="tray-badge">{pending ? 'Working' : 'Ready'}</span></div>
        {scans.length === 0 ? <div className="tray-empty"><span className="empty-icon"><ScanLine size={18} /></span><p>New photos appear here while the camera stays ready.</p></div> : <div className="tray-list">{scans.map((item, index) => {
          const title = item.materialCompanyId ? 'Company brochure' : typeof item.extracted?.name === 'string' && item.extracted.name ? item.extracted.name : item.source === 'qr' ? 'QR code' : `Photo ${scans.length - index}`;
          const reviewable = item.status === 'ready' || item.status === 'failed';
          const working = item.status === 'uploading' || item.status === 'queued' || item.status === 'reading';
          return <div className={`tray-item${working ? ' is-working' : ''}`} key={item.id} data-client-scan-id={item.clientScanId}>
            <ScanThumbnail item={item} />
            <div className="tray-item-copy"><strong>{title}</strong><span className={working ? 'is-working-text' : undefined}><StatusIcon status={item.status} /> {displayStatus[item.status]}</span>{item.error && <small>{item.error}</small>}</div>
            {reviewable && <button className="tray-review" onClick={() => navigate(`/review/${item.id}${item.status === 'failed' ? '?dialog=1' : ''}`)}>Review</button>}
            {item.status === 'saved' && <span className="saved-check" aria-label="Saved"><Check size={17} /></span>}
            {item.status !== 'saved' && <button aria-label={`Discard ${title}`} className="icon-button" disabled={removingId === item.id} onClick={() => void discard(item)}><Trash2 size={16} /></button>}
          </div>;
        })}<p className="honest-note">{readingMode === 'demo' && <span className="demo-reading">Demo reading</span>}{geminiCardsAvailable ? 'Gemini reads new photos first; on-device OCR is the fallback. ' : 'Cards are read on this device. '}Check every detail before saving. Photos upload to your workspace.</p></div>}
      </aside>
    </div>
    {emailNowContactId && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEmailNow(); }}>
      <section className="email-now-dialog" role="dialog" aria-modal="true" aria-labelledby="email-now-title">
        <button type="button" className="icon-button dialog-close" aria-label="Close email draft" onClick={closeEmailNow}><X size={19} /></button>
        <p id="email-now-title" className="visually-hidden">Email this person</p>
        <FollowUpComposer key={emailNowContactId} contactId={emailNowContactId} autoOpen onSkip={closeEmailNow} onComplete={(message) => { closeEmailNow(); notify(message); }} />
      </section>
    </div>}
  </section>;
}

function StatusIcon({ status }: { status: ScanView['status'] }) {
  if (status === 'failed') return <AlertCircle size={14} aria-hidden="true" />;
  if (status === 'saved') return <Check size={14} aria-hidden="true" />;
  if (status === 'ready') return <Check size={14} className="status-pop" aria-hidden="true" />;
  if (status === 'uploading') return <RotateCw size={14} className="status-spin" aria-hidden="true" />;
  return <Sparkles size={14} className="status-pulse" aria-hidden="true" />;
}

function CameraPreview({ stream, onClose, onCapture, onQr }: { stream: MediaStream; onClose: () => void; onCapture: (file: File) => void; onQr: (raw: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastValue = useRef('');
  const missedFrames = useRef(0);
  const busy = useRef(false);
  const [playError, setPlayError] = useState(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    void video.play().catch(() => {
      if (videoRef.current === video) setPlayError(true);
    });
    const NativeDetector = (window as unknown as { BarcodeDetector?: new (options?: { formats: string[] }) => { detect: (image: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
    const detector = NativeDetector ? new NativeDetector({ formats: ['qr_code'] }) : null;
    const timer = window.setInterval(async () => {
      if (busy.current || !video.videoWidth) return;
      busy.current = true;
      try {
        let raw = '';
        if (detector) {
          try { raw = (await detector.detect(video))[0]?.rawValue ?? ''; } catch { /* use jsQR below */ }
        }
        if (!raw) {
          const canvas = canvasRef.current;
          const ctx = canvas?.getContext('2d', { willReadFrequently: true });
          if (canvas && ctx) {
            const scale = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
            canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
            canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
            raw = (await decodeQrPixels(pixels.data, pixels.width, pixels.height))?.data ?? '';
          }
        }
        if (raw) {
          missedFrames.current = 0;
          if (raw !== lastValue.current) { lastValue.current = raw; onQr(raw); }
        } else if (++missedFrames.current >= 4) { lastValue.current = ''; }
      } finally { busy.current = false; }
    }, 700);
    return () => window.clearInterval(timer);
  }, [stream, onQr]);
  function capture() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return;
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob((blob) => { if (blob) onCapture(new File([blob], `card-${Date.now()}.jpg`, { type: 'image/jpeg' })); }, 'image/jpeg', 0.9);
  }
  return <div className="camera-live"><video ref={videoRef} className="camera-video" playsInline muted />{playError && <p className="form-error" role="status">The camera could not start. Close it and choose a photo instead.</p>}<canvas ref={canvasRef} hidden /><div className="camera-controls"><button className="button secondary" onClick={onClose}>Close camera</button><button className="shutter" aria-label="Take photo" onClick={capture}><span /></button><span className="capture-hint">Tap the circle to take a photo · QR codes are read automatically</span></div></div>;
}

type ReviewLead = { name: string; title: string; company: string; email: string; phone: string; website: string; products: string[]; topics: string[]; uncertain: string[] };
const reviewTextFields = ['name', 'title', 'company', 'email', 'phone', 'website'] as const;

function mergeReadLead(current: ReviewLead, incoming: ReviewLead, edited: ReadonlySet<string>): ReviewLead {
  const next = { ...incoming };
  for (const key of reviewTextFields) if (edited.has(key)) next[key] = current[key];
  next.uncertain = incoming.uncertain.filter((key) => !edited.has(key));
  return next;
}
type ProductChoice = { id: string; name: string; description: string };
type ReviewVoiceNoteHandle = { attach: (contactId: string, encounterId?: string) => Promise<boolean | null> };

const InlineVoiceNote = forwardRef<ReviewVoiceNoteHandle, { contactId?: string; compact?: boolean }>(function InlineVoiceNote({ contactId, compact = false }, forwardedRef) {
  const { session, csrfToken } = useWorkspace();
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [clip, setClip] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [manualText, setManualText] = useState('');
  const [localTranscript, setLocalTranscript] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcriptionLanguage, setTranscriptionLanguage] = useState<VoiceLanguage>('english');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setSeconds((value) => {
      if (value >= 119) { recorderRef.current?.stop(); return 120; }
      return value + 1;
    }), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  async function startRecording() {
    setMessage(''); setSeconds(0); setClip(null); setManualText(''); setLocalTranscript(false);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setMessage('Voice recording is not available here. Type a note instead.'); return; }
    try {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl('');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = ['audio/webm;codecs=opus','audio/webm','audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder; chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size) { setClip(blob); setPreviewUrl(URL.createObjectURL(blob)); }
        stream.getTracks().forEach((track) => track.stop()); streamRef.current = null; setRecording(false);
      };
      recorder.start(500); setRecording(true);
    } catch { setMessage('Microphone access was not available. Type a note instead.'); }
  }
  function stopRecording() { if (recorderRef.current?.state === 'recording') recorderRef.current.stop(); }
  async function transcribeClip() {
    if (!clip) return;
    setTranscribing(true); setMessage('Preparing local transcription…');
    try {
      const text = await transcribeLocally(clip, setMessage, transcriptionLanguage);
      if (!text) throw new Error('No speech was found. Listen and type the note if needed.');
      setManualText(text.slice(0, 4000)); setLocalTranscript(true);
      setMessage('Suggested text is ready. Check it before saving the person.');
    } catch (issue) { setMessage((issue as Error).message); }
    finally { setTranscribing(false); }
  }
  async function attach(contact: string, encounterId?: string) {
    if (!clip) return null;
    if (busy) return false;
    const text = manualText.trim();
    let audioSaved = false;
    setBusy(true); setMessage('');
    try {
      const mime = clip.type.split(';')[0] || 'audio/webm';
      const saved = await request<{ id: string }>(`/api/contacts/${contact}/voice`, { method: 'POST', headers: { 'Content-Type': mime, 'X-Recording-Seconds': String(Math.max(1, seconds)), ...(encounterId ? { 'X-Encounter-Id': encounterId } : {}) }, body: clip }, { csrfToken, workspaceId: session.workspace.id });
      audioSaved = true;
      setClip(null); setManualText(''); setPreviewUrl('');
      if (text) await request(`/api/notes/${saved.id}/text`, { method: 'PUT', body: JSON.stringify({ text }) }, { csrfToken, workspaceId: session.workspace.id });
      setMessage(text ? 'Voice note and your text are saved to this person.' : 'Voice note saved. No automatic transcript was made. Transcribe it on the person page or add text yourself.');
      return true;
    } catch (issue) { setMessage(audioSaved ? 'Voice note saved. Your text could not be saved; add it from the person page.' : (issue as Error).message); return audioSaved; }
    finally { setBusy(false); }
  }
  useImperativeHandle(forwardedRef, () => ({ attach }), [clip, busy, manualText, seconds, session.workspace.id, csrfToken]);

  return <div className={compact ? 'inline-voice-note compact' : 'inline-voice-note'}>
    {recording ? <div className="inline-voice-live"><span><Mic size={15} /> Recording · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')} / 2:00</span><button type="button" className="button secondary" onClick={stopRecording}>Stop recording</button></div>
      : !clip && <button type="button" className="button secondary inline-voice-trigger" onClick={() => void startRecording()}><Mic size={16} /> Record voice note</button>}
    {clip && <div className="inline-voice-preview"><audio controls src={previewUrl || undefined}>Audio playback is not supported by this browser.</audio><label className="voice-language">Recording language<select value={transcriptionLanguage} onChange={(event) => setTranscriptionLanguage(event.target.value as VoiceLanguage)}><option value="english">English</option><option value="hindi">Hindi</option><option value="gujarati">Gujarati</option></select></label><button type="button" className="button secondary" disabled={transcribing || busy} onClick={() => void transcribeClip()}>{transcribing ? 'Transcribing here…' : 'Transcribe on this device'}</button><p className="subtle">First use downloads a speech model. Transcription happens on this device; the audio is not sent to its model host.</p><label>{localTranscript ? 'Suggested transcript · check before saving' : 'Text you typed (optional)'}<textarea rows={2} maxLength={4000} value={manualText} onChange={(event) => setManualText(event.target.value)} placeholder="Type what you want to remember." /></label>{contactId ? <button type="button" className="button primary" disabled={busy || transcribing} onClick={() => void attach(contactId)}>{busy ? 'Saving…' : 'Save voice note'}</button> : <p>Keep this card open, then save the person to attach this note.</p>}<button type="button" className="text-button" disabled={busy || transcribing} onClick={() => { setClip(null); setManualText(''); if (previewUrl) URL.revokeObjectURL(previewUrl); setPreviewUrl(''); }}>Discard recording</button></div>}
    {message && <p role="status">{message}</p>}
  </div>;
});

type MatchDecision = { kind: 'person'; candidate: { id: string; name: string; companyName: string } } | { kind: 'company'; candidates: Array<{ id: string; name: string; people_count: number }> };
type CompanySuggestion = { id: string; name: string; people_count: number; reason: 'same domain' | 'same name' | 'similar name' };

function ReviewPage() {
  const { scanId = '' } = useParams();
  const { session, csrfToken, notify } = useWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  const singleCapture = new URLSearchParams(location.search).get('dialog') === '1';
  const captureFile = (location.state as { ocrFile?: Blob } | null)?.ocrFile;
  const useGeminiCards = (location.state as { useGeminiCards?: boolean } | null)?.useGeminiCards === true;
  const [scan, setScan] = useState<Record<string, unknown> | null>(null);
  const [lead, setLead] = useState<ReviewLead>({ name: '', title: '', company: '', email: '', phone: '', website: '', products: [], topics: [], uncertain: [] });
  const [productChoices, setProductChoices] = useState<ProductChoice[]>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [brochureItems, setBrochureItems] = useState('');
  const [note, setNote] = useState('');
  const [quality, setQuality] = useState<'hot' | 'warm' | 'cold' | ''>('');
  const [followUpDate, setFollowUpDate] = useState('');
  const followUpDateInitialized = useRef(false);
  const [decision, setDecision] = useState<MatchDecision | null>(null);
  const [samePersonContactId, setSamePersonContactId] = useState('');
  const [differentPerson, setDifferentPerson] = useState(false);
  const [reviewMode, setReviewMode] = useState<'person' | 'brochure'>('person');
  const [companyChoice, setCompanyChoice] = useState('');
  const [companySuggestions, setCompanySuggestions] = useState<CompanySuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [autoEmailAfterSave, setAutoEmailAfterSave] = useState(false);
  const [emailDismissed, setEmailDismissed] = useState(false);
  const [photoExpanded, setPhotoExpanded] = useState(false);
  const [photoWarning, setPhotoWarning] = useState<string | null>(null);
  const [ocrRunning, setOcrRunning] = useState(Boolean(singleCapture && captureFile));
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrStage, setOcrStage] = useState('Starting the on-device reader…');
  const [aiCardAssist, setAiCardAssist] = useState(false);
  const [aiCardProvider, setAiCardProvider] = useState<string | null>(null);
  const [aiReading, setAiReading] = useState(false);
  const [aiReadMessage, setAiReadMessage] = useState('');
  const editedFields = useRef(new Set<string>());
  const brochureEdited = useRef(false);
  const reviewModeChanged = useRef(false);
  const ocrStartedFor = useRef('');
  const ocrAuth = useRef({ csrfToken, workspaceId: session.workspace.id });
  ocrAuth.current = { csrfToken, workspaceId: session.workspace.id };
  const reviewVoiceRef = useRef<ReviewVoiceNoteHandle>(null);

  useEffect(() => {
    let active = true;
    void request<{ aiCardAssist: boolean; aiCardProvider: string | null }>('/api/capabilities').then((value) => { if (active) { setAiCardAssist(value.aiCardAssist); setAiCardProvider(value.aiCardProvider); } }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    editedFields.current.clear();
    brochureEdited.current = false;
    reviewModeChanged.current = false;
    setScan(null);
    setLead({ name: '', title: '', company: '', email: '', phone: '', website: '', products: [], topics: [], uncertain: [] });
    setNote(''); setQuality(''); setSelectedProductIds([]); setBrochureItems(''); setCompanyChoice(''); setCompanySuggestions([]); setAiReadMessage('');
    setDecision(null); setSamePersonContactId(''); setDifferentPerson(false); setFollowUpDate(''); setAutoEmailAfterSave(false); setEmailDismissed(false); setPhotoExpanded(false);
    followUpDateInitialized.current = false;
  }, [scanId]);

  useEffect(() => {
    let active = true;
    let timer = 0;
    async function load() {
      try {
        const response = await request<{ scan: Record<string, unknown> }>(`/api/scans/${scanId}`, {}, { workspaceId: session.workspace.id });
        if (!active) return;
        const next = response.scan;
        setScan(next);
        if (!followUpDateInitialized.current) {
          const timeZone = typeof next.eventTimeZone === 'string' && next.eventTimeZone ? next.eventTimeZone : 'UTC';
          setFollowUpDate(dateInTimeZoneDays(timeZone, 1));
          followUpDateInitialized.current = true;
        }
        if (!reviewModeChanged.current) setReviewMode(typeof next.materialCompanyId === 'string' && next.materialCompanyId ? 'brochure' : 'person');
        const extracted = next.extracted && typeof next.extracted === 'object' ? next.extracted as Record<string, unknown> : {};
        const materialItems = [...(Array.isArray(extracted.products) ? extracted.products : []), ...(Array.isArray(extracted.topics) ? extracted.topics : [])]
          .filter((item): item is string => typeof item === 'string' && !!item.trim());
        if (!brochureEdited.current) setBrochureItems([...new Set(materialItems)].join('\n'));
        const readLead: ReviewLead = {
          name: String(extracted.name ?? ''), title: String(extracted.title ?? ''),
          company: String(extracted.company ?? ''), email: String(extracted.email ?? ''),
          phone: String(extracted.phone ?? ''), website: String(extracted.website ?? ''),
          products: Array.isArray(extracted.products) ? extracted.products.map(String) : [],
          topics: Array.isArray(extracted.topics) ? extracted.topics.map(String) : [],
          uncertain: Array.isArray(next.uncertain) ? next.uncertain.map(String) : [],
        };
        setLead((current) => mergeReadLead(current, readLead, editedFields.current));
        if (next.status === 'queued' || next.status === 'reading') timer = window.setTimeout(() => void load(), 800);
      } catch (issue) { if (active) setError((issue as Error).message); }
    }
    void load();
    return () => { active = false; window.clearTimeout(timer); };
  }, [scanId, session.workspace.id]);

  useEffect(() => {
    const retrySavedPhoto = !captureFile && scan?.status === 'failed' && typeof scan.mimeType === 'string';
    if (!singleCapture || !scanId || (!captureFile && !retrySavedPhoto) || ocrStartedFor.current === scanId) return;
    ocrStartedFor.current = scanId;
    setOcrRunning(true);
    setError('');
    void (async () => {
      try {
        let photo = captureFile;
        if (!photo) {
          setOcrStage('Opening the uploaded photo on this device…');
          const response = await fetch(`/api/scans/${scanId}/image`, {
            credentials: 'same-origin', cache: 'no-store',
            headers: { 'X-Workspace-Id': ocrAuth.current.workspaceId },
          });
          if (!response.ok) throw new Error('We couldn’t reopen the uploaded photo. Type the details you can see.');
          photo = await response.blob();
        }
        let fields: ReviewLead | null = null;
        let usedGemini = false;
        try { const result = await readCardInBrowser(photo, (progress, stage) => { setOcrProgress(progress); setOcrStage(stage || 'Reading the card…'); }); if (result.confidence >= 20) fields = result.fields; }
        catch { setOcrStage('Local reading could not finish. Checking another option…'); }
        const needsHelp = needsCardAiFallback(fields);
        if (useGeminiCards && needsHelp) {
          try {
            setOcrStage('Checking unclear details with Gemini…');
            const ai = await request<{ fields: ReviewLead }>(`/api/scans/${scanId}/ai-read`, { method: 'POST' }, { csrfToken: ocrAuth.current.csrfToken, workspaceId: ocrAuth.current.workspaceId });
            if (Object.values(ai.fields).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value))) { fields = ai.fields; usedGemini = true; setAiReadMessage('Gemini suggested these details. Compare them with the photo before saving.'); }
          } catch { setOcrStage('Gemini was unavailable. Check the local reading yourself.'); }
        }
        if (!fields || !Object.values(fields).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value))) throw new Error('We couldn’t make out enough text. Type the details you can see.');
        const applied = await request<{ applied: boolean }>(`/api/scans/${scanId}/ocr`, { method: 'POST', headers: usedGemini ? { 'X-Read-Source': 'ai' } : undefined, body: JSON.stringify(fields) }, { csrfToken: ocrAuth.current.csrfToken, workspaceId: ocrAuth.current.workspaceId });
        if (!applied.applied) return;
        const latest = await request<{ scan: { extracted: ReviewLead | null; uncertain: string[] } }>(`/api/scans/${scanId}`, {}, { workspaceId: ocrAuth.current.workspaceId });
        const confirmed = latest.scan.extracted ?? fields;
        setLead((current) => mergeReadLead(current, confirmed, editedFields.current));
        setScan((current) => current ? { ...current, status: 'ready', extracted: confirmed, uncertain: latest.scan.uncertain, error: null } : current);
        setOcrProgress(100);
        setOcrStage('Reading complete. Check every detail against the photo.');
      } catch (issue) {
        const latest = await request<{ scan: { status: string } }>(`/api/scans/${scanId}`, {}, { workspaceId: ocrAuth.current.workspaceId }).catch(() => null);
        if (latest?.scan.status === 'ready' || latest?.scan.status === 'saved') return;
        setError(`${(issue as Error).message} Nothing is saved yet.`);
        setScan((current) => current ? { ...current, status: 'failed' } : current);
        await request(`/api/scans/${scanId}/ocr-failure`, { method: 'POST' }, { csrfToken: ocrAuth.current.csrfToken, workspaceId: ocrAuth.current.workspaceId }).catch(() => undefined);
      } finally { setOcrRunning(false); }
    })();
  }, [captureFile, scan, scanId, singleCapture, useGeminiCards]);

  useEffect(() => {
    if (session.workspace.kind !== 'company') return;
    let active = true;
    void request<{ products: ProductChoice[] }>('/api/products', {}, { workspaceId: session.workspace.id })
      .then((result) => { if (active) setProductChoices(result.products); })
      .catch(() => { if (active) setProductChoices([]); });
    return () => { active = false; };
  }, [session.workspace.id, session.workspace.kind]);

  useEffect(() => {
    if (!lead.company.trim() && !lead.website.trim() && !lead.email.trim()) { setCompanySuggestions([]); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ name: lead.company, website: lead.website, email: lead.email });
      void request<{ companies: CompanySuggestion[] }>(`/api/companies/suggestions?${query}`, {}, { workspaceId: session.workspace.id })
        .then((result) => { if (active) setCompanySuggestions(result.companies); })
        .catch(() => { if (active) setCompanySuggestions([]); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [lead.company, lead.website, lead.email, session.workspace.id]);

  function update(key: keyof ReviewLead, value: string) {
    editedFields.current.add(key);
    if (key === 'company' || key === 'website' || key === 'email') { setCompanyChoice(''); setDecision(null); }
    setLead((current) => ({ ...current, [key]: value, uncertain: current.uncertain.filter((field) => field !== key) }));
  }
  function chooseSuggestedCompany(company: CompanySuggestion) {
    editedFields.current.add('company');
    setDecision(null);
    if (company.reason === 'similar name') setCompanyChoice(company.id);
    else { setLead((current) => ({ ...current, company: company.name })); setCompanyChoice(''); }
  }
  async function improveWithAi() {
    setAiReading(true); setAiReadMessage('');
    try {
      const result = await request<{ fields: ReviewLead; needsReview: boolean }>(`/api/scans/${scanId}/ai-read`, { method: 'POST' }, { csrfToken, workspaceId: session.workspace.id });
      const fields = result.fields;
      const keys = ['name', 'title', 'company', 'email', 'phone', 'website'] as const;
      if (!keys.some((key) => fields[key]?.trim())) throw new Error('AI did not find usable contact details. Type what you can see.');
      setLead((current) => {
        const next = { ...current, uncertain: [...current.uncertain] };
        for (const key of keys) {
          if (!editedFields.current.has(key) && fields[key]?.trim() && (!current[key].trim() || current.uncertain.includes(key))) {
            next[key] = fields[key].trim();
            if (fields.uncertain.includes(key) && !next.uncertain.includes(key)) next.uncertain.push(key);
          }
        }
        return next;
      });
      setAiReadMessage('AI suggested details. Compare them with the photo before saving.');
    } catch (issue) { setAiReadMessage((issue as Error).message); }
    finally { setAiReading(false); }
  }
  function companyMatches() {
    if (!companySuggestions.length || status === 'saved') return null;
    const exact = companySuggestions.some((company) => company.reason !== 'similar name');
    return <div className="company-suggestions" role="group" aria-label="Existing matches"><strong>Existing companies first</strong><div className="company-suggestion-list">{companySuggestions.map((company) => <button type="button" key={company.id} className={companyChoice === company.id ? 'selected' : ''} onClick={() => chooseSuggestedCompany(company)}><Building2 size={17} aria-hidden="true" /><span><b>Add to {company.name}</b><small>{company.people_count} {company.people_count === 1 ? 'person' : 'people'} · {company.reason}</small></span>{companyChoice === company.id && <Check size={17} aria-hidden="true" />}</button>)}</div>{!exact && <button type="button" className="text-button" onClick={() => setCompanyChoice('create')}>This is a different company</button>}</div>;
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const action = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.dataset.saveAction ?? 'stay';
    try {
      const result = await request<Record<string, unknown>>(`/api/scans/${scanId}/save`, {
        method: 'POST', body: JSON.stringify({ name: lead.name, title: lead.title, company: lead.company, email: lead.email, phone: lead.phone, website: lead.website, quality: quality || null, note, followUpDate: followUpDate || null,
          productIds: selectedProductIds, samePersonContactId: samePersonContactId || undefined, differentPerson: differentPerson || undefined, companyChoice: companyChoice || undefined }),
      }, { csrfToken, workspaceId: session.workspace.id });
      if (result.needsSamePerson && result.candidate && typeof result.candidate === 'object') {
        setDecision({ kind: 'person', candidate: result.candidate as { id: string; name: string; companyName: string } });
        return;
      }
      if (result.needsCompanyDecision && Array.isArray(result.candidates)) {
        setDecision({ kind: 'company', candidates: result.candidates as Array<{ id: string; name: string; people_count: number }> });
        return;
      }
      if (!result.saved) throw new Error('The lead was not saved. Check the details and try again.');
      const savedContactId = typeof result.contactId === 'string' ? result.contactId : '';
      const voiceSaved = savedContactId ? await reviewVoiceRef.current?.attach(savedContactId, typeof result.encounterId === 'string' ? result.encounterId : undefined) : null;
      setScan((current) => current ? { ...current, status: 'saved', contactId: savedContactId } : current);
      if (voiceSaved === false) {
        setError('The person was saved, but the voice note was not. Try saving the recording again before moving on.');
        return;
      }
      let afterSaveEmail: 'ask' | 'never' = 'ask';
      if (action === 'stay') {
        try { afterSaveEmail = (await request<{ afterSaveEmail: 'ask' | 'never' }>('/api/preferences/capture', {}, { workspaceId: session.workspace.id })).afterSaveEmail; }
        catch { /* The preference defaults to asking; a settings read must not undo a successful save. */ }
      }
      if (action === 'next') {
        const contactId = typeof result.contactId === 'string' ? result.contactId : '';
        notify('Saved. Ready for the next card.', contactId ? {
          label: 'Email now',
          onClick: () => navigate(`/scan?emailNow=${encodeURIComponent(contactId)}`),
        } : undefined);
        navigate('/scan');
        return;
      }
      setEmailDismissed(false);
      setAutoEmailAfterSave(action === 'email' || (action === 'stay' && afterSaveEmail === 'ask'));
      notify('Saved. You can add a note or follow-up to the next card.');
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  async function saveAndNext() {
    if (!scan || scan.status !== 'saved') return;
    navigate('/scan');
  }
  async function saveMaterial(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await request<Record<string, unknown>>(`/api/scans/${scanId}/material`, {
        method: 'POST', body: JSON.stringify({ company: lead.company, website: lead.website, items: [...new Set(brochureItems.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))].slice(0, 12), companyChoice: companyChoice || undefined }),
      }, { csrfToken, workspaceId: session.workspace.id });
      if (result.needsCompanyDecision && Array.isArray(result.candidates)) {
        setDecision({ kind: 'company', candidates: result.candidates as Array<{ id: string; name: string; people_count: number }> });
        return;
      }
      if (!result.saved) throw new Error('The brochure was not saved. Check the company details and try again.');
      setScan((current) => current ? { ...current, status: 'saved', materialCompanyId: result.companyId, materialCompanyName: result.companyName } : current);
      notify('Brochure saved to the company.');
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  async function discardCurrentScan() {
    if (!scan || (status !== 'ready' && status !== 'failed') || materialAlreadySaved) return;
    setBusy(true); setError('');
    try {
      await request(`/api/scans/${scanId}/discard`, { method: 'POST' }, { csrfToken, workspaceId: session.workspace.id });
      notify('Photo discarded. No person was saved.');
      navigate('/scan');
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  const status = String(scan?.status ?? 'loading');
  const reviewPending = status === 'queued' || status === 'reading' || status === 'loading' || ocrRunning;
  const justRead = useJustFinished(reviewPending, 2400);
  const materialAlreadySaved = typeof scan?.materialCompanyId === 'string' && !!scan.materialCompanyId;
  const fieldsDisabled = status === 'saved' && (reviewMode === 'person' || materialAlreadySaved);
  const ReviewStatusIcon = status === 'failed' ? CircleX : status === 'ready' || status === 'saved' ? CircleCheck : CircleDot;
  return <section className={`review-view${singleCapture ? ' review-dialog-page' : ''}`} role={singleCapture ? 'dialog' : undefined} aria-modal={singleCapture ? true : undefined} aria-labelledby="review-page-title">
    <div className="page-heading-row"><div><p className="eyebrow">CHECK BEFORE SAVING</p><h1 id="review-page-title">{materialAlreadySaved ? 'Brochure saved to the company.' : status === 'saved' ? 'This person is saved.' : reviewMode === 'brochure' ? 'Review this brochure' : 'Review this card'}</h1><p className="page-lede">Compare the details with the photo. Nothing is saved until you confirm.</p></div><Link className="button secondary review-close" to="/scan"><X size={16} aria-hidden="true" />{singleCapture ? 'Close' : 'Back to cards'}</Link></div>
    {error && <p className="form-error review-error" role="alert">{error}</p>}
    {!scan ? <div className="surface-card review-wait"><RotateCw size={19} /><strong>Opening your photo…</strong><p>Review will appear as soon as the upload is ready.</p></div> :
    <div className="review-layout">
      <aside className="surface-card review-source">
        <div className="review-source-heading"><strong>Source photo</strong><span>Tap to enlarge</span></div>
        {Boolean(scan?.mimeType) && <button type="button" className={`review-photo-button${reviewPending ? ' is-scanning' : ''}`} onClick={() => setPhotoExpanded(true)} aria-label="Enlarge uploaded photo"><img src={`/api/scans/${scanId}/image`} onLoad={(event) => setPhotoWarning(photoQualityHint(event.currentTarget))} alt={reviewMode === 'brochure' ? 'Uploaded brochure' : 'Uploaded business card'} /><span>Tap to inspect photo</span></button>}
        {photoWarning && <p className="review-quality-warning" role="status"><AlertCircle size={16} />{photoWarning}</p>}
        {aiReadMessage && <p className="review-read-message" role="status">{aiReadMessage}</p>}
        {aiCardAssist && Boolean(scan?.mimeType) && status !== 'saved' && <details className="ai-card-assist"><summary>Need another read?</summary><p>If details are missing, ask AI to try again. {aiCardProvider === 'gemini' ? 'This sends the photo to Google again; on its free tier, Google may use it to improve products. ' : ''}Check its suggestion against the photo.</p><button type="button" className="button secondary" disabled={aiReading || ocrRunning} onClick={() => void improveWithAi()}>{aiReading ? <><Sparkles size={14} className="status-spin" aria-hidden="true" /> Checking with AI…</> : 'Ask AI to check this photo'}</button></details>}
        {status === 'failed' && !ocrRunning && <div className="manual-entry-note"><AlertCircle size={18} /><div><strong>We couldn’t read this photo.</strong><p>Nothing was guessed. Type the details you can see.</p></div></div>}
      </aside>
      <form id="review-save-form" className="surface-card review-form" onSubmit={(event) => reviewMode === 'brochure' ? void saveMaterial(event) : void submit(event)}>
        {session.workspace.kind === 'company' && typeof scan?.mimeType === 'string' && !materialAlreadySaved && <div className="capture-kind-switch" role="group" aria-label="Save this photo as"><button type="button" className={reviewMode === 'person' ? 'selected' : ''} aria-pressed={reviewMode === 'person'} onClick={() => { reviewModeChanged.current = true; setReviewMode('person'); setDecision(null); }}>Person lead</button><button type="button" className={reviewMode === 'brochure' ? 'selected' : ''} aria-pressed={reviewMode === 'brochure'} onClick={() => { reviewModeChanged.current = true; setReviewMode('brochure'); setDecision(null); setCompanyChoice(''); }}>Company brochure</button></div>}
        <div className="review-form-heading"><div><p className="eyebrow">{reviewMode === 'brochure' ? 'COMPANY MATERIAL' : 'PERSON'}</p><h2>{reviewMode === 'brochure' ? 'Save a brochure' : 'Contact details'}</h2></div><span className={`review-status ${ocrRunning ? 'reading' : status}`}>{ocrRunning ? <RotateCw size={14} aria-hidden="true" /> : <ReviewStatusIcon size={14} aria-hidden="true" />}{ocrRunning ? useGeminiCards ? 'Reading photo' : 'Reading on this device' : displayStatus[status as ScanView['status']] ?? 'Loading…'}</span></div>
        {reviewPending && <div className="review-reading-note" role="status"><RotateCw size={17} aria-hidden="true" /><div><strong>Start checking the photo now.</strong><span>{ocrRunning ? sentence(ocrStage) : 'Reading is starting.'} You can type while it finishes; your edits will stay. Save becomes available when reading ends.</span>{ocrRunning && !ocrStage.includes('Gemini') && <progress className="ocr-progress" max="100" value={ocrProgress} aria-label="On-device reading progress" />}</div></div>}
        {(status === 'ready' || status === 'failed') && <p className="review-check-note"><CircleCheck size={17} aria-hidden="true" /><span>Each field shows what the reader found: suggested, uncertain, or missing. These are not verified facts. Check them against the photo before saving.</span></p>}
        {reviewMode === 'person' && (['name','title','company','email','phone','website'] as const).map((key, index) => <Fragment key={key}><label style={{ '--i': index } as CSSProperties} className={[lead.uncertain.includes(key) ? 'uncertain-field' : '', reviewPending && !lead[key]?.trim() ? 'field-reading' : '', justRead && lead[key]?.trim() ? 'field-arrived' : ''].filter(Boolean).join(' ')}>
          <span>{({ name: 'Name', title: 'Job title', company: 'Company', email: 'Email', phone: 'Phone', website: 'Website' })[key]}{key === 'name' ? ' *' : ''}<em className={lead.uncertain.includes(key) ? '' : 'field-evidence'}>{lead.uncertain.includes(key) ? 'Check this' : lead[key]?.trim() ? 'Suggested' : reviewPending ? 'Reading' : 'Not found'}</em></span>
          <input value={lead[key]} onChange={(event) => update(key, event.target.value)} type={key === 'email' ? 'email' : key === 'phone' ? 'tel' : 'text'} inputMode={key === 'website' ? 'url' : undefined} maxLength={key === 'website' ? 300 : 200} required={key === 'name'} disabled={fieldsDisabled} />
        </label>{key === 'company' && companyMatches()}</Fragment>)}
        {reviewMode === 'brochure' && <><label>Company name<input value={lead.company} onChange={(event) => update('company', event.target.value)} maxLength={160} required disabled={fieldsDisabled} /></label>{companyMatches()}<label>Website<input value={lead.website} onChange={(event) => update('website', event.target.value)} type="text" inputMode="url" maxLength={300} placeholder="example.com" disabled={fieldsDisabled} /></label><label>Products or topics shown <span className="optional-label">one per line; check the words against the photo</span><textarea rows={3} value={brochureItems} maxLength={1500} onChange={(event) => { brochureEdited.current = true; setBrochureItems(event.target.value); }} placeholder="Recyclable cartons" disabled={fieldsDisabled} /></label><p className="subtle">This photo and the details you confirm will be saved under the company, not as a person. Similar company names are shown for confirmation.</p></>}
        {reviewMode === 'person' && (lead.products.length + lead.topics.length > 0) && <div className="extracted-context"><strong>Other details spotted — check before using</strong><p>{[...lead.products, ...lead.topics].join(' · ')}</p></div>}
        {reviewMode === 'person' && productChoices.length > 0 && <fieldset className="product-interest" disabled={fieldsDisabled}><legend>Products of interest <span className="optional-label">tap any they asked about</span></legend><div className="product-interest-options">{productChoices.map((product) => { const selected = selectedProductIds.includes(product.id); return <button type="button" key={product.id} className={`product-interest-chip${selected ? ' selected' : ''}`} aria-pressed={selected} title={product.description} onClick={() => setSelectedProductIds((current) => selected ? current.filter((id) => id !== product.id) : current.length < 12 ? [...current, product.id] : current)}>{selected && <Check size={14} />}{product.name}</button>; })}</div>{selectedProductIds.length === 12 && <small>Up to 12 products can be selected.</small>}</fieldset>}
        {reviewMode === 'person' && <div className="review-voice-field"><span>Voice note <em>optional</em></span><InlineVoiceNote ref={reviewVoiceRef} contactId={typeof scan?.contactId === 'string' ? scan.contactId : undefined} /></div>}
        {reviewMode === 'person' && <><label>Conversation note<textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} maxLength={4000} placeholder="A short note in your own words" disabled={fieldsDisabled} /></label><label>Next follow-up date<input aria-label="Next follow-up date" type="date" value={followUpDate} onChange={(event) => setFollowUpDate(event.target.value)} disabled={fieldsDisabled} /></label><div className="follow-up-presets" role="group" aria-label="Quick follow-up date"><button type="button" aria-pressed={followUpDate === dateInTimeZoneDays(String(scan?.eventTimeZone || 'UTC'), 1)} onClick={() => setFollowUpDate(dateInTimeZoneDays(String(scan?.eventTimeZone || 'UTC'), 1))} disabled={fieldsDisabled}>Tomorrow</button><button type="button" aria-pressed={followUpDate === dateInTimeZoneDays(String(scan?.eventTimeZone || 'UTC'), 2)} onClick={() => setFollowUpDate(dateInTimeZoneDays(String(scan?.eventTimeZone || 'UTC'), 2))} disabled={fieldsDisabled}>In 2 days</button><button type="button" aria-pressed={followUpDate === dateInTimeZoneDays(String(scan?.eventTimeZone || 'UTC'), 7)} onClick={() => setFollowUpDate(dateInTimeZoneDays(String(scan?.eventTimeZone || 'UTC'), 7))} disabled={fieldsDisabled}>Next week</button><button type="button" aria-pressed={!followUpDate} onClick={() => setFollowUpDate('')} disabled={fieldsDisabled}>No follow-up</button></div><div className="field-grid"><label>Lead temperature<select value={quality} onChange={(event) => setQuality(event.target.value as typeof quality)} disabled={fieldsDisabled}><option value="">Not set</option><option value="hot">Hot</option><option value="warm">Warm</option><option value="cold">Cold</option></select></label></div></>}
        {decision?.kind === 'person' && <div className="match-decision" role="group" aria-label="Possible existing person"><strong>This person may already be here</strong><p>{decision.candidate.name} at {decision.candidate.companyName}. Add this conversation to that person?</p><div><button type="button" className="button secondary" onClick={() => { setSamePersonContactId(''); setDifferentPerson(true); setDecision(null); }}>No, this is someone else</button><button type="button" className="button primary" onClick={() => { setSamePersonContactId(decision.candidate.id); setDifferentPerson(false); setDecision(null); }}>Yes, same person</button></div></div>}
        {decision?.kind === 'company' && <div className="match-decision" role="group" aria-label="Possible existing company"><strong>Is this one of these companies?</strong><p>Choosing an existing company keeps people together instead of making duplicates.</p><div className="company-choices">{decision.candidates.map((candidate) => <button type="button" key={candidate.id} className={`company-choice${companyChoice === candidate.id ? ' selected' : ''}`} onClick={() => setCompanyChoice(candidate.id)}><Building2 size={17} /><span><strong>{candidate.name}</strong><small>{candidate.people_count} {candidate.people_count === 1 ? 'person' : 'people'}</small></span><span>{companyChoice === candidate.id ? 'Selected' : 'Choose'}</span></button>)}</div><button type="button" className="text-button" onClick={() => { setCompanyChoice('create'); setDecision(null); }}>No, create a new company</button><button type="button" className="button primary" disabled={!companyChoice || companyChoice === 'create'} onClick={() => setDecision(null)}>Use selected company</button></div>}
        {reviewMode === 'person' && status === 'saved' && !emailDismissed && typeof scan?.contactId === 'string' && <FollowUpComposer contactId={scan.contactId} autoOpen={autoEmailAfterSave} onSkip={() => { setAutoEmailAfterSave(false); setEmailDismissed(true); }} />}
        <div className={`form-footer review-footer${reviewMode === 'person' && status !== 'saved' ? ' review-footer--choice' : ''}`}>
          {status === 'saved' && (reviewMode === 'person' || materialAlreadySaved) ? <>
            <span className="saved-message"><Check size={17} /> {materialAlreadySaved ? `Saved under ${String(scan?.materialCompanyName ?? 'the company')}` : 'Saved to your space'}</span>
            <button type="button" className="button primary" onClick={() => void saveAndNext()}>Next item <ScanLine size={17} /></button>
          </> : reviewMode === 'brochure' ? <>
            <p>This photo will be kept with the company. It won’t create a person record.</p>
            <button className="button primary" disabled={busy || reviewPending}>{busy ? 'Saving…' : 'Save brochure'}</button>
          </> : <>
            <p>Save once, then review a personal email draft. Nothing sends without your approval.</p>
            <div className="review-save-actions">
              <button type="submit" data-save-action="stay" className="button secondary" disabled={busy || reviewPending}>{busy ? 'Saving…' : 'Save person'}</button>
              <button type="submit" data-save-action="email" className="button primary" disabled={busy || reviewPending}>{busy ? 'Saving…' : 'Save & prepare email'}</button>
              <button type="submit" data-save-action="next" className="button secondary review-next-action" disabled={busy || reviewPending}>{busy ? 'Saving…' : 'Save & scan next'} <ScanLine size={17} /></button>
            </div>
          </>}
        </div>
        {(status === 'ready' || status === 'failed') && !materialAlreadySaved && <button type="button" className="text-button review-discard" disabled={busy} onClick={() => void discardCurrentScan()}>Discard</button>}
      </form>
    </div>}
    {Boolean(scan?.mimeType) && photoExpanded && <div className="review-photo-overlay" role="dialog" aria-modal="true" aria-label="Uploaded photo" onKeyDown={(event) => { if (event.key === 'Escape') setPhotoExpanded(false); }}><button type="button" className="button secondary" autoFocus onClick={() => setPhotoExpanded(false)}>Close photo</button><img src={`/api/scans/${scanId}/image`} alt={reviewMode === 'brochure' ? 'Uploaded brochure enlarged' : 'Uploaded business card enlarged'} /></div>}
  </section>;
}

type EmailDraftView = { id: string; recipient: string; subject: string; body: string; status: 'draft' | 'queued' | 'outbox' | 'sent' | 'failed'; generation: 'ai' | 'template' | 'fallback' | 'pending'; sourcesUsed: Array<{ label: string; excerpt: string }> };
function FollowUpComposer({ contactId, autoOpen = false, initialDraft = null, onSkip, onComplete, onDraftStateChange }: { contactId: string; autoOpen?: boolean; initialDraft?: EmailDraftView | null; onSkip?: () => void; onComplete?: (message: string) => void; onDraftStateChange?: (open: boolean) => void }) {
  const { session, csrfToken } = useWorkspace();
  const [draft, setDraft] = useState<EmailDraftView | null>(initialDraft);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const autoOpenStarted = useRef(false);
  const suggestedDraft = useRef<{ subject: string; body: string } | null>(null);
  const locallyEdited = useRef(false);
  const [regenerating, setRegenerating] = useState(false);
  useEffect(() => { if (initialDraft) suggestedDraft.current = { subject: initialDraft.subject, body: initialDraft.body }; }, [initialDraft?.id]);
  useEffect(() => { onDraftStateChange?.(draft?.status === 'draft'); }, [draft?.status, onDraftStateChange]);
  useEffect(() => {
    if (!draft || draft.generation !== 'pending' || draft.status !== 'draft') return;
    let active = true;
    const timer = window.setInterval(() => void request<{ status: string; generation: 'pending' | 'ai' | 'fallback'; subject: string; body: string }>(`/api/emails/${draft.id}`, {}, { workspaceId: session.workspace.id }).then((value) => {
      if (!active || value.generation === 'pending') return;
      setDraft((current) => {
        if (!current || current.id !== draft.id) return current;
        if (locallyEdited.current) return { ...current, generation: value.generation };
        suggestedDraft.current = { subject: value.subject, body: value.body };
        return { ...current, subject: value.subject, body: value.body, generation: value.generation };
      });
    }).catch(() => undefined), 1200);
    return () => { active = false; window.clearInterval(timer); };
  }, [draft?.id, draft?.generation, draft?.status, session.workspace.id]);
  useEffect(() => {
    if (draft?.status !== 'queued') return;
    let active = true;
    const timer = window.setInterval(() => void request<{ status: string }>(`/api/emails/${draft.id}`, {}, { workspaceId: session.workspace.id }).then((value) => {
      if (!active || !['sent','failed'].includes(value.status)) return;
      setDraft((current) => current ? { ...current, status: value.status as 'sent' | 'failed' } : current);
      setMessage(value.status === 'sent' ? 'The mail server accepted it. This does not confirm inbox delivery.' : 'The mail server did not accept it. You can retry.');
    }).catch(() => undefined), 1200);
    return () => { active = false; window.clearInterval(timer); };
  }, [draft?.id, draft?.status, session.workspace.id]);
  async function create() {
    setBusy(true); setError('');
    try {
      const next = await request<EmailDraftView>(`/api/contacts/${contactId}/email-draft`, { method: 'POST' }, { csrfToken, workspaceId: session.workspace.id });
      suggestedDraft.current = { subject: next.subject, body: next.body };
      locallyEdited.current = false;
      setDraft(next);
    }
    catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!autoOpen || initialDraft || autoOpenStarted.current) return;
    autoOpenStarted.current = true;
    void create();
  }, [autoOpen, contactId]);
  async function tryAnotherVersion() {
    if (!draft) return;
    const changed = !!suggestedDraft.current && (draft.subject !== suggestedDraft.current.subject || draft.body !== suggestedDraft.current.body);
    if (changed && !await askConfirm({ title: 'Replace your edits?', body: 'Another suggestion will replace the unsent edits you made.', confirmLabel: 'Replace with new version' })) return;
    setBusy(true); setRegenerating(true); setError(''); setMessage('');
    try {
      const next = await request<{ id: string; recipient: string; subject: string; body: string; status: 'draft'; generation: 'ai' | 'template' | 'fallback'; sourcesUsed: Array<{ label: string; excerpt: string }> }>(`/api/emails/${draft.id}/alternate`, { method: 'POST' }, { csrfToken, workspaceId: session.workspace.id });
      suggestedDraft.current = { subject: next.subject, body: next.body };
      locallyEdited.current = false; setDraft(next); setMessage('Another suggested version. Check it before sending.');
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); setRegenerating(false); }
  }
  async function send() {
    if (!draft) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await request<{ status: 'queued' | 'outbox'; message: string }>(`/api/emails/${draft.id}/send`, { method: 'POST', body: JSON.stringify({ subject: draft.subject, body: draft.body }) }, { csrfToken, workspaceId: session.workspace.id });
      setDraft({ ...draft, status: result.status }); setMessage(result.message);
      onComplete?.(result.message);
    } catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  async function saveOnly() {
    if (!draft) return;
    setBusy(true); setError('');
    try { await request(`/api/emails/${draft.id}`, { method: 'PUT', body: JSON.stringify({ subject: draft.subject, body: draft.body }) }, { csrfToken, workspaceId: session.workspace.id }); setMessage('Draft saved. Nothing was sent. Find it in Email Desk.'); }
    catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  async function retry() {
    if (!draft) return;
    setBusy(true); setError('');
    try { await request(`/api/emails/${draft.id}/retry`, { method: 'POST' }, { csrfToken, workspaceId: session.workspace.id }); setDraft({ ...draft, status: 'queued' }); setMessage('Retry queued for the mail server.'); }
    catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  async function copyOutbox() {
    if (!draft) return;
    try { await navigator.clipboard.writeText(`To: ${draft.recipient}\nSubject: ${draft.subject}\n\n${draft.body}`); setMessage('Copied. Nothing was sent.'); }
    catch { setError('Could not copy this message. Select the text above and copy it yourself.'); }
  }
  const missingEmail = error === 'Add an email address before creating a draft.';
  const edited = !!draft && !!suggestedDraft.current && (draft.subject !== suggestedDraft.current.subject || draft.body !== suggestedDraft.current.body);
  const aiPending = draft?.status === 'draft' && draft.generation === 'pending';
  const aiWorking = aiPending || regenerating;
  const aiArrived = useJustFinished(aiWorking, 2600, draft?.id) && draft?.generation === 'ai' && !edited;
  const fieldsWriting = regenerating || (aiPending && !edited);
  return <div id="person-email" className="email-compose"><div className="section-head"><div><p className="eyebrow">OPTIONAL FOLLOW-UP</p><h2>Email</h2></div>{!draft && !autoOpen && <button type="button" className="button secondary" disabled={busy} onClick={() => void create()}><Mail size={16} />{busy ? 'Preparing…' : 'Draft an email'}</button>}</div>
    {!draft && busy && <AiDraftSkeleton label="Preparing your draft" />}
    {error && !missingEmail && <p className="form-error" role="alert">{error}</p>}
    {autoOpen && missingEmail && <div className="email-state" role="status"><p>There’s no email address on this person yet. Nothing was sent.</p><button type="button" className="text-button" onClick={onSkip}>Skip email</button></div>}
    {draft && <><AiWritingBar writing={aiWorking} tookOver={aiPending && edited && !regenerating} arrived={aiArrived} title={regenerating ? 'Writing another version' : undefined} /><p className="email-recipient">To {draft.recipient}</p>{draft.sourcesUsed.length > 0 && <div className="email-sources"><strong>Draft uses</strong>{draft.sourcesUsed.map((source) => <p key={`${source.label}-${source.excerpt}`}><span>{source.label}:</span> {source.excerpt}</p>)}</div>}<label className={fieldsWriting ? 'ai-writing-field' : aiArrived ? 'ai-arrived' : undefined}>Subject<input value={draft.subject} maxLength={200} onChange={(event) => { locallyEdited.current = true; setDraft({ ...draft, subject: event.target.value }); }} disabled={draft.status !== 'draft' || regenerating} /></label><label className={fieldsWriting ? 'ai-writing-field' : aiArrived ? 'ai-arrived' : undefined}>Message<textarea rows={7} maxLength={8000} value={draft.body} aria-busy={fieldsWriting} onChange={(event) => { locallyEdited.current = true; setDraft({ ...draft, body: event.target.value }); }} disabled={draft.status !== 'draft' || regenerating} /></label><div className="email-compose-footer"><span className="email-state" role="status">{message || (draft.status === 'draft' ? draft.generation === 'ai' ? 'AI suggested draft. Check and edit it before sending.' : draft.generation === 'pending' ? 'Draft ready now. AI is preparing another suggestion; your edits will stay yours.' : draft.generation === 'fallback' ? 'AI could not prepare a draft. Template text is ready; edit it before sending.' : 'Template draft. AI is not set up; edit it before sending.' : statusWords.email[draft.status])}</span>{draft.status === 'draft' && <button type="button" className="button secondary" disabled={busy} onClick={() => void tryAnotherVersion()}>Try another version</button>}{draft.status === 'draft' && <button type="button" className="button secondary" disabled={busy || !draft.subject.trim() || !draft.body.trim()} onClick={() => void saveOnly()}>Save draft</button>}{draft.status === 'draft' && <button type="button" className="button primary" disabled={busy || !draft.subject.trim() || !draft.body.trim()} onClick={() => void send()}>{busy ? 'Saving…' : 'Approve email'}</button>}{draft.status === 'draft' && autoOpen && <button type="button" className="text-button" onClick={onSkip}>Skip</button>}{draft.status === 'failed' && <button type="button" className="button secondary" disabled={busy} onClick={() => void retry()}>{busy ? 'Retrying…' : 'Retry send'}</button>}</div>{draft.status === 'outbox' && <div className="outbox-actions"><a className="button secondary" href={`mailto:${encodeURIComponent(draft.recipient)}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`}>Open in my email app</a><button type="button" className="button secondary" onClick={() => void copyOutbox()}>Copy email</button></div>}</>}
  </div>;
}
