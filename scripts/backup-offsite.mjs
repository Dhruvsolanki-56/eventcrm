import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function listMediaFiles(root, folder = root) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing a media symlink in the backup bundle: ${path}`);
    if (info.isDirectory()) return listMediaFiles(root, path);
    if (!info.isFile()) throw new Error(`Unexpected non-file entry in the backup media: ${path}`);
    return [relative(root, path).split(sep).join('/')];
  });
}

export function readVerifiedBundlePath(output, backupsRoot) {
  const line = output.split(/\r?\n/).findLast((item) => item.startsWith('Database and ') && item.includes(' backed up: '));
  if (!line) throw new Error('The backup command did not report a completed bundle path.');
  const reportedPath = line.slice(line.indexOf(' backed up: ') + ' backed up: '.length).trim();
  if (!isAbsolute(reportedPath)) throw new Error('The backup command returned a non-absolute path.');
  const root = resolve(backupsRoot);
  const bundlePath = resolve(reportedPath);
  if (dirname(bundlePath) !== root || !/^gather-[0-9TZ-]+$/.test(basename(bundlePath))) {
    throw new Error('The backup command returned a path outside the expected Gather backup directory.');
  }
  const bundleStat = lstatSync(bundlePath);
  if (!bundleStat.isDirectory() || bundleStat.isSymbolicLink()) throw new Error('The backup bundle is not a regular directory.');
  const manifestPath = join(bundlePath, 'manifest.json');
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('The backup manifest is not a regular file.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.format !== 'gather-backup-v1' || manifest.database?.path !== 'database.sqlite' || manifest.media?.directory !== 'media' || !Array.isArray(manifest.media.files)) {
    throw new Error('The new backup bundle manifest is missing or invalid.');
  }
  const databasePath = join(bundlePath, 'database.sqlite');
  const databaseStat = lstatSync(databasePath);
  if (!databaseStat.isFile() || databaseStat.isSymbolicLink() || sha256(databasePath) !== manifest.database.sha256) throw new Error('The new backup database checksum does not match its manifest.');
  const mediaRoot = join(bundlePath, 'media');
  const mediaStat = lstatSync(mediaRoot);
  if (!mediaStat.isDirectory() || mediaStat.isSymbolicLink()) throw new Error('The backup media directory is not a regular directory.');
  const listed = new Map();
  for (const item of manifest.media.files) {
    if (!item || typeof item.path !== 'string' || item.path.includes('\\') || posix.isAbsolute(item.path) || item.path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('The backup manifest contains an unsafe media path.');
    }
    const parts = item.path.split('/');
    const mediaPath = resolve(mediaRoot, ...parts);
    const pathFromMediaRoot = relative(mediaRoot, mediaPath);
    if (!pathFromMediaRoot || pathFromMediaRoot === '..' || pathFromMediaRoot.startsWith(`..${sep}`)) throw new Error('The backup manifest media path escapes its media directory.');
    let checkedPath = mediaRoot;
    let info;
    for (const [index, part] of parts.entries()) {
      checkedPath = join(checkedPath, part);
      info = lstatSync(checkedPath);
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory()) || (index === parts.length - 1 && !info.isFile())) {
        throw new Error(`The backup media path is not a regular file: ${item.path}`);
      }
    }
    if (!info || info.size !== item.size || sha256(mediaPath) !== item.sha256) {
      throw new Error(`The backup media checksum does not match its manifest: ${item.path}`);
    }
    if (listed.has(item.path)) throw new Error(`The backup manifest contains a duplicate media path: ${item.path}`);
    listed.set(item.path, true);
  }
  const actual = listMediaFiles(mediaRoot).sort();
  const expected = [...listed.keys()].sort();
  if (manifest.media.fileCount !== expected.length || actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    throw new Error('The backup media inventory does not match its manifest.');
  }
  return bundlePath;
}

export function findOldLocalBundles(backupsRoot, keepCount) {
  const root = resolve(backupsRoot);
  if (!Number.isInteger(keepCount) || keepCount < 2 || keepCount > 365) throw new Error('KEEP_LOCAL_BACKUPS must be a whole number from 2 to 365.');
  const bundles = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^gather-[0-9TZ-]+$/.test(entry.name))
    .map((entry) => {
      const path = join(root, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`Refusing a symlink backup bundle: ${path}`);
      readVerifiedBundlePath(`Database and 0 private media files backed up: ${path}`, root);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return bundles.slice(keepCount).map((item) => item.path);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.`);
  return result.stdout ?? '';
}

export function replicateBundle(bundlePath, env = process.env, execute = run) {
  const backupsRoot = resolve(env.BACKUPS_PATH ?? 'backups');
  const remote = env.BACKUP_REMOTE?.trim();
  if (!remote || !/^[\w.-]+:[^\0\r\n]+$/.test(remote)) throw new Error('Set BACKUP_REMOTE to a configured rclone remote and destination, for example offsite:gather/prod.');
  const keepCount = Number(env.KEEP_LOCAL_BACKUPS ?? 14);
  if (!Number.isInteger(keepCount) || keepCount < 2 || keepCount > 365) throw new Error('KEEP_LOCAL_BACKUPS must be a whole number from 2 to 365.');
  const verifiedBundlePath = readVerifiedBundlePath(`Database and 0 private media files backed up: ${resolve(bundlePath)}`, backupsRoot);
  const remotePath = `${remote.replace(/\/+$/, '')}/${basename(verifiedBundlePath)}`;
  execute('rclone', ['copy', verifiedBundlePath, remotePath, '--create-empty-src-dirs']);
  execute('rclone', ['check', verifiedBundlePath, remotePath, '--download']);
  console.info(`Off-VM backup verified: ${remotePath}`);
  for (const oldBundle of findOldLocalBundles(backupsRoot, keepCount)) {
    if (resolve(dirname(oldBundle)) !== backupsRoot || !/^gather-[0-9TZ-]+$/.test(basename(oldBundle))) throw new Error(`Refusing to remove an unexpected local backup path: ${oldBundle}`);
    rmSync(oldBundle, { recursive: true, force: false });
    console.info(`Removed expired local backup bundle: ${oldBundle}`);
  }
}

export function createLocalBackup(env = process.env) {
  const backupsRoot = resolve(env.BACKUPS_PATH ?? 'backups');
  const compiledBackup = join(projectRoot, 'dist-server', 'server', 'backup.js');
  const backupOutput = existsSync(compiledBackup)
    ? run(process.execPath, [compiledBackup], { env: { ...env, BACKUPS_PATH: backupsRoot } })
    : run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'backup'], { env: { ...env, BACKUPS_PATH: backupsRoot } });
  const bundlePath = readVerifiedBundlePath(backupOutput, backupsRoot);
  console.info(`Gather local backup bundle: ${bundlePath}`);
  return bundlePath;
}

export function main(args = process.argv.slice(2), env = process.env) {
  if (args[0] === '--create-local' && args.length === 1) return createLocalBackup(env);
  if (args[0] === '--replicate' && args.length === 2) return replicateBundle(args[1], env);
  if (args.length) throw new Error('Use --create-local or --replicate <verified-bundle-directory>.');
  const bundlePath = createLocalBackup(env);
  return replicateBundle(bundlePath, env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
