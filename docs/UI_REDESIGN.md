# Workspace redesign and analytics

The September 30 redesign uses Inter throughout, a pale workspace sidebar, restrained green actions, flat bordered panels, compact metric strips, and aligned chart/table layouts. Home now includes real capture activity and conversation-stage summaries. Capture, review, people, companies, pipeline, reports, and Settings share the updated design tokens in `client/workspace-design.css`.

References inspected: [Attio reporting](https://attio.com/platform/reporting), [Attio navigation](https://attio.com/help/reference/attio-101/introduction-to-navigating-attio), and [Linear Insights](https://linear.app/insights). These informed information density, navigation hierarchy, and mixed chart/table cards; no product assets or branding were copied.

## Analytics

`/analytics` is available to company admins/managers and private-space owners. `/api/analytics` independently enforces the same role boundary. The page includes:

- 7-, 30-, and 90-day periods, saved in the URL, plus accessible-event filtering.
- Unique people met, distinct companies, current open/won company deal values, and comparison with the previous equal-length period.
- A daily people/conversation chart, saved lead-quality distribution, current stage snapshot, event activity table, and links to recent people.
- Refresh and CSV export of the selected daily activity.
- Empty, loading, and retry states, with responsive desktop and phone layouts.

The date range selects accessible encounters. Archived/deleted people are excluded. Repeated encounters count as separate conversations, while the period's people total counts each person once. Daily and per-event unique-person counts can sum to more than the period total. Company values are counted once per company in the selected cohort. They are current recorded values, not revenue earned during the selected dates or event attribution. Stage distribution is a current snapshot, not a historical conversion funnel. The selected event's time zone is used; otherwise the active event's time zone is used, with UTC as fallback. The query does not inherit the 200-record people-list limit.

All charts use stored CRM data. Synthetic seeded encounters can all occur on the seeding date, producing an honest spike rather than an invented smooth trend.

## Verification

`npm run test:e2e -- tests/e2e/analytics.spec.ts` verifies UI filters, chart switching, refresh, CSV download, record navigation, phone overflow, role/event isolation, 205 unique people, repeated encounters, archived exclusion, previous-period counting, a UTC+14 event, and counting a shared company value once. The route audit and control crawl include Analytics. Screenshots are saved under `docs/screenshots/analytics-desktop.png` and `analytics-phone.png`.

Final local checks on 2026-09-30: `npm run build` passed; `npm test` passed 19 tests; `npm run test:e2e` passed 39 journeys in 3.6 minutes, with 11 specialized cases intentionally separate. The desktop/phone control crawl exercised 580 controls and found two Home links with 34 px phone hit areas. Both were increased to 44 px. `npm run audit:controls:phone` then passed all four checks, exercised 234 controls, and reported zero undersized phone targets. The immediate-upload review and repeated follow-up/meeting actions passed on desktop in the combined run and on phone in the final rerun. This is a bounded visible-control audit, not every possible conditional state or a full screen-reader audit.
