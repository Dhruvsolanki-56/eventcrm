import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = process.cwd();
const entry = resolve(root, 'dist-server/server/index.js');
const workDir = await mkdtemp(join(tmpdir(), 'gather-production-smoke-'));
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

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Built server exited before health check.\n${output}`);
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok && (await response.json()).status === 'ok') return;
      lastError = new Error(`Health returned HTTP ${response.status}.`);
    } catch (error) { lastError = error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Built server did not become healthy: ${lastError?.message ?? 'timeout'}.\n${output}`);
}

try {
  const port = await nextPort();
  const url = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    AI_MODE: 'off',
    ANTHROPIC_API_KEY: '',
    SMTP_HOST: '',
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
    SMTP_REQUIRE_TLS: 'true',
    SMTP_USER: '',
    SMTP_PASSWORD: '',
    SMTP_FROM_NAME: '',
    SMTP_FROM_ADDRESS: '',
    HOST: '127.0.0.1',
    PORT: String(port),
    PUBLIC_BASE_URL: 'https://gather.invalid',
    DATABASE_PATH: join(workDir, 'gather.sqlite'),
    UPLOADS_PATH: join(workDir, 'uploads'),
    BACKUPS_PATH: join(workDir, 'backups'),
  };
  child = spawn(process.execPath, [entry], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  await waitForHealth(url, 15_000);

  const [home, scan, capabilities, demoAccounts] = await Promise.all([
    fetch(`${url}/`), fetch(`${url}/scan`), fetch(`${url}/api/capabilities`), fetch(`${url}/api/dev/demo-accounts`),
  ]);
  assert.equal(home.status, 200, 'production root should serve the built app');
  assert.match(await home.text(), /<title>Gather CRM<\/title>/);
  assert.equal(scan.status, 200, 'production routes should serve the built app');
  assert.equal(capabilities.status, 200);
  assert.deepEqual(await capabilities.json(), {
    cardReading: 'manual', emailDrafts: false, followUpSuggestions: false,
    emailSending: false, voiceTranscription: false,
  });
  assert.equal(demoAccounts.status, 404, 'development sample-login endpoint must not exist in production');
  console.log('Production smoke passed: built app and /scan return 200; health is ok; no-provider features report honest fallbacks; development demo login returns 404.');
  console.log('This local smoke does not test HTTPS, real provider credentials, external mail delivery, VM installation, or operational monitoring.');
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolveExit) => {
      const timeout = setTimeout(resolveExit, 3_000);
      child.once('exit', () => { clearTimeout(timeout); resolveExit(); });
    });
  }
  const tempRoot = resolve(tmpdir());
  if (!workDir.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('Refusing to clean a production smoke directory outside the system temp folder.');
  }
  await rm(workDir, { recursive: true, force: true });
}
