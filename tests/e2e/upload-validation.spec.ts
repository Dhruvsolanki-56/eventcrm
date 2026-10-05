import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, request as pwRequest, test } from '@playwright/test';

test('card photo uploads reject the wrong kind of file with a clear reason', async () => {
  const ctx = await pwRequest.newContext({ baseURL: `http://127.0.0.1:${process.env.E2E_API_PORT}` });
  const first = await (await ctx.get('/api/auth/csrf')).json() as { csrfToken: string };
  const login = await (await ctx.post('/api/dev/login-as', { headers: { 'X-CSRF-Token': first.csrfToken }, data: { accountId: 'demo-owner', workspaceId: 'demo-northstar' } })).json() as { csrfToken: string };
  const send = (body: Buffer, type: string) => ctx.post('/api/scans', { headers: { 'X-CSRF-Token': login.csrfToken, 'X-Workspace-Id': 'demo-northstar', 'Content-Type': type, 'X-Client-Scan-Id': crypto.randomUUID() }, data: body });
  const png = readFileSync(resolve('public/demo/sample-card.png'));
  const markup = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${'<script>alert(1)</script>'.repeat(10)}</svg>`);
  expect((await send(png, 'image/gif')).status(), 'a type we do not read').toBe(415);
  expect((await send(png, 'image/svg+xml')).status()).toBe(415);
  expect((await send(png, 'image/jpeg')).status(), 'PNG bytes sent as JPEG').toBe(415);
  expect((await send(markup, 'image/png')).status(), 'markup pretending to be a PNG').toBe(415);
  expect((await send(Buffer.alloc(13 * 1024 * 1024, 1), 'image/png')).status(), 'over the size limit').toBe(413);
  expect((await send(Buffer.alloc(10), 'image/png')).status(), 'too small to be a photo').toBe(400);
});
