# Go-live checklist

Use this before real customers' data goes into Encore. The demo service (`render.yaml`) is not production: it has demo mode
on, a public sample-account login and a database that is erased on restart.

## What the server enforces for you
When `NODE_ENV=production` and `GATHER_DEMO_MODE` is not `true`, the server **will not start** if any of these is wrong
(`server/production-config.ts`). It prints what to fix, and never prints a secret.

- The database is not in a temporary folder (`DATABASE_URL`, or `DATABASE_PATH` on a persistent disk).
- Uploads are not in a temporary folder (`UPLOADS_PATH`).
- `PUBLIC_BASE_URL` is an `https://` address (email, unsubscribe and reset links are built from it).
- `EMAIL_TRANSPORT=resend` has a `RESEND_API_KEY`.
- `DATABASE_SSL` is not `disable`; `TRUST_PROXY_HOPS` is a whole number.

It also warns, without stopping, about: no mail server configured (emails stay in the outbox), a missing sender address,
an unused `DEMO_PASSWORD`, SQLite (one server only), and an AI mode with no key.

## Choose a topology
- **Managed hosting:** `render.production.yaml` (Postgres plus a persistent disk for photos and voice notes).
  The Postgres mode has not been run end to end yet; see "Before the first customer".
- **One Linux VM with SQLite:** `docs/DEPLOYMENT.md`.

## Before the first customer
1. CI is green on the commit you will deploy, including the job "API checks on Postgres" if you use Postgres.
   Deploy to a staging service first and click through sign-up, scan, save, follow-up and an email to yourself.
2. Mail: verify your sending domain with the provider, then send yourself a test from Settings. Send one delivered and
   one bounced test message and confirm the status in Email Desk is honest about each.
3. Create the first company admin by signing up normally. Confirm `GET /api/dev/demo-accounts` returns 404.
4. Backups: SQLite uses `npm run backup` (see `docs/DEPLOYMENT.md`); Postgres uses the provider's point-in-time
   backups. Restore one into a scratch database and open it before you rely on it.
5. Test on a real iPhone and a real Android phone: camera, voice note, add to home screen, offline, a dropped connection mid-save.
6. Run through the app once with a screen reader (NVDA on Windows, VoiceOver on iPhone).

## After launch
- Watch the server log for `config_warning`, `job_failed` and `email_send_outcome_unknown` events.
  The last one means a send may have reached the recipient without being recorded; the email is marked failed, so check
  the sent mailbox before retrying.
- Re-run the scale test on a staging copy as data grows: `SCALE_TEST=1 npm run test:e2e -- scale`.
