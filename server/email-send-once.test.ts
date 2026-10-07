import Database from 'better-sqlite3';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A crash after the mail server takes a message but before we record it must never send the message a second time.
// This runs the real worker code against a small in-process mail server that counts the messages it accepts.
let folder = '';
let mailServer: Server;
let accepted = 0;
let refuseRecipients = false;
let raw: Database.Database;
const port = 25000 + Math.floor(Math.random() * 20000);

function startMailServer() {
  return new Promise<Server>((resolve) => {
    const server = createServer((socket) => {
      let inMessage = false;
      let buffer = '';
      socket.write('220 test ESMTP\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let index: number;
        while ((index = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (inMessage) { if (line === '.') { inMessage = false; accepted += 1; socket.write('250 queued\r\n'); } continue; }
          const command = line.toUpperCase();
          if (command.startsWith('EHLO') || command.startsWith('HELO')) socket.write('250 test\r\n');
          else if (command.startsWith('RCPT')) socket.write(refuseRecipients ? '550 no such user\r\n' : '250 ok\r\n');
          else if (command.startsWith('DATA')) { inMessage = true; socket.write('354 go\r\n'); }
          else if (command.startsWith('QUIT')) { socket.write('221 bye\r\n'); socket.end(); }
          else socket.write('250 ok\r\n');
        }
      });
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'encore-once-'));
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_PATH: join(folder, 'once.sqlite'), UPLOADS_PATH: join(folder, 'uploads'), AI_MODE: 'off',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_REQUIRE_TLS: 'false', SMTP_SECURE: 'false',
    SMTP_FROM_ADDRESS: 'team@northstar.example', PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
  });
  mailServer = await startMailServer();
  const database = await import('./db.js');
  await database.migrate();
  await database.seedDemoData('not-a-real-hash');
  raw = new Database(process.env.DATABASE_PATH!);
});

afterAll(async () => {
  raw?.close();
  await new Promise((resolve) => mailServer?.close(resolve));
  // The app keeps its database open until the process ends (Windows will not delete it yet); the system temp folder cleans up later.
  try { rmSync(folder, { recursive: true, force: true }); } catch { /* still open */ }
});

async function approveFreshDraft(label: string) {
  const database = await import('./db.js');
  const draft = raw.prepare("SELECT * FROM emails WHERE id='demo-email-tessa-draft'").get() as Record<string, unknown>;
  const id = `once-${label}`;
  const columns = Object.keys(draft);
  raw.prepare(`INSERT INTO emails (${columns.join(',')}) VALUES (${columns.map((column) => '@' + column).join(',')})`).run({ ...draft, id, status: 'draft', unsubscribe_token_hash: null });
  const approved = await database.approveEmailDraft('demo-owner', 'demo-northstar', id, true, 'http://127.0.0.1:3000');
  expect(approved.status).toBe('queued');
  return id;
}
// The database clock and this process's clock can differ by a few milliseconds, so a job made a moment ago may not be due yet.
async function claimWhenDue(database: typeof import('./db.js')) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const job = await database.claimNextJob();
    if (job) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}
const jobFor = (emailId: string) => raw.prepare("SELECT id,payload_json FROM jobs WHERE type='email_send' AND payload_json LIKE ?").get(`%${emailId}%`) as { id: string; payload_json: string };
const statusOf = (emailId: string) => raw.prepare('SELECT status,error_message FROM emails WHERE id=?').get(emailId) as { status: string; error_message: string | null };

describe('sending one approved email', () => {
  it('sends once and records it', async () => {
    const { processJob } = await import('./worker.js');
    const database = await import('./db.js');
    const id = await approveFreshDraft('normal');
    const job = (await claimWhenDue(database))!;
    expect(job.payload_json).toContain(id);
    const before = accepted;
    await processJob(job);
    expect(accepted - before).toBe(1);
    expect(statusOf(id).status).toBe('sent');
  });

  it('does not send again when an earlier attempt began sending and never reported back', async () => {
    const { processJob } = await import('./worker.js');
    const database = await import('./db.js');
    const id = await approveFreshDraft('crashed');
    // What a crashed worker leaves behind: sending began, nothing was recorded.
    await database.setJobPayloadField(jobFor(id).id, 'sendStartedAt', new Date().toISOString());
    const job = (await claimWhenDue(database))!;
    expect(job.payload_json).toContain(id);
    const before = accepted;
    await processJob(job);
    expect(accepted - before, 'no second copy goes out').toBe(0);
    const state = statusOf(id);
    expect(state.status).toBe('failed');
    expect(state.error_message).toMatch(/could not confirm/i);
  });

  it('allows a retry after the mail server clearly refused the recipient', async () => {
    const { processJob } = await import('./worker.js');
    const database = await import('./db.js');
    const id = await approveFreshDraft('refused');
    refuseRecipients = true;
    try {
      const job = (await claimWhenDue(database))!;
      await expect(processJob(job)).rejects.toThrow();
    } finally { refuseRecipients = false; }
    expect(JSON.parse(jobFor(id).payload_json)).not.toHaveProperty('sendStartedAt');
    expect(statusOf(id).status).toBe('queued');
  });
});

describe('scheduled sending', () => {
  async function scheduleFreshDraft(label: string, sendAt: Date) {
    const database = await import('./db.js');
    const draft = raw.prepare("SELECT * FROM emails WHERE id='demo-email-tessa-draft'").get() as Record<string, unknown>;
    const id = `sched-${label}`;
    const columns = Object.keys(draft);
    raw.prepare(`INSERT INTO emails (${columns.join(',')}) VALUES (${columns.map((column) => '@' + column).join(',')})`).run({ ...draft, id, status: 'draft', unsubscribe_token_hash: null });
    return { id, result: await database.approveEmailDraft('demo-owner', 'demo-northstar', id, true, 'http://127.0.0.1:3000', sendAt) };
  }

  it('holds an email until its time and can be cancelled back to a draft', async () => {
    const database = await import('./db.js');
    const { id, result } = await scheduleFreshDraft('later', new Date(Date.now() + 3600_000));
    expect(result).toMatchObject({ status: 'queued', scheduled: true });
    expect(raw.prepare('SELECT send_at FROM emails WHERE id=?').get(id)).toMatchObject({ send_at: expect.stringMatching(/Z$/) });
    const due = raw.prepare("SELECT run_at FROM jobs WHERE type='email_send' AND payload_json LIKE ?").get(`%${id}%`) as { run_at: string };
    expect(Date.parse(due.run_at)).toBeGreaterThan(Date.now() + 3000_000);
    expect(await database.cancelScheduledEmail('demo-owner', 'demo-northstar', id)).toBe(true);
    expect(statusOf(id).status).toBe('draft');
    expect(raw.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='email_send' AND payload_json LIKE ?").get(`%${id}%`)).toMatchObject({ n: 0 });
    // A second cancel, or cancelling something that is not scheduled, does nothing.
    expect(await database.cancelScheduledEmail('demo-owner', 'demo-northstar', id)).toBe(false);
  });

  it('treats a time that is already near as right away', async () => {
    const { id, result } = await scheduleFreshDraft('soon', new Date(Date.now() + 5000));
    expect(result).toMatchObject({ scheduled: false });
    expect(raw.prepare('SELECT send_at FROM emails WHERE id=?').get(id)).toMatchObject({ send_at: null });
  });
});

describe('automatic sending', () => {
  async function plainDraft(label: string) {
    const draft = raw.prepare("SELECT * FROM emails WHERE id='demo-email-tessa-draft'").get() as Record<string, unknown>;
    const id = `auto-${label}`;
    const columns = Object.keys(draft);
    raw.prepare(`INSERT INTO emails (${columns.join(',')}) VALUES (${columns.map((column) => '@' + column).join(',')})`).run({ ...draft, id, status: 'draft', unsubscribe_token_hash: null });
    return id;
  }
  const autoJob = (id: string) => raw.prepare("SELECT id,status,run_at FROM jobs WHERE type='email_auto_send' AND payload_json LIKE ?").get(`%${id}%`) as { id: string; status: string; run_at: string } | undefined;

  it('never plans a send sooner than the minimum hold', async () => {
    const database = await import('./db.js');
    const id = await plainDraft('hold');
    const when = await database.queueAutoSend('demo-northstar', id, 'demo-owner', new Date());
    expect(Date.parse(when)).toBeGreaterThanOrEqual(Date.now() + database.autoSendMinimumHoldMs() - 2000);
    expect(autoJob(id)).toBeTruthy();
    expect(await database.cancelAutoSend('demo-northstar', id)).toBe(true);
    expect(autoJob(id)).toBeUndefined();
  });

  it('sends a draft left alone, and leaves one a person has taken over', async () => {
    process.env.AUTO_SEND_MIN_DELAY_SECONDS = '0';
    const { processJob } = await import('./worker.js');
    const database = await import('./db.js');
    const left = await plainDraft('left');
    const edited = await plainDraft('edited');
    await database.queueAutoSend('demo-northstar', left, 'demo-owner', new Date());
    await database.queueAutoSend('demo-northstar', edited, 'demo-owner', new Date());
    // A person saves the second one, which takes it over.
    expect(await database.updateEmailDraft('demo-owner', 'demo-northstar', edited, 'Mine', 'My own words.')).toBe(true);
    expect(autoJob(edited)).toBeUndefined();
    const before = accepted;
    for (let step = 0; step < 10 && statusOf(left).status === 'draft'; step++) {
      const job = await claimWhenDue(database);
      if (!job) break;
      await processJob(job);
    }
    // The automatic job approved the draft, which queued the real send.
    expect(statusOf(left).status).toBe('queued');
    for (let step = 0; step < 10 && statusOf(left).status === 'queued'; step++) {
      const job = await claimWhenDue(database);
      if (!job) break;
      await processJob(job);
    }
    expect(accepted - before).toBeGreaterThanOrEqual(1);
    expect(statusOf(left).status).toBe('sent');
    expect(statusOf(edited).status).toBe('draft');
  });
});
