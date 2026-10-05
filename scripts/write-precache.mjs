import { readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Lists the app's own scripts, styles and fonts so the service worker can save every screen for offline use.
 * Skips the voice-transcription engine (tens of MB, only used online) so installing stays quick.
 */
const assets = resolve('dist/assets');
const skip = /transcribe-worker|\.wasm$|\.map$|\.woff$/;
const files = (await readdir(assets)).filter((name) => /\.(js|css|woff2)$/.test(name) && !skip.test(name)).sort();
await writeFile(resolve('dist/precache.json'), JSON.stringify({ files: files.map((name) => `/assets/${name}`) }));
console.log(`Offline list: ${files.length} files`);
