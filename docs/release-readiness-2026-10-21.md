# Release review — 2026-10-21 (Asia/Manila)

P4 follow-up: goals and allocations are implemented and verified separately in [P4 verification](p4-verification.md). The P3 release decision below records the earlier source state. Daily migrations **009/010** were applied on 2026-10-22 after backup and rehearsal, preserving all existing data. Current deployment and live verification are tracked in [P4 release](p4-release-2026-10-22.md).

## Decision

**The P2, appearance, patch notes, and P3 source is ready for main after the final checks recorded here.** The daily database prerequisite is resolved: migrations 007/008 were backed up, rehearsed against all 420 existing entries, applied atomically, and verified without creating ledger probe writes. Netlify now gates publishing on the required checks and server schema prerequisites.

P3 implementation and release details are in [P3 verification](p3-verification.md). No Git push or application deployment was performed.

## Added

- Settings → Updates → Patch notes, with a dated current-build entry, categorized
  features/improvements/fixes, and an unread New badge that clears on opening.
- A direct shortcut from the notes to Appearance, correct Settings navigation
  highlighting on its related pages, and local/offline availability. Notes are
  maintained in [patch-notes.ts](../src/lib/patch-notes.ts); prepend a new entry
  with a unique build ID for subsequent updates. No fictional release history
  was added.

## Problems found and fixed

| Area              | Fix                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Financial history | Paginate obligations and activity with a stable ID cursor. A fresh device no longer stops at the first server page. Tests cover 1,000+ rows, smaller server caps, and failure on a later page.                                                                                                                                                                                             |
| Account switching | Hide ledger children until the correct owner's mirror is ready; finish the previous sync before adoption; cancel stale/unmounted boot continuations. Owner adoption/clearing and logout are serialized, with an atomic all-table owner switch. StrictMode and rapid owner changes are covered.                                                                                             |
| Authentication    | Session lookup and subscription failures offer recovery rather than an indefinite loading screen. Newer auth events outrank the initial session response. Login/signup/reset/update forms release their busy state after rejected requests and use fixed, actionable errors. Existing offline MFA behavior also handles thrown failures.                                                   |
| Touch keypad      | A completed delete hold no longer discards a following digit when release happens outside the delete key. Normal hold-release suppression remains covered.                                                                                                                                                                                                                                 |
| Dialogs           | Put focus inside an opened modal, preserve input autofocus, and return focus to the entry opener on close.                                                                                                                                                                                                                                                                                 |
| Layout            | Fix Insights header wrapping and grid card minimum widths at 320px for every theme.                                                                                                                                                                                                                                                                                                        |
| Appearance        | Make reduced texture stay consistent across navigation when storage writes fail and synchronize the control across tabs. Replace the low-balance warning color with a readable theme token.                                                                                                                                                                                                |
| Feedback          | Catch recurring-undo failures and ignore a cosmetic pending-count read if logout closes its database. Recovery copy no longer claims that offline entries are already on the server.                                                                                                                                                                                                       |
| Dependencies      | Update React Router to 8.3.0 and apply compatible dependency audit fixes. The full dependency audit reports zero vulnerabilities. The Router advisory concerns unstable RSC APIs, which this client SPA does not use; the affected dependency was nevertheless replaced. See the [maintainer advisory](https://github.com/remix-run/react-router/security/advisories/GHSA-qwww-vcr4-c8h2). |
| Repository/CI     | Fix formatting, exclude generated verification artifacts from formatting and generated fixture bundles from Git, remove literal NUL bytes from restore source without changing its delimiter, and add dependency-audit/staging-isolation checks to CI.                                                                                                                                     |

## Verification

- Full local suite: **788 passed, 3 credentialed integration tests skipped**. All three passed separately against isolated staging after migration 008, together with the full RLS probe.
- ESLint, Prettier, TypeScript/production build, token collision checks, and
  `git diff --check` pass.
- All theme contrast checks pass, including the low-balance warning and Neo Pop's
  yellow balance surface. Lowest checked ratio across themes: **4.90:1**.
- Dependency audit: **0 vulnerabilities**, including development dependencies.
- Deployment and staging guards: **9/9 passed**.
- Independent disposable PostgreSQL rehearsal: **76 assertions passed** for
  migrations, financial invariants, RLS/grants, replay, rollback, and restoration.
- Browser layout matrix: **315/315 passed** across seven themes and widths 1280/390/320, including the new Budget screen and spending-day form. Details are retained in `output/review/p3-browser-matrix.log`.
- Actual touch-context checks: all 14 theme/phone-width keypad layouts fit;
  caret insertion, long-delete clearing, arithmetic save, undo, keyboard
  preference, focus restoration, patch-note read state/shortcut, cross-tab
  texture, storage failure, and offline note navigation passed.
- Actual production build under the deployed CSP: no CSP violations or inline
  scripts; service worker controls the page; offline reloads of login, signup,
  reset and split routes passed. A saved Neo Pop theme applied on startup, and
  an offline login failed visibly and left retry enabled. Daily-project network
  requests were blocked in that browser context.
- Isolated staging passed eight new P3 backend scenario groups and actual service-worker offline plan/receipt/reload/reconnect flows. Prior P2 conflict, correction and linked restore evidence remains in [the staging verification record](p2-staging-verification.md). Writable probes remain restricted to staging.
- Publishable-file scan: no configured private credentials, private JWT
  candidates, or literal source NUL bytes found. Generated local reports are
  under `output/review/`.

Final P3 clean-install reproduction is recorded in `output/review/p3-clean-room-result.json`. An isolated source copy with no daily environment file passed `npm ci`, `npm run check` and the production build. All 192 runtime/configuration files matched the reviewed workspace. The earlier pre-P3 snapshot remains in `output/review/clean-room-tests.json`.

The remaining build size warning is a performance follow-up rather than a failing
check. Physical phone/OS sleep behavior was not tested in this review. The browser
fixture disables Supabase transport, so its local save/undo checks do not prove
server acceptance; server invariants are independently covered by the SQL
rehearsal and the retained real staging evidence.

## Production prerequisite — completed

The initial read-only daily schema check returned the following, before the migration:

| Check                    | Result         |
| ------------------------ | -------------- |
| `financial_capabilities` | 404 / PGRST202 |
| `entries.financial`      | 400 / 42703    |
| `obligations`            | 404 / PGRST205 |
| `ledger_audit`           | 404 / PGRST205 |
| `profiles.week_start`    | 400 / 42703    |

The original discovery report is `output/review/production-schema.json`. It is superseded by the successful backup rehearsal, guarded migration and read verification in `production-backup-rehearsal.json`, `production-migration.json`, and `production-verification.json`.

All original fields and 420 entries matched before commit. Both migrations are registered, both capabilities return 1 to authenticated callers, and PostgREST schema discovery passes. Migration 008 preserves legacy-only accounts during the migration/deploy gap; once an account uses new financial features, older clients must refresh. The current client replays historical queued payloads with protocol 2.

Include all new source files, tests, migrations 007/008, package lockfile and release documentation in the reviewed commit. Live environment files, private backups/sessions, and generated fixture builds are ignored. Refresh installed/open clients when the new application is published. No remaining production schema blocker was found.
