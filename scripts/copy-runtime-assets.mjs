import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const target = resolve('dist-server/server/migrations');
await mkdir(target, { recursive: true });
await cp(resolve('server/migrations'), target, { recursive: true, force: true });

const ocrTarget = resolve('public/ocr');
await mkdir(ocrTarget, { recursive: true });
await cp(resolve('node_modules/tesseract.js/dist/worker.min.js'), resolve(ocrTarget, 'worker.min.js'));
for (const name of [
  'tesseract-core.wasm.js', 'tesseract-core-simd.wasm.js',
  'tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js',
]) await cp(resolve('node_modules/tesseract.js-core', name), resolve(ocrTarget, name));
