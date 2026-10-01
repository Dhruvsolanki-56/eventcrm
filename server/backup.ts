import 'dotenv/config';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { closeDatabase, createBackup, migrate } from './db.js';

await (migrate());
const directory = resolve(process.env.BACKUPS_PATH ?? 'backups');
mkdirSync(directory, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = resolve(directory, `gather-${timestamp}`);
const databaseTarget = join(target, 'database.sqlite');
const uploadsRoot = resolve(process.env.UPLOADS_PATH ?? 'uploads');
const mediaTarget = join(target, 'media');
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function mediaFiles(root: string, folder = root): Array<{ path: string; size: number; sha256: string }> {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(folder, entry.name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to back up a media symlink: ${absolute}`);
    if (entry.isDirectory()) return mediaFiles(root, absolute);
    if (!entry.isFile()) throw new Error(`Refusing to back up a non-file media entry: ${absolute}`);
    return [{ path: relative(root, absolute).split(sep).join('/'), size: stat.size, sha256: digest(absolute) }];
  });
}
mkdirSync(target, { recursive: false });
try {
  await createBackup(databaseTarget);
  if (existsSync(uploadsRoot)) cpSync(uploadsRoot, mediaTarget, { recursive: true, errorOnExist: true, force: false });
  else mkdirSync(mediaTarget, { recursive: false });
  const files = mediaFiles(mediaTarget);
  writeFileSync(join(target, 'manifest.json'), JSON.stringify({
    format: 'gather-backup-v1', createdAt: new Date().toISOString(), database: { path: 'database.sqlite', sha256: digest(databaseTarget) },
    media: { directory: 'media', fileCount: files.length, files },
  }, null, 2));
  console.info(`Database and ${files.length} private media files backed up: ${target}`);
} catch (error) {
  rmSync(target, { recursive: true, force: true });
  throw error;
} finally {
  await (closeDatabase());
}
