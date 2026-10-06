import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export type ConfigReport = { errors: string[]; warnings: string[] };

// Compare folders the same way on every system: forward slashes, lower case, no drive letter.
const plain = (path: string) => path.replace(/\\/g, '/').replace(/^[a-z]:/i, '').toLowerCase();
const underTemp = (path: string | undefined) => {
  if (!path) return false;
  const target = plain(resolve(path));
  return ['/tmp/', '/var/tmp/', `${plain(tmpdir())}/`].some((root) => target.startsWith(root));
};

/**
 * What must be true before this server holds real customers' data. Nothing here reads a secret's value, so the
 * messages are safe to print. A public demo (GATHER_DEMO_MODE=true) only gets warnings; a real production
 * deployment refuses to start while any error remains.
 */
export function checkProductionConfig(env: Record<string, string | undefined>): ConfigReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (env.NODE_ENV !== 'production') return { errors, warnings };
  const demo = env.GATHER_DEMO_MODE === 'true';
  const problem = (message: string) => (demo ? warnings : errors).push(message);

  if (demo) warnings.push('Demo mode is on: anyone can sign in as a sample account. Never use it for real customers.');
  else if (env.DEMO_PASSWORD) warnings.push('DEMO_PASSWORD is set but unused outside demo mode. Remove it.');

  const hosted = Boolean(env.DATABASE_URL?.trim());
  if (!hosted && underTemp(env.DATABASE_PATH ?? 'data/gather.sqlite')) problem('The database is stored in a temporary folder and will be erased on restart. Set DATABASE_URL (Postgres) or point DATABASE_PATH at a persistent disk.');
  if (!hosted && !demo) warnings.push('SQLite runs on one server only. Use DATABASE_URL (Postgres) to run more than one copy.');
  if (hosted && env.DATABASE_SSL === 'disable') problem('DATABASE_SSL is disabled, so the database connection is not encrypted.');
  if (underTemp(env.UPLOADS_PATH ?? 'uploads')) problem('Uploaded photos and voice notes are stored in a temporary folder and will be erased on restart. Point UPLOADS_PATH at a persistent disk.');
  if (!env.PUBLIC_BASE_URL?.startsWith('https://')) problem('PUBLIC_BASE_URL must be the public https:// address; email links and unsubscribe pages are built from it.');

  const resend = env.EMAIL_TRANSPORT === 'resend';
  if (resend && !env.RESEND_API_KEY) problem('EMAIL_TRANSPORT is resend but RESEND_API_KEY is not set.');
  if (!resend && !env.SMTP_HOST) warnings.push('No mail server is configured, so approved emails stay in the outbox and nothing is sent.');
  if ((resend || env.SMTP_HOST) && !env.SMTP_FROM_ADDRESS) warnings.push('SMTP_FROM_ADDRESS is not set; each workspace must save its own sender before anything can go out.');
  if (env.TRUST_PROXY_HOPS !== undefined && !/^[0-9]+$/.test(env.TRUST_PROXY_HOPS)) problem('TRUST_PROXY_HOPS must be a whole number (how many proxies sit in front of the server).');
  if (env.AI_MODE === 'provider' && !(env.GEMINI_API_KEY || env.ANTHROPIC_API_KEY || env.GROQ_API_KEY)) warnings.push('AI_MODE is provider but no AI key is set, so cards and drafts will fall back to manual entry.');
  return { errors, warnings };
}
