# P2 staging verification — completed 2026-10-21 (Asia/Manila)

P2.1–P2.6 passed their local, browser and isolated Supabase staging gates. The user supplied `tin-p2-staging` and authenticated the CLI. Migration 007 was applied to that disposable project only. No production migration, deployment or daily ledger write was performed. P3 remains unstarted.

## Migration and actual gateway

The preflight verified that the staging reference differs from the daily project's references and that the CLI account can access it. The project started without the Tin schema. Migrations 001–006 were applied through `supabase db push` in a separate temporary workdir. A real authenticated account then inserted a synthetic legacy Cash expense of -123 centavos. Applying 007 preserved its ID, signed amount, Cash tag and null financial metadata. The schema cache was refreshed and the actual capability RPC returned 1. Applied migrations are recorded in staging's migration history.

The CLI performs a connection preflight before linked Management API queries. An initial IPv6 failure was resolved by linking only the temporary workdir, which populated the IPv4 pooler cache. The repository's existing daily project link was not changed. API/admin keys were retrieved into process memory; no service-role key or management token was written to the repository or reports.

Evidence: [migration result](../output/playwright/p2/staging-migration-result.json), [current access preflight](../output/playwright/p2/staging-preflight.json).

## Real authenticated backend scenarios

Thirteen scenario groups passed through the Supabase gateway/PostgREST:

1. Current protocol header permits owner financial writes.
2. Anonymous and foreign-owner reads/writes are isolated; direct financial metadata insertion is denied.
3. Older-client writes are rejected while the current client can replay legacy payloads.
4. Replaying an accepted operation adds no money; reusing its identity with a changed payload is rejected.
5. Partial expense reimbursements obey combined recovery caps; two competing payments cannot overpay.
6. Competing corrections leave one active successor; accepted replay is safe and superseded originals cannot be restored.
7. A rejected compound operation leaves no ledger, operation-journal or audit residue.
8. Two account-transfer legs conserve total money and envelope ownership under replay.
9. Lending/partial principal repayment retain typed links and enforce the outstanding cap.
10. Equal reconciliation adds audit only, is idempotent and rejects a stale preview.
11. Week preference round-trips through authenticated profile access.
12. Restoring another account's existing identities is rejected atomically.
13. After exporting and resetting the disposable source, a second account restores all 12 signed rows, 2 obligations and 12 original audit events, plus exactly one restore audit. Repeating the command changes nothing.

Restore scope: IDs are preserved and globally unique for entries/audit. This verifies recovery into another account after source reset. Copying a still-existing source ledger into another account on the same database is deliberately rejected as an identity collision; it is not an account-cloning feature.

Evidence: [server scenarios](../output/playwright/p2/staging-server-result.json).

## Actual app, service worker and reconnect

A production build of the unmodified app ran on `http://127.0.0.1:5192` with only the staging URL and public client key injected. Its real `/sw.js` controlled Edge. No transport shim or fixture server was used.

- Offline reload reopened the authenticated app and cached ledger through the service worker.
- A ₱50 Online expense updated the local balance and queued exactly one financial command. A full offline reload retained it and the pending Sunday week preference.
- Reconnect drained both queues, accepted one server operation and retained exactly one copy of that expense.
- With Edge offline, Fix queued a ₱60 correction. A second real client committed a competing ₱55 correction. Reconnect rolled back the rejected tentative effect, pulled the authoritative ₱55 version and retained the complete ₱60 draft.
- Reviewing then canceling that draft changed no money. After explicit discard of the rejected queue item, reviewing and rebasing the draft synced one active ₱60 correction. All three versions remained in one chain.
- Home, History and Insights agreed on ₱110 net spending and ₱2,390 remaining from the original ₱2,500 fixture. A real Settings JSON export contained 5 signed rows and all 5 server audit events in format 2.
- An independent server read confirmed the 5 rows, the active balance of 239000 centavos and the synced Sunday preference.

Evidence: [offline results](../output/playwright/p2/live-offline-result.json), [conflict recovery](../output/playwright/p2/live-conflict-result.json), [report agreement](../output/playwright/p2/live-report-result.json), [app JSON export](../output/playwright/p2/live-app-export.json), [Home screenshot](../output/playwright/p2/live-final-home.png), [retained draft screenshot](../output/playwright/p2/live-conflict-retained.png), [recovered chain screenshot](../output/playwright/p2/live-conflict-recovered.png). Screenshots were visually inspected. Browser requests while deliberately offline and the expected rejected conflict generated network diagnostics; successful final screens had no request errors.

The earlier seven Edge clock/timezone scenarios and their physical-sleep limitation remain recorded in [the browser verification log](p2-browser-verification.md#clocktimezone-follow-up--2026-10-21).

## Existing credentialed checks

All 3 previously skipped integration tests were run against staging and passed: first-run seeding, local-first ledger round trip and recurring catch-up. The full credentialed RLS probe also passed, including ownership FKs, append-only/void/unvoid behavior, habit tables and owner-scoped reset.

The recurring test initially expected a duplicate due-date announcement. The implementation already correctly skips known groups. Its assertion was corrected to require zero new postings/announcements and successful cursor advancement, retaining its balance and single-server-row assertions. No financial production code needed changing during staging verification.

Evidence: [first-run test](../output/playwright/p2/staging-seed-integration.json), [ledger/recurring tests](../output/playwright/p2/staging-live-integrations.json), [integration/server summary](../output/playwright/p2/staging-integration-summary.json). Local baseline: 726 tests passed; the 3 credentialed cases now have separate successful evidence. The 5 staging isolation tests, ESLint and `git diff --check` passed. The production staging build passed; existing bundle-size/dynamic-import warnings remain.

## Reproduction and retained limits

- `npm run p2:staging:check` is a read-only schema/access preflight. The temporary CLI link may create CLI connection cache/login-role state but does not change application data.
- `npm run p2:staging:prepare` is only for a fresh target before 007; it refuses an already-upgraded schema.
- `npm run p2:staging:verify` resets the four named synthetic probe accounts and reruns backend scenarios. It generates ignored temporary browser configuration/session artifacts.
- `npm run p2:staging:serve` builds/serves the actual app on port 5192 using that configuration. Browser scripts and screenshots are under `output/playwright/p2/live-*`.
- `npm run p2:staging:integrations` runs the existing credentialed tests and RLS probe with staging-only credentials. Its final browser-state assertions expect the recorded offline/conflict scenario to have run first.

Staging contains disposable synthetic data, including the restored backup and browser correction chain. The rejected draft remains retained in the browser's journal after explicit queue discard/rebase, as designed; it does not affect balances. The temporary browser was closed, the local preview stopped and the ignored browser auth-session file removed after verification. The already-upgraded preparation guard was also exercised against staging and refused before any probe-user changes. Physical OS sleep was not tested. The daily schema still awaits a separately planned release; staging completion does not apply migration 007 or deploy the new UI to production.
