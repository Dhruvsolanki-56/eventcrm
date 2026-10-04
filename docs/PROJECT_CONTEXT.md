# Gather CRM — project context and handoff

Snapshot: 2026-10-03, updated after the frontend polish pass (see "Changes since the first snapshot"). The public demo was first deployed at commit `f559270`. This file describes the implemented project, the evidence available at this snapshot, and work that remains. It is not a claim of production readiness. For commands and detailed operational notes, also read the root `README.md`, `docs/DEPLOYMENT.md`, `docs/PRODUCTION_PLAN.md`, and `docs/FREE_DEMO_MIGRATION.md`. Where older documents describe an earlier behavior or test count, check the current code and this dated snapshot.

## Product intent and decisions

Gather began as a capture-first CRM: upload or photograph a card, brochure, or QR; read it immediately; review one item at a time; save it to the right company and person; optionally prepare an email; move to the next conversation. The product emphasis later shifted toward **fast, low-input, tenant-scoped email preparation grounded in repeated conversations**, with lead records supporting that workflow. The user asked for a clean premium light interface, mobile accessibility, event attribution, and honest status language.

The stack remains React 19 + TypeScript + Vite on the client, Node.js + Express 5 + TypeScript on the API, and SQLite for the running data layer. PostgreSQL compatibility code and migrations exist, but the hosted demo still runs SQLite. Current policy decisions: no unattended email sends; automation creates editable drafts only; likely same-person matches require human confirmation; card details and AI-produced conversation interpretations require review; voice transcription is optional with a manual text fallback. No implementation should imply that an image was read, audio was transcribed, or an email reached an inbox unless that actually happened.

## Architecture and data boundaries

- `client/App.tsx` contains the main app shell, capture, review, people, company, follow-up, and home flows. Separate route components include `client/EmailDeskPage.tsx`, `client/OnboardingPage.tsx`, `client/AnalyticsPage.tsx`, and `client/SettingsPage.tsx`. `client/api.ts` centralizes requests. CSS for the current light design system is under `client/`.
- `server/index.ts` owns HTTP routes, authentication/context checks, rate limits, and API wiring. `server/db.ts` contains the SQLite repository and business rules. Schema migrations are in `server/migrations/`; `server/postgres.ts` and `server/migrations-postgres/` are migration groundwork, not the active hosted database.
- The tenant boundary is a workspace. Company workspaces have admin, manager, and representative roles with event access; private attendee spaces have their own data. The intended hierarchy is **workspace → company → many people → many dated encounters/conversations**, with optional event attribution. Company deal value is company-level, not copied per person.
- Companies are normalized by name/domain, with aliases for merges. Review can suggest existing companies and same-person matches. Exact image-byte and QR repeat scans are reused; visually similar crops/retakes are not guaranteed duplicates and uncertain person identity is not silently merged. A repeat meeting should add an encounter to the existing person, not another person record.
- Notes, voice media, email drafts, tasks, scans, events, settings, and audit rows are stored per workspace. Event-scoped access is applied to conversation and email operations. The app has local quota/rate protections, but these do not replace a filesystem quota, backup, independent security review, or production monitoring.

## Implemented user workflow

1. **Sign in and setup.** The local and public demo have synthetic sample accounts. Setup has three resumable steps: business/person details, sender/test email, and first capture. For a company admin, the business profile records what the team sells, its role, optional services/products, tone, signature, and promises to avoid. The latest addition can suggest a profile from pasted website or brochure text using configured Gemini; it does not save the pasted source or accept the suggestion as fact until the user reviews and saves it. Private attendees have a smaller About me profile. Sender details are editable in Settings/setup; a From address alone does not configure a working mail transport.
2. **Capture at upload.** `/scan` accepts camera, single phone photo, multiple images, brochures, and QR. Event is selected before capture. Image upload itself starts reading—there is no second Scan button. QR decoding and local Tesseract OCR run on-device; if configured, Gemini can provide a card suggestion. The one-at-a-time review screen shows the source image beside editable fields and indicates uncertainty. Saving requires human confirmation. Bulk captures remain in a review tray.
3. **Resolve identity.** Review can attach the item to an existing company/person or create a new person. Exact duplicate scans/QR content are reused; matching email/phone prompts a likely-person decision. Person and company records are searchable. Company admin merge has typed confirmation and refuses conflicting deal details. People can be archived/restored, with permanent deletion as a separate explicit action for authorized roles.
4. **Keep conversation history.** `/people/:contactId` has dated conversations, event links, notes, voice notes, follow-ups/meetings, and the email action. Repeated encounters attach to the same person. Conversation saves accept an idempotency key. A saved audio recording is playable; on-device Whisper Tiny transcription is an explicit user action, produces editable suggested text, and requires checking/saving before it becomes email context. Typed notes work without transcription. Optional Gemini suggestions can summarize the conversation or propose structured context, but the person must review and save it. The prompt distinguishes the team's role from the client's role and is instructed not to invent offers, commitments, price, or acceptance.
5. **Prepare, review, and approve email.** A template draft is created quickly from the latest accessible conversation and earlier context. With a configured Gemini provider, an asynchronous job can suggest an improved version; the UI polls and must not overwrite human edits. Source snippets are saved alongside the draft so the reviewer can see what informed it. Email Desk at `/email` groups drafts, approved/outbox items, and people ready for a draft, with search, an editor, context panel, save, and approval actions. No lead message sends unattended. A separate user action can attempt sending when a transport is configured; with no transport, the item is explicitly unsent/outbox. Provider acceptance is not inbox delivery.
6. **Act and measure.** Home highlights next review, due follow-up, a ready email draft, missing profile context, or next capture. Follow-ups/meetings are stored as tasks. Analytics and reports use stored event and workspace records for activity, unique people/companies, stages, quality, company deals, and export rather than illustrative numbers. Counts and time-sensitive views are event/time-zone aware where implemented.

## UI routes and access

Authenticated routes are `/home`, `/setup`, `/scan`, `/review/:scanId`, `/email`, `/people`, `/people/:contactId`, `/companies`, `/companies/:companyId`, `/pipeline`, `/analytics`, `/reports`, `/follow-ups`, and `/settings`. Public auth flows include sign-in, password reset, and email verification. Company-only or manager/admin routes are hidden or not-found for roles without access; private attendee spaces do not show company pipeline/reports. The phone shell has Home, Email, Scan, People, and Follow-ups tabs. Unknown routes show a not-found page.

The design has gone through multiple light-theme and layout revisions. The current review save actions are in the normal form flow rather than floating over fields; the person page was reorganized to reduce the long empty left column. A previous exhaustive local control crawl exercised 660 distinct controls at desktop (1440 px) and phone (390 px) widths with no undersized phone targets, but that is not a full assistive-technology or WCAG assessment.

## AI, OCR, and email truthfulness

- Card/QR reading: QR is local; Tesseract provides local OCR; Gemini photo reading requires a configured server-side key and is rate-limited. Every suggestion is editable. The synthetic OCR benchmark in `docs/OCR_BENCHMARK.md` is not a real-card accuracy claim. No unlimited free API or guaranteed extraction is available.
- Voice: Whisper Tiny runs in the browser after model download and an explicit Transcribe action. A transcript is a suggestion, not verified conversation meaning. Manual text remains available. Real multilingual event-audio accuracy and first-download latency are not established.
- Conversation/email AI: prompts use sender organization/role, stated offerings, latest checked note, and older accessible history. They are designed to avoid reversing who offered or requested something and to omit ambiguous commercial claims. A model can still misunderstand a rough note, so the user must review both suggested context and final message.
- Email transport: local SMTP and HTTPS Resend integrations exist. A historical local Gmail test established mail-server acceptance of one test message, not inbox delivery. The current Render demo has no live sending configured. No reply-inbox integration, unattended campaign sequence, or delivery tracking has been implemented.

## Live demo as of this snapshot

- GitHub repository: `https://github.com/Dhruvsolanki-56/eventcrm`; deployment branch: `codex/gather-crm-demo`; deployed commit: `f559270` (three scoped commits: backend `93703eb`, frontend `38ff282`, tests `f559270`).
- Frontend: `https://gather-crm-preview.netlify.app/` on Netlify. It automatically publishes the deployment branch. The build uses `netlify.toml` and a proxy generated by `scripts/write-netlify-redirects.mjs` from Netlify's `GATHER_API_ORIGIN`.
- Backend: `https://gather-crm-demo-api.onrender.com/` on Render Free; `render.yaml` builds and starts the Express service. This deployment was manually started and Render reported `Deploy succeeded | Live` for `f559270`.
- Live checks after deployment: direct Render `/api/health` returned HTTP 200 with `{"status":"ok"}`; the same path through Netlify returned HTTP 200; the public sign-in page opened; a synthetic Maya Chen sample login worked after Render restarted; `/scan` and `/email` loaded with event and Email Desk data. These checks did **not** exercise a real card upload, voice transcription, a Gemini request, or an email send on the hosted service.
- The hosted SQLite database and media are under Render `/tmp`. Free-instance sleep/redeploy/restart can erase edits, uploads, and sessions; synthetic demo records reseed. Public sample workspaces are shared and mutable. Do not enter real customer cards, recordings, or confidential data. This is a disposable demo, not a production deployment.

## Local verification and commands

At the most recent implementation checkpoint, `npm run build` passed; unit tests passed 59 cases; targeted browser journeys for draft automation, Email Desk, home next action, setup, and attendee capture passed; a separate exhaustive control audit passed 4 checks across 660 desktop/phone controls. A local conversation-save/template-draft operation with AI disabled measured 28 ms; this is not real-provider latency. The deployment turn reran `npm run build` successfully and verified the public endpoints and sample UI. Older measurements in other docs refer to earlier code and synthetic fixtures.

Core commands from the repository root:

```powershell
Copy-Item .env.example .env
npm ci
npm run seed
npm run dev
npm test
npm run build
npm run test:e2e
npm run audit:controls
npm run audit:accessibility
npm run test:production-smoke
```

`npm run dev` serves Vite and Express locally; `npm start` serves a built app. The repository also has focused mail, OCR, quota, backup, public-demo, and operations test commands in `package.json` and `README.md`. Secrets belong only in untracked local/host environment settings; never copy `.env` into this file or Git.

## Known limitations and next work

1. **Production hosting is not done.** The agreed production target was a single server/VM with a persistent disk, one SQLite writer, TLS, tested backups and offsite restore, and monitoring. The runbook/templates exist but were not installed or validated on a VM. PostgreSQL migration and object storage are alternatives for durable cloud hosting, not the current live setup.
2. **Hosted email sending is off.** To enable actual cloud sending, configure and verify an HTTPS mail provider, sender domain, suppression/opt-out behavior, and provider acceptance/delivery observability. Never describe an outbox item as delivered. The user explicitly chose draft automation over unattended sends.
3. **AI quality is not proven in the field.** Test consented, representative cards and real rough conversation notes with labeled expected fields and sender/client roles. Record provider latency, error/fallback rates, and cost/free-tier limits. Review ambiguous offers/prices/agreements carefully. Do not assume Gemini availability from the presence of a UI control.
4. **Voice requires device validation.** Check first model download, browser compatibility, phone performance, languages/accents, and transcription quality. Do not treat a transcript or AI summary as automatically verified.
5. **Independent release gates remain.** Run a staging restart/migration/restore drill, real phone and assistive-technology review, privacy/consent review, and an independent post-fix security assessment before handling real customer data or claiming production-grade security.
6. ~~Home “Review drafts” link pointed at `/email-desk`~~ — fixed (now `/email`, covered by the Home next-action test).

## Changes since the first snapshot (frontend polish, 2026-10-03)

- **Calmer light theme:** `client/calm-workspace.css` layers over the base styles; the unused `redesign.css` was removed. Person page has tabs (Conversation, Email, Voice note, Follow-up, Meeting, Deal value for companies, More) with a one-line hint for the active tab; on phones the active panel shows first.
- **In-app confirmations:** the 11 browser `window.confirm` pop-ups were replaced by `client/confirm.tsx` (accessible dialog, queued so several prompts never drop). E2E tests click `[data-confirm-accept]`.
- **Email wording:** the person-page button is now “Approve email” (matches Email Desk). Nothing sends without a configured mail server.
- **No-AI draft fallback:** `server/email-template.ts` writes Friendly / Professional / Short drafts for the first, alternate and written-follow-up cases from the saved event, products of interest and checked topic only. It never adds price, offer, sample or commitment wording. Unit tests cover it. Demo seed drafts were rewritten.
- **AI motion:** `client/ai-motion.tsx/.css` — card-photo scanner sweep, shimmering fields while reading, staggered reveal, styled progress, animated tray rows; AI-draft status bar, dimmed editable fields while the AI writes (typing takes over because the AI never replaces edited text), highlight on arrival, skeleton for the first draft. All motion stops under `prefers-reduced-motion`.
- **Build:** React and router are in their own `vendor-react` chunk (main app chunk ~275 kB, below the 500 kB warning).
- **Verification at this point:** `npm run build` passes; 66 unit tests pass; the browser suite passes (52 passed, 14 skipped, 0 failed). Live Render was observed running the new template and showing the “AI is writing” state; Gemini drafting has since been reported working but its quality is not yet reviewed.

## Remaining work, in agreed order

1. Review real Gemini draft quality with realistic rough notes (wrong promises, mixed-up roles, generic wording).
2. Real email sending (HTTPS mail provider, sender domain, opt-out handling, delivery observability).
3. Last: permanent database/hosting with tested backups, real-world card/voice testing on consented data, and an independent security, privacy and accessibility review.

## Repository hygiene

Local-only items that are not part of the project and should not be committed: `.env`, `data/`, `uploads/`, `backups/`, `dist*/`, `node_modules/`, test output and leftover restore-drill folders. Stray copies such as `eng.traineddata` at the repo root (the app uses `public/ocr/eng.traineddata.gz`) and old staging folders can be deleted.
