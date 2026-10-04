# Gather frontend redesign — 3 October 2026

## Scope

Frontend-only release. No server, database, provider, tenant authorization, email sending, extraction, or deployment configuration changes. The existing Render backend remains in place.

## Design and workflow changes

- One light workspace system across the shell, Home, capture, card review, People, company list/detail, person detail, Email Desk, follow-ups, pipeline, analytics, reports, Settings, setup, account screens, and dialogs.
- Restrained teal actions, neutral backgrounds, readable Inter typography, consistent borders, focus indicators, and responsive spacing. No decorative hero blocks or floating review save bar.
- Home puts the next task first and uses a compact summary ledger. Its Review drafts link now opens the actual `/email` route.
- Person records keep contact details beside one selected task: conversation, email, voice note, follow-up, meeting, deal value, or management. History spans the content area beneath them. Switching tasks preserves unfinished form state.
- Settings is divided into business/personal profile, email/reminders, events/team (admin only), and data/activity. Panels remain mounted to preserve unfinished edits.
- Email Desk selects a draft on desktop. On phones, the queue and selected message have separate focused views with Back to queue and an unsaved-edit confirmation.
- Company tools use the width of the page rather than accumulating in a long narrow right column. Reports use a complete three-column metric grid on desktop.
- Mobile People rows give names and titles their own line instead of squeezing them into a desktop-style table.
- Review actions remain in document flow after the final field. Source photo, uncertainty markers, privacy disclosures, and explicit approval remain intact.

## Verification approach

Use isolated synthetic workspaces and captured local email, not live customer data. Visual route checks run at 1440 × 900 and 390 × 844, including every person task panel and every Settings section. Screenshots wait for data and chart layout before capture.

Commands:

```text
npm run build
npm run test:e2e -- tests/e2e/design-review.spec.ts tests/e2e/setup.spec.ts tests/e2e/audit.spec.ts tests/e2e/accessibility.spec.ts tests/e2e/email-desk-workflow.spec.ts tests/e2e/home-next-action.spec.ts tests/e2e/draft-automation.spec.ts
npm run test:e2e -- tests/e2e/focused-workspace.spec.ts
npm run test:e2e -- tests/e2e/shell.spec.ts tests/e2e/z-existing-account-invite.spec.ts tests/e2e/zz-sample-data.spec.ts tests/e2e/design-review.spec.ts
npm run test:mail
```

Existing tests were adapted to enter the new sections before using controls. Stale assertions for old copy, old background colors, and raw internal-note quotation were aligned with the current interface and existing safe email fallback; backend behavior was not changed.

## Boundaries

- These checks do not guarantee zero UI bugs, full WCAG conformance, or coverage of every browser and screen size.
- No live customer emails are sent as part of this release. Local SMTP capture verifies server acceptance behavior, not inbox delivery.
- AI quality/latency, Render cold starts, free-tier quotas, and the disposable demo database are unchanged.
- The build retains its existing large-chunk warning, including the optional local transcription runtime.
- Prior uncommitted screenshots, PROJECT_CONTEXT.md, and unrelated local files are excluded from this release.

## Deployment

Frontend target: https://gather-crm-preview.netlify.app

Repository: https://github.com/Dhruvsolanki-56/eventcrm

Publish by pushing the scoped release commits to `codex/gather-crm-demo`, then verify the Netlify published commit and the live interface. Do not redeploy Render for this frontend-only change.
