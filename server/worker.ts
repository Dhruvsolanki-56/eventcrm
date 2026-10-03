import 'dotenv/config';
import { createTransport } from 'nodemailer';
import { completeJob, claimNextJob, failJobAttempt, getDailyDigestForWorker, getEmailForWorker, getEmailVerificationForWorker, getPasswordResetEmailForWorker, getScanForWorker, getWorkspaceEmailSettingsForWorker, markScanNeedsInput, markScanReading, recordEmailFailed, recordEmailSent, scheduleReminderWork, updateDigestRunForJob, updateScanRead, type JobRow } from './db.js';
import { safeFailureCode, safeJobFailureMessage, serverCardReaderUnavailableMessage } from './safe-failure.js';
import { sendResendEmail } from './resend-email.js';

let active = false;
let timer: NodeJS.Timeout | undefined;
let reminderTimer: NodeJS.Timeout | undefined;

async function senderForWorkspace(workspaceId: string) {
  const configured = await (getWorkspaceEmailSettingsForWorker(workspaceId));
  const address = configured?.fromAddress ?? process.env.SMTP_FROM_ADDRESS;
  const name = configured?.fromName ?? process.env.SMTP_FROM_NAME ?? 'Gather';
  return address ? { address, name } : undefined;
}

async function processJob(job: JobRow) {
  if (job.type === 'password_reset_email' || job.type === 'email_verification') {
    const payload = JSON.parse(job.payload_json) as { userId?: string; token?: string };
    if (!payload.userId || !payload.token) throw new Error('The account email message is incomplete.');
    const recipient = job.type === 'email_verification'
      ? await (getEmailVerificationForWorker(payload.userId, payload.token))
      : await (getPasswordResetEmailForWorker(payload.userId, payload.token));
    if (!recipient) { await (completeJob(job.id)); return; }
    const host = process.env.SMTP_HOST;
    const fromAddress = process.env.SMTP_FROM_ADDRESS;
    const publicBase = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '');
    if (!host || !fromAddress || !publicBase) throw new Error('Password reset mail settings are incomplete.');
    const port = Number(process.env.SMTP_PORT ?? 587);
    const transport = createTransport({
      host, port, secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD ?? '' } : undefined,
      requireTLS: process.env.SMTP_REQUIRE_TLS !== 'false' && port !== 465, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
      tls: { minVersion: 'TLSv1.2' },
    });
    try {
      const isVerification = job.type === 'email_verification';
      const actionUrl = isVerification
        ? `${publicBase}/verify-email#verify=${encodeURIComponent(payload.token)}`
        : `${publicBase}/reset-password#reset=${encodeURIComponent(payload.token)}`;
      const result = await transport.sendMail({
        from: { name: process.env.SMTP_FROM_NAME || 'Gather', address: fromAddress },
        to: recipient.email, subject: isVerification ? 'Verify your Gather email' : 'Reset your Gather password',
        text: isVerification
          ? `Hello ${recipient.name},\n\nUse this one-time link to verify your email and finish setting up Gather. It expires in one hour:\n${actionUrl}\n\nIf you did not create this account, you can ignore this message.\n\nMail-server acceptance does not confirm inbox delivery.`
          : `Hello ${recipient.name},\n\nUse this one-time link to choose a new password. It expires in one hour:\n${actionUrl}\n\nIf you did not request this, you can ignore this message.\n\nMail-server acceptance does not confirm inbox delivery.`,
      });
      if (!result.accepted?.length) throw new Error('Mail server did not accept the account email recipient.');
      await (completeJob(job.id));
    } finally { transport.close(); }
    return;
  }
  if (job.type === 'daily_digest') {
    const payload = JSON.parse(job.payload_json) as { userId?: string; localDate?: string };
    if (!payload.userId || !payload.localDate) throw new Error('The daily digest details are incomplete.');
    const digest = await (getDailyDigestForWorker(job.workspace_id, payload.userId, payload.localDate));
    if (!digest?.hasTasks) {
      await (updateDigestRunForJob(job.id, 'not_sent', 'There were no open follow-ups to include. No email was sent.'));
      await (completeJob(job.id));
      return;
    }
    const host = process.env.SMTP_HOST;
    const sender = await (senderForWorkspace(job.workspace_id));
    if (!host || !sender) {
      await (updateDigestRunForJob(job.id, 'not_sent', 'Mail server settings are not set up. No email was sent.'));
      await (completeJob(job.id));
      return;
    }
    const port = Number(process.env.SMTP_PORT ?? 587);
    const transport = createTransport({
      host, port, secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD ?? '' } : undefined,
      requireTLS: process.env.SMTP_REQUIRE_TLS !== 'false' && port !== 465, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
      tls: { minVersion: 'TLSv1.2' },
    });
    try {
      const result = await transport.sendMail({
        from: { name: sender.name, address: sender.address },
        to: digest.recipient, subject: digest.subject, text: digest.body,
      });
      if (!result.accepted?.length) throw new Error('Mail server did not accept the digest recipient.');
      await (updateDigestRunForJob(job.id, 'sent_to_server'));
      await (completeJob(job.id));
    } finally { transport.close(); }
    return;
  }
  if (job.type === 'email_send') {
    const payload = JSON.parse(job.payload_json) as { emailId?: string; unsubscribeToken?: string };
    if (!payload.emailId || !payload.unsubscribeToken) throw new Error('The approved email job is incomplete.');
    const email = await (getEmailForWorker(payload.emailId, job.workspace_id, payload.unsubscribeToken));
    if (!email) { await (completeJob(job.id)); return; }
    if (email.do_not_contact) { await (recordEmailFailed(email.id, job.workspace_id)); await (completeJob(job.id)); return; }
    const host = process.env.SMTP_HOST;
    const sender = await (senderForWorkspace(job.workspace_id));
    const publicBase = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '');
    if ((!host && process.env.EMAIL_TRANSPORT !== 'resend') || !sender || !publicBase) throw new Error('Mail server settings are incomplete.');
    const unsubscribeUrl = `${publicBase}/unsubscribe/${encodeURIComponent(payload.unsubscribeToken)}`;
    if (process.env.EMAIL_TRANSPORT === 'resend') {
      const messageId = await sendResendEmail({
        id: email.id, fromName: sender.name, fromAddress: sender.address, to: email.recipient,
        subject: email.subject, text: `${email.body}\n\nTo stop receiving these emails, visit: ${unsubscribeUrl}`,
        unsubscribeUrl,
      });
      await (recordEmailSent(email.id, job.workspace_id, messageId));
      await (completeJob(job.id));
      return;
    }
    const port = Number(process.env.SMTP_PORT ?? 587);
    const transport = createTransport({
      host, port, secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD ?? '' } : undefined,
      requireTLS: process.env.SMTP_REQUIRE_TLS !== 'false' && port !== 465, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
      tls: { minVersion: 'TLSv1.2' },
    });
    try {
      const result = await transport.sendMail({
        from: { name: sender.name, address: sender.address },
        to: email.recipient, subject: email.subject,
        text: `${email.body}\n\nTo stop receiving these emails, visit: ${unsubscribeUrl}`,
        headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      });
      if (!result.accepted?.length) throw new Error('Mail server did not accept the recipient.');
      await (recordEmailSent(email.id, job.workspace_id, result.messageId || null));
      await (completeJob(job.id));
    } finally { transport.close(); }
    return;
  }
  if (job.type !== 'card_read') throw new Error(`Unknown job type: ${job.type}`);
  const payload = JSON.parse(job.payload_json) as { scanId?: string };
  if (!payload.scanId) throw new Error('Card reading job has no scan.');
  const scan = await (getScanForWorker(payload.scanId, job.workspace_id));
  if (!scan || !scan.image_path || !scan.image_mime) throw new Error('The uploaded photo is missing. Upload it again.');
  if (scan.status === 'ready' || scan.status === 'saved' || scan.status === 'discarded') { await (completeJob(job.id)); return; }
  await (markScanReading(scan.id, job.workspace_id));
  if (process.env.AI_MODE === 'demo') {
    if (process.env.NODE_ENV !== 'test') throw new Error('Demo reading is allowed only in automated tests.');
    const result = {
      name: 'Demo Contact', title: 'Packaging Buyer', company: 'Acme Packaging',
      email: 'demo.contact@sample.invalid', phone: '+1 415 555 0199', website: 'https://acme.co',
      products: ['Sample cartons'], topics: [], uncertain: [],
    };
    await (updateScanRead(scan.id, job.workspace_id, result, []));
    await (completeJob(job.id));
    return;
  }
  await (markScanNeedsInput(scan.id, job.workspace_id, serverCardReaderUnavailableMessage));
  await (completeJob(job.id));
}

async function tick() {
  if (active) return;
  active = true;
  try {
    const job = await (claimNextJob());
    if (job) {
      try { await processJob(job); }
      catch (error) {
        const message = safeJobFailureMessage(job.type);
        await (failJobAttempt(job, message));
        if (job.type === 'daily_digest') {
          await (updateDigestRunForJob(job.id, job.attempts >= job.max_attempts ? 'failed' : 'queued', message));
        }
        if (job.type === 'email_send' && job.attempts >= job.max_attempts) {
          try { const payload = JSON.parse(job.payload_json) as { emailId?: string }; if (payload.emailId) await (recordEmailFailed(payload.emailId, job.workspace_id)); } catch { /* failed job remains visible */ }
        }
        console.error(JSON.stringify({ event: 'job_failed', jobId: job.id, workspaceId: job.workspace_id, type: job.type, attempt: job.attempts, error: message, providerCode: safeFailureCode(error) }));
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ event: 'worker_error', providerCode: safeFailureCode(error) }));
  } finally { active = false; }
}

export async function startWorker() {
  if (timer) return;
  timer = setInterval(async () => void await (tick()), 400);
  timer.unref();
  const schedule = async () => {
    try { await (scheduleReminderWork()); }
    catch { console.error(JSON.stringify({ event: 'reminder_scheduler_error' })); }
  };
  const reminderInterval = process.env.NODE_ENV === 'test' ? 1000 : 60_000;
  reminderTimer = setInterval(schedule, reminderInterval);
  reminderTimer.unref();
  await (schedule());
  void await (tick());
}
