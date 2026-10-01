import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');

export async function verifyMedia(root, entries) {
  const base = resolve(root);
  const rootStat = await lstat(base);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Backup media root must be a real directory.');
  const expected = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0 || entry.path.includes('\0') || isAbsolute(entry.path) || /^[a-z]:/i.test(entry.path)) {
      throw new Error('Backup manifest contains an invalid media path.');
    }
    const segments = entry.path.split(/[\\/]/);
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error('Backup manifest contains an invalid media path.');
    const relativePath = segments.join('/');
    if (expected.has(relativePath)) throw new Error('Backup manifest contains duplicate media paths.');
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      throw new Error('Backup manifest contains invalid media metadata.');
    }
    expected.set(relativePath, entry);
  }

  const found = new Set();
  async function walk(directory, parentParts = []) {
    for (const name of await readdir(directory)) {
      const absolute = join(directory, name);
      const details = await lstat(absolute);
      if (details.isSymbolicLink()) throw new Error(`Backup media contains a symbolic link: ${[...parentParts, name].join('/')}`);
      if (details.isDirectory()) {
        await walk(absolute, [...parentParts, name]);
        continue;
      }
      if (!details.isFile()) throw new Error(`Backup media contains a non-file entry: ${[...parentParts, name].join('/')}`);
      const relativePath = [...parentParts, name].join('/');
      const manifestEntry = expected.get(relativePath);
      if (!manifestEntry) throw new Error(`Backup media inventory contains an unlisted file: ${relativePath}`);
      if (details.size !== manifestEntry.size || await sha256(absolute) !== manifestEntry.sha256) throw new Error(`Backup media file is missing or changed: ${relativePath}`);
      found.add(relativePath);
    }
  }
  await walk(base);
  if (found.size !== expected.size) throw new Error('Backup media inventory is incomplete.');
}
