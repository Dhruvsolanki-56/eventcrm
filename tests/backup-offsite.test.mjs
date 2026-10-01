import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findOldLocalBundles, readVerifiedBundlePath, replicateBundle } from '../scripts/backup-offsite.mjs';

const roots = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'gather-backup-ops-'));
  roots.push(root);
  return root;
}
function makeBundle(root, name, databaseContent = 'sqlite test') {
  const path = join(root, name);
  mkdirSync(join(path, 'media'), { recursive: true });
  const database = Buffer.from(databaseContent);
  writeFileSync(join(path, 'database.sqlite'), database);
  writeFileSync(join(path, 'manifest.json'), JSON.stringify({
    format: 'gather-backup-v1',
    database: { path: 'database.sqlite', sha256: createHash('sha256').update(database).digest('hex') },
    media: { directory: 'media', fileCount: 0, files: [] },
  }));
  return path;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('off-VM backup safety helpers', () => {
  it('accepts only a complete, checksummed bundle directly under BACKUPS_PATH', () => {
    const root = makeRoot();
    const path = makeBundle(root, 'gather-2026-09-29T11-00-00-000Z');
    const output = `Database and 0 private media files backed up: ${path}\n`;
    expect(readVerifiedBundlePath(output, root)).toBe(resolve(path));
    expect(() => readVerifiedBundlePath(`Database and 0 private media files backed up: ${join(root, '..', 'escape')}\n`, root)).toThrow(/outside/);
    writeFileSync(join(path, 'database.sqlite'), 'changed');
    expect(() => readVerifiedBundlePath(output, root)).toThrow(/checksum/);
    writeFileSync(join(path, 'database.sqlite'), 'sqlite test');
    writeFileSync(join(path, 'media', 'unlisted.jpg'), 'unexpected');
    expect(() => readVerifiedBundlePath(output, root)).toThrow(/inventory/);
    const manifestPath = join(path, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const mediaBytes = Buffer.from('private media');
    const mediaDigest = createHash('sha256').update(mediaBytes).digest('hex');
    writeFileSync(join(path, 'media', 'unlisted.jpg'), mediaBytes);
    manifest.media = { directory: 'media', fileCount: 1, files: [{ path: 'unlisted.jpg', size: mediaBytes.length, sha256: mediaDigest }] };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(readVerifiedBundlePath(output, root)).toBe(resolve(path));
    writeFileSync(join(path, 'media', 'unlisted.jpg'), 'tampered');
    expect(() => readVerifiedBundlePath(output, root)).toThrow(/media checksum/);
  });

  it('retains the newest configured number and refuses unsafe retention counts', () => {
    const root = makeRoot();
    for (let day = 1; day <= 4; day += 1) {
      const path = makeBundle(root, `gather-2026-09-${String(day).padStart(2, '0')}T00-00-00-000Z`);
      const date = new Date(2026, 8, day);
      utimesSync(path, date, date);
    }
    expect(findOldLocalBundles(root, 2)).toHaveLength(2);
    expect(() => findOldLocalBundles(root, 1)).toThrow(/2 to 365/);
  });

  it('verifies the remote copy before pruning old local bundles', () => {
    const root = makeRoot();
    const current = makeBundle(root, 'gather-2026-09-29T11-00-00-000Z', 'current sqlite');
    const oldPaths = [];
    for (let day = 1; day <= 3; day += 1) {
      const path = join(root, `gather-2026-09-${String(day).padStart(2, '0')}T00-00-00-000Z`);
      makeBundle(root, `gather-2026-09-${String(day).padStart(2, '0')}T00-00-00-000Z`); oldPaths.push(path);
      const date = new Date(2026, 8, day); utimesSync(path, date, date);
    }
    const calls = [];
    const execute = (command, args) => { calls.push([command, args]); };
    replicateBundle(current, { BACKUPS_PATH: root, BACKUP_REMOTE: 'offsite-crypt:gather/prod', KEEP_LOCAL_BACKUPS: '2' }, execute);
    expect(calls.map(([command, args]) => [command, args[0], args.at(-1)])).toEqual([
      ['rclone', 'copy', '--create-empty-src-dirs'], ['rclone', 'check', '--download'],
    ]);
    expect(readdirSync(root).filter((name) => name.startsWith('gather-'))).toHaveLength(2);
    expect(oldPaths.slice(0, 2).every((path) => !existsSync(path))).toBe(true);

    const anotherOld = join(root, 'gather-2026-09-04T00-00-00-000Z');
    makeBundle(root, 'gather-2026-09-04T00-00-00-000Z');
    const failingExecute = (command, args) => { if (command === 'rclone' && args[0] === 'check') throw new Error('remote read-back failed'); };
    expect(() => replicateBundle(current, { BACKUPS_PATH: root, BACKUP_REMOTE: 'offsite-crypt:gather/prod', KEEP_LOCAL_BACKUPS: '2' }, failingExecute)).toThrow(/remote read-back failed/);
    expect(existsSync(anotherOld)).toBe(true);
  });
});
