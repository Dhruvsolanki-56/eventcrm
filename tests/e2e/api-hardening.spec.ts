import { expect, request as pwRequest, test, type APIRequestContext } from '@playwright/test';

// These talk to the API directly, so nothing the browser UI would normally prevent is prevented here.
const api = () => `http://127.0.0.1:${process.env.E2E_API_PORT}`;

async function signIn(accountId: string, workspaceId: string) {
  const ctx = await pwRequest.newContext({ baseURL: api() });
  const first = await (await ctx.get('/api/auth/csrf')).json() as { csrfToken: string };
  const login = await ctx.post('/api/dev/login-as', { headers: { 'X-CSRF-Token': first.csrfToken }, data: { accountId, workspaceId } });
  expect(login.status(), await login.text()).toBe(200);
  const { csrfToken } = await login.json() as { csrfToken: string };
  const send = (method: string, path: string, options: { data?: unknown; raw?: string; headers?: Record<string, string> } = {}) => ctx.fetch(path, {
    method,
    headers: { 'X-CSRF-Token': csrfToken, 'X-Workspace-Id': workspaceId, ...(options.data !== undefined || options.raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    ...(options.raw !== undefined ? { data: options.raw } : options.data !== undefined ? { data: options.data } : {}),
  });
  return { ctx, csrfToken, send };
}
const noInternals = (text: string) => {
  expect(text).not.toMatch(/\bat [\w$.<>]+ \(|node_modules|\.ts:\d+|SQLITE_|SqliteError|Cannot (GET|POST|PUT|PATCH|DELETE)/);
};

test('malformed, oversized and hostile requests get a clear 4xx JSON answer, never a 500 or a framework page', async () => {
  const maya = await signIn('demo-owner', 'demo-northstar');
  const note = '/api/contacts/demo-ns-contact-1/notes';
  const cases: Array<[string, Promise<{ status(): number; text(): Promise<string>; headers(): Record<string, string> }>, number, string]> = [
    ['malformed JSON', maya.send('POST', note, { raw: '{"body": ' }), 400, 'invalid_json'],
    ['JSON null body', maya.send('POST', note, { raw: 'null' }), 400, 'invalid_json'],
    ['3 MB JSON body', maya.send('POST', note, { raw: JSON.stringify({ body: 'x'.repeat(3 * 1024 * 1024) }) }), 413, 'request_too_large'],
    ['NUL byte in a body field', maya.send('POST', note, { data: { body: 'a\u0000b' } }), 400, 'invalid_characters'],
    ['NUL byte in a search', maya.send('GET', '/api/contacts?q=a%00b'), 400, 'invalid_characters'],
    ['NUL byte in the path', maya.send('GET', '/api/contacts/abc%00def'), 400, 'invalid_characters'],
    ['broken percent-encoding in the path', maya.send('GET', '/api/contacts/%E0%A4%A'), 400, 'invalid_address'],
    ['unknown API address', maya.send('GET', '/api/definitely-not-here'), 404, 'not_found'],
    ['wrong method on a real address', maya.send('DELETE', '/api/contacts'), 404, 'not_found'],
  ];
  for (const [label, pending, status, code] of cases) {
    const res = await pending;
    const text = await res.text();
    expect(res.status(), `${label}: ${text.slice(0, 200)}`).toBe(status);
    const body = JSON.parse(text) as { code: string; requestId?: string };
    expect(body.code, label).toBe(code);
    expect(body.requestId, `${label} carries a request id`).toMatch(/^[0-9a-f]{8}$/);
    expect(res.headers()['x-request-id'], `${label} header matches`).toBe(body.requestId);
    noInternals(text);
  }
  // Valid requests also carry the id, and a hostile one did not break anything for the next request.
  const ok = await maya.send('GET', '/api/contacts');
  expect(ok.status()).toBe(200);
  expect(ok.headers()['x-request-id']).toMatch(/^[0-9a-f]{8}$/);
  await maya.ctx.dispose();
});

test('sign-in rejects unreadable input as 400 and never leaks internals', async () => {
  const ctx = await pwRequest.newContext({ baseURL: api() });
  const { csrfToken } = await (await ctx.get('/api/auth/csrf')).json() as { csrfToken: string };
  for (const raw of ['{"email": ', '', 'null', '[]', '{"email":"a@b.co"}', `{"email":"${'a'.repeat(400)}@b.co","password":"x"}`]) {
    const res = await ctx.fetch('/api/auth/login', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' }, data: raw });
    const text = await res.text();
    expect([400, 401], `body ${raw.slice(0, 30)} -> ${res.status()} ${text.slice(0, 120)}`).toContain(res.status());
    noInternals(text);
  }
  await ctx.dispose();
});

test('acting on an archived person is refused with 403 (not a server error) and changes nothing', async () => {
  const maya = await signIn('demo-owner', 'demo-northstar');
  const jordan = await signIn('demo-rep', 'demo-northstar');
  const people = (await (await maya.send('GET', '/api/contacts')).json() as { people: Array<{ id: string; name: string; version: number }> }).people;
  const target = people[people.length - 1]!;
  const archive = await maya.send('PATCH', `/api/contacts/${target.id}/archive`, { data: { archived: true } });
  expect(archive.status(), await archive.text()).toBe(200);
  try {
    const attempts: Array<[string, string, unknown?]> = [
      ['POST', '/api/deals', { contactId: target.id, title: 'sneaky', valueMinor: null, encounterId: null }],
      ['PATCH', `/api/contacts/${target.id}`, { version: target.version, name: 'Renamed', title: '', email: '', phone: '', website: '' }],
      ['POST', `/api/contacts/${target.id}/notes`, { body: 'sneaky' }],
      ['POST', `/api/contacts/${target.id}/conversations`, { body: 'sneaky', eventId: null, clientConversationId: crypto.randomUUID() }],
      ['POST', `/api/contacts/${target.id}/email-draft`],
    ];
    for (const who of [maya, jordan]) {
      for (const [method, path, data] of attempts) {
        const res = await who.send(method, path, data === undefined ? {} : { data });
        const text = await res.text();
        expect([403, 404, 409], `${method} ${path} -> ${res.status()} ${text.slice(0, 160)}`).toContain(res.status());
        noInternals(text);
      }
    }
    const archived = await (await maya.send('GET', '/api/contacts?archived=true')).json() as { people: Array<{ id: string; name: string; stage: string }> };
    const kept = archived.people.find((person) => person.id === target.id);
    expect(kept?.name).toBe(target.name);
  } finally {
    await maya.send('PATCH', `/api/contacts/${target.id}/archive`, { data: { archived: false } });
  }
  await jordan.ctx.dispose(); await maya.ctx.dispose();
});

test('every API address refuses an unauthenticated caller and never reveals internals', async () => {
  const ctx: APIRequestContext = await pwRequest.newContext({ baseURL: api() });
  const { csrfToken } = await (await ctx.get('/api/auth/csrf')).json() as { csrfToken: string };
  const protectedReads = ['/api/workspace', '/api/deals', '/api/contacts', '/api/companies', '/api/tasks', '/api/email-desk', '/api/scans', '/api/settings', '/api/team', '/api/problems', '/api/analytics', '/api/reports', '/api/dashboard', '/api/notifications', '/api/export/people.csv', '/api/export/data.json', '/api/contacts/demo-ns-contact-1', '/api/companies/demo-ns-acme', '/api/emails/demo-email-tessa-draft', '/api/notes/x/audio', '/api/scans/x/image'];
  for (const path of protectedReads) {
    const res = await ctx.get(path);
    const text = await res.text();
    expect(res.status(), `${path}: ${text.slice(0, 100)}`).toBe(401);
    noInternals(text);
    expect(text).not.toContain('Tessa');
  }
  const protectedWrites: Array<[string, string, unknown]> = [
    ['POST', '/api/contacts/demo-ns-contact-1/notes', { body: 'x' }], ['PATCH', '/api/deals/deal-demo-ns-contact-1/stage', { stage: 'won', version: 1 }], ['POST', '/api/deals', { contactId: 'demo-ns-contact-1', title: 'x', valueMinor: null, encounterId: null }], ['DELETE', '/api/deals/deal-demo-ns-contact-1', {}], ['DELETE', '/api/contacts/demo-ns-contact-1', {}],
    ['POST', '/api/events', { name: 'x', startsAt: '2026-01-01T00:00:00Z', endsAt: '2026-01-02T00:00:00Z', timeZone: 'UTC', spendMinor: null, active: false }],
    ['PUT', '/api/settings', { key: 'email', value: {} }], ['POST', '/api/team/invites', { role: 'manager', eventIds: [] }], ['POST', '/api/emails/demo-email-tessa-draft/send', {}],
  ];
  for (const [method, path, data] of protectedWrites) {
    const res = await ctx.fetch(path, { method, headers: { 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' }, data });
    expect([401, 403], `${method} ${path} -> ${res.status()}`).toContain(res.status());
    noInternals(await res.text());
  }
  await ctx.dispose();
});
