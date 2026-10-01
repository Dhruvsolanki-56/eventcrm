import 'dotenv/config';
import argon2 from 'argon2';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

if (process.env.NODE_ENV === 'production') throw new Error('The automated test seed is disabled in production.');
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH ??= 'data/gather-e2e.sqlite';
process.env.UPLOADS_PATH ??= 'uploads-e2e';

const testDatabase = resolve(process.env.DATABASE_PATH);
if (!/^gather-e2e(?:-[a-z0-9-]+)?\.sqlite$/i.test(testDatabase.split(/[\\/]/).at(-1) ?? '')) throw new Error('Refusing to use an unexpected automated-test database path.');
if (existsSync(testDatabase)) throw new Error('This automated-test database already exists; start a new E2E run to get a fresh isolated database.');

const { migrate, seedDemoData } = await import('./db.js');
await (migrate());
const password = process.env.DEMO_PASSWORD ?? 'Gather-Demo-2026!';
const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
await (seedDemoData(passwordHash));
console.info(`Automated test sample accounts are ready. Password sign-in uses DEMO_PASSWORD (${password.length} characters).`);
