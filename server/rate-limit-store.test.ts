import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let folder = '';
beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'encore-rl-'));
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_PATH: join(folder, 'rl.sqlite'), UPLOADS_PATH: join(folder, 'uploads'), AI_MODE: 'off' });
  await (await import('./db.js')).migrate();
});
afterAll(() => { try { rmSync(folder, { recursive: true, force: true }); } catch { /* still open on Windows */ } });

describe('shared request counters', () => {
  it('counts hits per key within a window and starts again after it', async () => {
    const { DatabaseRateLimitStore } = await import('./rate-limit-store.js');
    const store = new DatabaseRateLimitStore('test');
    store.init({ windowMs: 150 } as never);
    expect((await store.increment('a')).totalHits).toBe(1);
    expect((await store.increment('a')).totalHits).toBe(2);
    expect((await store.increment('b')).totalHits).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await store.increment('a')).totalHits).toBe(1);
  });

  it('is separate for each limiter, and a key can be reset or counted down', async () => {
    const { DatabaseRateLimitStore } = await import('./rate-limit-store.js');
    const one = new DatabaseRateLimitStore('one'), two = new DatabaseRateLimitStore('two');
    one.init({ windowMs: 60_000 } as never); two.init({ windowMs: 60_000 } as never);
    await one.increment('k'); await one.increment('k');
    expect((await two.increment('k')).totalHits).toBe(1);
    await one.decrement('k');
    expect((await one.increment('k')).totalHits).toBe(2);
    await one.resetKey('k');
    expect((await one.increment('k')).totalHits).toBe(1);
  });

  it('removes counters whose window is over', async () => {
    const { DatabaseRateLimitStore, pruneRateLimits } = await import('./rate-limit-store.js');
    const { database } = await import('./db.js');
    const store = new DatabaseRateLimitStore('old');
    store.init({ windowMs: 1 } as never);
    await store.increment('x');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pruneRateLimits();
    expect(await database.prepare(`SELECT COUNT(*) AS n FROM rate_limit_hits WHERE key LIKE 'old:%'`).get()).toMatchObject({ n: 0 });
  });
});
