# Main commit readiness — 2026-10-25

This final review covers the P6–P8 working tree based on `9618bcf`, including the three follow-up reporting fixes. It supersedes the earlier 873-test readiness count in the historical P8 verification record. Publication remains a separate step.

## Resolved follow-up findings

| Finding                                                                  | Final behavior                                                                                                                                                                         | Regression evidence                                                                                                                                                |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Corrected entries affected totals outside their selected filters.        | Matching prior versions still find the correction chain as audit context. Record counts, spending, account movement and daily net include only versions matching the selected filters. | Rendered tests cover old/new periods and category/envelope changes. Edge confirms September Insights and History both show zero after an expense moves to October. |
| Paid schedules remained in reminders until the reporting clock advanced. | Reminders use the loaded snapshot's timestamp as well as the reporting clock. Newly paid items and their Home hints disappear after refresh; voided payments reopen them.              | Rendered tests cover refresh, mount, void and genuinely future payments. Edge confirms a fully paid installment has no reminder.                                   |
| Past Calendar months hid later overdue subscriptions.                    | Schedule projection extends through at least the current month while the agenda remains scoped to the selected month.                                                                  | Rendered tests cover past/future navigation. Edge retains both September and October overdue occurrences while viewing August.                                     |

## Final checks

- `npm run check`: **880 tests in 78 files**, **186 disposable PostgreSQL assertions**, and **9 deployment/staging guards** pass. Dependency audit reports zero vulnerabilities; lint, formatting, contrast and token checks pass. Three credentialed integration files are intentionally skipped by the safe ordinary runner.
- `npm run build`: TypeScript and production Vite/PWA build pass. The existing large-bundle warning remains.
- A clean export of the Git index installs from the lockfile and passes the same full check and production build on **Node 24.22.1**, matching CI's runtime series. This export contains no private environment files or scratch output.
- Read-only release schema discovery passes. A fresh daily snapshot restores into disposable local PostgreSQL with every field matching in all 11 public tables, including 432 entries. Financial, budget, goal and schedule invariants pass. Existing migrations satisfy the client; no new migration is required.
- The three original Edge reproductions pass after the fixes. The final browser smoke check passes **27 cases** across nine screens and widths of 1280, 390 and 320 pixels, without horizontal overflow or uncaught page errors. These checks use synthetic local records with backend connectivity disabled.
- Earlier guarded staging evidence for seven backend scenario groups and the phase layout/offline checks remains in `output/playwright/p6/`, `p7/` and `p8/`. The three follow-up fixes do not change the financial command protocol or schema.

The final commit includes application source, tests, release helpers, phase documentation and selected public verification artifacts. Private `.env`/`.local` files, generated builds and unrelated scratch review output remain local. The staged content is scanned before committing.

Existing documented limits remain: reminder preferences are device-local; account reset deletions require signing out on other devices first; physical-device/native-picker checks retain their earlier waiver; the large-bundle warning and buried sheet-history marker are deferred. No new release blocker remains from this review.

Commands and summaries are retained locally in `output/review/main-final-*.log`; the shareable summary is `output/review/main-final-verification.json`. The phase records describe historical verification stages; this document records the final commit review.
