import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';
import { database as db } from './db.js';

/**
 * Request counters kept in the database, so a limit holds when more than one server copy is running
 * (a counter in each server's memory would let a person make the limit times the number of copies).
 */
export class DatabaseRateLimitStore implements Store {
  localKeys = false;
  private windowMs = 60_000;
  constructor(readonly prefix: string) {}

  init(options: Options) { this.windowMs = options.windowMs; }

  private name(key: string) { return `${this.prefix}:${key}`; }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const now = Date.now();
    const name = this.name(key);
    await db.prepare(`INSERT INTO rate_limit_hits(key,hits,reset_ms) VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN rate_limit_hits.reset_ms<=? THEN 1 ELSE rate_limit_hits.hits+1 END,
        reset_ms=CASE WHEN rate_limit_hits.reset_ms<=? THEN ? ELSE rate_limit_hits.reset_ms END`).run(name, now + this.windowMs, now, now, now + this.windowMs);
    const row = await db.prepare(`SELECT hits,reset_ms FROM rate_limit_hits WHERE key=?`).get(name) as { hits: number; reset_ms: number } | undefined;
    return { totalHits: Number(row?.hits ?? 1), resetTime: new Date(Number(row?.reset_ms ?? now + this.windowMs)) };
  }

  async decrement(key: string) {
    await db.prepare(`UPDATE rate_limit_hits SET hits=hits-1 WHERE key=? AND hits>0`).run(this.name(key));
  }

  async resetKey(key: string) {
    await db.prepare(`DELETE FROM rate_limit_hits WHERE key=?`).run(this.name(key));
  }
}

/** Shared counters when running on a hosted database (or when asked for); plain memory otherwise. */
export function limiterStore(name: string): Store | undefined {
  const choice = process.env.RATE_LIMIT_STORE;
  const shared = choice === 'database' || (choice !== 'memory' && Boolean(process.env.DATABASE_URL?.trim()));
  return shared ? new DatabaseRateLimitStore(name) : undefined;
}

export async function pruneRateLimits() {
  await db.prepare(`DELETE FROM rate_limit_hits WHERE reset_ms<?`).run(Date.now());
}
