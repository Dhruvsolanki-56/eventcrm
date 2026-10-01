# Hosted demo deployment

## Short-deadline demo target

- Netlify serves the React/Vite frontend.
- Render Free serves the Express API.
- The hosted demo runs on the existing SQLite data layer and reseeds synthetic demo records after a cold start.
- Public sample-account sign-in is enabled only by `GATHER_DEMO_MODE=true`; do not use that setting for real customer or personal data.
- Netlify proxies `/api` and `/unsubscribe` requests to the Render API using `GATHER_API_ORIGIN`.

This is a disposable demonstration setup, not production hosting. Render Free services sleep after 15 minutes without traffic, can take about a minute to wake, and have ephemeral storage. Its local SQLite database and uploaded files can disappear after a restart, spin-down, or redeploy. The app rebuilds the synthetic sample data on startup, but changes made during a session are not durable. Free Render services also cannot send email over SMTP ports 25, 465, or 587. See [Render Free services](https://render.com/docs/free).

## Honest capability boundaries

- Sample CRM records are fake. The public sample-account buttons sign in without a password and share mutable sample workspaces; anyone with the public URL can change them.
- Email sending is off. Drafting and status UI may be demonstrated, but no email is delivered or accepted by a mail provider.
- AI card reading is off unless a provider is separately configured. With the supplied demo blueprint, people must check and type uncertain card details; QR scanning remains on-device.
- Voice transcription remains off; the optional manual text field is the truthful fallback.
- SQLite is retained for this temporary demo. The PostgreSQL adapter and schema migration tests are groundwork only; this deployment does not use PostgreSQL.
- Private uploaded media is stored only on the ephemeral service filesystem. Do not upload real business cards, customer records, or confidential documents to the public demo.
- No durable database/media backup or restore path is configured for the hosted demo.

## Deployment configuration

`render.yaml` defines the temporary free web service. After Render creates the service, set Netlify's `GATHER_API_ORIGIN` build variable to the Render service's HTTPS origin and trigger a new Netlify deploy. The Netlify build already enables the public sample-account panel with `VITE_PUBLIC_DEMO=true`.

Before sharing the URL, verify the Render `/api/health` response, the Netlify sign-in screen, sample-account login, event/people views, one card upload/review/save, and a refresh that confirms the saved record is present while the service remains awake. State persistence across Render restarts is explicitly not promised.

## Longer-term hosted architecture

For durable hosted operation, migrate all data operations to PostgreSQL, place images and voice recordings in private object storage, switch email to an HTTPS provider API, add durable background job execution, and test database/media export and restore. No such production-grade setup is claimed here.
