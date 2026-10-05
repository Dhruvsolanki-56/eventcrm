import { expect, request as pwRequest, test } from '@playwright/test';

// Valid requests for admin-only actions, sent by people who are not admins: always a plain 403, and nothing changes.
const api = () => `http://127.0.0.1:${process.env.E2E_API_PORT}`;
async function signIn(accountId: string, workspaceId: string) {
  const ctx = await pwRequest.newContext({ baseURL: api() });
  const first = await (await ctx.get('/api/auth/csrf')).json() as { csrfToken: string };
  const login = await ctx.post('/api/dev/login-as', { headers: { 'X-CSRF-Token': first.csrfToken }, data: { accountId, workspaceId } });
  const { csrfToken } = await login.json() as { csrfToken: string };
  return (method: string, path: string, data?: unknown) => ctx.fetch(path, { method, headers: { 'X-CSRF-Token': csrfToken, 'X-Workspace-Id': workspaceId, ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(data !== undefined ? { data } : {}) });
}

test('representatives and managers get 403 for admin-only actions and nothing changes', async () => {
  const maya = await signIn('demo-owner', 'demo-northstar');
  const companies = (await (await maya('GET', '/api/companies')).json() as { companies: Array<{ id: string }> }).companies;
  const before = await (await maya('GET', '/api/contacts?pageSize=1')).json() as { total: number };
  for (const account of ['demo-rep', 'demo-manager']) {
    const them = await signIn(account, 'demo-northstar');
    const refused = [
      await them('POST', `/api/companies/${companies[0]!.id}/merge`, { targetCompanyId: companies[1]!.id, confirmation: 'MERGE' }),
      await them('PUT', '/api/team/members/demo-manager/access', { role: 'manager', eventIds: [] }),
      await them('POST', '/api/settings/clear-sample-data', { confirmation: 'CLEAR' }),
      await them('POST', '/api/settings/delete-my-data', { confirmation: 'DELETE' }),
      await them('DELETE', '/api/contacts/demo-ns-contact-10', { confirmation: 'DELETE' }),
      await them('POST', '/api/team/invites', { role: 'manager', eventIds: [] }),
      await them('PUT', '/api/settings', { key: 'email', value: {} }),
    ];
    expect(refused.map((response) => response.status()), account).toEqual(Array(refused.length).fill(403));
    for (const response of refused) expect(await response.text()).not.toMatch(/SQLITE|constraint|\.ts:|node_modules/i);
  }
  expect((await (await maya('GET', '/api/companies')).json() as { companies: unknown[] }).companies).toHaveLength(companies.length);
  expect((await (await maya('GET', '/api/contacts?pageSize=1')).json() as { total: number }).total).toBe(before.total);
});
