import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const target = resolve('dist-server/server/migrations');
await mkdir(target, { recursive: true });
await cp(resolve('server/migrations'), target, { recursive: true, force: true });
