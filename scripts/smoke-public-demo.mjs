import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const root = process.cwd();
const entry = resolve(root, 'dist-server/server/index.js');
const workDir = await mkdtemp(join(tmpdir(), 'gather-public-demo-smoke-'));
let child;
let output = '';

function nextPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function setCookies(response, current = new Map()) {
  const header = response.headers.get('set-cookie') ?? '';
  for (const match of header.matchAll(/(?:^|,\s*)(gather_session|gather_csrf)=([^;,]*)/g)) current.set(match[1], `${match[1]}=${match[2]}`);
  return current;
}

const cookiesToHeader = (cookies) => [...cookies.values()].join('; ');

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Public demo server exited before health check.\n${output}`);
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok && (await response.json()).status === 'ok') return;
      lastError = new Error(`Health returned HTTP ${response.status}.`);
    } catch (error) { lastError = error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Public demo server did not become healthy: ${lastError?.message ?? 'timeout'}.\n${output}`);
}

try {
  const port = await nextPort();
  const url = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production', GATHER_DEMO_MODE: 'true', AI_MODE: 'off',
    SMTP_HOST: '', SMTP_FROM_ADDRESS: '', REQUIRE_EMAIL_VERIFICATION: 'false',
    HOST: '127.0.0.1', PORT: String(port),
    DATABASE_PATH: join(workDir, 'gather.sqlite'), UPLOADS_PATH: join(workDir, 'uploads'),
    BACKUPS_PATH: join(workDir, 'backups'),
  };
  child = spawn(process.execPath, [entry], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  await waitForHealth(url, 20_000);

  const accountsResponse = await fetch(`${url}/api/dev/demo-accounts`);
  assert.equal(accountsResponse.status, 200, 'explicit public demo mode should expose only its seeded sample accounts');
  const accounts = (await accountsResponse.json()).accounts;
  assert.ok(accounts.some((account) => account.id === 'demo-owner' && account.workspaceId === 'demo-northstar'));

  let cookies = setCookies(await fetch(`${url}/api/auth/csrf`));
  const csrfToken = decodeURIComponent(cookies.get('gather_csrf').slice('gather_csrf='.length));
  const login = await fetch(`${url}/api/dev/login-as`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookiesToHeader(cookies), 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ accountId: 'demo-owner', workspaceId: 'demo-northstar' }),
  });
  assert.equal(login.status, 200, await login.text());
  cookies = setCookies(login, cookies);

  const session = await fetch(`${url}/api/auth/me`, { headers: { Cookie: cookiesToHeader(cookies) } });
  assert.equal(session.status, 200);
  const signedIn = await session.json();
  assert.equal(signedIn.workspace.id, 'demo-northstar');
  assert.equal(signedIn.demoMode, true, 'the explicit public demo should identify its shared demo session');

  const [capabilities, people] = await Promise.all([
    fetch(`${url}/api/capabilities`),
    fetch(`${url}/api/contacts`, { headers: { Cookie: cookiesToHeader(cookies), 'X-Workspace-Id': 'demo-northstar' } }),
  ]);
  assert.equal((await capabilities.json()).emailSending, false, 'the no-provider demo must not claim email is enabled');
  const peopleBody = await people.json();
  assert.equal(people.status, 200, JSON.stringify(peopleBody));
  assert.ok(peopleBody.people.length > 0, 'seeded sample people should load after sign-in');

  console.log('Public demo smoke passed: production-mode startup reseeds synthetic workspaces, sample sign-in works, people load, and email is reported disabled.');
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolveExit) => {
      const timeout = setTimeout(resolveExit, 3_000);
      child.once('exit', () => { clearTimeout(timeout); resolveExit(); });
    });
  }
  const tempRoot = resolve(tmpdir());
  if (!workDir.startsWith(`${tempRoot}${sep}`)) throw new Error('Refusing to clean a smoke directory outside the system temp folder.');
  await rm(workDir, { recursive: true, force: true });
}
