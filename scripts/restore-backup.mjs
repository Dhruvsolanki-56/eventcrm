import 'dotenv/config';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { verifyMedia } from './backup-media.mjs';

const source = process.argv[2] ? resolve(process.argv[2]) : '';
const target = resolve(process.env.DATABASE_PATH ?? 'data/gather.sqlite');
const uploadsTarget = resolve(process.env.UPLOADS_PATH ?? 'uploads');
if (!source) throw new Error('Usage: npm run restore -- <path-to-backup.sqlite>');
if (source === target) throw new Error('The backup and active database paths must be different.');
const sourceStat = await lstat(source);
if (sourceStat.isSymbolicLink()) throw new Error('Restore source must not be a symbolic link.');
const bundle = sourceStat.isDirectory();
let databaseSource = source;
let mediaSource = '';
let manifest;
const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
async function requireRegularFile(path) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Restore input must be a regular file: ${path}`);
}
if (bundle) {
  const manifestPath = join(source, 'manifest.json');
  databaseSource = join(source, 'database.sqlite');
  mediaSource = join(source, 'media');
  await requireRegularFile(manifestPath);
  await requireRegularFile(databaseSource);
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.format !== 'gather-backup-v1' || manifest.database?.path !== 'database.sqlite' || manifest.media?.directory !== 'media' || !Array.isArray(manifest.media.files) || manifest.media.fileCount !== manifest.media.files.length) throw new Error('This Gather backup bundle has an unsupported or invalid manifest.');
  if (await sha256(databaseSource) !== manifest.database.sha256) throw new Error('Backup database checksum does not match the manifest.');
  await verifyMedia(mediaSource, manifest.media.files);
} else {
  await requireRegularFile(source);
}
if (databaseSource === target) throw new Error('The backup and active database paths must be different.');
await mkdir(dirname(target), { recursive: true });
for (const sidecar of [`${target}-wal`, `${target}-shm`]) {
  try { await stat(sidecar); throw new Error(`Stop the Gather service and checkpoint SQLite before restoring; found ${sidecar}.`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (bundle) await mkdir(dirname(uploadsTarget), { recursive: true });

function integrity(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const result = db.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`SQLite integrity check failed for ${path}: ${result}`);
  } finally { db.close(); }
}
integrity(databaseSource);
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const staging = `${target}.restore-staging-${timestamp}`;
const safety = `${target}.before-restore-${timestamp}`;
const mediaStaging = `${uploadsTarget}.restore-staging-${timestamp}`;
const mediaSafety = `${uploadsTarget}.before-restore-${timestamp}`;
await copyFile(databaseSource, staging);
integrity(staging);
if (bundle) {
  await cp(mediaSource, mediaStaging, { recursive: true, errorOnExist: true, force: false });
  await verifyMedia(mediaStaging, manifest.media.files);
}
let movedCurrent = false;
let movedMedia = false;
let installedDatabase = false;
let installedMedia = false;
try {
  try { await rename(target, safety); movedCurrent = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (bundle) {
    try { await rename(uploadsTarget, mediaSafety); movedMedia = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await rename(staging, target);
  installedDatabase = true;
  if (bundle) {
    try {
      await rename(mediaStaging, uploadsTarget);
      installedMedia = true;
    } catch (error) {
      // Some Windows sync-managed folders reject directory renames with EPERM.
      // The source bundle has already been staged and checksum-verified, so copy
      // it into the now-empty destination and verify the installed inventory.
      if (!['EPERM', 'EXDEV', 'EBUSY'].includes(error?.code)) throw error;
      installedMedia = true;
      await cp(mediaStaging, uploadsTarget, { recursive: true, errorOnExist: true, force: false });
      await verifyMedia(uploadsTarget, manifest.media.files);
      await rm(mediaStaging, { recursive: true, force: true });
    }
  }
  integrity(target);
  if (bundle) await verifyMedia(uploadsTarget, manifest.media.files);
  console.info(`Restore complete. Previous database preserved at: ${movedCurrent ? safety : '(no previous database)'}. Previous media preserved at: ${bundle && movedMedia ? mediaSafety : '(not changed)'}`);
} catch (error) {
  if (installedDatabase) await rename(target, staging).catch(() => undefined);
  if (movedCurrent) await rename(safety, target).catch(() => undefined);
  if (installedMedia) await rm(uploadsTarget, { recursive: true, force: true }).catch(() => undefined);
  if (movedMedia) await rename(mediaSafety, uploadsTarget).catch(() => undefined);
  throw error;
}
