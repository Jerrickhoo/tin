# P5 verification — 2026-10-22 (Asia/Manila)

P5.1–P5.3 implement Upcoming, confirmed subscriptions and finite installment plans. D11/D12's recommended defaults were adopted for the user's instruction to implement P5. Git push and application deployment are separate from this verification.

## Resulting behavior

- The existing `/recurring` route is Upcoming. New definitions generate bounded reminders with stable schedule/month or schedule/ordinal keys. They create no money. Nominal days 29–31 clamp to each month without drifting. Paid and saved occurrences retain their original rule, amounts and fees; edits apply from next month. A separate reviewed option can revise saved future items that have no payment links, preserving the old terms and the existing funded hold.
- Subscriptions support pause, resume, explicit cancellation of every unpaid item including overdue/partial items, skip/reopen, actual payment review, and optional funded reservations. Actual payments remain recordable despite a shortfall. In-app reminder rows are unique occurrences; no background delivery or bank charging is promised.
- Account funds and budget after reservations are separate. Future budget holds, goal reservations and commitment reservations reduce shared availability once. An item's own hold is restored to its affordability numerator only to the extent it is actually backed; existing shortfalls cannot become fictional funds. Offline, pending, failed, never-completed or old sync snapshots do not claim fresh affordability.
- Installments use payment-time expenses. Creation records neither an upfront purchase nor cash. The user reviews already recorded purchases; an upfront financed purchase already expensed must be corrected before enabling payment-time tracking. Existing eligible installment expenses can be linked once. Principal amounts and explicitly entered fees are retained per term; no lender calculations are inferred.
- The 3 × ₱1,000 example gives zero completed / one partial / ₱2,600 remaining after ₱400, one completed / ₱2,000 remaining after another ₱600, and completion after a reviewed ₱2,000 payoff. Voiding that payoff reopens ₱2,000. Finite terms cannot be erased by subscription pause/cancel/skip controls. Completion derives from valid linked actual payments.
- Existing legacy templates remain visibly labeled **Auto-post on open**. A reviewed conversion uses the fresh server cursor, skips posted and voided deterministic groups, and atomically pauses the old template while saving its cutover. Converted templates cannot be resumed by an older client. Reminder-only schedules never invoke the catch-up poster.
- Monthly goal allocations appear by their existing P4 rule/month occurrence key and funded status. P4 remains the sole execution path; Upcoming introduces no second allocation scheduler.

## Review and fix log

The user requested repeated scans, a list of findings, fixes, and another scan. Findings from the implementation/review passes were:

| Pass | Problem found                                                                                                                                | Resolution and evidence                                                                                                                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | SQL variables conflicted with query aliases; first-pass compiler/form wiring and the previous backup-version fixture also needed adjustment. | Corrected aliases/types, sheet API use and version-6 rejection fixture. PostgreSQL rehearsal, typecheck, screen tests and full checks pass.                                                                                    |
| 1    | Initial sync state could imply fresh affordability, and payment links opened an unfiltered History page.                                     | Successful-sync freshness is explicit and cleared on stop; payment-chain URLs open the exact movement. Verified in Edge and component tests.                                                                                   |
| 1    | Legacy cutover could reintroduce a voided posting when the old cursor had not advanced.                                                      | Both preview and locked server transition walk deterministic consumed groups, including voids. SQL and real staging checks pass.                                                                                               |
| 2    | Adding an item's entire hold back after clamping could overstate budget when other actual spending had caused a shortfall.                   | Shared client/server calculations retain the signed shortfall. The ₱1,000 / ₱299 held / ₱800 spent fixture yields ₱200 for this payment, and an unfunded reservation is rejected.                                              |
| 2    | A date-only payment made before noon could be stored at today's future noon and not count immediately.                                       | Today's payment uses the current instant; earlier date-only entries use Manila noon. Future confirmations are rejected before enqueue. Actual early-morning Edge payment counts immediately.                                   |
| 2    | Review could leave two sheets active; a first installment with an earlier nominal day could disappear.                                       | Draft components remain mounted while their sheets close during review; the first installment date is validated. Review cancellation retains drafts; date and screen fixtures pass.                                            |
| 3    | Subscription pause/cancel/skip controls could hide unpaid finite terms.                                                                      | Restricted finite definitions and resolutions in client and additive migration 012. All unpaid terms remain in the obligation until paid. Local, PostgreSQL and three real staging rejection checks pass without cash changes. |
| 3    | The existing-expense picker offered already linked payments; ordering could move on pull.                                                    | Already linked/goal-consumed chains are excluded; definition ordering is stable. Payment identity and server caps still enforce duplicate protection.                                                                          |
| 3    | P4 allocations lacked funded status in Upcoming; schedule-only rejected drafts lacked readable details.                                      | Added an adapter over the existing rule/month identity and readable saved scheduling drafts in History. Adapter and History component checks pass.                                                                             |
| 4    | Settings described all upcoming items as auto-posting; Home/Budget/Goals labeled combined reservations as goals alone.                       | Updated copy, restore/reset descriptions, outbox explanations and combined reservation labels. Affected screen tests pass. Occurrence disclosures have 44px minimum targets.                                                   |

Pass 5 found that saved future unpaid terms lacked an explicit amendment path and that a 120-term payoff needs 121 events. Reviewed future-term revisions now preserve old snapshots and funded holds while protecting payment-linked terms (013). The bounded command capacity accommodates all 120 terms atomically (014). Local, SQL and real staging checks pass.

The final scan has no unresolved P5 findings. The evidence below bounds that conclusion; it does not claim testing proves the absence of all possible defects.

## Persistence and safeguards

Schedules use immutable owner-scoped `ledger_audit.details.schedules` events in the existing financial command, journal and FIFO outbox. No mutable stored cash balance or second ledger is introduced. Local writes, payment links and reservations commit together. Pull validation commits cash, schedule history and the cursor together, so malformed links cannot expose a partial snapshot. Rejected commands roll back dependent local activity and preserve their drafts.

The server serializes commands with the established owner lock, checks revisions and ownership, recomputes free funds and payment caps, rejects duplicate/stale confirmations, and validates imports and linked corrections/voids/restores. Helper functions and superseded RPCs are private. Old clients cannot bypass schedule semantics after an account starts using them. Direct old recurring postings at or after a converted cutover are rejected.

JSON backup version **5** preserves definitions, all revisions, occurrence snapshots, payment-chain links, resolutions and funded holds. Readers retain versions 1–4; downgrading a schedule-bearing bundle is rejected. Restore remaps category/envelope references, preserves dependent identities and validates before writing. Owner switch, logout and reset reuse the existing audit lifecycle. Both Home and Settings use the complete atomic backup snapshot.

Migration **011** adds the schedule command/projection/validation layer. Migration **012** is a follow-up to the already applied staging migration and prevents finite obligations from being erased through subscription lifecycle controls. Migration **013** adds explicit saved future-term revisions without repricing payment-linked items. Migration **014** accommodates all 120 terms and their payment link in one bounded atomic command. Previously applied migrations were preserved.

## Evidence

- `npm run check`: **827 tests passed, 3 credentialed integration files skipped**; **9 deployment/staging guards passed**. Dependency audit: zero vulnerabilities. Lint, formatting, AA contrast and token collision checks pass.
- TypeScript/Vite/PWA staging build passes. The SQL rehearsal is pinned as a dev dependency and runs in both GitHub CI and the deployment check. The existing large-bundle warning remains a documented, deferred performance item.
- Disposable PostgreSQL/WASM rehearsal: **168 assertions pass** across migrations 001–014, including the existing P2–P4 checks. P5 covers reminder-only creation, owner isolation, immutable terms, competing confirmation, replay, payment caps, partials, reservation consumption/void/restore, an existing expense link, shortfall funding, finite lifecycle rejection, canceled subscriptions, legacy conversion of a voided posting, old-client/direct-write rejection, helper permissions, account reset, future-term revisions and a full 120-term atomic payoff.
- Real isolated Supabase/PostgREST: **8 scenario groups pass**, plus **3 explicit finite lifecycle rejection checks** after migration 012. The disposable-target guard excludes the daily project. Restore across owners follows source reset to avoid identity collisions.
- Actual Edge: review cancellation retained the creation draft; a ₱299 reservation survived an offline service-worker reload and synced on reconnect; payment before Manila noon counted immediately; the History link showed the same single expense. The 3 × ₱1,000 partial/payoff/void example passed. Reviewed legacy conversion created no expense. An actual downloaded JSON backup is version 5 and contains the linked history. A saved future installment changed from ₱1,000 to ₱1,200 while its ₱1,000 hold and original audit snapshot remained intact; the server rejects repricing a payment-linked term.
- Final Edge matrix: **273/273 cases pass**, covering eight routes and five form/review views, seven themes and widths 1280/390/320. No horizontal/dialog overflow or uncaught page errors were found. Review cancellation preserved the 100-character draft in every theme/width combination. Viewport screenshots were visually inspected for the phone payoff and future-term review.
- Daily backup rehearsal: all **423 entries** and every existing field across all **11 public tables** survived local restoration and migrations 011–014 exactly. Financial, budget, goal and schedule invariants pass. Private backups and sessions stay in ignored `.local` files.
- Daily release gate: migrations **011–014 are applied and registered**. The post-migration read-only comparison still matches every backed-up field; authenticated owner isolation, helper permissions and PostgREST discovery pass. See [P5 main readiness](p5-release-2026-10-22.md).
- Source/file scan: no configured private credentials, private JWTs or source NUL bytes were found. Final report is in `output/review/release-file-scan.json`.

## Reproduce

Use `npm.cmd` on Windows when PowerShell execution policy blocks `npm.ps1`.

```text
npm run check
npm run build
npm run check:sql
node scripts/probe-p5-staging.mjs verify
node scripts/serve-p5-staging.mjs
```

Staging migration mode applies only missing P5 history to the explicitly disposable project and refuses reapplication. `scripts/release-p5.mjs prepare` takes a fresh private daily snapshot and rehearses it locally. Its `apply` mode checks migration hashes and rejects any snapshot drift before atomically applying the additive migrations; `verify` compares all fields again and checks authenticated isolation, helper permissions and PostgREST discovery. Existing cross-device reset propagation limits and physical-device verification limits remain as documented for P8.
