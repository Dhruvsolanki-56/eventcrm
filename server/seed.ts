import 'dotenv/config';
import argon2 from 'argon2';
import { migrate, seedDemoData } from './db.js';

if (process.env.NODE_ENV === 'production') {
  throw new Error('The demo seed is disabled in production.');
}

await (migrate());
const password = process.env.DEMO_PASSWORD ?? 'Gather-Demo-2026!';
const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
await (seedDemoData(passwordHash));
console.info(`Sample accounts are ready. Password sign-in uses DEMO_PASSWORD (${password.length} characters).`);
