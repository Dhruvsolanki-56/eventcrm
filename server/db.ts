import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnalyticsData } from '../shared/analytics.js';
import { AsyncSqliteDatabase } from './sqlite-async.js';
import { composeTemplateEmail } from './email-template.js';
import { PostgresDatabase } from './postgres-compat.js';
import { isGroqEmailEnabled } from './groq-email.js';
import { closePostgres, isPostgresConfigured, migratePostgres } from './postgres.js';

// A permission refusal. The message is written for the person who sees it; the HTTP layer answers these with 403.
export class AccessDeniedError extends Error {
  constructor(message: string) { super(message); this.name = 'AccessDeniedError'; }
}

export type WorkspaceRole = 'admin' | 'manager' | 'representative' | 'attendee';
export type WorkspaceKind = 'company' | 'personal';
export type WorkspaceInfo = { id: string; name: string; kind: WorkspaceKind; role: WorkspaceRole };
export type ActorInfo = {
  id: string;
  name: string;
  email: string;
  workspaces: WorkspaceInfo[];
};

const dbPath = resolve(process.env.DATABASE_PATH ?? 'data/gather.sqlite');
const postgresMode = isPostgresConfigured();
if (!postgresMode) mkdirSync(dirname(dbPath), { recursive: true });
const sqlite = postgresMode ? null : new Database(dbPath);
const db: any = postgresMode ? new PostgresDatabase() : new AsyncSqliteDatabase(sqlite!);
if (!postgresMode) {
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
}

export async function migrate() {
  if (postgresMode) return migratePostgres();
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
  const migrationDir = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');
  for (const name of readdirSync(migrationDir).filter((file) => file.endsWith('.sql')).sort()) {
    const applied = await db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(name);
    if (applied) continue;
    const sql = readFileSync(resolve(migrationDir, name), 'utf8');
    await db.transaction(async () => {
      await db.exec(sql);
      await db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run(name);
    })();
  }
  const noteColumns = db.pragma('table_info(notes)') as Array<{ name: string }>;
  if (noteColumns.some((column) => column.name === 'audio_bytes')) {
    const uploadRoot = resolve(process.env.UPLOADS_PATH ?? 'uploads');
    const legacyNotes = await (db.prepare(`SELECT id,audio_path FROM notes WHERE kind='audio' AND audio_bytes=0 AND audio_path IS NOT NULL`).all()) as Array<{ id: string; audio_path: string }>;
    const updateSize = db.prepare('UPDATE notes SET audio_bytes=? WHERE id=? AND audio_bytes=0');
    await (db.transaction(async () => {
      for (const note of legacyNotes) {
        try {
          const absolute = resolve(note.audio_path);
          if (!absolute.startsWith(`${uploadRoot}${sep}`)) continue;
          const details = lstatSync(note.audio_path);
          if (details.isFile() && !details.isSymbolicLink()) await (updateSize.run(details.size, note.id));
        } catch { /* Missing legacy media is not counted as stored disk use. */ }
      }
    })());
  }
  const scanColumns = db.pragma('table_info(scans)') as Array<{ name: string }>;
  if (scanColumns.some((column) => column.name === 'image_bytes')) {
    const uploadRoot = resolve(process.env.UPLOADS_PATH ?? 'uploads');
    const legacyScans = await (db.prepare(`SELECT id,image_path FROM scans WHERE image_bytes=0 AND image_path IS NOT NULL`).all()) as Array<{ id: string; image_path: string }>;
    const updateSize = db.prepare('UPDATE scans SET image_bytes=? WHERE id=? AND image_bytes=0');
    await (db.transaction(async () => {
      for (const scan of legacyScans) {
        try {
          const absolute = resolve(scan.image_path);
          if (!absolute.startsWith(`${uploadRoot}${sep}`)) continue;
          const details = lstatSync(scan.image_path);
          if (details.isFile() && !details.isSymbolicLink()) await (updateSize.run(details.size, scan.id));
        } catch { /* Missing legacy media is not counted as stored disk use. */ }
      }
    })());
  }
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export async function findUserByEmail(email: string) {
  return await (db.prepare('SELECT id,name,email,password_hash,disabled_at,email_verified_at FROM users WHERE email = ? COLLATE NOCASE').get(email)) as
    | { id: string; name: string; email: string; password_hash: string; disabled_at: string | null; email_verified_at: string | null }
    | undefined;
}

export async function createUser(input: { name: string; email: string; passwordHash: string; kind: WorkspaceKind; workspaceName: string; emailVerified?: boolean }) {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const role: WorkspaceRole = input.kind === 'company' ? 'admin' : 'attendee';
  await (db.transaction(async () => {
    await (db.prepare(`INSERT INTO users(id,name,email,password_hash,email_verified_at) VALUES (?,?,?,?,CASE WHEN ?=1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END)`)
      .run(userId, input.name, input.email, input.passwordHash, input.emailVerified === false ? 0 : 1));
    await (db.prepare('INSERT INTO workspaces(id,kind,name,owner_user_id) VALUES (?,?,?,?)').run(workspaceId, input.kind, input.workspaceName, userId));
    await (db.prepare('INSERT INTO memberships(workspace_id,user_id,role) VALUES (?,?,?)').run(workspaceId, userId, role));
  })());
  return { userId, workspaceId };
}

export async function createSession(userId: string, rawToken: string, csrfToken: string, expiresAt: string) {
  const id = randomUUID();
  await (db.prepare('INSERT INTO sessions(id,token_hash,user_id,csrf_hash,expires_at) VALUES (?,?,?,?,?)')
    .run(id, hash(rawToken), userId, hash(csrfToken), expiresAt));
  return id;
}

export async function findActorBySession(rawToken: string): Promise<ActorInfo | undefined> {
  const row = await (db.prepare(`
    SELECT u.id,u.name,u.email,s.id AS session_id
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND u.disabled_at IS NULL
  `).get(hash(rawToken))) as { id: string; name: string; email: string; session_id: string } | undefined;
  if (!row) return undefined;
  const workspaces = await (db.prepare(`
    SELECT w.id,w.name,w.kind,m.role
    FROM memberships m JOIN workspaces w ON w.id=m.workspace_id
    WHERE m.user_id=? AND m.status='active'
    ORDER BY CASE WHEN m.role='admin' THEN 0 ELSE 1 END, w.created_at
  `).all(row.id)) as WorkspaceInfo[];
  return { id: row.id, name: row.name, email: row.email, workspaces };
}

export async function validateCsrf(rawToken: string, csrfToken: string) {
  const row = await (db.prepare(`SELECT csrf_hash FROM sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .get(hash(rawToken))) as { csrf_hash: string } | undefined;
  return !!row && row.csrf_hash === hash(csrfToken);
}

export async function revokeSession(rawToken: string) {
  await (db.prepare(`UPDATE sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash=? AND revoked_at IS NULL`).run(hash(rawToken)));
}

export async function queuePasswordReset(userId: string, rawToken: string, expiresAt: string) {
  const workspace = await (db.prepare(`SELECT workspace_id FROM memberships WHERE user_id=? AND status='active' ORDER BY created_at LIMIT 1`).get(userId)) as { workspace_id: string } | undefined;
  if (!workspace) return false;
  return await (db.transaction(async () => {
    const recentlyRequested = await (db.prepare(`SELECT 1 FROM account_tokens WHERE user_id=? AND kind='password_reset'
      AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes') LIMIT 1`).get(userId));
    if (recentlyRequested) return false;
    await (db.prepare(`UPDATE account_tokens SET used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=? AND kind='password_reset' AND used_at IS NULL`).run(userId));
    await (db.prepare(`INSERT INTO account_tokens(id,user_id,kind,token_hash,expires_at) VALUES (?,?,'password_reset',?,?)`)
      .run(randomUUID(), userId, hash(rawToken), expiresAt));
    await (db.prepare(`INSERT INTO jobs(id,workspace_id,type,payload_json,run_at) VALUES (?,?, 'password_reset_email', ?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .run(randomUUID(), workspace.workspace_id, JSON.stringify({ userId, token: rawToken })));
    return true;
  })());
}

export async function getPasswordResetEmailForWorker(userId: string, rawToken: string) {
  return await (db.prepare(`SELECT u.name,u.email FROM account_tokens t JOIN users u ON u.id=t.user_id
    WHERE t.user_id=? AND t.kind='password_reset' AND t.token_hash=? AND t.used_at IS NULL
      AND t.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND u.disabled_at IS NULL`)
    .get(userId, hash(rawToken))) as { name: string; email: string } | undefined;
}

export async function queueEmailVerification(userId: string, rawToken: string, expiresAt: string) {
  const workspace = await (db.prepare(`SELECT workspace_id FROM memberships WHERE user_id=? AND status='active' ORDER BY created_at LIMIT 1`).get(userId)) as { workspace_id: string } | undefined;
  if (!workspace) return false;
  return await (db.transaction(async () => {
    const recentlyRequested = await (db.prepare(`SELECT 1 FROM account_tokens WHERE user_id=? AND kind='email_verification'
      AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes') LIMIT 1`).get(userId));
    if (recentlyRequested) return false;
    await (db.prepare(`UPDATE account_tokens SET used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=? AND kind='email_verification' AND used_at IS NULL`).run(userId));
    await (db.prepare(`INSERT INTO account_tokens(id,user_id,kind,token_hash,expires_at) VALUES (?,?,'email_verification',?,?)`)
      .run(randomUUID(), userId, hash(rawToken), expiresAt));
    await (db.prepare(`INSERT INTO jobs(id,workspace_id,type,payload_json,run_at) VALUES (?,?, 'email_verification', ?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .run(randomUUID(), workspace.workspace_id, JSON.stringify({ userId, token: rawToken })));
    return true;
  })());
}

export async function getEmailVerificationForWorker(userId: string, rawToken: string) {
  return await (db.prepare(`SELECT u.name,u.email FROM account_tokens t JOIN users u ON u.id=t.user_id
    WHERE t.user_id=? AND t.kind='email_verification' AND t.token_hash=? AND t.used_at IS NULL
      AND t.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND u.disabled_at IS NULL AND u.email_verified_at IS NULL`)
    .get(userId, hash(rawToken))) as { name: string; email: string } | undefined;
}

export async function findEmailVerificationUser(rawToken: string) {
  return await (db.prepare(`SELECT u.id FROM account_tokens t JOIN users u ON u.id=t.user_id
    WHERE t.kind='email_verification' AND t.token_hash=? AND t.used_at IS NULL
      AND t.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND u.disabled_at IS NULL AND u.email_verified_at IS NULL`)
    .get(hash(rawToken))) as { id: string } | undefined;
}

export async function consumeEmailVerification(rawToken: string) {
  return await (db.transaction(async () => {
    const tokenHash = hash(rawToken);
    const row = await (db.prepare(`SELECT t.user_id FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE t.kind='email_verification' AND t.token_hash=? AND t.used_at IS NULL
      AND t.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND u.disabled_at IS NULL AND u.email_verified_at IS NULL`).get(tokenHash)) as { user_id: string } | undefined;
    if (!row) return undefined;
    const changed = await (db.prepare(`UPDATE users SET email_verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND email_verified_at IS NULL AND disabled_at IS NULL`).run(row.user_id));
    if (!changed.changes) throw new Error('Email verification changed while being confirmed.');
    const consumed = await (db.prepare(`UPDATE account_tokens SET used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE kind='email_verification' AND token_hash=? AND used_at IS NULL`).run(tokenHash));
    if (!consumed.changes) throw new Error('Email verification token changed during confirmation.');
    await (db.prepare(`UPDATE account_tokens SET used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=? AND used_at IS NULL`).run(row.user_id));
    return row.user_id;
  })());
}

export async function findPasswordResetUser(rawToken: string) {
  return await (db.prepare(`SELECT u.id FROM account_tokens t JOIN users u ON u.id=t.user_id
    WHERE t.kind='password_reset' AND t.token_hash=? AND t.used_at IS NULL
      AND t.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND u.disabled_at IS NULL`)
    .get(hash(rawToken))) as { id: string } | undefined;
}

export async function consumePasswordReset(rawToken: string, passwordHash: string) {
  return await (db.transaction(async () => {
    const tokenHash = hash(rawToken);
    const row = await (db.prepare(`SELECT t.user_id FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE t.kind='password_reset' AND t.token_hash=? AND t.used_at IS NULL
      AND t.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND u.disabled_at IS NULL`).get(tokenHash)) as { user_id: string } | undefined;
    if (!row) return false;
    const changedUser = await (db.prepare(`UPDATE users SET password_hash=? WHERE id=? AND disabled_at IS NULL`).run(passwordHash, row.user_id));
    if (!changedUser.changes) return false;
    const consumed = await (db.prepare(`UPDATE account_tokens SET used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE kind='password_reset' AND token_hash=? AND used_at IS NULL AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(tokenHash));
    if (!consumed.changes) throw new Error('Password reset token changed during use.');
    await (db.prepare(`UPDATE sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=? AND revoked_at IS NULL`).run(row.user_id));
    await (db.prepare(`UPDATE account_tokens SET used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=? AND used_at IS NULL`).run(row.user_id));
    return true;
  })());
}

export async function workspaceForActor(actorId: string, workspaceId: string): Promise<WorkspaceInfo | undefined> {
  return await (db.prepare(`
    SELECT w.id,w.name,w.kind,m.role FROM memberships m
    JOIN workspaces w ON w.id=m.workspace_id
    WHERE m.user_id=? AND m.workspace_id=? AND m.status='active'
  `).get(actorId, workspaceId)) as WorkspaceInfo | undefined;
}

export async function hasSampleWorkspaceData(actorId: string, workspaceId: string) {
  const sampleUser = await (db.prepare(`SELECT 1 FROM users WHERE id=? AND email LIKE '%@gather.test' AND disabled_at IS NULL`).get(actorId));
  if (!sampleUser || !workspaceId.startsWith('demo-') || !await (workspaceForActor(actorId, workspaceId))) return false;
  return Boolean(await (db.prepare(`SELECT 1 FROM companies WHERE workspace_id=?
    UNION ALL SELECT 1 FROM contacts WHERE workspace_id=?
    UNION ALL SELECT 1 FROM scans WHERE workspace_id=?
    UNION ALL SELECT 1 FROM events WHERE workspace_id=?
    UNION ALL SELECT 1 FROM products WHERE workspace_id=? LIMIT 1`).get(workspaceId, workspaceId, workspaceId, workspaceId, workspaceId)));
}

async function requireCompanyAdmin(actorId: string, workspaceId: string) {
  const workspace = await (workspaceForActor(actorId, workspaceId));
  if (!workspace || workspace.kind !== 'company' || workspace.role !== 'admin') throw new AccessDeniedError('Only a company admin can manage team access.');
  return workspace;
}

export async function listTeamSettings(actorId: string, workspaceId: string) {
  await (requireCompanyAdmin(actorId, workspaceId));
  const events = await (db.prepare(`SELECT id,name,starts_at,ends_at,time_zone,spend_minor,is_active FROM events WHERE workspace_id=? ORDER BY starts_at DESC,name`).all(workspaceId)) as Array<Record<string, unknown>>;
  const members = (await (db.prepare(`SELECT u.id AS user_id,u.name,u.email,m.role,m.created_at,GROUP_CONCAT(DISTINCT e.name) AS event_names,GROUP_CONCAT(DISTINCT ea.event_id) AS event_ids_csv
    FROM memberships m JOIN users u ON u.id=m.user_id
    LEFT JOIN event_access ea ON ea.workspace_id=m.workspace_id AND ea.user_id=m.user_id
    LEFT JOIN events e ON e.workspace_id=ea.workspace_id AND e.id=ea.event_id
    WHERE m.workspace_id=? AND m.status='active' GROUP BY m.workspace_id,u.id ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,u.name`).all(workspaceId)) as Array<Record<string, unknown>>).map((member) => ({
      ...member,
      event_ids: typeof member.event_ids_csv === 'string' && member.event_ids_csv ? member.event_ids_csv.split(',') : [],
      event_ids_csv: undefined,
    }));
  const invites = (await (db.prepare(`SELECT id,role,event_ids_json,expires_at,created_at FROM invites WHERE workspace_id=? AND accepted_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC`).all(workspaceId)) as Array<{ id: string; role: WorkspaceRole; event_ids_json: string; expires_at: string; created_at: string }>).map((invite) => ({
    id: invite.id, role: invite.role, eventIds: JSON.parse(invite.event_ids_json) as string[], expiresAt: invite.expires_at,
    expired: Date.parse(invite.expires_at) <= Date.now(),
  }));
  return { events, members, invites };
}

type EventInput = { name: string; startsAt: string; endsAt: string; timeZone: string; spendMinor: number | null; active: boolean };

function validateEventInput(input: EventInput) {
  if (!input.name.trim()) throw new Error('Enter an event name.');
  if (!Number.isFinite(Date.parse(input.startsAt)) || !Number.isFinite(Date.parse(input.endsAt)) || Date.parse(input.endsAt) < Date.parse(input.startsAt)) {
    throw new Error('Check the event dates. The end date must be on or after the start date.');
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: input.timeZone }).format(); }
  catch { throw new Error('Enter a time zone such as America/Los_Angeles.'); }
  if (input.spendMinor !== null && (!Number.isSafeInteger(input.spendMinor) || input.spendMinor < 0)) throw new Error('Event spend must be zero or a positive amount.');
}

export async function saveWorkspaceEvent(actorId: string, workspaceId: string, eventId: string | null, input: EventInput) {
  const saved = await saveWorkspaceEventDetailed(actorId, workspaceId, eventId, input);
  return saved ? saved.id : false;
}

// Creating an event with the same name and dates as one that already exists (a double click, or a retry after a lost
// response) returns that event instead of adding a second one.
export async function saveWorkspaceEventDetailed(actorId: string, workspaceId: string, eventId: string | null, input: EventInput): Promise<{ id: string; created: boolean } | false> {
  await (requireCompanyAdmin(actorId, workspaceId));
  validateEventInput(input);
  let id = eventId ?? randomUUID();
  if (eventId && !await (db.prepare(`SELECT id FROM events WHERE workspace_id=? AND id=?`).get(workspaceId, eventId))) return false;
  const startsAt = new Date(input.startsAt).toISOString();
  const endsAt = new Date(input.endsAt).toISOString();
  let created = !eventId;
  await (db.transaction(async () => {
    if (!eventId) {
      const same = await (db.prepare(`SELECT id FROM events WHERE workspace_id=? AND lower(name)=lower(?) AND starts_at=? AND ends_at=? LIMIT 1`).get(workspaceId, input.name.trim(), startsAt, endsAt)) as { id: string } | undefined;
      if (same) {
        id = same.id; created = false;
        if (input.active) {
          await (db.prepare(`UPDATE events SET is_active=0 WHERE workspace_id=?`).run(workspaceId));
          await (db.prepare(`UPDATE events SET is_active=1 WHERE workspace_id=? AND id=?`).run(workspaceId, same.id));
        }
        return;
      }
    }
    if (input.active) await (db.prepare(`UPDATE events SET is_active=0 WHERE workspace_id=?`).run(workspaceId));
    if (eventId) {
      await (db.prepare(`UPDATE events SET name=?,starts_at=?,ends_at=?,time_zone=?,spend_minor=?,is_active=? WHERE workspace_id=? AND id=?`)
        .run(input.name.trim(), startsAt, endsAt, input.timeZone, input.spendMinor, input.active ? 1 : 0, workspaceId, id));
    } else {
      await (db.prepare(`INSERT INTO events(id,workspace_id,name,starts_at,ends_at,time_zone,spend_minor,is_active) VALUES (?,?,?,?,?,?,?,?)`)
        .run(id, workspaceId, input.name.trim(), startsAt, endsAt, input.timeZone, input.spendMinor, input.active ? 1 : 0));
      await (db.prepare(`INSERT OR IGNORE INTO event_access(workspace_id,event_id,user_id) SELECT ?,?,user_id FROM memberships WHERE workspace_id=? AND role='admin' AND status='active'`)
        .run(workspaceId, id, workspaceId));
    }
    await (db.prepare(`INSERT OR IGNORE INTO event_access(workspace_id,event_id,user_id) SELECT ?,?,user_id FROM memberships WHERE workspace_id=? AND role='admin' AND status='active'`)
      .run(workspaceId, id, workspaceId));
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,?,? ,?,?)`)
      .run(randomUUID(), workspaceId, actorId, eventId ? 'event_updated' : 'event_created', 'event', id, JSON.stringify({ name: input.name.trim(), startsAt, endsAt, timeZone: input.timeZone, spendMinor: input.spendMinor, active: input.active })));
  })());
  return { id, created };
}

export async function createWorkspaceInvite(actorId: string, workspaceId: string, role: 'manager' | 'representative', eventIds: string[]) {
  await (requireCompanyAdmin(actorId, workspaceId));
  const uniqueEventIds = [...new Set(eventIds)];
  const eventCount = uniqueEventIds.length
    ? (await (db.prepare(`SELECT COUNT(*) AS count FROM events WHERE workspace_id=? AND id IN (${uniqueEventIds.map(() => '?').join(',')})`).get(workspaceId, ...uniqueEventIds)) as { count: number }).count
    : 0;
  if (eventCount !== uniqueEventIds.length) {
    throw new Error('Choose events from this company only.');
  }
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
  await (db.transaction(async () => {
    await (db.prepare(`INSERT INTO invites(id,workspace_id,token_hash,role,event_ids_json,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .run(id, workspaceId, hash(token), role, JSON.stringify(uniqueEventIds), expiresAt, actorId));
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'invite_created','invite',?,?)`)
      .run(randomUUID(), workspaceId, actorId, id, JSON.stringify({ role, eventIds: uniqueEventIds, expiresAt })));
  })());
  return { id, token, role, expiresAt };
}

export async function revokeWorkspaceInvite(actorId: string, workspaceId: string, inviteId: string) {
  await (requireCompanyAdmin(actorId, workspaceId));
  return await (db.transaction(async () => {
    const result = await (db.prepare(`UPDATE invites SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=? AND id=? AND accepted_at IS NULL AND revoked_at IS NULL`).run(workspaceId, inviteId));
    if (!result.changes) return false;
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id) VALUES (?,?,?,'invite_revoked','invite',?)`).run(randomUUID(), workspaceId, actorId, inviteId));
    return true;
  })());
}

async function pendingInvite(token: string) {
  return await (db.prepare(`SELECT i.id,i.workspace_id,i.role,i.event_ids_json,w.kind FROM invites i JOIN workspaces w ON w.id=i.workspace_id
    WHERE i.token_hash=? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`).get(hash(token))) as
    { id: string; workspace_id: string; role: 'manager' | 'representative'; event_ids_json: string; kind: WorkspaceKind } | undefined;
}

async function applyInvite(invite: NonNullable<Awaited<ReturnType<typeof pendingInvite>>>, userId: string) {
  await (db.prepare(`INSERT INTO memberships(workspace_id,user_id,role,status) VALUES (?,?,?,'active')
    ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,status='active'`).run(invite.workspace_id, userId, invite.role));
  await (db.prepare(`DELETE FROM event_access WHERE workspace_id=? AND user_id=?`).run(invite.workspace_id, userId));
  const eventIds = JSON.parse(invite.event_ids_json) as string[];
  const addAccess = db.prepare(`INSERT OR IGNORE INTO event_access(workspace_id,event_id,user_id) SELECT ?,id,? FROM events WHERE workspace_id=? AND id=?`);
  for (const eventId of eventIds) await (addAccess.run(invite.workspace_id, userId, invite.workspace_id, eventId));
  const accepted = await (db.prepare(`UPDATE invites SET accepted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND accepted_at IS NULL AND revoked_at IS NULL`).run(invite.id));
  if (!accepted.changes) throw new Error('This invite was already used. Ask the admin for a new link.');
  await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'invite_accepted','membership',?,?)`)
    .run(randomUUID(), invite.workspace_id, userId, userId, JSON.stringify({ role: invite.role })));
  return invite.workspace_id;
}

export async function acceptInviteForUser(actorId: string, token: string) {
  const invite = await (pendingInvite(token));
  if (!invite || invite.kind !== 'company') throw new Error('This invite has expired or was cancelled. Ask the admin for a new link.');
  return await (db.transaction(async () => await (applyInvite(invite, actorId)))());
}

export async function createUserFromInvite(input: { name: string; email: string; passwordHash: string; token: string; emailVerified?: boolean }) {
  const invite = await (pendingInvite(input.token));
  if (!invite || invite.kind !== 'company') throw new Error('This invite has expired or was cancelled. Ask the admin for a new link.');
  const userId = randomUUID();
  return await (db.transaction(async () => {
    await (db.prepare(`INSERT INTO users(id,name,email,password_hash,email_verified_at) VALUES (?,?,?,?,CASE WHEN ?=1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END)`)
      .run(userId, input.name, input.email, input.passwordHash, input.emailVerified === false ? 0 : 1));
    const workspaceId = await (applyInvite(invite, userId));
    return { userId, workspaceId };
  })());
}

export async function removeWorkspaceMember(actorId: string, workspaceId: string, userId: string) {
  await (requireCompanyAdmin(actorId, workspaceId));
  const owner = await (db.prepare(`SELECT owner_user_id FROM workspaces WHERE id=?`).get(workspaceId)) as { owner_user_id: string } | undefined;
  const member = await (db.prepare(`SELECT m.role,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id=? AND m.status='active'`).get(workspaceId, userId)) as { role: WorkspaceRole; email: string } | undefined;
  if (!member) return false;
  if (userId === actorId || userId === owner?.owner_user_id) throw new Error('The workspace owner cannot be removed.');
  if (member.role === 'admin') {
    const admins = await (db.prepare(`SELECT COUNT(*) AS count FROM memberships WHERE workspace_id=? AND role='admin' AND status='active'`).get(workspaceId)) as { count: number };
    if (admins.count <= 1) throw new Error('Keep at least one active admin in the company.');
  }
  return await (db.transaction(async () => {
    const removed = await (db.prepare(`UPDATE memberships SET status='removed' WHERE workspace_id=? AND user_id=? AND status='active'`).run(workspaceId, userId));
    if (!removed.changes) return false;
    await (db.prepare(`DELETE FROM event_access WHERE workspace_id=? AND user_id=?`).run(workspaceId, userId));
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'member_removed','membership',?,?)`)
      .run(randomUUID(), workspaceId, actorId, userId, JSON.stringify({ email: member.email })));
    return true;
  })());
}

export async function updateWorkspaceMemberAccess(actorId: string, workspaceId: string, userId: string, role: 'manager' | 'representative', eventIds: string[]) {
  await (requireCompanyAdmin(actorId, workspaceId));
  if (actorId === userId) throw new Error('You cannot change your own access.');
  const uniqueEventIds = [...new Set(eventIds)];
  const eventCount = uniqueEventIds.length
    ? (await (db.prepare(`SELECT COUNT(*) AS count FROM events WHERE workspace_id=? AND id IN (${uniqueEventIds.map(() => '?').join(',')})`).get(workspaceId, ...uniqueEventIds)) as { count: number }).count
    : 0;
  if (eventCount !== uniqueEventIds.length) throw new Error('Choose events from this company only.');
  if (await (db.prepare(`SELECT 1 FROM events WHERE workspace_id=? LIMIT 1`).get(workspaceId)) && !uniqueEventIds.length) {
    throw new Error('Give this teammate access to at least one event.');
  }
  const current = await (db.prepare(`SELECT role FROM memberships WHERE workspace_id=? AND user_id=? AND status='active'`).get(workspaceId, userId)) as { role: WorkspaceRole } | undefined;
  if (!current) return false;
  if (current.role === 'admin') throw new Error('Admin access cannot be changed here.');
  return await (db.transaction(async () => {
    await (db.prepare(`UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=? AND status='active'`).run(role, workspaceId, userId));
    await (db.prepare(`DELETE FROM event_access WHERE workspace_id=? AND user_id=?`).run(workspaceId, userId));
    const addAccess = db.prepare(`INSERT INTO event_access(workspace_id,event_id,user_id) VALUES (?,?,?)`);
    for (const eventId of uniqueEventIds) await (addAccess.run(workspaceId, eventId, userId));
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'member_access_updated','membership',?,?)`)
      .run(randomUUID(), workspaceId, actorId, userId, JSON.stringify({ role, eventIds: uniqueEventIds })));
    return true;
  })());
}

async function assertWorkspaceAccess(actorId: string, workspaceId: string) {
  const membership = await (db.prepare(`SELECT 1 AS allowed FROM memberships WHERE user_id=? AND workspace_id=? AND status='active'`).get(actorId, workspaceId));
  if (!membership) throw new Error('Workspace access changed. Choose an available space.');
}

async function contactAccessible(actorId: string, workspaceId: string, contactId: string, includeArchived = false) {
  const accessible = await (db.prepare(`SELECT 1 FROM contacts c JOIN memberships m ON m.workspace_id=c.workspace_id AND m.user_id=? AND m.status='active'
    WHERE c.workspace_id=? AND c.id=? AND c.deleted_at IS NULL AND (?=1 OR c.archived_at IS NULL)
      AND (m.role='admin' OR c.owner_user_id=? OR EXISTS (
        SELECT 1 FROM encounters en JOIN event_access ea ON ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id
        WHERE en.workspace_id=c.workspace_id AND en.contact_id=c.id AND ea.user_id=?)) LIMIT 1`)
    .get(actorId, workspaceId, contactId, includeArchived ? 1 : 0, actorId, actorId));
  return Boolean(accessible);
}

async function noteScope(actorId: string, workspaceId: string) {
  const workspace = await (workspaceForActor(actorId, workspaceId));
  return { all: workspace?.kind === 'personal' || workspace?.role === 'admin' ? 1 : 0 };
}

function visibleNoteSql(alias: string) {
  return `(?=1 OR ${alias}.created_by=? OR EXISTS (
    SELECT 1 FROM encounters note_en JOIN event_access note_ea ON note_ea.workspace_id=note_en.workspace_id AND note_ea.event_id=note_en.event_id
    WHERE note_en.workspace_id=${alias}.workspace_id AND note_en.id=${alias}.encounter_id AND note_ea.user_id=?))`;
}

async function noteVisible(actorId: string, workspaceId: string, noteId: string, edit = false) {
  const scope = await (noteScope(actorId, workspaceId));
  const row = await (db.prepare(`SELECT n.contact_id FROM notes n
    LEFT JOIN encounters en ON en.workspace_id=n.workspace_id AND en.id=n.encounter_id
    WHERE n.workspace_id=? AND n.id=? AND ${edit ? '(?=1 OR n.created_by=?)' : visibleNoteSql('n')}
      AND (en.event_id IS NULL OR ?=1 OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id AND ea.user_id=?))
    LIMIT 1`)
    .get(workspaceId, noteId, scope.all, actorId, ...(edit ? [] : [actorId]), scope.all, actorId)) as { contact_id: string } | undefined;
  return Boolean(row && await (contactAccessible(actorId, workspaceId, row.contact_id)));
}

async function noteEncounter(actorId: string, workspaceId: string, contactId: string) {
  const scope = await (noteScope(actorId, workspaceId));
  const row = await (db.prepare(`SELECT en.id FROM encounters en WHERE en.workspace_id=? AND en.contact_id=?
    AND (?=1 OR en.event_id IS NULL OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id AND ea.user_id=?))
    ORDER BY en.occurred_at DESC LIMIT 1`).get(workspaceId, contactId, scope.all, actorId)) as { id: string } | undefined;
  return row?.id ?? null;
}

function emailAccessSql(emailAlias = 'm', contactAlias = 'c', membershipAlias = 'ms', linkedAlias = 'linked') {
  return `(${membershipAlias}.role='admin'
    OR (${emailAlias}.encounter_id IS NOT NULL AND ${linkedAlias}.id IS NOT NULL AND ${linkedAlias}.event_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM event_access ea WHERE ea.workspace_id=${linkedAlias}.workspace_id AND ea.event_id=${linkedAlias}.event_id AND ea.user_id=?))
    OR ((${emailAlias}.encounter_id IS NULL OR ${linkedAlias}.id IS NULL OR ${linkedAlias}.event_id IS NULL) AND (${contactAlias}.owner_user_id=? OR EXISTS (
      SELECT 1 FROM encounters en JOIN event_access ea ON ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id
      WHERE en.workspace_id=${contactAlias}.workspace_id AND en.contact_id=${contactAlias}.id AND ea.user_id=?))))`;
}

async function emailAccessible(actorId: string, workspaceId: string, emailId: string) {
  return Boolean(await (db.prepare(`SELECT 1 FROM emails m
    JOIN contacts c ON c.workspace_id=m.workspace_id AND c.id=m.contact_id
    JOIN memberships ms ON ms.workspace_id=m.workspace_id AND ms.user_id=? AND ms.status='active'
    LEFT JOIN encounters linked ON linked.workspace_id=m.workspace_id AND linked.id=m.encounter_id
    WHERE m.workspace_id=? AND m.id=? AND c.deleted_at IS NULL AND c.archived_at IS NULL AND ${emailAccessSql()} LIMIT 1`)
    .get(actorId, workspaceId, emailId, actorId, actorId, actorId)));
}

async function companyAccessible(actorId: string, workspaceId: string, companyId: string) {
  return Boolean(await (db.prepare(`SELECT 1 FROM companies co
    WHERE co.workspace_id=? AND co.id=? AND co.archived_at IS NULL AND (
      EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id=co.workspace_id AND m.user_id=? AND m.status='active' AND m.role='admin')
      OR EXISTS (SELECT 1 FROM contacts c WHERE c.workspace_id=co.workspace_id AND c.company_id=co.id AND c.deleted_at IS NULL AND c.archived_at IS NULL
        AND (c.owner_user_id=? OR EXISTS (SELECT 1 FROM encounters en JOIN event_access ea ON ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id
          WHERE en.workspace_id=c.workspace_id AND en.contact_id=c.id AND ea.user_id=?)))
      OR EXISTS (SELECT 1 FROM scans s WHERE s.workspace_id=co.workspace_id AND s.material_company_id=co.id AND s.status='saved'
        AND ((s.event_id IS NULL AND s.created_by=?) OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=s.workspace_id AND ea.event_id=s.event_id AND ea.user_id=?)))
    ) LIMIT 1`).get(workspaceId, companyId, actorId, actorId, actorId, actorId, actorId)));
}

async function assertContactAccess(actorId: string, workspaceId: string, contactId: string, includeArchived = false) {
  if (!await (contactAccessible(actorId, workspaceId, contactId, includeArchived))) throw new AccessDeniedError('You do not have access to this person. They may be archived, or in an event you are not on. Ask your admin if you need access.');
}

export async function getCurrentEvent(actorId: string, workspaceId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  return await (db.prepare(`SELECT e.id,e.name,e.starts_at,e.ends_at,e.time_zone FROM events e
    JOIN event_access a ON a.event_id=e.id AND a.workspace_id=e.workspace_id
    WHERE e.workspace_id=? AND e.is_active=1 AND a.user_id=? ORDER BY e.starts_at DESC LIMIT 1`)
    .get(workspaceId, actorId)) as { id: string; name: string; starts_at: string; ends_at: string; time_zone: string } | undefined;
}

export async function listAccessibleEvents(actorId: string, workspaceId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  return await (db.prepare(`SELECT e.id,e.name,e.starts_at,e.ends_at,e.time_zone,e.is_active FROM events e
    JOIN event_access ea ON ea.workspace_id=e.workspace_id AND ea.event_id=e.id AND ea.user_id=?
    WHERE e.workspace_id=? ORDER BY e.is_active DESC,e.starts_at DESC,e.name`)
    .all(actorId, workspaceId)) as Array<{ id: string; name: string; starts_at: string; ends_at: string; time_zone: string; is_active: number }>;
}

export async function getDashboard(actorId: string, workspaceId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const activeEvent = await getCurrentEvent(actorId, workspaceId);
  const timeZone = activeEvent?.time_zone ?? 'UTC';
  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [year, month, day] = todayKey.split('-').map(Number);
  const tomorrowKey = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  const todayStart = dateTimeInZone(todayKey, 0, timeZone);
  const todayEnd = dateTimeInZone(tomorrowKey, 0, timeZone);
  const due = await (db.prepare(`SELECT t.id,t.title,t.due_at,t.time_zone,t.kind,t.status,c.id AS contact_id,c.name AS contact_name,co.name AS company_name
    FROM tasks t JOIN contacts c ON c.id=t.contact_id AND c.workspace_id=t.workspace_id
    JOIN companies co ON co.id=c.company_id AND co.workspace_id=c.workspace_id
    WHERE t.workspace_id=? AND t.kind='follow_up' AND t.status='open' AND t.due_at<? AND (t.snoozed_until IS NULL OR datetime(t.snoozed_until)<=datetime('now'))
      AND c.archived_at IS NULL AND c.deleted_at IS NULL AND (t.event_id IS NULL OR EXISTS (
        SELECT 1 FROM event_access ea WHERE ea.workspace_id=t.workspace_id AND ea.event_id=t.event_id AND ea.user_id=?))
      AND (c.owner_user_id=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id=c.workspace_id AND m.user_id=? AND m.role='admin') OR EXISTS (
        SELECT 1 FROM encounters en JOIN event_access ea ON ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id WHERE en.workspace_id=c.workspace_id AND en.contact_id=c.id AND ea.user_id=?))
    ORDER BY t.due_at LIMIT 8`).all(workspaceId, todayEnd, actorId, actorId, actorId, actorId)) as Array<{ id: string; title: string; due_at: string; time_zone: string; kind: string; status: string; contact_id: string; contact_name: string; company_name: string }>;
  const counts = await (db.prepare(`SELECT
      (SELECT COUNT(*) FROM contacts c WHERE c.workspace_id=@workspaceId AND c.archived_at IS NULL AND c.deleted_at IS NULL AND c.created_at>=@todayStart AND c.created_at<@todayEnd AND (c.owner_user_id=@actorId OR EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id=c.workspace_id AND m.user_id=@actorId AND m.role='admin') OR EXISTS (SELECT 1 FROM encounters en JOIN event_access ea ON ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id WHERE en.workspace_id=c.workspace_id AND en.contact_id=c.id AND ea.user_id=@actorId))) AS captured_today,
      (SELECT COUNT(*) FROM scans s WHERE s.workspace_id=@workspaceId AND s.status IN ('queued','reading','ready','failed') AND ((s.event_id IS NULL AND s.created_by=@actorId) OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=s.workspace_id AND ea.event_id=s.event_id AND ea.user_id=@actorId))) AS waiting_review,
      (SELECT COUNT(*) FROM tasks t JOIN contacts c ON c.id=t.contact_id AND c.workspace_id=t.workspace_id WHERE t.workspace_id=@workspaceId AND t.kind='follow_up' AND t.status='open' AND c.archived_at IS NULL AND c.deleted_at IS NULL AND t.due_at<@todayEnd AND (t.snoozed_until IS NULL OR datetime(t.snoozed_until)<=datetime('now')) AND (t.event_id IS NULL OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=t.workspace_id AND ea.event_id=t.event_id AND ea.user_id=@actorId)) AND (c.owner_user_id=@actorId OR EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id=c.workspace_id AND m.user_id=@actorId AND m.role='admin') OR EXISTS (SELECT 1 FROM encounters en JOIN event_access ea ON ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id WHERE en.workspace_id=c.workspace_id AND en.contact_id=c.id AND ea.user_id=@actorId))) AS follow_ups_due,
      (SELECT COUNT(*) FROM emails e JOIN contacts c ON c.id=e.contact_id AND c.workspace_id=e.workspace_id WHERE e.workspace_id=@workspaceId AND c.archived_at IS NULL AND c.deleted_at IS NULL AND e.status='replied' AND (c.owner_user_id=@actorId OR EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id=c.workspace_id AND m.user_id=@actorId AND m.role='admin') OR EXISTS (SELECT 1 FROM encounters en JOIN event_access ea ON ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id WHERE en.workspace_id=c.workspace_id AND en.contact_id=c.id AND ea.user_id=@actorId))) AS replies`)
    .get({ workspaceId, actorId, todayStart, todayEnd })) as { captured_today: number; waiting_review: number; follow_ups_due: number; replies: number };
  const scans = await listScans(actorId, workspaceId, 100);
  const nextReviewScanId = scans.find((scan) => scan.status === 'ready' || scan.status === 'failed')?.id ?? null;
  const workspaceKind = (await (db.prepare(`SELECT kind FROM workspaces WHERE id=?`).get(workspaceId)) as { kind: WorkspaceKind }).kind;
  const profileKey = workspaceKind === 'personal' ? 'aboutMe' : 'knowledge';
  const profile = await (getWorkspaceSetting(actorId, workspaceId, profileKey)) as Record<string, unknown> | undefined;
  const profileFields = workspaceKind === 'personal' ? ['role', 'company', 'lookingFor'] : ['whatYouSell', 'productsText'];
  const hasPersonalizationDetails = profileFields.some((field) => typeof profile?.[field] === 'string' && (profile[field] as string).trim().length > 0);
  const draftRow = await db.prepare(`SELECT COUNT(*) AS count FROM emails m
    JOIN contacts c ON c.id=m.contact_id AND c.workspace_id=m.workspace_id
    JOIN memberships ms ON ms.workspace_id=m.workspace_id AND ms.user_id=? AND ms.status='active'
    LEFT JOIN encounters linked ON linked.id=m.encounter_id AND linked.workspace_id=m.workspace_id
    WHERE m.workspace_id=? AND m.status='draft' AND c.deleted_at IS NULL AND c.archived_at IS NULL AND ${emailAccessSql()}`)
    .get(actorId, workspaceId, actorId, actorId, actorId) as { count: number };
  const draftsReady = draftRow.count;
  return { counts: { ...counts, drafts_ready: draftsReady }, due, nextReviewScanId, hasPersonalizationDetails, timeZone };
}

// The screen shows the 200 most recent matches (search finds the rest); an export passes a larger limit to get everyone.
export async function listPeople(actorId: string, workspaceId: string, search = '', includeArchived = false, limit = 200) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const term = `%${search.trim().replace(/[\\%_]/g, '\\$&')}%`;
  return await (db.prepare(`SELECT c.id,c.name,c.title,c.email,c.phone,c.website,c.quality,c.stage,c.version,c.updated_at,
      co.id AS company_id,co.name AS company_name,COUNT(DISTINCT en.id) AS encounters,
      GROUP_CONCAT(DISTINCT p.name) AS products
    FROM contacts c JOIN companies co ON co.id=c.company_id AND co.workspace_id=c.workspace_id
    LEFT JOIN encounters en ON en.contact_id=c.id AND en.workspace_id=c.workspace_id
    LEFT JOIN contact_products cp ON cp.contact_id=c.id AND cp.workspace_id=c.workspace_id
    LEFT JOIN products p ON p.id=cp.product_id AND p.workspace_id=cp.workspace_id
    WHERE c.workspace_id=? AND c.deleted_at IS NULL AND ((?=1 AND c.archived_at IS NOT NULL) OR (?=0 AND c.archived_at IS NULL))
      AND (c.owner_user_id=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id=c.workspace_id AND m.user_id=? AND m.role='admin') OR EXISTS (SELECT 1 FROM encounters en JOIN event_access ea ON ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id WHERE en.workspace_id=c.workspace_id AND en.contact_id=c.id AND ea.user_id=?))
      AND (?='' OR c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR co.name LIKE ? ESCAPE '\\')
    GROUP BY c.id ORDER BY c.updated_at DESC,c.name LIMIT ?`).all(workspaceId, includeArchived ? 1 : 0, includeArchived ? 1 : 0, actorId, actorId, actorId, search.trim(), term, term, term, limit)) as Array<Record<string, unknown>>;
}

export async function listCompanies(actorId: string, workspaceId: string, search = '') {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const term = `%${search.trim().replace(/[\\%_]/g, '\\$&')}%`;
  return await (db.prepare(`SELECT co.id,co.name,co.website,co.deal_value_minor,co.deal_status,co.created_at,
      COUNT(DISTINCT c.id) AS people,COUNT(DISTINCT en.id) AS encounters,COUNT(DISTINCT material.id) AS materials
    FROM companies co LEFT JOIN contacts c ON c.company_id=co.id AND c.workspace_id=co.workspace_id AND c.deleted_at IS NULL AND c.archived_at IS NULL
      AND (c.owner_user_id=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id=c.workspace_id AND m.user_id=? AND m.role='admin') OR EXISTS (SELECT 1 FROM encounters x JOIN event_access ea ON ea.workspace_id=x.workspace_id AND ea.event_id=x.event_id WHERE x.workspace_id=c.workspace_id AND x.contact_id=c.id AND ea.user_id=?))
    LEFT JOIN encounters en ON en.contact_id=c.id AND en.workspace_id=c.workspace_id AND (en.event_id IS NULL OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id AND ea.user_id=?))
    LEFT JOIN scans material ON material.workspace_id=co.workspace_id AND material.material_company_id=co.id AND material.status='saved'
      AND ((material.event_id IS NULL AND material.created_by=?) OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=material.workspace_id AND ea.event_id=material.event_id AND ea.user_id=?))
    WHERE co.workspace_id=? AND co.archived_at IS NULL AND (?='' OR co.name LIKE ? ESCAPE '\\')
    GROUP BY co.id HAVING people>0 OR materials>0 OR EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id=co.workspace_id AND m.user_id=? AND m.role='admin') ORDER BY people DESC,co.name LIMIT 200`).all(actorId, actorId, actorId, actorId, actorId, actorId, workspaceId, search.trim(), term, actorId)) as Array<Record<string, unknown>>;
}

export async function suggestCompanies(actorId: string, workspaceId: string, name: string, website: string, email: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const normalizedName = normalizeCompanyName(name);
  const domain = businessDomain(website) || emailDomain(email);
  if (normalizedName.length < 2 && !domain) return [];
  const rows = await (db.prepare(`SELECT id,name,normalized_name,normalized_domain FROM companies
    WHERE workspace_id=? AND archived_at IS NULL`).all(workspaceId)) as Array<{ id: string; name: string; normalized_name: string; normalized_domain: string | null }>;
  const aliases = await (db.prepare(`SELECT company_id,alias_type,alias_value FROM company_aliases WHERE workspace_id=?`).all(workspaceId)) as Array<{ company_id: string; alias_type: 'name' | 'domain'; alias_value: string }>;
  const aliasMap = new Map<string, { names: Set<string>; domains: Set<string> }>();
  for (const alias of aliases) {
    const list = aliasMap.get(alias.company_id) ?? { names: new Set<string>(), domains: new Set<string>() };
    if (alias.alias_type === 'name') list.names.add(alias.alias_value);
    else list.domains.add(alias.alias_value);
    aliasMap.set(alias.company_id, list);
  }
  const ranked = rows.map((company) => {
    const exactDomain = Boolean(domain && (company.normalized_domain === domain || aliasMap.get(company.id)?.domains.has(domain)));
    const exactName = Boolean(normalizedName && (company.normalized_name === normalizedName || aliasMap.get(company.id)?.names.has(normalizedName)));
    const sameCoreName = companyCoreName(name) && companyCoreName(name) === companyCoreName(company.name);
    const similarName = sameCoreName || normalizedName.length >= 3 && company.normalized_name.length >= 3 &&
      (company.normalized_name.startsWith(normalizedName) || normalizedName.startsWith(company.normalized_name) ||
        editDistance(company.normalized_name, normalizedName) <= 2 ||
        Math.min(company.normalized_name.length, normalizedName.length) / Math.max(company.normalized_name.length, normalizedName.length) >= 0.82 && editDistance(company.normalized_name, normalizedName) <= 4);
    return { ...company, score: exactDomain ? 0 : exactName ? 1 : similarName ? 2 : 9,
      reason: exactDomain ? 'same domain' : exactName ? 'same name' : 'similar name' };
  }).filter((company) => company.score < 9);
  const accessChecks = await Promise.all(ranked.map(async (company) => ({
    company,
    accessible: await companyAccessible(actorId, workspaceId, company.id),
  })));
  const visibleRanked = accessChecks.filter((item) => item.accessible).map((item) => item.company)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)).slice(0, 5);
  return Promise.all(visibleRanked.map(async (company) => {
    const count = await (db.prepare(`SELECT COUNT(*) AS total FROM contacts c WHERE c.workspace_id=? AND c.company_id=? AND c.deleted_at IS NULL AND c.archived_at IS NULL
      AND (c.owner_user_id=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id=c.workspace_id AND m.user_id=? AND m.status='active' AND m.role='admin')
        OR EXISTS (SELECT 1 FROM encounters en JOIN event_access ea ON ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id
          WHERE en.workspace_id=c.workspace_id AND en.contact_id=c.id AND ea.user_id=?))`).get(workspaceId, company.id, actorId, actorId, actorId)) as { total: number };
    return { id: company.id, name: company.name, people_count: count.total, reason: company.reason };
  }));
}

export async function listProducts(actorId: string, workspaceId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  return await (db.prepare(`SELECT id,name,description FROM products WHERE workspace_id=? AND archived_at IS NULL ORDER BY name`).all(workspaceId));
}

export async function getCompanyDetail(actorId: string, workspaceId: string, companyId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const companies = await listCompanies(actorId, workspaceId);
  const visible = companies.find((item) => item.id === companyId);
  if (!visible) return undefined;
  const allPeople = await listPeople(actorId, workspaceId);
  const people = allPeople.filter((person) => person.company_id === companyId);
  const materialRows = await (db.prepare(`SELECT s.id AS scan_id,s.image_mime,s.saved_at,s.extracted_json,e.name AS event_name
    FROM scans s LEFT JOIN events e ON e.id=s.event_id AND e.workspace_id=s.workspace_id
    WHERE s.workspace_id=? AND s.material_company_id=? AND s.status='saved'
      AND ((s.event_id IS NULL AND s.created_by=?) OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=s.workspace_id AND ea.event_id=s.event_id AND ea.user_id=?))
    ORDER BY s.saved_at DESC`).all(workspaceId, companyId, actorId, actorId)) as Array<{ scan_id: string; image_mime: string; saved_at: string; extracted_json: string | null; event_name: string | null }>;
  const materials = materialRows.map(({ extracted_json, ...material }) => {
    let extracted: { products?: unknown; topics?: unknown } = {};
    try { extracted = extracted_json ? JSON.parse(extracted_json) as typeof extracted : {}; } catch { /* Older or malformed extraction remains viewable without its item list. */ }
    const items = [...(Array.isArray(extracted.products) ? extracted.products : []), ...(Array.isArray(extracted.topics) ? extracted.topics : [])]
      .filter((item): item is string => typeof item === 'string' && !!item.trim());
    return { ...material, items: [...new Set(items)] };
  });
  return { company: visible, people, materials };
}

export async function mergeCompany(actorId: string, workspaceId: string, sourceId: string, targetId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const workspace = await (workspaceForActor(actorId, workspaceId));
  if (!workspace || workspace.kind === 'company' && workspace.role !== 'admin') {
    throw new AccessDeniedError('Only a company admin can merge company records.');
  }
  if (sourceId === targetId) throw new Error('Choose another company to keep.');
  return await (db.transaction(async () => {
    const getCompany = db.prepare(`SELECT id,name,normalized_name,normalized_domain,website,deal_value_minor,deal_status
      FROM companies WHERE workspace_id=? AND id=? AND archived_at IS NULL`);
    const source = await (getCompany.get(workspaceId, sourceId)) as { id: string; name: string; normalized_name: string; normalized_domain: string | null; website: string | null; deal_value_minor: number | null; deal_status: string | null } | undefined;
    const target = await (getCompany.get(workspaceId, targetId)) as typeof source;
    if (!source || !target) throw new Error('One of these companies is no longer available. Refresh and try again.');
    if ((source.deal_value_minor !== null && target.deal_value_minor !== null) ||
      (source.deal_status && target.deal_status && source.deal_status !== target.deal_status)) {
      throw new Error('Both companies have deal details. Review those values before merging them.');
    }
    const people = (await (db.prepare('SELECT COUNT(*) AS total FROM contacts WHERE workspace_id=? AND company_id=?').get(workspaceId, sourceId)) as { total: number }).total;
    const materials = (await (db.prepare('SELECT COUNT(*) AS total FROM scans WHERE workspace_id=? AND material_company_id=?').get(workspaceId, sourceId)) as { total: number }).total;
    await (db.prepare(`UPDATE contacts SET company_id=?,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=? AND company_id=?`).run(targetId, workspaceId, sourceId));
    await (db.prepare('UPDATE scans SET material_company_id=? WHERE workspace_id=? AND material_company_id=?').run(targetId, workspaceId, sourceId));
    await (db.prepare('UPDATE company_aliases SET company_id=? WHERE workspace_id=? AND company_id=?').run(targetId, workspaceId, sourceId));
    const addAlias = db.prepare('INSERT OR IGNORE INTO company_aliases(workspace_id,company_id,alias_type,alias_value) VALUES (?,?,?,?)');
    await (addAlias.run(workspaceId, targetId, 'name', source.normalized_name));
    if (source.normalized_domain) await (addAlias.run(workspaceId, targetId, 'domain', source.normalized_domain));
    await (db.prepare('DELETE FROM companies WHERE workspace_id=? AND id=?').run(workspaceId, sourceId));
    await (db.prepare(`UPDATE companies SET website=COALESCE(NULLIF(website,''),?), normalized_domain=COALESCE(NULLIF(normalized_domain,''),?),
      deal_value_minor=COALESCE(deal_value_minor,?), deal_status=COALESCE(deal_status,?) WHERE workspace_id=? AND id=?`)
      .run(source.website, source.normalized_domain, source.deal_value_minor, source.deal_status, workspaceId, targetId));
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json)
      VALUES (?,?,?,'company_merged','company',?,?)`)
      .run(randomUUID(), workspaceId, actorId, targetId, JSON.stringify({ sourceId, sourceName: source.name, targetName: target.name, peopleMoved: people, materialsMoved: materials })));
    return { targetCompanyId: targetId, peopleMoved: people, materialsMoved: materials };
  })());
}

export async function updateCompanyDeal(actorId: string, workspaceId: string, companyId: string, valueMinor: number | null, status: 'open' | 'won' | 'lost' | null) {
  const workspace = await (workspaceForActor(actorId, workspaceId));
  if (!workspace || !['admin','manager'].includes(workspace.role)) throw new AccessDeniedError('An admin or manager updates company deal values.');
  if (workspace.kind !== 'company') throw new Error('Deal values are only used in company spaces.');
  if (!await (companyAccessible(actorId, workspaceId, companyId))) return false;
  const changed = await (db.prepare(`UPDATE companies SET deal_value_minor=?,deal_status=? WHERE workspace_id=? AND id=? AND archived_at IS NULL`)
    .run(valueMinor, status, workspaceId, companyId));
  if (!changed.changes) return false;
  await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'deal_updated','company',?,?)`)
    .run(randomUUID(), workspaceId, actorId, companyId, JSON.stringify({ valueMinor, status })));
  return true;
}

/** The website to read for a company: its saved website, else a person's website, else a work-email domain. */
export async function getCompanyAboutTarget(actorId: string, workspaceId: string, companyId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  if (!await (companyAccessible(actorId, workspaceId, companyId))) return undefined;
  const company = await (db.prepare(`SELECT name,website,about FROM companies WHERE workspace_id=? AND id=? AND archived_at IS NULL`).get(workspaceId, companyId)) as { name: string; website: string | null; about: string } | undefined;
  if (!company) return undefined;
  let website = (company.website || '').trim();
  if (!website) {
    const people = await (db.prepare(`SELECT website,email FROM contacts WHERE workspace_id=? AND company_id=? AND deleted_at IS NULL AND archived_at IS NULL ORDER BY created_at LIMIT 20`).all(workspaceId, companyId)) as Array<{ website: string | null; email: string }>;
    website = people.find((person) => (person.website || '').trim())?.website?.trim() || '';
    if (!website) { const domain = people.map((person) => emailDomain(person.email)).find(Boolean); if (domain) website = domain; }
  }
  return { name: company.name, website, about: company.about };
}

export async function updateCompanyAbout(actorId: string, workspaceId: string, companyId: string, about: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  if (!await (companyAccessible(actorId, workspaceId, companyId))) return false;
  const changed = await (db.prepare(`UPDATE companies SET about=? WHERE workspace_id=? AND id=? AND archived_at IS NULL`).run(about.trim().slice(0, 400), workspaceId, companyId));
  if (!changed.changes) return false;
  await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'company_about_updated','company',?,?)`)
    .run(randomUUID(), workspaceId, actorId, companyId, JSON.stringify({ length: about.trim().length })));
  return true;
}

export async function getReportData(actorId: string, workspaceId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const allPeople = await listPeople(actorId, workspaceId);
  const stages = allPeople.reduce<Record<string, number>>((counts, person) => {
    const stage = String(person.stage);
    counts[stage] = (counts[stage] ?? 0) + 1;
    return counts;
  }, {});
  const companies = await (listCompanies(actorId, workspaceId));
  const valueByStatus = { open: 0, won: 0, lost: 0 };
  for (const company of companies) {
    const status = String(company.deal_status ?? 'open') as keyof typeof valueByStatus;
    if (company.deal_value_minor !== null && status in valueByStatus) valueByStatus[status] += Number(company.deal_value_minor);
  }
  const personScope = `(c.owner_user_id=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id=c.workspace_id AND m.user_id=? AND m.status='active' AND m.role='admin') OR EXISTS (SELECT 1 FROM encounters en JOIN event_access ea ON ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id WHERE en.workspace_id=c.workspace_id AND en.contact_id=c.id AND ea.user_id=?))`;
  const workMetrics = await (db.prepare(`SELECT
      SUM(CASE WHEN t.kind='follow_up' AND t.status='done' THEN 1 ELSE 0 END) AS follow_ups_done,
      SUM(CASE WHEN t.kind='meeting' AND t.status IN ('confirmed','done','no_show') THEN 1 ELSE 0 END) AS meetings
    FROM tasks t JOIN contacts c ON c.id=t.contact_id AND c.workspace_id=t.workspace_id
    WHERE t.workspace_id=? AND c.deleted_at IS NULL AND c.archived_at IS NULL AND ${personScope}
      AND (t.event_id IS NULL OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=t.workspace_id AND ea.event_id=t.event_id AND ea.user_id=?))`)
    .get(workspaceId, actorId, actorId, actorId, actorId)) as { follow_ups_done: number | null; meetings: number | null };
  const replies = (await (db.prepare(`SELECT COUNT(*) AS count FROM audit_events a JOIN contacts c ON c.workspace_id=a.workspace_id AND c.id=a.target_id
    WHERE a.workspace_id=? AND a.action='contact_replied' AND a.target_type='contact' AND c.deleted_at IS NULL AND c.archived_at IS NULL AND ${personScope}`)
    .get(workspaceId, actorId, actorId, actorId)) as { count: number }).count;
  const activeEvent = await (getCurrentEvent(actorId, workspaceId));
  const dailyCaptures: Array<{ day: string; captures: number }> = [];
  if (activeEvent) {
    const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: activeEvent.time_zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const [year, month, day] = todayKey.split('-').map(Number);
    const dayKeys = Array.from({ length: 14 }, (_, index) => new Date(Date.UTC(year, month - 1, day - 13 + index)).toISOString().slice(0, 10));
    const dayCounts = new Map(dayKeys.map((key) => [key, 0]));
    const scans = await (db.prepare(`SELECT s.saved_at FROM scans s JOIN contacts c ON c.workspace_id=s.workspace_id AND c.id=s.contact_id
      WHERE s.workspace_id=? AND s.event_id=? AND s.status='saved' AND s.saved_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 days') AND c.deleted_at IS NULL AND c.archived_at IS NULL AND ${personScope}`)
      .all(workspaceId, activeEvent.id, actorId, actorId, actorId)) as Array<{ saved_at: string }>;
    for (const scan of scans) {
      const key = new Intl.DateTimeFormat('en-CA', { timeZone: activeEvent.time_zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(scan.saved_at));
      if (dayCounts.has(key)) dayCounts.set(key, (dayCounts.get(key) ?? 0) + 1);
    }
    for (const key of dayKeys) dailyCaptures.push({ day: key.slice(5), captures: dayCounts.get(key) ?? 0 });
  }
  const eventRows = await (db.prepare(`SELECT e.id,e.name,e.spend_minor,COUNT(DISTINCT en.contact_id) AS people,COUNT(en.id) AS encounters
    FROM events e JOIN event_access ea ON ea.event_id=e.id AND ea.workspace_id=e.workspace_id AND ea.user_id=?
    LEFT JOIN encounters en ON en.event_id=e.id AND en.workspace_id=e.workspace_id
    WHERE e.workspace_id=? GROUP BY e.id ORDER BY e.starts_at DESC`).all(actorId, workspaceId));
  const wonCompanies = companies.filter((company) => company.deal_status === 'won');
  return {
    stages, valueByStatus, companies: companies.length, people: allPeople.length, events: eventRows,
    metrics: { followUpsDone: Number(workMetrics.follow_ups_done ?? 0), replies, meetings: Number(workMetrics.meetings ?? 0), wonCount: wonCompanies.length },
    dailyCaptures, activeEvent: activeEvent ? { id: activeEvent.id, name: activeEvent.name, timeZone: activeEvent.time_zone } : null,
  };
}

export async function getAnalytics(actorId: string, workspaceId: string, days: number, eventId = ''): Promise<AnalyticsData> {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const events = await (db.prepare(`SELECT e.id,e.name,e.time_zone FROM events e JOIN event_access ea ON ea.workspace_id=e.workspace_id AND ea.event_id=e.id AND ea.user_id=? WHERE e.workspace_id=? ORDER BY e.starts_at DESC`)
    .all(actorId, workspaceId)) as Array<{ id: string; name: string; time_zone: string }>;
  if (eventId && !events.some((event) => event.id === eventId)) throw new Error('Choose an event you can access.');
  const activeEvent = await getCurrentEvent(actorId, workspaceId);
  const timeZone = events.find((event) => event.id === eventId)?.time_zone ?? activeEvent?.time_zone ?? 'UTC';
  const today = localDateAndTime(new Date(), timeZone).day;
  const shiftDay = (offset: number) => new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
  const from = shiftDay(1 - days);
  const start = dateTimeInZone(from, 0, timeZone);
  const end = dateTimeInZone(shiftDay(1), 0, timeZone);
  const previousStart = dateTimeInZone(shiftDay(1 - days * 2), 0, timeZone);
  // The cohort comes only from accessible encounters, without the people-list pagination cap.
  const rows = await (db.prepare(`SELECT c.id,c.name,c.company_id,c.stage,c.quality,c.email,c.phone,co.name AS company,co.deal_status,co.deal_value_minor,
      en.id AS encounter_id,en.event_id,en.occurred_at,e.name AS event_name
    FROM encounters en JOIN contacts c ON c.id=en.contact_id AND c.workspace_id=en.workspace_id
    JOIN companies co ON co.id=c.company_id AND co.workspace_id=c.workspace_id
    LEFT JOIN events e ON e.id=en.event_id AND e.workspace_id=en.workspace_id
    WHERE en.workspace_id=? AND c.deleted_at IS NULL AND c.archived_at IS NULL
      AND en.occurred_at>=? AND en.occurred_at<? AND (?='' OR en.event_id=?)
      AND ((en.event_id IS NOT NULL AND EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id AND ea.user_id=?))
        OR (en.event_id IS NULL AND (c.owner_user_id=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id=c.workspace_id AND m.user_id=? AND m.role='admin' AND m.status='active'))))
    ORDER BY en.occurred_at DESC`).all(workspaceId, previousStart, end, eventId, eventId, actorId, actorId, actorId)) as Array<{
      id: string; name: string; company_id: string; stage: string; quality: string | null; email: string; phone: string; company: string;
      deal_status: string | null; deal_value_minor: number | null; encounter_id: string; event_id: string | null; occurred_at: string; event_name: string | null;
    }>;
  const current = rows.filter((row) => row.occurred_at >= start);
  const workflowScans = await db.prepare(`SELECT s.event_id,s.queued_at,s.saved_at,e.name AS event_name FROM scans s
    LEFT JOIN events e ON e.id=s.event_id AND e.workspace_id=s.workspace_id
    WHERE s.workspace_id=? AND s.status<>'discarded' AND (?='' OR s.event_id=?)
      AND ((s.event_id IS NULL AND s.created_by=?) OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=s.workspace_id AND ea.event_id=s.event_id AND ea.user_id=?))
      AND ((s.queued_at>=? AND s.queued_at<?) OR (s.saved_at>=? AND s.saved_at<?))`).all(workspaceId, eventId, eventId, actorId, actorId, start, end, start, end) as Array<{ event_id: string | null; queued_at: string; saved_at: string | null; event_name: string | null }>;
  const workflowEmails = await db.prepare(`SELECT linked.event_id,e.name AS event_name,linked.occurred_at,m.created_at,m.approved_at,m.sent_to_server_at,m.reply_recorded_at FROM emails m
    JOIN contacts c ON c.id=m.contact_id AND c.workspace_id=m.workspace_id
    JOIN memberships ms ON ms.workspace_id=m.workspace_id AND ms.user_id=? AND ms.status='active'
    LEFT JOIN encounters linked ON linked.id=m.encounter_id AND linked.workspace_id=m.workspace_id
    LEFT JOIN events e ON e.id=linked.event_id AND e.workspace_id=linked.workspace_id
    WHERE m.workspace_id=? AND c.deleted_at IS NULL AND c.archived_at IS NULL AND ${emailAccessSql()}
      AND (?='' OR linked.event_id=?)
      AND ((m.created_at>=? AND m.created_at<?) OR (m.approved_at>=? AND m.approved_at<?) OR (m.sent_to_server_at>=? AND m.sent_to_server_at<?) OR (m.reply_recorded_at>=? AND m.reply_recorded_at<?))`)
    .all(actorId, workspaceId, actorId, actorId, actorId, eventId, eventId, start, end, start, end, start, end, start, end) as Array<{ event_id: string | null; event_name: string | null; occurred_at: string | null; created_at: string; approved_at: string | null; sent_to_server_at: string | null; reply_recorded_at: string | null }>;
  const inPeriod = (date: string | null) => Boolean(date && date >= start && date < end);
  const medianMinutes = (pairs: Array<[string | null, string | null]>) => {
    const values = pairs.flatMap(([fromDate, toDate]) => fromDate && toDate ? [Math.max(0, (Date.parse(toDate) - Date.parse(fromDate)) / 60000)] : []).filter(Number.isFinite).sort((a, b) => a - b);
    return values.length ? Math.round((values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2) : null;
  };
  const workflowByEvent = new Map<string, { id: string; name: string; captured: number; reviewed: number; draftsPrepared: number; userApproved: number; serverAccepted: number; repliesRecorded: number }>();
  const eventRow = (id: string | null, name: string | null) => { const key = id ?? 'unassigned'; const value = workflowByEvent.get(key) ?? { id: key, name: name ?? 'No event assigned', captured: 0, reviewed: 0, draftsPrepared: 0, userApproved: 0, serverAccepted: 0, repliesRecorded: 0 }; workflowByEvent.set(key, value); return value; };
  for (const scan of workflowScans) { const value = eventRow(scan.event_id, scan.event_name); if (inPeriod(scan.queued_at)) value.captured++; if (inPeriod(scan.saved_at)) value.reviewed++; }
  for (const email of workflowEmails) { const value = eventRow(email.event_id, email.event_name); if (inPeriod(email.created_at)) value.draftsPrepared++; if (inPeriod(email.approved_at)) value.userApproved++; if (inPeriod(email.sent_to_server_at)) value.serverAccepted++; if (inPeriod(email.reply_recorded_at)) value.repliesRecorded++; }
  const workflowEvents = [...workflowByEvent.values()].sort((a, b) => b.captured - a.captured);
  const people = [...new Map(current.map((row) => [row.id, row])).values()];
  const companies = [...new Map(people.map((row) => [row.company_id, row])).values()];
  const dayMap = new Map(Array.from({ length: days }, (_, index) => [shiftDay(index + 1 - days), { people: new Set<string>(), conversations: 0 }]));
  const sourceMap = new Map<string, { id: string; name: string; people: Set<string>; conversations: number }>();
  for (const row of current) {
    const day = dayMap.get(localDateAndTime(new Date(row.occurred_at), timeZone).day);
    if (day) { day.people.add(row.id); day.conversations++; }
    const key = row.event_id ?? 'unassigned';
    const source = sourceMap.get(key) ?? { id: key, name: row.event_name ?? 'No event assigned', people: new Set<string>(), conversations: 0 };
    source.people.add(row.id); source.conversations++; sourceMap.set(key, source);
  }
  return {
    period: { days, from, to: today, timeZone }, selectedEventId: eventId, events: events.map(({ id, name }) => ({ id, name })),
    metrics: {
      people: people.length, previousPeople: new Set(rows.filter((row) => row.occurred_at < start).map((row) => row.id)).size,
      companies: companies.length, conversations: current.length,
      openValue: companies.filter((row) => row.deal_status === 'open').reduce((total, row) => total + (row.deal_value_minor ?? 0), 0),
      wonValue: companies.filter((row) => row.deal_status === 'won').reduce((total, row) => total + (row.deal_value_minor ?? 0), 0),
      wonCompanies: companies.filter((row) => row.deal_status === 'won').length,
      contactable: people.filter((row) => row.email || row.phone).length,
    },
    daily: [...dayMap].map(([day, value]) => ({ day, people: value.people.size, conversations: value.conversations })),
    stages: ['new','contacted','replied','meeting','won','lost'].map((stage) => ({ stage, people: people.filter((row) => row.stage === stage).length })),
    quality: ['hot','warm','cold','unrated'].map((quality) => ({ quality, people: people.filter((row) => (row.quality ?? 'unrated') === quality).length })),
    sources: [...sourceMap.values()].map((source) => ({ ...source, people: source.people.size })).sort((a,b) => b.people-a.people),
    recent: [...new Map([...current].reverse().map((row) => [row.id, row])).values()].sort((a,b) => b.occurred_at.localeCompare(a.occurred_at)).slice(0,8)
      .map((row) => ({ id: row.id, name: row.name, company: row.company, stage: row.stage, quality: row.quality, lastEncounter: row.occurred_at })),
    workflow: { captured: workflowEvents.reduce((sum, row) => sum + row.captured, 0), reviewed: workflowEvents.reduce((sum, row) => sum + row.reviewed, 0), draftsPrepared: workflowEvents.reduce((sum, row) => sum + row.draftsPrepared, 0), userApproved: workflowEvents.reduce((sum, row) => sum + row.userApproved, 0), serverAccepted: workflowEvents.reduce((sum, row) => sum + row.serverAccepted, 0), repliesRecorded: workflowEvents.reduce((sum, row) => sum + row.repliesRecorded, 0), medianCaptureToReviewMinutes: medianMinutes(workflowScans.filter((scan) => inPeriod(scan.saved_at)).map((scan) => [scan.queued_at, scan.saved_at])), medianConversationToDraftMinutes: medianMinutes(workflowEmails.filter((email) => inPeriod(email.created_at)).map((email) => [email.occurred_at, email.created_at])), events: workflowEvents },
  };
}

export async function exportPeople(actorId: string, workspaceId: string) {
  const people = await listPeople(actorId, workspaceId, '', false, 1_000_000);
  return people.map(({ name, title, company_name, email, phone, website, quality, stage }) => ({ name, title, company: company_name, email, phone, website, quality, stage }));
}

export async function getWorkspaceExport(actorId: string, workspaceId: string) {
  const workspace = await (workspaceForActor(actorId, workspaceId));
  if (!workspace || (workspace.kind === 'company' && workspace.role !== 'admin') || (workspace.kind === 'personal' && workspace.role !== 'attendee')) {
    throw new AccessDeniedError('Only the company admin or private-space owner can export all workspace data.');
  }
  const rawScans = await (db.prepare(`SELECT id,event_id,client_scan_id,source,status,extracted_json,uncertain_json,contact_id,material_company_id,queued_at,reading_started_at,ready_at,saved_at,image_mime,image_path FROM scans WHERE workspace_id=? ORDER BY queued_at`).all(workspaceId)) as Array<Record<string, unknown>>;
  const rawNotes = await (db.prepare(`SELECT id,contact_id,encounter_id,kind,body,transcript,transcript_status,audio_mime,duration_seconds,created_at,audio_path FROM notes WHERE workspace_id=? ORDER BY created_at`).all(workspaceId)) as Array<Record<string, unknown>>;
  const media: Array<{ kind: 'scan_photo' | 'voice_note'; recordId: string; mimeType: string; path: string }> = [];
  const scans = rawScans.map((scan) => {
    if (typeof scan.image_path === 'string' && typeof scan.image_mime === 'string') media.push({ kind: 'scan_photo', recordId: String(scan.id), mimeType: scan.image_mime, path: scan.image_path });
    return { ...scan, extracted: scan.extracted_json ? JSON.parse(String(scan.extracted_json)) : null, uncertain: JSON.parse(String(scan.uncertain_json ?? '[]')), extracted_json: undefined, uncertain_json: undefined, image_path: undefined };
  });
  const notes = rawNotes.map((note) => {
    if (typeof note.audio_path === 'string' && typeof note.audio_mime === 'string') media.push({ kind: 'voice_note', recordId: String(note.id), mimeType: note.audio_mime, path: note.audio_path });
    return { ...note, audio_path: undefined };
  });
  const parseJson = (value: unknown) => { try { return JSON.parse(String(value)); } catch { return null; } };
  const data = {
    workspace: { id: workspace.id, name: workspace.name, kind: workspace.kind },
    members: await (db.prepare(`SELECT u.id AS user_id,u.name,u.email,m.role,m.status,m.created_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.created_at`).all(workspaceId)),
    events: await (db.prepare(`SELECT id,name,starts_at,ends_at,time_zone,spend_minor,is_active,created_at FROM events WHERE workspace_id=? ORDER BY starts_at`).all(workspaceId)),
    companies: await (db.prepare(`SELECT id,name,website,deal_value_minor,deal_status,archived_at,created_at FROM companies WHERE workspace_id=? ORDER BY name`).all(workspaceId)),
    products: await (db.prepare(`SELECT id,name,description,url,archived_at FROM products WHERE workspace_id=? ORDER BY name`).all(workspaceId)),
    contacts: await (db.prepare(`SELECT id,company_id,name,title,email,phone,website,quality,stage,lost_reason,do_not_contact,owner_user_id,version,archived_at,deleted_at,created_at,updated_at FROM contacts WHERE workspace_id=? ORDER BY created_at`).all(workspaceId)),
    contactProducts: await (db.prepare(`SELECT contact_id,product_id FROM contact_products WHERE workspace_id=?`).all(workspaceId)),
    scans,
    encounters: await (db.prepare(`SELECT id,contact_id,event_id,scan_id,occurred_at,summary,open_question,promised_next_step,changed_since_last FROM encounters WHERE workspace_id=? ORDER BY occurred_at`).all(workspaceId)),
    notes,
    emails: await (db.prepare(`SELECT id,contact_id,encounter_id,recipient,subject,body,status,provider_message_id,approved_at,sent_to_server_at,reply_recorded_at,sources_json,created_at FROM emails WHERE workspace_id=? ORDER BY created_at`).all(workspaceId)),
    tasks: await (db.prepare(`SELECT id,contact_id,event_id,kind,status,due_at,time_zone,title,note,snoozed_until,created_by,created_at FROM tasks WHERE workspace_id=? ORDER BY due_at`).all(workspaceId)),
    settings: (await (db.prepare(`SELECT key,value_json,updated_at FROM workspace_settings WHERE workspace_id=? ORDER BY key`).all(workspaceId)) as Array<{ key: string; value_json: string; updated_at: string }>).map((setting) => ({ key: setting.key, value: parseJson(setting.value_json), updated_at: setting.updated_at })),
    notifications: await (db.prepare(`SELECT id,user_id,kind,message,read_at,created_at FROM notifications WHERE workspace_id=? ORDER BY created_at`).all(workspaceId)),
    digestRuns: await (db.prepare(`SELECT user_id,local_date,status,last_error,sent_to_server_at,created_at FROM digest_runs WHERE workspace_id=? ORDER BY local_date`).all(workspaceId)),
    auditEvents: (await (db.prepare(`SELECT id,actor_user_id,action,target_type,target_id,details_json,created_at FROM audit_events WHERE workspace_id=? ORDER BY created_at`).all(workspaceId)) as Array<Record<string, unknown>>).map((event) => ({ ...event, details: parseJson(event.details_json), details_json: undefined })),
    invites: (await (db.prepare(`SELECT id,role,event_ids_json,expires_at,accepted_at,revoked_at,created_at FROM invites WHERE workspace_id=? ORDER BY created_at`).all(workspaceId)) as Array<Record<string, unknown>>).map((invite) => ({ ...invite, event_ids: parseJson(invite.event_ids_json), event_ids_json: undefined })),
  };
  return { data, media };
}

export async function recordWorkspaceExport(actorId: string, workspaceId: string, format: 'people_csv' | 'workspace_json') {
  const workspace = await (workspaceForActor(actorId, workspaceId));
  if (!workspace || (format === 'people_csv' && (workspace.kind !== 'company' || !['admin','manager'].includes(workspace.role))) ||
    (format === 'workspace_json' && (workspace.kind === 'company' ? workspace.role !== 'admin' : workspace.role !== 'attendee'))) {
    throw new AccessDeniedError('You do not have permission to export this workspace.');
  }
  await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'data_exported','workspace',?,?)`)
    .run(randomUUID(), workspaceId, actorId, workspaceId, JSON.stringify({ format, includesMedia: format === 'workspace_json' })));
}

export async function clearPersonalWorkspaceData(actorId: string, workspaceId: string) {
  const workspace = await (workspaceForActor(actorId, workspaceId));
  const owner = await (db.prepare(`SELECT owner_user_id FROM workspaces WHERE id=? AND kind='personal'`).get(workspaceId)) as { owner_user_id: string } | undefined;
  if (!workspace || workspace.kind !== 'personal' || workspace.role !== 'attendee' || owner?.owner_user_id !== actorId) {
    throw new AccessDeniedError('Only the owner can delete data from a private space.');
  }
  const activeJobs = Number((await (db.prepare(`SELECT COUNT(*) AS total FROM jobs WHERE workspace_id=? AND status='running'`).get(workspaceId)) as { total: number }).total);
  if (activeJobs > 0) throw new Error('A background task is finishing in this space. Wait a moment, then try deleting again.');

  const uploadsRoot = resolve(process.env.UPLOADS_PATH ?? 'uploads');
  const mediaPaths = (await (db.prepare(`SELECT image_path AS path FROM scans WHERE workspace_id=? AND image_path IS NOT NULL
    UNION ALL SELECT audio_path AS path FROM notes WHERE workspace_id=? AND audio_path IS NOT NULL`).all(workspaceId, workspaceId)) as Array<{ path: string }>).map(({ path }) => {
    const absolute = resolve(path);
    if (!absolute.startsWith(`${uploadsRoot}${sep}`)) throw new Error('A private file is outside the uploads folder. No data was deleted.');
    return absolute;
  });

  const counts = await (db.transaction(async () => {
    const count = async (table: string) => Number((await (db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE workspace_id=?`).get(workspaceId)) as { total: number }).total);
    const deleted = {
      companies: await (count('companies')), contacts: await (count('contacts')), scans: await (count('scans')), notes: await (count('notes')),
      emails: await (count('emails')), tasks: await (count('tasks')), events: await (count('events')), products: await (count('products')),
      jobs: await (count('jobs')), notifications: await (count('notifications')),
    };
    await (db.prepare(`DELETE FROM jobs WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`DELETE FROM scans WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`DELETE FROM tasks WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`DELETE FROM companies WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`DELETE FROM events WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`DELETE FROM products WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`DELETE FROM invites WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`DELETE FROM notifications WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`DELETE FROM digest_runs WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`DELETE FROM workspace_settings WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`DELETE FROM audit_events WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json)
      VALUES (?,?,?,'data_deleted','workspace',?,?)`).run(randomUUID(), workspaceId, actorId, workspaceId, JSON.stringify({ counts: deleted })));
    return deleted;
  })());
  return { mediaPaths, counts };
}

export async function clearSampleWorkspaceData(actorId: string, workspaceId: string) {
  if (process.env.NODE_ENV === 'production') throw new Error('Sample data can only be cleared in a development workspace.');
  const sampleUser = await (db.prepare(`SELECT email FROM users WHERE id=? AND disabled_at IS NULL`).get(actorId)) as { email: string } | undefined;
  const workspace = await (workspaceForActor(actorId, workspaceId));
  if (!sampleUser?.email.endsWith('@gather.test') || !workspaceId.startsWith('demo-') || !workspace ||
    (workspace.kind === 'company' ? workspace.role !== 'admin' : workspace.role !== 'attendee')) {
    throw new AccessDeniedError('Only a sample workspace admin or owner can clear sample data.');
  }
  if (workspace.kind === 'personal') {
    const owner = await (db.prepare(`SELECT owner_user_id FROM workspaces WHERE id=? AND kind='personal'`).get(workspaceId)) as { owner_user_id: string } | undefined;
    if (owner?.owner_user_id !== actorId) throw new AccessDeniedError('Only the owner can clear sample data from this private space.');
  }
  const activeJobs = Number((await (db.prepare(`SELECT COUNT(*) AS total FROM jobs WHERE workspace_id=? AND status='running'`).get(workspaceId)) as { total: number }).total);
  if (activeJobs > 0) throw new Error('A background task is finishing here. Wait a moment, then clear sample data.');

  const uploadsRoot = resolve(process.env.UPLOADS_PATH ?? 'uploads');
  const mediaPaths = (await (db.prepare(`SELECT image_path AS path FROM scans WHERE workspace_id=? AND image_path IS NOT NULL
    UNION ALL SELECT audio_path AS path FROM notes WHERE workspace_id=? AND kind='audio' AND audio_path IS NOT NULL`).all(workspaceId, workspaceId)) as Array<{ path: string }>).map(({ path }) => {
    const absolute = resolve(path);
    if (!absolute.startsWith(`${uploadsRoot}${sep}`)) throw new Error('A sample file is outside the uploads folder. No data was cleared.');
    return absolute;
  });
  const counts = await (db.transaction(async () => {
    const count = async (table: string) => Number((await (db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE workspace_id=?`).get(workspaceId)) as { total: number }).total);
    const deleted = {
      companies: await (count('companies')), contacts: await (count('contacts')), scans: await (count('scans')), notes: await (count('notes')),
      emails: await (count('emails')), tasks: await (count('tasks')), events: await (count('events')), products: await (count('products')),
      jobs: await (count('jobs')), notifications: await (count('notifications')),
    };
    await (db.prepare(`DELETE FROM jobs WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`DELETE FROM scans WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`DELETE FROM tasks WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`DELETE FROM companies WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`DELETE FROM events WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`DELETE FROM products WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`DELETE FROM invites WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`DELETE FROM notifications WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`DELETE FROM digest_runs WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`DELETE FROM workspace_settings WHERE workspace_id=?`).run(workspaceId));
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json)
      VALUES (?,?,?,'sample_data_cleared','workspace',?,?)`).run(randomUUID(), workspaceId, actorId, workspaceId, JSON.stringify({ counts: deleted })));
    return deleted;
  })());
  return { mediaPaths, counts };
}

export async function listTasks(actorId: string, workspaceId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  return await (db.prepare(`SELECT t.id,t.kind,t.status,t.due_at,t.time_zone,t.title,t.note,t.snoozed_until,c.id AS contact_id,c.name AS contact_name,c.email AS contact_email,co.name AS company_name,e.name AS event_name
    FROM tasks t JOIN contacts c ON c.id=t.contact_id AND c.workspace_id=t.workspace_id
    JOIN companies co ON co.id=c.company_id AND co.workspace_id=c.workspace_id
    LEFT JOIN events e ON e.id=t.event_id AND e.workspace_id=t.workspace_id
    WHERE t.workspace_id=? AND t.status<>'cancelled' AND (t.status<>'done' OR t.due_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')) AND c.deleted_at IS NULL AND c.archived_at IS NULL
      AND (c.owner_user_id=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id=c.workspace_id AND m.user_id=? AND m.role='admin') OR EXISTS (
        SELECT 1 FROM encounters en JOIN event_access ea ON ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id WHERE en.workspace_id=c.workspace_id AND en.contact_id=c.id AND ea.user_id=?))
      AND (t.event_id IS NULL OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=t.workspace_id AND ea.event_id=t.event_id AND ea.user_id=?))
    ORDER BY CASE WHEN t.status IN ('done','no_show') THEN 1 ELSE 0 END,t.due_at LIMIT 250`).all(workspaceId, actorId, actorId, actorId, actorId)) as Array<Record<string, unknown>>;
}

export async function getFollowUpSuggestionContext(actorId: string, workspaceId: string, contactId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  await (assertContactAccess(actorId, workspaceId, contactId));
  const contact = await (db.prepare(`SELECT c.name,c.stage,co.name AS company_name,
      (SELECT e.name FROM encounters en JOIN events e ON e.id=en.event_id AND e.workspace_id=en.workspace_id
        WHERE en.workspace_id=c.workspace_id AND en.contact_id=c.id AND en.event_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id AND ea.user_id=?)
        ORDER BY en.occurred_at DESC LIMIT 1) AS event_name
    FROM contacts c JOIN companies co ON co.id=c.company_id AND co.workspace_id=c.workspace_id
    WHERE c.workspace_id=? AND c.id=? AND c.deleted_at IS NULL AND c.archived_at IS NULL`).get(actorId, workspaceId, contactId)) as
      { name: string; stage: string; company_name: string; event_name: string | null } | undefined;
  if (!contact) throw new Error('This person is no longer available.');
  const noteAccess = await (noteScope(actorId, workspaceId));
  const notes = await (db.prepare(`SELECT CASE WHEN kind='audio' THEN transcript ELSE body END AS text FROM notes
    WHERE workspace_id=? AND contact_id=? AND ((kind='text' AND body<>'') OR (kind='audio' AND transcript<>''))
      AND ${visibleNoteSql('notes')}
    ORDER BY created_at DESC LIMIT 5`).all(workspaceId, contactId, noteAccess.all, actorId, actorId)) as Array<{ text: string }>;
  const products = await (db.prepare(`SELECT p.name FROM contact_products cp JOIN products p ON p.id=cp.product_id AND p.workspace_id=cp.workspace_id
    WHERE cp.workspace_id=? AND cp.contact_id=? AND p.archived_at IS NULL ORDER BY p.name`).all(workspaceId, contactId)) as Array<{ name: string }>;
  const activeEvent = await getCurrentEvent(actorId, workspaceId);
  const timeZone = activeEvent?.time_zone ?? 'UTC';
  return {
    firstName: contact.name.split(/\s+/)[0] || 'there', companyName: contact.company_name, eventName: contact.event_name,
    stage: contact.stage, productsOfInterest: products.map((item) => item.name), recentNotes: notes.map((item) => item.text.trim().slice(0, 500)).filter(Boolean),
    today: localDateAndTime(new Date(), timeZone).day, timeZone,
  };
}

type ReminderPreferences = { inAppEnabled: boolean; dailyDigestEnabled: boolean; digestTime: string; timeZone: string };
const defaultReminderPreferences: ReminderPreferences = { inAppEnabled: false, dailyDigestEnabled: false, digestTime: '09:00', timeZone: 'UTC' };
function readReminderPreferences(value: string): ReminderPreferences {
  try {
    const parsed = JSON.parse(value) as Partial<ReminderPreferences>;
    return {
      inAppEnabled: parsed.inAppEnabled === true,
      dailyDigestEnabled: parsed.dailyDigestEnabled === true,
      digestTime: typeof parsed.digestTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(parsed.digestTime) ? parsed.digestTime : '09:00',
      timeZone: typeof parsed.timeZone === 'string' ? parsed.timeZone : 'UTC',
    };
  } catch { return defaultReminderPreferences; }
}
function localDateAndTime(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { day: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}
type DueReminderTask = { id: string; workspace_id: string; user_id: string; contact_id: string; contact_name: string; company_name: string; title: string; due_at: string; snoozed_until: string | null; stage: string };
async function dueReminderTasks() {
  return await (db.prepare(`SELECT t.id,t.workspace_id,COALESCE(c.owner_user_id,t.created_by) AS user_id,t.contact_id,c.name AS contact_name,co.name AS company_name,t.title,t.due_at,t.snoozed_until,c.stage
    FROM tasks t JOIN contacts c ON c.id=t.contact_id AND c.workspace_id=t.workspace_id
    JOIN companies co ON co.id=c.company_id AND co.workspace_id=c.workspace_id
    JOIN memberships m ON m.workspace_id=t.workspace_id AND m.user_id=COALESCE(c.owner_user_id,t.created_by) AND m.status='active'
    WHERE t.kind='follow_up' AND t.status='open' AND c.archived_at IS NULL AND c.deleted_at IS NULL AND c.stage NOT IN ('replied','meeting','won','lost')
      AND datetime(COALESCE(t.snoozed_until,t.due_at))<=datetime('now','+1 day')
      AND (t.event_id IS NULL OR m.role='admin' OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=t.workspace_id AND ea.event_id=t.event_id AND ea.user_id=m.user_id))
    ORDER BY t.due_at LIMIT 5000`).all()) as DueReminderTask[];
}

export async function scheduleReminderWork(nowMs = Date.now()) {
  const settings = await (db.prepare(`SELECT s.workspace_id,m.user_id,s.value_json FROM workspace_settings s
    JOIN memberships m ON m.workspace_id=s.workspace_id AND m.status='active' WHERE s.key='reminders'`).all()) as Array<{ workspace_id: string; user_id: string; value_json: string }>;
  const preferences = new Map(settings.map((row) => [`${row.workspace_id}:${row.user_id}`, readReminderPreferences(row.value_json)]));
  const tasks = await (dueReminderTasks());
  const now = new Date(nowMs);
  let notificationsCreated = 0;
  let digestsQueued = 0;
  const schedule = db.transaction(async () => {
    for (const task of tasks) {
      const prefs = preferences.get(`${task.workspace_id}:${task.user_id}`);
      if (!prefs) continue;
      const effectiveAt = task.snoozed_until ?? task.due_at;
      const effectiveTime = Date.parse(effectiveAt);
      if (!Number.isFinite(effectiveTime)) continue;
      if (prefs.inAppEnabled && effectiveTime <= nowMs) {
        const id = randomUUID();
        const inserted = await (db.prepare(`INSERT OR IGNORE INTO notifications(id,workspace_id,user_id,kind,message,dedupe_key,contact_id)
          VALUES (?,?,?,'follow_up_due',?,?,?)`).run(id, task.workspace_id, task.user_id,
          `Follow up with ${task.contact_name} at ${task.company_name}.`, `task:${task.id}:${effectiveAt}`, task.contact_id));
        notificationsCreated += inserted.changes;
      }
      if (!prefs.dailyDigestEnabled) continue;
      let local: { day: string; time: string };
      try { local = localDateAndTime(now, prefs.timeZone); } catch { continue; }
      if (local.time < prefs.digestTime || localDateAndTime(new Date(effectiveTime), prefs.timeZone).day > local.day) continue;
      const jobId = randomUUID();
      const inserted = await (db.prepare(`INSERT OR IGNORE INTO digest_runs(workspace_id,user_id,local_date,status) VALUES (?,?,?,'queued')`)
        .run(task.workspace_id, task.user_id, local.day));
      if (!inserted.changes) continue;
      await (db.prepare(`INSERT INTO jobs(id,workspace_id,type,payload_json,run_at,max_attempts) VALUES (?,?, 'daily_digest', ?, ?, 5)`)
        .run(jobId, task.workspace_id, JSON.stringify({ userId: task.user_id, localDate: local.day }), now.toISOString()));
      await (db.prepare(`UPDATE digest_runs SET job_id=? WHERE workspace_id=? AND user_id=? AND local_date=?`).run(jobId, task.workspace_id, task.user_id, local.day));
      digestsQueued++;
    }
  });
  schedule();
  return { notificationsCreated, digestsQueued };
}

export async function listNotifications(actorId: string, workspaceId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const notifications = await (db.prepare(`SELECT id,kind,message,contact_id,read_at,created_at FROM notifications WHERE workspace_id=? AND user_id=? ORDER BY created_at DESC LIMIT 30`)
    .all(workspaceId, actorId)) as Array<Record<string, unknown>>;
  const unread = Number((await (db.prepare(`SELECT COUNT(*) AS total FROM notifications WHERE workspace_id=? AND user_id=? AND read_at IS NULL`).get(workspaceId, actorId)) as { total: number }).total);
  return { notifications, unread };
}

export async function markNotificationRead(actorId: string, workspaceId: string, notificationId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  return (await db.prepare(`UPDATE notifications SET read_at=COALESCE(read_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE workspace_id=? AND user_id=? AND id=?`).run(workspaceId, actorId, notificationId)).changes > 0;
}

export async function getDigestRuns(actorId: string, workspaceId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  return await (db.prepare(`SELECT local_date,status,last_error,sent_to_server_at,created_at FROM digest_runs WHERE workspace_id=? AND user_id=? ORDER BY local_date DESC LIMIT 10`)
    .all(workspaceId, actorId)) as Array<Record<string, unknown>>;
}

export async function getDailyDigestForWorker(workspaceId: string, userId: string, localDate: string) {
  const user = await (db.prepare(`SELECT u.name,u.email FROM users u JOIN memberships m ON m.user_id=u.id AND m.workspace_id=? AND m.status='active'
    WHERE u.id=? AND u.disabled_at IS NULL`).get(workspaceId, userId)) as { name: string; email: string } | undefined;
  const workspace = await (db.prepare(`SELECT name FROM workspaces WHERE id=?`).get(workspaceId)) as { name: string } | undefined;
  if (!user || !workspace) return undefined;
  const prefsRow = await (db.prepare(`SELECT value_json FROM workspace_settings WHERE workspace_id=? AND key='reminders'`).get(workspaceId)) as { value_json: string } | undefined;
  const prefs = prefsRow ? readReminderPreferences(prefsRow.value_json) : defaultReminderPreferences;
  if (!prefs.dailyDigestEnabled) return undefined;
  const tasks = await dueReminderTasks();
  const rows = tasks.filter((task) => {
    if (task.workspace_id !== workspaceId || task.user_id !== userId) return false;
    try { return localDateAndTime(new Date(task.snoozed_until ?? task.due_at), prefs.timeZone).day <= localDate; }
    catch { return false; }
  });
  return {
    recipient: user.email,
    senderName: user.name,
    subject: `Your Encore follow-ups for ${localDate}`,
    body: rows.length ? [`Here are your open follow-ups in ${workspace.name}:`, '', ...rows.map((task) => `• ${task.contact_name} at ${task.company_name} — ${task.title || 'Follow up'}`), '', 'Open Encore to review or update each next step.'].join('\n') : '',
    hasTasks: rows.length > 0,
  };
}

export async function updateDigestRun(workspaceId: string, userId: string, localDate: string, status: 'sent_to_server' | 'failed' | 'not_sent', message?: string) {
  await (db.prepare(`UPDATE digest_runs SET status=?,last_error=?,sent_to_server_at=CASE WHEN ?='sent_to_server' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE sent_to_server_at END
    WHERE workspace_id=? AND user_id=? AND local_date=?`).run(status, message ?? null, status, workspaceId, userId, localDate));
}

export async function updateDigestRunForJob(jobId: string, status: 'queued' | 'failed' | 'sent_to_server' | 'not_sent', message?: string) {
  await (db.prepare(`UPDATE digest_runs SET status=?,last_error=?,sent_to_server_at=CASE WHEN ?='sent_to_server' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE sent_to_server_at END WHERE job_id=?`)
    .run(status, message ?? null, status, jobId));
}

export async function createTask(actorId: string, workspaceId: string, contactId: string, input: { kind: 'follow_up' | 'meeting'; dueAt: string; title: string; note: string; timeZone: string; allowOverlap: boolean }) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  await (assertContactAccess(actorId, workspaceId, contactId));
  const due = new Date(input.dueAt);
  if (Number.isNaN(due.getTime())) throw new Error('Choose a date and time.');
  const event = await (getCurrentEvent(actorId, workspaceId));
  const timeZone = event?.time_zone ?? input.timeZone;
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(due); }
  catch { throw new Error('Choose a valid time zone and try again.'); }
  if (input.kind === 'meeting') {
    const conflict = await (db.prepare(`SELECT t.id,t.due_at,c.name AS contact_name FROM tasks t JOIN contacts c ON c.id=t.contact_id AND c.workspace_id=t.workspace_id
      WHERE t.workspace_id=? AND t.kind='meeting' AND t.status='confirmed' AND t.created_by=?
        AND t.due_at > ? AND t.due_at < ? AND c.deleted_at IS NULL LIMIT 1`)
      .get(workspaceId, actorId, new Date(due.getTime() - 30 * 60_000).toISOString(), new Date(due.getTime() + 30 * 60_000).toISOString())) as { id: string; due_at: string; contact_name: string } | undefined;
    if (conflict && !input.allowOverlap) return { created: false as const, conflict };
  }
  const id = randomUUID();
  const title = input.title.trim() || (input.kind === 'meeting' ? 'Meeting' : 'Follow up');
  const note = input.note.trim();
  const outcome = await (db.transaction(async () => {
    // The same person, time, kind and wording already waiting is a double click or a retry, not a second follow-up.
    const repeat = await (db.prepare(`SELECT id FROM tasks WHERE workspace_id=? AND contact_id=? AND kind=? AND due_at=? AND title=? AND note=? AND created_by=?
      AND status IN ('open','proposed','confirmed') LIMIT 1`).get(workspaceId, contactId, input.kind, due.toISOString(), title, note, actorId)) as { id: string } | undefined;
    if (repeat) return { taskId: repeat.id, duplicate: true };
    const workspaceLimit = configuredStorageLimit('TASK_COUNT_WORKSPACE_LIMIT', 25000);
    const totalLimit = configuredStorageLimit('TASK_COUNT_TOTAL_LIMIT', 100000);
    const workspaceCount = (await (db.prepare(`SELECT COUNT(*) AS total FROM tasks WHERE workspace_id=?`).get(workspaceId)) as { total: number }).total;
    const totalCount = (await (db.prepare(`SELECT COUNT(*) AS total FROM tasks`).get()) as { total: number }).total;
    if (workspaceCount >= workspaceLimit) throw new TaskStorageLimitError('workspace');
    if (totalCount >= totalLimit) throw new TaskStorageLimitError('service');
    await (db.prepare(`INSERT INTO tasks(id,workspace_id,contact_id,event_id,kind,status,due_at,time_zone,title,note,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, workspaceId, contactId, event?.id ?? null, input.kind, input.kind === 'meeting' ? 'proposed' : 'open', due.toISOString(), timeZone, title, note, actorId));
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'task_created','task',?,?)`)
      .run(randomUUID(), workspaceId, actorId, id, JSON.stringify({ kind: input.kind, dueAt: due.toISOString() })));
    return { taskId: id, duplicate: false };
  })());
  return { created: true as const, ...outcome };
}

export class TaskStorageLimitError extends Error {
  readonly code = 'task_storage_limit';
  readonly scope: 'workspace' | 'service';
  constructor(scope: 'workspace' | 'service') {
    super(scope === 'workspace'
      ? 'This space has reached its follow-up limit. Ask an admin to review older follow-ups.'
      : 'The shared service has reached its follow-up limit. Please contact an administrator.');
    this.name = 'TaskStorageLimitError';
    this.scope = scope;
  }
}

export async function updateTaskAction(actorId: string, workspaceId: string, taskId: string, action: 'done' | 'snooze_1' | 'snooze_3' | 'snooze_7' | 'confirm' | 'no_show' | 'cancel') {
  await (assertWorkspaceAccess(actorId, workspaceId));
  return await (db.transaction(async () => {
    const task = await (db.prepare(`SELECT id,contact_id,kind,status,event_id FROM tasks WHERE workspace_id=? AND id=? AND status IN ('open','confirmed','proposed')`)
      .get(workspaceId, taskId)) as { id: string; contact_id: string; kind: string; status: string; event_id: string | null } | undefined;
    if (!task || !await (contactAccessible(actorId, workspaceId, task.contact_id))) return false;
    if (task.event_id) {
      const authorized = await (db.prepare(`SELECT 1 FROM event_access WHERE workspace_id=? AND event_id=? AND user_id=?`).get(workspaceId, task.event_id, actorId));
      const admin = await (db.prepare(`SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=? AND status='active' AND role='admin'`).get(workspaceId, actorId));
      if (!authorized && !admin) return false;
    }
    if (action.startsWith('snooze_') && task.kind !== 'follow_up') return false;
    if ((action === 'confirm' || action === 'no_show') && task.kind !== 'meeting') return false;
    const transition: Record<typeof action, string> = { done: 'done', snooze_1: task.status, snooze_3: task.status, snooze_7: task.status, confirm: 'confirmed', no_show: 'no_show', cancel: 'cancelled' };
    const snoozeDays = action === 'snooze_1' ? 1 : action === 'snooze_3' ? 3 : action === 'snooze_7' ? 7 : 0;
    if (snoozeDays) await (db.prepare(`UPDATE tasks SET snoozed_until=strftime('%Y-%m-%dT09:00:00Z','now',?) WHERE workspace_id=? AND id=?`).run(`+${snoozeDays} days`, workspaceId, taskId));
    else await (db.prepare(`UPDATE tasks SET status=?,snoozed_until=NULL WHERE workspace_id=? AND id=?`).run(transition[action], workspaceId, taskId));
    if (action === 'confirm') {
      await (db.prepare(`UPDATE contacts SET stage='meeting',version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=? AND id=? AND stage NOT IN ('won','lost')`).run(workspaceId, task.contact_id));
    }
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'task_updated','task',?,?)`)
      .run(randomUUID(), workspaceId, actorId, taskId, JSON.stringify({ action })));
    return true;
  })());
}

export async function getPersonDetail(actorId: string, workspaceId: string, contactId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const person = await (db.prepare(`SELECT c.*,co.name AS company_name,co.website AS company_website,co.about AS company_about,co.deal_value_minor,co.deal_status
    FROM contacts c JOIN companies co ON co.id=c.company_id AND co.workspace_id=c.workspace_id
    WHERE c.workspace_id=? AND c.id=? AND c.deleted_at IS NULL`).get(workspaceId, contactId)) as Record<string, unknown> | undefined;
  if (!person || !await (contactAccessible(actorId, workspaceId, contactId))) return undefined;
  const noteAccess = await (noteScope(actorId, workspaceId));
  const timeline = await (db.prepare(`SELECT 'note' AS kind,n.id,CASE WHEN n.kind='audio' THEN CASE WHEN n.summary<>'' THEN n.summary WHEN n.transcript<>'' THEN n.transcript ELSE 'Voice recording — no text added.' END ELSE n.body END AS detail,n.created_at,e.name AS event_name FROM notes n
      LEFT JOIN encounters note_en ON note_en.id=n.encounter_id AND note_en.workspace_id=n.workspace_id
      LEFT JOIN events e ON e.id=note_en.event_id AND e.workspace_id=note_en.workspace_id
      WHERE n.workspace_id=? AND n.contact_id=? AND ${visibleNoteSql('n')}
        AND (note_en.event_id IS NULL OR ?=1 OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=note_en.workspace_id AND ea.event_id=note_en.event_id AND ea.user_id=?))
    UNION ALL SELECT 'encounter',en.id,COALESCE(e.name,'Conversation saved'),en.occurred_at,e.name FROM encounters en
      LEFT JOIN events e ON e.id=en.event_id AND e.workspace_id=en.workspace_id WHERE en.workspace_id=? AND en.contact_id=? AND (en.event_id IS NULL OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id AND ea.user_id=?))
    UNION ALL SELECT t.kind,t.id,COALESCE(t.title,'Follow up'),t.due_at,NULL FROM tasks t WHERE t.workspace_id=? AND t.contact_id=? AND (t.event_id IS NULL OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=t.workspace_id AND ea.event_id=t.event_id AND ea.user_id=?))
    UNION ALL SELECT 'email',m.id,m.subject,m.created_at,NULL FROM emails m WHERE m.workspace_id=? AND m.contact_id=? AND (m.encounter_id IS NULL OR EXISTS (SELECT 1 FROM encounters en JOIN event_access ea ON ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id WHERE en.workspace_id=m.workspace_id AND en.id=m.encounter_id AND ea.user_id=?))
    UNION ALL SELECT 'reply',a.id,'You marked that they replied',a.created_at,NULL FROM audit_events a WHERE a.workspace_id=? AND a.target_id=? AND a.target_type='contact' AND a.action='contact_replied'
    ORDER BY created_at DESC LIMIT 60`).all(workspaceId, contactId, noteAccess.all, actorId, actorId, noteAccess.all, actorId, workspaceId, contactId, actorId, workspaceId, contactId, actorId, workspaceId, contactId, actorId, workspaceId, contactId));
  const products = await (db.prepare(`SELECT p.id,p.name,p.description FROM contact_products cp JOIN products p ON p.id=cp.product_id AND p.workspace_id=cp.workspace_id
    WHERE cp.workspace_id=? AND cp.contact_id=? AND p.archived_at IS NULL`).all(workspaceId, contactId));
  const voiceNotes = await (db.prepare(`SELECT n.id,n.transcript,n.summary,n.duration_seconds,n.audio_mime,n.created_at FROM notes n
    LEFT JOIN encounters en ON en.workspace_id=n.workspace_id AND en.id=n.encounter_id
    WHERE n.workspace_id=? AND n.contact_id=? AND n.kind='audio' AND ${visibleNoteSql('n')}
      AND (en.event_id IS NULL OR ?=1 OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id AND ea.user_id=?))
    ORDER BY n.created_at DESC`)
    .all(workspaceId, contactId, noteAccess.all, actorId, actorId, noteAccess.all, actorId)) as Array<{ id: string; transcript: string; summary: string; duration_seconds: number | null; audio_mime: string | null; created_at: string }>;
  const conversationMemories = await db.prepare(`SELECT en.id,en.summary,en.open_question,en.promised_next_step,en.changed_since_last,en.occurred_at,e.name AS event_name
    FROM encounters en LEFT JOIN events e ON e.id=en.event_id AND e.workspace_id=en.workspace_id
    WHERE en.workspace_id=? AND en.contact_id=? AND (en.event_id IS NULL OR EXISTS (
      SELECT 1 FROM event_access ea WHERE ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id AND ea.user_id=?))
      AND (en.summary<>'' OR en.open_question<>'' OR en.promised_next_step<>'' OR en.changed_since_last<>'')
    ORDER BY en.occurred_at DESC LIMIT 20`).all(workspaceId, contactId, actorId);
  return { person, timeline, products, voiceNotes, conversationMemories };
}

export async function setPersonArchived(actorId: string, workspaceId: string, contactId: string, archived: boolean) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const workspace = await (workspaceForActor(actorId, workspaceId));
  if (!workspace) throw new Error('Workspace access changed. Choose an available space.');
  if (workspace.kind === 'personal') {
    const owner = await (db.prepare(`SELECT owner_user_id FROM workspaces WHERE id=? AND kind='personal'`).get(workspaceId)) as { owner_user_id: string } | undefined;
    if (workspace.role !== 'attendee' || owner?.owner_user_id !== actorId) throw new AccessDeniedError('Only the owner can archive or restore people in a private space.');
  }
  await (assertContactAccess(actorId, workspaceId, contactId, true));
  return await (db.transaction(async () => {
    const changed = await (db.prepare(`UPDATE contacts SET archived_at=CASE WHEN ?=1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
      version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE workspace_id=? AND id=? AND deleted_at IS NULL AND ((?=1 AND archived_at IS NULL) OR (?=0 AND archived_at IS NOT NULL))`)
      .run(archived ? 1 : 0, workspaceId, contactId, archived ? 1 : 0, archived ? 1 : 0));
    if (!changed.changes) return false;
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,?, 'contact',?,?)`)
      .run(randomUUID(), workspaceId, actorId, archived ? 'contact_archived' : 'contact_restored', contactId, JSON.stringify({ archived })));
    return true;
  })());
}

export async function deletePerson(actorId: string, workspaceId: string, contactId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const workspace = await (workspaceForActor(actorId, workspaceId));
  if (!workspace || (workspace.kind === 'company' && workspace.role !== 'admin')) throw new AccessDeniedError('Only a company admin can delete a person and their full event history.');
  await (assertContactAccess(actorId, workspaceId, contactId));
  const person = await (db.prepare(`SELECT id,company_id FROM contacts WHERE workspace_id=? AND id=? AND deleted_at IS NULL`).get(workspaceId, contactId)) as { id: string; company_id: string } | undefined;
  if (!person) return undefined;
  const busyEmail = await (db.prepare(`SELECT 1 FROM jobs j WHERE j.workspace_id=? AND j.type='email_send' AND j.status='running'
    AND EXISTS (SELECT 1 FROM emails e WHERE e.workspace_id=j.workspace_id AND e.contact_id=? AND json_extract(j.payload_json,'$.emailId')=e.id) LIMIT 1`)
    .get(workspaceId, contactId));
  const busyCardRead = await (db.prepare(`SELECT 1 FROM jobs j WHERE j.workspace_id=? AND j.type='card_read' AND j.status='running'
    AND EXISTS (SELECT 1 FROM scans s JOIN encounters en ON en.workspace_id=s.workspace_id AND en.scan_id=s.id
      WHERE s.workspace_id=j.workspace_id AND en.contact_id=? AND json_extract(j.payload_json,'$.scanId')=s.id) LIMIT 1`)
    .get(workspaceId, contactId));
  if (busyEmail || busyCardRead) throw new Error('A background task for this person is finishing. Wait a moment, then try deleting them again.');

  const uploadsRoot = resolve(process.env.UPLOADS_PATH ?? 'uploads');
  const mediaPaths = (await (db.prepare(`SELECT image_path AS path FROM scans WHERE workspace_id=? AND (contact_id=? OR id IN
      (SELECT scan_id FROM encounters WHERE workspace_id=? AND contact_id=?)) AND image_path IS NOT NULL
    UNION ALL SELECT audio_path AS path FROM notes WHERE workspace_id=? AND contact_id=? AND audio_path IS NOT NULL`)
    .all(workspaceId, contactId, workspaceId, contactId, workspaceId, contactId)) as Array<{ path: string }>).map(({ path }) => {
      const absolute = resolve(path);
      if (!absolute.startsWith(`${uploadsRoot}${sep}`)) throw new Error('A private file is outside the uploads folder. No person data was deleted.');
      return absolute;
    });

  const result = await (db.transaction(async () => {
    const ids = {
      scans: (await (db.prepare(`SELECT id FROM scans WHERE workspace_id=? AND (contact_id=? OR id IN
        (SELECT scan_id FROM encounters WHERE workspace_id=? AND contact_id=?))`).all(workspaceId, contactId, workspaceId, contactId)) as Array<{ id: string }>).map((row) => row.id),
      notes: (await (db.prepare(`SELECT id FROM notes WHERE workspace_id=? AND contact_id=?`).all(workspaceId, contactId)) as Array<{ id: string }>).map((row) => row.id),
      emails: (await (db.prepare(`SELECT id FROM emails WHERE workspace_id=? AND contact_id=?`).all(workspaceId, contactId)) as Array<{ id: string }>).map((row) => row.id),
      tasks: (await (db.prepare(`SELECT id FROM tasks WHERE workspace_id=? AND contact_id=?`).all(workspaceId, contactId)) as Array<{ id: string }>).map((row) => row.id),
    };
    const deleteAuditTargets = async (type: string, targetIds: string[]) => {
      if (!targetIds.length) return;
      const marks = targetIds.map(() => '?').join(',');
      await (db.prepare(`DELETE FROM audit_events WHERE workspace_id=? AND target_type=? AND target_id IN (${marks})`).run(workspaceId, type, ...targetIds));
    };
    await (db.prepare(`DELETE FROM jobs WHERE workspace_id=? AND type='email_send' AND EXISTS
      (SELECT 1 FROM emails e WHERE e.workspace_id=jobs.workspace_id AND e.contact_id=? AND json_extract(jobs.payload_json,'$.emailId')=e.id)`)
      .run(workspaceId, contactId));
    await (db.prepare(`DELETE FROM jobs WHERE workspace_id=? AND type='card_read' AND json_extract(payload_json,'$.scanId') IN
      (SELECT s.id FROM scans s WHERE s.workspace_id=? AND (s.contact_id=? OR s.id IN
        (SELECT scan_id FROM encounters WHERE workspace_id=? AND contact_id=?)))`).run(workspaceId, workspaceId, contactId, workspaceId, contactId));
    await (deleteAuditTargets('scan', ids.scans));
    await (deleteAuditTargets('note', ids.notes));
    await (deleteAuditTargets('email', ids.emails));
    await (deleteAuditTargets('task', ids.tasks));
    await (db.prepare(`DELETE FROM audit_events WHERE workspace_id=? AND target_type='contact' AND target_id=?`).run(workspaceId, contactId));
    await (db.prepare(`DELETE FROM scans WHERE workspace_id=? AND id IN (SELECT id FROM scans WHERE workspace_id=? AND (contact_id=? OR id IN
      (SELECT scan_id FROM encounters WHERE workspace_id=? AND contact_id=?)))`).run(workspaceId, workspaceId, contactId, workspaceId, contactId));
    await (db.prepare(`DELETE FROM tasks WHERE workspace_id=? AND contact_id=?`).run(workspaceId, contactId));
    await (db.prepare(`DELETE FROM contacts WHERE workspace_id=? AND id=?`).run(workspaceId, contactId));
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json)
      VALUES (?,?,?,'contact_deleted','contact',?,?)`).run(randomUUID(), workspaceId, actorId, contactId, JSON.stringify({ companyId: person.company_id, mediaReferences: mediaPaths.length })));
    return { scans: ids.scans.length, notes: ids.notes.length, emails: ids.emails.length, tasks: ids.tasks.length };
  })());
  return { mediaPaths, counts: result };
}

export async function addConversation(actorId: string, workspaceId: string, contactId: string, input: { eventId: string | null; body: string; clientConversationId: string; summary?: string; openQuestion?: string; promisedNextStep?: string; changedSinceLast?: string }) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  await (assertContactAccess(actorId, workspaceId, contactId));
  const body = input.body.trim();
  if (!body) throw new Error('Add what you discussed before saving this conversation.');
  if (input.eventId && !await (db.prepare(`SELECT 1 FROM event_access WHERE workspace_id=? AND event_id=? AND user_id=?`)
    .get(workspaceId, input.eventId, actorId))) throw new Error('Choose an event you can access.');
  return await (db.transaction(async () => {
    const existing = await (db.prepare(`SELECT id,contact_id,event_id FROM encounters WHERE workspace_id=? AND client_conversation_id=?`)
      .get(workspaceId, input.clientConversationId)) as { id: string; contact_id: string; event_id: string | null } | undefined;
    if (existing) {
      if (existing.contact_id !== contactId || existing.event_id !== input.eventId) throw new Error('This conversation request was already used for another person or event.');
      return { id: existing.id, duplicate: true };
    }
    const workspaceBytes = (await (db.prepare(`SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) AS total FROM notes WHERE workspace_id=? AND kind='text'`).get(workspaceId)) as { total: number }).total;
    const totalBytes = (await (db.prepare(`SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) AS total FROM notes WHERE kind='text'`).get()) as { total: number }).total;
    const workspaceCount = (await (db.prepare(`SELECT COUNT(*) AS count FROM notes WHERE workspace_id=? AND kind='text'`).get(workspaceId)) as { count: number }).count;
    const totalCount = (await (db.prepare(`SELECT COUNT(*) AS count FROM notes WHERE kind='text'`).get()) as { count: number }).count;
    const noteBytes = Buffer.byteLength(body, 'utf8');
    if (workspaceBytes + noteBytes > configuredStorageLimit('NOTE_STORAGE_WORKSPACE_LIMIT_BYTES', 16777216) || workspaceCount >= configuredStorageLimit('NOTE_COUNT_WORKSPACE_LIMIT', 100000)) throw new NoteStorageLimitError('workspace');
    if (totalBytes + noteBytes > configuredStorageLimit('NOTE_STORAGE_TOTAL_LIMIT_BYTES', 536870912) || totalCount >= configuredStorageLimit('NOTE_COUNT_TOTAL_LIMIT', 500000)) throw new NoteStorageLimitError('service');
    const id = randomUUID();
    const created = await (db.prepare(`INSERT INTO encounters(id,workspace_id,contact_id,event_id,client_conversation_id,summary,open_question,promised_next_step,changed_since_last) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
      .run(id, workspaceId, contactId, input.eventId, input.clientConversationId, input.summary?.trim() ?? '', input.openQuestion?.trim() ?? '', input.promisedNextStep?.trim() ?? '', input.changedSinceLast?.trim() ?? ''));
    if (!created.changes) {
      const raced = await (db.prepare(`SELECT id,contact_id,event_id FROM encounters WHERE workspace_id=? AND client_conversation_id=?`)
        .get(workspaceId, input.clientConversationId)) as { id: string; contact_id: string; event_id: string | null } | undefined;
      if (!raced || raced.contact_id !== contactId || raced.event_id !== input.eventId) throw new Error('This conversation request was already used for another person or event.');
      return { id: raced.id, duplicate: true };
    }
    await (db.prepare(`INSERT INTO notes(id,workspace_id,contact_id,encounter_id,created_by,kind,body) VALUES (?,?,?,?,?,'text',?)`)
      .run(randomUUID(), workspaceId, contactId, id, actorId, body));
    await (db.prepare(`UPDATE contacts SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1 WHERE id=? AND workspace_id=?`).run(contactId, workspaceId));
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'conversation_added','contact',?,?)`)
      .run(randomUUID(), workspaceId, actorId, contactId, JSON.stringify({ eventId: input.eventId, encounterId: id })));
    return { id, duplicate: false };
  })());
}

export async function updateConversationMemory(actorId: string, workspaceId: string, contactId: string, encounterId: string, memory: { summary: string; openQuestion: string; promisedNextStep: string; changedSinceLast: string }) {
  await assertWorkspaceAccess(actorId, workspaceId);
  await assertContactAccess(actorId, workspaceId, contactId);
  return db.transaction(async () => {
    const changed = await db.prepare(`UPDATE encounters SET summary=?,open_question=?,promised_next_step=?,changed_since_last=?
      WHERE workspace_id=? AND contact_id=? AND id=? AND (event_id IS NULL OR EXISTS (
        SELECT 1 FROM event_access ea WHERE ea.workspace_id=encounters.workspace_id AND ea.event_id=encounters.event_id AND ea.user_id=?))`)
      .run(memory.summary.trim(), memory.openQuestion.trim(), memory.promisedNextStep.trim(), memory.changedSinceLast.trim(), workspaceId, contactId, encounterId, actorId);
    if (!changed.changes) return false;
    await db.prepare(`UPDATE contacts SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1 WHERE workspace_id=? AND id=?`).run(workspaceId, contactId);
    await db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'conversation_context_updated','encounter',?,?)`)
      .run(randomUUID(), workspaceId, actorId, encounterId, JSON.stringify({ contactId }));
    return true;
  })();
}

export async function addPersonNote(actorId: string, workspaceId: string, contactId: string, body: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  await (assertContactAccess(actorId, workspaceId, contactId));
  const id = randomUUID();
  return await (db.transaction(async () => {
    // The same text for the same person from the same author a moment ago is a double click or a retry.
    const repeat = await (db.prepare(`SELECT id FROM notes WHERE workspace_id=? AND contact_id=? AND created_by=? AND kind='text' AND body=? AND created_at>=? LIMIT 1`)
      .get(workspaceId, contactId, actorId, body.trim(), new Date(Date.now() - 15_000).toISOString())) as { id: string } | undefined;
    if (repeat) return { duplicate: true };
    const workspaceBytes = (await (db.prepare(`SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) AS total FROM notes WHERE workspace_id=? AND kind='text'`).get(workspaceId)) as { total: number }).total;
    const totalBytes = (await (db.prepare(`SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) AS total FROM notes WHERE kind='text'`).get()) as { total: number }).total;
    const workspaceCount = (await (db.prepare(`SELECT COUNT(*) AS count FROM notes WHERE workspace_id=? AND kind='text'`).get(workspaceId)) as { count: number }).count;
    const totalCount = (await (db.prepare(`SELECT COUNT(*) AS count FROM notes WHERE kind='text'`).get()) as { count: number }).count;
    const workspaceByteLimit = configuredStorageLimit('NOTE_STORAGE_WORKSPACE_LIMIT_BYTES', 16777216);
    const totalByteLimit = configuredStorageLimit('NOTE_STORAGE_TOTAL_LIMIT_BYTES', 536870912);
    const workspaceCountLimit = configuredStorageLimit('NOTE_COUNT_WORKSPACE_LIMIT', 100000);
    const totalCountLimit = configuredStorageLimit('NOTE_COUNT_TOTAL_LIMIT', 500000);
    const noteBytes = Buffer.byteLength(body.trim(), 'utf8');
    if (workspaceBytes + noteBytes > workspaceByteLimit || workspaceCount >= workspaceCountLimit) throw new NoteStorageLimitError('workspace');
    if (totalBytes + noteBytes > totalByteLimit || totalCount >= totalCountLimit) throw new NoteStorageLimitError('service');
    await (db.prepare(`INSERT INTO notes(id,workspace_id,contact_id,encounter_id,created_by,kind,body) VALUES (?,?,?,?,?,'text',?)`)
      .run(id, workspaceId, contactId, await (noteEncounter(actorId, workspaceId, contactId)), actorId, body.trim()));
    await (db.prepare(`UPDATE contacts SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1 WHERE id=? AND workspace_id=?`).run(contactId, workspaceId));
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id) VALUES (?,?,?,'note_added','contact',?)`).run(randomUUID(), workspaceId, actorId, contactId));
    return { duplicate: false };
  })());
}

export class NoteStorageLimitError extends Error {
  readonly code = 'note_storage_limit';
  readonly scope: 'workspace' | 'service';
  constructor(scope: 'workspace' | 'service') {
    super(scope === 'workspace'
      ? 'This space has reached its saved-note limit. Remove an older note or ask an admin for help.'
      : 'The shared service has reached its saved-note limit. Please contact an administrator.');
    this.name = 'NoteStorageLimitError';
    this.scope = scope;
  }
}

export async function addVoiceNote(actorId: string, workspaceId: string, contactId: string, audioPath: string, audioMime: string, durationSeconds: number, audioBytes: number, id = randomUUID(), encounterId?: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  await (assertContactAccess(actorId, workspaceId, contactId));
  if (encounterId && !await (db.prepare(`SELECT 1 FROM encounters en WHERE en.workspace_id=? AND en.contact_id=? AND en.id=?
    AND (en.event_id IS NULL OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id AND ea.user_id=?))`)
    .get(workspaceId, contactId, encounterId, actorId))) throw new Error('That conversation is no longer available to you.');
  await (db.transaction(async () => {
    const storedBytes = await (db.prepare(`SELECT COALESCE(SUM(audio_bytes),0) AS total FROM notes WHERE workspace_id=? AND kind='audio'`).get(workspaceId)) as { total: number };
    const workspaceLimit = configuredStorageLimit('VOICE_STORAGE_WORKSPACE_LIMIT_BYTES', 268435456);
    const totalBytes = await (db.prepare(`SELECT COALESCE(SUM(audio_bytes),0) AS total FROM notes WHERE kind='audio'`).get()) as { total: number };
    const totalLimit = configuredStorageLimit('VOICE_STORAGE_TOTAL_LIMIT_BYTES', 5368709120);
    if (storedBytes.total + audioBytes > workspaceLimit) throw new VoiceStorageLimitError('workspace');
    if (totalBytes.total + audioBytes > totalLimit) throw new VoiceStorageLimitError('service');
    const workspaceCreated = (await (db.prepare(`SELECT created_count FROM voice_note_usage WHERE scope_id=?`).get(workspaceId)) as { created_count: number } | undefined)?.created_count ?? 0;
    const serviceCreated = (await (db.prepare(`SELECT created_count FROM voice_note_usage WHERE scope_id='__service__'`).get()) as { created_count: number } | undefined)?.created_count ?? 0;
    const workspaceCountLimit = configuredStorageLimit('VOICE_NOTE_COUNT_WORKSPACE_LIMIT', 25000);
    const serviceCountLimit = configuredStorageLimit('VOICE_NOTE_COUNT_TOTAL_LIMIT', 100000);
    if (workspaceCreated >= workspaceCountLimit || serviceCreated >= serviceCountLimit) throw new VoiceStorageLimitError(workspaceCreated >= workspaceCountLimit ? 'workspace' : 'service');
    await (db.prepare(`INSERT INTO notes(id,workspace_id,contact_id,encounter_id,created_by,kind,transcript_status,audio_path,audio_mime,duration_seconds,audio_bytes) VALUES (?,?,?,?,?,'audio','manual',?,?,?,?)`)
      .run(id, workspaceId, contactId, encounterId ?? await (noteEncounter(actorId, workspaceId, contactId)), actorId, audioPath, audioMime, durationSeconds, audioBytes));
    await (db.prepare(`INSERT INTO voice_note_usage(scope_id,created_count) VALUES (?,1) ON CONFLICT(scope_id) DO UPDATE SET created_count=created_count+1`).run(workspaceId));
    await (db.prepare(`UPDATE voice_note_usage SET created_count=created_count+1 WHERE scope_id='__service__'`).run());
    await (db.prepare(`UPDATE contacts SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=? AND id=?`).run(workspaceId, contactId));
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id) VALUES (?,?,?,'voice_note_added','contact',?)`).run(randomUUID(), workspaceId, actorId, contactId));
  })());
  return id;
}

export class VoiceStorageLimitError extends Error {
  readonly code = 'voice_storage_limit';
  readonly scope: 'workspace' | 'service';
  constructor(scope: 'workspace' | 'service') {
    super(scope === 'workspace'
      ? 'This space has reached its voice-note limit. Remove older recordings or ask your admin for help.'
      : 'The shared service has reached its voice-note limit. Please contact an administrator.');
    this.name = 'VoiceStorageLimitError';
    this.scope = scope;
  }
}

export async function setVoiceNoteText(actorId: string, workspaceId: string, noteId: string, transcript: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const note = await (db.prepare(`SELECT contact_id FROM notes WHERE workspace_id=? AND id=? AND kind='audio'`).get(workspaceId, noteId)) as { contact_id: string } | undefined;
  if (!note || !await (noteVisible(actorId, workspaceId, noteId, true))) return false;
  const text = transcript.trim();
  return await (db.transaction(async () => {
    const current = await (db.prepare(`SELECT transcript FROM notes WHERE workspace_id=? AND id=? AND kind='audio'`).get(workspaceId, noteId)) as { transcript: string } | undefined;
    if (!current) return false;
    const currentBytes = Buffer.byteLength(current.transcript, 'utf8');
    const nextBytes = Buffer.byteLength(text, 'utf8');
    const workspaceBytes = (await (db.prepare(`SELECT COALESCE(SUM(length(CAST(transcript AS BLOB))),0) AS total FROM notes WHERE workspace_id=? AND kind='audio'`).get(workspaceId)) as { total: number }).total;
    const totalBytes = (await (db.prepare(`SELECT COALESCE(SUM(length(CAST(transcript AS BLOB))),0) AS total FROM notes WHERE kind='audio'`).get()) as { total: number }).total;
    const workspaceLimit = configuredStorageLimit('VOICE_TRANSCRIPT_WORKSPACE_LIMIT_BYTES', 16777216);
    const totalLimit = configuredStorageLimit('VOICE_TRANSCRIPT_TOTAL_LIMIT_BYTES', 536870912);
    if (workspaceBytes - currentBytes + nextBytes > workspaceLimit || totalBytes - currentBytes + nextBytes > totalLimit) {
      throw new VoiceStorageLimitError(workspaceBytes - currentBytes + nextBytes > workspaceLimit ? 'workspace' : 'service');
    }
    const changed = await (db.prepare(`UPDATE notes SET transcript=?,summary='',transcript_status='manual' WHERE workspace_id=? AND id=? AND kind='audio' AND contact_id IN (SELECT id FROM contacts WHERE workspace_id=? AND deleted_at IS NULL)`)
      .run(text, workspaceId, noteId, workspaceId));
    if (changed.changes) await (db.prepare(`UPDATE contacts SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=? AND id=(SELECT contact_id FROM notes WHERE id=? AND workspace_id=?)`).run(workspaceId, noteId, workspaceId));
    return changed.changes > 0;
  })());
}

export async function setVoiceNoteSummary(actorId: string, workspaceId: string, noteId: string, summary: string) {
  await assertWorkspaceAccess(actorId, workspaceId);
  if (!await noteVisible(actorId, workspaceId, noteId, true)) return false;
  return await db.transaction(async () => {
    const changed = await db.prepare(`UPDATE notes SET summary=? WHERE workspace_id=? AND id=? AND kind='audio' AND transcript<>''
      AND contact_id IN (SELECT id FROM contacts WHERE workspace_id=? AND deleted_at IS NULL)`)
      .run(summary.trim(), workspaceId, noteId, workspaceId);
    if (!changed.changes) return false;
    await db.prepare(`UPDATE contacts SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=? AND id=(SELECT contact_id FROM notes WHERE id=? AND workspace_id=?)`).run(workspaceId, noteId, workspaceId);
    await db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id) VALUES (?,?,?,'voice_summary_saved','note',?)`).run(randomUUID(), workspaceId, actorId, noteId);
    return true;
  })();
}

export async function getVoiceNote(actorId: string, workspaceId: string, noteId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const note = await (db.prepare(`SELECT audio_path,audio_mime,contact_id,transcript,summary FROM notes WHERE workspace_id=? AND id=? AND kind='audio' AND contact_id IN (SELECT id FROM contacts WHERE workspace_id=? AND deleted_at IS NULL)`)
    .get(workspaceId, noteId, workspaceId)) as { audio_path: string; audio_mime: string; contact_id: string; transcript: string; summary: string } | undefined;
  return note && await (noteVisible(actorId, workspaceId, noteId)) ? note : undefined;
}

export async function deleteVoiceNote(actorId: string, workspaceId: string, noteId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const note = await (db.prepare(`SELECT audio_path,contact_id FROM notes WHERE workspace_id=? AND id=? AND kind='audio' AND contact_id IN (SELECT id FROM contacts WHERE workspace_id=? AND deleted_at IS NULL)`)
    .get(workspaceId, noteId, workspaceId)) as { audio_path: string | null; contact_id: string } | undefined;
  if (!note || !await (noteVisible(actorId, workspaceId, noteId, true))) return undefined;
  await (db.transaction(async () => {
    await (db.prepare(`DELETE FROM notes WHERE workspace_id=? AND id=? AND kind='audio'`).run(workspaceId, noteId));
    await (db.prepare(`UPDATE contacts SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=? AND id=?`).run(workspaceId, note.contact_id));
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id) VALUES (?,?,?,'voice_note_deleted','contact',?)`).run(randomUUID(), workspaceId, actorId, note.contact_id));
  })());
  return note.audio_path;
}

export async function updatePersonStage(actorId: string, workspaceId: string, contactId: string, stage: string, version: number, lostReason = '') {
  await (assertWorkspaceAccess(actorId, workspaceId));
  await (assertContactAccess(actorId, workspaceId, contactId));
  if (stage === 'lost' && !lostReason.trim()) return false;
  return await (db.transaction(async () => {
    const result = await (db.prepare(`UPDATE contacts SET stage=?,lost_reason=?,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE workspace_id=? AND id=? AND version=? AND deleted_at IS NULL AND archived_at IS NULL`).run(stage, stage === 'lost' ? lostReason.trim() : null, workspaceId, contactId, version));
    if (!result.changes) return false;
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'stage_changed','contact',?,?)`)
      .run(randomUUID(), workspaceId, actorId, contactId, JSON.stringify({ stage, ...(stage === 'lost' ? { lostReason: lostReason.trim() } : {}) })));
    return true;
  })());
}

export async function updatePersonDetails(actorId: string, workspaceId: string, contactId: string, version: number, input: { name: string; title: string; email: string; phone: string; website: string }) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  await (assertContactAccess(actorId, workspaceId, contactId));
  const name = input.name.trim();
  const title = input.title.trim();
  const email = input.email.trim().toLowerCase();
  const phone = input.phone.trim();
  const website = input.website.trim();
  const phoneNormalized = phone.replace(/[^+\d]/g, '');
  if (!name || (!email && !phoneNormalized)) throw new Error('Add a name and an email address or phone number.');
  const duplicate = await (db.prepare(`SELECT id FROM contacts WHERE workspace_id=? AND id<>? AND deleted_at IS NULL AND archived_at IS NULL
    AND ((?<>'' AND email_normalized=?) OR (?<>'' AND phone_normalized=?)) LIMIT 1`)
    .get(workspaceId, contactId, email, email, phoneNormalized, phoneNormalized));
  if (duplicate) throw new Error('Another person already has this email or phone. Check their record before changing this one.');
  return await (db.transaction(async () => {
    const changed = await (db.prepare(`UPDATE contacts SET name=?,title=?,email=?,email_normalized=?,phone=?,phone_normalized=?,website=?,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE workspace_id=? AND id=? AND version=? AND deleted_at IS NULL AND archived_at IS NULL`)
      .run(name, title, email, email, phone, phoneNormalized, website, workspaceId, contactId, version));
    if (!changed.changes) return false;
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'contact_updated','contact',?,?)`)
      .run(randomUUID(), workspaceId, actorId, contactId, JSON.stringify({ fields: ['name','title','email','phone','website'] })));
    return true;
  })());
}

export async function markContactReplied(actorId: string, workspaceId: string, contactId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  await (assertContactAccess(actorId, workspaceId, contactId));
  return await (db.transaction(async () => {
    const contact = await (db.prepare(`SELECT stage,lost_reason FROM contacts WHERE workspace_id=? AND id=? AND deleted_at IS NULL AND archived_at IS NULL`)
      .get(workspaceId, contactId)) as { stage: string; lost_reason: string | null } | undefined;
    if (!contact) return false;

    const latestSentEmail = await (db.prepare(`SELECT m.id FROM emails m
      JOIN contacts c ON c.workspace_id=m.workspace_id AND c.id=m.contact_id
      JOIN memberships ms ON ms.workspace_id=m.workspace_id AND ms.user_id=? AND ms.status='active'
      LEFT JOIN encounters linked ON linked.workspace_id=m.workspace_id AND linked.id=m.encounter_id
      WHERE m.workspace_id=? AND m.contact_id=? AND m.status='sent' AND c.deleted_at IS NULL AND c.archived_at IS NULL
        AND ${emailAccessSql()} ORDER BY m.sent_to_server_at DESC LIMIT 1`)
      .get(actorId, workspaceId, contactId, actorId, actorId, actorId)) as { id: string } | undefined;
    const contactChanged = contact.stage !== 'replied' || contact.lost_reason !== null;
    if (!contactChanged && !latestSentEmail) return true;

    if (contactChanged) {
      await (db.prepare(`UPDATE contacts SET stage='replied',lost_reason=NULL,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE workspace_id=? AND id=? AND deleted_at IS NULL AND archived_at IS NULL`).run(workspaceId, contactId));
    }
    if (latestSentEmail) {
      await (db.prepare(`UPDATE emails SET status='replied',reply_recorded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=? AND contact_id=? AND id=? AND status='sent'`)
        .run(workspaceId, contactId, latestSentEmail.id));
    }
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id) VALUES (?,?,?,'contact_replied','contact',?)`)
      .run(randomUUID(), workspaceId, actorId, contactId));
    return true;
  })());
}

async function buildEmailSuggestion(actorId: string, workspaceId: string, contactId: string, variant: 'first' | 'alternate' = 'first') {
  await (assertWorkspaceAccess(actorId, workspaceId));
  await (assertContactAccess(actorId, workspaceId, contactId));
  const contact = await (db.prepare(`SELECT c.id,c.name,c.title,c.email,c.do_not_contact,co.name AS company_name,co.website AS company_website,co.about AS company_about,e.name AS event_name,en.id AS encounter_id
    FROM contacts c JOIN companies co ON co.id=c.company_id AND co.workspace_id=c.workspace_id
    LEFT JOIN encounters en ON en.contact_id=c.id AND en.workspace_id=c.workspace_id
      AND (en.event_id IS NULL OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id AND ea.user_id=?))
    LEFT JOIN events e ON e.id=en.event_id AND e.workspace_id=en.workspace_id
    WHERE c.workspace_id=? AND c.id=? AND c.deleted_at IS NULL AND c.archived_at IS NULL
    ORDER BY en.occurred_at DESC LIMIT 1`).get(actorId, workspaceId, contactId)) as { id: string; name: string; title: string; email: string; do_not_contact: number; company_name: string; company_website: string | null; company_about: string; event_name: string | null; encounter_id: string | null } | undefined;
  if (!contact) throw new Error('This person is no longer available.');
  if (contact.do_not_contact) throw new Error('This person has asked not to receive follow-up email.');
  if (!contact.email) throw new Error('Add an email address before creating a draft.');
  const workspace = await (workspaceForActor(actorId, workspaceId));
  const profile = await (getWorkspaceSetting(actorId, workspaceId, workspace?.kind === 'personal' ? 'aboutMe' : 'knowledge'));
  const settings = profile && typeof profile === 'object' && !Array.isArray(profile) ? profile as Record<string, unknown> : {};
  const tone = settings.tone === 'Professional' || settings.tone === 'Short' ? settings.tone : 'Friendly';
  const productsText = typeof settings.productsText === 'string' ? settings.productsText.slice(0, 2000) : '';
  const productNames = [...new Set(productsText.split(/\r?\n/).map((line) => line.split(/[—–-]/, 1)[0]?.trim()).filter((name): name is string => Boolean(name)).map((name) => name.slice(0, 100)))].slice(0, 6);
  const whatYouSell = typeof settings.whatYouSell === 'string' ? settings.whatYouSell.trim().slice(0, 500) : '';
  const lookingFor = typeof settings.lookingFor === 'string' ? settings.lookingFor.trim().slice(0, 200) : '';
  const senderRole = typeof settings.ourRole === 'string' ? settings.ourRole.trim().slice(0, 240) : typeof settings.role === 'string' ? settings.role.trim().slice(0, 100) : '';
  const senderOrganization = workspace?.kind === 'personal' && typeof settings.company === 'string' && settings.company.trim() ? settings.company.trim().slice(0, 120) : workspace?.name ?? '';
  const profileSignature = typeof settings.signature === 'string' ? settings.signature.trim().slice(0, 600) : '';
  const noteAccess = await (noteScope(actorId, workspaceId));
  const recentConversations = await (db.prepare(`SELECT n.created_at AS date,n.kind,e.name AS event_name,en.id AS encounter_id,
      en.summary,en.open_question,en.promised_next_step,en.changed_since_last,
      CASE WHEN n.kind='audio' THEN n.transcript ELSE n.body END AS text
    FROM notes n LEFT JOIN encounters en ON en.workspace_id=n.workspace_id AND en.id=n.encounter_id
    LEFT JOIN events e ON e.workspace_id=en.workspace_id AND e.id=en.event_id
    WHERE n.workspace_id=? AND n.contact_id=? AND ((n.kind='text' AND n.body<>'') OR (n.kind='audio' AND n.transcript<>''))
      AND ${visibleNoteSql('n')}
      AND (en.event_id IS NULL OR ?=1 OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id AND ea.user_id=?))
    ORDER BY n.created_at DESC,n.id DESC LIMIT 6`).all(workspaceId, contactId, noteAccess.all, actorId, actorId, noteAccess.all, actorId)) as Array<{ date: string; kind: 'audio' | 'text'; event_name: string | null; encounter_id: string | null; text: string; summary: string | null; open_question: string | null; promised_next_step: string | null; changed_since_last: string | null }>;
  const latest = recentConversations[0];
  const emailEventName = recentConversations.length ? recentConversations[0].event_name : contact.event_name;
  const emailEncounterId = recentConversations.length ? recentConversations[0].encounter_id : contact.encounter_id;
  const interestedProducts = await (db.prepare(`SELECT p.name FROM contact_products cp JOIN products p ON p.id=cp.product_id AND p.workspace_id=cp.workspace_id
    WHERE cp.workspace_id=? AND cp.contact_id=? AND p.archived_at IS NULL ORDER BY p.name`).all(workspaceId, contactId)) as Array<{ name: string }>;
  const interestedProductNames = interestedProducts.map((product) => product.name);
  const greeting = contact.name.split(/\s+/)[0] || 'there';
  const requestedWrittenFollowUp = /\b(?:official|formal) email\b|\bfollow[ -]?up (?:email|message)\b/i.test(latest?.text || '');
  // A checked summary is strongest. With only a rough note, quote only a
  // narrow request phrase; never turn a team instruction into a client promise.
  const roughRequest = latest?.text.match(/\basked (?:for|about|whether)\s+([^.;!?\n]{5,140})/i)?.[1]?.trim() ?? '';
  const safeRoughRequest = /\b(?:send|promise|offer|agree|paid|payment|accepted|confirmed)\b/i.test(roughRequest) ? '' : roughRequest;
  const checkedTopic = latest?.summary?.match(/\b(?:needs|wants|asked for|interested in)\s+([^.;!?\n]{5,140})/i)?.[1]?.trim() ?? '';
  const relevantPoint = (checkedTopic || safeRoughRequest).slice(0, 180);
  const { subject, body } = composeTemplateEmail({
    firstName: greeting, tone, variant, eventName: emailEventName, topic: relevantPoint,
    productsOfInterest: interestedProductNames, requestedWrittenFollowUp,
    signature: profileSignature || await (getActorName(actorId)),
  });
  const sourcesUsed = [
    ...(emailEventName ? [{ label: 'Event', excerpt: emailEventName }] : []),
    ...recentConversations.slice(0, 3).map((item, index) => ({ label: `${index === 0 ? 'Latest' : 'Earlier'} ${item.kind === 'audio' ? 'checked voice transcript' : 'conversation'}${item.event_name ? ` · ${item.event_name}` : ''}`, excerpt: item.text.trim().slice(0, 180) })),
    ...(latest?.open_question ? [{ label: 'Open question', excerpt: latest.open_question.slice(0, 180) }] : []),
    ...(latest?.promised_next_step ? [{ label: 'Agreed next step', excerpt: latest.promised_next_step.slice(0, 180) }] : []),
    ...(latest?.changed_since_last ? [{ label: 'What changed', excerpt: latest.changed_since_last.slice(0, 180) }] : []),
    ...(interestedProductNames.length ? [{ label: 'Products of interest', excerpt: interestedProductNames.join(', ') }] : []),
    ...(productNames.length ? [{ label: 'Your product list', excerpt: productNames.join(', ') }] : whatYouSell ? [{ label: 'What you sell', excerpt: whatYouSell.slice(0, 180) }] : []),
    ...(senderRole ? [{ label: 'Your role', excerpt: senderRole }] : []),
    ...(lookingFor ? [{ label: 'About me', excerpt: lookingFor }] : []),
  ];
  return {
    recipient: contact.email, subject, body, sourcesUsed, encounterId: emailEncounterId,
    aiContext: {
      firstName: greeting, companyName: contact.company_name, eventName: emailEventName,
      senderWebsite: typeof settings.website === 'string' ? settings.website.trim().slice(0, 200) : '',
      contactTitle: (contact.title || '').slice(0, 120), companyWebsite: (contact.company_website || '').slice(0, 200), companyAbout: (contact.company_about || '').slice(0, 400),
      senderOrganization, senderRole, senderOfferings: whatYouSell, senderGoal: lookingFor,
      productsOfInterest: interestedProductNames, companyProducts: productNames,
      recentConversations: recentConversations.slice(0, 4).map((item) => ({ date: item.date, eventName: item.event_name, sourceType: item.kind === 'audio' ? 'voice' as const : 'text' as const, rawNote: item.text.trim().slice(0, 600), checkedSummary: (item.summary || '').trim().slice(0, 500), openQuestion: (item.open_question || '').trim().slice(0, 300), promisedNextStep: (item.promised_next_step || '').trim().slice(0, 300), changedSinceLast: (item.changed_since_last || '').trim().slice(0, 300) })),
      tone: tone as 'Friendly' | 'Professional' | 'Short',
      signature: profileSignature || await (getActorName(actorId)),
      neverPromise: typeof settings.neverPromise === 'string' ? settings.neverPromise.trim().slice(0, 500) : '',
    },
  };
}

export async function getEmailDraftSuggestion(actorId: string, workspaceId: string, contactId: string) {
  const { aiContext, encounterId: _encounterId, ...suggestion } = await (buildEmailSuggestion(actorId, workspaceId, contactId));
  return { ...suggestion, aiContext };
}

export async function createEmailDraft(actorId: string, workspaceId: string, contactId: string, generated?: { subject: string; body: string }) {
  const suggestion = await (buildEmailSuggestion(actorId, workspaceId, contactId));
  const draft = generated ? { ...suggestion, subject: generated.subject, body: generated.body } : suggestion;
  let id: string = randomUUID();
  let reused: { subject: string; body: string } | null = null;
  await (db.transaction(async () => {
    // Asking again for the same person and conversation while a draft is still open (a double click, a retry)
    // opens that draft, with any edits already made, instead of piling up copies.
    if (!generated) {
      const open = await (db.prepare(`SELECT id,subject,body FROM emails WHERE workspace_id=? AND contact_id=? AND created_by=? AND status='draft'
        AND ${draft.encounterId ? 'encounter_id=?' : 'encounter_id IS NULL'} ORDER BY created_at DESC LIMIT 1`)
        .get(workspaceId, contactId, actorId, ...(draft.encounterId ? [draft.encounterId] : []))) as { id: string; subject: string; body: string } | undefined;
      if (open) { id = open.id; reused = { subject: open.subject, body: open.body }; return; }
    }
    await (db.prepare(`INSERT INTO emails(id,workspace_id,contact_id,encounter_id,recipient,subject,body,status,created_by,sources_json) VALUES (?,?,?,?,?,?,?,'draft',?,?)`)
      .run(id, workspaceId, contactId, draft.encounterId, draft.recipient, draft.subject, draft.body, actorId, JSON.stringify(draft.sourcesUsed)));
  })());
  const { aiContext: _aiContext, encounterId: _encounterId, ...suggestedDraft } = draft;
  const publicDraft = reused ? { ...suggestedDraft, ...(reused as { subject: string; body: string }) } : suggestedDraft;
  const aiConfigured = isGroqEmailEnabled() || process.env.AI_MODE === 'provider' && (process.env.AI_PROVIDER === 'gemini' ? Boolean(process.env.GEMINI_API_KEY?.trim()) : (process.env.AI_PROVIDER || 'anthropic') === 'anthropic' && Boolean(process.env.ANTHROPIC_API_KEY?.trim()));
  let generation: 'ai' | 'fallback' | 'template' | 'pending' = generated ? 'ai' : aiConfigured ? 'fallback' : 'template';
  if (reused) {
    const job = await (db.prepare(`SELECT status FROM jobs WHERE workspace_id=? AND type='email_draft' AND json_extract(payload_json,'$.emailId')=? ORDER BY created_at DESC LIMIT 1`)
      .get(workspaceId, id)) as { status: string } | undefined;
    generation = job ? job.status === 'succeeded' ? 'ai' : job.status === 'failed' ? 'fallback' : 'pending' : 'template';
  }
  return { id, ...publicDraft, generation, status: 'draft' as const, reused: reused !== null };
}

// Keep model latency out of capture and conversation saves. The job only carries
// identifiers and a hash of the starting text; it never stores a second copy of
// the contact's conversation in its payload.
export async function queueEmailDraftImprovement(workspaceId: string, emailId: string, subject: string, body: string) {
  const originalHash = createHash('sha256').update(`${subject}\u0000${body}`).digest('hex');
  await db.prepare(`INSERT INTO jobs(id,workspace_id,type,payload_json,run_at,max_attempts) VALUES (?,?, 'email_draft', ?, ?, 2)`)
    .run(randomUUID(), workspaceId, JSON.stringify({ emailId, originalHash }), new Date().toISOString());
}

export async function getEmailDraftForWorker(workspaceId: string, emailId: string) {
  return await db.prepare(`SELECT id,created_by,contact_id,subject,body,status FROM emails WHERE workspace_id=? AND id=?`)
    .get(workspaceId, emailId) as { id: string; created_by: string; contact_id: string; subject: string; body: string; status: string } | undefined;
}

export async function applyEmailDraftImprovement(workspaceId: string, emailId: string, jobId: string, originalHash: string, subject: string, body: string) {
  const original = await getEmailDraftForWorker(workspaceId, emailId);
  if (!original || original.status !== 'draft' || createHash('sha256').update(`${original.subject}\u0000${original.body}`).digest('hex') !== originalHash) return false;
  const changed = await db.prepare(`UPDATE emails SET subject=?,body=? WHERE workspace_id=? AND id=? AND status='draft' AND subject=? AND body=?
    AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND workspace_id=? AND type='email_draft' AND status='running')`)
    .run(subject, body, workspaceId, emailId, original.subject, original.body, jobId, workspaceId);
  return changed.changes > 0;
}

export class EmailSendRateLimitError extends Error {
  readonly retryAfterSeconds = 3600;
  constructor() {
    super('Too many emails were queued. Wait an hour before sending or retrying more.');
    this.name = 'EmailSendRateLimitError';
  }
}

async function recordEmailSendAllowance(actorId: string, workspaceId: string) {
  await (db.prepare(`DELETE FROM email_send_limits WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')`).run());
  const actorCount = (await (db.prepare(`SELECT COUNT(*) AS count FROM email_send_limits WHERE actor_user_id=? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')`)
    .get(actorId)) as { count: number }).count;
  const workspaceCount = (await (db.prepare(`SELECT COUNT(*) AS count FROM email_send_limits WHERE workspace_id=? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')`)
    .get(workspaceId)) as { count: number }).count;
  if (actorCount >= 20 || workspaceCount >= 100) throw new EmailSendRateLimitError();
  await (db.prepare(`INSERT INTO email_send_limits(id,workspace_id,actor_user_id) VALUES (?,?,?)`).run(randomUUID(), workspaceId, actorId));
}

export async function getAlternateEmailDraftSuggestion(actorId: string, workspaceId: string, emailId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const existing = await (db.prepare(`SELECT contact_id FROM emails WHERE workspace_id=? AND id=? AND status='draft'`)
    .get(workspaceId, emailId)) as { contact_id: string } | undefined;
  if (!existing || !await (emailAccessible(actorId, workspaceId, emailId))) return undefined;
  return buildEmailSuggestion(actorId, workspaceId, existing.contact_id, 'alternate');
}

export async function createAlternateEmailDraft(actorId: string, workspaceId: string, emailId: string, generated?: { subject: string; body: string }) {
  const suggestion = await getAlternateEmailDraftSuggestion(actorId, workspaceId, emailId);
  if (!suggestion) return undefined;
  await db.prepare(`UPDATE jobs SET status='failed',last_error='A person chose another version.',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=? AND type='email_draft' AND json_extract(payload_json,'$.emailId')=? AND status IN ('queued','running')`).run(workspaceId, emailId);
  const updated = await (db.prepare(`UPDATE emails SET subject=?,body=?,sources_json=? WHERE workspace_id=? AND id=? AND status='draft' AND contact_id IN (
    SELECT id FROM contacts WHERE workspace_id=? AND do_not_contact=0 AND deleted_at IS NULL AND archived_at IS NULL)`)
    .run(generated?.subject ?? suggestion.subject, generated?.body ?? suggestion.body, JSON.stringify(suggestion.sourcesUsed), workspaceId, emailId, workspaceId));
  const { aiContext: _aiContext, ...publicSuggestion } = suggestion;
  const aiConfigured = isGroqEmailEnabled() || process.env.AI_MODE === 'provider' && (process.env.AI_PROVIDER === 'gemini' ? Boolean(process.env.GEMINI_API_KEY?.trim()) : (process.env.AI_PROVIDER || 'anthropic') === 'anthropic' && Boolean(process.env.ANTHROPIC_API_KEY?.trim()));
  return updated.changes ? { id: emailId, ...publicSuggestion, subject: generated?.subject ?? suggestion.subject, body: generated?.body ?? suggestion.body, generation: generated ? 'ai' as const : aiConfigured ? 'fallback' as const : 'template' as const, status: 'draft' as const } : undefined;
}

async function getActorName(actorId: string) {
  const user = await (db.prepare(`SELECT name FROM users WHERE id=? AND disabled_at IS NULL`).get(actorId)) as { name: string } | undefined;
  return user?.name ?? 'Your name';
}

export async function updateEmailDraft(actorId: string, workspaceId: string, emailId: string, subject: string, body: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const draft = await (db.prepare(`SELECT contact_id FROM emails WHERE workspace_id=? AND id=? AND status='draft'`).get(workspaceId, emailId)) as { contact_id: string } | undefined;
  if (!draft || !await (emailAccessible(actorId, workspaceId, emailId))) return false;
  await db.prepare(`UPDATE jobs SET status='failed',last_error='A person saved this draft.',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=? AND type='email_draft' AND json_extract(payload_json,'$.emailId')=? AND status IN ('queued','running')`).run(workspaceId, emailId);
  const changed = await (db.prepare(`UPDATE emails SET subject=?,body=? WHERE workspace_id=? AND id=? AND status='draft' AND contact_id IN (
    SELECT id FROM contacts WHERE workspace_id=? AND do_not_contact=0 AND deleted_at IS NULL)`)
    .run(subject.trim(), body.trim(), workspaceId, emailId, workspaceId));
  return changed.changes > 0;
}

export async function listEmailDesk(actorId: string, workspaceId: string) {
  await assertWorkspaceAccess(actorId, workspaceId);
  const drafts = await db.prepare(`SELECT m.id,m.contact_id,m.recipient,m.subject,m.body,m.status,m.created_at,m.approved_at,m.sent_to_server_at,m.sources_json,
      c.name AS person_name,co.name AS company_name,e.name AS event_name,
      linked.summary,linked.open_question,linked.promised_next_step,linked.changed_since_last
    FROM emails m JOIN contacts c ON c.id=m.contact_id AND c.workspace_id=m.workspace_id
    JOIN companies co ON co.id=c.company_id AND co.workspace_id=c.workspace_id
    JOIN memberships ms ON ms.workspace_id=m.workspace_id AND ms.user_id=? AND ms.status='active'
    LEFT JOIN encounters linked ON linked.id=m.encounter_id AND linked.workspace_id=m.workspace_id
    LEFT JOIN events e ON e.id=linked.event_id AND e.workspace_id=linked.workspace_id
    WHERE m.workspace_id=? AND c.deleted_at IS NULL AND c.archived_at IS NULL AND ${emailAccessSql()}
    ORDER BY m.created_at DESC LIMIT 150`).all(actorId, workspaceId, actorId, actorId, actorId) as Array<Record<string, unknown>>;
  const blocked = new Set((await db.prepare(`SELECT id FROM contacts WHERE workspace_id=? AND do_not_contact=1`).all(workspaceId) as Array<{ id: string }>).map((row) => row.id));
  const noteAccess = await noteScope(actorId, workspaceId);
  const withContext = new Set((await db.prepare(`SELECT DISTINCT n.contact_id FROM notes n LEFT JOIN encounters en ON en.id=n.encounter_id AND en.workspace_id=n.workspace_id
    WHERE n.workspace_id=? AND ((n.kind='text' AND n.body<>'') OR (n.kind='audio' AND (n.summary<>'' OR n.transcript<>'')))
      AND ${visibleNoteSql('n')} AND (en.event_id IS NULL OR ?=1 OR EXISTS (
        SELECT 1 FROM event_access ea WHERE ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id AND ea.user_id=?))`)
    .all(workspaceId, noteAccess.all, actorId, actorId, noteAccess.all, actorId) as Array<{ contact_id: string }>).map((row) => row.contact_id));
  const people = (await listPeople(actorId, workspaceId)).filter((person) => Boolean(person.email) && !blocked.has(String(person.id)) && !drafts.some((draft) => draft.contact_id === person.id && draft.status === 'draft')).slice(0, 100)
    .map((person) => ({ ...person, hasContext: withContext.has(String(person.id)) }));
  return { drafts, people };
}

export async function approveEmailDraft(actorId: string, workspaceId: string, emailId: string, smtpReady: boolean, publicBaseUrl: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const email = await (db.prepare(`SELECT m.id,m.contact_id,m.subject,m.body,c.email,c.do_not_contact FROM emails m
    JOIN contacts c ON c.id=m.contact_id AND c.workspace_id=m.workspace_id
    WHERE m.workspace_id=? AND m.id=? AND m.status='draft' AND c.deleted_at IS NULL`).get(workspaceId, emailId)) as
      { id: string; contact_id: string; subject: string; body: string; email: string; do_not_contact: number } | undefined;
  if (!email) throw new Error('This draft is no longer available.');
  if (!await (emailAccessible(actorId, workspaceId, emailId))) throw new Error('This draft is no longer available.');
  if (email.do_not_contact) throw new Error('This person has asked not to receive follow-up email.');
  if (!smtpReady || !publicBaseUrl) {
    await (db.prepare(`UPDATE emails SET status='outbox',approved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=? AND id=? AND status='draft'`).run(workspaceId, emailId));
    return { status: 'outbox' as const, message: 'Saved in the outbox. No mail server and public link are configured, so nothing was sent.' };
  }
  const token = randomBytes(32).toString('base64url');
  const emailIdLink = randomUUID();
  await (db.transaction(async () => {
    await (recordEmailSendAllowance(actorId, workspaceId));
    const changed = await (db.prepare(`UPDATE emails SET status='queued',approved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),unsubscribe_token_hash=? WHERE workspace_id=? AND id=? AND status='draft'`)
      .run(hash(token), workspaceId, emailId));
    if (!changed.changes) throw new Error('This draft was already approved or changed.');
    await (db.prepare(`INSERT INTO jobs(id,workspace_id,type,payload_json,run_at) VALUES (?,?, 'email_send', ?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .run(emailIdLink, workspaceId, JSON.stringify({ emailId, unsubscribeToken: token })));
  })());
  return { status: 'queued' as const, message: 'Approved and queued for the mail server.' };
}

export async function getEmailForWorker(emailId: string, workspaceId: string, unsubscribeToken: string) {
  return await (db.prepare(`SELECT m.id,m.workspace_id,m.contact_id,m.recipient,m.subject,m.body,m.unsubscribe_token_hash,c.do_not_contact
    FROM emails m JOIN contacts c ON c.id=m.contact_id AND c.workspace_id=m.workspace_id
    WHERE m.workspace_id=? AND m.id=? AND m.status='queued' AND m.unsubscribe_token_hash=?`).get(workspaceId, emailId, hash(unsubscribeToken))) as
      { id: string; workspace_id: string; contact_id: string; recipient: string; subject: string; body: string; unsubscribe_token_hash: string | null; do_not_contact: number } | undefined;
}

export async function recordEmailSent(emailId: string, workspaceId: string, messageId: string | null) {
  await (db.transaction(async () => {
    const email = await (db.prepare(`SELECT contact_id,created_by FROM emails WHERE workspace_id=? AND id=? AND status='queued'`).get(workspaceId, emailId)) as { contact_id: string; created_by: string | null } | undefined;
    if (!email) return;
    const changed = await (db.prepare(`UPDATE emails SET status='sent',provider_message_id=?,sent_to_server_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),error_message=NULL WHERE workspace_id=? AND id=? AND status='queued'`)
      .run(messageId, workspaceId, emailId));
    if (!changed.changes) return;
    await (db.prepare(`UPDATE contacts SET stage=CASE WHEN stage='new' THEN 'contacted' ELSE stage END,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=? AND id=? AND deleted_at IS NULL`)
      .run(workspaceId, email.contact_id));
    if (email.created_by) await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'email_sent','contact',?,?)`)
      .run(randomUUID(), workspaceId, email.created_by, email.contact_id, JSON.stringify({ emailId })));
  })());
}

export async function recordEmailFailed(emailId: string, workspaceId: string) {
  await (db.prepare(`UPDATE emails SET status='failed',error_message='The mail server did not accept this message.' WHERE workspace_id=? AND id=? AND status='queued'`).run(workspaceId, emailId));
}

export async function getEmailStatus(actorId: string, workspaceId: string, emailId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const email = await (db.prepare(`SELECT id,contact_id,status,error_message,subject,body FROM emails WHERE workspace_id=? AND id=?`).get(workspaceId, emailId)) as { id: string; contact_id: string; status: string; error_message: string | null; subject: string; body: string } | undefined;
  if (!email || !await (emailAccessible(actorId, workspaceId, emailId))) return undefined;
  const job = await db.prepare(`SELECT status FROM jobs WHERE workspace_id=? AND type='email_draft' AND json_extract(payload_json,'$.emailId')=? ORDER BY created_at DESC LIMIT 1`)
    .get(workspaceId, emailId) as { status: string } | undefined;
  return { id: email.id, status: email.status, error: email.error_message, subject: email.subject, body: email.body,
    generation: job ? job.status === 'succeeded' ? 'ai' : job.status === 'failed' ? 'fallback' : 'pending' : 'template' };
}

export async function retryEmail(actorId: string, workspaceId: string, emailId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const email = await (db.prepare(`SELECT contact_id FROM emails WHERE workspace_id=? AND id=? AND status='failed'`).get(workspaceId, emailId)) as { contact_id: string } | undefined;
  if (!email || !await (emailAccessible(actorId, workspaceId, emailId))) return false;
  const job = await (db.prepare(`SELECT id FROM jobs WHERE workspace_id=? AND type='email_send' AND status='failed' AND json_extract(payload_json,'$.emailId')=? ORDER BY created_at DESC LIMIT 1`).get(workspaceId, emailId)) as { id: string } | undefined;
  if (!job) return false;
  return await (db.transaction(async () => {
    await (recordEmailSendAllowance(actorId, workspaceId));
    const changed = await (db.prepare(`UPDATE jobs SET status='queued',run_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),attempts=0,lease_until=NULL,last_error=NULL,finished_at=NULL WHERE workspace_id=? AND id=? AND status='failed'`).run(workspaceId, job.id));
    if (!changed.changes) return false;
    const emailChanged = await (db.prepare(`UPDATE emails SET status='queued',error_message=NULL WHERE workspace_id=? AND id=? AND status='failed'`).run(workspaceId, emailId));
    if (!emailChanged.changes) throw new Error('Email retry state changed while it was being queued.');
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id) VALUES (?,?,?,'email_retried','email',?)`).run(randomUUID(), workspaceId, actorId, emailId));
    return true;
  })());
}

export async function unsubscribeByToken(token: string) {
  const tokenHash = hash(token);
  const rows = await (db.prepare(`SELECT workspace_id,contact_id FROM emails WHERE unsubscribe_token_hash=?`).all(tokenHash)) as Array<{ workspace_id: string; contact_id: string }>;
  if (!rows.length) return false;
  return await (db.transaction(async () => {
    for (const row of rows) {
      await (db.prepare(`UPDATE contacts SET do_not_contact=1,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=? AND id=?`).run(row.workspace_id, row.contact_id));
      await (db.prepare(`UPDATE emails SET unsubscribe_token_hash=NULL WHERE workspace_id=? AND contact_id=?`).run(row.workspace_id, row.contact_id));
    }
    return true;
  })());
}

export async function getDemoAccounts() {
  return await (db.prepare(`
    SELECT u.id,u.name,u.email,m.role,w.id AS workspaceId,w.name AS workspaceName,w.kind AS workspaceKind
    FROM users u JOIN memberships m ON m.user_id=u.id JOIN workspaces w ON w.id=m.workspace_id
    WHERE u.email LIKE '%@gather.test' AND m.status='active'
    ORDER BY w.kind,w.name,u.name
  `).all()) as Array<{ id: string; name: string; email: string; role: WorkspaceRole; workspaceId: string; workspaceName: string; workspaceKind: WorkspaceKind }>;
}

export async function setWorkspaceSetting(actorId: string, workspaceId: string, key: string, value: unknown) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  await (db.prepare(`INSERT INTO workspace_settings(workspace_id,key,value_json) VALUES (?,?,?)
    ON CONFLICT(workspace_id,key) DO UPDATE SET value_json=excluded.value_json,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .run(workspaceId, key, JSON.stringify(value)));
}

export async function getWorkspaceSetting(actorId: string, workspaceId: string, key: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const row = await (db.prepare('SELECT value_json FROM workspace_settings WHERE workspace_id=? AND key=?').get(workspaceId, key)) as { value_json: string } | undefined;
  return row ? JSON.parse(row.value_json) as unknown : undefined;
}

export type WorkspaceEmailSettings = { fromName: string; fromAddress: string };

export async function getWorkspaceEmailSettingsForWorker(workspaceId: string): Promise<WorkspaceEmailSettings | undefined> {
  const row = await (db.prepare(`SELECT value_json FROM workspace_settings WHERE workspace_id=? AND key='email'`).get(workspaceId)) as { value_json: string } | undefined;
  if (!row) return undefined;
  try {
    const value = JSON.parse(row.value_json) as Partial<WorkspaceEmailSettings>;
    if (typeof value.fromName !== 'string' || typeof value.fromAddress !== 'string') return undefined;
    if (!value.fromName.trim() || /[\r\n]/.test(value.fromName) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.fromAddress)) return undefined;
    return { fromName: value.fromName.trim().slice(0, 100), fromAddress: value.fromAddress.trim().slice(0, 254) };
  } catch { return undefined; }
}

export type CaptureAfterSaveEmail = 'ask' | 'never';

export async function getCaptureAfterSaveEmail(actorId: string, workspaceId: string): Promise<CaptureAfterSaveEmail> {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const row = await (db.prepare(`SELECT value_json FROM user_workspace_preferences
    WHERE workspace_id=? AND user_id=? AND preference_key='capture_after_save_email'`).get(workspaceId, actorId)) as { value_json: string } | undefined;
  if (!row) return 'ask';
  try { return JSON.parse(row.value_json) === 'never' ? 'never' : 'ask'; }
  catch { return 'ask'; }
}

export async function setCaptureAfterSaveEmail(actorId: string, workspaceId: string, value: CaptureAfterSaveEmail) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  await (db.prepare(`INSERT INTO user_workspace_preferences(workspace_id,user_id,preference_key,value_json) VALUES (?,?,'capture_after_save_email',?)
    ON CONFLICT(workspace_id,user_id,preference_key) DO UPDATE SET value_json=excluded.value_json,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .run(workspaceId, actorId, JSON.stringify(value)));
}

export async function getUserWorkspacePreference(actorId: string, workspaceId: string, key: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const row = await (db.prepare(`SELECT value_json FROM user_workspace_preferences
    WHERE workspace_id=? AND user_id=? AND preference_key=?`).get(workspaceId, actorId, key)) as { value_json: string } | undefined;
  if (!row) return undefined;
  try { return JSON.parse(row.value_json) as unknown; } catch { return undefined; }
}

export async function setUserWorkspacePreference(actorId: string, workspaceId: string, key: string, value: unknown) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  await (db.prepare(`INSERT INTO user_workspace_preferences(workspace_id,user_id,preference_key,value_json) VALUES (?,?,?,?)
    ON CONFLICT(workspace_id,user_id,preference_key) DO UPDATE SET value_json=excluded.value_json,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .run(workspaceId, actorId, key, JSON.stringify(value)));
}

export type ScanRow = {
  id: string;
  client_scan_id: string;
  source: 'camera' | 'gallery' | 'qr' | 'manual';
  image_mime: string | null;
  status: 'queued' | 'reading' | 'ready' | 'saved' | 'failed' | 'discarded';
  extracted_json: string | null;
  uncertain_json: string;
  error_message: string | null;
  contact_id: string | null;
  queued_at: string;
  ready_at: string | null;
  saved_at: string | null;
  material_company_id?: string | null;
  event_time_zone?: string | null;
};

export async function findScanByClientId(actorId: string, workspaceId: string, clientScanId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  return await (db.prepare(`SELECT s.id,s.client_scan_id,s.source,s.image_mime,s.status,s.extracted_json,s.uncertain_json,s.error_message,s.contact_id,s.queued_at,s.ready_at,s.saved_at FROM scans s WHERE s.workspace_id=? AND s.client_scan_id=? AND ((s.event_id IS NULL AND s.created_by=?) OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=s.workspace_id AND ea.event_id=s.event_id AND ea.user_id=?))`)
    .get(workspaceId, clientScanId, actorId, actorId)) as ScanRow | undefined;
}

export async function findScanByContentHash(actorId: string, workspaceId: string, contentHash: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  return await (db.prepare(`SELECT s.id,s.client_scan_id,s.source,s.image_mime,s.status,s.extracted_json,s.uncertain_json,s.error_message,s.contact_id,s.queued_at,s.ready_at,s.saved_at
    FROM scans s WHERE s.workspace_id=? AND s.content_sha256=? AND s.status<>'discarded'
      AND ((s.event_id IS NULL AND s.created_by=?) OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=s.workspace_id AND ea.event_id=s.event_id AND ea.user_id=?))
    ORDER BY CASE WHEN s.status='saved' THEN 0 ELSE 1 END,s.queued_at DESC LIMIT 1`)
    .get(workspaceId, contentHash, actorId, actorId)) as ScanRow | undefined;
}

export async function findLikelySavedScan(actorId: string, workspaceId: string, visualHash: string) {
  await assertWorkspaceAccess(actorId, workspaceId);
  const { imageHashDistance } = await import('./visual-hash.js');
  const activeBits = imageHashDistance(visualHash, '0000000000000000');
  if (activeBits < 8 || activeBits > 56) return undefined;
  const rows = await db.prepare(`SELECT s.id,s.client_scan_id,s.source,s.image_mime,s.status,s.extracted_json,s.uncertain_json,s.error_message,s.contact_id,s.queued_at,s.ready_at,s.saved_at,s.visual_hash
    FROM scans s WHERE s.workspace_id=? AND s.status='saved' AND s.contact_id IS NOT NULL AND s.visual_hash IS NOT NULL
      AND ((s.event_id IS NULL AND s.created_by=?) OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=s.workspace_id AND ea.event_id=s.event_id AND ea.user_id=?))
    ORDER BY s.saved_at DESC LIMIT 500`).all(workspaceId, actorId, actorId) as Array<ScanRow & { visual_hash: string }>;
  const candidate = rows.map((scan) => ({ scan, distance: imageHashDistance(visualHash, scan.visual_hash) }))
    .sort((a, b) => a.distance - b.distance)[0];
  return candidate && candidate.distance <= 3 ? candidate.scan : undefined;
}

function configuredStorageLimit(name: string, fallback: number) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name} storage limit configuration.`);
  return value;
}

export async function createScan(input: { actorId: string; workspaceId: string; eventId: string | null; clientScanId: string; clientOrder?: number; scanId?: string; source: ScanRow['source']; imagePath: string; imageMime: string; imageBytes: number; contentHash?: string; visualHash?: string }) {
  await (assertWorkspaceAccess(input.actorId, input.workspaceId));
  if (!Number.isSafeInteger(input.imageBytes) || input.imageBytes <= 0) throw new Error('scan_storage_limit');
  const scanId = input.scanId ?? randomUUID();
  const jobId = randomUUID();
  return await (db.transaction(async () => {
    if (input.eventId) {
      const event = await (db.prepare(`SELECT e.id FROM events e JOIN event_access a ON a.event_id=e.id AND a.workspace_id=e.workspace_id
        WHERE e.id=? AND e.workspace_id=? AND a.user_id=?`).get(input.eventId, input.workspaceId, input.actorId));
      if (!event) throw new Error('This event is no longer available. Choose another event.');
    }
    const existing = await (db.prepare(`SELECT s.id,s.client_scan_id,s.source,s.image_mime,s.status,s.extracted_json,s.uncertain_json,s.error_message,s.contact_id,s.queued_at,s.ready_at,s.saved_at FROM scans s WHERE s.workspace_id=? AND s.client_scan_id=? AND ((s.event_id IS NULL AND s.created_by=?) OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=s.workspace_id AND ea.event_id=s.event_id AND ea.user_id=?))`)
      .get(input.workspaceId, input.clientScanId, input.actorId, input.actorId)) as ScanRow | undefined;
    if (existing) return { scan: existing, duplicate: true };
    if (input.contentHash) {
      const matching = await (db.prepare(`SELECT s.id,s.client_scan_id,s.source,s.image_mime,s.status,s.extracted_json,s.uncertain_json,s.error_message,s.contact_id,s.queued_at,s.ready_at,s.saved_at
        FROM scans s WHERE s.workspace_id=? AND s.content_sha256=? AND s.status<>'discarded'
          AND ((s.event_id IS NULL AND s.created_by=?) OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=s.workspace_id AND ea.event_id=s.event_id AND ea.user_id=?))
        ORDER BY CASE WHEN s.status='saved' THEN 0 ELSE 1 END,s.queued_at DESC LIMIT 1`)
        .get(input.workspaceId, input.contentHash, input.actorId, input.actorId)) as ScanRow | undefined;
      if (matching) return { scan: matching, duplicate: true };
    }
    const workspaceLimit = configuredStorageLimit('SCAN_STORAGE_WORKSPACE_LIMIT_BYTES', 536870912);
    const totalLimit = configuredStorageLimit('SCAN_STORAGE_TOTAL_LIMIT_BYTES', 5368709120);
    const workspaceBytes = (await (db.prepare(`SELECT COALESCE(SUM(image_bytes),0) AS total FROM scans WHERE workspace_id=? AND image_path IS NOT NULL`).get(input.workspaceId)) as { total: number }).total;
    const allBytes = (await (db.prepare(`SELECT COALESCE(SUM(image_bytes),0) AS total FROM scans WHERE image_path IS NOT NULL`).get()) as { total: number }).total;
    if (workspaceBytes + input.imageBytes > workspaceLimit || allBytes + input.imageBytes > totalLimit) throw new Error('scan_storage_limit');
    await (db.prepare(`INSERT INTO scans(id,workspace_id,event_id,client_scan_id,source,image_path,image_mime,image_bytes,content_sha256,visual_hash,status,created_by,client_order) VALUES (?,?,?,?,?,?,?,?,?,?,'queued',?,?)`)
      .run(scanId, input.workspaceId, input.eventId, input.clientScanId, input.source, input.imagePath, input.imageMime, input.imageBytes, input.contentHash ?? null, input.visualHash ?? null, input.actorId, input.clientOrder ?? Date.now() * 10));
    await (db.prepare(`INSERT INTO jobs(id,workspace_id,type,payload_json,run_at) VALUES (?,?, 'card_read', ?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .run(jobId, input.workspaceId, JSON.stringify({ scanId })));
    const scan = await (db.prepare(`SELECT id,client_scan_id,source,image_mime,status,extracted_json,uncertain_json,error_message,contact_id,queued_at,ready_at,saved_at FROM scans WHERE id=?`)
      .get(scanId)) as ScanRow;
    return { scan, duplicate: false };
  })());
}

export async function createQrScan(input: { actorId: string; workspaceId: string; eventId: string | null; clientScanId: string; result: unknown; uncertain: string[]; contentHash?: string }) {
  await (assertWorkspaceAccess(input.actorId, input.workspaceId));
  const scanId = randomUUID();
  return await (db.transaction(async () => {
    if (input.eventId && !await (db.prepare(`SELECT 1 FROM event_access WHERE workspace_id=? AND event_id=? AND user_id=?`).get(input.workspaceId, input.eventId, input.actorId))) {
      throw new AccessDeniedError('You no longer have access to this event. Ask your admin for access.');
    }
    const existing = await (db.prepare(`SELECT s.id,s.client_scan_id,s.source,s.image_mime,s.status,s.extracted_json,s.uncertain_json,s.error_message,s.contact_id,s.queued_at,s.ready_at,s.saved_at FROM scans s WHERE s.workspace_id=? AND s.client_scan_id=? AND ((s.event_id IS NULL AND s.created_by=?) OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=s.workspace_id AND ea.event_id=s.event_id AND ea.user_id=?))`)
      .get(input.workspaceId, input.clientScanId, input.actorId, input.actorId)) as ScanRow | undefined;
    if (existing) return { scan: existing, duplicate: true };
    if (input.contentHash) {
      const matching = await (db.prepare(`SELECT s.id,s.client_scan_id,s.source,s.image_mime,s.status,s.extracted_json,s.uncertain_json,s.error_message,s.contact_id,s.queued_at,s.ready_at,s.saved_at
        FROM scans s WHERE s.workspace_id=? AND s.content_sha256=? AND s.status<>'discarded'
          AND ((s.event_id IS NULL AND s.created_by=?) OR EXISTS (SELECT 1 FROM event_access ea WHERE ea.workspace_id=s.workspace_id AND ea.event_id=s.event_id AND ea.user_id=?))
        ORDER BY CASE WHEN s.status='saved' THEN 0 ELSE 1 END,s.queued_at DESC LIMIT 1`)
        .get(input.workspaceId, input.contentHash, input.actorId, input.actorId)) as ScanRow | undefined;
      if (matching) return { scan: matching, duplicate: true };
    }
    const workspaceCount = (await (db.prepare(`SELECT COUNT(*) AS total FROM scans WHERE workspace_id=? AND source='qr'`).get(input.workspaceId)) as { total: number }).total;
    const totalCount = (await (db.prepare(`SELECT COUNT(*) AS total FROM scans WHERE source='qr'`).get()) as { total: number }).total;
    const workspaceLimit = configuredStorageLimit('QR_SCAN_WORKSPACE_LIMIT_COUNT', 20000);
    const totalLimit = configuredStorageLimit('QR_SCAN_TOTAL_LIMIT_COUNT', 100000);
    if (workspaceCount >= workspaceLimit) throw new QrScanStorageLimitError('workspace');
    if (totalCount >= totalLimit) throw new QrScanStorageLimitError('service');
    await (db.prepare(`INSERT INTO scans(id,workspace_id,event_id,client_scan_id,source,status,extracted_json,uncertain_json,content_sha256,queued_at,ready_at,created_by)
      VALUES (?,?,?,?,?,'ready',?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),?)`)
      .run(scanId, input.workspaceId, input.eventId, input.clientScanId, 'qr', JSON.stringify(input.result), JSON.stringify(input.uncertain), input.contentHash ?? null, input.actorId));
    return { scan: await (db.prepare(`SELECT id,client_scan_id,source,image_mime,status,extracted_json,uncertain_json,error_message,contact_id,queued_at,ready_at,saved_at FROM scans WHERE id=?`)
      .get(scanId)) as ScanRow, duplicate: false };
  })());
}

export class QrScanStorageLimitError extends Error {
  readonly code = 'qr_scan_storage_limit';
  readonly scope: 'workspace' | 'service';
  constructor(scope: 'workspace' | 'service') {
    super(scope === 'workspace'
      ? 'This space has reached its QR scan limit. Remove older scans or ask an admin for help.'
      : 'The shared service has reached its QR scan limit. Please contact an administrator.');
    this.name = 'QrScanStorageLimitError';
    this.scope = scope;
  }
}

export async function listScans(actorId: string, workspaceId: string, limit = 40) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  return await (db.prepare(`SELECT id,client_scan_id,source,image_mime,status,extracted_json,uncertain_json,error_message,contact_id,queued_at,ready_at,saved_at,material_company_id
    FROM scans s WHERE workspace_id=? AND status<>'discarded' AND ((event_id IS NULL AND created_by=?) OR EXISTS (
      SELECT 1 FROM event_access ea WHERE ea.workspace_id=s.workspace_id AND ea.event_id=s.event_id AND ea.user_id=?))
    ORDER BY COALESCE(client_order,CAST(julianday(queued_at)*864000000 AS INTEGER)) DESC,queued_at DESC LIMIT ?`).all(workspaceId, actorId, actorId, Math.min(Math.max(limit, 1), 100))) as ScanRow[];
}

export async function getScan(actorId: string, workspaceId: string, scanId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  return await (db.prepare(`SELECT s.id,s.workspace_id,s.event_id,s.client_scan_id,s.source,s.image_path,s.image_mime,s.status,s.extracted_json,s.uncertain_json,s.error_message,s.contact_id,s.queued_at,s.ready_at,s.saved_at,s.material_company_id,e.time_zone AS event_time_zone
    FROM scans s LEFT JOIN events e ON e.id=s.event_id AND e.workspace_id=s.workspace_id WHERE s.workspace_id=? AND s.id=? AND ((s.event_id IS NULL AND s.created_by=?) OR EXISTS (
      SELECT 1 FROM event_access ea WHERE ea.workspace_id=s.workspace_id AND ea.event_id=s.event_id AND ea.user_id=?))`).get(workspaceId, scanId, actorId, actorId)) as (ScanRow & { workspace_id: string; event_id: string | null; image_path: string | null }) | undefined;
}

function mergeScanReadResult(existingValue: string | null, incomingValue: unknown, preferIncoming: boolean) {
  const parsedExisting = existingValue ? JSON.parse(existingValue) as Record<string, unknown> : {};
  const incoming = incomingValue && typeof incomingValue === 'object' ? incomingValue as Record<string, unknown> : {};
  const merged: Record<string, unknown> = {};
  for (const field of ['name', 'title', 'company', 'email', 'phone', 'website'] as const) {
    const current = parsedExisting[field];
    const next = incoming[field];
    const currentValue = typeof current === 'string' ? current.trim() : '';
    const nextValue = typeof next === 'string' ? next.trim() : '';
    merged[field] = preferIncoming ? (nextValue || currentValue) : (currentValue || nextValue);
  }
  for (const field of ['products', 'topics'] as const) {
    const current = Array.isArray(parsedExisting[field]) ? parsedExisting[field] as unknown[] : [];
    const next = Array.isArray(incoming[field]) ? incoming[field] as unknown[] : [];
    const ordered = preferIncoming ? [...next, ...current] : [...current, ...next];
    merged[field] = [...new Set(ordered.filter((item): item is string => typeof item === 'string' && !!item.trim()).map((item) => item.trim()))];
  }
  const incomingUncertain = Array.isArray(incoming.uncertain) ? incoming.uncertain.filter((item): item is string => typeof item === 'string') : [];
  const uncertain = new Set([
    ...(Array.isArray(parsedExisting.uncertain) ? parsedExisting.uncertain : []),
    ...incomingUncertain,
  ].filter((item): item is string => typeof item === 'string'));
  if (preferIncoming) {
    for (const field of ['name', 'title', 'company', 'email', 'phone', 'website']) {
      if (typeof incoming[field] === 'string' && incoming[field].trim() && !incomingUncertain.includes(field)) uncertain.delete(field);
    }
  }
  merged.uncertain = [...uncertain].filter((field) => ['name', 'title', 'company', 'email', 'phone', 'website'].includes(field));
  return merged;
}

export async function updateScanRead(scanId: string, workspaceId: string, result: unknown, uncertain: string[]) {
  const scan = await (db.prepare(`SELECT extracted_json FROM scans WHERE id=? AND workspace_id=? AND status IN ('queued','reading')`).get(scanId, workspaceId)) as { extracted_json: string | null } | undefined;
  if (!scan) return;
  const merged = mergeScanReadResult(scan.extracted_json, result, false);
  await (db.prepare(`UPDATE scans SET status='ready',extracted_json=?,uncertain_json=?,error_message=NULL,ready_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND workspace_id=? AND status IN ('queued','reading')`)
    .run(JSON.stringify(merged), JSON.stringify(merged.uncertain ?? uncertain), scanId, workspaceId));
}

export async function applyQrToScan(actorId: string, workspaceId: string, scanId: string, result: unknown, uncertain: string[], preferIncoming = true, finalizeRead = false) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const scan = await (db.prepare(`SELECT event_id,status,created_by FROM scans WHERE workspace_id=? AND id=?`).get(workspaceId, scanId)) as { event_id: string | null; status: string; created_by: string | null } | undefined;
  if (!scan || ['saved','discarded'].includes(scan.status)) return false;
  if (scan.event_id ? !await (db.prepare(`SELECT 1 FROM event_access WHERE workspace_id=? AND event_id=? AND user_id=?`).get(workspaceId, scan.event_id, actorId)) : scan.created_by !== actorId) {
    throw new AccessDeniedError('You no longer have access to this event. Ask your admin for access.');
  }
  return await (db.transaction(async () => {
    const current = await (db.prepare(`SELECT extracted_json FROM scans WHERE workspace_id=? AND id=?`).get(workspaceId, scanId)) as { extracted_json: string | null };
    const merged = mergeScanReadResult(current.extracted_json, result, preferIncoming);
    const reading = !finalizeRead && (scan.status === 'queued' || scan.status === 'reading');
    await (db.prepare(`UPDATE scans SET status=CASE WHEN ? THEN status ELSE 'ready' END,extracted_json=?,uncertain_json=?,error_message=NULL,ready_at=CASE WHEN ? THEN ready_at ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END WHERE workspace_id=? AND id=?`)
      .run(reading ? 1 : 0, JSON.stringify(merged), JSON.stringify(merged.uncertain ?? uncertain), reading ? 1 : 0, workspaceId, scanId));
    return true;
  })());
}

export async function markScanReading(scanId: string, workspaceId: string) {
  await (db.prepare(`UPDATE scans SET status='reading',reading_started_at=COALESCE(reading_started_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=? AND workspace_id=? AND status='queued'`).run(scanId, workspaceId));
}

export async function markScanNeedsInput(scanId: string, workspaceId: string, message: string) {
  await (db.prepare(`UPDATE scans SET status='failed',error_message=?,ready_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND workspace_id=? AND status IN ('queued','reading')`)
    .run(message, scanId, workspaceId));
}

export async function markScanNeedsInputByActor(actorId: string, workspaceId: string, scanId: string, message: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const scan = await (db.prepare(`SELECT event_id,status,created_by FROM scans WHERE workspace_id=? AND id=?`).get(workspaceId, scanId)) as { event_id: string | null; status: string; created_by: string | null } | undefined;
  if (!scan || ['saved','discarded'].includes(scan.status)) return false;
  if (scan.event_id ? !await (db.prepare(`SELECT 1 FROM event_access WHERE workspace_id=? AND event_id=? AND user_id=?`).get(workspaceId, scan.event_id, actorId)) : scan.created_by !== actorId) {
    throw new AccessDeniedError('You no longer have access to this event. Ask your admin for access.');
  }
  return (await db.prepare(`UPDATE scans SET status='failed',error_message=?,ready_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=? AND id=? AND status IN ('queued','reading','failed')`)
    .run(message, workspaceId, scanId)).changes > 0;
}

export async function discardScan(actorId: string, workspaceId: string, scanId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  return await (db.transaction(async () => {
    const scan = await (db.prepare(`SELECT event_id,created_by,source FROM scans WHERE workspace_id=? AND id=? AND contact_id IS NULL AND status<>'discarded'`).get(workspaceId, scanId)) as { event_id: string | null; created_by: string | null; source: ScanRow['source'] } | undefined;
    if (!scan || (scan.event_id ? !await (db.prepare(`SELECT 1 FROM event_access WHERE workspace_id=? AND event_id=? AND user_id=?`).get(workspaceId, scan.event_id, actorId)) : scan.created_by !== actorId)) return false;
    if (scan.source === 'qr') {
      return (await db.prepare(`DELETE FROM scans WHERE workspace_id=? AND id=? AND contact_id IS NULL AND status<>'discarded'`).run(workspaceId, scanId)).changes > 0;
    }
    return (await db.prepare(`UPDATE scans SET status='discarded',image_path=NULL,image_bytes=0 WHERE workspace_id=? AND id=? AND contact_id IS NULL AND status<>'discarded'`).run(workspaceId, scanId)).changes > 0;
  })());
}

export type JobRow = { id: string; workspace_id: string; type: string; payload_json: string; attempts: number; max_attempts: number };

export async function claimNextJob(): Promise<JobRow | undefined> {
  const now = new Date().toISOString();
  return await (db.transaction(async () => {
    const job = await (db.prepare(`SELECT id,workspace_id,type,payload_json,attempts,max_attempts FROM jobs
      WHERE (status='queued' AND run_at<=?) OR (status='running' AND lease_until<=?)
      ORDER BY CASE type WHEN 'email_send' THEN 0 WHEN 'password_reset_email' THEN 0 WHEN 'email_verification' THEN 0 WHEN 'card_read' THEN 1 WHEN 'email_draft' THEN 3 ELSE 2 END,run_at,created_at LIMIT 1`).get(now, now)) as JobRow | undefined;
    if (!job) return undefined;
    await (db.prepare(`UPDATE jobs SET status='running',attempts=attempts+1,lease_until=?,last_error=NULL WHERE id=?`)
      .run(new Date(Date.now() + 60_000).toISOString(), job.id));
    return { ...job, attempts: job.attempts + 1 };
  })());
}

// Secrets in a job's payload (one-time links, unsubscribe tokens) are only needed while the job is being worked on.
// Plain JSON handling rather than SQL json functions, so it behaves the same on SQLite and Postgres.
const jobSecretField: Record<string, string> = { password_reset_email: 'token', email_verification: 'token', email_send: 'unsubscribeToken' };

export async function completeJob(jobId: string) {
  await (db.prepare(`UPDATE jobs SET status='succeeded',lease_until=NULL,last_error=NULL,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='running'`)
    .run(jobId));
  const row = await (db.prepare(`SELECT type,payload_json FROM jobs WHERE id=? AND status='succeeded'`).get(jobId)) as { type: string; payload_json: string } | undefined;
  if (row && jobSecretField[row.type]) await blankPayloadField(jobId, row.payload_json, jobSecretField[row.type]!);
}
async function blankPayloadField(jobId: string, payloadJson: string, field: string) {
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    if (!payload[field]) return;
    await (db.prepare(`UPDATE jobs SET payload_json=? WHERE id=?`).run(JSON.stringify({ ...payload, [field]: '' }), jobId));
  } catch { /* an unreadable payload has nothing to clear */ }
}
// Emails sent before this change still hold their token; clear them once, in small batches.
export async function clearOldSentEmailTokens() {
  for (let round = 0; round < 200; round++) {
    const rows = await (db.prepare(`SELECT id,payload_json FROM jobs WHERE type='email_send' AND status='succeeded' AND payload_json LIKE '%"unsubscribeToken":"_%' LIMIT 200`).all()) as Array<{ id: string; payload_json: string }>;
    if (!rows.length) return;
    for (const row of rows) await blankPayloadField(row.id, row.payload_json, 'unsubscribeToken');
  }
}

export async function failJobAttempt(job: JobRow, message: string) {
  const terminal = job.attempts >= job.max_attempts;
  const delaySeconds = process.env.NODE_ENV === 'test' ? 0 : Math.min(3600, 10 * (2 ** Math.max(0, job.attempts - 1)));
  await (db.prepare(`UPDATE jobs SET status=?,run_at=?,lease_until=NULL,last_error=?,finished_at=? WHERE id=?`)
    .run(terminal ? 'failed' : 'queued', new Date(Date.now() + delaySeconds * 1000).toISOString(), message.slice(0, 1000), terminal ? new Date().toISOString() : null, job.id));
  if (terminal && ['password_reset_email','email_verification'].includes(job.type)) await blankPayloadField(job.id, job.payload_json, 'token');
  if (terminal && job.type === 'card_read') {
    try {
      const payload = JSON.parse(job.payload_json) as { scanId: string };
      await (markScanNeedsInput(payload.scanId, job.workspace_id, 'The card could not be read. Type the details and try again.'));
    } catch { /* the job still remains visible under Problems */ }
  }
}

export async function getScanForWorker(scanId: string, workspaceId: string) {
  return await (db.prepare(`SELECT id,workspace_id,image_path,image_mime,status FROM scans WHERE workspace_id=? AND id=?`).get(workspaceId, scanId)) as
    { id: string; workspace_id: string; image_path: string | null; image_mime: string | null; status: string } | undefined;
}

export async function listJobProblems(actorId: string, workspaceId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const jobs = await (db.prepare(`SELECT id,type,payload_json,attempts,max_attempts,created_at FROM jobs WHERE workspace_id=? AND status='failed' ORDER BY created_at DESC LIMIT 100`)
    .all(workspaceId)) as Array<{ id: string; type: string; payload_json: string; attempts: number; max_attempts: number; created_at: string }>;
  const problemGroups = await Promise.all(jobs.map(async (job) => {
    try {
      if (job.type === 'card_read') {
        const payload = JSON.parse(job.payload_json) as { scanId?: string };
        const scan = payload.scanId ? await (getScan(actorId, workspaceId, payload.scanId)) : undefined;
        return scan?.status === 'failed' ? [{ id: job.id, type: 'card_read', attempts: job.attempts, max_attempts: job.max_attempts, created_at: job.created_at, message: 'This card could not be read. Open it and type the details.' }] : [];
      }
      if (job.type === 'email_send') {
        const payload = JSON.parse(job.payload_json) as { emailId?: string };
        const email = payload.emailId ? await (getEmailStatus(actorId, workspaceId, payload.emailId)) : undefined;
        return email?.status === 'failed' ? [{ id: job.id, type: 'email_send', attempts: job.attempts, max_attempts: job.max_attempts, created_at: job.created_at, message: 'The mail server did not accept this email. Review it and try again.' }] : [];
      }
      if (job.type === 'daily_digest') {
        const payload = JSON.parse(job.payload_json) as { userId?: string; localDate?: string };
        const workspace = await (workspaceForActor(actorId, workspaceId));
        const run = payload.userId && payload.localDate ? await (db.prepare(`SELECT status FROM digest_runs WHERE workspace_id=? AND user_id=? AND local_date=? AND job_id=?`)
          .get(workspaceId, payload.userId, payload.localDate, job.id)) as { status: string } | undefined : undefined;
        return run?.status === 'failed' && (payload.userId === actorId || workspace?.role === 'admin')
          ? [{ id: job.id, type: 'daily_digest', attempts: job.attempts, max_attempts: job.max_attempts, created_at: job.created_at, message: 'The daily digest could not be sent. Check the mail server settings, then retry.' }]
          : [];
      }
    } catch { /* Invalid or inaccessible job details stay private. */ }
    return [];
  }));
  return problemGroups.flat();
}

export async function retryJob(actorId: string, workspaceId: string, jobId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const job = await (db.prepare(`SELECT type,payload_json FROM jobs WHERE workspace_id=? AND id=? AND status='failed'`).get(workspaceId, jobId)) as { type: string; payload_json: string } | undefined;
  if (!job) return false;
  let payload: { scanId?: string; emailId?: string };
  try { payload = JSON.parse(job.payload_json) as typeof payload; } catch { return false; }
  if (job.type === 'email_send') return Boolean(payload.emailId && await (retryEmail(actorId, workspaceId, payload.emailId)));
  if (job.type === 'daily_digest') {
    let digest: { userId?: string; localDate?: string };
    try { digest = JSON.parse(job.payload_json) as typeof digest; } catch { return false; }
    if (!digest.userId || !digest.localDate) return false;
    const workspace = await (workspaceForActor(actorId, workspaceId));
    const run = await (db.prepare(`SELECT status FROM digest_runs WHERE workspace_id=? AND user_id=? AND local_date=? AND job_id=?`)
      .get(workspaceId, digest.userId, digest.localDate, jobId)) as { status: string } | undefined;
    if (run?.status !== 'failed' || (digest.userId !== actorId && workspace?.role !== 'admin')) return false;
    return await (db.transaction(async () => {
      const changed = await (db.prepare(`UPDATE jobs SET status='queued',run_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),attempts=0,lease_until=NULL,last_error=NULL,finished_at=NULL WHERE workspace_id=? AND id=? AND status='failed'`).run(workspaceId, jobId));
      if (!changed.changes) return false;
      await (db.prepare(`UPDATE digest_runs SET status='queued',last_error=NULL WHERE workspace_id=? AND user_id=? AND local_date=?`).run(workspaceId, digest.userId, digest.localDate));
      await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id) VALUES (?,?,?,'job_retried','job',?)`).run(randomUUID(), workspaceId, actorId, jobId));
      return true;
    })());
  }
  if (job.type !== 'card_read' || !payload.scanId) return false;
  const scan = await (getScan(actorId, workspaceId, payload.scanId));
  if (!scan || scan.status !== 'failed') return false;
  return await (db.transaction(async () => {
    const changed = await (db.prepare(`UPDATE jobs SET status='queued',run_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),attempts=0,lease_until=NULL,last_error=NULL,finished_at=NULL WHERE workspace_id=? AND id=? AND status='failed'`).run(workspaceId, jobId));
    if (!changed.changes) return false;
    await (db.prepare(`UPDATE scans SET status='queued',error_message=NULL WHERE workspace_id=? AND id=? AND status='failed'`).run(workspaceId, payload.scanId));
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id) VALUES (?,?,?,'job_retried','job',?)`).run(randomUUID(), workspaceId, actorId, jobId));
    return true;
  })());
}

const normalizeCompanyName = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
// Legal suffixes are only a review hint: they never silently merge two companies.
const companyCoreName = (value: string) => normalizeCompanyName(value.replace(/(?:\s|,|\.)+(?:incorporated|inc|limited|ltd|llc|llp|corp(?:oration)?|pvt|private)(?:\s|\.)*$/i, ''));
async function findExactCompany(workspaceId: string, normalizedName: string, domain: string) {
  const lookup = async (aliasType: 'name' | 'domain', value: string) => {
    if (!value) return undefined;
    const column = aliasType === 'domain' ? 'normalized_domain' : 'normalized_name';
    return await (db.prepare(`SELECT co.id,co.name FROM companies co WHERE co.workspace_id=? AND co.archived_at IS NULL
      AND (co.${column}=? OR EXISTS (SELECT 1 FROM company_aliases a WHERE a.workspace_id=co.workspace_id AND a.company_id=co.id AND a.alias_type=? AND a.alias_value=?))
      ORDER BY CASE WHEN co.${column}=? THEN 0 ELSE 1 END LIMIT 1`).get(workspaceId, value, aliasType, value, value)) as { id: string; name: string } | undefined;
  };
  return await (lookup('domain', domain)) ?? await (lookup('name', normalizedName));
}
function dateTimeInZone(date: string, hour: number, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error('Choose a valid follow-up date.');
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour);
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess));
    const value = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
    const represented = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);
    const difference = target - represented;
    guess += difference;
    if (!difference) break;
  }
  const local = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess));
  const parts = Object.fromEntries(local.map((part) => [part.type, part.value]));
  if (`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` !== `${date}T${String(hour).padStart(2, '0')}:00`) throw new Error('That follow-up time could not be set in the event time zone. Choose another date.');
  return new Date(guess).toISOString();
}
const freeEmailDomains = new Set(['gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','yahoo.com','icloud.com','aol.com','proton.me','protonmail.com','me.com']);
function businessDomain(value: string) {
  try {
    const domain = new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, '');
    return domain && domain.includes('.') ? domain : '';
  } catch { return ''; }
}
function emailDomain(value: string) {
  const domain = value.toLowerCase().split('@')[1]?.trim() ?? '';
  return domain.includes('.') && !freeEmailDomains.has(domain) ? domain : '';
}
function editDistance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

export type LeadInput = {
  scanId: string;
  name: string;
  title: string;
  company: string;
  email: string;
  phone: string;
  website: string;
  quality: 'hot' | 'warm' | 'cold' | null;
  note: string;
  followUpDate: string | null;
  productIds: string[];
  companyChoice?: string;
  samePersonContactId?: string;
  differentPerson?: boolean;
};

export async function saveScannedLead(actorId: string, workspaceId: string, input: LeadInput) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const scan = await (db.prepare(`SELECT s.id,s.event_id,s.status,s.contact_id,s.created_by,e.time_zone AS event_time_zone FROM scans s LEFT JOIN events e ON e.id=s.event_id AND e.workspace_id=s.workspace_id WHERE s.id=? AND s.workspace_id=?`).get(input.scanId, workspaceId)) as
    { id: string; event_id: string | null; status: string; contact_id: string | null; created_by: string | null; event_time_zone: string | null } | undefined;
  if (!scan) throw new Error('This photo is no longer available. Add it again.');
  if (scan.event_id && !await (db.prepare(`SELECT 1 FROM event_access WHERE workspace_id=? AND event_id=? AND user_id=?`).get(workspaceId, scan.event_id, actorId))) {
    throw new AccessDeniedError('You no longer have access to this event. Ask your admin for access.');
  }
  if (!scan.event_id && scan.created_by !== actorId) throw new AccessDeniedError('You no longer have access to this photo.');
  if (scan.status === 'saved' && scan.contact_id) return { saved: true as const, duplicate: true, contactId: scan.contact_id };
  if (!['ready','failed'].includes(scan.status)) throw new Error('This photo is still being read. Wait a moment and try again.');
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const emailNormalized = email;
  const phone = input.phone.trim();
  const phoneNormalized = phone.replace(/[^+\d]/g, '');
  if (!name || (!emailNormalized && !phoneNormalized)) throw new Error('Add a name and an email address or phone number to save.');
  const productIds = [...new Set(input.productIds)];
  if (productIds.length > 12) throw new Error('Choose up to 12 products of interest.');
  if (productIds.length) {
    const availableProducts = await (db.prepare(`SELECT id FROM products WHERE workspace_id=? AND archived_at IS NULL AND id IN (${productIds.map(() => '?').join(',')})`).all(workspaceId, ...productIds)) as Array<{ id: string }>;
    if (availableProducts.length !== productIds.length) throw new Error('One of those products is no longer available. Refresh and try again.');
  }
  const personMatch = await (db.prepare(`SELECT c.id,c.name,c.company_id,co.name AS company_name FROM contacts c
    JOIN companies co ON co.id=c.company_id AND co.workspace_id=c.workspace_id
    WHERE c.workspace_id=? AND c.deleted_at IS NULL AND c.archived_at IS NULL
      AND (c.owner_user_id=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id=c.workspace_id AND m.user_id=? AND m.status='active' AND m.role='admin')
        OR EXISTS (SELECT 1 FROM encounters en JOIN event_access ea ON ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id
          WHERE en.workspace_id=c.workspace_id AND en.contact_id=c.id AND ea.user_id=?))
      AND ((?<>'' AND c.email_normalized=?) OR (?<>'' AND c.phone_normalized=?)) LIMIT 1`)
    .get(workspaceId, actorId, actorId, actorId, emailNormalized, emailNormalized, phoneNormalized, phoneNormalized)) as
      { id: string; name: string; company_id: string; company_name: string } | undefined;
  let companyCandidates: Array<{ id: string; name: string; people_count: number }> = [];
  const normalizedName = normalizeCompanyName(input.company);
  const websiteDomain = businessDomain(input.website);
  const emailBusinessDomain = emailDomain(email);
  const domain = websiteDomain || emailBusinessDomain;
  if (input.company.trim() && normalizedName) {
    const exactName = await (findExactCompany(workspaceId, normalizedName, domain));
    if (exactName && !await (companyAccessible(actorId, workspaceId, exactName.id))) {
      throw new Error('This lead cannot be saved with those company details. Ask your admin for help.');
    }
    if (!exactName) {
      const candidates = await (db.prepare(`SELECT co.id,co.name,co.normalized_name,COUNT(c.id) AS people_count FROM companies co
        LEFT JOIN contacts c ON c.company_id=co.id AND c.workspace_id=co.workspace_id AND c.deleted_at IS NULL AND c.archived_at IS NULL
          AND (c.owner_user_id=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id=c.workspace_id AND m.user_id=? AND m.status='active' AND m.role='admin')
            OR EXISTS (SELECT 1 FROM encounters en JOIN event_access ea ON ea.workspace_id=en.workspace_id AND ea.event_id=en.event_id
              WHERE en.workspace_id=c.workspace_id AND en.contact_id=c.id AND ea.user_id=?))
        WHERE co.workspace_id=? AND co.archived_at IS NULL GROUP BY co.id ORDER BY co.name`).all(actorId, actorId, actorId, workspaceId)) as Array<{ id: string; name: string; normalized_name: string; people_count: number }>;
      const similarCandidates = candidates.filter((candidate) => candidate.normalized_name && candidate.normalized_name !== normalizedName &&
        (editDistance(candidate.normalized_name, normalizedName) <= 2 || Math.min(candidate.normalized_name.length, normalizedName.length) / Math.max(candidate.normalized_name.length, normalizedName.length) >= 0.82 && editDistance(candidate.normalized_name, normalizedName) <= 4));
      const candidateChecks = await Promise.all(similarCandidates.map(async (candidate) => ({
        candidate,
        accessible: await companyAccessible(actorId, workspaceId, candidate.id),
      })));
      companyCandidates = candidateChecks.filter((item) => item.accessible).slice(0, 3)
        .map(({ candidate: { id, name, people_count } }) => ({ id, name, people_count }));
    }
  }
  const samePersonAccepted = !!personMatch && input.samePersonContactId === personMatch.id;
  const samePersonDeclined = !!personMatch && input.differentPerson === true;
  const companyWasChosen = !!input.companyChoice && (input.companyChoice === 'create' || companyCandidates.some((item) => item.id === input.companyChoice));
  const exactCompany = await (findExactCompany(workspaceId, normalizedName, domain));
  if (personMatch && !samePersonAccepted && !samePersonDeclined) {
    return { saved: false as const, needsSamePerson: true, candidate: { id: personMatch.id, name: personMatch.name, companyName: personMatch.company_name } };
  }
  if ((!personMatch || samePersonDeclined) && !exactCompany && companyCandidates.length && !companyWasChosen) {
    return { saved: false as const, needsCompanyDecision: true, candidates: companyCandidates };
  }

  return await (db.transaction(async () => {
    let companyId = '';
    let contactId = '';
    if (samePersonAccepted && personMatch) {
      if (!await (contactAccessible(actorId, workspaceId, personMatch.id))) throw new Error('This person is no longer available in your event. Ask your admin for access.');
      contactId = personMatch.id;
      companyId = personMatch.company_id;
    } else {
      let company = exactCompany;
      if (input.companyChoice && input.companyChoice !== 'create') {
        company = await (db.prepare(`SELECT id,name FROM companies WHERE workspace_id=? AND id=? AND archived_at IS NULL`).get(workspaceId, input.companyChoice)) as { id: string; name: string } | undefined;
        if (!company || !await (companyAccessible(actorId, workspaceId, company.id))) throw new Error('This lead cannot be saved with those company details. Ask your admin for help.');
      }
      if (company && !await (companyAccessible(actorId, workspaceId, company.id))) throw new Error('This lead cannot be saved with those company details. Ask your admin for help.');
      if (!company && input.companyChoice === 'create' && companyCandidates.length && !companyWasChosen) throw new Error('Choose whether this is the same company.');
      if (!company) {
        const title = input.company.trim() || 'No company provided';
        const normalized = normalizedName || 'no-company-provided';
        const companyIdNew = randomUUID();
        await (db.prepare(`INSERT INTO companies(id,workspace_id,name,normalized_name,website,normalized_domain) VALUES (?,?,?,?,?,?)
          ON CONFLICT(workspace_id,normalized_name) DO NOTHING`).run(companyIdNew, workspaceId, title, normalized, input.website.trim(), domain || null));
        company = await (db.prepare(`SELECT id,name FROM companies WHERE workspace_id=? AND normalized_name=? LIMIT 1`).get(workspaceId, normalized)) as { id: string; name: string };
      }
      companyId = company.id;
      contactId = randomUUID();
      await (db.prepare(`INSERT INTO contacts(id,workspace_id,company_id,name,title,email,email_normalized,phone,phone_normalized,quality,stage,owner_user_id,website)
        VALUES (?,?,?,?,?,?,?,?,?,?,'new',?,?)`).run(contactId, workspaceId, companyId, name, input.title.trim(), email, emailNormalized, phone, phoneNormalized, input.quality, actorId, input.website.trim()));
    }
    await (db.prepare(`INSERT OR IGNORE INTO encounters(id,workspace_id,contact_id,event_id,scan_id) VALUES (?,?,?,?,?)`)
      .run(randomUUID(), workspaceId, contactId, scan.event_id, scan.id));
    const encounter = await (db.prepare(`SELECT id FROM encounters WHERE scan_id=?`).get(scan.id)) as { id: string } | undefined;
    if (input.note.trim()) await (db.prepare(`INSERT INTO notes(id,workspace_id,contact_id,encounter_id,created_by,kind,body) VALUES (?,?,?,?,?,'text',?)`)
      .run(randomUUID(), workspaceId, contactId, encounter?.id ?? null, actorId, input.note.trim()));
    const insertProductInterest = db.prepare(`INSERT OR IGNORE INTO contact_products(workspace_id,contact_id,product_id) VALUES (?,?,?)`);
    for (const productId of productIds) await (insertProductInterest.run(workspaceId, contactId, productId));
    if (input.followUpDate) {
      const timeZone = scan.event_time_zone || 'UTC';
      const dueAt = dateTimeInZone(input.followUpDate, 9, timeZone);
      await (db.prepare(`INSERT INTO tasks(id,workspace_id,contact_id,event_id,kind,status,due_at,time_zone,title,created_by)
        VALUES (?,?,?,?,'follow_up','open',?,?,'Follow up',?)`).run(randomUUID(), workspaceId, contactId, scan.event_id, dueAt, timeZone, actorId));
    }
    await (db.prepare(`UPDATE contacts SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1 WHERE id=? AND workspace_id=?`).run(contactId, workspaceId));
    await (db.prepare(`UPDATE scans SET status='saved',contact_id=?,saved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND workspace_id=? AND status<>'saved'`).run(contactId, scan.id, workspaceId));
    return { saved: true as const, duplicate: false, contactId, companyId, encounterId: encounter?.id ?? null };
  })());
}

export type MaterialInput = { scanId: string; company: string; website: string; items: string[]; companyChoice?: string };

export async function saveScannedMaterial(actorId: string, workspaceId: string, input: MaterialInput) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const workspace = await (workspaceForActor(actorId, workspaceId));
  if (!workspace || workspace.kind !== 'company') throw new Error('Company brochures can only be saved in a company workspace.');
  const scan = await (db.prepare(`SELECT id,event_id,status,contact_id,created_by,image_path,image_mime,material_company_id FROM scans WHERE id=? AND workspace_id=?`)
    .get(input.scanId, workspaceId)) as { id: string; event_id: string | null; status: string; contact_id: string | null; created_by: string | null; image_path: string | null; image_mime: string | null; material_company_id: string | null } | undefined;
  if (!scan || !scan.image_path || !scan.image_mime) throw new Error('This photo is no longer available. Add it again.');
  if (scan.event_id && !await (db.prepare(`SELECT 1 FROM event_access WHERE workspace_id=? AND event_id=? AND user_id=?`).get(workspaceId, scan.event_id, actorId))) {
    throw new AccessDeniedError('You no longer have access to this event. Ask your admin for access.');
  }
  if (!scan.event_id && scan.created_by !== actorId) throw new AccessDeniedError('You no longer have access to this photo.');
  if (scan.material_company_id) {
    const savedCompany = await (db.prepare(`SELECT id,name FROM companies WHERE workspace_id=? AND id=?`).get(workspaceId, scan.material_company_id)) as { id: string; name: string } | undefined;
    return { saved: true as const, duplicate: true, companyId: savedCompany?.id, companyName: savedCompany?.name };
  }
  if (!['ready','failed','saved'].includes(scan.status) || scan.status === 'saved' && !scan.contact_id) {
    throw new Error('This photo is still being read. Wait a moment and try again.');
  }
  const title = input.company.trim();
  const normalizedName = normalizeCompanyName(title);
  const website = input.website.trim();
  const items = [...new Set(input.items.map((item) => item.trim()).filter(Boolean))].slice(0, 12);
  if (!title || !normalizedName) throw new Error('Add the company name shown on the brochure.');
  const domain = businessDomain(website);
  const visibleCompanies = await (listCompanies(actorId, workspaceId));
  const visibleIds = new Set(visibleCompanies.map((company) => String(company.id)));
  const exactCompany = await (findExactCompany(workspaceId, normalizedName, domain));
  if (exactCompany && !visibleIds.has(exactCompany.id)) throw new Error('That company is outside your event access. Ask an admin to grant access before adding this material.');

  const candidates = exactCompany ? [] : (await (db.prepare(`SELECT co.id,co.name,co.normalized_name,COUNT(c.id) AS people_count
      FROM companies co LEFT JOIN contacts c ON c.company_id=co.id AND c.workspace_id=co.workspace_id AND c.deleted_at IS NULL
      WHERE co.workspace_id=? AND co.archived_at IS NULL GROUP BY co.id ORDER BY co.name`).all(workspaceId)) as Array<{ id: string; name: string; normalized_name: string; people_count: number }>)
    .filter((company) => visibleIds.has(company.id) && company.normalized_name && company.normalized_name !== normalizedName &&
      (companyCoreName(company.name) === companyCoreName(title) || editDistance(company.normalized_name, normalizedName) <= 2 || Math.min(company.normalized_name.length, normalizedName.length) / Math.max(company.normalized_name.length, normalizedName.length) >= 0.82 && editDistance(company.normalized_name, normalizedName) <= 4))
    .slice(0, 3).map(({ id, name, people_count }) => ({ id, name, people_count }));
  if (!exactCompany && candidates.length && !input.companyChoice) return { saved: false as const, needsCompanyDecision: true, candidates };
  if (input.companyChoice && input.companyChoice !== 'create' && !candidates.some((candidate) => candidate.id === input.companyChoice)) {
    throw new Error('Choose a company from the suggestions or create a new company.');
  }

  return await (db.transaction(async () => {
    let company = exactCompany;
    if (input.companyChoice && input.companyChoice !== 'create') {
      company = await (db.prepare(`SELECT id,name FROM companies WHERE workspace_id=? AND id=? AND archived_at IS NULL`).get(workspaceId, input.companyChoice)) as { id: string; name: string } | undefined;
      if (!company || !visibleIds.has(company.id)) throw new Error('That company is no longer available. Choose it again.');
    }
    if (!company) {
      const id = randomUUID();
      await (db.prepare(`INSERT OR IGNORE INTO companies(id,workspace_id,name,normalized_name,website,normalized_domain) VALUES (?,?,?,?,?,?)`)
        .run(id, workspaceId, title, normalizedName, website, domain || null));
      company = await (findExactCompany(workspaceId, normalizedName, domain));
      if (!company) throw new Error('The company could not be saved. Review the website and company name.');
    }
    const extracted = await (db.prepare(`SELECT extracted_json FROM scans WHERE id=? AND workspace_id=?`).get(scan.id, workspaceId)) as { extracted_json: string | null } | undefined;
    let read: Record<string, unknown> = {};
    try { read = extracted?.extracted_json ? JSON.parse(extracted.extracted_json) as Record<string, unknown> : {}; } catch { /* Replace invalid extraction with only the values the person confirmed. */ }
    const confirmedExtraction = { ...read, products: items, topics: [] };
    await (db.prepare(`UPDATE scans SET material_company_id=?,status='saved',extracted_json=?,saved_at=COALESCE(saved_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=? AND workspace_id=?`)
      .run(company.id, JSON.stringify(confirmedExtraction), scan.id, workspaceId));
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,details_json) VALUES (?,?,?,'company_material_saved','company',?,?)`)
      .run(randomUUID(), workspaceId, actorId, company.id, JSON.stringify({ scanId: scan.id, eventId: scan.event_id, items })));
    return { saved: true as const, duplicate: false, companyId: company.id, companyName: company.name };
  })());
}

export async function removeScannedMaterial(actorId: string, workspaceId: string, scanId: string) {
  await (assertWorkspaceAccess(actorId, workspaceId));
  const scan = await (db.prepare(`SELECT event_id,created_by,contact_id,material_company_id FROM scans WHERE id=? AND workspace_id=?`).get(scanId, workspaceId)) as
    { event_id: string | null; created_by: string | null; contact_id: string | null; material_company_id: string | null } | undefined;
  if (!scan || !scan.material_company_id) return false;
  if (scan.event_id ? !await (db.prepare(`SELECT 1 FROM event_access WHERE workspace_id=? AND event_id=? AND user_id=?`).get(workspaceId, scan.event_id, actorId)) : scan.created_by !== actorId) {
    throw new AccessDeniedError('You no longer have access to this material.');
  }
  return await (db.transaction(async () => {
    await (db.prepare(`UPDATE scans SET material_company_id=NULL,status=CASE WHEN contact_id IS NULL THEN 'ready' ELSE 'saved' END,
      saved_at=CASE WHEN contact_id IS NULL THEN NULL ELSE saved_at END WHERE id=? AND workspace_id=? AND material_company_id IS NOT NULL`).run(scanId, workspaceId));
    await (db.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,target_type,target_id) VALUES (?,?,?,'company_material_removed','scan',?)`)
      .run(randomUUID(), workspaceId, actorId, scanId));
    return true;
  })());
}

export async function createBackup(targetPath: string) {
  if (postgresMode) throw new Error('PostgreSQL backups must use the managed database backup or export process.');
  mkdirSync(dirname(targetPath), { recursive: true });
  return db.backup(targetPath);
}

export async function seedDemoData(passwordHash: string) {
  type DemoVoiceFixture = { id: string; workspaceId: string; contactId: string; encounterId: string; file: string; transcript: string; durationSeconds: number; mimeType: string };
  const voiceFixtures = JSON.parse(readFileSync(resolve('public/demo/sample-voice-notes.json'), 'utf8')) as DemoVoiceFixture[];
  const uploadsRoot = resolve(process.env.UPLOADS_PATH ?? 'uploads');
  const privateVoiceFixtures = voiceFixtures.map((fixture) => {
    if (!/^a1000000-0000-4000-8000-00000000000[1-3]$/.test(fixture.id) || fixture.file !== basename(fixture.file) || fixture.mimeType !== 'audio/wav') {
      throw new Error('A bundled sample voice note has invalid details.');
    }
    const source = resolve('public/demo', fixture.file);
    const audioPath = resolve(uploadsRoot, fixture.workspaceId, 'voice-notes', `${fixture.id}.wav`);
    mkdirSync(dirname(audioPath), { recursive: true });
    copyFileSync(source, audioPath);
    return { ...fixture, audioPath };
  });
  const accounts = [
    { id: 'demo-owner', name: 'Maya Chen', email: 'maya@gather.test', kind: 'company' as const, role: 'admin' as const, workspaceId: 'demo-northstar', workspaceName: 'Northstar Packaging' },
    { id: 'demo-manager', name: 'Priya Shah', email: 'priya@gather.test', kind: 'company' as const, role: 'manager' as const, workspaceId: 'demo-northstar', workspaceName: 'Northstar Packaging' },
    { id: 'demo-rep', name: 'Jordan Lee', email: 'jordan@gather.test', kind: 'company' as const, role: 'representative' as const, workspaceId: 'demo-northstar', workspaceName: 'Northstar Packaging' },
    { id: 'demo-other-company', name: 'Alex Rivera', email: 'alex@gather.test', kind: 'company' as const, role: 'admin' as const, workspaceId: 'demo-riverbend', workspaceName: 'Riverbend Supply' },
    { id: 'demo-attendee-one', name: 'Sam Patel', email: 'sam@gather.test', kind: 'personal' as const, role: 'attendee' as const, workspaceId: 'demo-sam-space', workspaceName: "Sam's private space" },
    { id: 'demo-attendee-two', name: 'Riley Morgan', email: 'riley@gather.test', kind: 'personal' as const, role: 'attendee' as const, workspaceId: 'demo-riley-space', workspaceName: "Riley's private space" },
  ];
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1)).toISOString();
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 2)).toISOString();
  await (db.transaction(async () => {
    for (const account of accounts) {
      await (db.prepare(`INSERT INTO users(id,name,email,password_hash,email_verified_at) VALUES (?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(email) DO UPDATE SET name=excluded.name,password_hash=excluded.password_hash,disabled_at=NULL`).run(account.id, account.name, account.email, passwordHash));
      await (db.prepare(`INSERT INTO workspaces(id,kind,name,owner_user_id) VALUES (?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name`).run(account.workspaceId, account.kind, account.workspaceName, account.id));
      await (db.prepare(`INSERT INTO memberships(workspace_id,user_id,role,status) VALUES (?,?,?,'active')
        ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,status='active'`).run(account.workspaceId, account.id, account.role));
    }
    const eventSeed = [
      ['event-main-active', 'demo-northstar', 'Pacific Packaging Expo', start, end, 'America/Los_Angeles', 1],
      ['event-main-ended', 'demo-northstar', 'West Coast Retail Show', new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 31)).toISOString(), new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 29)).toISOString(), 'America/Los_Angeles', 0],
      ['event-riverbend', 'demo-riverbend', 'Pacific Packaging Expo', start, end, 'America/Los_Angeles', 1],
      ['event-sam-private', 'demo-sam-space', 'Pacific Packaging Expo', start, end, 'America/Los_Angeles', 1],
      ['event-riley-private', 'demo-riley-space', 'Pacific Packaging Expo', start, end, 'America/Los_Angeles', 1],
    ] as const;
    const insertEvent = db.prepare(`INSERT INTO events(id,workspace_id,name,starts_at,ends_at,time_zone,is_active) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,starts_at=excluded.starts_at,ends_at=excluded.ends_at,time_zone=excluded.time_zone,is_active=excluded.is_active`);
    for (const event of eventSeed) await (insertEvent.run(...event));
    for (const account of accounts.filter((item) => item.role === 'admin' || item.role === 'manager' || item.role === 'representative')) {
      const eventId = account.workspaceId === 'demo-northstar' ? 'event-main-active' : 'event-riverbend';
      await (db.prepare(`INSERT OR IGNORE INTO event_access(workspace_id,event_id,user_id) VALUES (?,?,?)`).run(account.workspaceId, eventId, account.id));
    }
    for (const account of accounts.filter((item) => item.kind === 'personal')) {
      const eventId = account.workspaceId === 'demo-sam-space' ? 'event-sam-private' : 'event-riley-private';
      await (db.prepare(`INSERT OR IGNORE INTO event_access(workspace_id,event_id,user_id) VALUES (?,?,?)`).run(account.workspaceId, eventId, account.id));
    }
    const companies = [
      ['demo-ns-acme', 'demo-northstar', 'Acme Packaging', 'acmepackaging', null],
      ['demo-ns-juniper', 'demo-northstar', 'Juniper Foods', 'juniperfoods', null],
      ['demo-ns-morrow', 'demo-northstar', 'Morrow Market', 'morrowmarket', null],
      ['demo-ns-sora', 'demo-northstar', 'Sora Supply', 'sorasupply', null],
      ['demo-ns-bluebird', 'demo-northstar', 'Bluebird Labs', 'bluebirdlabs', null],
      ['demo-ns-cedar', 'demo-northstar', 'Cedar & Slate', 'cedarslate', null],
      ['demo-ns-lumen', 'demo-northstar', 'Lumen Home', 'lumenhome', null],
      ['demo-ns-harbor', 'demo-northstar', 'Harbor Goods', 'harborgoods', null],
      ['demo-ns-vale', 'demo-northstar', 'Vale Outdoor', 'valeoutdoor', null],
      ['demo-ns-novo', 'demo-northstar', 'Novo Pantry', 'novopantry', null],
      ['demo-ns-orbit', 'demo-northstar', 'Orbit Medical', 'orbitmedical', null],
      ['demo-ns-fieldnote', 'demo-northstar', 'Fieldnote Studio', 'fieldnotestudio', null],
      ['demo-rb-acme', 'demo-riverbend', 'Acme Packaging', 'acmepackaging', null],
      ['demo-sam-company', 'demo-sam-space', 'Sam Patel', 'sampatel', null],
      ['demo-riley-company', 'demo-riley-space', 'Riley Morgan', 'rileymorgan', null],
    ] as const;
    const insertCompany = db.prepare(`INSERT INTO companies(id,workspace_id,name,normalized_name,website,normalized_domain,deal_value_minor,deal_status)
      VALUES (?,?,?,?,?,NULL,NULL,NULL) ON CONFLICT(id) DO UPDATE SET name=excluded.name,normalized_name=excluded.normalized_name`);
    for (const company of companies) await (insertCompany.run(company[0], company[1], company[2], company[3], company[4]));
    const seededDeals = [
      ['demo-ns-acme', 125000, 'won'], ['demo-ns-juniper', 800000, 'open'], ['demo-ns-morrow', 450000, 'open'],
      ['demo-ns-sora', 500000, 'lost'], ['demo-ns-bluebird', 900000, 'open'], ['demo-ns-cedar', 125000, 'open'],
    ] as const;
    for (const [companyId, dealValue, dealStatus] of seededDeals) {
      await (db.prepare(`UPDATE companies SET deal_value_minor=?,deal_status=? WHERE id=? AND workspace_id='demo-northstar'`).run(dealValue, dealStatus, companyId));
    }
    const contacts = [
      ['demo-ns-contact-1','demo-northstar','demo-ns-acme','Tessa Morgan','Procurement Director','tessa@acmepackaging.example','+1 415 555 0121','warm','contacted','demo-owner'],
      ['demo-ns-contact-2','demo-northstar','demo-ns-acme','Noah Price','Packaging Buyer','noah@acmepackaging.example','','hot','meeting','demo-rep'],
      ['demo-ns-contact-3','demo-northstar','demo-ns-juniper','Mina Park','Operations Lead','mina@juniperfoods.example','','warm','new','demo-rep'],
      ['demo-ns-contact-4','demo-northstar','demo-ns-morrow','Eli Torres','Category Manager','eli@morrowmarket.example','','cold','replied','demo-owner'],
      ['demo-ns-contact-5','demo-northstar','demo-ns-sora','Ari Patel','Founder','ari@sorasupply.example','+1 415 555 0125','warm','new','demo-rep'],
      ['demo-ns-contact-6','demo-northstar','demo-ns-bluebird','June Kim','Lab Manager','june@bluebirdlabs.example','','hot','contacted','demo-owner'],
      ['demo-ns-contact-10','demo-northstar','demo-ns-acme','Olivia Bennett','Sourcing Manager','olivia@acmepackaging.example','+1 415 555 0130','warm','replied','demo-manager'],
      ['demo-ns-contact-11','demo-northstar','demo-ns-juniper','Luca Jameson','Supply Planner','luca@juniperfoods.example','+1 415 555 0131','cold','new','demo-rep'],
      ['demo-ns-contact-12','demo-northstar','demo-ns-juniper','Vera Cole','Brand Director','vera@juniperfoods.example','+1 415 555 0132','hot','contacted','demo-owner'],
      ['demo-ns-contact-13','demo-northstar','demo-ns-morrow','Nathan Wells','Retail Buyer','nathan@morrowmarket.example','+1 415 555 0133','warm','meeting','demo-manager'],
      ['demo-ns-contact-14','demo-northstar','demo-ns-morrow','Imani Green','Packaging Engineer','imani@morrowmarket.example','+1 415 555 0134','cold','new','demo-rep'],
      ['demo-ns-contact-15','demo-northstar','demo-ns-sora','Kai Foster','Commercial Lead','kai@sorasupply.example','+1 415 555 0135','warm','contacted','demo-owner'],
      ['demo-ns-contact-16','demo-northstar','demo-ns-bluebird','Mira Singh','Research Buyer','mira@bluebirdlabs.example','+1 415 555 0136','hot','replied','demo-manager'],
      ['demo-ns-contact-17','demo-northstar','demo-ns-cedar','Charlie Moon','Co-founder','charlie@cedarslate.example','+1 415 555 0137','warm','new','demo-rep'],
      ['demo-ns-contact-18','demo-northstar','demo-ns-cedar','Lila Brooks','Operations Director','lila@cedarslate.example','+1 415 555 0138','cold','contacted','demo-owner'],
      ['demo-ns-contact-19','demo-northstar','demo-ns-lumen','Finn Gallagher','Product Lead','finn@lumenhome.example','+1 415 555 0139','hot','meeting','demo-manager'],
      ['demo-ns-contact-20','demo-northstar','demo-ns-lumen','Sara Ali','Purchasing Lead','sara@lumenhome.example','+1 415 555 0140','warm','new','demo-rep'],
      ['demo-ns-contact-21','demo-northstar','demo-ns-harbor','Ethan Park','Owner','ethan@harborgoods.example','+1 415 555 0141','cold','contacted','demo-owner'],
      ['demo-ns-contact-22','demo-northstar','demo-ns-harbor','Stella Ross','Merchandising Lead','stella@harborgoods.example','+1 415 555 0142','warm','replied','demo-manager'],
      ['demo-ns-contact-23','demo-northstar','demo-ns-vale','Miles Avery','Category Buyer','miles@valeoutdoor.example','+1 415 555 0143','hot','new','demo-rep'],
      ['demo-ns-contact-24','demo-northstar','demo-ns-vale','Rory James','Sustainability Lead','rory@valeoutdoor.example','+1 415 555 0144','warm','contacted','demo-owner'],
      ['demo-ns-contact-25','demo-northstar','demo-ns-vale','Theo Chen','Product Designer','theo@valeoutdoor.example','+1 415 555 0145','cold','meeting','demo-manager'],
      ['demo-ns-contact-26','demo-northstar','demo-ns-novo','Leah Kim','Brand Manager','leah@novopantry.example','+1 415 555 0146','warm','new','demo-rep'],
      ['demo-ns-contact-27','demo-northstar','demo-ns-novo','Cole Rivera','Operations Buyer','cole@novopantry.example','+1 415 555 0147','hot','contacted','demo-owner'],
      ['demo-ns-contact-28','demo-northstar','demo-ns-novo','Ava Nguyen','Founder','ava@novopantry.example','+1 415 555 0148','cold','replied','demo-manager'],
      ['demo-ns-contact-29','demo-northstar','demo-ns-orbit','Grace Wilson','Purchasing Manager','grace@orbitmedical.example','+1 415 555 0149','warm','new','demo-rep'],
      ['demo-ns-contact-30','demo-northstar','demo-ns-orbit','David Ibrahim','Lab Operations Lead','david@orbitmedical.example','+1 415 555 0150','hot','contacted','demo-owner'],
      ['demo-ns-contact-31','demo-northstar','demo-ns-orbit','Sasha Bell','Quality Director','sasha@orbitmedical.example','+1 415 555 0151','cold','meeting','demo-manager'],
      ['demo-ns-contact-32','demo-northstar','demo-ns-fieldnote','Rowan Ellis','Creative Director','rowan@fieldnotestudio.example','+1 415 555 0152','warm','new','demo-rep'],
      ['demo-ns-contact-33','demo-northstar','demo-ns-fieldnote','Lucy Martin','Studio Manager','lucy@fieldnotestudio.example','+1 415 555 0153','hot','contacted','demo-owner'],
      ['demo-rb-contact-1','demo-riverbend','demo-rb-acme','Tessa Morgan','Procurement Director','tessa@acmepackaging.example','','warm','contacted','demo-other-company'],
      ['demo-sam-contact-1','demo-sam-space','demo-sam-company','Morgan Ellis','Product Designer','morgan@studio.example','','warm','new','demo-attendee-one'],
      ['demo-riley-contact-1','demo-riley-space','demo-riley-company','Casey Lane','Account Lead','casey@partner.example','','cold','new','demo-attendee-two'],
    ] as const;
    const insertContact = db.prepare(`INSERT INTO contacts(id,workspace_id,company_id,name,title,email,email_normalized,phone,phone_normalized,quality,stage,owner_user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,title=excluded.title,email=excluded.email,email_normalized=excluded.email_normalized,phone=excluded.phone,phone_normalized=excluded.phone_normalized,quality=excluded.quality,stage=excluded.stage`);
    for (const contact of contacts) await (insertContact.run(contact[0], contact[1], contact[2], contact[3], contact[4], contact[5], contact[5], contact[6], contact[6].replace(/[^+\d]/g,''), contact[7], contact[8], contact[9]));
    const products = [
      ['demo-product-carton','demo-northstar','Flexible cartons','Short production runs with recyclable materials.'],
      ['demo-product-mailer','demo-northstar','Recycled mailers','Lightweight shipping mailers for ecommerce.'],
      ['demo-product-display','demo-northstar','Retail displays','Counter and shelf display packaging.'],
    ] as const;
    const insertProduct = db.prepare(`INSERT INTO products(id,workspace_id,name,description) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description`);
    for (const product of products) await (insertProduct.run(...product));
    // The sample company's details, so AI drafts show how a filled-in profile reads. Edits made in Settings are kept.
    await (db.prepare(`INSERT INTO workspace_settings(workspace_id,key,value_json) VALUES ('demo-northstar','knowledge',?) ON CONFLICT(workspace_id,key) DO NOTHING`).run(JSON.stringify({
      whatYouSell: 'Recyclable and custom-printed packaging for retail and ecommerce brands: recycled mailers, flexible cartons and retail displays. Short runs from 500 units, printed at our own plant in California.',
      ourRole: 'We are a packaging manufacturer. We meet retail and ecommerce brands at trade shows, send samples and help them choose packaging for a product launch.',
      tone: 'Friendly',
      signature: 'The Northstar Packaging Team\nnorthstarpackaging.example · +1 415 555 0100',
      neverPromise: 'Prices, discounts, delivery dates, or free samples. A team member confirms these personally.',
      productsText: 'Flexible cartons — short production runs with recyclable materials\nRecycled mailers — lightweight shipping mailers for ecommerce\nRetail displays — counter and shelf display packaging',
    })));
    await (db.prepare(`INSERT OR IGNORE INTO contact_products(workspace_id,contact_id,product_id) VALUES ('demo-northstar','demo-ns-contact-1','demo-product-carton'),('demo-northstar','demo-ns-contact-2','demo-product-mailer'),('demo-northstar','demo-ns-contact-5','demo-product-display')`).run());
    const followUpAt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 17, 0)).toISOString();
    await (db.prepare(`INSERT INTO tasks(id,workspace_id,contact_id,event_id,kind,status,due_at,time_zone,title,note,created_by)
      VALUES ('demo-task-noah','demo-northstar','demo-ns-contact-2','event-main-active','follow_up','open',?,'America/Los_Angeles','Send sample options','He asked for recyclable mailer sizes.','demo-rep')
      ON CONFLICT(id) DO UPDATE SET due_at=excluded.due_at,status='open'`).run(followUpAt));
    const yesterdayAt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1, 17, 0)).toISOString();
    const upcomingAt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 3, 17, 0)).toISOString();
    const meetingAt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1, 18, 0)).toISOString();
    const demoTasks = [
      ['demo-task-tessa-overdue','demo-ns-contact-1','follow_up','open',yesterdayAt,'Send Tessa the sample plan','She asked for short-run recyclable packaging details.','demo-owner'],
      ['demo-task-mina-today','demo-ns-contact-3','follow_up','open',followUpAt,'Check sample timing','Confirm the pack size and event timeline.','demo-rep'],
      ['demo-task-ari-upcoming','demo-ns-contact-5','follow_up','open',upcomingAt,'Share retail display ideas','Follow up next week with two examples.','demo-rep'],
      ['demo-task-eli-done','demo-ns-contact-4','follow_up','done',yesterdayAt,'Send market pack sizes','Sample follow-up completed.','demo-owner'],
      ['demo-task-june-meeting','demo-ns-contact-6','meeting','confirmed',meetingAt,'Product review meeting','Meeting confirmed for the day after the show.','demo-owner'],
      ['demo-task-rowan-no-show','demo-ns-contact-32','meeting','no_show',yesterdayAt,'Studio introduction','Sample meeting marked as a no-show.','demo-rep'],
    ] as const;
    const upsertTask = db.prepare(`INSERT INTO tasks(id,workspace_id,contact_id,event_id,kind,status,due_at,time_zone,title,note,created_by)
      VALUES (?,'demo-northstar',?,'event-main-active',?,?,?,'America/Los_Angeles',?,?,?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,status=excluded.status,due_at=excluded.due_at,title=excluded.title,note=excluded.note,created_by=excluded.created_by`);
    for (const [id, contactId, kind, status, dueAt, title, note, createdBy] of demoTasks) await (upsertTask.run(id, contactId, kind, status, dueAt, title, note, createdBy));
    await (db.prepare(`INSERT OR IGNORE INTO encounters(id,workspace_id,contact_id,event_id) VALUES
      ('demo-encounter-1','demo-northstar','demo-ns-contact-1','event-main-active'),
      ('demo-encounter-2','demo-northstar','demo-ns-contact-2','event-main-active'),
      ('demo-encounter-3','demo-northstar','demo-ns-contact-3','event-main-active')`).run());
    const insertEncounter = db.prepare(`INSERT OR IGNORE INTO encounters(id,workspace_id,contact_id,event_id) VALUES (?,?,?,?)`);
    for (const contact of contacts.filter((item) => item[1] === 'demo-northstar' && !['demo-ns-contact-1','demo-ns-contact-2','demo-ns-contact-3'].includes(item[0]))) {
      await (insertEncounter.run(`demo-encounter-${contact[0]}`, 'demo-northstar', contact[0], 'event-main-active'));
    }
    await (insertEncounter.run('demo-encounter-tessa-ended', 'demo-northstar', 'demo-ns-contact-1', 'event-main-ended'));
    await (insertEncounter.run('demo-encounter-sam-private', 'demo-sam-space', 'demo-sam-contact-1', 'event-sam-private'));
    await (insertEncounter.run('demo-encounter-riley-private', 'demo-riley-space', 'demo-riley-contact-1', 'event-riley-private'));
    await (db.prepare(`DELETE FROM notes WHERE id IN ('demo-note-1','demo-note-sam-private','demo-note-riley-private')`).run());
    await (db.prepare(`INSERT OR IGNORE INTO notes(id,workspace_id,contact_id,encounter_id,kind,body) VALUES
      ('demo-note-2','demo-northstar','demo-ns-contact-2','demo-encounter-2','text','Asked for recyclable mailer sizes and lead times.'),
      ('demo-note-3','demo-northstar','demo-ns-contact-1','demo-encounter-tessa-ended','text','Met again at the retail show. She asked about sample timing.'),
      ('demo-note-4','demo-northstar','demo-ns-contact-3','demo-encounter-3','text','Interested in a smaller case size for a seasonal launch.'),
      ('demo-note-5','demo-northstar','demo-ns-contact-5','demo-encounter-demo-ns-contact-5','text','Asked to see a recyclable shelf display sample.'),
      ('demo-note-6','demo-northstar','demo-ns-contact-6','demo-encounter-demo-ns-contact-6','text','Needs a materials sheet for the research team.')`).run());
    const saveDemoVoiceNote = db.prepare(`INSERT INTO notes(id,workspace_id,contact_id,encounter_id,kind,body,transcript,transcript_status,audio_path,audio_mime,duration_seconds)
      VALUES (?,?,?,?,'audio','',?,'manual',?,?,?)
      ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,contact_id=excluded.contact_id,encounter_id=excluded.encounter_id,kind='audio',body='',transcript=excluded.transcript,transcript_status='manual',audio_path=excluded.audio_path,audio_mime=excluded.audio_mime,duration_seconds=excluded.duration_seconds`);
    for (const fixture of privateVoiceFixtures) await (saveDemoVoiceNote.run(fixture.id, fixture.workspaceId, fixture.contactId, fixture.encounterId, fixture.transcript, fixture.audioPath, fixture.mimeType, fixture.durationSeconds));
    const seededVoiceCounts = await (db.prepare(`SELECT workspace_id,COUNT(*) AS total FROM notes WHERE kind='audio' GROUP BY workspace_id`).all()) as Array<{ workspace_id: string; total: number }>;
    const updateVoiceUsage = db.prepare(`INSERT INTO voice_note_usage(scope_id,created_count) VALUES (?,?) ON CONFLICT(scope_id) DO UPDATE SET created_count=MAX(created_count,excluded.created_count)`);
    for (const row of seededVoiceCounts) await (updateVoiceUsage.run(row.workspace_id, row.total));
    const serviceVoiceCount = (await (db.prepare(`SELECT COALESCE(SUM(created_count),0) AS total FROM voice_note_usage WHERE scope_id<>'__service__'`).get()) as { total: number }).total;
    await (updateVoiceUsage.run('__service__', serviceVoiceCount));
    const sampleMailDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 18, 0)).toISOString();
    await (db.prepare(`INSERT INTO emails(id,workspace_id,contact_id,encounter_id,recipient,subject,body,status,provider_message_id,error_message,approved_at,sent_to_server_at,created_at,created_by) VALUES
      ('demo-email-tessa-draft','demo-northstar','demo-ns-contact-1','demo-encounter-1','tessa@acmepackaging.example','Sample options for your next run','Hi Tessa,

It was great meeting you at Pacific Packaging Expo. I noted your interest in sample options for your next run. What would be most useful for me to send you next?

Best,
Maya','draft',NULL,NULL,NULL,NULL,?,'demo-owner'),
      ('demo-email-tessa-sent','demo-northstar','demo-ns-contact-1','demo-encounter-tessa-ended','tessa@acmepackaging.example','Following up from the retail show','Hi Tessa,

Thank you for speaking with us again at the retail show. Here are the sample details we went over. Let me know if anything looks off.

Best,
Maya','sent','sample-mail-server-accepted',NULL,?, ?,?,'demo-owner'),
      ('demo-email-noah-failed','demo-northstar','demo-ns-contact-2','demo-encounter-2','noah@acmepackaging.example','Mailer sizes and lead times','Here are the mailer sizes we discussed.','failed',NULL,'Sample data: test message was not accepted.',NULL,NULL,?,'demo-rep'),
      ('demo-email-mina-replied','demo-northstar','demo-ns-contact-3','demo-encounter-3','mina@juniperfoods.example','Seasonal case-size notes','I have attached the case-size notes from our conversation.','replied','sample-reply-recorded',NULL,?, ?,?,'demo-rep')
      ON CONFLICT(id) DO UPDATE SET recipient=excluded.recipient,subject=excluded.subject,body=excluded.body,status=excluded.status,provider_message_id=excluded.provider_message_id,error_message=excluded.error_message,approved_at=excluded.approved_at,sent_to_server_at=excluded.sent_to_server_at,created_at=excluded.created_at,created_by=excluded.created_by`).run(sampleMailDate, sampleMailDate, sampleMailDate, sampleMailDate, sampleMailDate, sampleMailDate, sampleMailDate, sampleMailDate));
  })());
}

export async function closeDatabase() {
  if (postgresMode) return closePostgres();
  return db.close();
}
