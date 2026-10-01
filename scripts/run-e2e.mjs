import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const availablePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

const runId = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const [apiPort, webPort] = await Promise.all([availablePort(), availablePort()]);
const testArgs = process.argv.slice(2);
const smtpCaptureMode = testArgs[0] === '--smtp-capture';
if (smtpCaptureMode) testArgs.shift();
const fullControlCrawlMode = testArgs[0] === '--full-control-crawl';
if (fullControlCrawlMode) testArgs.shift();
const manualReadingMode = testArgs[0] === '--manual-reading';
if (manualReadingMode) testArgs.shift();
const scanQuotaMode = testArgs[0] === '--scan-quota';
if (scanQuotaMode) testArgs.shift();
const noteQuotaMode = testArgs[0] === '--note-quota';
if (noteQuotaMode) testArgs.shift();
const noteCountQuotaMode = testArgs[0] === '--note-count-quota';
if (noteCountQuotaMode) testArgs.shift();
const qrQuotaMode = testArgs[0] === '--qr-quota';
if (qrQuotaMode) testArgs.shift();
const taskQuotaMode = testArgs[0] === '--task-quota';
if (taskQuotaMode) testArgs.shift();
const taskRateMode = testArgs[0] === '--task-rate';
if (taskRateMode) testArgs.shift();
const voiceQuotaMode = testArgs[0] === '--voice-quota';
if (voiceQuotaMode) testArgs.shift();
const phoneControlCrawlMode = testArgs[0] === '--phone-only';
if (phoneControlCrawlMode) testArgs.shift();
const env = {
  ...process.env,
  NODE_ENV: 'test',
  AI_MODE: manualReadingMode ? 'off' : 'demo',
  GATHER_MANUAL_READING_MODE: manualReadingMode ? '1' : '0',
  GATHER_SCAN_QUOTA_MODE: scanQuotaMode ? '1' : '0',
  GATHER_NOTE_QUOTA_MODE: noteQuotaMode ? '1' : '0',
  GATHER_NOTE_COUNT_QUOTA_MODE: noteCountQuotaMode ? '1' : '0',
  GATHER_QR_QUOTA_MODE: qrQuotaMode ? '1' : '0',
  GATHER_TASK_QUOTA_MODE: taskQuotaMode ? '1' : '0',
  GATHER_TASK_RATE_MODE: taskRateMode ? '1' : '0',
  GATHER_TASK_RATE_LIMIT: taskRateMode ? '2' : undefined,
  GATHER_VOICE_QUOTA_MODE: voiceQuotaMode ? '1' : '0',
  GATHER_FULL_CONTROL_CRAWL: fullControlCrawlMode ? '1' : '0',
  GATHER_CONTROL_WIDTHS: phoneControlCrawlMode ? '390' : '',
  SCAN_STORAGE_WORKSPACE_LIMIT_BYTES: scanQuotaMode ? '70000' : (process.env.SCAN_STORAGE_WORKSPACE_LIMIT_BYTES ?? '536870912'),
  SCAN_STORAGE_TOTAL_LIMIT_BYTES: scanQuotaMode ? '150000' : (process.env.SCAN_STORAGE_TOTAL_LIMIT_BYTES ?? '5368709120'),
  NOTE_STORAGE_WORKSPACE_LIMIT_BYTES: noteQuotaMode ? '3000' : noteCountQuotaMode ? '100000' : (process.env.NOTE_STORAGE_WORKSPACE_LIMIT_BYTES ?? '16777216'),
  NOTE_STORAGE_TOTAL_LIMIT_BYTES: noteQuotaMode ? '5000' : noteCountQuotaMode ? '200000' : (process.env.NOTE_STORAGE_TOTAL_LIMIT_BYTES ?? '536870912'),
  NOTE_COUNT_WORKSPACE_LIMIT: noteQuotaMode ? '10' : noteCountQuotaMode ? '6' : (process.env.NOTE_COUNT_WORKSPACE_LIMIT ?? '100000'),
  NOTE_COUNT_TOTAL_LIMIT: noteQuotaMode ? '10' : noteCountQuotaMode ? '7' : (process.env.NOTE_COUNT_TOTAL_LIMIT ?? '500000'),
  QR_SCAN_WORKSPACE_LIMIT_COUNT: qrQuotaMode ? '2' : (process.env.QR_SCAN_WORKSPACE_LIMIT_COUNT ?? '20000'),
  QR_SCAN_TOTAL_LIMIT_COUNT: qrQuotaMode ? '3' : (process.env.QR_SCAN_TOTAL_LIMIT_COUNT ?? '100000'),
  TASK_COUNT_WORKSPACE_LIMIT: taskQuotaMode ? '8' : (process.env.TASK_COUNT_WORKSPACE_LIMIT ?? '25000'),
  TASK_COUNT_TOTAL_LIMIT: taskQuotaMode ? '9' : (process.env.TASK_COUNT_TOTAL_LIMIT ?? '100000'),
  VOICE_NOTE_COUNT_WORKSPACE_LIMIT: voiceQuotaMode ? '2' : (process.env.VOICE_NOTE_COUNT_WORKSPACE_LIMIT ?? '25000'),
  VOICE_NOTE_COUNT_TOTAL_LIMIT: voiceQuotaMode ? '4' : (process.env.VOICE_NOTE_COUNT_TOTAL_LIMIT ?? '100000'),
  VOICE_TRANSCRIPT_WORKSPACE_LIMIT_BYTES: voiceQuotaMode ? '50' : (process.env.VOICE_TRANSCRIPT_WORKSPACE_LIMIT_BYTES ?? '16777216'),
  VOICE_TRANSCRIPT_TOTAL_LIMIT_BYTES: process.env.VOICE_TRANSCRIPT_TOTAL_LIMIT_BYTES ?? '536870912',
  ANTHROPIC_API_KEY: '',
  SMTP_HOST: '',
  SMTP_FROM_ADDRESS: '',
  DATABASE_PATH: `data/gather-e2e-${runId}.sqlite`,
  UPLOADS_PATH: `uploads-e2e-${runId}`,
  HOST: '127.0.0.1',
  PORT: String(apiPort),
  VITE_PORT: String(webPort),
  PLAYWRIGHT_OUTPUT_DIR: `test-results/gather-${runId}`,
  E2E_API_PORT: String(apiPort),
  E2E_WEB_PORT: String(webPort),
  API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
};

const node = process.execPath;
const waitForExit = (child) => new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});
const seed = spawn(node, ['node_modules/tsx/dist/cli.mjs', 'server/seed-e2e.ts'], { env, stdio: 'inherit' });
const seedStatus = await waitForExit(seed);
if (seedStatus !== 0) process.exit(seedStatus);

let smtpServer;
if (smtpCaptureMode) {
  env.REQUIRE_EMAIL_VERIFICATION = 'true';
  env.SMTP_CAPTURE_PATH = resolve(env.UPLOADS_PATH, 'smtp-capture.eml');
  env.SMTP_REJECT_PATH = resolve(env.UPLOADS_PATH, 'smtp-reject');
  env.SMTP_FROM_ADDRESS = 'gather-test@example.test';
  env.SMTP_FROM_NAME = 'Gather SMTP Fixture';
  env.SMTP_SECURE = 'false';
  env.SMTP_REQUIRE_TLS = 'false';
  env.PUBLIC_BASE_URL = `http://127.0.0.1:${webPort}`;
  mkdirSync(dirname(env.SMTP_CAPTURE_PATH), { recursive: true });
  writeFileSync(env.SMTP_CAPTURE_PATH, '');
  smtpServer = net.createServer((socket) => {
    let buffer = '';
    let collecting = false;
    const message = [];
    socket.write('220 gather-test.local ESMTP ready\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\r\n')) {
        const delimiter = buffer.indexOf('\r\n');
        const line = buffer.slice(0, delimiter);
        buffer = buffer.slice(delimiter + 2);
        if (collecting) {
          if (line === '.') {
            collecting = false;
            writeFileSync(env.SMTP_CAPTURE_PATH, `${message.join('\r\n')}\r\n`);
            socket.write('250 2.0.0 Accepted by local test fixture\r\n');
          } else message.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        const command = line.split(/\s/, 1)[0]?.toUpperCase();
        if (command === 'EHLO' || command === 'HELO') socket.write('250-gather-test.local\r\n250 SIZE 10485760\r\n');
        else if (command === 'RCPT' && existsSync(env.SMTP_REJECT_PATH)) socket.write('550 5.1.1 Rejected by the local test fixture\r\n');
        else if (command === 'MAIL' || command === 'RCPT' || command === 'RSET' || command === 'NOOP') socket.write('250 2.0.0 OK\r\n');
        else if (command === 'DATA') { collecting = true; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
        else if (command === 'QUIT') { socket.write('221 2.0.0 Bye\r\n'); socket.end(); }
        else socket.write('250 2.0.0 OK\r\n');
      }
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    smtpServer.once('error', rejectListen);
    smtpServer.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = smtpServer.address();
  if (typeof address !== 'object' || !address) throw new Error('The SMTP test fixture failed to bind a local port.');
  env.SMTP_HOST = '127.0.0.1';
  env.SMTP_PORT = String(address.port);
}

const devServer = spawn(node, ['node_modules/tsx/dist/cli.mjs', 'server/dev-e2e.ts'], { env, stdio: 'inherit' });
let serverReady = false;
for (let attempt = 0; attempt < 120 && !serverReady; attempt += 1) {
  if (devServer.exitCode !== null) throw new Error(`Gather E2E server exited before startup (${devServer.exitCode}).`);
  try {
    const [webResponse, apiResponse] = await Promise.all([
      fetch(`http://127.0.0.1:${webPort}`),
      fetch(`http://127.0.0.1:${apiPort}/api/health`),
    ]);
    const health = apiResponse.ok ? await apiResponse.json() : null;
    serverReady = webResponse.ok && apiResponse.ok && health?.status === 'ok';
  } catch {}
  if (!serverReady) await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!serverReady) { devServer.kill('SIGTERM'); throw new Error('Gather E2E server did not become ready within 30 seconds.'); }

let testStatus = 1;
try {
  const test = spawn(node, ['node_modules/@playwright/test/cli.js', 'test', ...testArgs], { env, stdio: 'inherit' });
  testStatus = await waitForExit(test);
} finally {
  if (devServer.exitCode === null) {
    const serverExit = waitForExit(devServer);
    devServer.kill('SIGTERM');
    await Promise.race([serverExit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  const database = resolve(env.DATABASE_PATH);
  const uploads = resolve(env.UPLOADS_PATH);
  if (dirname(database) !== resolve('data') || !/^gather-e2e-[0-9]+-[a-f0-9]+\.sqlite$/.test(basename(database))) throw new Error('Refusing to clean an unexpected automated-test database path.');
  if (dirname(uploads) !== resolve('.') || !/^uploads-e2e-[0-9]+-[a-f0-9]+$/.test(basename(uploads))) throw new Error('Refusing to clean an unexpected automated-test uploads path.');
  if (smtpServer?.listening) await new Promise((resolveClose) => smtpServer.close(resolveClose));
  for (const path of [database, `${database}-wal`, `${database}-shm`]) {
    await rm(path, { force: true, maxRetries: 8, retryDelay: 250 });
  }
  await rm(uploads, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
process.exit(testStatus);
