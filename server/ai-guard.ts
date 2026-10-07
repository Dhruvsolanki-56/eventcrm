import { database as db, sha256Hex } from './db.js';

/**
 * Every call to an AI provider goes through here, so the same question is not paid for twice, a flood of
 * identical requests becomes one call, a workspace cannot spend without limit, and a provider that is down
 * stops being asked for a short while instead of making every save wait for a timeout.
 */
export class AiBudgetError extends Error {
  constructor() { super('The AI limit for today has been reached.'); this.name = 'AiBudgetError'; }
}
export class AiPausedError extends Error {
  constructor() { super('AI is paused for a moment after repeated errors.'); this.name = 'AiPausedError'; }
}

export type AiKind = 'card_read' | 'email_draft' | 'email_draft_alternate' | 'conversation_context' | 'transcript_summary' | 'follow_up' | 'business_profile' | 'company_about';

const DEFAULT_TTL_SECONDS: Record<AiKind, number> = {
  card_read: 30 * 86400, email_draft: 6 * 3600, email_draft_alternate: 0, conversation_context: 24 * 3600,
  transcript_summary: 7 * 86400, follow_up: 6 * 3600, business_profile: 7 * 86400, company_about: 7 * 86400,
};
const DEFAULT_DAILY_BUDGET: Record<AiKind, number> = {
  card_read: 400, email_draft: 600, email_draft_alternate: 150, conversation_context: 600, transcript_summary: 300, follow_up: 300, business_profile: 60, company_about: 120,
};

function budgetFor(kind: AiKind) {
  const configured = Number(process.env[`AI_DAILY_LIMIT_${kind.toUpperCase()}`]);
  return Number.isInteger(configured) && configured >= 0 ? configured : DEFAULT_DAILY_BUDGET[kind];
}

const inFlight = new Map<string, Promise<unknown>>();
const breaker = new Map<string, { failures: number; pausedUntil: number }>();
const FAILURES_BEFORE_PAUSE = 5;
const PAUSE_MS = 60_000;

const today = () => new Date().toISOString().slice(0, 10);

async function bump(workspaceId: string, kind: AiKind, column: 'calls' | 'cache_hits' | 'failures') {
  await db.prepare(`INSERT INTO ai_usage(workspace_id,day,kind,${column}) VALUES (?,?,?,1) ON CONFLICT(workspace_id,day,kind) DO UPDATE SET ${column}=${column}+1`)
    .run(workspaceId, today(), kind).catch(() => undefined);
}

export function aiCacheKey(workspaceId: string, kind: AiKind, input: unknown) {
  const material = typeof input === 'string' ? input : JSON.stringify(input);
  return sha256Hex(`${workspaceId}\u0000${kind}\u0000${material}`);
}

export async function guardedAI<T>(options: {
  workspaceId: string; kind: AiKind; input: unknown; run: () => Promise<T>;
  /** False for a result that should not be kept, such as "AI is not set up". */
  cacheable?: (result: T) => boolean; ttlSeconds?: number;
}): Promise<T> {
  const { workspaceId, kind } = options;
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS[kind];
  const key = aiCacheKey(workspaceId, kind, options.input);

  if (ttl > 0) {
    const hit = await db.prepare(`SELECT result_json FROM ai_cache WHERE cache_key=? AND workspace_id=? AND expires_at>?`).get(key, workspaceId, new Date().toISOString()) as { result_json: string } | undefined;
    if (hit) { void bump(workspaceId, kind, 'cache_hits'); return JSON.parse(hit.result_json) as T; }
  }
  // The same question asked again while the first is still being answered shares that answer.
  const pending = inFlight.get(key);
  if (pending) return await pending as T;

  const work = (async () => {
    const state = breaker.get(kind);
    if (state && state.pausedUntil > Date.now()) throw new AiPausedError();
    const used = await db.prepare(`SELECT calls FROM ai_usage WHERE workspace_id=? AND day=? AND kind=?`).get(workspaceId, today(), kind) as { calls: number } | undefined;
    if ((used?.calls ?? 0) >= budgetFor(kind)) throw new AiBudgetError();
    await bump(workspaceId, kind, 'calls');
    let result: T;
    try { result = await options.run(); }
    catch (error) {
      await bump(workspaceId, kind, 'failures');
      const next = { failures: (breaker.get(kind)?.failures ?? 0) + 1, pausedUntil: 0 };
      if (next.failures >= FAILURES_BEFORE_PAUSE) { next.pausedUntil = Date.now() + PAUSE_MS; next.failures = 0; }
      breaker.set(kind, next);
      throw error;
    }
    breaker.delete(kind);
    if (ttl > 0 && (options.cacheable ? options.cacheable(result) : result !== null && result !== undefined)) {
      await db.prepare(`INSERT INTO ai_cache(cache_key,workspace_id,kind,result_json,expires_at) VALUES (?,?,?,?,?)
        ON CONFLICT(cache_key) DO UPDATE SET result_json=excluded.result_json,created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),expires_at=excluded.expires_at`)
        .run(key, workspaceId, kind, JSON.stringify(result), new Date(Date.now() + ttl * 1000).toISOString()).catch(() => undefined);
    }
    return result;
  })();
  inFlight.set(key, work);
  try { return await work; } finally { inFlight.delete(key); }
}

/** Removes answers that are past their time. Safe to run often. */
export async function pruneAiCache() {
  await db.prepare(`DELETE FROM ai_cache WHERE expires_at<?`).run(new Date().toISOString());
  await db.prepare(`DELETE FROM ai_usage WHERE day<?`).run(new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10));
}

/** Collapses whitespace and caps length so a long page or transcript does not cost more than it can help. */
export function trimForAI(text: string, maxChars: number) {
  const tidy = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return tidy.length > maxChars ? `${tidy.slice(0, maxChars)}…` : tidy;
}

/** What AI cost looks like for a workspace: calls made, answers reused, failures. */
export async function aiUsageSummary(workspaceId: string, days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return await db.prepare(`SELECT kind,SUM(calls) AS calls,SUM(cache_hits) AS cache_hits,SUM(failures) AS failures FROM ai_usage WHERE workspace_id=? AND day>=? GROUP BY kind ORDER BY kind`)
    .all(workspaceId, since) as Array<{ kind: AiKind; calls: number; cache_hits: number; failures: number }>;
}

/** For tests. */
export function resetAiGuardForTests() { inFlight.clear(); breaker.clear(); }
