import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import argon2 from 'argon2';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createTransport } from 'nodemailer';
import { leadMailTransportReady, sendResendEmail } from './resend-email.js';
import { CardReadOutputSchema, LoginSchema, OneTimeTokenSchema, PasswordResetConfirmSchema, PasswordResetRequestSchema, SaveLeadSchema, SignupSchema, SessionSchema, WebsiteSchema } from '../shared/contracts.js';
import {
  createSession,
  consumePasswordReset,
  consumeEmailVerification,
  createScan,
  createQrScan,
  QrScanStorageLimitError,
  createUser,
  createUserFromInvite,
  acceptInviteForUser,
  createWorkspaceInvite,
  listTeamSettings,
  saveWorkspaceEvent,
  updateWorkspaceMemberAccess,
  removeWorkspaceMember,
  revokeWorkspaceInvite,
  findActorBySession,
  findUserByEmail,
  findPasswordResetUser,
  findEmailVerificationUser,
  getCurrentEvent,
  listAccessibleEvents,
  hasSampleWorkspaceData,
  queuePasswordReset,
  queueEmailVerification,
  getDashboard,
  getAnalytics,
  listNotifications,
  markNotificationRead,
  getDigestRuns,
  listPeople,
  listCompanies,
  suggestCompanies,
  listProducts,
  getCompanyDetail,
  mergeCompany,
  updateCompanyDeal,
  getReportData,
  exportPeople,
  getWorkspaceExport,
  recordWorkspaceExport,
  getPersonDetail,
  getEmailDraftSuggestion,
  getFollowUpSuggestionContext,
  addPersonNote,
  addConversation,
  updatePersonStage,
  updatePersonDetails,
  setPersonArchived,
  markContactReplied,
  listTasks,
  createTask,
  TaskStorageLimitError,
  updateTaskAction,
  addVoiceNote,
  VoiceStorageLimitError,
  clearSampleWorkspaceData,
  clearPersonalWorkspaceData,
  setVoiceNoteText,
  setVoiceNoteSummary,
  getVoiceNote,
  deleteVoiceNote,
  createEmailDraft,
  EmailSendRateLimitError,
  NoteStorageLimitError,
  createAlternateEmailDraft,
  deletePerson,
  updateEmailDraft,
  approveEmailDraft,
  unsubscribeByToken,
  getEmailStatus,
  retryEmail,
  getDemoAccounts,
  getWorkspaceSetting,
  getWorkspaceEmailSettingsForWorker,
  getUserWorkspacePreference,
  getCaptureAfterSaveEmail,
  seedDemoData,
  getScan,
  listScans,
  listJobProblems,
  migrate,
  revokeSession,
  setWorkspaceSetting,
  setUserWorkspacePreference,
  setCaptureAfterSaveEmail,
  retryJob,
  discardScan,
  findScanByClientId,
  findScanByContentHash,
  findLikelySavedScan,
  applyQrToScan,
  markScanNeedsInputByActor,
  saveScannedLead,
  saveScannedMaterial,
  removeScannedMaterial,
  type ScanRow,
  validateCsrf,
  workspaceForActor,
  type ActorInfo,
  type WorkspaceInfo,
} from './db.js';
import { draftEmail, isAIProviderEnabled, isCardAIEnabled, readCard, suggestFollowUp } from './ai.js';
import { isGeminiCardEnabled } from './gemini-card.js';
import { summarizeCheckedTranscript } from './gemini-conversation.js';
import { imageDifferenceHash } from './visual-hash.js';
import { startWorker } from './worker.js';
import { verifyLoginPassword } from './auth.js';

type RequestContext = { actor: ActorInfo; workspace: WorkspaceInfo };
const SESSION_COOKIE = 'gather_session';
const CSRF_COOKIE = 'gather_csrf';
const isProduction = process.env.NODE_ENV === 'production';
const publicDemoMode = isProduction && process.env.GATHER_DEMO_MODE === 'true';
const taskCreationLimit = (() => {
  if (isProduction) return 120;
  if (process.env.NODE_ENV !== 'test' || process.env.GATHER_TASK_RATE_LIMIT === undefined) return 1000;
  const testLimit = Number(process.env.GATHER_TASK_RATE_LIMIT);
  if (!Number.isSafeInteger(testLimit) || testLimit < 1 || testLimit > 1000) throw new Error('GATHER_TASK_RATE_LIMIT must be a whole number from 1 to 1000 in tests.');
  return testLimit;
})();
const secureCookie = isProduction ? '; Secure' : '';
const cookieOptions = `Path=/; SameSite=Lax${secureCookie}`;

await (migrate());
if (publicDemoMode) {
  const demoPasswordHash = await argon2.hash(process.env.DEMO_PASSWORD ?? 'Gather-Demo-2026!', { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  await (seedDemoData(demoPasswordHash));
}

const app = express();
app.disable('x-powered-by');
if (isProduction) app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'same-site' },
  contentSecurityPolicy: isProduction ? { directives: { scriptSrc: ["'self'", "'wasm-unsafe-eval'"], workerSrc: ["'self'"], connectSrc: ["'self'", 'https://huggingface.co', 'https://*.hf.co', 'https://*.huggingface.co', 'https://*.xethub.hf.co'] } } : false,
}));
app.use(express.json({ limit: '2mb', strict: true }));
await startWorker();

function cookieValue(req: Request, name: string) {
  const entry = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!entry) return undefined;
  try { return decodeURIComponent(entry.slice(name.length + 1)); } catch { return undefined; }
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function csrfGuard(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/api/auth/csrf' || req.path.startsWith('/api/unsubscribe/') || req.path.startsWith('/unsubscribe/')) return next();
  const cookieToken = cookieValue(req, CSRF_COOKIE);
  const headerToken = req.header('x-csrf-token');
  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
    return res.status(403).json({ code: 'csrf', message: 'This request expired. Refresh the page and try again.' });
  }
  const rawSession = cookieValue(req, SESSION_COOKIE);
  if (rawSession && !await (validateCsrf(rawSession, headerToken))) {
    return res.status(403).json({ code: 'csrf', message: 'This request expired. Refresh the page and try again.' });
  }
  next();
}

app.use(csrfGuard);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { code: 'rate_limit', message: 'Too many sign-in attempts. Wait 15 minutes and try again.' },
});
const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isProduction ? 5 : 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { code: 'export_rate_limit', message: 'Too many exports were requested. Wait 15 minutes and try again.' },
});
const recoveryRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { code: 'recovery_rate_limit', message: 'Too many account email requests. Wait 15 minutes and try again.' },
});
const recoveryTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { code: 'recovery_token_rate_limit', message: 'Too many link attempts. Wait 15 minutes and try again.' },
});
const aiSuggestionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isProduction ? 30 : 200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { code: 'suggestion_rate_limit', message: 'Too many suggestions were requested. Wait a little and try again.' },
});
const emailTestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { code: 'email_test_rate_limit', message: 'Too many test messages. Wait an hour before trying again.' },
});
const voiceLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (_req, res) => (res.locals.context as RequestContext | undefined)?.actor.id ?? 'unauthenticated',
  message: { code: 'voice_rate_limit', message: 'Too many recordings were added. Wait an hour before trying again.' },
});
const noteLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: isProduction ? 120 : 1000,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (_req, res) => (res.locals.context as RequestContext | undefined)?.actor.id ?? 'unauthenticated',
  message: { code: 'note_rate_limit', message: 'Too many notes were saved. Wait an hour before trying again.' },
});
const taskLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: taskCreationLimit,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (_req, res) => (res.locals.context as RequestContext | undefined)?.actor.id ?? 'unauthenticated',
  message: { code: 'task_rate_limit', message: 'Too many follow-ups were saved. Wait an hour and try again.' },
});

function makeToken() { return randomBytes(32).toString('base64url'); }
function accountMailReady() {
  const publicBase = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '');
  let originReady = false;
  try {
    const url = new URL(publicBase ?? '');
    originReady = url.protocol === 'https:' || !isProduction;
  } catch { /* missing or malformed canonical URL */ }
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM_ADDRESS && originReady);
}
async function workspaceMailSender(workspaceId: string) {
  const configured = await (getWorkspaceEmailSettingsForWorker(workspaceId));
  const fromAddress = configured?.fromAddress ?? process.env.SMTP_FROM_ADDRESS?.trim();
  const fromName = configured?.fromName ?? process.env.SMTP_FROM_NAME?.trim() ?? 'Gather';
  if (!leadMailTransportReady() || !fromAddress || !z.email().safeParse(fromAddress).success || !fromName || /[\r\n]/.test(fromName)) return null;
  return { fromAddress, fromName: fromName.slice(0, 100) };
}
const requireEmailVerification = (isProduction && !publicDemoMode) || process.env.REQUIRE_EMAIL_VERIFICATION === 'true';
function setSessionCookies(res: Response, sessionToken: string, csrfToken: string) {
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; ${cookieOptions}; HttpOnly; Max-Age=604800`,
    `${CSRF_COOKIE}=${encodeURIComponent(csrfToken)}; ${cookieOptions}; Max-Age=604800`,
  ]);
}
function clearSessionCookies(res: Response) {
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE}=; ${cookieOptions}; HttpOnly; Max-Age=0`,
    `${CSRF_COOKIE}=; ${cookieOptions}; Max-Age=0`,
  ]);
}
async function issueSession(res: Response, userId: string) {
  const sessionToken = makeToken();
  const csrfToken = makeToken();
  await (createSession(userId, sessionToken, csrfToken, new Date(Date.now() + 7 * 86400000).toISOString()));
  setSessionCookies(res, sessionToken, csrfToken);
  return csrfToken;
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/capabilities', (_req, res) => res.json({
  cardReading: process.env.AI_MODE === 'demo' && process.env.NODE_ENV === 'test' ? 'demo' : isGeminiCardEnabled() ? 'provider' : 'browser',
  aiCardAssist: isCardAIEnabled(),
  aiCardProvider: isGeminiCardEnabled() ? 'gemini' : isAIProviderEnabled() ? 'anthropic' : null,
  emailDrafts: isAIProviderEnabled(),
  followUpSuggestions: isAIProviderEnabled(),
  emailSending: Boolean(leadMailTransportReady() && process.env.SMTP_FROM_ADDRESS),
  voiceTranscription: 'browser',
}));

app.get('/api/auth/csrf', async (req, res) => {
  const rawSession = cookieValue(req, SESSION_COOKIE);
  const currentToken = cookieValue(req, CSRF_COOKIE);
  if (rawSession && currentToken && await (validateCsrf(rawSession, currentToken))) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ csrfToken: currentToken });
  }
  const csrfToken = makeToken();
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE}=; ${cookieOptions}; HttpOnly; Max-Age=0`,
    `${CSRF_COOKIE}=${encodeURIComponent(csrfToken)}; ${cookieOptions}; Max-Age=3600`,
  ]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ csrfToken });
});

app.post('/api/auth/login', loginLimiter, async (req, res, next) => {
  try {
    const input = LoginSchema.parse(req.body);
    const user = await (findUserByEmail(input.email));
    const passwordValid = await verifyLoginPassword(user, input.password);
    if (!user || user.disabled_at || !passwordValid) {
      return res.status(401).json({ code: 'sign_in_failed', message: 'That email and password did not match. Try again.' });
    }
    if (requireEmailVerification && !user.email_verified_at) {
      return res.status(403).json({ code: 'email_unverified', message: 'Verify your email before signing in. You can request another verification link.' });
    }
    const csrfToken = await (issueSession(res, user.id));
    res.json({ csrfToken });
  } catch (error) { next(error); }
});

app.post('/api/auth/signup', loginLimiter, async (req, res, next) => {
  try {
    const input = SignupSchema.parse(req.body);
    if (requireEmailVerification && !accountMailReady()) return res.status(503).json({ code: 'verification_unavailable', message: 'Account verification email is not set up. No account was created.' });
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const existing = await (findUserByEmail(input.email));
    if (existing) {
      if (requireEmailVerification) return res.status(202).json({ requiresVerification: true, message: 'If this email can receive account instructions, check its inbox. No inbox delivery is guaranteed.' });
      return res.status(409).json({ code: 'email_in_use', message: 'An account already uses that email. Sign in instead.' });
    }
    const result = input.inviteToken
      ? await (createUserFromInvite({ name: input.name, email: input.email, passwordHash, token: input.inviteToken, emailVerified: !requireEmailVerification }))
      : await (createUser({
          name: input.name,
          email: input.email,
          passwordHash,
          kind: input.workspaceKind,
          workspaceName: input.workspaceKind === 'company' ? input.workspaceName! : `${input.name}'s private space`,
          emailVerified: !requireEmailVerification,
        }));
    if (requireEmailVerification) {
      await (queueEmailVerification(result.userId, makeToken(), new Date(Date.now() + 60 * 60_000).toISOString()));
      return res.status(202).json({ requiresVerification: true, message: 'If this email can receive account instructions, check its inbox. No inbox delivery is guaranteed.' });
    }
    const csrfToken = await (issueSession(res, result.userId));
    res.status(201).json({ csrfToken, workspaceId: result.workspaceId });
  } catch (error) { next(error); }
});

app.post('/api/auth/password-reset', recoveryRequestLimiter, async (req, res, next) => {
  try {
    const input = PasswordResetRequestSchema.parse(req.body);
    if (!accountMailReady()) return res.status(202).json({ message: 'Password reset email is not set up. No message was sent.' });
    const user = await (findUserByEmail(input.email));
    if (user && !user.disabled_at) {
      const token = makeToken();
      await (queuePasswordReset(user.id, token, new Date(Date.now() + 60 * 60_000).toISOString()));
    }
    res.status(202).json({ message: 'If an account uses this email, check for a recent reset message. Wait five minutes before requesting another link. Mail-server acceptance does not confirm inbox delivery.' });
  } catch (error) { next(error); }
});

app.post('/api/auth/email-verification/resend', recoveryRequestLimiter, async (req, res, next) => {
  try {
    const input = PasswordResetRequestSchema.parse(req.body);
    if (!accountMailReady()) return res.status(202).json({ message: 'Email verification is not set up. No message was sent.' });
    const user = await (findUserByEmail(input.email));
    if (user && !user.disabled_at && !user.email_verified_at) {
      await (queueEmailVerification(user.id, makeToken(), new Date(Date.now() + 60 * 60_000).toISOString()));
    }
    res.status(202).json({ message: 'If the account still needs verification, check for the most recent verification message. Mail-server acceptance does not confirm inbox delivery.' });
  } catch (error) { next(error); }
});

app.post('/api/auth/email-verification/confirm', recoveryTokenLimiter, async (req, res, next) => {
  try {
    const input = OneTimeTokenSchema.parse(req.body);
    if (!await (findEmailVerificationUser(input.token))) return res.status(400).json({ code: 'verification_invalid', message: 'This verification link has expired or was already used. Request a new one.' });
    const userId = await (consumeEmailVerification(input.token));
    if (!userId) return res.status(400).json({ code: 'verification_invalid', message: 'This verification link has expired or was already used. Request a new one.' });
    const csrfToken = await (issueSession(res, userId));
    res.json({ verified: true, csrfToken });
  } catch (error) { next(error); }
});

app.post('/api/auth/password-reset/confirm', recoveryTokenLimiter, async (req, res, next) => {
  try {
    const input = PasswordResetConfirmSchema.parse(req.body);
    if (!await (findPasswordResetUser(input.token))) return res.status(400).json({ code: 'reset_invalid', message: 'This reset link has expired or was already used. Request a new one.' });
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    if (!await (consumePasswordReset(input.token, passwordHash))) return res.status(400).json({ code: 'reset_invalid', message: 'This reset link has expired or was already used. Request a new one.' });
    clearSessionCookies(res);
    res.json({ reset: true, message: 'Password updated. Sign in with your new password.' });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', async (req, res) => {
  const token = cookieValue(req, SESSION_COOKIE);
  if (token) await (revokeSession(token));
  clearSessionCookies(res);
  res.json({ signedOut: true });
});

app.get('/api/auth/me', async (req, res) => {
  const token = cookieValue(req, SESSION_COOKIE);
  const actor = token ? await (findActorBySession(token)) : undefined;
  if (!actor || actor.workspaces.length === 0) return res.json({ authenticated: false });
  const requestedWorkspace = req.header('x-workspace-id');
  const workspace = (requestedWorkspace && actor.workspaces.find((item) => item.id === requestedWorkspace)) || actor.workspaces[0];
  const result = SessionSchema.safeParse({
    user: { id: actor.id, name: actor.name, email: actor.email },
    workspace,
    availableWorkspaces: actor.workspaces,
    csrfToken: cookieValue(req, CSRF_COOKIE) ?? '',
    demoMode: !isProduction || publicDemoMode,
  });
  if (!result.success) return res.status(500).json({ code: 'session_invalid', message: 'Your session needs to be refreshed. Sign in again.' });
  res.setHeader('Cache-Control', 'no-store');
  res.json(result.data);
});

if (!isProduction || publicDemoMode) {
  app.get('/api/dev/demo-accounts', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ accounts: await (getDemoAccounts()) });
  });
  app.post('/api/dev/login-as', async (req, res) => {
    const parsed = z.object({ accountId: z.string().min(1), workspaceId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ code: 'invalid_demo_account', message: 'Choose a sample account.' });
    const accounts = await getDemoAccounts();
    const account = accounts.find((item) => item.id === parsed.data.accountId && item.workspaceId === parsed.data.workspaceId);
    if (!account) return res.status(404).json({ code: 'demo_account_missing', message: 'That sample account is no longer available.' });
    const csrfToken = await (issueSession(res, account.id));
    res.json({ csrfToken, workspaceId: account.workspaceId });
  });
}

async function requireContext(req: Request, res: Response, next: NextFunction) {
  const rawSession = cookieValue(req, SESSION_COOKIE);
  const actor = rawSession ? await (findActorBySession(rawSession)) : undefined;
  if (!actor) return res.status(401).json({ code: 'sign_in_required', message: 'Sign in to continue.' });
  const requestedId = req.header('x-workspace-id');
  const workspace = requestedId ? await (workspaceForActor(actor.id, requestedId)) : actor.workspaces[0];
  if (!workspace) return res.status(403).json({ code: 'workspace_access', message: 'You no longer have access to this space. Choose another space.' });
  res.locals.context = { actor, workspace } satisfies RequestContext;
  next();
}

app.get('/api/workspace', requireContext, async (_req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const event = await (getCurrentEvent(actor.id, workspace.id));
  res.json({
    workspace: { id: workspace.id, name: workspace.name, kind: workspace.kind, role: workspace.role },
    event: event ? { id: event.id, name: event.name, startsAt: event.starts_at, endsAt: event.ends_at, timeZone: event.time_zone } : null,
    user: { id: actor.id, name: actor.name },
    sampleData: !isProduction && await (hasSampleWorkspaceData(actor.id, workspace.id)),
  });
});

app.get('/api/events/accessible', requireContext, async (_req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ events: await listAccessibleEvents(actor.id, workspace.id) });
});

const onboardingSteps = ['knowledge', 'email', 'capture'] as const;
const onboardingStateSchema = z.object({
  completed: z.array(z.enum(onboardingSteps)).max(3),
  skipped: z.array(z.enum(onboardingSteps)).max(3),
}).strict().refine((state) => new Set([...state.completed, ...state.skipped]).size === state.completed.length + state.skipped.length, 'Each setup step can appear only once.');

async function getOnboardingState(actorId: string, workspaceId: string) {
  const value = await (getUserWorkspacePreference(actorId, workspaceId, 'onboarding'));
  const parsed = onboardingStateSchema.safeParse(value);
  return parsed.success ? parsed.data : { completed: [], skipped: [] };
}

async function updateOnboardingStep(actorId: string, workspaceId: string, step: typeof onboardingSteps[number], completed: boolean) {
  const state = await (getOnboardingState(actorId, workspaceId));
  const done = new Set(state.completed);
  const skipped = new Set(state.skipped);
  skipped.delete(step);
  if (completed) done.add(step);
  else done.delete(step);
  await (setUserWorkspacePreference(actorId, workspaceId, 'onboarding', { completed: [...done], skipped: [...skipped] }));
}

app.get('/api/onboarding', requireContext, async (_req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const sender = await (workspaceMailSender(workspace.id));
  const mailReady = Boolean(leadMailTransportReady() && sender);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    state: await (getOnboardingState(actor.id, workspace.id)),
    canEditKnowledge: workspace.kind === 'personal' || workspace.role === 'admin',
    canTestEmail: workspace.kind === 'personal' || workspace.role === 'admin',
    mailReady,
    senderAddress: sender?.fromAddress ?? null,
    senderName: sender?.fromName ?? process.env.SMTP_FROM_NAME?.trim() ?? 'Gather',
    accountEmail: actor.email,
    demoEmailAddress: isProduction ? null : process.env.DEMO_EMAIL_ADDRESS?.trim() || 'dhruvtube11@gmail.com',
  });
});

app.put('/api/onboarding', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const parsed = onboardingStateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ code: 'invalid_onboarding', message: 'Check the setup steps and try again.' });
  await (setUserWorkspacePreference(actor.id, workspace.id, 'onboarding', parsed.data));
  res.json({ state: parsed.data });
});

app.post('/api/onboarding/test-email', emailTestLimiter, requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  if (workspace.kind === 'company' && workspace.role !== 'admin') return res.status(403).json({ code: 'email_test_permission', message: 'Ask your company admin to test the sending setup.' });
  const parsed = z.object({ recipient: z.email().max(254).optional() }).strict().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ code: 'invalid_test_recipient', message: 'Enter a valid test email address.' });
  const recipient = parsed.data.recipient ?? actor.email;
  const host = process.env.SMTP_HOST?.trim();
  const sender = await (workspaceMailSender(workspace.id));
  if ((!host && process.env.EMAIL_TRANSPORT !== 'resend') || !sender) {
    return res.status(503).json({ code: 'email_not_configured', message: 'Mail sending is not set up yet. No test email was sent.' });
  }
  if (process.env.EMAIL_TRANSPORT === 'resend') {
    try {
      await sendResendEmail({ id: randomUUID(), fromAddress: sender.fromAddress, fromName: sender.fromName,
        to: recipient, subject: 'Gather test email',
        text: `This test message was requested from the Gather setup screen for ${workspace.name}. The provider accepted it; that does not confirm inbox delivery.` });
      return res.json({ status: 'sent_to_server', message: `The email provider accepted a test message for ${recipient}. Inbox delivery is not confirmed.` });
    } catch {
      return res.status(502).json({ code: 'email_test_failed', message: 'The email provider did not accept the test message. Check its key and verified sender.' });
    }
  }
  const port = Number(process.env.SMTP_PORT ?? 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(503).json({ code: 'email_settings_invalid', message: 'The mail server settings need attention. No test email was sent.' });
  const transport = createTransport({
    host, port, secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD ?? '' } : undefined,
    requireTLS: process.env.SMTP_REQUIRE_TLS !== 'false' && port !== 465,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    tls: { minVersion: 'TLSv1.2' },
  });
  try {
    const result = await transport.sendMail({
      from: { name: sender.fromName, address: sender.fromAddress },
      to: recipient,
      subject: 'Gather test email',
      text: `This test message was requested from the Gather setup screen for ${workspace.name}. The mail server accepted it; that does not confirm inbox delivery.`,
    });
    if (!result.accepted?.some((address) => address.toLowerCase() === recipient.toLowerCase())) throw new Error('recipient_not_accepted');
    res.json({ status: 'sent_to_server', message: `The mail server accepted a test message for ${recipient}. Inbox delivery is not confirmed.` });
  } catch {
    console.error(JSON.stringify({ event: 'setup_email_test_failed', workspaceId: workspace.id }));
    res.status(502).json({ code: 'email_test_failed', message: 'The mail server did not accept the test message. Check its settings. No delivery is confirmed.' });
  } finally { transport.close(); }
});

app.get('/api/team', requireContext, async (_req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  try { res.json(await (listTeamSettings(actor.id, workspace.id))); }
  catch (error) { res.status(403).json({ code: 'team_access', message: error instanceof Error ? error.message : 'Only a company admin can manage the team.' }); }
});

app.post('/api/team/invites', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const parsed = z.object({ role: z.enum(['manager','representative']), eventIds: z.array(z.string().min(1).max(80)).max(100) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ code: 'invalid_invite', message: 'Choose a role and the events this person can access.' });
  try { res.status(201).json(await (createWorkspaceInvite(actor.id, workspace.id, parsed.data.role, parsed.data.eventIds))); }
  catch (error) { res.status(403).json({ code: 'invite_not_created', message: error instanceof Error ? error.message : 'The invite could not be created.' }); }
});

const EventInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  timeZone: z.string().min(1).max(80),
  spendMinor: z.number().int().nonnegative().nullable(),
  active: z.boolean(),
}).strict();

app.post('/api/events', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const parsed = EventInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ code: 'invalid_event', message: 'Check the event name, dates, time zone, and spend.' });
  try {
    const id = await (saveWorkspaceEvent(actor.id, workspace.id, null, parsed.data));
    res.status(201).json({ id });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The event could not be saved.';
    res.status(message.startsWith('Only a company admin') ? 403 : 400).json({ code: 'event_not_saved', message });
  }
});

app.put('/api/events/:eventId', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().min(1).max(80).safeParse(req.params.eventId);
  const parsed = EventInputSchema.safeParse(req.body);
  if (!id.success || !parsed.success) return res.status(400).json({ code: 'invalid_event', message: 'Check the event name, dates, time zone, and spend.' });
  try {
    const saved = await (saveWorkspaceEvent(actor.id, workspace.id, id.data, parsed.data));
    if (!saved) return res.status(404).json({ code: 'event_missing', message: 'This event is no longer available.' });
    res.json({ id: saved });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The event could not be saved.';
    res.status(message.startsWith('Only a company admin') ? 403 : 400).json({ code: 'event_not_saved', message });
  }
});

app.delete('/api/team/invites/:inviteId', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().uuid().safeParse(req.params.inviteId);
  if (!id.success) return res.status(400).json({ code: 'invalid_invite', message: 'Choose an invite to cancel.' });
  try {
    if (!await (revokeWorkspaceInvite(actor.id, workspace.id, id.data))) return res.status(404).json({ code: 'invite_missing', message: 'This invite is no longer available.' });
    res.json({ revoked: true });
  } catch (error) { res.status(403).json({ code: 'invite_not_revoked', message: error instanceof Error ? error.message : 'The invite could not be cancelled.' }); }
});

app.delete('/api/team/members/:userId', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().uuid().safeParse(req.params.userId);
  if (!id.success) return res.status(400).json({ code: 'invalid_member', message: 'Choose a team member to remove.' });
  try {
    if (!await (removeWorkspaceMember(actor.id, workspace.id, id.data))) return res.status(404).json({ code: 'member_missing', message: 'This person is no longer on the team.' });
    res.json({ removed: true });
  } catch (error) { res.status(409).json({ code: 'member_not_removed', message: error instanceof Error ? error.message : 'This person could not be removed.' }); }
});

app.put('/api/team/members/:userId/access', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().min(1).max(80).safeParse(req.params.userId);
  const parsed = z.object({ role: z.enum(['manager','representative']), eventIds: z.array(z.string().min(1).max(80)).max(100) }).strict().safeParse(req.body);
  if (!id.success || !parsed.success) return res.status(400).json({ code: 'invalid_member_access', message: 'Choose a team role and the events this person can access.' });
  try {
    if (!await (updateWorkspaceMemberAccess(actor.id, workspace.id, id.data, parsed.data.role, parsed.data.eventIds))) {
      return res.status(404).json({ code: 'member_missing', message: 'This person is no longer on the team.' });
    }
    res.json({ updated: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'This person’s access could not be updated.';
    res.status(message.startsWith('Only a company admin') ? 403 : 409).json({ code: 'member_access_not_updated', message });
  }
});

app.post('/api/invites/accept', requireContext, async (req, res) => {
  const { actor } = res.locals.context as RequestContext;
  const parsed = z.object({ token: z.string().min(40).max(100) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ code: 'invalid_invite', message: 'This invite link is not valid.' });
  try { res.json({ workspaceId: await (acceptInviteForUser(actor.id, parsed.data.token)) }); }
  catch (error) { res.status(409).json({ code: 'invite_not_accepted', message: error instanceof Error ? error.message : 'This invite could not be accepted.' }); }
});

app.get('/api/dashboard', requireContext, async (_req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  res.setHeader('Cache-Control', 'no-store');
  res.json(await (getDashboard(actor.id, workspace.id)));
});

app.get('/api/notifications', requireContext, async (_req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  res.setHeader('Cache-Control', 'no-store');
  res.json(await (listNotifications(actor.id, workspace.id)));
});

app.post('/api/notifications/:notificationId/read', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().uuid().safeParse(req.params.notificationId);
  if (!id.success || !await (markNotificationRead(actor.id, workspace.id, id.data))) return res.status(404).json({ code: 'notification_missing', message: 'This reminder is no longer available.' });
  res.json({ read: true });
});

app.get('/api/tasks', requireContext, async (_req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  res.setHeader('Cache-Control', 'no-store'); res.json({ tasks: await (listTasks(actor.id, workspace.id)) });
});

app.post('/api/contacts/:contactId/tasks', requireContext, taskLimiter, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const contactId = z.string().min(1).max(80).safeParse(req.params.contactId);
  const parsed = z.object({
    kind: z.enum(['follow_up','meeting']), dueAt: z.iso.datetime(), title: z.string().trim().max(150).default(''),
    note: z.string().trim().max(2000).default(''), timeZone: z.string().min(1).max(80), allowOverlap: z.boolean().default(false),
  }).strict().safeParse(req.body);
  if (!contactId.success || !parsed.success) return res.status(400).json({ code: 'invalid_task', message: 'Check the date, time, and note, then try again.' });
  try {
    const result = await (createTask(actor.id, workspace.id, contactId.data, parsed.data));
    if (!result.created) return res.status(409).json({ code: 'meeting_overlap', message: `This overlaps with a confirmed meeting for ${result.conflict.contact_name}. Choose another time or save it anyway.`, conflict: result.conflict });
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof TaskStorageLimitError) return res.status(413).json({ code: error.code, message: error.message });
    const message = error instanceof Error ? error.message : 'This follow-up could not be saved.';
    res.status(message.startsWith('You do not have access') ? 403 : 404).json({ code: 'task_not_saved', message });
  }
});

app.post('/api/tasks/:taskId/action', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().min(1).max(80).safeParse(req.params.taskId);
  const parsed = z.object({ action: z.enum(['done','snooze_1','snooze_3','snooze_7','confirm','no_show','cancel']) }).strict().safeParse(req.body);
  if (!id.success || !parsed.success) return res.status(400).json({ code: 'invalid_task_action', message: 'Choose a follow-up action and try again.' });
  if (!await (updateTaskAction(actor.id, workspace.id, id.data, parsed.data.action))) return res.status(404).json({ code: 'task_missing', message: 'This follow-up is no longer available.' });
  res.json({ updated: true });
});

app.get('/api/contacts', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const query = z.string().max(100).safeParse(req.query.q ?? '');
  const archived = z.enum(['true', 'false']).optional().safeParse(req.query.archived);
  if (!query.success || !archived.success) return res.status(400).json({ code: 'invalid_search', message: 'Check the people search and try again.' });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ people: await (listPeople(actor.id, workspace.id, query.data, archived.data === 'true')) });
});

app.get('/api/products', requireContext, async (_req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ products: await (listProducts(actor.id, workspace.id)) });
});

app.get('/api/companies', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const query = z.string().max(100).safeParse(req.query.q ?? '');
  if (!query.success) return res.status(400).json({ code: 'invalid_search', message: 'Search text is too long.' });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ companies: await (listCompanies(actor.id, workspace.id, query.data)) });
});

app.get('/api/companies/suggestions', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const parsed = z.object({ name: z.string().max(160).default(''), website: z.string().max(300).default(''), email: z.string().max(254).default('') }).strict().safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ code: 'invalid_company_search', message: 'Check the company details and try again.' });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ companies: await (suggestCompanies(actor.id, workspace.id, parsed.data.name, parsed.data.website, parsed.data.email)) });
});

app.get('/api/companies/:companyId', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().min(1).max(80).safeParse(req.params.companyId);
  if (!id.success) return res.status(404).json({ code: 'company_missing', message: 'This company is no longer available.' });
  const result = await (getCompanyDetail(actor.id, workspace.id, id.data));
  if (!result) return res.status(404).json({ code: 'company_missing', message: 'This company is no longer available.' });
  res.setHeader('Cache-Control', 'no-store'); res.json(result);
});

app.post('/api/companies/:companyId/merge', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const source = z.string().min(1).max(80).safeParse(req.params.companyId);
  const parsed = z.object({ targetCompanyId: z.string().min(1).max(80), confirmation: z.literal('MERGE') }).strict().safeParse(req.body);
  if (!source.success || !parsed.success) return res.status(400).json({ code: 'invalid_company_merge', message: 'Choose the company to keep and type MERGE.' });
  try { res.json(await (mergeCompany(actor.id, workspace.id, source.data, parsed.data.targetCompanyId))); }
  catch (error) { res.status(409).json({ code: 'company_merge_unavailable', message: (error as Error).message }); }
});

app.put('/api/companies/:companyId/deal', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().min(1).max(80).safeParse(req.params.companyId);
  const parsed = z.object({ valueMinor: z.number().int().nonnegative().nullable(), status: z.enum(['open','won','lost']).nullable() }).strict().safeParse(req.body);
  if (!id.success || !parsed.success) return res.status(400).json({ code: 'invalid_deal', message: 'Enter a valid non-negative deal value.' });
  try {
    if (!await (updateCompanyDeal(actor.id, workspace.id, id.data, parsed.data.valueMinor, parsed.data.status))) return res.status(404).json({ code: 'company_missing', message: 'This company is no longer available.' });
    res.json({ updated: true });
  } catch (error) { res.status(403).json({ code: 'deal_permission', message: error instanceof Error ? error.message : 'You cannot change this deal value.' }); }
});

app.get('/api/analytics', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  if (workspace.kind === 'company' && !['admin','manager'].includes(workspace.role)) return res.status(403).json({ code: 'analytics_permission', message: 'Company analytics are available to admins and managers.' });
  const query = z.object({ days: z.enum(['7','30','90']).default('30'), eventId: z.string().max(100).default('') }).strict().safeParse(req.query);
  if (!query.success) return res.status(400).json({ code: 'analytics_filters', message: 'Choose 7, 30, or 90 days and an available event.' });
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await (getAnalytics(actor.id, workspace.id, Number(query.data.days), query.data.eventId)));
  } catch (error) { res.status(400).json({ code: 'analytics_event', message: error instanceof Error ? error.message : 'Analytics could not be loaded.' }); }
});

app.get('/api/reports', requireContext, async (_req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  if (workspace.kind !== 'company' || !['admin','manager'].includes(workspace.role)) return res.status(403).json({ code: 'report_permission', message: 'Reports are available to company admins and managers.' });
  res.setHeader('Cache-Control', 'no-store'); res.json(await (getReportData(actor.id, workspace.id)));
});

app.get('/api/export/people.csv', exportLimiter, requireContext, async (_req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  if (workspace.kind !== 'company' || !['admin','manager'].includes(workspace.role)) return res.status(403).json({ code: 'export_permission', message: 'Only company admins and managers can export this list.' });
  await (recordWorkspaceExport(actor.id, workspace.id, 'people_csv'));
  const rows = await (exportPeople(actor.id, workspace.id));
  const columns = ['name','title','company','email','phone','website','quality','stage'] as const;
  const cell = (value: unknown) => {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const csv = [columns.map(cell).join(','), ...rows.map((row) => columns.map((column) => cell(row[column])).join(','))].join('\r\n');
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="gather-people.csv"');
  res.send(csv);
});

app.get('/api/export/data.json', exportLimiter, requireContext, async (_req, res, next) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  let dataExport: Awaited<ReturnType<typeof getWorkspaceExport>>;
  try { dataExport = await (getWorkspaceExport(actor.id, workspace.id)); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'This workspace cannot be exported.';
    return res.status(message.startsWith('Only the company admin') ? 403 : 500).json({ code: 'export_permission', message });
  }
  const uploadsRoot = resolve(process.env.UPLOADS_PATH ?? 'uploads');
  const safeMedia = dataExport.media.map((item) => {
    const filePath = resolve(item.path);
    if (!filePath.startsWith(`${uploadsRoot}${sep}`)) throw new Error('An attached file is outside the private uploads folder. Export was stopped.');
    return { ...item, path: filePath };
  });
  await (recordWorkspaceExport(actor.id, workspace.id, 'workspace_json'));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="gather-${workspace.kind}-export.json"`);
  const writeChunk = async (chunk: string) => { if (!res.write(chunk)) await new Promise<void>((resolveDrain) => res.once('drain', resolveDrain)); };
  try {
    const prefix = JSON.stringify({ format: 'gather-data-export', schemaVersion: 1, exportedAt: new Date().toISOString(), data: dataExport.data });
    await writeChunk(`${prefix.slice(0, -1)},"media":[`);
    for (let index = 0; index < safeMedia.length; index++) {
      const item = safeMedia[index]!;
      let contentBase64: string | null = null;
      try { contentBase64 = (await readFile(item.path)).toString('base64'); } catch { /* Keep a visible unavailable marker instead of claiming the attachment was included. */ }
      const extension = item.mimeType === 'image/jpeg' ? 'jpg' : item.mimeType === 'image/png' ? 'png' : item.mimeType === 'image/webp' ? 'webp' : item.mimeType === 'audio/ogg' ? 'ogg' : item.mimeType === 'audio/mp4' ? 'm4a' : 'webm';
      const manifest = { kind: item.kind, recordId: item.recordId, mimeType: item.mimeType, fileName: `${item.recordId}.${extension}`, available: contentBase64 !== null, ...(contentBase64 === null ? {} : { contentBase64 }) };
      await writeChunk(`${index ? ',' : ''}${JSON.stringify(manifest)}`);
    }
    res.end(']}');
  } catch (error) { next(error); }
});

app.get('/api/contacts/:contactId', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().min(1).max(80).safeParse(req.params.contactId);
  if (!id.success) return res.status(404).json({ code: 'person_missing', message: 'This person is no longer available.' });
  const detail = await (getPersonDetail(actor.id, workspace.id, id.data));
  if (!detail) return res.status(404).json({ code: 'person_missing', message: 'This person is no longer available.' });
  res.setHeader('Cache-Control', 'no-store'); res.json(detail);
});

app.patch('/api/contacts/:contactId/archive', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().min(1).max(80).safeParse(req.params.contactId);
  const parsed = z.object({ archived: z.boolean() }).strict().safeParse(req.body);
  if (!id.success) return res.status(404).json({ code: 'person_missing', message: 'This person is no longer available.' });
  if (!parsed.success) return res.status(400).json({ code: 'invalid_archive_action', message: 'Choose whether to archive or restore this person.' });
  try {
    if (!await (setPersonArchived(actor.id, workspace.id, id.data, parsed.data.archived))) {
      return res.status(409).json({ code: 'archive_state_changed', message: 'This person already has a different status. Refresh and try again.' });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ archived: parsed.data.archived });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'This person could not be updated.';
    const denied = message.startsWith('Workspace access changed') || message.startsWith('You do not have access') || message.startsWith('Only a company') || message.startsWith('Only the owner');
    res.status(denied ? 403 : 404).json({ code: denied ? 'archive_permission' : 'person_missing', message });
  }
});

app.delete('/api/contacts/:contactId', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().min(1).max(80).safeParse(req.params.contactId);
  const parsed = z.object({ confirmation: z.literal('DELETE') }).strict().safeParse(req.body);
  if (!id.success) return res.status(404).json({ code: 'person_missing', message: 'This person is no longer available.' });
  if (!parsed.success) return res.status(400).json({ code: 'confirmation_required', message: 'Type DELETE to confirm removing this person and their event history.' });
  try {
    const deleted = await (deletePerson(actor.id, workspace.id, id.data));
    if (!deleted) return res.status(404).json({ code: 'person_missing', message: 'This person is no longer available.' });
    const cleanup = await Promise.allSettled(deleted.mediaPaths.map((path) => unlink(path)));
    const mediaCleanupPending = cleanup.filter((result) => result.status === 'rejected').length;
    if (mediaCleanupPending) console.error(`Person deletion left ${mediaCleanupPending} media file(s) for cleanup.`);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ deleted: true, counts: deleted.counts, mediaCleanupPending });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'This person could not be deleted.';
    const denied = message.startsWith('Workspace access changed') || message.startsWith('You do not have access') || message.startsWith('Only a company admin');
    const busy = message.startsWith('A background task');
    const missing = message.startsWith('This person is no longer available');
    res.status(denied ? 403 : missing ? 404 : busy ? 409 : 500).json({ code: denied ? 'delete_permission' : missing ? 'person_missing' : busy ? 'delete_busy' : 'person_not_deleted', message });
  }
});

app.post('/api/contacts/:contactId/notes', requireContext, noteLimiter, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().min(1).max(80).safeParse(req.params.contactId);
  const parsed = z.object({ body: z.string().trim().min(1).max(4000) }).strict().safeParse(req.body);
  if (!id.success || !parsed.success) return res.status(400).json({ code: 'invalid_note', message: 'Write a short note before saving.' });
  try { await (addPersonNote(actor.id, workspace.id, id.data, parsed.data.body)); res.status(201).json({ saved: true }); }
  catch (error) {
    if (error instanceof NoteStorageLimitError) return res.status(413).json({ code: error.code, message: error.message });
    res.status(404).json({ code: 'person_missing', message: error instanceof Error ? error.message : 'This person is no longer available.' });
  }
});

app.post('/api/contacts/:contactId/conversations', requireContext, noteLimiter, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().min(1).max(80).safeParse(req.params.contactId);
  const parsed = z.object({ body: z.string().trim().min(1).max(4000), eventId: z.string().min(1).max(80).nullable(), clientConversationId: z.string().uuid() }).strict().safeParse(req.body);
  if (!id.success || !parsed.success) return res.status(400).json({ code: 'invalid_conversation', message: 'Add a conversation note and choose an event, or choose no event.' });
  try {
    const saved = await addConversation(actor.id, workspace.id, id.data, parsed.data);
    const draftSettings = await getWorkspaceSetting(actor.id, workspace.id, 'draftAutomation') as { autoDraftAfterConversation?: boolean } | undefined;
    let autoDraft = null;
    if (draftSettings?.autoDraftAfterConversation && !saved.duplicate) {
      try { autoDraft = await createEmailDraft(actor.id, workspace.id, id.data); }
      catch { console.error(JSON.stringify({ event: 'automatic_draft_unavailable', workspaceId: workspace.id })); }
    }
    res.status(saved.duplicate ? 200 : 201).json({ saved: true, encounterId: saved.id, duplicate: saved.duplicate, autoDraft });
  } catch (error) {
    if (error instanceof NoteStorageLimitError) return res.status(413).json({ code: error.code, message: error.message });
    const message = error instanceof Error ? error.message : 'The conversation could not be saved.';
    res.status(message.startsWith('You do not have access') || message.startsWith('Choose an event') ? 403 : 409)
      .json({ code: 'conversation_not_saved', message });
  }
});

app.post('/api/contacts/:contactId/email-draft', aiSuggestionLimiter, requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().min(1).max(80).safeParse(req.params.contactId);
  if (!id.success) return res.status(404).json({ code: 'person_missing', message: 'This person is no longer available.' });
  try {
    let generated: { subject: string; body: string } | null = null;
    if (isAIProviderEnabled()) {
      try {
        const suggestion = await getEmailDraftSuggestion(actor.id, workspace.id, id.data);
        generated = await draftEmail(suggestion.aiContext);
      }
      catch { console.error(JSON.stringify({ event: 'ai_email_suggestion_unavailable', workspaceId: workspace.id })); }
    }
    res.status(201).json(await (createEmailDraft(actor.id, workspace.id, id.data, generated ?? undefined)));
  }
  catch (error) { res.status(409).json({ code: 'email_draft_not_created', message: error instanceof Error ? error.message : 'An email draft could not be created.' }); }
});

app.post('/api/contacts/:contactId/follow-up-suggestion', aiSuggestionLimiter, requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().min(1).max(80).safeParse(req.params.contactId);
  if (!id.success) return res.status(404).json({ code: 'person_missing', message: 'This person is no longer available.' });
  try {
    const context = await (getFollowUpSuggestionContext(actor.id, workspace.id, id.data));
  if (!isAIProviderEnabled()) return res.json({ available: false, message: 'AI suggestions are turned off. Choose a date and write the next step yourself.' });
    const suggestion = await suggestFollowUp(context);
    if (!suggestion) return res.json({ available: false, message: 'AI suggestions are not set up. Choose a date and write the next step yourself.' });
    res.json({ available: true, ...suggestion });
  } catch {
    console.error(JSON.stringify({ event: 'ai_follow_up_suggestion_unavailable', workspaceId: workspace.id }));
    res.status(503).json({ code: 'follow_up_suggestion_unavailable', message: 'A suggestion could not be prepared. Choose a date and write the next step yourself.' });
  }
});

app.post('/api/emails/:emailId/alternate', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().uuid().safeParse(req.params.emailId);
  if (!id.success) return res.status(404).json({ code: 'email_missing', message: 'This draft is no longer available.' });
  try {
    const draft = await (createAlternateEmailDraft(actor.id, workspace.id, id.data));
    if (!draft) return res.status(409).json({ code: 'email_draft_changed', message: 'This draft is no longer available to change.' });
    res.json(draft);
  } catch (error) {
    res.status(409).json({ code: 'email_alternate_not_created', message: error instanceof Error ? error.message : 'Another draft could not be prepared.' });
  }
});

app.put('/api/emails/:emailId', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().uuid().safeParse(req.params.emailId);
  const parsed = z.object({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(8000) }).strict().safeParse(req.body);
  if (!id.success || !parsed.success) return res.status(400).json({ code: 'invalid_email_draft', message: 'Add a subject and message before saving.' });
  if (!await (updateEmailDraft(actor.id, workspace.id, id.data, parsed.data.subject, parsed.data.body))) return res.status(409).json({ code: 'email_draft_changed', message: 'This draft is no longer available to edit.' });
  res.json({ saved: true });
});

app.post('/api/emails/:emailId/send', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().uuid().safeParse(req.params.emailId);
  const parsed = z.object({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(8000) }).strict().safeParse(req.body);
  if (!id.success || !parsed.success) return res.status(400).json({ code: 'invalid_email_draft', message: 'Add a subject and message before sending.' });
  if (!await (updateEmailDraft(actor.id, workspace.id, id.data, parsed.data.subject, parsed.data.body))) return res.status(409).json({ code: 'email_draft_changed', message: 'This draft is no longer available to send.' });
  const publicUrl = process.env.PUBLIC_BASE_URL ?? '';
  if (isProduction && publicUrl && !publicUrl.startsWith('https://')) return res.status(503).json({ code: 'https_required', message: 'The public email link must use HTTPS before sending.' });
  try {
    const result = await (approveEmailDraft(actor.id, workspace.id, id.data, Boolean(leadMailTransportReady() && await (workspaceMailSender(workspace.id))), publicUrl));
    res.json(result);
  } catch (error) {
    if (error instanceof EmailSendRateLimitError) {
      res.setHeader('Retry-After', String(error.retryAfterSeconds));
      return res.status(429).json({ code: 'email_send_rate_limit', message: error.message });
    }
    res.status(409).json({ code: 'email_not_approved', message: error instanceof Error ? error.message : 'This email could not be approved.' });
  }
});

app.get('/api/emails/:emailId', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().uuid().safeParse(req.params.emailId);
  if (!id.success) return res.status(404).json({ code: 'email_missing', message: 'This email is no longer available.' });
  const email = await (getEmailStatus(actor.id, workspace.id, id.data));
  if (!email) return res.status(404).json({ code: 'email_missing', message: 'This email is no longer available.' });
  res.setHeader('Cache-Control', 'no-store'); res.json(email);
});

app.post('/api/emails/:emailId/retry', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().uuid().safeParse(req.params.emailId);
  if (!id.success) return res.status(409).json({ code: 'email_not_retryable', message: 'This email is no longer waiting for a retry.' });
  try {
    if (!await (retryEmail(actor.id, workspace.id, id.data))) return res.status(409).json({ code: 'email_not_retryable', message: 'This email is no longer waiting for a retry.' });
  } catch (error) {
    if (error instanceof EmailSendRateLimitError) {
      res.setHeader('Retry-After', String(error.retryAfterSeconds));
      return res.status(429).json({ code: 'email_send_rate_limit', message: error.message });
    }
    throw error;
  }
  res.json({ status: 'queued', message: 'Retry queued for the mail server.' });
});

app.get('/unsubscribe/:token', (req, res) => {
  const token = z.string().regex(/^[A-Za-z0-9_-]{40,60}$/).safeParse(req.params.token);
  if (!token.success) return res.status(404).type('text').send('This unsubscribe link is not available.');
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Email preferences</title><body style="font:16px system-ui;max-width:34rem;margin:12vh auto;padding:1.5rem;color:#1b1a17"><h1>Stop follow-up emails?</h1><p>Confirm to stop Gather follow-up email for this address. This does not delete your saved event notes.</p><form method="post" action="/unsubscribe/${token.data}"><button style="padding:.8rem 1.2rem;background:#2447d6;color:#fff;border:0;border-radius:.5rem;font:inherit;cursor:pointer">Unsubscribe</button></form></body></html>`);
});

app.post(['/unsubscribe/:token', '/api/unsubscribe/:token'], async (req, res) => {
  const token = z.string().regex(/^[A-Za-z0-9_-]{40,60}$/).safeParse(req.params.token);
  if (!token.success || !await (unsubscribeByToken(token.data))) return res.status(404).type('text').send('This email preference link has expired.');
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><title>Preference saved</title><body style="font:16px system-ui;max-width:34rem;margin:12vh auto;padding:1.5rem;color:#1b1a17"><h1>You are unsubscribed.</h1><p>Gather will not send further follow-up email to this address.</p></body></html>');
});

app.patch('/api/contacts/:contactId/stage', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().min(1).max(80).safeParse(req.params.contactId);
  const parsed = z.object({ stage: z.enum(['new','contacted','replied','meeting','won','lost']), version: z.number().int().positive(), lostReason: z.string().trim().max(500).optional() }).strict().safeParse(req.body);
  if (!id.success || !parsed.success || (parsed.success && parsed.data.stage === 'lost' && !parsed.data.lostReason?.trim())) return res.status(400).json({ code: 'invalid_stage', message: 'Add a short reason before marking this person as lost.' });
  if (!await (updatePersonStage(actor.id, workspace.id, id.data, parsed.data.stage, parsed.data.version, parsed.data.lostReason))) return res.status(409).json({ code: 'record_changed', message: 'This person changed in another window. Refresh to see the latest.' });
  res.json({ updated: true, version: parsed.data.version + 1 });
});

app.patch('/api/contacts/:contactId', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().min(1).max(80).safeParse(req.params.contactId);
  const parsed = z.object({
    version: z.number().int().positive(), name: z.string().trim().min(1).max(160), title: z.string().trim().max(160),
    email: z.string().trim().max(254).refine((value) => !value || z.email().safeParse(value).success, 'Enter a valid email address.'),
    phone: z.string().trim().max(60), website: WebsiteSchema,
  }).strict().safeParse(req.body);
  if (!id.success || !parsed.success) return res.status(400).json({ code: 'invalid_person', message: 'Check the name and contact details, then try again.' });
  try {
    if (!await (updatePersonDetails(actor.id, workspace.id, id.data, parsed.data.version, parsed.data))) {
      return res.status(409).json({ code: 'record_changed', message: 'Someone else changed this. Reload to see the latest.' });
    }
    res.json({ updated: true, version: parsed.data.version + 1 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'These details could not be saved.';
    const status = message.startsWith('You do not have access') ? 403 : message.startsWith('Another person') ? 409 : 400;
    res.status(status).json({ code: 'person_not_updated', message });
  }
});

app.post('/api/contacts/:contactId/reply', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().min(1).max(80).safeParse(req.params.contactId);
  if (!id.success) return res.status(404).json({ code: 'person_missing', message: 'This person is no longer available.' });
  try {
    if (!await (markContactReplied(actor.id, workspace.id, id.data))) return res.status(404).json({ code: 'person_missing', message: 'This person is no longer available.' });
    const detail = await (getPersonDetail(actor.id, workspace.id, id.data));
    res.json({ updated: true, version: Number(detail?.person.version ?? 1) });
  } catch (error) {
    res.status(403).json({ code: 'reply_not_logged', message: error instanceof Error ? error.message : 'You cannot update this person.' });
  }
});

const audioMimeBySignature = (bytes: Buffer) => {
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) return 'audio/webm';
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4';
  return null;
};
app.post('/api/contacts/:contactId/voice', requireContext, voiceLimiter, express.raw({ type: ['audio/webm','audio/ogg','audio/mp4'], limit: '12mb' }), async (req, res, next) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const contactId = z.string().min(1).max(80).safeParse(req.params.contactId);
  const bytes = Buffer.isBuffer(req.body) ? req.body : null;
  const mime = req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
  const detected = bytes ? audioMimeBySignature(bytes) : null;
  const duration = z.coerce.number().int().min(1).max(120).safeParse(req.header('x-recording-seconds'));
  const encounterHeader = req.header('x-encounter-id');
  const encounterId = encounterHeader ? z.string().min(1).max(80).safeParse(encounterHeader) : null;
  if (!contactId.success || !bytes || bytes.length < 128 || !detected || detected !== mime || !duration.success || (encounterId && !encounterId.success)) {
    return res.status(400).json({ code: 'invalid_recording', message: 'This recording could not be saved. Record up to two minutes and try again.' });
  }
  const noteId = randomUUID();
  const extension = detected === 'audio/webm' ? '.webm' : detected === 'audio/ogg' ? '.ogg' : '.m4a';
  const directory = resolve(process.env.UPLOADS_PATH ?? 'uploads', workspace.id, 'voice');
  const path = resolve(directory, `${noteId}${extension}`);
  try {
    await mkdir(directory, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    await (addVoiceNote(actor.id, workspace.id, contactId.data, path, detected, duration.data, bytes.length, noteId, encounterId?.success ? encounterId.data : undefined));
    res.status(201).json({ id: noteId, playbackUrl: `/api/notes/${noteId}/audio`, durationSeconds: duration.data, transcriptStatus: 'manual' });
  } catch (error) {
    await unlink(path).catch(() => undefined);
    if (error instanceof VoiceStorageLimitError) return res.status(413).json({ code: error.code, message: error.message });
    next(error);
  }
});

app.get('/api/notes/:noteId/audio', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().uuid().safeParse(req.params.noteId);
  if (!id.success) return res.status(404).json({ code: 'audio_missing', message: 'This recording is no longer available.' });
  const note = await (getVoiceNote(actor.id, workspace.id, id.data));
  if (!note?.audio_path || !note.audio_mime) return res.status(404).json({ code: 'audio_missing', message: 'This recording is no longer available.' });
  res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); res.type(note.audio_mime).sendFile(note.audio_path);
});

app.put('/api/notes/:noteId/text', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().uuid().safeParse(req.params.noteId);
  const parsed = z.object({ text: z.string().trim().max(4000) }).strict().safeParse(req.body);
  if (!id.success || !parsed.success) return res.status(400).json({ code: 'invalid_note_text', message: 'Check the note and try again.' });
  try {
    if (!await (setVoiceNoteText(actor.id, workspace.id, id.data, parsed.data.text))) return res.status(404).json({ code: 'audio_missing', message: 'This recording is no longer available.' });
    res.json({ saved: true, transcriptStatus: 'manual' });
  } catch (error) {
    if (error instanceof VoiceStorageLimitError) return res.status(413).json({ code: error.code, message: error.message });
    throw error;
  }
});

app.post('/api/notes/:noteId/summary-suggestion', aiSuggestionLimiter, requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().uuid().safeParse(req.params.noteId);
  if (!id.success) return res.status(404).json({ code: 'audio_missing', message: 'This recording is no longer available.' });
  const note = await getVoiceNote(actor.id, workspace.id, id.data);
  if (!note) return res.status(404).json({ code: 'audio_missing', message: 'This recording is no longer available.' });
  if (!note.transcript.trim()) return res.status(409).json({ code: 'transcript_needed', message: 'Check and save the words first.' });
  try { return res.json({ summary: await summarizeCheckedTranscript(note.transcript) }); }
  catch (error) { return res.status(503).json({ code: 'summary_unavailable', message: error instanceof Error ? error.message : 'AI note help is unavailable.' }); }
});

app.put('/api/notes/:noteId/summary', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().uuid().safeParse(req.params.noteId);
  const parsed = z.object({ summary: z.string().trim().max(1000) }).strict().safeParse(req.body);
  if (!id.success || !parsed.success) return res.status(400).json({ code: 'invalid_summary', message: 'Check the summary and try again.' });
  if (!await setVoiceNoteSummary(actor.id, workspace.id, id.data, parsed.data.summary)) return res.status(404).json({ code: 'audio_missing', message: 'This recording is no longer available.' });
  res.json({ saved: true });
});

app.delete('/api/notes/:noteId', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const id = z.string().uuid().safeParse(req.params.noteId);
  if (!id.success) return res.status(404).json({ code: 'audio_missing', message: 'This recording is no longer available.' });
  const path = await (deleteVoiceNote(actor.id, workspace.id, id.data));
  if (path) await unlink(path).catch(() => undefined);
  if (!path) return res.status(404).json({ code: 'audio_missing', message: 'This recording is no longer available.' });
  res.json({ deleted: true });
});

const settingSchema = z.object({
  key: z.enum(['knowledge', 'aboutMe', 'email', 'capture', 'reminders', 'onboarding', 'draftAutomation']),
  value: z.unknown(),
});
const emailSettingsSchema = z.object({
  fromName: z.string().trim().min(1).max(100).refine((value) => !/[\r\n]/.test(value), 'Use one line for the sender name.'),
  fromAddress: z.string().trim().max(254).email(),
  testRecipient: z.string().trim().max(254).email().optional(),
}).strict();

const capturePreferenceSchema = z.object({ afterSaveEmail: z.enum(['ask', 'never']) }).strict();

app.get('/api/preferences/capture', requireContext, async (_req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ afterSaveEmail: await (getCaptureAfterSaveEmail(actor.id, workspace.id)) });
});

app.put('/api/preferences/capture', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const parsed = capturePreferenceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ code: 'invalid_capture_preference', message: 'Choose whether to ask before opening an email draft.' });
  await (setCaptureAfterSaveEmail(actor.id, workspace.id, parsed.data.afterSaveEmail));
  res.json({ afterSaveEmail: parsed.data.afterSaveEmail });
});

app.get('/api/settings', requireContext, async (_req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  if (workspace.kind === 'company' && workspace.role !== 'admin') return res.status(403).json({ code: 'settings_permission', message: 'Ask your company admin to change workspace settings.' });
  const keys = ['knowledge', 'aboutMe', 'email', 'capture', 'reminders', 'onboarding', 'draftAutomation'] as const;
  const settings = await Promise.all(keys.map(async (key) => [key, await getWorkspaceSetting(actor.id, workspace.id, key) ?? null] as const));
  res.json(Object.fromEntries(settings));
});

app.get('/api/reminders', requireContext, async (_req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  if (workspace.kind === 'company' && workspace.role !== 'admin') return res.status(403).json({ code: 'settings_permission', message: 'Ask your company admin to change reminder settings.' });
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    settings: await (getWorkspaceSetting(actor.id, workspace.id, 'reminders')) ?? { inAppEnabled: false, dailyDigestEnabled: false, digestTime: '09:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
    recentDigests: await (getDigestRuns(actor.id, workspace.id)),
    emailSending: Boolean(process.env.SMTP_HOST && await (workspaceMailSender(workspace.id))),
  });
});

app.put('/api/settings', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  if (workspace.kind === 'company' && workspace.role !== 'admin') return res.status(403).json({ code: 'settings_permission', message: 'Ask your company admin to change workspace settings.' });
  const parsed = settingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ code: 'invalid_setting', message: 'Check the information and try again.' });
  if (workspace.kind === 'company' && workspace.role !== 'admin' && ['knowledge', 'email'].includes(parsed.data.key)) {
    return res.status(403).json({ code: 'role_required', message: 'An admin manages these company settings.' });
  }
  if (workspace.kind === 'personal' && parsed.data.key === 'knowledge') {
    return res.status(400).json({ code: 'wrong_setting', message: 'Use About me for your personal details.' });
  }
  let value = parsed.data.value;
  if (parsed.data.key === 'email') {
    const emailSettings = emailSettingsSchema.safeParse(value);
    if (!emailSettings.success) return res.status(400).json({ code: 'invalid_email_settings', message: 'Add a sender name and a valid sender email address.' });
    value = emailSettings.data;
  }
  if (parsed.data.key === 'reminders') {
    const reminderSettings = z.object({
      inAppEnabled: z.boolean(), dailyDigestEnabled: z.boolean(), digestTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      timeZone: z.string().min(1).max(100),
    }).strict().safeParse(value);
    if (!reminderSettings.success) return res.status(400).json({ code: 'invalid_reminders', message: 'Check the reminder choices and try again.' });
    try { new Intl.DateTimeFormat('en-US', { timeZone: reminderSettings.data.timeZone }).format(new Date()); }
    catch { return res.status(400).json({ code: 'invalid_reminder_timezone', message: 'Choose a valid time zone and try again.' }); }
    value = reminderSettings.data;
  }
  if (parsed.data.key === 'draftAutomation') {
    const settings = z.object({ autoDraftAfterConversation: z.boolean() }).strict().safeParse(value);
    if (!settings.success) return res.status(400).json({ code: 'invalid_draft_automation', message: 'Choose whether to prepare drafts after a conversation.' });
    value = settings.data;
  }
  await (setWorkspaceSetting(actor.id, workspace.id, parsed.data.key, value));
  res.json({ saved: true, changedBy: actor.name });
});

app.post('/api/settings/delete-my-data', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const parsed = z.object({ confirmation: z.literal('DELETE') }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ code: 'confirmation_required', message: 'Type DELETE to confirm removing this private space’s data.' });
  try {
    const deleted = await (clearPersonalWorkspaceData(actor.id, workspace.id));
    const cleanup = await Promise.allSettled(deleted.mediaPaths.map((path) => unlink(path)));
    const mediaCleanupPending = cleanup.filter((result) => result.status === 'rejected').length;
    if (mediaCleanupPending) console.error(`Private data deletion left ${mediaCleanupPending} media file(s) for cleanup.`);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ deleted: true, counts: deleted.counts, mediaCleanupPending });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Your private data could not be deleted.';
    const denied = message.startsWith('Only the owner');
    res.status(denied ? 403 : 409).json({ code: denied ? 'delete_permission' : 'data_not_deleted', message });
  }
});

if (!isProduction) {
  app.post('/api/settings/clear-sample-data', requireContext, async (req, res) => {
    const { actor, workspace } = res.locals.context as RequestContext;
    const parsed = z.object({ confirmation: z.literal('CLEAR') }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ code: 'confirmation_required', message: 'Type CLEAR to remove sample records from this workspace.' });
    try {
      const cleared = await (clearSampleWorkspaceData(actor.id, workspace.id));
      const cleanup = await Promise.allSettled(cleared.mediaPaths.map((path) => unlink(path)));
      const mediaCleanupPending = cleanup.filter((result) => result.status === 'rejected').length;
      if (mediaCleanupPending) console.error(`Sample data clearing left ${mediaCleanupPending} media file(s) for cleanup.`);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ cleared: true, counts: cleared.counts, mediaCleanupPending });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sample data could not be cleared.';
      const denied = message.startsWith('Only a sample') || message.startsWith('Only the owner');
      res.status(denied ? 403 : 409).json({ code: denied ? 'clear_permission' : 'sample_data_not_cleared', message });
    }
  });
}

const scanLimiter = rateLimit({
  windowMs: 60_000,
  limit: 45,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { code: 'scan_rate_limit', message: 'Too many photos at once. Wait a moment, then try again.' },
});
const imageMimeBySignature = (bytes: Buffer) => {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
};
function publicScan(row: ScanRow) {
  let extracted: unknown = null;
  let uncertain: unknown = [];
  try { extracted = row.extracted_json ? JSON.parse(row.extracted_json) : null; } catch { extracted = null; }
  try { uncertain = JSON.parse(row.uncertain_json); } catch { uncertain = []; }
  return {
    id: row.id,
    clientScanId: row.client_scan_id,
    source: row.source,
    mimeType: row.image_mime,
    status: row.status,
    extracted,
    uncertain,
    error: row.error_message,
    contactId: row.contact_id,
    materialCompanyId: row.material_company_id ?? null,
    eventTimeZone: row.event_time_zone ?? null,
    queuedAt: row.queued_at,
    readyAt: row.ready_at,
    savedAt: row.saved_at,
  };
}

app.get('/api/scans', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const limit = Number(req.query.limit ?? 40);
  res.setHeader('Cache-Control', 'no-store');
  const scans = await listScans(actor.id, workspace.id, Number.isFinite(limit) ? limit : 40);
  res.json({ scans: scans.map(publicScan) });
});

app.post('/api/scans/qr', scanLimiter, requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const parsed = z.object({ clientScanId: z.string().uuid(), fields: CardReadOutputSchema, eventId: z.string().min(1).max(80).nullable().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ code: 'invalid_qr', message: 'This QR code did not contain contact details we could use.' });
  try {
    const event = await (getCurrentEvent(actor.id, workspace.id));
    const { uncertain: _uncertain, ...contactFields } = parsed.data.fields;
    const contentHash = `qr:${createHash('sha256').update(JSON.stringify(contactFields)).digest('hex')}`;
    const result = await (createQrScan({ actorId: actor.id, workspaceId: workspace.id, eventId: parsed.data.eventId === undefined ? event?.id ?? null : parsed.data.eventId, clientScanId: parsed.data.clientScanId, result: parsed.data.fields, uncertain: parsed.data.fields.uncertain, contentHash }));
    res.status(result.duplicate ? 200 : 201).json({ scan: publicScan(result.scan), duplicate: result.duplicate, duplicateQr: result.duplicate && result.scan.client_scan_id !== parsed.data.clientScanId });
  } catch (error) {
    if (error instanceof QrScanStorageLimitError) return res.status(413).json({ code: error.code, message: error.message });
    res.status(403).json({ code: 'qr_not_added', message: error instanceof Error ? error.message : 'This QR code could not be added.' });
  }
});

app.post('/api/scans', scanLimiter, requireContext, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '12mb' }), async (req, res, next) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const scanIdHeader = req.header('x-client-scan-id');
  const clientOrderParsed = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).safeParse(req.header('x-client-order') ?? Date.now() * 10);
  const sourceParsed = z.enum(['camera', 'gallery']).safeParse(req.header('x-scan-source') ?? 'gallery');
  const clientScanParsed = z.string().uuid().safeParse(scanIdHeader);
  const bytes = Buffer.isBuffer(req.body) ? req.body : null;
  const contentType = req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
  const eventHeader = req.header('x-event-id');
  if (eventHeader !== undefined && eventHeader !== 'none' && !z.string().min(1).max(80).safeParse(eventHeader).success) return res.status(400).json({ code: 'invalid_event', message: 'Choose an event you can access.' });
  if (!sourceParsed.success || !clientScanParsed.success || !clientOrderParsed.success) return res.status(400).json({ code: 'invalid_scan', message: 'This photo could not be added. Choose it again.' });
  if (!bytes || bytes.length < 100) return res.status(400).json({ code: 'empty_photo', message: 'Choose a clear photo of the card.' });
  const detectedMime = imageMimeBySignature(bytes);
  if (!detectedMime || detectedMime !== contentType) return res.status(415).json({ code: 'invalid_photo', message: 'Use a JPEG, PNG or WebP photo.' });
  const activeEvent = eventHeader === undefined ? await getCurrentEvent(actor.id, workspace.id) : null;
  const eventId = eventHeader === undefined ? activeEvent?.id ?? null : eventHeader === 'none' ? null : eventHeader;
  if (eventId && !activeEvent && !(await listAccessibleEvents(actor.id, workspace.id)).some((event) => event.id === eventId)) {
    return res.status(403).json({ code: 'event_not_available', message: 'This event is no longer available. Choose another event.' });
  }
  const existing = await (findScanByClientId(actor.id, workspace.id, clientScanParsed.data));
  if (existing) return res.status(200).json({ scan: publicScan(existing), duplicate: true });
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const existingImage = await findScanByContentHash(actor.id, workspace.id, contentHash);
  if (existingImage) return res.status(200).json({ scan: publicScan(existingImage), duplicate: true, duplicateImage: true });
  let visualHash: string;
  try { visualHash = await imageDifferenceHash(bytes); }
  catch { return res.status(415).json({ code: 'invalid_photo', message: 'This photo could not be read. Choose a clear JPEG, PNG or WebP image.' }); }
  if (req.header('x-allow-similar-scan') !== 'true') {
    const likely = await findLikelySavedScan(actor.id, workspace.id, visualHash);
    if (likely) return res.status(200).json({ scan: publicScan(likely), possibleDuplicate: true });
  }
  const scanId = randomUUID();
  const extension = detectedMime === 'image/jpeg' ? '.jpg' : detectedMime === 'image/png' ? '.png' : '.webp';
  const uploadRoot = resolve(process.env.UPLOADS_PATH ?? 'uploads');
  const directory = resolve(uploadRoot, workspace.id, 'scans');
  const imagePath = resolve(directory, `${scanId}${extension}`);
  try {
    await mkdir(directory, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(imagePath, bytes, { flag: 'wx', mode: 0o600 });
    try {
      const result = await (createScan({
        actorId: actor.id, workspaceId: workspace.id, eventId,
        clientScanId: clientScanParsed.data, clientOrder: clientOrderParsed.data, scanId, source: sourceParsed.data, imagePath, imageMime: detectedMime, imageBytes: bytes.length, contentHash, visualHash,
      }));
      if (result.duplicate) await unlink(imagePath).catch(() => undefined);
      return res.status(result.duplicate ? 200 : 201).json({ scan: publicScan(result.scan), duplicate: result.duplicate, duplicateImage: result.duplicate && result.scan.client_scan_id !== clientScanParsed.data });
    } catch (error) {
      await unlink(imagePath).catch(() => undefined);
      const raced = await (findScanByClientId(actor.id, workspace.id, clientScanParsed.data));
      if (raced) return res.status(200).json({ scan: publicScan(raced), duplicate: true });
      if (error instanceof Error && error.message === 'scan_storage_limit') return res.status(413).json({ code: 'scan_storage_limit', message: 'This workspace or Gather server has reached its photo storage limit. Remove old scans or ask your admin for help.' });
      throw error;
    }
  } catch (error) { next(error); }
});

app.get('/api/scans/:scanId/image', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const parsed = z.string().uuid().safeParse(req.params.scanId);
  if (!parsed.success) return res.status(404).json({ code: 'photo_missing', message: 'This photo is no longer available.' });
  const scan = await (getScan(actor.id, workspace.id, parsed.data));
  if (!scan?.image_path || !scan.image_mime) return res.status(404).json({ code: 'photo_missing', message: 'This photo is no longer available.' });
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.type(scan.image_mime).sendFile(scan.image_path);
});

app.get('/api/scans/:scanId', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const parsed = z.string().uuid().safeParse(req.params.scanId);
  if (!parsed.success) return res.status(404).json({ code: 'scan_missing', message: 'This photo is no longer available.' });
  const scan = await (getScan(actor.id, workspace.id, parsed.data));
  if (!scan) return res.status(404).json({ code: 'scan_missing', message: 'This photo is no longer available.' });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ scan: publicScan(scan), imageUrl: scan.image_path ? `/api/scans/${scan.id}/image` : null });
});

app.post('/api/scans/:scanId/qr', scanLimiter, requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const scanId = z.string().uuid().safeParse(req.params.scanId);
  const fields = CardReadOutputSchema.safeParse(req.body);
  if (!scanId.success || !fields.success) return res.status(400).json({ code: 'invalid_qr', message: 'This QR code did not contain contact details we could use.' });
  try {
    const applied = await (applyQrToScan(actor.id, workspace.id, scanId.data, fields.data, fields.data.uncertain));
    if (!applied) {
      const scan = await getScan(actor.id, workspace.id, scanId.data);
      if (scan?.status === 'saved') return res.json({ applied: false, alreadySaved: true });
      return res.status(404).json({ code: 'scan_not_available', message: 'This photo is already saved or was removed.' });
    }
    res.json({ applied: true });
  } catch (error) { res.status(403).json({ code: 'qr_not_added', message: error instanceof Error ? error.message : 'This QR code could not be added.' }); }
});

app.post('/api/scans/:scanId/ocr', scanLimiter, requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const scanId = z.string().uuid().safeParse(req.params.scanId);
  const fields = CardReadOutputSchema.safeParse(req.body);
  if (!scanId.success || !fields.success) return res.status(400).json({ code: 'invalid_ocr', message: 'Those card details could not be added. Check them or type the details yourself.' });
  try {
    const applied = await (applyQrToScan(actor.id, workspace.id, scanId.data, fields.data, fields.data.uncertain, req.header('x-read-source') === 'ai', true));
    if (!applied) {
      const scan = await getScan(actor.id, workspace.id, scanId.data);
      if (scan?.status === 'saved') return res.json({ applied: false, alreadySaved: true });
      return res.status(404).json({ code: 'scan_not_available', message: 'This photo is already saved or was removed.' });
    }
    res.json({ applied: true });
  } catch (error) { res.status(403).json({ code: 'ocr_not_added', message: error instanceof Error ? error.message : 'Those details could not be added.' }); }
});

app.post('/api/scans/:scanId/ai-read', aiSuggestionLimiter, requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const scanId = z.string().uuid().safeParse(req.params.scanId);
  if (!scanId.success) return res.status(404).json({ code: 'scan_missing', message: 'This photo is no longer available.' });
  if (!isCardAIEnabled()) return res.status(409).json({ code: 'ai_unavailable', message: 'AI reading is not set up. Keep using the on-device reader or type the details.' });
  try {
    const scan = await getScan(actor.id, workspace.id, scanId.data);
    if (!scan?.image_path || !scan.image_mime || ['saved','discarded'].includes(scan.status)) return res.status(404).json({ code: 'scan_not_available', message: 'This photo is already saved or was removed.' });
    const result = await readCard(scan.image_path, scan.image_mime);
    if (!result.available) return res.status(503).json({ code: 'ai_read_failed', message: 'AI could not read this photo. Check the on-device result or type the details.' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ fields: result.data, source: 'ai_suggestion', needsReview: true });
  } catch {
    res.status(503).json({ code: 'ai_read_failed', message: 'AI could not read this photo. Check the on-device result or type the details.' });
  }
});

app.post('/api/scans/:scanId/ocr-failure', scanLimiter, requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const scanId = z.string().uuid().safeParse(req.params.scanId);
  if (!scanId.success) return res.status(404).json({ code: 'scan_missing', message: 'This photo is no longer available.' });
  try {
    const applied = await (markScanNeedsInputByActor(actor.id, workspace.id, scanId.data, 'We couldn’t read this photo on this try. Type the details to continue.'));
    if (!applied) {
      const scan = await getScan(actor.id, workspace.id, scanId.data);
      if (scan?.status === 'ready' || scan?.status === 'saved') return res.json({ failed: false, alreadyProcessed: true });
      return res.status(404).json({ code: 'scan_not_available', message: 'This photo is already saved or was removed.' });
    }
    res.json({ failed: true });
  } catch (error) { res.status(403).json({ code: 'ocr_failure_not_saved', message: error instanceof Error ? error.message : 'This photo could not be updated.' }); }
});

app.post('/api/scans/:scanId/save', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const scanId = z.string().uuid().safeParse(req.params.scanId);
  const parsed = SaveLeadSchema.safeParse(req.body);
  if (!scanId.success || !parsed.success) return res.status(400).json({ code: 'invalid_lead', message: 'Check the details and try again.' });
  if (parsed.data.email && !z.email().safeParse(parsed.data.email).success) return res.status(400).json({ code: 'invalid_email', message: 'Check the email address and try again.' });
  try {
    const result = await (saveScannedLead(actor.id, workspace.id, { scanId: scanId.data, ...parsed.data }));
    await (updateOnboardingStep(actor.id, workspace.id, 'capture', true));
    res.json(result);
  } catch (error) { res.status(409).json({ code: 'lead_not_saved', message: error instanceof Error ? error.message : 'The lead could not be saved. Check the details and try again.' }); }
});

app.post('/api/scans/:scanId/material', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const scanId = z.string().uuid().safeParse(req.params.scanId);
  const parsed = z.object({ company: z.string().trim().min(1).max(160), website: WebsiteSchema.default(''), items: z.array(z.string().trim().min(1).max(120)).max(12).default([]), companyChoice: z.string().min(1).max(80).optional() }).strict().safeParse(req.body);
  if (!scanId.success || !parsed.success) return res.status(400).json({ code: 'invalid_material', message: 'Add the brochure’s company name and check the website.' });
  try {
    res.json(await (saveScannedMaterial(actor.id, workspace.id, { scanId: scanId.data, ...parsed.data })));
  } catch (error) { res.status(409).json({ code: 'material_not_saved', message: error instanceof Error ? error.message : 'The company material could not be saved.' }); }
});

app.delete('/api/scans/:scanId/material', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const scanId = z.string().uuid().safeParse(req.params.scanId);
  if (!scanId.success) return res.status(404).json({ code: 'material_missing', message: 'This company material is no longer available.' });
  try {
    if (!await (removeScannedMaterial(actor.id, workspace.id, scanId.data))) return res.status(404).json({ code: 'material_missing', message: 'This company material is no longer available.' });
    res.json({ removed: true });
  } catch (error) { res.status(403).json({ code: 'material_not_removed', message: error instanceof Error ? error.message : 'This company material could not be removed.' }); }
});

app.post('/api/scans/:scanId/discard', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const parsed = z.string().uuid().safeParse(req.params.scanId);
  if (!parsed.success) return res.status(404).json({ code: 'scan_not_discarded', message: 'This photo was not found.' });
  const scan = await (getScan(actor.id, workspace.id, parsed.data));
  const discarded = await (discardScan(actor.id, workspace.id, parsed.data));
  if (!discarded) return res.status(409).json({ code: 'scan_not_discarded', message: 'This photo is already saved or was removed.' });
  if (scan?.image_path) void unlink(scan.image_path).catch(() => undefined);
  res.json({ discarded: true });
});

app.get('/api/problems', requireContext, async (_req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  res.json({ jobs: await (listJobProblems(actor.id, workspace.id)) });
});

app.post('/api/jobs/:jobId/retry', requireContext, async (req, res) => {
  const { actor, workspace } = res.locals.context as RequestContext;
  const parsed = z.string().uuid().safeParse(req.params.jobId);
  if (!parsed.success) return res.status(404).json({ code: 'job_not_retryable', message: 'This job was not found.' });
  const retried = await (retryJob(actor.id, workspace.id, parsed.data));
  if (!retried) return res.status(404).json({ code: 'job_not_retryable', message: 'This job is no longer waiting for a retry.' });
  res.json({ retried: true });
});

const clientBuild = resolve(process.cwd(), 'dist');
if (existsSync(clientBuild)) {
  app.use(express.static(clientBuild, { index: false, fallthrough: true, maxAge: isProduction ? '1h' : 0 }));
  app.get('*splat', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(resolve(clientBuild, 'index.html'));
  });
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) return res.status(400).json({ code: 'invalid_input', message: 'Check the highlighted information and try again.', fields: error.issues.map((item) => ({ path: item.path.join('.'), message: item.message })) });
  const message = error instanceof Error ? error.message : 'Unexpected error';
  if (!isProduction) console.error(error);
  else console.error(JSON.stringify({ event: 'request_error', message, at: new Date().toISOString() }));
  res.status(500).json({ code: 'server_error', message: 'That did not work. Try again. If it keeps happening, contact your admin.' });
});

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '127.0.0.1';
const server = app.listen(port, host, () => console.info(`Gather API listening on http://${host}:${port}`));
let closeServerPromise: Promise<void> | undefined;
export function closeHttpServer() {
  closeServerPromise ??= new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return closeServerPromise;
}
function shutdown() {
  void closeHttpServer().then(() => process.exit(0), () => process.exit(1));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
