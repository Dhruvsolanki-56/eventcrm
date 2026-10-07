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
- The limit and timeout settings below are whole numbers above zero, `RATE_LIMIT_STORE` is `database` or `memory`, and
  `AUTO_SEND_MIN_DELAY_SECONDS` (if set) is at least 60.

It also warns, without stopping, about: no mail server configured (emails stay in the outbox), a missing sender address,
an unused `DEMO_PASSWORD`, SQLite (one server only), and an AI mode with no key.

## Protections built in
- **Rate limits.** Every API request is counted per network address (`API_LIMIT_PER_ADDRESS_PER_MINUTE`, default 1500, high
  because a booth or office shares one address) and per signed-in session (`API_LIMIT_PER_SESSION_PER_MINUTE`, default 600).
  Sensitive routes have their own, stricter limits: sign-in (per address and per account, so guessing one password from many
  addresses still stops), password and verification email, exports, scans, notes, tasks, deals, group emails, AI suggestions
  and email sending. With `DATABASE_URL` set, those counters live in the database (`RATE_LIMIT_STORE=database`, the default
  there), so they hold when several server copies run. The two blanket limits stay in each copy's memory.
- **Timeouts.** A request that runs past `API_REQUEST_TIMEOUT_MS` (60 s) is answered with a clear 503. The server closes
  stalled connections (`REQUEST_TIMEOUT_MS`, `KEEP_ALIVE_TIMEOUT_MS`). Postgres queries stop after
  `PG_STATEMENT_TIMEOUT_MS` (20 s); each copy opens at most `PG_POOL_MAX` connections (10).
- **Headers.** HTTPS-only cookies, CSRF checks, a content security policy, `Permissions-Policy` (camera and microphone for
  the app only), and `Cache-Control: no-store` on every API answer.
- **Email.** Approved email is limited per person and per workspace each hour. A group email is limited to
  `CAMPAIGN_DAILY_LIMIT` (500) a day per workspace, leaves out people who opted out or were emailed in the last 7 days, and
  goes out spaced apart. Automatic sending is off by default; when on it always waits at least
  `AUTO_SEND_MIN_DELAY_SECONDS` (300) so a person can stop it, and it re-checks opt-out and limits at the moment of sending.
- **AI.** Every provider call goes through `server/ai-guard.ts`: the same input in the same workspace is answered from a
  short-lived cache, identical requests at the same moment become one call, each workspace has a daily limit per kind of call
  (`AI_DAILY_LIMIT_<KIND>`, for example `AI_DAILY_LIMIT_EMAIL_DRAFT`), and after five failures in a row a kind of call pauses
  for a minute. Pages and transcripts are trimmed before they are sent. Usage is in the `ai_usage` table.

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
