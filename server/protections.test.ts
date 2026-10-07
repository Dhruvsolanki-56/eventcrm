import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiProtection, securityHeaders } from './protections.js';

let server: Server;
let base = '';
beforeAll(async () => {
  Object.assign(process.env, { API_LIMIT_PER_SESSION_PER_MINUTE: '5', API_LIMIT_PER_ADDRESS_PER_MINUTE: '50', API_REQUEST_TIMEOUT_MS: '150' });
  const app = express();
  app.use(securityHeaders);
  app.use('/api', ...apiProtection({ isProduction: false, sessionCookie: 'gather_session' }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/thing', (_req, res) => res.json({ ok: true }));
  app.get('/api/slow', (_req, res) => { setTimeout(() => { if (!res.headersSent) res.json({ late: true }); }, 600); });
  app.get('/page', (_req, res) => res.send('page'));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));

describe('API protections', () => {
  it('keeps private answers out of caches and limits camera and microphone to the app', async () => {
    const api = await fetch(`${base}/api/thing`, { headers: { cookie: 'gather_session=header-test' } });
    expect(api.headers.get('cache-control')).toBe('no-store');
    expect(api.headers.get('permissions-policy')).toContain('camera=(self)');
    expect(api.headers.get('permissions-policy')).toContain('geolocation=()');
    expect((await fetch(`${base}/page`)).headers.get('cache-control')).toBeNull();
  });

  it('limits one signed-in session without touching another', async () => {
    const hit = (session: string) => fetch(`${base}/api/thing`, { headers: { cookie: `gather_session=${session}` } });
    const results: number[] = [];
    for (let index = 0; index < 7; index++) results.push((await hit('busy')).status);
    expect(results.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(results.slice(5)).toEqual([429, 429]);
    const refused = await hit('busy');
    expect(await refused.json()).toMatchObject({ code: 'rate_limit' });
    expect((await hit('quiet')).status).toBe(200);
  });

  it('never counts the health check', async () => {
    for (let index = 0; index < 20; index++) expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it('answers a request that takes too long with a clear message', async () => {
    const slow = await fetch(`${base}/api/slow`, { headers: { cookie: 'gather_session=slow-one' } });
    expect(slow.status).toBe(503);
    expect(await slow.json()).toMatchObject({ code: 'request_timeout' });
  });
});
