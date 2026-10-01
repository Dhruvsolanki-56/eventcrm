import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyMedia } from '../scripts/backup-media.mjs';

const roots = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'gather-restore-media-'));
  roots.push(root);
  return root;
}
function manifestEntry(path, bytes) {
  return { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('restore media verification', () => {
  it('accepts only the exact manifest inventory of regular files', async () => {
    const root = makeRoot();
    const media = join(root, 'media');
    mkdirSync(media);
    const bytes = Buffer.from('private scan photo');
    writeFileSync(join(media, 'scan.jpg'), bytes);
    await expect(verifyMedia(media, [manifestEntry('scan.jpg', bytes)])).resolves.toBeUndefined();
    writeFileSync(join(media, 'unlisted.txt'), 'not in manifest');
    await expect(verifyMedia(media, [manifestEntry('scan.jpg', bytes)])).rejects.toThrow(/unlisted/);
  });

  it('rejects a media path whose ancestor is a symbolic link', async () => {
    const root = makeRoot();
    const media = join(root, 'media');
    const outside = join(root, 'outside');
    mkdirSync(media);
    mkdirSync(outside);
    const bytes = Buffer.from('outside file');
    writeFileSync(join(outside, 'recording.webm'), bytes);
    try { symlinkSync(outside, join(media, 'workspace'), 'junction'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return;
      throw error;
    }
    await expect(verifyMedia(media, [manifestEntry('workspace/recording.webm', bytes)])).rejects.toThrow(/symbolic link/);
  });
});
