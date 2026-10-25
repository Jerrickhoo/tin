# P7 verification — calendar and focused review

Prepared for main on **2026-10-25 (Asia/Manila)**. P7.1 and P7.2 are implemented locally. No push or deployment was performed. Existing P6 work in the checkout was preserved. D14's recommended four-block layout and Upcoming-first calendar navigation were adopted for the user's instruction to implement P7.

## Delivered behavior

- `/calendar`, linked from Upcoming and Insights, reads actual groups, schedule occurrences, debt deadlines and expected allowances from the existing records. Month/day query parameters survive source navigation and Back. Monday/Sunday preference controls the grid; date buttons support keyboard movement, and the agenda provides all item names and source links.
- Actual effective dates use Manila time. Correction chains contribute only their active head; voids disappear from actual totals. Income splits and linked payments appear once. Same-day paid occurrences collapse into the actual payment with a due-source link; early/late payments retain a resolved item on the original due date and the actual movement on its effective date. Due markers never contribute to actual totals.
- Calendar distinguishes actual, scheduled, overdue, partly paid, resolved, skipped, canceled and expected records with text. Unresolved overdue items on other dates remain accessible. Month-only expected allowance has no invented due day; it is shown once in an explicitly undated monthly section with its own subtotal.
- Insights has four default blocks: spending/returns, top categories, current funds/commitments and six recent periods. Envelope flows are under Details; streak/mix are absent. Current funds remain current while a historical or future report month is selected. Future holds, goals and commitments reduce free money through the authoritative availability selector. Unsupported reservations are not called funded after overspending removes their backing; shortfalls remain explicit.
- Gross, returned and net spending share the financial projection. Refunds/reimbursements count on receipt day; principal and transfers do not become spending or income. Adjustments are explained separately. Categories use gross purchase shares, archived names remain available, and missing labels remain unknown. Category and trend drilldowns carry their date bounds into History. Uncategorized and rolled-up category links explicitly open all entries in that period.
- Current-month trends use the same elapsed calendar dates, capped at each month's last date; shorter months and today's incomplete day are labeled. Completed months use full periods with differing lengths disclosed. Future, empty and incomplete/stale/offline snapshots have limited-data copy. No forecast is inferred from sparse activity.
- One read-only IndexedDB transaction loads the review snapshot. P7 creates no financial storage, migration, outbox command, automatic payment or expected-income posting. Patch notes identify build `2026.10.25.p7`.

## Review findings and fixes

| Pass | Problem found                                                                                                         | Resolution                                                                                                                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Month-only expected allowances appeared in both the agenda and the expected section.                                  | Excluded expected records from the dated agenda; retained one monthly section and subtotal.                                                                                                             |
| 1    | A future calendar occurrence could lie beyond Upcoming's default next-month projection.                               | Validated the occurrence's month from its existing identity and extended the read-only window; Edge verified a February 2027 source link opens the exact due item.                                      |
| 1    | Existing History incoming filters did not accept report date bounds.                                                  | Added validated incoming dates; tested all-ledger date/category filtering and browser Back restoration.                                                                                                 |
| 1    | New financial and UI paths lacked regression coverage.                                                                | Added paid-late, correction/refund, split-income, cancellation, future holds, funded shortfall, debt-direction, leap/short-month, archived-label, stale-response, retry, keyboard and navigation tests. |
| 2    | Two new test assertions used the wrong existing total field and an ambiguous amount query.                            | Corrected the assertions to `spentCentavos` and the labeled gross-spending value. Production totals were already correct.                                                                               |
| 2    | `text-base` collided with the app's `--color-base` token in both headings.                                            | Used explicit `text-[1rem]`; required token check passes.                                                                                                                                               |
| 3    | Initial browser automation used an outdated fixture name, and later screenshots could capture a cold unsynced mirror. | Corrected the fixture locator and required populated category/agenda data before the layout checks and screenshots. Browser/server processes were restarted after the session interruption.             |
| 4    | Same-day paid items still displayed a redundant resolved-due marker.                                                  | Collapse that marker into the actual movement while retaining the source link; keep separate due-date markers for early/late payments. Added a regression test.                                         |

All findings above are fixed. The final scan is scoped to P7 and affected regressions; it does not claim that tests prove the absence of every possible defect.

The last verification pass also corrected a browser form locator to use the Category combobox's accessible role/name, formatted this new report after its initial formatting-check failure, and used a fresh browser to verify the rebuilt service worker rather than an older cached client. Those were verification setup issues; no failed product check was waived.

## Verification

- Required repository check passed: zero dependency vulnerabilities; ESLint, formatting, contrast and token checks; **168 disposable SQL assertions**, **856 tests in 73 files**, and **9 staging/deployment guards**. Three credentialed integration files remain intentionally skipped by the safe check runner; P7 has no schema or financial-command change.
- TypeScript and production Vite/PWA build passed.
- Snapshot test compares every IndexedDB table before/after browsing multiple months and computing availability; no records are written.
- Actual Edge against the guarded disposable staging account: Calendar/History totals agree; category drilldown carries dates; Back restores the selected day; future subscription source links open their exact occurrence; Details opens; actual service-worker offline reload preserves Calendar/Insights and shows limited-data copy.
- Live disposable financial flow: created a ₱321.09 subscription due October 24, confirmed its actual payment on October 25, and verified zero spending on the due date and exactly ₱321.09 on the payment date in Calendar and History. A ₱777.77 expected allowance appears once in November's undated section with zero actual income. The final fresh-browser pass also confirms the same-day deduplication and due-source links.
- Layout matrix: **126/126 passed**, seven themes × three widths (1280/390/320) × six populated/current/historical/future views, with no horizontal overflow or uncaught browser errors. Populated screenshots were visually inspected. Artifacts and scripts are in `output/playwright/p7/`.
- Read-only configured backend capability checks pass. Release-file scan checks configured private credentials, private JWTs and literal source NUL bytes. Analytics has escaped `\0` sentinel strings, not literal NUL bytes; no key cleanup was needed.

Final command counts and browser results are recorded alongside `output/review/p7-check.log`, `output/playwright/p7/production-build.log` and the browser scripts/results. Private staging authentication remains in ignored `.local` files.

## Reproduce and release scope

```text
npm.cmd run check
npm.cmd run build
node --env-file=.env scripts/check-release-schema.mjs
```

The existing guarded disposable server can be rebuilt with `node scripts/serve-p5-staging.mjs --build-only`. Browser financial-creation scripts use that disposable account and are not idempotent. Read-only browsing and the matrix do not record money.

The existing large-bundle warning, physical-device verification and cross-device reset propagation remain the roadmap's deferred items. No newly identified P7 release blocker is intentionally deferred. P8 remains a separate phase; this record does not mark its broader release work complete.
