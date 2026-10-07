import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let folder = '';
beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'encore-ai-'));
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_PATH: join(folder, 'ai.sqlite'), UPLOADS_PATH: join(folder, 'uploads'), AI_MODE: 'off' });
  const database = await import('./db.js');
  await database.migrate();
  await database.seedDemoData('not-a-real-hash');
});
afterAll(() => { try { rmSync(folder, { recursive: true, force: true }); } catch { /* still open on Windows */ } });
beforeEach(async () => { (await import('./ai-guard.js')).resetAiGuardForTests(); });

describe('AI guard', () => {
  it('answers the same question from memory instead of calling again', async () => {
    const { guardedAI, aiUsageSummary } = await import('./ai-guard.js');
    let calls = 0;
    const ask = () => guardedAI({ workspaceId: 'demo-northstar', kind: 'conversation_context', input: { note: 'cache me' }, run: async () => { calls += 1; return { summary: 'ok' }; } });
    expect(await ask()).toEqual({ summary: 'ok' });
    expect(await ask()).toEqual({ summary: 'ok' });
    expect(calls).toBe(1);
    const usage = (await aiUsageSummary('demo-northstar')).find((row) => row.kind === 'conversation_context')!;
    expect(Number(usage.cache_hits)).toBeGreaterThanOrEqual(1);
  });

  it('never shares an answer between workspaces', async () => {
    const { guardedAI } = await import('./ai-guard.js');
    let calls = 0;
    const run = async () => { calls += 1; return { n: calls }; };
    await guardedAI({ workspaceId: 'demo-northstar', kind: 'follow_up', input: 'same text', run });
    await guardedAI({ workspaceId: 'demo-riverbend', kind: 'follow_up', input: 'same text', run });
    expect(calls).toBe(2);
  });

  it('turns many identical requests at once into one call', async () => {
    const { guardedAI } = await import('./ai-guard.js');
    let calls = 0;
    const run = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 40)); return 'shared'; };
    const answers = await Promise.all(Array.from({ length: 6 }, () => guardedAI({ workspaceId: 'demo-northstar', kind: 'business_profile', input: 'burst', run })));
    expect(answers).toEqual(Array(6).fill('shared'));
    expect(calls).toBe(1);
  });

  it('does not keep a result that says AI is unavailable, and keeps nothing for a new version of a draft', async () => {
    const { guardedAI } = await import('./ai-guard.js');
    let calls = 0;
    const none = () => guardedAI<{ available: boolean }>({ workspaceId: 'demo-northstar', kind: 'card_read', input: 'img', cacheable: (value) => value.available, run: async () => { calls += 1; return { available: false }; } });
    await none(); await none();
    expect(calls).toBe(2);
    let versions = 0;
    const another = () => guardedAI({ workspaceId: 'demo-northstar', kind: 'email_draft_alternate', input: 'ctx', run: async () => ++versions });
    expect([await another(), await another()]).toEqual([1, 2]);
  });

  it('stops a workspace at its daily limit', async () => {
    process.env.AI_DAILY_LIMIT_FOLLOW_UP = '2';
    const { guardedAI, AiBudgetError } = await import('./ai-guard.js');
    let calls = 0;
    const ws = 'demo-northstar';
    const run = (input: string) => guardedAI({ workspaceId: ws, kind: 'follow_up', input: `limit-${input}`, run: async () => { calls += 1; return input; } });
    const used = Number((await (await import('./ai-guard.js')).aiUsageSummary(ws)).find((row) => row.kind === 'follow_up')?.calls ?? 0);
    process.env.AI_DAILY_LIMIT_FOLLOW_UP = String(used + 2);
    await run('a'); await run('b');
    await expect(run('c')).rejects.toBeInstanceOf(AiBudgetError);
    expect(calls).toBe(2);
    delete process.env.AI_DAILY_LIMIT_FOLLOW_UP;
  });

  it('pauses a failing provider briefly instead of making every request wait', async () => {
    const { guardedAI, AiPausedError } = await import('./ai-guard.js');
    let calls = 0;
    const fail = (input: string) => guardedAI({ workspaceId: 'demo-northstar', kind: 'transcript_summary', input, run: async () => { calls += 1; throw new Error('provider down'); } });
    for (let index = 0; index < 5; index++) await expect(fail(`x${index}`)).rejects.toThrow('provider down');
    await expect(fail('after')).rejects.toBeInstanceOf(AiPausedError);
    expect(calls).toBe(5);
  });

  it('trims long text and collapses whitespace', async () => {
    const { trimForAI } = await import('./ai-guard.js');
    expect(trimForAI('a   b\n\n\n\nc', 100)).toBe('a b\n\nc');
    expect(trimForAI('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}…`);
  });
});
