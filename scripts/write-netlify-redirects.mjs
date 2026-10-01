import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderNetlifyRedirects } from './netlify-redirects.mjs';

const dist = resolve('dist');
const configuredOrigin = process.env.GATHER_API_ORIGIN?.trim();
await mkdir(dist, { recursive: true });
await writeFile(resolve(dist, '_redirects'), renderNetlifyRedirects(configuredOrigin));
console.info(configuredOrigin
  ? `Netlify API and unsubscribe requests will proxy to ${new URL(configuredOrigin).origin}.`
  : 'GATHER_API_ORIGIN is unset: Netlify will show the honest backend-unavailable response.');
