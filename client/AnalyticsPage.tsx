import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, CalendarDays, RefreshCw } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AnalyticsData } from '../shared/analytics.js';
import { request, saveDownload } from './api.js';
import { Skeleton } from './skeletons.js';
import { useWorkspace } from './workspace-context.js';

const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value / 100);
const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const colors = ['#447767', '#739886', '#9eb7aa', '#d1ddd6'];

function useAnalytics(days: string, eventId: string, refresh: number) {
  const { session } = useWorkspace();
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void request<AnalyticsData>(`/api/analytics?${new URLSearchParams({ days, eventId })}`, {}, { workspaceId: session.workspace.id })
      .then((value) => { if (active) setData(value); })
      .catch((issue) => { if (active) { setError((issue as Error).message); setData(null); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [session.workspace.id, days, eventId, refresh]);
  return { data, error, loading };
}

function ActivityChart({ data, metric = 'people' }: { data: AnalyticsData; metric?: 'people' | 'conversations' }) {
  return <div className="analytics-chart" role="img" aria-label={`Daily ${metric} from ${data.period.from} to ${data.period.to}. ${data.metrics[metric]} in the selected period.`}>
    <ResponsiveContainer width="100%" height="100%"><AreaChart data={data.daily} margin={{ top: 12, right: 8, left: -24, bottom: 0 }}>
      <CartesianGrid vertical={false} stroke="#e9ece9" strokeDasharray="3 4" />
      <XAxis dataKey="day" axisLine={false} tickLine={false} minTickGap={32} tick={{ fill: '#7c8580', fontSize: 11 }} tickFormatter={(day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} dy={10} />
      <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fill: '#7c8580', fontSize: 11 }} />
      <Tooltip contentStyle={{ border: '1px solid #dfe5df', borderRadius: 8, fontSize: 12, boxShadow: '0 4px 16px #18291d12' }} labelFormatter={(day) => String(day)} />
      <Area type="linear" dataKey={metric} name={metric === 'people' ? 'People met' : 'Conversations'} stroke="#447767" strokeWidth={2.2} fill="#eaf1ec" fillOpacity={1} activeDot={{ r: 4, stroke: '#fff', strokeWidth: 2 }} isAnimationActive={false} />
    </AreaChart></ResponsiveContainer>
  </div>;
}

function RecentPeople({ data }: { data: AnalyticsData }) {
  return <div className="analytics-table-wrap"><table className="analytics-table"><thead><tr><th>Person</th><th>Company</th><th>Stage</th><th>Last conversation</th></tr></thead><tbody>
    {data.recent.map((person) => <tr key={person.id}><td><Link to={`/people/${person.id}`}><span className="record-monogram">{person.name.split(' ').map((part) => part[0]).slice(0,2).join('')}</span>{person.name}<ArrowUpRight size={13} /></Link></td><td>{person.company}</td><td><span className={`analytics-stage stage-${person.stage}`}><i />{label(person.stage)}</span></td><td>{new Date(person.lastEncounter).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: data.period.timeZone })}</td></tr>)}
    {!data.recent.length && <tr><td colSpan={4} className="analytics-empty">No conversations in this period. Try another date range or scan your next card.</td></tr>}
  </tbody></table></div>;
}

export function OverviewActivity() {
  const { data, error } = useAnalytics('30', '', 0);
  if (error) return <p className="form-error">{error}</p>;
  if (!data) return <Skeleton variant="tiles" label="Loading workspace activity" rows={8} />;
  return <div className="overview-insights">
    <article className="insight-panel overview-activity"><div className="insight-heading"><div><h2>Capture activity</h2><p>People met each day · last 30 days</p></div><Link to="/analytics" className="subtle-link">Analytics <ArrowUpRight size={14} /></Link></div><div className="chart-total"><strong>{data.metrics.people}</strong><span>people across {data.metrics.companies} companies</span></div><ActivityChart data={data} /></article>
    <article className="insight-panel overview-pipeline"><div className="insight-heading"><div><h2>Conversation stages</h2><p>Current status of people met in the last 30 days</p></div></div><div className="stage-bars">{data.stages.map((item) => <div className="stage-bar-row" key={item.stage}><span><i className={`stage-dot stage-${item.stage}`} />{label(item.stage)}</span><div><i style={{ width: `${data.metrics.people ? item.people / data.metrics.people * 100 : 0}%` }} /></div><strong>{item.people}</strong></div>)}</div><Link to="/people" className="panel-footer-link">View people <ArrowRight size={14} /></Link></article>
  </div>;
}

export default function AnalyticsPage() {
  const [params, setParams] = useSearchParams();
  const days = ['7','30','90'].includes(params.get('days') ?? '') ? params.get('days')! : '30';
  const eventId = params.get('event') ?? '';
  const [refresh, setRefresh] = useState(0);
  const [metric, setMetric] = useState<'people' | 'conversations'>('people');
  const { data, error, loading } = useAnalytics(days, eventId, refresh);
  function filter(key: string, value: string) { const next = new URLSearchParams(params); value ? next.set(key, value) : next.delete(key); setParams(next); }
  function exportData() {
    if (!data || loading) return;
    const rows = [['Date', 'People met', 'Conversations'], ...data.daily.map((row) => [row.day, row.people, row.conversations])];
    saveDownload(new Blob([rows.map((row) => row.join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }), `gather-activity-${data.period.from}-${data.period.to}.csv`);
  }
  const change = data ? data.metrics.people - data.metrics.previousPeople : 0;
  return <section className="analytics-view">
    <div className="page-heading-row"><div><h1>Analytics</h1></div><button className="button secondary" disabled={!data || loading} onClick={exportData}><ArrowDownToLine size={15} /> Export activity</button></div>
    <div className="analytics-toolbar"><div className="analytics-section-label"><span className="status-pip" /> Workspace overview</div><div className="analytics-filters"><label><span className="sr-only">Analytics event</span><select value={eventId} onChange={(event) => filter('event', event.target.value)}><option value="">All accessible events</option>{data?.events.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}</select></label><label><CalendarDays size={14} /><span className="sr-only">Analytics period</span><select value={days} onChange={(event) => filter('days', event.target.value)}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select></label><button className="icon-button" aria-label="Refresh analytics" disabled={loading} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={15} /></button></div></div>
    {error && <div className="form-error" role="alert">{error} <button className="text-button" onClick={() => { setParams({}); setRefresh((value) => value + 1); }}>Reset filters and retry</button></div>}
    {loading && <p className="analytics-loading" role="status">Updating analytics…</p>}
    {data && <div className={loading ? 'analytics-content is-loading' : 'analytics-content'} aria-busy={loading}>
      <div className="analytics-kpis">
        <article><span>People met</span><strong>{data.metrics.people}</strong><small className={change > 0 ? 'positive' : ''}>{change > 0 ? '+' : ''}{change} vs. previous {days} days</small></article>
        <article><span>Companies reached</span><strong>{data.metrics.companies}</strong><small>Distinct company records</small></article>
        <article><span>Open deal value</span><strong>{money(data.metrics.openValue)}</strong><small>Current value · USD</small></article>
        <article><span>Won deal value</span><strong>{money(data.metrics.wonValue)}</strong><small>{data.metrics.wonCompanies} won {data.metrics.wonCompanies === 1 ? 'company' : 'companies'} · USD</small></article>
      </div>
      <article className="insight-panel workflow-panel"><div className="insight-heading"><div><h2>Capture to email</h2><p>Each count is an observed step during this period, not a single-person conversion funnel.</p></div><Link to="/email" className="subtle-link">Open Email Desk <ArrowUpRight size={14} /></Link></div><div className="workflow-steps">{([['Captured', data.workflow.captured], ['Reviewed & saved', data.workflow.reviewed], ['Draft prepared', data.workflow.draftsPrepared], ['User approved', data.workflow.userApproved], ['Mail server accepted', data.workflow.serverAccepted], ['Reply recorded', data.workflow.repliesRecorded]] as const).map(([name, count]) => <div key={name}><strong>{count}</strong><span>{name}</span></div>)}</div><p className="chart-note">Median capture to saved review: {data.workflow.medianCaptureToReviewMinutes === null ? 'Not enough data' : `${data.workflow.medianCaptureToReviewMinutes} min`} · Conversation to draft: {data.workflow.medianConversationToDraftMinutes === null ? 'Not enough data' : `${data.workflow.medianConversationToDraftMinutes} min`}. Mail-server acceptance does not prove inbox delivery. Replies count only a manually recorded reply linked to an accepted email.</p><div className="analytics-table-wrap"><table className="analytics-table"><thead><tr><th>Event</th><th>Captured</th><th>Saved</th><th>Drafts</th><th>Approved</th><th>Server accepted</th><th>Replies</th></tr></thead><tbody>{data.workflow.events.map((event) => <tr key={event.id}><td>{event.name}</td><td>{event.captured}</td><td>{event.reviewed}</td><td>{event.draftsPrepared}</td><td>{event.userApproved}</td><td>{event.serverAccepted}</td><td>{event.repliesRecorded}</td></tr>)}{!data.workflow.events.length && <tr><td colSpan={7} className="analytics-empty">No workflow steps recorded in this period.</td></tr>}</tbody></table></div></article>
      <div className="analytics-main-grid">
        <article className="insight-panel activity-panel"><div className="insight-heading"><div><h2>Capture activity</h2><p>Daily activity across the selected events</p></div><div className="chart-switch" aria-label="Chart measure"><button aria-pressed={metric === 'people'} onClick={() => setMetric('people')}>People</button><button aria-pressed={metric === 'conversations'} onClick={() => setMetric('conversations')}>Conversations</button></div></div><div className="chart-total"><strong>{data.metrics[metric]}</strong><span>{metric === 'people' ? 'unique people in this period' : 'saved conversations in this period'}</span></div><ActivityChart data={data} metric={metric} /><p className="chart-note">A person can appear on multiple days. The period total counts each person once.</p></article>
        <article className="insight-panel quality-panel"><div className="insight-heading"><div><h2>Lead quality</h2><p>Based on the ratings your team saved</p></div></div><div className="quality-donut" style={{ background: data.metrics.people ? `conic-gradient(${data.quality.map((item,index) => { const before = data.quality.slice(0,index).reduce((sum,row) => sum+row.people,0)/data.metrics.people*100; return `${colors[index]} ${before}% ${before+item.people/data.metrics.people*100}%`; }).join(',')})` : '#e8ece9' }}><div><strong>{data.metrics.people}</strong><span>people</span></div></div><div className="quality-legend">{data.quality.map((item,index) => <div key={item.quality}><span><i style={{ background: colors[index] }} />{label(item.quality)}</span><strong>{item.people}</strong><small>{data.metrics.people ? Math.round(item.people/data.metrics.people*100) : 0}%</small></div>)}</div></article>
      </div>
      <div className="analytics-secondary-grid"><article className="insight-panel"><div className="insight-heading"><div><h2>Pipeline snapshot</h2><p>Current stages for people met in this period</p></div><Link className="subtle-link" to="/people">View people <ArrowUpRight size={14} /></Link></div><div className="stage-bars">{data.stages.map((item) => <div className="stage-bar-row" key={item.stage}><span><i className={`stage-dot stage-${item.stage}`} />{label(item.stage)}</span><div><i style={{ width: `${data.metrics.people ? item.people/data.metrics.people*100 : 0}%` }} /></div><strong>{item.people}</strong></div>)}</div><p className="chart-note">This is a current snapshot, not a historical conversion funnel.</p></article>
        <article className="insight-panel"><div className="insight-heading"><div><h2>Event performance</h2><p>People and conversations by event</p></div></div><div className="source-list"><div className="source-row source-label"><span>Event</span><span>People</span><span>Conversations</span></div>{data.sources.map((source) => <div className="source-row" key={source.id}><span><i className="event-marker" />{source.name}</span><strong>{source.people}</strong><span>{source.conversations}</span></div>)}{!data.sources.length && <p className="analytics-empty">No event activity in this period.</p>}</div><p className="chart-note">A person may belong to more than one event.</p></article></div>
      <article className="insight-panel recent-panel"><div className="insight-heading"><div><h2>Recent conversations</h2><p>The latest people behind these numbers</p></div><Link to="/people" className="subtle-link">All people <ArrowRight size={14} /></Link></div><RecentPeople data={data} /></article>
      <div className="analytics-footnote"><span>{data.period.from} — {data.period.to} · {data.period.timeZone}</span><p>Includes active people with an accessible conversation in this period. Company deal values are counted once and reflect their current state, not revenue earned during these dates.</p></div>
    </div>}
  </section>;
}
