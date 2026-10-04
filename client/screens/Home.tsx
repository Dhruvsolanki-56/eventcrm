import { lazy, Suspense, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowRight, Check, Clock3, Mail, ScanLine, Users } from 'lucide-react';
import { request } from '../api.js';
import { InstallPrompt } from '../install-app.js';
import { useWorkspace } from '../workspace-context.js';
import { CountUp, greetingFor } from '../ui/motion.js';

const OverviewActivity = lazy(() => import('../AnalyticsPage.js').then((module) => ({ default: module.OverviewActivity })));

type Dashboard = {
  counts: { captured_today: number; waiting_review: number; drafts_ready: number; follow_ups_due: number; replies: number };
  due: Array<{ id: string; title: string; due_at: string; time_zone: string; kind: string; contact_id: string; contact_name: string; company_name: string }>;
  nextReviewScanId: string | null; hasPersonalizationDetails: boolean; timeZone: string;
};

export function HomePage({ onShowTour }: { onShowTour: () => void }) {
  const { session, notify } = useWorkspace();
  const isPersonal = session.workspace.kind === 'personal';
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  useEffect(() => { void request<Dashboard>('/api/dashboard', {}, { workspaceId: session.workspace.id }).then(setDashboard).catch((error) => notify((error as Error).message)); }, [session.workspace.id, notify]);

  const nextAction = dashboard?.counts.waiting_review
    ? dashboard.nextReviewScanId
      ? { title: `${dashboard.counts.waiting_review} ${dashboard.counts.waiting_review === 1 ? 'card is' : 'cards are'} waiting for review.`, body: 'Check each detail before you save it.', label: 'Review next card', href: `/review/${dashboard.nextReviewScanId}`, icon: ScanLine }
      : { title: 'Your card is being read now.', body: 'You can keep capturing while it finishes.', label: 'Open Capture', href: '/scan', icon: ScanLine }
    : dashboard?.counts.drafts_ready
      ? { title: `${dashboard.counts.drafts_ready} ${dashboard.counts.drafts_ready === 1 ? 'email draft is' : 'email drafts are'} ready to review.`, body: 'Check the conversation and message before you decide whether to send.', label: 'Review drafts', href: '/email', icon: Mail }
      : dashboard?.counts.follow_ups_due
        ? { title: `${dashboard.counts.follow_ups_due} ${dashboard.counts.follow_ups_due === 1 ? 'follow-up needs' : 'follow-ups need'} attention.`, body: 'Today’s and overdue conversations are ready for you.', label: 'Open follow-ups', href: '/follow-ups', icon: Clock3 }
        : dashboard && !dashboard.hasPersonalizationDetails
          ? { title: isPersonal ? 'Add a little about yourself.' : 'Add what you sell so emails sound like you.', body: 'A few short details help make your messages more useful.', label: isPersonal ? 'Add your details' : 'Add work details', href: '/settings', icon: Users }
          : { title: 'Start with the card you just collected.', body: 'Take a photo or choose a picture. Check each detail before it is saved.', label: 'Open camera', href: '/scan', icon: ScanLine };
  const NextIcon = nextAction.icon;
  const waiting = (dashboard?.counts.waiting_review ?? 0) + (dashboard?.counts.drafts_ready ?? 0) + (dashboard?.counts.follow_ups_due ?? 0);
  const lede = !dashboard ? 'Capture the conversation, prepare a personal email, and keep moving.'
    : waiting ? `You have ${waiting} ${waiting === 1 ? 'thing' : 'things'} to look at today. Nothing is sent without you.` : 'You are all caught up. Capture the next conversation when you are ready.';

  return <section className="home">
    <InstallPrompt />
    <header className="home-head">
      <div><p className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p><h1>{greetingFor()}, {session.user.name.split(' ')[0]}.</h1><p className="page-lede">{lede}</p></div>
      <Link className="button primary" to="/scan"><ScanLine size={18} /> Capture a card</Link>
    </header>
    <section className="next-action-card route-enter">
      <div className="action-illustration"><NextIcon size={28} strokeWidth={1.6} /></div>
      <div className="action-copy"><span className="eyebrow">NEXT UP</span><h2>{nextAction.title}</h2><p>{nextAction.body}</p></div>
      <Link className="button primary" to={nextAction.href}>{nextAction.label} <ArrowRight size={16} /></Link>
    </section>
    <section className="metric-grid stagger" aria-label="Today's summary">
      <Link to="/people" className="metric-card"><span className="metric-top"><span className="metric-icon"><Users size={16} /></span>{isPersonal ? 'People saved today' : 'Leads captured today'}</span><strong className="metric-number"><CountUp value={dashboard?.counts.captured_today} /></strong><small>In your event’s time zone</small></Link>
      <Link to={dashboard?.nextReviewScanId ? `/review/${dashboard.nextReviewScanId}` : '/scan'} className="metric-card tone-amber"><span className="metric-top"><span className="metric-icon"><ScanLine size={16} /></span>Waiting for review</span><strong className="metric-number"><CountUp value={dashboard?.counts.waiting_review} /></strong><small>Each one checked by you</small></Link>
      <Link to="/follow-ups" className="metric-card tone-info"><span className="metric-top"><span className="metric-icon"><Clock3 size={16} /></span>Follow-ups due</span><strong className="metric-number"><CountUp value={dashboard?.counts.follow_ups_due} /></strong><small>Today and overdue</small></Link>
      <Link to="/email" className="metric-card"><span className="metric-top"><span className="metric-icon"><Mail size={16} /></span>Drafts to review</span><strong className="metric-number"><CountUp value={dashboard?.counts.drafts_ready} /></strong><small>Nothing sends on its own</small></Link>
    </section>
    <div className="home-grid">
      {(isPersonal || ['admin', 'manager'].includes(session.workspace.role)) && <Suspense fallback={<div className="analytics-loading">Loading activity…</div>}><OverviewActivity /></Suspense>}
      <article className="panel today-card"><div className="panel-head"><div><p className="eyebrow">YOUR EVENT</p><h2>Follow-ups to handle</h2></div><Link to="/scan" className="subtle-link">Add a person</Link></div>
        {dashboard?.due.length ? <div className="due-list">{dashboard.due.map((task) => <div className="due-item" key={task.id}><span className="due-dot"></span><div><strong>{task.contact_name}</strong><small>{task.title || (task.kind === 'meeting' ? 'Meeting' : 'Follow up')} · {task.company_name}</small></div><time>{new Date(task.due_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: task.time_zone || dashboard.timeZone })}</time></div>)}</div>
          : <div className="empty-inline"><span className="empty-icon"><Check size={18} /></span><p>{dashboard ? 'No follow-ups due yet. Save a person and choose when to check in.' : 'Loading your follow-ups…'}</p></div>}
      </article>
      <article className="panel setup-panel"><div className="panel-head"><div><p className="eyebrow">MAKE IT SOUND LIKE YOU</p><h2>{isPersonal ? 'Add a little about yourself' : 'Add what your team sells'}</h2></div></div><p>A few useful details help make email drafts feel personal. You can skip this and add them later.</p><Link className="button secondary" to="/setup">Continue first-time setup</Link></article>
    </div>
    <button className="quiet-tour" onClick={onShowTour}>Show me around</button>
  </section>;
}

export function NotFoundPage() {
  return <section className="not-found-view"><span className="empty-icon"><AlertCircle size={18} /></span><p className="eyebrow">NOT FOUND</p><h1>That page isn’t here.</h1><p className="page-lede">Go back to your workspace or start with Capture.</p><div><Link className="button secondary" to="/home">Go to Home</Link><Link className="button primary" to="/scan"><ScanLine size={17} /> Open Capture</Link></div></section>;
}
