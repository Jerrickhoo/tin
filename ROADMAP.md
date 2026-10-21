# Tin — practical improvement roadmap

Implementation update: **2026-10-22 (Asia/Manila)**. P1 is complete under the user's human/device waiver. **P2.1–P2.6, P3.1–P3.3 and P4.1–P4.2 are implemented and deployed**, with local, Edge, isolated Supabase/PostgREST and real offline/reconnect evidence. The daily database has migrations 007/008 after the earlier verified backup and comparison of all 420 existing entries. P4 migrations 009/010 are now applied after a fresh backup and local rehearsal preserving all 423 entries and every field in all 11 public tables. GitHub CI and live authenticated read-only Edge checks passed. See [P4 release](docs/p4-release-2026-10-22.md). P5.1–P5.3 are now implemented and verified for main, including the backed-up daily migrations 011–014. The P5 client release is prepared locally. P6–P8 have not started. See [P5 verification](docs/p5-verification.md) and [P5 release readiness](docs/p5-release-2026-10-22.md). Initial findings remain the pre-P1 snapshot; phase records distinguish later changes and evidence.

This file replaces the root document's filename `ROADMAP.md` with the requested `roadmap.md`. The complete pre-existing roadmap is retained verbatim in the **Historical roadmap** appendix. Its historical completion claims and product rationale remain useful evidence, but are not verification of this checkout or the live deployment. `QOL-CHECKLIST.md` is preserved separately, including its unfinished checks. Use the new **P1.1–P8.2** identifiers for this improvement program; old numeric phase identifiers refer only to the appendix.

## Goal and guiding UX principles

Make Tin reliable enough for daily personal finance use while adding one understandable flow at a time. The user should be able to answer: **What do I actually have? What can I use this month? What did I spend? What is coming due?** Those are different questions and should have different labels.

- Keep Home centered on balances, available envelope money, and Add. Add new detail through account/envelope sheets and an Upcoming page before adding dashboard cards or navigation destinations.
- Preserve fast expense entry, the existing amount parser, touch keypad/keyboard escape hatch, and explicit Cash/Online choice. Notes remain optional; dates default to today and are always reachable.
- Use text and icons alongside color for type/status. Support keyboard focus, screen readers, large touch targets, narrow screens, and long labels. No hover-only explanations.
- Show the consequence before committing a correction, reconciliation, reservation, or payment. Canceling an unfinished form must leave money unchanged.
- Preserve historical facts and existing data. A scheduled bill, budget allocation, balance target, or reminder is not proof that money moved.
- Use the existing React/Vite, Vitest, Testing Library, fake IndexedDB, and Supabase architecture. No stack replacement or large redesign is a prerequisite.
- Historical decisions retained: seed split is **70% Needs / 20% Savings / 10% Wants**, shares and names are editable, categories belong to one envelope, and an actual expense may overdraw an envelope. Never block recording money that already left merely because a recommendation says it was unaffordable.

## Current app findings

### Source findings at planning time (before P1)

| Area | Existing behavior and evidence | Planning consequence |
| --- | --- | --- |
| Structure and navigation | `src/router.tsx` routes Home, History, Insights, Recurring, Import, Envelopes, and Settings. `src/components/NavBar.tsx` and `src/AppShell.tsx` own navigation and global Add/toasts. | Extend existing surfaces first; financial logic belongs in pure libraries and data modules, not duplicated inside screens. |
| Ledger and models | `src/lib/groups.ts` has four kinds: `income`, `expense`, `transfer`, `adjustment`. Rows carry signed centavos, envelope/category IDs, group ID, effective `occurred_at`, optional money type, and void fields. `supabase/migrations/001_core.sql` also has server `created_at`/`updated_at`, owner constraints, RLS, and column grants permitting only void-field updates. | New meanings and links require additive schema work and matching readers/writers. No existing refund, debt, goal, account entity, installment, or budget-month model was found. |
| Income and balances | `src/db/entries.ts` splits income across active envelope basis-point shares, or sends manual income to one envelope. Expenses are negative, one category implies its envelope. `src/lib/balances.ts` sums every non-voided signed row over all dates. | Existing envelope balances are cumulative, not monthly budget accounts. Changing a split does not recalculate history. |
| Cash and Online | `src/lib/money-type.ts` sums `online`, `reallife` (Cash), and untagged rows. `src/features/settings/Settings.tsx` saves device-local snapshot targets; Home can display those instead of ledger bucket totals, labeled as targets and with drift. | There are two logical money buckets, not a bank account ledger or real integration. Targets are not reconciliations and are not evidence of available funds. Keep an honest untagged residual. |
| Transfers | `addTransfer` in `src/db/entries.ts` writes opposite legs to two different envelopes with the **same** money type. `AddSheet.tsx` explains that the pot stays the same. | Envelope moves already exist. Cash ↔ Online is a distinct missing operation; existing transfer semantics must remain readable. |
| Spending and adjustments | `spentOnDay`/`spentInRange` in `src/lib/logging-streak.ts` and `spentTodayByEnvelope` in `src/lib/allowance.ts` count non-voided expenses only. `src/lib/analytics.ts` separates adjustments from income/spending. `totalsFor` in `src/lib/ledger-filter.ts` instead includes signed adjustments in spent/received totals. | Incoming money currently does not reduce daily expense spending. Report adjustment deltas separately and introduce classified returns without netting ordinary income against spending. |
| Dates and weeks | `src/lib/dates.ts` uses UTC instants and Asia/Manila day/month keys and half-open UTC month ranges. Home calls `spentInRange(today - 6, today)`: a rolling seven days. `AddSheet.tsx` builds/parses `datetime-local` using the device timezone. | Calendar-week reporting is a requested behavior change, not deletion/reset. Centralize the clock and make entry dates consistent with reporting timezone. |
| Entry | `AddSheet.tsx` has expense/income/transfer modes, ranked categories (`src/lib/category-rank.ts`), name search past 12 categories, recent note chips and frequent amounts. Notes/date are under “Note & date.” Frequent amounts already follow the keypad in source order, but the MoneyTypePicker sits between them. A category tap saves an expense. | Improve the existing picker instead of rebuilding it. Visible note/date must appear before the category save action. Place quick amounts immediately after the keypad with a clear keyboard-mode fallback. |
| History | `History.tsx` supports search, expandable kind/category/envelope/date filters, date presets, totals and money-bucket summaries, day/month separators, expandable rows, Fix and Void. `src/db/entries.ts` loads whole groups, paginates 200 rows, and searches all local entries when a query is active. | Preserve whole-group pagination and all-ledger search. Give controls and totals clear scope; show linked audit details inside one logical item. |
| Corrections and voids | `History.onFix` voids the group first and then opens a prefilled Add sheet. There is no original/replacement link. `fetchEntryPage` sorts by effective timestamp then row ID; grouping follows first appearance. `unvoidGroup` is exposed through an eight-second toast, not a permanent restore action. | Cancellation can leave only the original voided. Equal effective times use IDs rather than correction relationships. Replace this sequencing before making repayments depend on it. |
| Monthly recommendations | `src/lib/allowance.ts` floors a positive envelope balance divided by remaining calendar days including today; zero/negative balance gives zero. `src/lib/envelope-month.ts` builds a pace meter anchored to the last positive income/adjustment, with recent spending used to decide whether to show a daily rate. | There is no selected-school-days model or explicit monthly allocation/reservation layer. Future-held money and adjustments must stop acting like fresh spendable top-ups. |
| Recurring | `src/lib/recurring.ts` clamps billing days 29–31 and computes due dates. `src/db/recurring.ts` catches up due templates on online app open, writes actual income/expenses through the local outbox, and uses deterministic UUIDv5 identities plus group existence checks. `AppShell.tsx` announces/undoes postings. Templates are fetched/configured online. | Current recurring is **auto-posted ledger activity**, not reminder-only scheduling. New subscriptions need explicit confirmation; preserve existing template intent until deliberately converted. |
| Insights | `Insights.tsx` provides monthly income/spend/net, category breakdown, comparison/projection, six-month trends, streak, spending mix vs plan, and expandable envelope flows. It uses `occurred_at`; the month selector ends at the current month. `analytics.ts` already supports partial-period comparison and early-month projection guards. | Retain useful comparison guards. Remove streak/mix from default analytical review and keep deeper flows optional. Future budgets need their own context and navigation. |
| Storage and sync | `src/db/dexie.ts` is a user-owned IndexedDB mirror, schema v3. Money writes update mirror + FIFO outbox atomically. `outbox.ts` supports insert/void/unvoid; `sync.ts` and `remote.ts` push and pull by server update cursors. Configuration writes in `config.ts` and recurring templates use Supabase directly. | Every new financial field/table must survive local write, outbox, push, pull, reload, export, restore, user switch and reset. New compound operations cannot be modeled as unrelated queue items. |
| Compatibility | `remote.ts` can retry inserts with `money_type` stripped on older schemas. Migration `005_money_type.sql` documents an earlier edit to migration 001 and the resulting lost tags. Export/restore in `src/lib/export.ts`, `src/lib/restore.ts` currently use format version 1; restore remaps envelope/category references by name. | Never silently strip new financial meaning. Introduce explicit capabilities/versioned bundles and preserve links/IDs through restore. Never rewrite previously applied migrations. |
| Existing tests | `package.json` uses Vitest; `vite.config.ts` includes `.test.ts` and `.test.tsx`, default Node, per-file jsdom, serialized files. Existing suites cover money/splits/dates, filters/groups, recurring, restore/import, Dexie upgrades/local-first writes, remote/sync loops, AddSheet, amount entry and BottomSheet. `Home.test.tsx` tests the card-facts helper, not a rendered Home. Supabase integration tests and `rls-probe.ts` write to probe accounts when credentials are supplied. | Add targeted tests to these tools. A green helper suite cannot verify History/Insights/Home wiring; typecheck/build and render/manual checks remain necessary. Do not run live probes against daily user data. |

No applicable `AGENTS.md` was found in the workspace, its inspected ancestors, or the repository file search. Historical roadmap engineering rules were read as repository context. No runtime reproduction, test-suite run, browser check, or live-schema inspection was performed for this documentation-only task; past test counts and deployment claims have not been re-certified.

### Suspected issues and limits of the evidence

- The reported `[Object Object]` toast has a plausible source: many catches use `err instanceof Error ? err.message : String(err)` in AddSheet, History, Insights, AppShell and the outbox; some config/template paths throw Supabase plain objects. A plain object stringifies to `[object Object]`. The exact user-triggered path is unconfirmed; P1.1 must reproduce the behavior with a structured error.
- Ordering follows the source described above; the particular confusing void/replacement example has not been reproduced. Relationship-aware rendering is preferable to simply reversing the sort.
- Home has wake-driven check-in refresh via AppShell, but no shared reporting-day clock was found in Home. A foreground session crossing midnight may retain stale period totals until another refresh. P2.5 verifies this with a fake clock.
- Local snapshot targets can explain a displayed balance disagreement, but cannot explain an unrecorded real transaction. The app cannot discover missing transactions without an integration.
- QOL's unchecked browser verification conflicts with historical roadmap §18.6, which claims a later successful browser run. Preserve both records; obtain fresh evidence after entry changes instead of assuming either status describes this checkout.

### Outstanding work carried forward

The appendix retains every old section and task. These items remain visible so the new program does not erase them:

| Historical item | Disposition in this plan |
| --- | --- |
| Home, History, Insights and AppShell render coverage; money-card/opening-offer/reset-panel wiring | P1.3, P1.4, P3.2, P7.2 and P8.1; helper tests do not close these gaps. |
| QOL mobile keypad/caret/sums/toggle browser check; real drag, scroll handoff and Back behavior | Fresh checks P1.2/P8.1; browser history/compositor behavior cannot be closed by jsdom. |
| Permanent restore after the void toast expires | Product decision D10; safeguarded action scoped to P2.2, not blanket restoration of superseded records. |
| Sticky sync pill/day header agreement and guessed 12-category threshold | P1.3 layout checks and P1.2 usability check. |
| Untagged historical balances and possible bulk tagging | Keep unknown values; reconciliation P2.6. Bulk tagging remains deferred, needs a separate reviewed design and must preserve append-only history. |
| RLS probe lacks money-type-specific coverage; archived category revival path untested | P8.1 targeted probe additions in a disposable test environment. |
| Cross-device account reset does not propagate; new table FK/reset ordering | P8.1/P8.2 preserve and verify explicit other-device sign-out guidance. Reset propagation remains a recorded limitation; no silent claim of a solved sync protocol. |
| Untested sync dirty-teardown microtask window | Retain as deferred engineering investigation; change it only with a reproducible failing case. Re-run existing sync-loop tests for new operations. |
| Analytics sentinel/NUL concern | P7.2 re-check actual bytes first; clean up only if present and justified. Historical claim alone is not proof. |
| Biggest single expense and weekday-pattern insights | Deferred optional ideas; P7.2 does not quietly expand default panels. |
| Back-dismiss stale navigation entry when a sheet is buried | Retained limitation, manually verify P8.1; broader router/history repair is excluded unless a regression blocks a planned flow. |
| Bundle splitting, GCash PDF reader | Bundle splitting stays deferred; PDF reader stays deliberately dropped. Neither is revived by this roadmap. |
| Migrations 005/006 | Historically recorded as applied in §17.8. Do not list them as pending or reapply blindly; inspect target schema/history at the next migration gate. |

## Shared financial and date rules

**D1–D4 were explicitly accepted by the user on 2026-10-19.** The corresponding rules below are the accepted target contract for P2. Other proposed decisions remain open until their dependent phases. P1.4 records the contract and characterizes current behavior; it does not ship the proposed calculations or persistence model.

### Accounts, allocations and availability

1. **Physical money:** Cash and Online are the first logical accounts; retain stored `reallife` compatibility and display Cash. Keep “Not tagged” separate. Account balance is the signed sum of active actual ledger movements through the as-of instant, never a manually overwritten stored total. Named bank/e-wallet accounts and bank feeds are excluded from this program's first version.
2. **Envelope money:** existing signed envelope balances remain the ownership of physical money across envelopes. A physical transaction may move money in an account and an envelope at once; those are two projections of the **same** movement, not two assets to add. Parent + children likewise cannot be summed as additional money.
3. **Budget period and holds:** future budget assignments and sub-goals are allocations/reservations, not cash movements. Define current available per envelope as its cash-backed balance less future-month holds, active goal reservations, and funded commitment reservations. Use unique reservation identities so one subscription paid from a goal is not reserved twice. Show any shortfall separately; clamp the recommendation numerator to zero, not the actual balance. Unfunded commitments remain obligations, not fictional reserved money.
4. **Source of truth:** Settings targets may be shown as observations/targets only. They must not enter account balance, affordability or daily recommendation calculations. A reconciliation turns a reviewed difference into a real transaction/adjustment, or explicitly classifies an unknown account without changing total wealth.
5. **Currency:** PHP integer centavos, safe-integer guards on inputs **and accumulated sums**, existing `MAX_CENTAVOS` limits and BigInt split arithmetic. Basis points total 10,000 for a complete split; largest remainder with stable order breaks ties. Floor daily rates and show remaining centavos honestly. No float-based financial persistence or currency conversion.

### Actual movements and reporting

| Intent | Account effect | Envelope/budget effect | Income and spending effect |
| --- | --- | --- | --- |
| Ordinary income/received allowance | Positive actual receipt once | Allocate once under current split or selected envelope and budget month | Income on receipt date; never offset expense spending merely because it arrived. |
| Purchase expense | Negative payment | Reduces relevant envelope and the effective month's spending | Positive gross spending; reservations used for this purchase are consumed/released atomically. |
| Merchant refund | Positive receipt linked to a purchase where possible | Restores the original envelope; restore a consumed reservation only by explicit choice | “Money returned” on receipt date; original purchase remains gross spending on its actual date. |
| Expense reimbursement | Positive receipt for someone else's portion of a recorded purchase | Restores that expense's envelope, capped at its eligible unrecovered amount | Qualifying money returned, not ordinary income. Show outstanding reimbursable amount. |
| Lending principal | Negative movement and a receivable | Reduces cash-backed available envelope money | Neither spending nor income. Track principal owed separately. |
| Borrowing principal | Positive movement and a liability | Assign actual received cash to an envelope while disclosing debt | Neither ordinary income nor spending. Net worth/liabilities are distinct from cash available. |
| Loan principal repaid to me / by me | Positive / negative actual payment linked to debt | Restores / reduces selected cash-backed envelope; reduces debt outstanding | Neither income nor spending. Does not reduce purchase spending. Explicitly entered interest/fees can be separate income/expense components later. |
| Cash ↔ Online transfer | Equal negative/positive account legs | Same envelope on both legs, no envelope net change | No income, spending or total-money change. Record a real withdrawal fee as a separate expense if needed. |
| Envelope transfer | Same account, two opposing envelope legs | Moves ownership, total unchanged | No income/spending; preserve existing transfer history. |
| Reconciliation adjustment | Signed actual ledger delta | Explicit balancing envelope allocation; not a monthly income top-up | Separate adjustment line, excluded from income, gross/net spending and behavioral trends. A known missing purchase must be an expense instead. |
| Scheduled/expected item | None until explicitly received/paid | May have a separately labeled funded reservation; expected income cannot fund it | No actual totals. Due/overdue does not imply paid. |

**Gross spending** is active purchase/fee expenses in the selected effective-date period. **Money returned** is active merchant refunds and expense reimbursements actually received in that period. **Net spending = gross spending − qualifying money returned**; it may be negative on a refund-only day. Label all three in details; Home may show net spending as the compact number with “after ₱X returned” and gross available on tap. Ordinary income, loan principal, transfers, void events and adjustments are excluded. A debt repayment only reduces net spending if it settles an explicitly expense-backed reimbursement, not just because the UI says “repaid.”

For an old purchase refunded today: today's return affects today's net cash-spending measure; last month's gross spending remains unchanged. Show lifetime recovery beside the original for context without subtracting it from both periods. Legacy incoming entries stay income until deliberately corrected; do not infer a refund from notes, a person's name, or a matching amount.

### Dates, audit, ordering and duplicate protection

- **Recorded at:** immutable client recording timestamp for offline audit, retained after sync; server creation/update timestamps remain sync metadata. Historical server-created timestamps may approximate recording time, but offline sync delay makes them imperfect; display “recorded time unavailable” if unknown rather than inventing a time.
- **Effective at:** when actual money moved (`occurred_at` remains compatible). Backdating changes financial reporting dates, not recorded-at. New date-only input uses an explicitly defined Manila instant (recommend noon for an explicitly chosen backdate); unchanged Today uses the actual current instant. Existing exact times survive a correction unless the date changes. An optional time control can be disclosed; the date itself stays visible.
- **Budget month:** explicit `YYYY-MM` assignment, initially defaulting to Manila month of effective receipt. It is independent of recorded and received dates. Future received allowance appears once in actual-date history and once as a reference in its budget-month view; these views must not be combined as duplicate cash records.
- **Expected date:** scheduling metadata with no actual movement. Recording expected allowance as received requires an explicit receipt action and actual account/date.
- **Reporting timezone:** keep Asia/Manila consistently even when the device travels. Boundaries are local midnight. Calendar week defaults to Monday 00:00 through next Monday 00:00, with Sunday preference; show “This week · Oct 19–25.” Keep rolling seven days available as a separately labeled History preset. No rows are reset/deleted at a week or month boundary.
- Use half-open instant ranges `[start, end)`; inclusive day-picker bounds convert through Manila dates. Recompute on foreground local midnight, focus/resume and preference change, without needing a new ledger write. Selected-day schedules are calendar dates in that timezone; test leap years and December/January.
- **Correction:** collect replacement without voiding the original. Saving commits whole-group void + linked replacement + audit event atomically locally and remotely, with stable operation ID and preconditions. Cancel/failure leaves the original financially active. No destructive amount/category/account edits in place. At most one active successor per correction chain.
- **History ordering:** order logical chains by the active record's effective time (original time if no active replacement), stable chain ID as tie-breaker. Show the active replacement first inside the chain, then collapsed original, void reason/time and prior versions in recorded order. A standalone void stays at its original effective position; its void is an audit event, not a second spending row. If a correction changes the date, show the chain at the new date with an explicit “originally on…” link; search by the original date can still find the original as audit context without counting it.
- **Void/restore:** whole group only. Voids exclude all of that movement's monetary effects. Superseded originals cannot be independently restored alongside their successor. Linked refund, repayment, reservation, and obligation effects must be reversed or resolved together; do not leave paid status after voiding its payment. Store audit events for void/unvoid going forward; legacy void metadata is all that is known.
- **Idempotency:** one stable client operation ID per submission, reused after a lost response, retry, double tap, and reload. Schedule occurrence/payment, correction and repayment links have server uniqueness/ownership constraints and transactional validation. Client busy state helps UX but is not the financial guard. Two devices paying the same occurrence or correcting the same original must not silently both win.

### Worked examples: fixtures to implement, not claims about current behavior

All amounts below are pesos; persistence uses centavos. Each example starts independently, ignores unrelated reservations, and uses Manila dates. Ordinary unmentioned account/envelope balances remain unchanged.

| Scenario | Actions | Expected results |
| --- | --- | --- |
| Transfer | Online ₱2,000, Cash ₱500; move ₱300 Online → Cash, owned by Needs. | Online ₱1,700, Cash ₱800; total ₱2,500. Needs unchanged; income, gross/net spending and budget allocations unchanged. Retry creates no extra legs. Void restores ₱2,000/₱500. |
| Partial expense repayment | Oct 19: pay ₱600 from Cash/Needs for a shared purchase; ₱400 is owed by a friend. Oct 20: receive ₱150 Cash as reimbursement. | Oct 19 gross/net spending ₱600, receivable ₱400. Oct 20 gross ₱0, returned ₱150, net **−₱150**. Outstanding ₱250. Across both days gross ₱600, returned ₱150, net ₱450. Cash/Needs rises ₱150 at repayment only. Repeating submit changes nothing. A second ₱250 settles it; a further ₱1 needs a separate classified receipt. |
| Partial loan repayment | Lend ₱600 Cash; receive ₱150 next day. | Cash first −₱600 then +₱150; principal outstanding ₱450. Gross spending, money returned from purchases, net spending and ordinary income all ₱0. Same repayment machinery, different origin classification. |
| Corrected expense | Starting Cash/Needs ₱1,000; record ₱200 expense on Oct 19, then correct to ₱250 keeping the date. | Cash/Needs ₱750; gross spending ₱250, not ₱450. Original ₱200 retained but voided; active ₱250 replacement above it inside one chain. Canceling correction instead would leave ₱800 and the original active. Reject replay/conflicting second replacement. |
| Balance adjustment | Ledger Cash ₱1,000; actual Cash ₱900, cause unknown; user chooses Needs for reviewed −₱100 adjustment. | Cash and Needs each −₱100; total money −₱100, separate adjustment −₱100; income, gross/net spending unchanged. Audit captures expected ₱1,000, observed ₱900, delta, account, reason and timestamp. If cause is a missed ₱100 meal, record an expense instead and gross spending becomes ₱100; never apply both. |
| Early allowance | Record Oct 25, actually received Online Oct 24: ₱10,000 for November, split 70/20/10. | Physical Online/total +₱10,000 on Oct 24; October actual income +₱10,000. November allocations Needs ₱7,000/Savings ₱2,000/Wants ₱1,000; all ₱10,000 held out of October availability. November budget history references the same receipt with all three dates/contexts. Nov 1 releases the hold into November availability without another receipt, income event or split. Merely expected ₱10,000 has **zero** current account/budget funding effect. |
| Scheduled subscription → payment | Online/Bills envelope has ₱1,000; subscription occurrence ₱299 due Nov 5, optionally funded with a ₱299 reservation. Confirm Nov 5 paid Online. | Before payment account remains ₱1,000, actual spending ₱0; if funded, unreserved balance ₱701. Confirm creates one ₱299 expense and links occurrence: account/envelope ₱701, actual spending ₱299, reservation consumed, remaining unreserved still ₱701. Repeat confirm is a no-op/conflict, not a second expense. Canceling a future occurrence changes no actual money; voiding payment restores money and makes the obligation unpaid. |

## Recommended phases and dependency order

| Phase | Independently deliverable outcome | Gate before downstream financial features |
| --- | --- | --- |
| P1 — entry, errors and baseline | Readable errors, visible note/date, understandable History controls, documented financial contract and regression fixtures. | P1.4 contract accepted and current behavior characterized. P1.1–P1.3 can ship separately. |
| P2 — trusted ledger operations | Compatible financial metadata, safe corrections, classified returns/repayments, account transfers, calendar weeks, reconciliations. | P2.1 semantics persisted end to end; each feature's own invariants pass. |
| P3 — periods and recommendations | Received future allowance held correctly, future navigation, selected-day budgeting. | Allocation/availability invariants pass before advice uses them. |
| P4 — goals and allocations | Child goals and monthly reservations within envelopes. | Reservations never double count; insufficient funds remain visible. |
| P5 — commitments | Shared schedule occurrences, confirmed subscriptions and finite installments. | Scheduled items cannot create money; each confirmation links one real payment. |
| P6 — utang completion | Manage debts and repayments in one shared system, with user-only reminders. | Debt totals derive from validated principal/repayment links. |
| P7 — calendar and review | A calendar from existing records and a focused Insights review. | All included record types use the same financial projections and schedule identities. |
| P8 — rollout and retained checks | Migration rehearsal, broad regression and careful release. | Applies incrementally to every earlier data-changing step; not postponed until the end. |

Critical paths: **P1.4 → P2.1 → P2.2 → P2.3 → P6.1** for debt; **P2.1 → P3.1 → P4.1 → P4.2** for availability; **P2.2 + P3.1 + P4.1 → P5.1 → P5.2/P5.3 → P7.1** for scheduling. P2.4/P2.5 can follow P2.1 independently of return UI. P7.2 follows all types it reports. No calendar prerequisite for basic subscriptions or debt entry.

## Detailed implementation checklist

**How to use a step:** request its stable ID. Keep work within its scope and exclusions, re-read its referenced code, and update its status here. Each Gate is blocking for dependent steps. Mark `[x]` only with recorded acceptance evidence, automated results and manual results; otherwise leave `[ ]`, state partial progress, blockers and next check. Existing test names below are verified; “new/proposed” paths do not yet exist.

### P1 — daily entry and trustworthy foundations

- [x] **P1.1 — Readable errors and the broken-toast regression.** Implementation, automated and Edge checks complete; remaining human/device checks were waived.
  - **Problem/behavior:** a structured error must produce a friendly sentence and an appropriate retry/sign-in/check-input next step instead of `[object Object]`.
  - **Scope/exclusions:** add a shared unknown-error normalizer and use it in AddSheet, History, Insights, Home, AppShell, Settings, config/template and outbox-facing error paths; retain operation-specific context. No financial rules, dependency installation, remote telemetry service or broad async refactor.
  - **Dependencies:** none; smallest first implementation task.
  - **Files:** `src/app-context.ts`, `src/AppShell.tsx`, affected feature catches, `src/db/outbox.ts`, `src/db/config.ts`, `src/db/recurring.ts`; proposed `src/lib/errors.ts` and tests.
  - **Data/compatibility:** no schema migration. Keep safe diagnostic code/operation/cause available in developer logs without tokens, notes, people, payloads or raw SQL in user messages. Handle existing persisted `last_error` strings safely.
  - **Acceptance:** structured Supabase-like errors, Error, string, null, nested/untrusted/circular values all yield bounded readable messages; known auth/network/validation cases give useful next steps; generic fallback never interpolates arbitrary objects or sensitive details; original draft remains after save failure.
  - **Automated:** Vitest normalizer cases plus a Testing Library AddSheet rejected-save test that supplies a plain object and asserts the actual toast text, preserved form and re-enabled retry; test sensitive details are absent.
  - **Manual:** force failed save/config operation in a test setup; read toast; retry successfully; check keyboard/screen-reader announcement and developer diagnostic redaction.
  - **Edges/gate:** error formatting must not itself throw. Gate: reported stringification failure reproduced by a regression that fails before the fix and passes after; relevant lint/typecheck/tests pass.

- [x] **P1.2 — Visible date/note and a compact category picker.** Implementation, automated and Edge checks complete; remaining human/device checks were waived.
  - **Problem/behavior:** users can annotate/backdate before tapping a category, find categories quickly, and reach quick amounts immediately below the pad.
  - **Scope/exclusions:** move optional note and native date control above expense save controls; default Today with no required date editing; place frequent amounts directly below keypad, or below amount tools in keyboard mode. Retain stable usage ranking, existing search past 12 items and `+ Other`; add envelope group headings within search results if a 20–40-category phone check demonstrates need. Favorites and a picker replacement are excluded initially.
  - **Dependencies:** none; P2.5 later centralizes date conversion. Preserve current effective instants in this layout-only step.
  - **Files:** `src/features/entries/AddSheet.tsx`, `AddSheet.test.tsx`, `src/components/Keypad.tsx`, `useAmountField.ts`, `src/lib/category-rank.ts`, `frequent-amounts.ts`, `entry-prefs.ts`, `src/styles/theme.css`.
  - **Data/compatibility:** no migration; preserve note length, saved preferences, explicit account choice and prefill behavior. Do not reintroduce remembered money-type defaults rejected in historical §18.2.
  - **Acceptance:** note/date are visible in all three modes without a disclosure; blank note saves as null; no forced date typing; quick chips below pad and do not replace an in-progress amount; zero-match search exposes Other; 40 categories stay searchable with stable results; category-tap save remains obvious.
  - **Automated:** extend existing AddSheet render cases for layout order, optional note, date prefill/invalid input, search and keypad/keyboard modes; retain money/keypad/parser suites.
  - **Manual:** 390×844 touch and desktop/keyboard; ₱50 quick amount, `120+45`, caret edit, clear, note/backdate, category save, no-match Other, scroll and Back/cancel.
  - **Edges/gate:** archived prefill, long names, zero categories and phone keyboard covering actions. Gate: these flows and accessible labels verified, with tap count recorded rather than an unsupported “two taps” claim.

- [x] **P1.3 — History controls with explicit scope.** Implementation, automated and Edge checks complete; remaining human/device checks were waived.
  - **Problem/behavior:** users can distinguish the query, active filters, result totals and per-entry actions under search.
  - **Scope/exclusions:** show one compact row of removable active-filter chips and Clear; one labeled “Results” summary with period and loaded/all-matching scope; keep full filter picker collapsed unless needed. Put Fix/Void in entry details; text type/status badges use color only as reinforcement. Do not change financial totals or correction sequencing here; label current adjustment-inclusive totals as “Outflows/Inflows” pending P2.1.
  - **Dependencies:** P1.1 for readable failures.
  - **Files:** `src/features/entries/History.tsx`, `src/lib/ledger-filter.ts`, `src/db/entries.ts`, `src/AppShell.tsx`; proposed `History.test.tsx`.
  - **Data/compatibility:** no migration; preserve incoming router-state filters, whole-group pagination, search over all local rows, void visibility and scroll position.
  - **Acceptance:** user sees which period/filter a total covers; loaded-page totals never imply all-history totals; each filter clears independently; active and voided rows have readable text; count includes visible audit records only with a clear label; sync pill never covers sticky date headers.
  - **Automated:** render empty/loading/error/matching/voided states, filter chips, Clear, Home/Insights incoming filters, and load-older whole groups using existing filter/local-first suites.
  - **Manual:** find an entry older than 200 rows, combine date/envelope/category search, clear filters, expand actions, scroll with stuck-sync pill at 390px and 200% zoom.
  - **Edges/gate:** archived category labels and no matches must not look like missing data. Gate: controls, labels and total scope verified; P2.2 owns relationship ordering.

- [x] **P1.4 — Accept the financial contract and capture regressions.** D1–D4 accepted; current-behavior fixtures and local baseline recorded below.
  - **Problem/behavior:** later features must agree on what each peso and date means.
  - **Scope/exclusions:** resolve blocking decisions for P2; document current-versus-target projection contracts and build shared fixtures from the worked examples. Add current-behavior characterization tests, not failing future-feature tests or changes to production calculations.
  - **Dependencies:** repository findings above; decisions D1–D4 for P2 work. D5–D9 can be resolved at their later gates.
  - **Files:** this roadmap, `src/lib/{groups,balances,money-type,ledger-filter,analytics,dates,allowance,envelope-month}.ts`, corresponding tests, `src/db/local-first.test.ts`, `src/db/remote.test.ts`; proposed fixture helpers under `src/lib/` test support.
  - **Data/compatibility:** map every field through entry → local mirror/outbox → remote → projection → export/restore. Inventory historical four-kind/untagged rows and current schema capabilities without modifying data.
  - **Acceptance:** agreed decision entries name each intent, signs, account/envelope/report effects, date basis, recovery cap, cancellation and audit behavior. Tests expose the existing History/Insights adjustment discrepancy and existing rolling-seven-day behavior by name; they do not declare those proposed defaults already implemented.
  - **Automated:** current money/split/date/group/filter/analytics/local-first suites; add boundary and whole-group fixtures where missing. Establish baseline with local suites only, without probe credentials.
  - **Manual:** walk transfer, early allowance, refund versus loan principal and canceled correction examples with expected balances written down.
  - **Edges/gate:** record unknown legacy timestamps and classifications. Gate: accepted contracts and baseline evidence exist before P2 semantic changes; no unexplained failing baseline is inherited.

### P1 implementation and verification record — 2026-10-19

The P1 checkmarks mean implementation, local automated verification and the browser checks below are complete. The user explicitly waived the remaining three human/device checks; they were not executed. The historical appendix and `QOL-CHECKLIST.md` completion claims/checks have not been changed.

- **P1.1:** `src/lib/errors.ts` normalizes unknown errors into fixed operation-specific copy with auth, connection, input or generic retry guidance. Bounded traversal handles nested/circular values and hostile getters without stringifying objects. Developer diagnostics include only the operation, recognized protocol code and cause classification. AddSheet, History, Home, Insights, AppShell, Settings, envelope/category configuration UI, recurring UI/posting and sync/outbox paths use it. Persisted queue errors are redacted when displayed. Remote error wrappers preserve their structured cause; known partial-reset outcomes retain explicit recovery guidance through fixed messages. Error toasts now have `role="alert"`.
- **Broken-toast evidence:** the new AddSheet rejected-save render test was run before the fix and failed with actual alert text `[object Object]`. It now passes with `Could not save the entry. Check your input and try again.`, retains amount, note, date and Cash choice, re-enables save and successfully retries. Unit tests verify sensitive SQL/token/note/person strings are absent from messages and diagnostic output.
- **P1.2:** note and native date/time controls are visible in all three modes before save actions. Current device-time conversion is preserved and labeled explicitly; P2.5 still owns Manila input semantics. Frequent amount shortcuts sit immediately after keypad/amount tools, disappear once typing starts and preserve the keyboard escape hatch. Recent notes, usage ranking, category search, explicit Cash/Online selection, archived-category fallback and Other remain. Tests cover 40 searchable categories, stable results, no-match Other, layout order, prefill/backdate, blank date, blank-note persistence, both pointer modes and retry. No envelope search headings were added without the requested phone usability evidence.
- **P1.3:** active filters appear as independently removable chips plus Clear while the full picker starts collapsed. Results state Manila period, loaded-page versus all-matching local scope, records including voided audit items, adjustment-inclusive Outflows/Inflows and account net movement. Results wait for data matching their scope. Entry type and Active/Voided status have text; Fix/Void remain inside details. Loading, error/retry, empty and no-match states are distinct. Whole-group reads and pagination remain intact. The sync pill publishes its measured bottom plus clearance, including resize/wrapping, instead of a guessed height; History consumes the same CSS variable. Render tests cover these behaviors, incoming Home/Insights filters, archived names, older whole income groups, and the existing unsafe correction sequence.
- **P1.4:** `src/lib/test-support/financial-fixtures.ts` stores the worked examples in integer centavos and exports shared deterministic rows used by projection and History render tests. `financial-baseline.test.ts` names existing differences rather than testing future financial behavior as though it already existed. No production financial calculations were changed.

**Accepted decisions.** The user explicitly selected “Accept recommended D1–D4.” D1 means gross/returned/net spending with qualifying returns on receipt day; ordinary income and loan principal do not reduce purchase spending. D2 means logical Cash/Online plus an honest untagged residual; account transfers use opposing account legs with explicit envelope ownership. D3 means immutable financial meaning, an atomic linked correction with one active successor, and cancellation/failure leaving the original active. D4 means one obligation/settlement model with expense recovery capped at eligible unrecovered principal and explicit classification of excess. The user subsequently accepted D5/D6/D10: Manila dates with Monday/Sunday preference, reviewed reconciliation and guarded standalone Restore. D7–D9 and D11–D14 remain subject to their later gates. The P2 record describes the implemented storage shape; these were still target rules at the P1 snapshot.

**Current-to-target walkthrough.** Each scenario is independent; amounts here are pesos.

| Example | Current characterization / accepted target |
| --- | --- |
| Transfer | Existing envelope transfers move ₱300 between envelopes within one money type, net account change zero; whole groups survive filtering. Target account transfer: Online ₱2,000 → ₱1,700 and Cash ₱500 → ₱800; total ₱2,500 and envelope ownership unchanged. The target operation does not exist yet. |
| Early allowance | Current ₱10,000 receipt on Oct 24 counts in October income and cumulative balances immediately; Needs ₱7,000 over eight remaining days gives ₱875/day. Target reserves all ₱10,000 for November and gives it zero October availability, with no second receipt on Nov 1. |
| Refund versus loan | A current legacy ₱600 expense plus ₱150 ordinary-income receipt leaves cash −₱450, expenses ₱600 and income ₱150; the app cannot infer reimbursement/principal intent from notes. Accepted reimbursement target: gross ₱600, returned ₱150, net ₱450, outstanding ₱250 of the original ₱400 obligation. Lending ₱600 and collecting ₱150 instead leaves principal ₱450 with zero purchase spending/returned/income. Receipt-day reimbursement net may be −₱150. |
| Canceled correction | Current History calls void before opening the replacement draft. Starting ₱1,000 less ₱200 gives ₱800, but canceling after that void leaves ₱1,000. Accepted target keeps ₱800 on cancel; saving ₱250 atomically leaves ₱750. The render characterization records the current sequencing bug; P2.2 must replace it. |
| Adjustment | A reviewed −₱100 changes Cash/Needs from ₱1,000 to ₱900. Current History counts ₱100 outflow while Insights reports zero expense spending and a separate −₱100 adjustment. P1 labels that difference honestly; P2.1 must unify projections. Positive adjustments currently anchor the pace meter. |
| Subscription | Accepted fixture: ₱1,000 actual money, ₱299 reservation, ₱701 unreserved; spending stays zero until explicit payment. Payment leaves actual money ₱701 and spending ₱299, consuming the reservation without subtracting it again. Reminder/reservation/payment semantics are later work. |

**Field survival inventory (checked-out code, no live schema inspection).**

| Field / meaning | Entry → mirror/outbox → remote → projections → backup/restore |
| --- | --- |
| `id`, `group_id` | Client UUIDs survive local inserts and queued payloads, idempotent remote upserts, pull and JSON backup/restore. Groups remain whole in queries, pagination and restore chunking. Correction/operation identity is not represented by these IDs yet. |
| `kind` | Four historical kinds (`income`, `expense`, `transfer`, `adjustment`) survive all existing paths. Refund, principal, reservation and payment intent cannot be represented without additive work. Notes are not classification. |
| `envelope_id`, `category_id` | Category implies its envelope; mirror/outbox/remote retain IDs. JSON exports references; restore remaps by envelope/category names. This is insufficient for future immutable linked objects without a versioned identity strategy. |
| `amount_centavos` | Signed integer legs survive storage, sync and JSON restore; projections exclude voids. Transfers cancel overall. Existing input/split bounds and largest-remainder tests remain green. Accumulated-sum safety and future operations remain later gates. |
| `note` | Optional, bounded by the entry form; blank/whitespace persists as null. Stored and exported/restored; never copied into normalized errors or diagnostics. |
| `occurred_at` | Effective instant survives queue/push/pull/JSON restore (canonicalized to UTC). Current form uses device time; reporting uses Manila. Unknown historical recording times remain unknown; corrupt effective timestamps are not silently assigned today. Restore rejects unreadable timestamps. |
| `money_type` | Optional Cash (`reallife`), Online, or untagged survives normal current-schema insert/pull and JSON export. **Newly characterized gap:** v1 `parseBundle`/`planRestore` drop the tag, and CSV has no money-type column. An older remote schema may also trigger the existing tag-stripping retry. P2.1/P8.1 must address these compatibility gaps before adding new financial meaning. P1 does not rewrite historical data or silently change restore semantics. |
| `voided_at`, `void_reason` | Local whole-group operations queue separately, remote column-granted updates and pulls retain flags, projections exclude them, JSON restore reinserts then applies whole-group voids. No immutable audit event chain or supersession constraint exists yet. |
| Recorded time, operation/origin links, obligation/settlement/account-transfer purpose, budget month, reservation identity | Not in the current entry model/mirror/outbox/export v1. Server `created_at`/`updated_at` are remote/sync metadata and cannot reconstruct an offline recording time reliably. New meanings require additive schema, explicit capabilities and matching round-trip tests. |

**Verification evidence.** After the Edge follow-up, `npm test -- --reporter=dot`: **682 passed, 3 skipped**, 45 test files passed and 3 live integration files skipped. `npm run lint` and `npm run build` pass, including TypeScript. The existing large-bundle warning remains; bundle splitting is still deferred. Tests used fake IndexedDB and mocked remotes; no live probes, schema migration or deployment was run. Characterizations explicitly retain the adjustment discrepancy, rolling-seven-day reporting, positive-adjustment pace anchor, canceled-correction risk and v1 restore tag loss as known later-phase work, not unexplained failing tests.

**Edge follow-up — 2026-10-19.** The user connected Edge and requested the remaining checks. A dedicated local origin with disposable IndexedDB data exercised the real screens with simulated sync/failure boundaries. See [the reproducible fixture and detailed results](output/playwright/p1/README.md), [390px History evidence](output/playwright/p1/history-390.jpg), and [narrow navigation evidence](output/playwright/p1/narrow-navigation.jpg). Production data was not used.

- [x] P1.1 real-browser failed save and category-config operation; retained drafts, successful single-save retries, alert roles and actual redacted diagnostic arguments verified.
- [x] P1.2 Edge at 390×844 with coarse-pointer layout and 1280×900 desktop input: ₱50 shortcut, `120+45`, caret insertion, 850ms hold-clear, keyboard toggle/full reload, visible note/date in all modes, native backdate/blank-date validation, category save, no-match Other, long label/40-category search, zero categories, sheet scrolling, pointer drag and Back/Escape cancellation. Normal quick expense used four clicks (Add → ₱50 → Cash → Food), plus scrolling where needed.
- [x] P1.3 searched beyond 200 rows; combined and independently cleared date/envelope/category/kind/text filters; loaded older entries, expanded actions, verified incoming Home/Insights filters and no matches. Sticky header clearance was 8px at 390px and at 195px reflow. Accessible status/type text and dialog labels inspected in the rendered browser.
- [x] Fixed browser-discovered issues: Tab escaped the modal and the dialog lacked a name; BottomSheet now traps boundary focus and AddSheet supplies a mode-specific accessible name. At 195px reflow, Settings was clipped; navigation now wraps into two rows below 320 CSS pixels with sufficient page clearance. History now says `1 record` for a single result. Two focused keyboard regression tests were added.
- [x] **Waived by the user, not tested:** P1.1 human confirmation of actual spoken assistive-technology announcements. Alert roles and accessible names were verified; speech was not.
- [x] **Waived by the user, not tested:** P1.2 physical-phone touch/OS-keyboard overlap and touch-scroll handoff. Desktop Edge pointer/coarse-layout checks above do not certify a phone's native keyboard or touch compositor.
- [x] **Waived by the user, not tested:** P1.3 actual Edge browser-menu 200% zoom. The 195×422 viewport tests the equivalent narrow CSS reflow for 390×844 at 200%, but browser zoom shortcuts did not apply through the available connection.

The initial attempt had no browser connection; the subsequent Edge connection allowed the checked items above. Native Windows computer use still reports its pipe unavailable, so spoken screen-reader and browser-chrome interaction checks remain unverified. Browser timeouts during fixture updates were recovered using a fresh Edge tab; fixture HMR was disabled to avoid re-running its bootstrap. The user subsequently waived these three human/device confirmations and authorized proceeding to P2. P1 is complete under that instruction; the waived checks are not claimed as executed.

### P2 — reliable financial operations

- [x] **P2.1 — Persist financial meaning and unify report projections.**
  - **Problem/behavior:** refund, reimbursement, principal, income and adjustment must survive sync and be reported consistently.
  - **Scope/exclusions:** introduce additive group metadata for movement intent, operation ID, recorded-at, typed origin links and transfer purpose; retain signed ledger legs. Add shared projections for income, gross spending, money returned, net spending and adjustments; update History/Home/Insights and import/recurring adapters. No debt manager, future budgets or scheduled posting yet.
  - **Dependencies:** P1.4; D1–D3 settled; P8.1 compatibility gates applied to this migration.
  - **Files:** `src/lib/groups.ts`, `balances.ts`, `money-type.ts`, `analytics.ts`, `ledger-filter.ts`, `logging-streak.ts`, `allowance.ts`, `envelope-month.ts`; `src/db/{entries,dexie,outbox,remote,sync,import,restore}.ts`; `src/lib/{export,restore,import-draft}.ts`; new migration and proposed intent/projection module.
  - **Data/compatibility:** recommend metadata keyed by group ID with owner constraints, not note parsing or unsupported positive expense rows. Legacy rows retain existing kinds/meaning and unknown metadata. Mirror and export all new fields; version export bundles. Capability-gate writes if the server cannot retain intent, with a friendly upgrade-needed message; never downgrade a repayment to ordinary income.
  - **Acceptance:** the same fixture produces identical Home/History/Insights figures; adjustments always have their own line; account totals still equal envelope totals including archived/untagged money; ordinary income never lowers spending; legacy restores and old outbox payloads still work.
  - **Automated:** targeted projection cases for each rule-table row, one-cent/large sums, void exclusions, return-only negative net; local/remote round trips, old schema and old export fixtures, CSV labels and new JSON round trip.
  - **Manual:** seeded old account plus new classified receipt, offline save/reload/reconnect/export/restore; compare three screens and audit details.
  - **Edges/gate:** missing/mixed account tags, unknown origin, multiple legs, safe aggregate bounds. Gate: complete persistence chain and compatibility tests pass before any new semantic UI writes money.

- [x] **P2.2 — Atomic corrections and linked audit history.**
  - **Problem/behavior:** abandoning Fix must leave the original active; a successful correction shows one coherent chain.
  - **Scope/exclusions:** edit a draft first; atomically void original, insert replacement, link chain and append audit event on Save. Add relationship-aware rendering and guarded restore of a standalone void after toast expiry. No arbitrary in-place ledger updates or general conflict-resolution engine.
  - **Dependencies:** P2.1, P1.3; D3/D10; P8.1 migration safeguards.
  - **Files:** `src/features/entries/{History,AddSheet}.tsx`, `src/app-context.ts`, `src/lib/groups.ts`, `src/db/{entries,dexie,outbox,remote,sync}.ts`, `src/features/settings/Settings.tsx` outbox description, proposed correction operation/RPC and migration.
  - **Data/compatibility:** immutable original/replacement links and audit events; one compound outbox operation plus server transaction with expected active predecessor. Existing unlinked voids remain standalone, never guessed into chains by note/time. Concurrency rejection must keep a visible conflict, re-project the authoritative chain and preserve the unsaved draft; do not leave mirror-only money looking settled.
  - **Acceptance:** cancel/failing Save leaves original active; ₱200→₱250 example holds; chains show active version then collapsed prior versions, including after reload, search, pagination and changed effective date. Never unvoid a superseded original alongside its replacement. Linked paid/returned obligations require a preview and valid compound reversal/relink before correction is allowed.
  - **Automated:** local rollback, RPC transaction failure, lost-response retry, two-device predecessor conflict, repeated corrections, restore/void and export chains; History render tests assert relationship order independent of random IDs.
  - **Manual:** open Fix/cancel, fail save, retry, correct backdate, void/restore, inspect audit and reconnect offline correction.
  - **Edges/gate:** income split/account/target changes and archived categories must preserve original allocation unless explicitly changed. Gate: atomicity and conflict cases verified before linked repayments/payments depend on corrections.

- [x] **P2.3 — Classify money returned and share one repayment core.**
  - **Problem/behavior:** “repaid” must settle a known amount once and distinguish shared purchases from loans.
  - **Scope/exclusions:** contextual Refund, Reimbursement and Record repayment actions, optional origin selection for unknown historical refunds, and minimal “someone owes me / I owe someone” principal records. A shared repayment command handles amount/date/account, partial settlement, eligibility and reversal. The full debt list/reminders wait for P6; no interest calculator, automatic note classification or contacting people.
  - **Dependencies:** P2.1/P2.2; D1/D4. This core deliberately precedes the debt manager so History does not grow a conflicting repayment system.
  - **Files:** `History.tsx`, `AddSheet.tsx`, `src/db/entries.ts`, proposed obligation/repayment library and data module, `groups.ts`, shared projections; mirror/sync/export/restore and new owner-scoped obligation/settlement migration.
  - **Data/compatibility:** obligation origin type (`expense_reimbursement`, `receivable_principal`, `payable_principal`), original amount, optional person/due/notes and immutable settlement links to actual payment groups. Creating a claim against an already recorded expense creates no second cash outflow. Opening historical debt without a known disbursement is explicitly non-cash outstanding principal; no fabricated ledger movement.
  - **Acceptance:** eligible active expense shows Record reimbursement/repayment with amount still owed; ordinary expenses are not all labeled debt. Settle ₱150 of ₱400 once; show ₱250 left. Principal-only example never enters income/spending; refunds/reimbursements enter returned money on receipt date. Correction/void updates linked outstanding consistently; excess return requires a separate classification.
  - **Automated:** worked examples, zero/negative/excess amounts, recovery caps across refund plus reimbursement, duplicate submit, concurrent overpayment, corrected/voided origins and settlements, old export/unknown origin; History action render eligibility.
  - **Manual:** flag shared purchase, receive partial payment on another day/account, reopen/reload, complete repayment, void one payment, attempt duplicate and excess.
  - **Edges/gate:** overdue is not paid; payment account can differ from original; actor may be unnamed. Gate: outstanding amount and cash/report effects reconcile, end to end, before P6 adds more UI.

- [x] **P2.4 — Cash ↔ Online transfers without budget movement.**
  - **Problem/behavior:** withdrawals/top-ups change both physical buckets without becoming income or spending.
  - **Scope/exclusions:** distinguish “Between accounts” and “Between envelopes” in Transfer. Account move uses opposite account tags in the same envelope; show source, destination and preview. A simple envelope ownership selector is acceptable for the first version; automatic multi-envelope sourcing and named bank accounts are excluded.
  - **Dependencies:** P2.1/P2.2; D2.
  - **Files:** `src/db/entries.ts`, `AddSheet.tsx`, `MoneyTypePicker.tsx`, `src/lib/{money-type,groups,balances,entry-prefs}.ts`, History/Insights projections and applicable sync tests.
  - **Data/compatibility:** transfer-purpose metadata distinguishes legacy same-account envelope moves from new cross-account same-envelope pairs. `groupMoneyType` cannot represent both sides; use a source/destination descriptor rather than labeling a mixed transfer untagged. No new account table required for two logical accounts.
  - **Acceptance:** ₱300 worked example, reverse direction, preview and void all preserve total money and every envelope; same-source/destination rejected; old transfers remain legible and report-neutral. Separate fee can be explicitly logged as an expense, never inferred.
  - **Automated:** zero-sum/group/account invariants, duplicate submit, corrections/void, old mixed tags and offline round trip; render both transfer purposes and swapped direction.
  - **Manual:** withdraw Online→Cash, reverse, reload, inspect balances/history and income/spending totals; use existing Cover from to verify envelope transfers still work.
  - **Edges/gate:** insufficient source classification may be recorded with a visible negative-balance warning for a real movement; unknown ownership requires an explicit choice, never silent allocation. Gate: account and envelope sums both verified; no double count through mixed tags.

- [x] **P2.5 — Calendar weeks and one reporting clock.**
  - **Problem/behavior:** “This week” changes at the chosen week boundary and dates remain correct across device timezones.
  - **Scope/exclusions:** central Manila clock/date helpers; Monday/Sunday week preference; week-to-date Home and History preset; preserve separately labeled rolling-seven-day preset. Convert visible date input explicitly in Manila and refresh on midnight/resume. Arbitrary timezone selection and historical data deletion are excluded.
  - **Dependencies:** P1.2/P1.4/P2.1; D5 for week start. No debt/schedule dependency.
  - **Files:** `src/lib/dates.ts`, `dates.test.ts`, `dates-nav.test.ts`, `logging-streak.ts`, `Home.tsx`, `History.tsx`, `AddSheet.tsx`, `AppShell.tsx`, Settings and `local-keys.ts`; proposed reporting-clock hook/preferences adapter.
  - **Data/compatibility:** user-scoped week preference, default Monday. Existing effective timestamps stay unchanged. Prefer syncing preference in profile settings with a local cached fallback; do not block offline reporting if preference cannot load.
  - **Acceptance:** Monday 00:00 resets the reporting window only; Sunday preference does likewise; no data lost and old weeks searchable. Foreground midnight and sleeping PWA wake refresh day/week/month without a transaction. Date-only backdate uses documented conversion; exact original times survive unchanged corrections.
  - **Automated:** fake clock around Sunday/Monday, Manila midnight versus UTC previous day, month/year/leap boundaries and non-Manila device timezone; preserve check-in idempotency and test hook cleanup/StrictMode.
  - **Manual:** change week start; compare Home to matching History dates; simulate clock/resume and enter a backdate under a different device timezone.
  - **Edges/gate:** preference load races and a reporting period changing while History is open. Gate: clock, entry and projection agree on boundaries before schedules/recommendations reuse them.

- [x] **P2.6 — Review and reconcile actual balances.**
  - **Problem/behavior:** enter observed Cash or Online, review the ledger difference, resolve missing activity or an explicit adjustment.
  - **Scope/exclusions:** account sheet/Settings → Check balance → observed amount/date → expected/delta → choose missing transaction, account reclassification, or labeled adjustment with envelope allocation/reason → confirm. Offer an optional in-app last-checked reminder. No bank integration, overwritten totals or automatic invented purchase.
  - **Dependencies:** P2.1/P2.2/P2.4/P2.5; D6.
  - **Files:** `Settings.tsx` Current money panel, `Home.tsx` money card, `src/lib/money-type.ts`, `src/db/entries.ts`, `OpeningBalancesSheet.tsx`, proposed reconciliation module/sheet, snapshot/local keys, mirror/sync/export/restore and new audit migration.
  - **Data/compatibility:** reconciliation record stores expected/observed/delta/as-of/reason and resulting group IDs. Existing snapshots become clearly labeled legacy targets; never auto-convert them into adjustments. Deprecate target precedence only after the user has a reviewed path. Classification of untagged money uses zero-sum account reclassification, not new wealth.
  - **Acceptance:** ₱1,000→₱900 example holds; known missing meal records one expense; unknown difference records one adjustment; zero difference writes a check event only. Cancel saves no money. New activity since preview forces re-review. Positive/negative adjustments affect available physical funds but are not income, spending, recommendation top-up anchors or trend achievements.
  - **Automated:** delta/sign/as-of calculations, stale-preview guard, retry, zero difference, unknown-bucket reclassification, negative balance, correction/void and snapshot compatibility; render review and cancellation.
  - **Manual:** check each account, enter more/less/equal than ledger, choose missing transaction versus adjustment, cancel, reconnect; compare Home/History/Insights.
  - **Edges/gate:** queued writes included in expected local balance; show stale sync state and avoid false certainty about another device. Never clamp real observed balance to the old ledger total. Gate: audit plus all financial projections reconcile; no snapshot is mistaken for money.

### P2 implementation and verification record — 2026-10-21

P2.1–P2.6 are complete. Functional Edge checks and actual isolated Supabase/PostgREST migration/header/RLS/replay/concurrency/restore checks passed. The production app's real service worker, offline reload/save, authenticated reconnect, conflict rollback/draft rebase and week-preference sync passed. Seven further Edge scenarios cover browser clock/timezone emulation and simulated resume with a Los Angeles device timezone; physical OS sleep was not performed. P1 remains complete under the user's waiver. D1–D4 and D5/D6/D10 are accepted; P3 has not started. Full completion evidence: [P2 staging verification](docs/p2-staging-verification.md).

- **P2.1:** immutable group meaning is copied to signed legs, persisted in Dexie v4 and one financial outbox command, validated by owner-scoped SQL/RPC, pulled with explicit old-schema handling, and retained in JSON v2/atomic restore. CSV labels accounts/movements and carries audit links. v1 restore retains money type. Ordinary income, gross purchases, returned money, net spending and adjustments share one projection across Home/History/Insights; principal/transfers stay report-neutral. Safe aggregate guards refuse unsupported integer totals instead of rounding.
- **P2.2:** Fix opens a draft without voiding. Save atomically posts one successor, voids the exact predecessor and adds audit. Repeated corrections, Undo as another audited version, standalone Restore and superseded-original refusal are covered. Original income proportions and untouched exact instants survive. History retains whole chains through search/pagination and collapses prior versions. Definitive sync conflicts roll back dependent tentative commands, retain drafts, and force a complete authoritative pull; ambiguous failures keep stable retry identities.
- **P2.3:** contextual refund/shared-claim/repayment sheets plus minimal lend/borrow/historical opening records share one obligation core. Claims move no money; partial settlements are actual classified groups. Refunds and unpaid claim reservations share the original expense cap. Excess is refused for separate classification. Explicit unknown historical refund origins remain unknown without fabricated purchases; their caps cannot be verified. Voiding payments restores outstanding; non-cash records may be canceled after payments are voided. Unsupported linked-origin corrections/voids are blocked with readable guidance.
- **P2.4:** Transfer separates Between accounts from Between envelopes, asks explicit envelope ownership, previews both accounts/source balances and negative outcomes, and supports swapping direction. Opposing account legs preserve envelope/wealth totals. The old envelope transfer path remains separate.
- **P2.5:** date entry uses Manila wall time with optional exact time and noon for chosen date-only backdates. A shared midnight/resume clock updates day/week/month and check-ins. Monday/Sunday preference is user-scoped, cached offline and synchronized without overwriting a newer local choice. Home and History share week-to-date boundaries; History's separate 7 days preset remains rolling.
- **P2.6:** Home/Settings expose Check balance with expected/observed/delta/as-of, reason, explicit envelope allocation, missing-transaction entry, adjustment or untagged reclassification, review/cancel and stale-preview rejection. Equal checks write audit only. Legacy targets no longer override Home balances. Last-checked audit and an optional in-app reminder are available. Owner switch/logout/reset include new financial tables/keys and reset confirmation/counts include repayment records and audit.

**Rehearsal evidence:** `scripts/check-financial-sql.mjs` applies migrations 001–007 in disposable PostgreSQL/WASM, with existing legacy rows seeded before migration 007. It covers owner RLS/grants, idempotent replay, stale/concurrent corrections, transaction rollback, recovery caps, principal links, check snapshots, whole-group voids, backup restore and account reset. The old-account rehearsal caught and fixed deferred FK events blocking ALTER TABLE/RLS; an empty database alone did not expose it. UUID links are normalized so casing cannot bypass recovery matching. The harness has no live Supabase connection. Final local check results are recorded in `docs/p2-ledger-operations.md`.

**Edge evidence:** Native Windows Computer Use recovered from the browser connector failure. Correction/history, claims/recovery guards, account and envelope transfers, principal/opening debt, refunds, simulated conflict rollback/draft review, week preference/drilldowns, reconciliation equal/more/less/cancel/missing transaction/untagged/stale preview, permanent standalone Restore and report agreement passed. JSON v2 export/restore on a second empty origin matched nine signed rows, one obligation and all original audit events, adding exactly one import audit. Browser checks found and fixed a UTC date in the refund picker and narrow Insights hint overflow. Details and evidence limits: [P2 verification results](docs/p2-browser-verification.md).

**Staging gates closed:** The user supplied `tin-p2-staging` and authenticated the CLI. Real `db push` applied 001–006, an authenticated account inserted a synthetic legacy Cash expense, and 007 preserved its amount/tag/unknown financial meaning. Capability 1 and schema-cache refresh passed. Thirteen backend scenario groups passed, including replay, competing corrections/settlements, rollback, old-client rejection, owner isolation, audit-only checks and linked restore. A second account restored 12 signed rows, 2 obligations and 12 original audit events after the disposable source was reset; existing cross-account identity collisions are correctly rejected. Daily data remains read-only; no production migration or deployment occurred.

**Final automated checks:** 726 local tests passed. All 3 formerly skipped credentialed integration cases now passed separately against staging, together with the full RLS probe. Five independent staging isolation tests, ESLint, production staging build and `git diff --check` passed. The SQL rehearsal passed 54 assertions. The recurring integration assertion was corrected to require zero duplicate announcements/postings while advancing its due cursor. Build warnings remain for bundle size and the shared capability-probe import.

**Actual app follow-up:** Five real offline/service-worker scenario groups and three conflict recovery groups passed in Edge on a staging-only production build at port 5192. The offline correction lost to a competing real client, rolled back to the server's active version, retained its full draft, and synced one active version after explicit queue discard/review/rebase. Home/History/Insights agreed on ₱110 net spending and ₱2,390 remaining. The actual app exported JSON v2 with 5 rows and all 5 audit events; an independent server read confirmed that balance and the Sunday preference. The [setup guide](docs/p2-staging-setup.md), guarded scripts and [staging evidence](docs/p2-staging-verification.md) support reproduction.

### P3 — future months and spending-day recommendations

- [x] **P3.1 — Received allowance with a separate budget month.**
  - **Problem/behavior:** record money already received now while holding it for next month.
  - **Scope/exclusions:** add budget-month assignment for received allowance and an explicit expected-allowance draft state. Maintain a pure allocation/hold projection independent of account movements. No automatic expected receipt or spending of held money; other income types default to their effective month.
  - **Dependencies:** P2.1/P2.2/P2.5/P2.6; D7.
  - **Files:** `src/db/entries.ts`, `AddSheet.tsx`, `src/lib/{allowance,envelope-month,analytics}.ts`, proposed budget-allocation/availability library and persistence; schema/mirror/sync/export/restore adapters.
  - **Data/compatibility:** allocation event links receipt group, envelope centavos and target month; recorded-at and effective receipt remain distinct. Legacy income defaults to effective Manila month for classification, without retroactively inventing monthly caps or altering balances. Holds release by period evaluation, not a scheduled income insert. Corrections/voids atomically update allocations and reservations.
  - **Acceptance:** Oct 24/25→November ₱10,000 worked example holds before/after Nov 1; all funds appear in actual accounts immediately but are unavailable in October budget. Expected allowance has zero cash/funded allocation; marking received links one real income event. Existing unreserved carryover remains available unless a future assignment/reservation explicitly holds it.
  - **Automated:** receipts split/targeted, month rollover with no app open, retry, timezones, correction/void, changing future month and oversubscribed holds; legacy projection golden cases.
  - **Manual:** received early versus expected, offline reload/reconnect, inspect October available/November assigned and date labels; simulate Nov 1 and confirm no second income.
  - **Edges/gate:** spending already-held cash shows an actual expense and a funding shortfall, never fictional funding. Gate: physical money versus budget availability invariants pass before recommendations/goals use them.

- [x] **P3.2 — Future budget navigation and honest history contexts.**
  - **Problem/behavior:** navigate to next month's allocations and find an early allowance without mistaking it for a future cash receipt.
  - **Scope/exclusions:** shared month navigator supports future budget months (recommend 12 months forward plus any existing later allocation); label Budget view versus Actual activity. Budget history references linked actual transactions with received/recorded/budget labels. Keep current Home glance simple; expose month review via envelope details. No duplicate ledger or misleading projected spending comparisons.
  - **Dependencies:** P3.1 and P1.3.
  - **Files:** `Home.tsx`, `History.tsx`, `Insights.tsx` month navigation, `src/lib/dates.ts`, `ledger-filter.ts`, `src/router.tsx`; proposed shared month picker/budget review component.
  - **Data/compatibility:** no additional money table; query allocation month separately from effective-day filters. Router/deep links preserve selected context. Existing actual-date history remains the default.
  - **Acceptance:** early allowance is discoverable in November Budget and October Actual activity as the same linked record; totals do not add both references. Empty future month says no assignments/expected items; current-month return control works; changing months never paints old totals under a new heading.
  - **Automated:** rendered future navigation, delayed/stale responses, empty/legacy months and record navigation; test future cap plus stored allocation beyond it.
  - **Manual:** jump October→November→January, open allowance details and actual record, Back, compare context labels and verify actual account balance unchanged by navigation.
  - **Edges/gate:** expected versus received future allowance visible and distinct; no month-to-month performance claims for future periods. Gate: each month/context has correct query and labels before exposing recommendations there.

- [x] **P3.3 — Selected spending days and a simple calculator.**
  - **Problem/behavior:** school-day allowance uses the intended remaining budget and remaining selected days, including Monday–Thursday schedules or a manual number.
  - **Scope/exclusions:** opt-in per-envelope schedule with weekday selection, excluded/extra dates, or remaining-day count override; separate quick “amount ÷ number of days” calculator. Default configured school use to a user-selected Needs envelope ID, never a name heuristic. No calendar auto-guessing of holidays or savings-wide spending recommendation.
  - **Dependencies:** P3.1/P3.2/P2.5; D8. Integrate reservation effects again after P4/P5.
  - **Files:** `src/lib/allowance.ts`, `envelope-month.ts`, `dates.ts`, `src/features/home/envelope-card-facts.ts`, Home/envelope detail and Settings; proposed schedule/calculator library and preference persistence.
  - **Data/compatibility:** owner-scoped selected-envelope/schedule plus month-specific override/exception dates. Existing calendar-day rate remains fallback until configured; no entry rewrites. Distinguish “16 total selected days this month” from “16 remaining days”; only remaining days divide the live remaining amount.
  - **Acceptance:** ₱3,200 available and 16 remaining selected days → ₱200/day; after spending ₱200 today with 15 selected days remaining → ₱200/day. Explain numerator and included dates; same-day recalculation uses remaining balance and counts today until user excludes it. Zero remaining days says no selected days, not infinity; overspent says ₱0 available plus shortfall. Quick calculator never moves money or silently changes saved schedule.
  - **Automated:** selected dates across months/leap years, Mon–Thu, exceptions, partial month, manual overrides, zero/fractional/negative count rejection, centavo floor and held-fund exclusion.
  - **Manual:** choose envelope, weekdays and 16-day override, inspect formula, add excluded/extra day, month switch, spend/refund and return to calendar fallback.
  - **Edges/gate:** commitments and reservations reduce numerator once, never savings from other envelopes. Gate: explainable rate matches availability and remaining dates; add reserved-fund regression when P4/P5 land.

### P3 implementation and verification record — 2026-10-21

P3.1–P3.3 are complete. D7/D8 recommended defaults were adopted under the user's instruction to perform recommended work without waiting. Received assignments and expected allowances use revision-checked audit events inside atomic financial operations. Correction-chain references retain holds through fixes/voids/restore. Budget navigation and actual receipt deep links remain distinct. Spending schedules use explicit envelope IDs, remaining selected dates/counts and available centavos; the calculator never writes money.

Full local verification: **788 passed, 3 credentialed tests skipped**; all three also passed separately on isolated staging with the full RLS probe. Nine deployment/isolation guards, lint, formatting, contrast, token checks, zero-vulnerability audit and production build pass. PostgreSQL rehearsal passes 76 assertions. Eight real P3 backend groups cover owner isolation, compatibility, replay, competing assignments/receipt confirmations, schedule validation and linked restore. The real staging app passed service-worker offline plan/receipt/reload/reconnect and exported a version 3 backup. Its ₱4,700 actual balance reconciled to ₱1,500 November holds plus ₱3,200 current availability, producing ₱200/day over 16 remaining days.

Review fixes include atomic pulled ledger/audit/cursor publication, complete Home/Settings backup snapshots, fresh as-of times after saves, persistent schedule drafts across sync with stale-revision refusal, honest future-date balances, and private `.local.*` artifact exclusion. Netlify now runs mandatory checks plus a read-only schema gate before publishing. Details, exact evidence and remaining device limits: [P3 verification](docs/p3-verification.md).

Daily migrations 007/008 were applied in one guarded transaction after a private backup and local restore/migration rehearsal of all seven original tables. All 420 entries and original fields matched before commit, financial invariants passed, and authenticated-role/PostgREST read checks passed afterward. No production ledger test entries, Git push or application deployment occurred. Legacy-only accounts remain compatible until first use of new financial meaning, after which older clients must refresh.

### P4 — sub-goals and recurring reservations

- [x] **P4.1 — Child goals with one reservation balance.**
  - **Problem/behavior:** save for a watch inside Wants, or a goal inside Savings, while seeing what is free to spend.
  - **Scope/exclusions:** one-level child goals with target, progress, reserved amount, optional deadline, add/release funds and explicit purchase-from-goal. Parent shows total = reserved + unreserved; no nested goal tree, new bank account or trading feature.
  - **Dependencies:** P3.1, P2.2; D9.
  - **Files:** `src/features/settings/Envelopes.tsx`, Home/envelope details, `src/lib/split.ts`, proposed goals/reservations/availability modules and tables; include sync, reset, export and restore paths.
  - **Data/compatibility:** goals belong to parent envelope and owner; immutable reservation events use stable IDs and link source allocations. Existing parent balance unchanged; no default child goal or automatic reallocation of historical money. Use shared reservation IDs for a goal later funding a commitment.
  - **Acceptance:** Wants total ₱1,000 with watch reserve ₱300 shows free ₱700, not total ₱1,300. Release ₱100 → reserve ₱200/free ₱800. Spending ₱200 from goal lowers both parent cash and goal reservation once. Completion offers hold, release or close explicitly; archive retains audit/history.
  - **Automated:** reserve/release/pay/void/correct, retry and concurrent oversubscription, insufficient free balance, archived parents and backup round trip; parent/child non-double-count property tests.
  - **Manual:** create watch/Savings goals, fund, release, partially purchase, finish and archive; inspect account totals and daily recommendation before/after.
  - **Edges/gate:** permit recording real overspending but show underfunded goals; a new reservation cannot silently take held/funded money. Gate: one availability calculation and ownership invariants hold through reload/sync.
  - **Implementation/evidence (2026-10-21):** Goals & allocations is linked from Home, Settings and Envelopes. Immutable owner-scoped audit events share the existing atomic financial command, mirror, outbox, reset and version 4 backup/restore lifecycle. Parent totals stay unchanged by reservations; linked purchases and receipt corrections/voids update the projection. Local and real staging competition, replay, ownership, linked restore and offline service-worker reload/reconnect pass. See [P4 verification](docs/p4-verification.md). Daily migrations 009/010 were applied on 2026-10-22 with all 423 entries preserved; see [P4 release](docs/p4-release-2026-10-22.md).

- [x] **P4.2 — Percentage splits and monthly allocation rules.**
  - **Problem/behavior:** reserve a chosen fraction of new Wants/Savings money or a monthly amount for an ongoing purpose such as stocks/ETFs.
  - **Scope/exclusions:** child split percentages applied to eligible new parent allocations, explicit unreserved remainder, and fixed/percentage monthly reserve rules with a reviewable occurrence record. Reuse small monthly date/identity helpers ahead of full scheduling; no real investment order, returns forecast or advice.
  - **Dependencies:** P4.1/P2.5; D9. P5.1 later consumes these monthly occurrence identities instead of creating a second allocation scheduler.
  - **Files:** `src/lib/{split,shares,recurring,dates}.ts`, proposed allocation-rule module, goal/envelope settings; schema/mirror/sync/export/restore.
  - **Data/compatibility:** version rules effective prospectively, store executed reservation amount and deterministic rule/month ID. Child percentages plus unreserved remainder sum to 10,000 basis points. Future assigned income follows the rule version captured when assignment is made; user may explicitly revise an unconsumed assignment with audit, never silently on month rollover.
  - **Acceptance:** ₱1,000 new Wants at 30% watch reserves ₱300 and leaves ₱700; parent split happened first. One-cent splits conserve centavos via stable largest remainder. Split change affects new eligible allocations only. Completed one-time goal stops new funding; ongoing monthly rule continues until paused. Catch-up after three months never blindly spends three months of money.
  - **Automated:** rounding/tie/property cases, duplicate/multi-device month execution, future receipt capture, correction/void of funding, capped goal overflow to unreserved and insufficient funds.
  - **Manual:** configure 30%, receive/split income, change to 40%, top up, simulate next month; review partial/underfunded rule and pause it.
  - **Edges/gate:** recommend allocate only available unreserved money, label partial/shortfall, retry remainder only by reviewed action; no negative automatic reserve. Gate: deterministic execution and audit prevent retroactive/double allocations before shared scheduling expands.
  - **Implementation/evidence (2026-10-21):** D9's recommended defaults were adopted for the user's “do P4” instruction. Largest-remainder child splits include the explicit unreserved remainder and capture their rule revision with each eligible new receipt. Future reservations remain inside the future hold until Manila rollover; an unconsumed future capture can be revised explicitly. Fixed/percentage monthly rules have prospective revisions, clamped due dates and one deterministic rule/month occurrence. Partial retries require a fresh review; missed months never run automatically. The complete check passes 805 tests and 9 deployment/staging guards; the disposable PostgreSQL rehearsal passes 116 assertions and real staging passes seven scenario groups.

### P5 — scheduling, subscriptions and installments

- [x] **P5.1 — Shared occurrences, payment links and legacy recurring compatibility.**
  - **Problem/behavior:** due items need consistent identity/status without automatically becoming actual money.
  - **Scope/exclusions:** schedule definition → bounded generated occurrence → linked confirmed payment(s); common due/upcoming/overdue/partial/paid/canceled logic and in-app reminder eligibility. Integrate P4.2 allocation occurrences by type. No cron, push/email service, permission prompts on startup or automatic bank charging.
  - **Dependencies:** P2.2/P2.3/P2.5/P3.1/P4.1/P4.2; D11 (legacy conversion).
  - **Files:** `src/lib/recurring.ts`, `src/db/recurring.ts`, `src/features/recurring/Recurring.tsx`, `src/AppShell.tsx`, recurring tests; proposed schedules/occurrences/payment-link modules, tables and shared Upcoming UI.
  - **Data/compatibility:** stable schedule+period/sequence IDs, preserved nominal billing day, rule versions, owner constraints and payment links. New schedules default reminder/confirm only. Existing recurring templates stay labeled “Auto-post on open” until user reviews conversion; mapping records a cutover/last-posted occurrence and disables old posting in the same reviewed transition. Old posted/voided groups count as consumed occurrences, never silently reimported.
  - **Acceptance:** opening after missed months can generate upcoming/overdue items with **zero actual movement**; statuses derive from active payment links. Day 31→Feb 28/29→Mar 31 without drift. Existing recurring catch-up keeps its documented behavior until converted; conversion creates neither duplicate payment nor lost due item.
  - **Automated:** stable occurrence generation, bounds, pause/resume, price/date rule versioning, clock boundaries, lost-response and two-device payment confirmation, legacy cutover, existing recurring-catchup tests.
  - **Manual:** preview legacy template/conversion, reopen repeatedly/offline, change billing day, confirm/void one payment and inspect statuses/totals.
  - **Edges/gate:** canceled versus skipped occurrence, long absence, explicit nominal-date clamping. Gate: reminder-only never calls money posting; legacy cutover passes exact no-duplicate fixtures before subscription migration.

- [x] **P5.2 — Subscriptions and clearly labeled affordability.**
  - **Problem/behavior:** see amount, due date, account and whether the next subscription fits both actual funds and budget.
  - **Scope/exclusions:** active/paused/canceled subscription list, amount, billing day/start date, payment account, category/envelope, due-in label, funded reservation option, in-app reminders and Confirm payment. Use existing Recurring route as an Upcoming hub without adding a new primary tab. No automatic deduction from a reminder or unsupported background delivery promise.
  - **Dependencies:** P5.1/P3.3/P4.1.
  - **Files:** `src/features/recurring/Recurring.tsx`, Settings links, Home optional compact upcoming hint; proposed subscription detail and affordability selector, schedule/payment data modules.
  - **Data/compatibility:** subscription metadata references shared schedule/occurrences; payment action creates or links an existing expense group with stable identity. Retain amount/account at payment time; changes to definition apply prospectively. Reservation is the same identity consumed by payment, not a second hold in the goal and subscription.
  - **Acceptance:** show separately “Account funds” and “Budget after reservations”; mark affordable only when both cover the due amount, excluding the item's own hold from subtraction twice. Label unknown/stale/untagged funds honestly. ₱299 example holds; due soon/reminder alone changes no spending. Cancel stops future items/releases future reservations but retains paid history and explicitly resolves already overdue unpaid items.
  - **Automated:** account-rich/budget-poor and opposite cases, overlapping holds, duplicate/manual-linked payment, price changes, cancellation, month-end/leap dates and reminder deduplication.
  - **Manual:** add/price-change/pause/cancel, inspect due-in and shortfall, reserve funds, confirm late with actual date/account, link an existing payment and void it.
  - **Edges/gate:** no automatic transfer from Savings to cover a charge; actual payment may still be logged if unaffordable. Gate: payment/reservation and affordability examples verified before showing predictions in calendar/Insights.

- [x] **P5.3 — Finite installment plans with explicit remaining obligation.**
  - **Problem/behavior:** SPayLater-style plans end after a known set of payments and show what remains.
  - **Scope/exclusions:** separate installment-plan type using shared occurrences; entered total installment count, start/due dates and per-installment amounts. Start with payment-time expense tracking: creating the plan itself records no cash movement or upfront purchase expense. Support partial payments, overdue state and manually entered early payoff with review; exclude lender formulas, inferred interest, automatic credit reporting, accrual purchase accounting and amortization engines.
  - **Dependencies:** P5.1/P5.2/P2.3; D12 installment accounting basis.
  - **Files:** proposed installment plan/detail under `src/features/recurring/`, shared schedule/payment modules, projections/obligation model and migration/export adapters.
  - **Data/compatibility:** finite ordinal occurrence IDs, explicit principal/fees where provided, linked active payments, terminal state. Sum entered amounts for remaining obligation; adjustments to future unpaid terms retain audit/version. Ask whether the purchase or any installments are already recorded. Link existing installment expenses instead of creating duplicates. If an upfront financed purchase was already expensed, require review/correction before enabling payment-time expense posting; do not silently reinterpret a cash expense as a noncash purchase. A later accrual model needs its own explicit liability and noncash-acquisition design.
  - **Acceptance:** 3 × ₱1,000 plan: after ₱400 on installment 1, paid installments 0, partial 1, remaining obligation ₱2,600; after another ₱600, paid 1/3, remaining ₱2,000. Overdue changes status only. Explicit ₱2,000 payoff completes remaining principal once, with no future cash charges; fees appear only if entered. Void payoff reopens the obligation.
  - **Automated:** partial/extra payment allocation, final rounding centavo, duplicate/out-of-order payments, overdue, changed unpaid amounts, early payoff/void and no future occurrences after completion; plan creation has zero actual effect, existing payments link once, and already-expensed upfront purchases cannot enter a double-expensing flow.
  - **Manual:** enter plan, pay partially/late, finish/early-pay with review, inspect remaining total and actual expense versus principal labels.
  - **Edges/gate:** no retroactive repricing of paid installments; payment reallocation must be explicit. Gate: remaining obligation equals entered scheduled amounts minus valid payments, and purchase/principal never counted twice.

### P5 implementation and verification record — 2026-10-22

P5.1–P5.3 are complete for the main release. D11/D12 recommended defaults were adopted under the user's instruction to do P5. Upcoming shares immutable schedule/month or schedule/ordinal occurrences, existing P4 allocation identities, reviewed actual payments and cash-backed reservations. Legacy auto-post templates remain labeled until an owner-locked conversion preserves consumed posted/voided periods and disables old posting. Installment principal/entered fees remain visible until paid; subscription pause/cancel/skip cannot erase finite terms. Explicit revisions of saved future unpaid terms preserve old snapshots and holds, and payment-linked terms remain frozen.

Repeated review/fix passes resolved freshness, shortfall/own-hold arithmetic, pre-noon payment dates, exact History links, legacy cutover, finite lifecycle controls, duplicate link choices, rejected-draft visibility, shared reservation labels, future-term amendments and the full 120-term atomic command boundary. The complete problem/fix list is in [P5 verification](docs/p5-verification.md).

Final automated evidence: `npm run check` passes **827 tests** with **3 credentialed integration tests skipped**, **9 deployment/staging guards** and **168 disposable PostgreSQL assertions** across migrations 001–014. Audit, lint, formatting, contrast, token checks and production build pass. Real isolated Supabase/PostgREST passes eight scenario groups, three finite-lifecycle rejection checks and saved-future-term revision/payment-link protection. Edge verifies partial/payoff/void, legacy conversion, offline service-worker reload/reconnect, actual payment time, exact History navigation and downloaded version 5 backup. The final seven-theme/three-width matrix passes **273/273** cases with no overflow or uncaught errors.

Daily migrations **011–014** were applied atomically after a fresh private backup and complete local restore/migration rehearsal. Every field across all 11 public tables and all **423 entries** matched before/after; owner invariants, authenticated isolation, helper permissions and PostgREST discovery pass. No daily ledger test entries were written. The application release is ready for Git push; details are in [P5 release readiness](docs/p5-release-2026-10-22.md). The inherited bundle-size warning and documented P8 physical-device/reset-propagation limits remain outside this slice.

### P6 — utang without a second repayment system

- [ ] **P6.1 — Debt list and integrated settlements.**
  - **Problem/behavior:** see money owed by/to people, optional due dates, original amount, payments and remaining balance.
  - **Scope/exclusions:** add a debt view linked from Upcoming/History, “I owe”/“Owed to me,” person label, effective date, optional due date/notes, partial/full status and the P2.3 repayment sheet. Lending/borrowing entry uses explicit direction and actual account; no separate “mark paid” boolean or contact messaging.
  - **Dependencies:** P2.3/P2.4/P3.1/P5.1; no need to wait for calendar/Insights.
  - **Files:** proposed debt view/detail/data modules; `History.tsx`, `AddSheet.tsx`, Upcoming route, shared obligation/repayment/schedule adapters, export/restore/reset paths.
  - **Data/compatibility:** extend P2.3 obligations rather than duplicate them. Owner-scoped person labels, optional due date and reminder preferences; settlements reference actual payment groups. A historical opening debt remains non-cash until money actually moves. Expense reimbursement claims keep their expense links/type.
  - **Acceptance:** both directions have correct signed cash and principal changes; totals distinguish receivable/payable from available cash. History and debt detail open the **same** repayment and show the same outstanding. Removing/voiding a settlement updates both; correcting an origin below already repaid amount is blocked pending explicit resolution. Settled items retain audit and can be found.
  - **Automated:** bidirectional partial principal, expense-backed recovery, historical noncash opening, duplicate/concurrent settlement, overpayment, archived person label and correction/void; component navigation and backup round trip.
  - **Manual:** lend, borrow, enter old debt, partially repay/receive in another account, open same payment from History, finish and void one repayment.
  - **Edges/gate:** optional due date, same person with multiple debts, exact centavo settlement. Gate: reconcile cash, receivables/payables and report exclusions with P2.3 fixtures before reminders use status.

- [ ] **P6.2 — User-only reminders and balance checks.**
  - **Problem/behavior:** surface due repayments/subscriptions/installments and optional stale-balance checks without nagging or contacting other people.
  - **Scope/exclusions:** one in-app reminder queue with due soon, overdue, snooze/dismiss, per-item controls and last-seen suppression. A small Home hint opens Upcoming; no duplicated dashboard panels, SMS, email, contact access or unverified background delivery.
  - **Dependencies:** P6.1/P5.2/P5.3/P2.6; D13 reminder timing.
  - **Files:** `AppShell.tsx`, Home, Settings, proposed reminder selector/preferences and Upcoming views; `src/lib/local-keys.ts` for cached user-scoped preferences.
  - **Data/compatibility:** reminder IDs derived from occurrence/obligation/check identity; save snooze/ack separately from financial status. Sync preferences if supported by new settings storage, with local fallback. No ledger writes from reminder creation, display or dismissal.
  - **Acceptance:** due tomorrow/overdue display accurately in Manila; settled/canceled item disappears; snoozed reminder does not recur on each render; missing due date produces no fabricated deadline. All messages are to the app user only; disable reminders without changing obligations.
  - **Automated:** fake-clock due/overdue/snooze, cancel/settle/void, repeated app-open, account switch/logout hygiene, no payment command invoked by reminders.
  - **Manual:** enable, snooze, dismiss, pay and reopen; check offline and later resume; disable all reminders and inspect unchanged balances.
  - **Edges/gate:** in-app reminders can be missed while app is closed; explain this at preference selection. Gate: no unsolicited contact or money changes, with duplicate reminder suppression verified.

### P7 — calendar and focused analytical review

- [ ] **P7.1 — Calendar as a view over validated records.**
  - **Problem/behavior:** see spending and upcoming commitments by day with clear actual/scheduled/expected/overdue distinctions.
  - **Scope/exclusions:** month calendar plus accessible agenda/day drawer linked from Upcoming; actual transactions, subscriptions, installments, debt due dates and expected allowance. Distinct text/icon statuses and separate actual/expected subtotals; no copied calendar ledger, holiday service or automatic payment.
  - **Dependencies:** P2.5/P3.2/P5.2/P5.3/P6.1; reminder links after P6.2.
  - **Files:** proposed calendar selector/view under `src/features/recurring/` or `src/features/calendar/`, `src/router.tsx`, shared schedule/obligation/projection modules and History deep links.
  - **Data/compatibility:** no new financial storage. Render transaction group and occurrence/payment links, suppress duplicate paid-occurrence markers, and retain due-versus-paid date relationship. Expected income must never appear in actual spend/income totals.
  - **Acceptance:** open a day to actual spending and separately listed upcoming items; navigate to source, then Back restores month/day. Paid late shows actual payment on payment day and resolved due item on due date without counting twice. Correction/void and canceled plans update view; day totals match History for same effective date.
  - **Automated:** month grid/agenda, timezone/year/leap boundaries, mixed statuses, paid-late deduplication, correction/refund days and deep-link identity; rendered keyboard navigation and empty states.
  - **Manual:** mobile day open/close, keyboard/reader agenda, future month and overdue item, confirm payment and verify spending appears once, inspect an expected allowance.
  - **Edges/gate:** many items on one day collapse with a count and accessible list; overdue remains visible until resolved. Gate: selectors share financial/schedule identities and never create rows merely by browsing months.

- [ ] **P7.2 — Insights with a small useful default review.**
  - **Problem/behavior:** understand spending, returns, free money, upcoming obligations and trends without a crowded screen.
  - **Scope/exclusions:** four default blocks: (1) gross/returned/net spending with comparison basis, (2) top categories with drilldown, (3) cash versus current budget free/reserved plus upcoming funded/unfunded commitments, (4) recent comparable-period trends. Remove spending-mix/streak from main view; keep envelope flows in an optional Details panel. Biggest purchase/weekday patterns remain deferred.
  - **Dependencies:** P2–P6 financial gates, P3.2 and P7.1 navigation. Can ship a clearly scoped actual-spending subset earlier only if unimplemented panels are omitted and dependencies documented.
  - **Files:** `src/features/analytics/Insights.tsx`, `src/lib/analytics.ts`, shared projections/availability/schedule selectors, `src/features/entries/History.tsx`; proposed `Insights.test.tsx`. Re-check historical NUL sentinel finding before touching keys.
  - **Data/compatibility:** read-only projections; no new monetary records. Legacy unknown metadata remains labeled. Snapshot observations excluded from affordability. Expected/future assignments belong in budget context, not historical actual income a second time.
  - **Acceptance:** all four blocks have plain-language period/basis and drilldown. Refund/reimbursement lowers net only on receipt date; principal, transfers and adjustments do not masquerade as spending/income. Adjustments get a separate explanation; future-held funds reduce current availability. Current partial month compares equal elapsed dates with shorter-month differences labeled; no full-month improvement claim or projection from an insufficient sample. Future/empty/incompletely synced periods show limited-data states.
  - **Automated:** shared worked examples across all projections, comparable-span/leap/short-month fixtures, late refunds, archived categories and incomplete data; rendered stale-response/month-switch cases and panel visibility.
  - **Manual:** compare Insights with matching History and account totals; current versus complete/future month; drill category and obligation, expand details, check mobile and screen reader.
  - **Edges/gate:** net return-only periods can be negative; category gross/return/net labels must share a denominator. Gate: four panels agree with authoritative projections and no hidden double counting; optional panels do not crowd Home.

### P8 — verification, migration rehearsal and release

- [ ] **P8.1 — Rehearse upgrades and close relevant retained gaps.**
  - **Problem/behavior:** daily data and existing flows must survive each schema/operation addition.
  - **Scope/exclusions:** run the regression matrix below against old-version fixtures and a disposable Supabase environment; add ownership/transaction probes for the new financial entities. Add targeted Home/AppShell and Settings reset/opening-offer renders, money-type RLS and archived-category revival cases. Preserve recorded limitations rather than expanding into a sync rewrite or unsupported bulk tagging.
  - **Dependencies:** P1.4 baseline; apply incrementally as each P2–P7 step changes its surface, repeat only affected cases after later changes.
  - **Files:** existing `src/db/*test.ts`, `src/lib/*test.ts`, `AddSheet.test.tsx`, `BottomSheet.test.tsx`, new screen tests, `supabase/tests/*`, `supabase/migrations/006_account_reset.sql` as reference, proposed new migration(s), CI workflow.
  - **Data/compatibility:** rehearse v1→v3→new Dexie upgrade with pending old and new outbox writes, owner change/logout/reset, full backup with links and archived config. Extend reset FK ordering/counts for each new table. Verify no untrusted user can reference another owner's account/envelope/goal/payment.
  - **Acceptance:** fixture IDs, signed sums, voids, relationships and outstanding totals survive upgrade/export/restore; no queued write silently loses semantics. Tests explicitly verify reset phrase gating and opening offer visibility. Relevant real-browser keypad/drag/Back/sticky-header checks have fresh evidence.
  - **Automated:** local full suite + lint + build and affected integration/RLS probes against disposable test accounts only, recording skips; new reset-table ordering exercise. No claim that old suite counts prove coverage.
  - **Manual:** documented cross-device offline/online sequence and new-device restore, mobile checks, other-device reset guidance. Capture differences and recoverability.
  - **Edges/gate:** existing reset propagation limitation remains explicit and release scope cannot claim to solve it. Gate: no unexplained money difference, orphaned link, rejected queue head or failed mandatory check for the releasing slice.

- [ ] **P8.2 — Release one verified slice and record its status.**
  - **Problem/behavior:** user can adopt changes gradually and know what has actually been verified.
  - **Scope/exclusions:** back up, inspect target schema/history, apply reviewed additive migration in deployment order, activate compatible UI behind a capability gate, check a small release fixture, and update this roadmap with evidence and remaining limitations. No automatic bulk reclassification, deletion/reseed or opening feature flags for unfinished steps.
  - **Dependencies:** relevant feature gate plus P8.1 for that slice. This is a repeatable release step, not permission to deploy during planning.
  - **Files:** this roadmap, new migrations, release notes/CI configuration if needed, capability checks in `src/db/remote.ts` and data modules, export/restore/reset adapters.
  - **Data/compatibility:** capture exported backup and restore rehearsal before schema changes; retain historical migrations and established IDs. Stop new semantic writes on unsupported server/client combinations. Rollback disables new entry points and retains data/readers; never drop new financial tables as a UI rollback.
  - **Acceptance:** migration status is observed, not assumed from source; old clients cannot silently post/strip incompatible meanings; no double posting when older recurring paths coexist; existing queued daily entries drain; data and signed totals match before/after expected fixture changes.
  - **Automated:** deployment build and compatible-schema fixture checks; re-run only affected regression/integration cases after release config changes.
  - **Manual:** Home→Add→History→Insights; offline save/reload/reconnect; relevant new flow; backup export; verify pending/stale state labels and recovery instructions.
  - **Edges/gate:** service-worker cached old client and two-device writes need deliberate upgrade handling. Gate: record date, commit, migration/capability versions, exact checks and skips before checking off the feature; rollback if any unexplained financial divergence remains.

## Verification and regression plan

### Check selection and evidence

Use existing commands; no dependency installation is needed for this roadmap. During future implementation run targeted `npm test -- <test file paths>` for the touched logic, then `npm run lint` and `npm run build` (the build includes TypeScript). `npx tsc --noEmit -p tsconfig.app.json` is an existing documented optional faster typecheck; it does not replace the final build. For a monetary/schema change run the local full suite once the focused cases pass. Repeat/broaden only when a later edit, failure or unresolved concern justifies it.

Do not blindly run `npm test` with probe credentials: `supabase/tests/*integration.test.ts` can write to a real Supabase project when `PROBE_B_PASSWORD` is supplied. Use local mocked/fake-indexeddb suites without live credentials for the baseline. Later, use an explicitly disposable project/account for integration fixtures and `npm run probe:rls`; inspect its reset/delete behavior before running. Never record secrets in evidence. `npm run check:contrast` and `npm run check:tokens` apply when UI colors/tokens change. Do not run `npm run format` over the repository for a scoped feature.

| Layer | Minimum meaningful check | When required |
| --- | --- | --- |
| Financial projection | All six requested worked scenarios (plus principal-only repayment), integer-cent conservation, return caps, non-spending exclusions and active-group filtering | P2 semantics and every later feature feeding totals |
| Calendar/period | Midnight/UTC offset, Monday/Sunday, leap/short month/year end, month hold release, selected-day zero case | P2.5 onward; use a supplied/fake clock |
| Commands and concurrency | Stable operation identity; local rollback; rejected/failed push; lost response; reload/retry; two-device conflict | Corrections, returns, transfers, adjustments, allocation funding and confirmed payments |
| Persistence | New field survives local write → queue → push → pull → mirror → projection → export → restore | Every new financial entity/field, before its UI is enabled |
| Legacy compatibility | Original four kinds, untagged rows, old same-account transfers, old outbox inserts/void/unvoid, v1 exports, recurring catch-up IDs and archived references | Every migration/projection change |
| UI wiring | Real rendered toast; visible optional note/date; History filter/totals; linked correction order; Home money/availability; Insights period match | Targeted jsdom with existing Testing Library plus typecheck/build |
| Browser | 390px touch, desktop keyboard, focus order, 200% zoom, native date picker, pad caret/clear/sums/toggle, scroll/drag/Back and sticky sync pill | Relevant entry/history/navigation changes; capture browser/device and observations |
| Offline/account lifecycle | Save/reload offline, reconnect queue drain, cached old client, user switch/logout wipe; reset includes new tables | Every new data table/outbox op |
| Security/integration | Ownership FKs/RLS, group atomicity, recovery/settlement uniqueness and reset FK-safe ordering | New schema, using disposable fixtures only |

Regression checkpoints: P2 retains fast Add/search/import/restore/cover-from; P3 retains actual account sums and P2 corrections; P4 retains future holds and daily-rate numerator; P5 retains legacy recurring IDs and reservation consumption; P6 retains History repayment eligibility and no-spending principal; P7 compares each displayed number against the same fixture projection. A refund, void or correction of an old item must invalidate dependent cached calculations without requiring a page reload.

For each completed step append a short evidence record under that step: implementation commit, date, accepted decision IDs, automated commands/results (including skipped tests), manual device/scenarios/results, migration/backup compatibility evidence and unresolved limitations. If a required browser or integration check cannot run, leave the step unchecked and name the remaining check. A release may omit a blocked feature; it may not present an unverified dependent feature as complete.

## Data migration and rollout considerations

1. **Inventory before change:** verify actual deployed schema and migration-history registration; historical §17.8 says migrations were applied by hand and migration 001 was once edited. Do not blindly run a tool that might attempt to recreate existing tables. This planning turn has not checked deployment state.
2. **Choose the narrow storage extension:** retain signed entries and four-kind legacy readers. Prefer owner-scoped immutable group metadata/links plus allocation, obligation and schedule tables. P2.1 must finalize exact schema, constraints, RPC permissions and capability version before implementation; paths described as proposed are design suggestions, not existing modules.
3. **Expand safely:** additive columns/tables/indexes and RLS in the same new migration. Add ownership FKs on every cross-reference and unique operation/occurrence/settlement keys. Expand Dexie version additively; preserve existing mirror, pending outbox and cursor. No wipe/reseed as a migration shortcut.
4. **Metadata cannot disappear:** new remote selects, outbox payloads, mirrors and exports must carry every financial field. Existing money-type stripping fallback is unsuitable for intent, budget month, correction or repayment links. Require a known schema capability and pause only incompatible new actions with a useful message rather than enqueueing writes destined to block the FIFO.
5. **Compound writes:** correction/settlement/payment+reservation changes require one local transaction and one transactional server command with ownership and expected-state checks. Add an explicit outbox operation/exhaustive Settings description; preserve stable IDs on retry. Document conflict/recovery states instead of assuming append-only alone eliminates conflicts.
6. **Backup/restore is part of each schema feature:** preserve v1 reader support, introduce a new bundle version for new entities and links, remap IDs consistently in two passes, validate all references before writing and refuse unsupported data visibly. Restore audit/void state with original IDs; repeated restore is idempotent. CSV stays a labeled analysis export, not a lossless backup. Include goals, rules, obligations, occurrences, payments, preferences and reconciliation audit in the new full backup.
7. **No speculative backfill:** never infer cash accounts, debts, reimbursements, receipt timestamps, future budget months or confirmed payments from notes. Legacy types retain meaning, timestamps may be unknown, and inferred effective-month budget classification must not alter actual balances. Existing observation targets require review rather than automatic ledger adjustments.
8. **Rollout by capability:** stage migration/read support, verify compatibility, then enable one action. Service-worker cached older clients and multiple devices need version detection plus upgrade guidance before new transactional semantics are allowed. Preserve basic old ledger writes only where the server can safely accept them; enforce critical monetary invariants server-side.
9. **Recurring transition:** cutover maps consumed due periods and existing auto-posted groups. Reminder-only definitions do not backfill expenses. Paused/canceled definitions do not erase payments. Receipts for future budgets are never reposted at month start.
10. **Lifecycle completeness:** new user-owned tables participate in logout/owner switch, reset summary/RPC deletion ordering, exports and restore. Keep cross-device reset limitations explicit; do not promise deleted data propagates through an update-only cursor. Resolve queued-write handling before any reset/migration rehearsal.
11. **Rollback:** back up and rehearse restoration first; disable new writes/UI if verification fails, retain read support and committed records, reconcile any pending operations visibly. A destructive down-migration is not the default recovery for a UI issue. Never mark a migration released because the file exists or a mocked test passed.

## Open questions and recommended defaults

**Blocking** means settle and record the decision before the named implementation, not that this planning task requires a reply. D1?D6 and D10 were explicitly accepted by the user. The remaining defaults are recommendations with tradeoffs, not confirmed product requirements. Historical user decisions such as the seed split, explicit money-type choice and allowing actual overdrawn expenses remain in force unless the user changes them.

| ID | Decision and recommended default | Tradeoff / when it must be settled |
| --- | --- | --- |
| D1 (accepted) | Use gross/returned/net spending; merchant refunds and expense reimbursements lower net on receipt day. Loan principal does not. Original gross history remains intact. | Can produce negative net on a refund-only day; clearer than rewriting last month. **Blocking P2.1/P2.3.** |
| D2 (accepted) | Start with logical Cash/Online plus untagged, add a distinct account-transfer purpose and require explicit envelope ownership for its two legs. | A withdrawal touching several envelopes takes multiple moves initially; avoids premature named-account schema. **Blocking P2.1/P2.4.** |
| D3 (accepted) | Keep signed ledger + immutable group metadata; corrections use a compound operation with one active successor and explicit conflict state. | More storage/transaction work than reversing a sort, but protects money on cancel/offline/concurrent save. Finalize metadata/table versus additive-column shape in P2.1. **Blocking P2.1/P2.2.** |
| D4 (accepted) | One obligation/settlement model for reimbursements and principal debts. Cap expense recovery at eligible unrecovered amount; require classification for excess. | Does not automatically handle tips, overpayments, interest or debt write-offs; these need explicit later operations. **Blocking P2.3.** |
| D5 (accepted) | Asia/Manila regardless of device; Monday week start, user can select Sunday; date visible, optional time disclosure, chosen backdates at noon if no exact time is known. | Travel-local dates may differ; labels must say Manila. **Blocking P2.5**, week preference is reversible. |
| D6 (accepted) | Reconcile by actual observation + reviewed difference; missing known transaction preferred, unknown difference uses labeled adjustment and explicit envelope allocation. Do not import old snapshots as money. | User must identify which envelope absorbs unknown difference; recommend selected envelope Needs only after explicit confirmation, never silent. **Blocking P2.6.** |
| D7 | Actual receipt now, budget assignment later; future-held money excluded from current availability. Unreserved existing carryover remains usable; no hard monthly reset. Expected allowance funds nothing. | Physical money and current availability differ deliberately; both labels needed. Choice of reallocating an already-held month requires review. **Blocking P3.1.** |
| D8 | Per-envelope calendar-day fallback; user opt-in Mon–Thu or a remaining-day override, with explicit date exceptions. Count today if selected until excluded; floor available/remaining days. | A live rate can change during the same day; explain that numerator is the current balance, not a fixed daily quota. **Blocking P3.3.** |
| D9 (adopted for P4) | Goals reserve parent funds; percentage rules use new eligible parent allocations only. One-time goals cap at target and overflow becomes unreserved; ongoing allocations recur. Partial funding is limited to free money with a visible shortfall. | Captured receipt rule versions persist through rollover; explicit review can revise an unconsumed future capture. Monthly occurrences retain their reviewed request and rule version when a rule is edited. Close/archive releases remaining reservations and is terminal; Hold preserves money and can resume. |
| D10 (accepted) | Permit permanent Restore for standalone voids after preview; block restoring superseded originals and resolve linked obligations/payments in a compound action. | More useful recovery but requires careful linked-state safeguards; ordinary Undo remains quick. **Blocking permanent-restore portion of P2.2.** |
| D11 (adopted for P5) | New subscriptions require explicit confirmation; existing auto-post templates remain labeled until reviewed conversion with an occurrence cutover. | Two behaviors coexist temporarily; avoids silently changing the historically confirmed auto-post preference. **Blocking P5.1.** |
| D12 (adopted for P5) | Start installment plans with payment-time expense tracking: no upfront cash/purchase entry from plan creation, confirmed payments count as expenses, explicit fees separately. Link existing installment payments; flag an already-expensed upfront financed purchase for review before new postings. Defer accrual purchase/liability accounting. | Simpler cash-based daily review; acquisition-date spending analysis is unavailable. Supporting upfront noncash purchases later needs an explicit accounting model rather than subtracting cash that never moved. **Blocking P5.3.** |
| D13 | In-app reminders default three days before and on due date, overdue retained in Upcoming; balance-check reminder opt-in monthly. No proactive contact or guaranteed closed-app delivery. | Low setup, reminders may be missed while app closed. Timing is reversible; settle copy/preferences in P6.2. |
| D14 | Four Insights blocks from P7.2; streak/mix removed from main review, flows in Details, calendar linked from Upcoming before any new primary tab. | Some deep metrics need one extra tap; test discoverability on a phone. Reversible P7 layout decision. |

## Feedback coverage matrix

| Feedback request | Step IDs and observable coverage |
| --- | --- |
| 1. Accurate spending, repayments, transfers, calendar weeks | P1.4 contract; P2.1 shared gross/returned/net; P2.3 classified partial returns/principal; P2.4 Cash↔Online; P2.5 Monday/Sunday reporting clock. |
| 2. Cleaner entry: categories, visible optional note/date, quick amounts | P1.2 ranking/search/group check, note/date before save and shortcuts below keypad; P2.5 date semantics. |
| 3. Clear history, correction/void relationships, repaid action and audit | P1.3 control/totals scope; P2.2 atomic linked correction/void/restore/order; P2.3 one partial repayment core; P6.1 debt view of same settlements. |
| 4. Friendly errors including Object Object regression | P1.1 structured-error normalizer, actual rejected-save toast test, safe diagnostics; reused by later flows. |
| 5. Reconcile recorded versus real balances | P2.6 missing transaction versus adjustment, expected/actual/delta audit, snapshot transition and reminder; P6.2 optional check reminders. |
| 6. Early allowance and future months | P3.1 receipt/recorded/budget dates, held versus expected funds, no rollover repost; P3.2 future budget history/navigation; P7.2 context-safe insights. |
| 7. Selected spending days / 16-day calculator | P3.3 per-envelope weekday/count/exception calculator, remaining days, boundaries, zero/overspend; P4/P5 reservation integrations. |
| 8. Sub-savings, percentage splits and recurring allocations | P4.1 parent/child reservations and completion; P4.2 prospective percentages/rounding/remainder and monthly rules; P5.1 shared occurrences. |
| 9. Subscriptions, due dates, affordability and reminders | P5.1 occurrence/payment distinction; P5.2 amount/date/account/active/cancel/price/affordability; P6.2 user-only reminders. |
| 10. Finite installment plans | P5.3 count/amount/due/paid/partial/overdue/early payoff/completion, explicit fees and no invented lender math; P5.1 shared scheduler. |
| 11. Utang in both directions and reminders | P2.3 principal/reimbursement foundation; P6.1 person/date/due/notes/partial balances and History integration; P6.2 user-only reminders. |
| 12. Calendar of actual and upcoming items | P7.1 source-linked calendar/agenda, actual/scheduled/expected/overdue labels, no duplicated postings; P2.5 dates and P5 shared schedules. |
| 13. Useful uncluttered Insights | P7.2 four default blocks, optional deep panels and comparable periods; P2.1/P3/P4/P5 data semantics and P7.1 drilldowns. |
| 14. UX across every phase | P1.2/P1.3 entry/history improvements first; each step's manual/accessibility gate; P3.2 context labels, P5 Upcoming hub, P7 progressive disclosure, P8.1 mobile/keyboard checks. |

## Current implementation gate

P1 is complete under the explicit human/device waiver. P2.1–P2.6, P3.1–P3.3 and P4.1–P4.2 are implemented, verified locally and on isolated staging, and deployed. The daily database has migrations 007–010 after backed-up releases. The P4 release preserved all 423 entries and every public-table field; authenticated-role and PostgREST checks passed. The read-only release gate requires the goals capability. GitHub CI and live Edge smoke checks passed; see [P4 release](docs/p4-release-2026-10-22.md). P5–P8 remain unstarted. Physical phone/OS sleep behavior remains outside the emulated browser evidence. See [P4 verification](docs/p4-verification.md), [P3 verification](docs/p3-verification.md) and [release readiness](docs/release-readiness-2026-10-21.md).

## Historical roadmap

The original `ROADMAP.md` follows **verbatim**. It preserves prior decisions, completed-work notes, outstanding investigations, technical rationale and historical verification claims. Its former top-level “all phases closed” status refers to that historical program, not to the unchecked improvement plan above. Conflicting historical notes are retained as evidence and called out in the current findings; do not silently resolve them by checking off new work.

---

# Tin — Build Roadmap

> A cozy 70/20/10 savings & spending tracker. One real pot of money (GCash), three virtual envelopes, an honest append-only ledger.
>
> Solo dev · ₱0 budget · PHP centavos · Asia/Manila · multi-user-safe from day one.

---

## Status — all phases closed (2026-07-22), Phases 9 and 10 added 2026-07-24, Phases 11-12 2026-07-28

**Live at <https://tin-jar.netlify.app>.** Phases 0–12 are done, plus a Phase 3.5 retrofit. 631 tests — including the component-render tests added in §17 and extended in §18; lint, build and the AA-contrast script all clean. `git push` to `main` deploys.

| Phase | State |
| ----- | ----- |
| 0–2 Setup, money brain, accounts & RLS | ✅ |
| 3 The ledger ★ | ✅ |
| 3.5 Envelope/category management | ✅ **retrofit** — §0 promised it, no phase ever gave it a task line, so it was never built. Found by auditing prose against code. |
| 4–7 Analytics, recurring, offline, hardening | ✅ |
| 8 Statement importer | ✅ **closed** — importer shipped; the GCash-PDF-specific reader was **dropped by decision**, not left pending |
| 9 Habit loop & insight rework | ✅ — streak + repair saves + check-ins, true-ratio spending breakdown, calmer backdrop. **Web Push explicitly NOT built** — see §9. |
| 10 The review surfaces | ✅ — History paging + whole-ledger search, **restore from a JSON export**, per-envelope daily allowance, note chips, 6-month trend. See §10. |
| 11 The Home meter correction | ✅ — the envelope meter drew a target that **punished you for using the app correctly**; replaced with a drain-to-pace meter, and the days-left line deduplicated. See §11. |
| 12 Whole-app logic audit | ✅ — the money core held; **check-ins only fired on a cold boot**, `repairDay` never checked the budget it was designed around, and `undoRepair` had a DELETE policy but no button. See §12. |
| 18 QOL pass | ✅ — thirteen changes. The keypad is **back on the add sheet**: §17.9 deleted it over a bug that turned out to be in Settings. Also amount sums, remembered answers, History dates, and undo on a void. See §18. |

This document stops being a plan here and becomes the record of why things are the way they are. The parts worth reading before changing anything: **§1 engineering law**, the **§3** notes on composite ownership FKs and the missing sum-to-10000 check, **§6**'s known CVD gap, and the closure note on Phase 8.

Three lessons this roadmap taught the hard way, all worth keeping:

1. **A ticked checklist is not a built product.** Every box for Phases 0–7 was ticked while an entire promised feature (editable percentages, category management) did not exist — because it only ever lived in prose and a file-tree comment, never in a task line. Audit promises against code, not against boxes.
2. **`[]` is truthy.** `{list && …}` is not a loading guard. On a cold load the local mirror is empty until the first pull; that bug shipped twice, once leaving a picker permanently empty and once crashing a screen outright.
3. **Fix the screen that was reported, not the screen you were looking at.** §17.9 deleted a whole feature off the add sheet to fix a bug that lived in Settings — §17.10 then found and fixed the real one, on the real screen, without touching the thing that had been removed. Confirm _where_ before deciding _what_. §18.0 put it back.

---

## 0. Decisions on record

These were answered in the kickoff session (2026-07-17). Don't re-litigate them casually.

| Question               | Decision                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Split variant          | **70 Needs / 20 Savings / 10 Wants**                                                                                                                                                                                            |
| Editable percentages   | **Yes**, in Settings. Shares live on envelopes as basis points (7000/2000/1000). Historical entries are never re-allocated — the ledger records actual centavos, so a ratio change only affects income logged after the change. |
| Envelope goes negative | **Allow it, show red, offer one-tap "cover from…"** that writes a proper 2-row transfer. Never block an expense — the money already left GCash; blocking makes the ledger lie.                                                  |
| Categories             | **User-defined, each owned by exactly one envelope** (Food→Needs, Games→Wants). Picking a category implies the envelope → one less tap. App seeds a starter set; rename/add/archive freely.                                     |
| Recurring              | **Yes, Phase 5.** Cheap implementation: templates that auto-post (with confirm toast) on next app open. No server cron — free tier doesn't have one anyway.                                                                     |
| Home screen            | **Balances + big Add button.** Balances are the 10×/day glance; Add opens a keypad bottom sheet. PWA long-press shortcut deep-links straight to Add-expense.                                                                    |
| Name                   | **Tin**                                                                                                                                                                                                                         |

### Stack verdict (you asked me to challenge it)

I keep your stack. Reasoning, so you know it was actually examined:

- **React + Vite + TS + Tailwind** — fine. SvelteKit would ship a smaller bundle, but the difference is irrelevant at this app's size and React's ecosystem/familiarity wins for a solo dev pairing with an AI.
- **Supabase** — correct choice, and the reason is _security_, not Postgres. The only free-tier rival is Cloudflare Workers + D1 (no project pausing, generous limits), but it makes you hand-roll auth and authorization — the exact two things a solo dev must not improvise on a public URL. Supabase gives you battle-tested auth + RLS for free. Accept the pause quirk; mitigate it (below).
- **Netlify vs Cloudflare Pages** — a wash at one user. Netlify per your plan; `_headers` and `_redirects` both work there.
- **Dexie + outbox** — right design, wrong _time_. It's the single most complex subsystem in the app. It comes in Phase 6, after months of the online-only app working. Basic PWA installability (icon on your home screen) comes much earlier and cheaply in Phase 3, because it drives the daily habit.

**Supabase keep-alive (cheapest option):** a GitHub Actions scheduled workflow every 3 days that curls the REST endpoint with the anon key. REST traffic counts as project activity. Costs ₱0.

```yaml
# .github/workflows/keepalive.yml
name: supabase-keepalive
on:
  schedule:
    - cron: '0 21 */3 * *' # 05:00 Manila, every 3rd day
  workflow_dispatch:
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -sf "${{ secrets.SUPABASE_URL }}/rest/v1/envelopes?select=id&limit=1" \
            -H "apikey: ${{ secrets.SUPABASE_ANON_KEY }}" \
            -H "Authorization: Bearer ${{ secrets.SUPABASE_ANON_KEY }}"
```

Caveat: GitHub disables scheduled workflows after 60 days of repo inactivity. Daily use means you'll commit often enough; if the project ever goes maintenance-only, move the ping to a Cloudflare Worker cron (also free).

### MFA

Enable **TOTP MFA in Phase 7** — it's free on Supabase and worth having on a public URL. From day one: a unique strong password (leaked-password protection turned out to be Pro-plan-only — verified 2026-07-18 — so the free-tier stack is strong password + RLS now, TOTP MFA in Phase 7). Don't gate early phases on MFA.

### End-to-end encryption — recommendation: no

E2EE would mean: every sum, monthly rollup, and category breakdown computed client-side over decrypted data (you lose SQL views entirely), a key-sync problem across devices, and key loss = total data loss with no recovery. What it defends against — Supabase staff or a DB breach reading _peso amounts and category names_ — is a low-stakes threat for this data. RLS + TLS + strong password + MFA is the right level. One behavioral rule instead: **don't put account numbers or other PII in entry notes.**

---

## 1. Engineering rules (restated as law)

1. **Money is integer centavos**, `bigint` in Postgres, `number`/`BigInt` in TS. `10000` = ₱100.00. Format only at display: `Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' })`.
2. **Largest-remainder split.** Floor each envelope's `total * share_bp / 10000`, then distribute leftover centavos one at a time by descending fractional part; ties broken by envelope `sort_order`. Compute internally with BigInt so huge amounts can't hit float territory. Unit-tested (see Phase 1 tests).
3. **Append-only ledger.** One `entries` table. Income = 3 rows sharing a `group_id`; expense = 1 negative row; transfer = 2 rows sharing a `group_id`; opening balance/correction = `adjustment` rows. Balances are `SUM(amount_centavos)` — never a stored column. Edits are **void + re-insert**; deletes don't exist. Voids always target the **whole `group_id`** — voiding a single leg of an income or transfer would corrupt balances and the split invariant. Enforced at the database, not by discipline (see column grants in §3).
4. **Client-generated UUIDs** for every entry. Why this matters _before_ the sync layer exists: the failure mode of any network write is "request sent, response lost" — the client cannot know if the row landed. With server-generated IDs, a retry inserts a duplicate and **double-counts money**. With client IDs + upsert-on-primary-key (`ignoreDuplicates`), a retry is a no-op. Combined with append-only (no in-place edits racing each other), the only possible "conflict" is the same fact arriving twice — which the upsert collapses. This is the entire reason Phase 6's sync can be a dumb queue instead of a CRDT research project.
5. **`timestamptz` UTC in storage; Asia/Manila for display and grouping.** Manila is UTC+8: a 7am Feb 1 Manila transaction is Jan 31 in UTC. All month grouping goes through `occurred_at AT TIME ZONE 'Asia/Manila'` (SQL) or an `Intl`-based `manilaMonthKey()` (TS). Both are unit-tested at the boundary.
6. **Backdating**: every entry form has an editable `occurred_at` defaulting to now.

---

## 2. Phases

Effort = focused evenings (~2–3 h). Total to end of Phase 7: **~17–25 evenings**.

### Phase 0 — Hello, Tin (1 evening)

**Goal:** prove the deploy pipeline before writing any product code.

- GitHub repo, Vite + React + TS scaffold, Tailwind, ESLint/Prettier, Vitest wired.
- `.gitignore` includes `.env` **from commit #1**. `.env.example` documents `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- `public/_headers` (baseline security headers) and `public/_redirects` (`/* /index.html 200` for the SPA router).
- Netlify connected to `main`, auto-deploy, live URL renders a themed "Tin 🫙" hello page.

**Shippable:** a live public URL. **Unblocks:** everything — every later phase ships the same evening it's built.

### Phase 1 — The money brain (1–2 evenings)

**Goal:** all money math as pure, tested functions, before any UI or DB exists.

- `src/lib/money.ts` — centavo helpers, `formatPHP()`, parse-input-to-centavos (handles "1,234.5", rejects >2 decimals).
- `src/lib/split.ts` — `splitByLargestRemainder(totalCentavos, shares[])`.
- `src/lib/dates.ts` — `manilaMonthKey()`, `manilaDayKey()`, month-boundary helpers via `Intl` (no date library).
- Tests: ₱0.01 → [1,0,0]; ₱0.03 → [2,1,0]; ₱1,234.57 → [86420, 24691, 12346]; ₱888,888,888.88; a 10k-random-amounts loop asserting parts always sum to total; Manila boundary cases (2026-01-31T23:00Z groups as February).

**Shippable:** a deployed **split preview** screen — type an income, watch it split live. **Unblocks:** Phase 3 forms just call these functions; the scariest math is done and trusted.

### Phase 2 — Accounts & vault (2–3 evenings)

**Goal:** Supabase stands up with security _before_ any real data exists.

- Supabase project; migration `001_core.sql` (full schema, RLS, grants, views — §3) committed to the repo.
- Email + password auth (leaked-password protection is Pro-only — skipped); signup/login/logout screens; **forgot-password reset flow** (add the Netlify URL to Supabase's allowed redirect URLs); session persistence.
- First-run seeding (client-side, idempotent): if the user has no envelopes, create the profile row + Needs 7000bp / Savings 2000bp / Wants 1000bp + starter categories. (Chosen over an `auth.users` trigger — trigger failures block signups and are miserable to debug.)
- **RLS probe test:** create a second account, attempt to read/insert/update the first account's rows via the REST API. Keep the script; re-run it after _every_ future migration.
- Heads-up: Supabase's built-in email sender allows only a handful of emails per hour — fine for one real user, painful during testing. Create test users (e.g. the probe's second account) from the dashboard, auto-confirmed, instead of burning signup/reset emails.

**Shippable:** log in on phone and laptop, see the same three envelopes. **Unblocks:** the ledger.

### Phase 3 — The ledger (4–6 evenings) ★ THE MILESTONE

**Goal:** Tin becomes your daily driver. Everything after this phase is enhancement.

- **Home:** three envelope balance cards (from `envelope_balances` view) + big bottom-center Add button.
- **Add expense:** bottom sheet — amount keypad up immediately, category chips (category implies envelope), optional note, editable `occurred_at`. Target: <5 s, 2 taps from open.
- **Add income:** amount → live split preview (Phase 1 function) → one `insert` of 3 rows sharing a `group_id`.
- **Transfers:** envelope→envelope, 2 rows, one `group_id`. Includes the one-tap **"cover from…"** on red envelopes.
- **Opening balances:** onboarding asks what's currently in GCash per envelope → `adjustment` entries.
- **Timeline:** entries grouped by Manila day, with a group's legs collapsed into one logical item — an income reads as one card, not three rows. Void (with reason) and "fix" = void + re-open form prefilled. **Voids always apply to the whole `group_id`** — voiding one leg of an income or transfer would silently corrupt balances.
- **Export from day one of real use:** Settings → download **JSON** (full fidelity, includes voided) and **CSV** (spreadsheet-friendly). Text cells starting with `=`, `+`, `-`, or `@` get a leading apostrophe — the standard spreadsheet formula-injection guard, one line of code. You are never locked in.
- **Basic PWA installability:** manifest + icons (no offline yet) so Tin sits on your home screen like an app. (iOS Add-to-Home-Screen and Chrome install both work with manifest alone; Chrome's install UX just gets richer once the Phase 6 service worker lands.)

**Shippable:** a real tracker you use every day. **Unblocks:** analytics has data; the habit starts.

### Phase 4 — Analytics (2–3 evenings)

**Goal:** answer "how am I doing?" with Manila-correct months.

- Month picker (Manila boundaries), income vs spending totals, net.
- **Transfers are excluded from top-line income/spending totals** — they net to zero overall but would inflate both sides. Per-envelope flow views _do_ include them (they're real to the envelope); adjustments get their own line.
- Per-envelope inflow/outflow; per-category breakdown with % bars.
- **Split adherence:** actual spending mix vs the 70/20/10 plan.
- Charts as plain CSS/SVG bars first — no chart library until one is genuinely needed.

**Shippable:** an Insights tab worth opening at month-end.

### Phase 5 — Recurring (2 evenings)

**Goal:** rent/allowance/subscriptions log themselves.

- `recurring_templates` table (amount, kind, category, day-of-month rule, `next_run_on`, `paused_at`).
- On app open: catch-up poster generates due entries (backdated to their due date, Manila-correct) with an undoable confirm toast.
- **Deterministic posting IDs:** a generated entry's UUID is derived (UUIDv5) from (template_id, due_date, leg index) — _not_ random. If phone and laptop both catch up the same due date, they produce identical IDs and the upsert collapses them; with random IDs, two-device catch-up double-posts rent.
- Income templates post the full 3-way split at current shares (3 legs, one `group_id`) — reusing the Phase 1 split function — never a single-envelope row.
- Manage screen: list, pause, edit, delete templates.

**Shippable:** open Tin on the 1st, rent is already logged and confirmable.

### Phase 6 — PWA + offline (3–5 evenings) — the hardest phase

**Goal:** works in a dead spot; syncs when back. Scope is _cache + outbox_, **not** a general sync engine.

- `vite-plugin-pwa` service worker; app shell cached.
- Dexie mirror of entries/envelopes/categories; UI reads local-first.
- **Outbox:** every write goes to Dexie + an outbox row, then a sync loop pushes them. Exactly two op types: _insert entries_ (upsert, `ignoreDuplicates: true` — retries are no-ops, see rule 4) and _void group_ (update `voided_at` by `group_id` — also idempotent on retry).
- **Delta pull** by `updated_at > cursor` (voids bump `updated_at` via trigger — already in the schema). The cursor is the max `updated_at` the _server_ returned, never the client clock, and each pull overlaps the previous window by ~60 s — overlap is harmless because the mirror upserts by `id`.
- Online/offline indicator; queued-writes badge.
- **Logout clears Dexie + outbox + service-worker caches.** Without this, logout on a shared laptop is theatre. Warn if the outbox is non-empty before logging out.
- PWA shortcut (long-press icon) → deep link to Add expense.

**Shippable:** log an expense in an elevator; it syncs on the way out.

### Phase 7 — Hardening & polish (2–3 evenings)

- TOTP MFA enrollment + challenge flow.
- Tighten CSP to a strict allowlist (self + your Supabase project origin only).
- Keep-alive GitHub Action (see §0).
- Error boundary; audit every failure path surfaces a toast, never a silent loss.
- Lighthouse pass: a11y (AA contrast check against §6 palette), PWA, performance.
- Monthly-export reminder (a recurring template pointed at yourself works fine).

**Shippable:** the version you stop thinking about.

### Phase 8 — GCash statement importer — ✅ CLOSED 2026-07-22 (importer shipped; GCash PDF reader dropped)

**Goal:** backfill history from GCash's emailed, password-protected transaction export. **Entirely client-side — the file never leaves the machine.** This is an _importer with review_, not a sync.

- Parse in-browser (pdf.js handles password-protected PDFs; if GCash sends XLSX, SheetJS community edition).
- Map rows → draft entries; **review-and-confirm table** (edit category/envelope per row; nothing auto-commits).
- **Duplicate detection:** flag drafts matching an existing entry within ±amount-exact and ±36 h, and drafts identical to a previous import (store a source-row hash on imported entries).
- Batch insert as backdated entries with client UUIDs.

**Risk note:** statement-format parsing is the flakiest code you'll write; GCash can change the layout any time. That's why it's last and optional. *(This note aged well — it's the reason the GCash-specific half was ultimately dropped rather than built. See the closure note below.)*

> **CLOSED 2026-07-22 — owner's call, and the right one.** The importer shipped; the **GCash-PDF-specific reader was dropped, not deferred.** Read this before reopening it.
>
> What shipped is a working importer with review: paste a table or CSV, map the columns, review every row, commit as backdated entries. That covers the actual goal — backfilling history — from a spreadsheet, a copied list, or anything else with selectable text.
>
> What was dropped is only the *GCash PDF adapter*. Its cost was never the parsing; it was that nobody had confirmed the emailed statement even contains selectable text. If those pages are images, the job isn't "a small adapter", it's OCR over money — unreliable in a way a ledger cannot absorb, and needing a library that likely can't run under Tin's CSP anyway. Spending 4–8 evenings on a one-time backfill with that unknown at the front, for a format GCash can change at will, was a bad trade against just typing a month in via the 2-tap sheet.
>
> **Reopening is cheap and that is by design.** The phase was built at a seam — `StatementRow` in `src/lib/import-draft.ts`. Anything that can emit `StatementRow[]` inherits the review table, duplicate detection and backdated insert for free, all already tested. If a GCash export with real text ever lands, the adapter is a contained piece of work against a known contract, not a re-architecture.
>
> **The dedupe design changed on the way in.** The roadmap called for "a source-row hash on imported entries", i.e. a new column and a migration. Not needed: derive each entry's UUID from the statement row's natural key (UUIDv5, exactly the trick §5.1 recurring postings use to stop two devices double-posting rent) and a re-import regenerates byte-identical ids that both the Dexie mirror's `bulkAdd` and the server upsert already ignore. Duplicate protection becomes the primary key rather than a check that could be forgotten — no schema change, no sync change.

---

## 3. Data model & security SQL

`supabase/migrations/001_core.sql` — this is the actual migration, not pseudocode.

```sql
-- ============ EXTENSIONS ============
create extension if not exists moddatetime with schema extensions;

-- ============ TABLES ============

create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.envelopes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 40),
  share_bp    integer not null default 0 check (share_bp between 0 and 10000), -- 7000 = 70%
  sort_order  integer not null default 0,
  color       text,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, name),
  unique (id, user_id)  -- composite-FK target: children prove they share the owner
);
-- "shares of active envelopes sum to 10000" is enforced in the app +
-- asserted by the Settings save flow; a DB-level check would need a
-- deferred trigger and isn't worth it at this scale.
--
-- OWNERSHIP FKs (added on top of the roadmap SQL): RLS alone lets user B
-- *reference* user A's envelope/category ids (rows stay invisible via RLS,
-- but the ledger would hold cross-user pointers). Children therefore carry
-- composite FKs on (foreign_id, user_id) so a reference to someone else's
-- row is impossible at the database, not by app discipline.

create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  envelope_id uuid not null,
  name        text not null check (char_length(name) between 1 and 40),
  emoji       text,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, envelope_id, name),
  unique (id, envelope_id),  -- composite-FK target: lets entries enforce category ↔ envelope
  unique (id, user_id),      -- composite-FK target: recurring_templates ownership
  foreign key (envelope_id, user_id) references public.envelopes (id, user_id) on delete restrict
);

create table public.entries (
  id              uuid primary key,  -- CLIENT-generated: retries are idempotent upserts
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  group_id        uuid not null,     -- legs of one action (income split, transfer) share this
  kind            text not null check (kind in ('income','expense','transfer','adjustment')),
  envelope_id     uuid not null,
  category_id     uuid,
  amount_centavos bigint not null check (amount_centavos <> 0),
  note            text check (char_length(note) <= 500),
  occurred_at     timestamptz not null,           -- editable; backdating lives here
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  voided_at       timestamptz,
  void_reason     text,
  check (
    (kind = 'income'  and amount_centavos > 0) or
    (kind = 'expense' and amount_centavos < 0) or
    (kind in ('transfer','adjustment'))
  ),
  -- a category must belong to the entry's envelope. MATCH SIMPLE semantics:
  -- skipped entirely when category_id is null (income/transfer legs). Side effect:
  -- a category can't be re-parented to another envelope once entries reference it —
  -- archive + create new instead, which is the product rule anyway.
  foreign key (category_id, envelope_id) references public.categories (id, envelope_id),
  -- the entry's envelope must belong to the entry's owner (see note on envelopes)
  foreign key (envelope_id, user_id) references public.envelopes (id, user_id) on delete restrict
);

create table public.recurring_templates (   -- used from Phase 5
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind            text not null check (kind in ('income','expense')),
  category_id     uuid,
  amount_centavos bigint not null check (amount_centavos > 0),
  note            text,
  day_of_month    integer not null check (day_of_month between 1 and 31), -- clamped to month length
  next_run_on     date not null,   -- Manila-local date
  paused_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- MATCH SIMPLE: skipped when category_id is null. SET NULL (category_id)
  -- clears only the category on delete (PG 15+); user_id stays intact.
  foreign key (category_id, user_id) references public.categories (id, user_id)
    on delete set null (category_id)
);

-- ============ updated_at TRIGGERS (needed for Phase 6 delta pull) ============
create trigger set_updated_at before update on public.profiles
  for each row execute procedure extensions.moddatetime(updated_at);
create trigger set_updated_at before update on public.envelopes
  for each row execute procedure extensions.moddatetime(updated_at);
create trigger set_updated_at before update on public.categories
  for each row execute procedure extensions.moddatetime(updated_at);
create trigger set_updated_at before update on public.entries
  for each row execute procedure extensions.moddatetime(updated_at);
create trigger set_updated_at before update on public.recurring_templates
  for each row execute procedure extensions.moddatetime(updated_at);

-- ============ INDEXES ============
create index entries_user_time    on public.entries (user_id, occurred_at desc) where voided_at is null;
create index entries_user_env     on public.entries (user_id, envelope_id)      where voided_at is null;
create index entries_user_group   on public.entries (user_id, group_id);
create index entries_user_updated on public.entries (user_id, updated_at);      -- sync delta pull
create index recurring_user       on public.recurring_templates (user_id);
-- (no standalone user_id indexes on envelopes/categories: their UNIQUE
--  constraints already index user_id as the leading column)

-- ============ ROW LEVEL SECURITY ============
-- Enabled in the SAME migration that creates the tables. No RLS-less window, ever.

alter table public.profiles            enable row level security;
alter table public.envelopes           enable row level security;
alter table public.categories          enable row level security;
alter table public.entries             enable row level security;
alter table public.recurring_templates enable row level security;

-- profiles (keyed on id, not user_id)
create policy profiles_select on public.profiles for select using (auth.uid() = id);
create policy profiles_insert on public.profiles for insert with check (auth.uid() = id);
create policy profiles_update on public.profiles for update
  using (auth.uid() = id) with check (auth.uid() = id);

-- envelopes
create policy envelopes_select on public.envelopes for select using (auth.uid() = user_id);
create policy envelopes_insert on public.envelopes for insert with check (auth.uid() = user_id);
create policy envelopes_update on public.envelopes for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- categories
create policy categories_select on public.categories for select using (auth.uid() = user_id);
create policy categories_insert on public.categories for insert with check (auth.uid() = user_id);
create policy categories_update on public.categories for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- entries
create policy entries_select on public.entries for select using (auth.uid() = user_id);
create policy entries_insert on public.entries for insert with check (auth.uid() = user_id);
create policy entries_update on public.entries for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- recurring_templates
create policy recurring_select on public.recurring_templates for select using (auth.uid() = user_id);
create policy recurring_insert on public.recurring_templates for insert with check (auth.uid() = user_id);
create policy recurring_update on public.recurring_templates for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy recurring_delete on public.recurring_templates for delete using (auth.uid() = user_id);

-- NOTE: no DELETE policy on entries/envelopes/categories/profiles → deletes are denied.
-- Envelopes/categories "delete" = archived_at. Entries "delete" = voided_at.

-- ============ APPEND-ONLY, ENFORCED (column-level grants) ============
-- The ONLY mutation allowed on a ledger row is voiding it.
-- Edits are void + insert a corrected row. The database enforces this, not app discipline.
revoke update on public.entries from authenticated;
grant  update (voided_at, void_reason) on public.entries to authenticated;
-- (the updated_at trigger still fires; triggers aren't limited by the caller's column grants)

-- ============ VIEWS (security_invoker so RLS applies to the querying user) ============

-- LEFT JOIN from envelopes, not an aggregate over entries alone:
-- a brand-new envelope with zero entries must still appear (as ₱0.00),
-- or a fresh account's home screen renders no cards at all.
create view public.envelope_balances
with (security_invoker = true) as
select
  e.user_id,
  e.id as envelope_id,
  coalesce(sum(en.amount_centavos), 0)::bigint as balance_centavos
from public.envelopes e
left join public.entries en
  on en.envelope_id = e.id and en.voided_at is null
group by e.user_id, e.id;

create view public.monthly_flows
with (security_invoker = true) as
select
  user_id,
  envelope_id,
  category_id,
  kind,
  (date_trunc('month', occurred_at at time zone 'Asia/Manila'))::date as manila_month,
  sum(amount_centavos)::bigint as total_centavos,
  count(*) as entry_count
from public.entries
where voided_at is null
group by 1, 2, 3, 4, 5;
```

### Key security callouts

- **`VITE_`-prefixed vars are PUBLIC.** Anything with that prefix is baked into the JS bundle anyone can read. `VITE_SUPABASE_ANON_KEY` is fine there _only because RLS is on every table_. The **`service_role` key never leaves the Supabase dashboard** — not in frontend code, not in Netlify env vars, not in the repo, not in the keep-alive workflow. If it ever leaks, rotate it immediately; it bypasses RLS entirely.
- Upserts from the client use `ignoreDuplicates: true` (`ON CONFLICT DO NOTHING`) — deliberately compatible with the revoked-UPDATE grant above.
- `user_id` always defaults to `auth.uid()` server-side; the client never sends it.
- `_headers` starts with: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, and a CSP with `default-src 'self'; connect-src 'self' https://<ref>.supabase.co wss://<ref>.supabase.co; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'` (tightened further in Phase 7). **`style-src 'unsafe-inline'` is required, not sloppiness:** without it, `default-src 'self'` blocks inline `style=` attributes — which the analytics bars (dynamic widths) and bottom-sheet transforms rely on. Script injection is what CSP is really guarding here, and `script-src` stays strict `'self'`.
- Known, accepted gap: the DB doesn't verify that a transfer's two legs sum to zero, or that an income's three legs match the split — that's app logic (unit-tested in Phase 1). A deferred constraint trigger could enforce it but isn't worth the complexity for a solo project; the append-only ledger means a bad group is at least visible and voidable, never silently mutated.
- **Ownership FKs (added during Phase 2 build, closing a gap the original SQL missed):** RLS hides rows but doesn't stop user B from *referencing* user A's envelope/category ids in B's own rows. Children now carry composite FKs on `(foreign_id, user_id)` — `entries→envelopes`, `categories→envelopes`, `recurring_templates→categories` — so cross-user references fail at the database. The RLS probe asserts this.

---

## 4. Repo structure

```
tin/
├─ .github/workflows/keepalive.yml     # Supabase ping (Phase 7)
├─ ROADMAP.md                          # this file — plan, schema, checklist
├─ public/
│  ├─ _headers                         # security headers / CSP
│  ├─ _redirects                       # /* /index.html 200
│  └─ icons/                           # PWA icons, favicon
├─ supabase/
│  ├─ migrations/
│  │  └─ 001_core.sql
│  └─ tests/
│     └─ rls-probe.ts                  # two-account cross-access test; run after every migration
├─ src/
│  ├─ lib/                             # PURE logic. No React, no IO, fully unit-tested.
│  │  ├─ money.ts                      #   centavos, formatPHP, parseAmount
│  │  ├─ split.ts                      #   largest-remainder split
│  │  ├─ dates.ts                      #   Manila month/day keys, boundaries
│  │  ├─ export.ts                     #   entries → CSV / JSON
│  │  ├─ shares.ts                     #   split percentages ↔ bp    (Phase 3.5)
│  │  ├─ import-draft.ts               #   StatementRow seam, dedupe  (Phase 8)
│  │  └─ import-parse.ts               #   delimited text → rows      (Phase 8)
│  ├─ db/
│  │  ├─ supabase.ts                   # client init (reads VITE_ vars)
│  │  ├─ dexie.ts                      # local mirror schema        (Phase 6)
│  │  ├─ outbox.ts                     # pending-writes queue       (Phase 6)
│  │  ├─ sync.ts                       # push outbox / delta pull   (Phase 6)
│  │  ├─ config.ts                     # envelope/category writes  (Phase 3.5)
│  │  └─ import.ts                     # classify + batch commit    (Phase 8)
│  ├─ features/
│  │  ├─ auth/                         # login, signup, session, logout(+cache wipe)
│  │  ├─ home/                         # balance cards + Add button
│  │  ├─ entries/                      # keypad sheet, income split, timeline, void/fix, cover-transfer
│  │  ├─ analytics/                    # month picker, flows, adherence
│  │  ├─ recurring/                    # templates + catch-up poster (Phase 5)
│  │  ├─ settings/                     # envelopes, categories, percentages, export, account
│  │  └─ import/                       # paste/CSV → review → backdated insert (Phase 8)
│  ├─ components/                      # Button, BottomSheet, AmountText, NavBar, EmptyState…
│  ├─ styles/
│  │  └─ theme.css                     # design tokens from §6
│  ├─ App.tsx / main.tsx / router.tsx
├─ .env.example                        # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (values blank)
├─ .gitignore                          # .env from commit #1
├─ index.html · vite.config.ts · tailwind.config.ts · tsconfig.json · package.json
```

Rule of the house: **`src/lib` imports nothing from `src/`** — it's the tested, pure core. Features import lib and db; components import nothing but other components.

---

## 5. Dependency-ordered task checklist

Work top to bottom; nothing depends on anything below it.

**Phase 0 — Hello, Tin**

- [x] 0.1 Create GitHub repo `tin`; init Vite React-TS app
- [x] 0.2 Add Tailwind, ESLint, Prettier, Vitest
- [x] 0.3 `.gitignore` with `.env`; commit `.env.example`
- [x] 0.4 `public/_headers` + `public/_redirects`
- [x] 0.5 Connect Netlify → auto-deploy `main`; verify live URL
- [x] 0.6 Themed hello page with the §6 background/text tokens (first taste of cozy)

**Phase 1 — Money brain**

- [x] 1.1 `money.ts` (+tests: format, parse, reject bad input)
- [x] 1.2 `split.ts` (+tests: ₱0.01, ₱0.03, ₱1,234.57, ₱888,888,888.88, 10k-random sum invariant, tie-break determinism)
- [x] 1.3 `dates.ts` (+tests: UTC/Manila month boundary both directions)
- [x] 1.4 Deployed split-preview screen

**Phase 2 — Accounts & vault**

- [x] 2.1 Create Supabase project (leaked-password protection: Pro-only, skipped)
- [x] 2.2 Write & apply `001_core.sql`; commit it
- [x] 2.3 Netlify env vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`); local `.env`
- [x] 2.4 Auth screens + session handling + route guard + password-reset flow (redirect URL allowlisted in Supabase)
- [x] 2.5 First-run seeding: profile row + 3 envelopes (7000/2000/1000 bp) + starter categories, idempotent
- [x] 2.6 `rls-probe.ts`: second account (dashboard-created, auto-confirmed) cannot read/write first account's rows — **passes**
- [x] 2.7 Logout works (cache-wipe hook stubbed for Phase 6)

**Phase 3 — The ledger ★**

- [x] 3.1 Home: balance cards from `envelope_balances` + bottom nav + Add button
- [x] 3.2 Expense bottom sheet: keypad-first, category chips, note, editable `occurred_at` — measure: ≤2 taps, <5 s
- [x] 3.3 Income flow: amount → live split preview → 3-row insert w/ shared `group_id`
- [x] 3.4 Onboarding opening balances (`adjustment` entries)
- [x] 3.5 Timeline grouped by Manila day; group legs collapsed into one item; entry detail
- [x] 3.6 Void with reason — always the whole `group_id`, never a single leg; "Fix" = void + prefilled re-entry
- [x] 3.7 Transfer flow + one-tap "cover from…" on red envelopes
- [x] 3.8 Export JSON + CSV from Settings
- [x] 3.9 PWA manifest + icons (installable; offline comes later)
- [x] 3.10 **Start using Tin daily. This is the finish line for “usable.”**

**Phase 4 — Analytics**

- [x] 4.1 Month picker on Manila boundaries
- [x] 4.2 Income vs spending + net for month (transfers excluded from totals)
- [x] 4.3 Per-envelope and per-category breakdowns (CSS/SVG bars)
- [x] 4.4 Split adherence: actual mix vs plan

**Phase 5 — Recurring**

- [x] 5.1 Catch-up poster logic: compute due dates from templates (table already shipped in `001_core.sql`), Manila-correct, clamp day 29–31 to month end; deterministic UUIDv5 posting IDs; income templates post the full split
- [x] 5.2 On-open catch-up with confirm/undo toast
- [x] 5.3 Manage screen (add/edit/pause/delete)

**Phase 6 — PWA + offline** _(done 2026-07-19)_

- [x] 6.1 `vite-plugin-pwa` service worker, app shell cached
- [x] 6.2 Dexie mirror; UI reads local-first
- [x] 6.3 Outbox queue; writes go local + queue
- [x] 6.4 Sync loop: push entry upserts (`ignoreDuplicates`) + void-group updates; delta pull by `updated_at` (server-side cursor, ~60 s overlap)
- [x] 6.5 Online/offline indicator + queued-writes badge
- [x] 6.6 Logout wipes Dexie + outbox + SW caches (warn if outbox non-empty)
- [x] 6.7 PWA shortcut → Add expense; airplane-mode end-to-end test (headless-Edge Playwright: offline reload from SW → offline expense queued → reconnect → outbox drained → logout wipe verified)

**Phase 7 — Hardening** _(DONE + verified 2026-07-22)_

- [x] 7.1 TOTP MFA enroll + challenge — opt-in, not enforced (solo account, no admin to reset a lost factor; RLS + strong password stay the boundary). Enroll/manage in Settings (`MfaSection`); login-time gate (`MfaGate` inside `RequireAuth`) steps up aal1→aal2; helpers in `features/auth/mfa.ts`; fails **open** offline so the local-first app still opens. Verified end-to-end on a real authenticator (enroll → logout → login code gate) 2026-07-22.
- [x] 7.2 CSP tightened to strict allowlist — dropped dead `wss://` (Tin never uses Realtime); added explicit `script-src 'self'`, `object-src 'none'`, `frame-src 'none'`, `worker-src`/`manifest-src`/`font-src 'self'`, `upgrade-insecure-requests`. `style-src 'unsafe-inline'` + `img-src data:` kept (inline widths/transforms; PWA icons + MFA QR) with reasons in `public/_headers`.
- [x] 7.3 Keep-alive workflow — `.github/workflows/keepalive.yml` live on GitHub (repo `Jerrickhoo/tin`, private). Repo secrets `SUPABASE_URL` + `SUPABASE_ANON_KEY` set; workflow run confirmed green 2026-07-22. Self-pings the REST endpoint every 3 days from now on.
- [x] 7.4 Error boundary + failure-path audit — `ErrorBoundary` wraps the app in `main.tsx`; audit found & fixed one silent path (`Settings.logout` now toasts on wipe/sign-out failure). All other async paths already toast.
- [x] 7.5 a11y/PWA/perf — **Lighthouse (mobile, prod /login, LH 13.3.0): Performance 99 · Accessibility 100 · Best Practices 100.** AA contrast also scripted (`npm run check:contrast`, worst 4.86:1); new MFA inputs labeled; PWA installability verified via Application tab (manifest + SW; Chrome dropped LH's PWA category). Only perf note is "reduce unused JS ~119 KiB" = the deferred bundle split — a non-issue on an SW-cached app.

  **Re-measured after theme v3 (2026-07-22, LH 13.2.0, Moto G Power / Slow 4G, prod, incognito): Performance 93 · Accessibility 100 · Best Practices 100.** The 6-point drop was entirely **LCP 3.0 s** against FCP 1.9 s — that gap is text painting in the fallback face and re-painting when Nunito lands, because a font isn't discoverable until the CSS has downloaded and parsed. Fixed by a ~30-line `preloadLatinFonts()` plugin in `vite.config.ts` that emits `<link rel="preload">` for the two `*-latin-wght-normal` woff2 files (content-hashed, so generated from the bundle). **Needs one more clean run to confirm the recovery.**

  Two measurement traps worth writing down, both cost an evening once:
  - **Run it in incognito.** A normal-profile run scored 68 with TBT 3,080 ms and claimed "1,810 KiB unused JS" — against a 613 KB bundle, which is arithmetically impossible. That was extension code, not Tin. Incognito: TBT 20 ms.
  - **Run it on `/login`, not `/`.** With a session, `/` boots Dexie, the sync loop, seeding and the catch-up poster — a completely different workload from the static login screen these numbers describe. (Logged out, `/` redirects to `/login`, so incognito happens to be comparable.)

  Verified while wiring the preload: only the two latin faces are ever fetched for latin text — the ext/cyrillic/vietnamese subsets never download. So trimming Inter to latin shrinks the **SW precache**, not the critical path; it will not move LCP.

  **Done 2026-07-22.** Inter now gets the same hand-declared latin-only `@font-face` Nunito has, in `theme.css`. Precache **953.02 KiB → 798.20 KiB across 18 → 12 entries**; the six unused Inter subsets are gone. Confirmed the trim didn't silently fall back to a system face — a wrong `@font-face` path fails invisibly — by checking `document.fonts` resolves both families and that `Peña ₱1,234` measures differently from monospace. LCP is unchanged by design.

  > **Superseded by §6 v4 (same day).** The pixel reskin dropped Inter and Nunito entirely — both packages are uninstalled — and replaced them with Press Start 2P + three Pixelify Sans weights, 36 KB against 87 KB. The hand-declared latin-only technique documented here carried over verbatim to the new faces; only the font names changed. The `₱`-measures-differently-from-monospace check above is **no longer a valid smoke test**: money now renders in the system monospace stack on purpose (§6, "Numbers deliberately opt out").
- [x] 7.6 Monthly export reminder — localStorage "last export" nudge in Settings (`lib/exportReminder.ts`, unit-tested), **not** a self-pointed recurring template (that would post fake money rows into the ledger it's meant to back up).

**Phase 3.5 — Envelope & category management (retrofit, 2026-07-22)**

> **Why this has its own heading:** §0 promises editable percentages and categories you can "rename/add/archive freely", and the §4 file tree claimed `settings/` already covered "envelopes, categories, percentages" — but **no phase ever gave it a task line**, so it was never built and nothing flagged it. Prose promises without a checklist item don't get built. Found 2026-07-22 by auditing the code against the roadmap's own claims rather than against its checkboxes.

- [x] 3.5.1 Editable split — `/envelopes`, linked from Settings. Percentages in, basis points stored. The "active shares sum to 10000" invariant has **no database check behind it** (001_core.sql says a deferred trigger isn't worth it at this scale), so `lib/shares.ts` *is* the enforcement — and the save is **one upsert, not three updates**, because a partial failure would leave the split permanently malformed. `name` rides along in the upsert because its INSERT arm must satisfy every NOT NULL column. Verified against the live schema (saved 60/30/10, confirmed after reload, restored).
- [x] 3.5.2 Envelope rename — label only; entries are untouched.
- [x] 3.5.3 Categories add / rename / emoji / archive / restore. **No re-parenting, by design:** entries carry a composite FK `(category_id, envelope_id)`, so moving a category between envelopes is refused by the database once anything references it. 001_core.sql already called it — "archive + create new instead, which is the product rule anyway" — so the sheet says so in plain words instead of offering a control that fails.
- [x] 3.5.4 Config writes go **direct to Supabase and need a connection**, following the Phase 5 recurring-templates precedent rather than the outbox. The outbox has exactly two op types on purpose, both idempotent money writes; config edits are rare, need server-side uniqueness, and have nothing to reconcile offline. After each write we `syncNow()` so the mirror the UI reads picks it up. 24 new tests.

  Driving it caught a crash: an **empty** envelope list is not a ready state, and on a cold load the mirror is empty until the first pull — `envelopes[envelopes.length - 1].name` threw and took the screen into the ErrorBoundary. Same cold-load race as the import screen, worse symptom. Empty is now its own rendered state. **Worth remembering: `[]` is truthy, so `{list && …}` is not a loading guard.**

**Phase 8 — statement importer** — ✅ **CLOSED 2026-07-22.** Importer shipped and live; the GCash-PDF-specific reader was **dropped by decision**, not left pending. Rationale in the §2 closure note.

- [x] ~~8.1 Request own GCash export; inspect real file format~~ — **dropped.** This was the gate for the PDF reader, and the reader was dropped, so the gate is moot. It resolved to a single unanswered question — does the emailed statement contain selectable text or images? — and the honest answer was that nobody wanted to spend evenings finding out for a one-time backfill.
- [x] 8.2a Client-side parse, format-independent — `src/lib/import-parse.ts`: CSV/TSV/pasted-table reader with quote handling, delimiter detection, header sniffing and an explicit column mapping. Statement-flavoured amounts (`₱`, thousands commas, leading/trailing/unicode minus, accountancy parens) and dates (ISO, named-month both orders, numeric d/m/y). 35 tests.

  Two things it refuses to guess, because guessing them silently corrupts a ledger: **`03/04/2026`** (3 Apr or 4 Mar? the UI asks) and **direction on an unsigned amount** (the UI asks). Bare dates anchor at **noon** Manila, not midnight — a midnight anchor sits within ±8 h of the day boundary, so Manila-day grouping would file half an import on the wrong date. Unreadable rows are reported with their row number, never dropped.
- [x] ~~8.2b Client-side parse, GCash PDF~~ — **dropped.** pdf.js-with-password emitting `StatementRow[]` remains the design if it's ever revived; the seam is in place and 8.3–8.5 would come free. Not built because the prerequisite (a statement confirmed to hold selectable text) was never established, and image-only pages would turn this into OCR-over-money — a different, worse project. Typing a month into the 2-tap sheet beats it.
- [x] 8.3 Row → draft-entry mapping + review/confirm table — `src/features/import/ImportStatement.tsx`, three steps (paste → map columns → review), reachable from Settings → Import. Debit ⇒ expense needing a category (category implies envelope, §1); credit ⇒ income posting the **full split at current shares**, same rule recurring income follows. Nothing writes until the confirm button; a flagged row starts unticked so a careless confirm can't double-post.
- [x] 8.4 Duplicate detection — two halves, because there are two ways a row can already be on the ledger. **Re-import:** deterministic UUIDv5 id (see the note in §2) — detected up-front, shown as "already imported", and locked out. **Hand-typed overlap:** exact amount + same direction + within ±36 h, matched against **group totals, not legs** (a ₱10,000 income is 7,000/2,000/1,000 and no leg equals the statement figure). Voided groups never match — voiding means it didn't happen. Flagged, never auto-resolved.
- [x] 8.5 Batch insert as backdated entries — `src/db/import.ts` writes through `insertPostedRows`, so an import is Dexie + outbox like every other write since Phase 6: works offline, drains later. Chunked at 200 rows so a year-long backfill isn't one all-or-nothing outbox row; each chunk independently idempotent.

  **Verified in real Edge** (probe-b, `scratchpad/drive-import.mjs`): auto-mapping, sign detection, duplicate classification, bulk-categorise and the confirm bar all correct; stopped short of committing so the shared probe ledger stays clean — the commit path is covered by `src/db/import-flow.test.ts` instead. That run caught one genuine bug: the screen fetched categories with `[]` deps, so a **cold** load straight to `/import` could beat sync populating the mirror and leave the category pickers permanently empty. Now follows `version` like every other screen. 77 new tests (161 total).

  **Shipped 2026-07-22** — commit `e0c9946`, pushed to `Jerrickhoo/tin`, deployed to <https://tin-jar.netlify.app>. Prod re-verified by deep-linking to `/import` on a cold load (the exact path that was broken): route resolves, auto-mapping correct, category pickers populate, no page errors. Prod ledger untouched — the smoke test stops before the confirm button.

---

## 6. Design system — pixel pastel

> **v4, 2026-07-22 — reskinned.** Replaces "midnight violet, one lamp" (v2/v3) with a retro pixel-art treatment: dark plum surfaces, pastel accents, pixel typefaces, hard edges everywhere. This was a **reskin, not a rebuild** — no component logic changed, no layout changed. The rule that made that possible is the one v2 wrote down and v4 collected on: token names in `src/styles/theme.css` are role-based, so ~360 utility usages across 25 component files restyled without being touched.
>
> What survived unchanged: measured contrast enforced by `npm run check:contrast`, no off-origin assets, and the CVD caveat below (improved, still open).

A CRT in a dark room: deep-plum surfaces, pastel sprites, scanlines over the top. All ratios below are **measured** (WCAG relative-luminance script, not eyeballed); every text token clears AA (4.5:1) on `bg-base`, `bg-surface`, *and* `bg-raised`. Worst case is `text-muted` on `bg-raised` at **5.19:1** — up from v3's 4.86:1 floor.

### Palette

Token names in code are role-based (`src/styles/theme.css`) so a future restyle touches one file. §6-name → code-name mapping is commented in that file, and is unchanged from v2 — that stability is the whole reason v4 was cheap.

| Token            | Hex       | Use                                            | Contrast on `bg-base` |
| ---------------- | --------- | ---------------------------------------------- | --------------------- |
| `bg-base`        | `#17131F` | app background (deep plum)                     | —                     |
| `bg-surface`     | `#221B2E` | cards                                          | —                     |
| `bg-raised`      | `#2D2440` | bottom sheets, modals                          | —                     |
| `border`         | `#3D3354` | borders, dividers (2px, never hairline)        | —                     |
| `text-primary`   | `#F2E9F7` | body & labels (plum-white)                     | 15.46 : 1             |
| `text-secondary` | `#C4B3D6` | labels, secondary                              | 9.37 : 1              |
| `text-muted`     | `#A294B8` | timestamps, hints                              | 6.49 : 1              |
| `accent`         | `#C9A7FF` | primary buttons, focus rings, links (lavender) | 9.10 : 1              |
| `on-accent`      | `#1E1030` | text on accent buttons                         | 8.92 : 1 on accent    |
| `positive`       | `#A8E6CF` | income, positive deltas (mint)                 | 12.95 : 1             |
| `negative`       | `#FF9AA2` | expenses, red envelopes (soft coral)           | 9.04 : 1              |
| `env-needs`      | `#C9A7FF` | Needs identity (lavender)                      | 9.10 : 1              |
| `env-savings`    | `#A8E6CF` | Savings identity (mint)                        | 12.95 : 1             |
| `env-wants`      | `#FFB3D9` | Wants identity (pastel pink)                   | 11.05 : 1             |

The base is deep plum rather than near-black **on purpose**: pastels on `#000` read as neon, which is the opposite of cozy. Every surface keeps a violet cast so the pastels sit *on* something instead of glowing out of a void. `theme-color` in `index.html`, `manifest.webmanifest`, `favicon.svg` and `scripts/generate-icons.mjs` all track `bg-base`; change them together.

**Known gap — envelope colors under color-vision deficiency.** Carried forward from v3 and **improved but not closed**. Re-measured against the v4 hexes (Viénot 1999 deuteranopia simulation → CIEDE2000): `env-savings` (mint) ↔ `env-wants` (pink) sit at **ΔE 8.7 under deuteranopia** against 38.5 for normal vision. That is up from v3's 5.5 — the pinker Wants helps — but still under the 15 floor, so red-green colorblind viewers still cannot reliably separate a Savings bar from a Wants bar by hue alone. The other two pairs are fine (needs↔savings 27.6, needs↔wants 18.4 under deuteranopia). Still **mitigated, not fixed**, by the same rule as before: identity is never carried by color alone anywhere in the app — every dot, meter and chip sits immediately next to the envelope's name in text. Fixing it properly still means re-stepping the palette *and* migrating the `color` column on existing `envelopes` rows. The workable direction is unchanged: spread the three on **lightness** as well as hue.

Note `env-needs` still deliberately shares the accent lavender: Needs is the app's center of gravity. `negative` (coral) vs `env-wants` (pink) remain neighbours — keep negative for amounts/errors only, wants for identity dots/bars only.

### Hard edges, light, texture (v4)

All defined once in `src/styles/theme.css`; screens compose them, never re-roll them.

- **Zero radius, from one block.** `--radius-xs` … `--radius-4xl` are all `0px`. Tailwind v4 resolves `rounded-xl` to `var(--radius-xl)`, so the 104 hardcoded `rounded-*` classes across 25 files squared without a single JSX edit. `rounded-full` is the one exception — v4 hardcodes it to `calc(infinity * 1px)` with no variable — so its 23 uses were removed by hand.
- **The screen** — `body::before` is a much-weakened pastel bloom (a smooth gradient is the least pixel-native thing available, so it earns its place only by being nearly subliminal); `body::after` carries scanlines plus a 4×4 ordered dither. Scanline period is **3px, not 2px**: at 2px it beats against the device pixel grid on 1.5x and 2.5x DPR screens and crawls during scroll.
- **`.card`** — 2px border, flat `bg-surface`, and a **solid offset shadow** rather than a blurred one. A blur is a lens; pixel art is drawn, so depth comes from a shape displaced by whole pixels. `.sheet-surface` is the same recipe one step brighter.
- **`.press`** — the offset shadow *is* the affordance: at rest the control floats 2px up-left of its own shadow and pressing drops it onto it, in 60ms `steps(2)`. Replaces v3's `scale(0.97)`, which resampled the glyph grid mid-animation and made pixel text shimmer.
- **`.meter`** — now segmented into discrete cells by a repeating hard-stop gradient, so small differences are *countable*, not merely visible. Plan tick unchanged (light core, dark halo).
- **Blur is banned app-wide.** Every `backdrop-blur` and `blur-3xl` glow was removed — a lens over scrolling text smears the pixel grid it covers, and costs a GPU pass per frame on exactly the elements composited during scroll. Anything that was translucent-and-blurred is now opaque.
- **Pixel art is drawn, never sourced.** `img-src 'self' data:` means a hotlinked asset is blocked by CSP in production while working fine in dev. Nav icons and the tin sprite are inline SVG on a 16×16 grid, filled `<rect>`s with `shape-rendering="crispEdges"` — stroked paths centre on their path and land on half-pixels. They also inherit the palette tokens, so art can't drift out of sync with the theme.

### Type & shape

- **Body:** Pixelify Sans, self-hosted via Fontsource, latin subset declared by hand. Chosen over VT323 because it ships **real weights** — the JSX carries hierarchy in `font-medium` (17 uses), `font-semibold` (42) and `font-bold` (38), and a single-weight face would collapse all 97 into one texture or into synthesized faux-bold.
- **Display:** Press Start 2P (`--font-display`), **short headings only** — app name, section titles, button labels. It runs ~2.3× wider per character, so every heading that adopted it stepped *down* in size, and it is never applied to a sentence.
- **Weight scale is remapped down one step** in `@theme`: `medium`→400, `semibold`→500, `bold`→600. A pixel face has no optical weight axis — it bolds by adding whole pixels to every stem, so the face's own 700 is double the stem width of its 400 and most of the app read as solid blocks. Remapping thinned all 97 usages from one block while keeping three distinct steps. No 700 face is loaded as a result.
- **Numbers deliberately opt out of the pixel aesthetic.** `--font-numeric` (system monospace) is applied via the `tabular-nums` class. Pixel faces separate 6/8/5 and 0/8 by one or two lit pixels — fine for a score counter, not for a balance you act on. It also **fixes `₱`**: neither pixel face covers U+20B1, so before this every amount was a pixel-font number with a fallback-font peso sign glued to the front. This overloads a Tailwind utility on purpose — all 26 uses in the codebase are already exactly and only numeric content. Delete that one block in `theme.css` to revert.
- **Font budget went down:** 36 KB (Press Start 2P + three Pixelify weights) against 87 KB for Inter + Nunito. Both old packages were uninstalled. The LCP element (the hero balance) now needs **no font download at all** — it renders in the system numeric stack.
- **Shape:** 0 radius everywhere; 2px borders; min 44px tap targets; bottom nav + Add button in the thumb zone.
- **Motion:** 140–180 ms on sheets, all `steps()` rather than eased, so transitions read as frames. None on data updates. Everything disabled under `prefers-reduced-motion`.

---

## 7. Risk list — top 5, blunt

1. **You stop logging. (The #1 killer — not a bug, a habit.)** Every abandoned tracker died here. _Mitigation:_ Phase 3 is ruthlessly optimized for 2-tap entry; installable icon in Phase 3, not Phase 6; backdating for forgotten days; dogfooding starts at end of Phase 3, not when it's "done." If entry ever takes >5 s, that's a P0 bug.
2. **Offline sync scope creep.** A solo dev building a general sync engine is a tar pit; this is where the project quietly dies in month 3. _Mitigation:_ app is fully usable online-only through Phase 5; Phase 6 is strictly mirror + outbox + delta pull; append-only + client UUIDs means there is no conflict resolution to build. If Phase 6 exceeds ~6 evenings, stop and ship online-only — it's already a complete product.
3. **An RLS mistake exposes your finances on a public URL.** One table created without RLS is world-readable via the anon key. _Mitigation:_ RLS lives in the same migration as `CREATE TABLE`; the two-account probe test is written in Phase 2 and re-run after every migration; `service_role` never leaves the dashboard.
4. **Supabase free-tier project pause or loss.** Pauses after 7 days idle; free tier has no automated backups — a deleted project is gone. _Mitigation:_ keep-alive Action (₱0); migrations in the repo mean rebuild-from-zero is ~10 minutes; export button ships in Phase 3 and a monthly export reminder makes backups a habit. Your data outlives any Supabase project.
5. **Perfectionism before dogfood (solo student edition).** Tinkering with analytics colors in week 2 while expenses still can't be logged, then exams hit and the repo goes cold. _Mitigation:_ the phase order **is** the mitigation — nothing about polish precedes daily usability; every phase ends deployed; if a phase stalls, cut its scope, not the shipping.

---

## 8. Phase 9 — habit loop & insight rework (2026-07-24)

Four changes, requested together. Ordered here by how much of the app they touch.

### 9.1 "Where it went" was a rank chart pretending to be a ratio chart

**The bug:** each category bar was `spent / biggestCategory`, so the top bar was full-width in _every_ month — whether it was 90% of spending or 12%. The shape of the chart carried no information about the month.

Now every width is a share of **total spending**, the percentage is stated in text next to the peso amount, and a stacked 100%-wide composition bar sits above the rows so the whole is visible at a glance.

Two things the naive fix would have got wrong, both now handled in `lib/analytics.ts`:

- **The denominator did not exist.** `summarizeMonth` counted every expense in `spendingCentavos` but only categorised ones in `perCategory`. Dividing by the former made the shares silently sum to <100%; dividing by the latter hid real money. There is now an `uncategorizedCentavos` field and an explicit **Uncategorized** row, so the column always adds to 100%.
- **True shares are individually small.** Twelve categories means everything under ~4% is thinner than one cell of the segmented `.meter`. The tail folds into one **Other · N categories** row, expandable — and expanding _re-derives_ the breakdown rather than un-hiding rows, because the largest-remainder pass is what keeps the percentages summing to exactly 10000 bp either way.

`sharesBpOf` is the inverse direction of `splitByLargestRemainder` (parts → shares instead of total → parts) and exists for the same reason: a breakdown that visibly fails to add up undermines every other number on the screen.

### 9.2 Streak, with three repair saves a month

`lib/logging-streak.ts` used to argue **against** a streak counter in its header comment — a number that resets to zero punishes one missed day so hard that people abandon the app rather than break the chain, which is the exact failure mode risk #1 describes. That objection was never answered, only deferred.

**Repair saves answer it.** Three days a month can be bought back, so one missed day is recoverable rather than terminal. The old comment has been rewritten rather than deleted — the reasoning still matters, and a file that contradicts its own code is worse than either position.

Rules, all pure and tested:

- A day counts if it has any non-voided entry, **a check-in** (§9.7), **or** a save.
- **Today never breaks a streak.** It is in progress until PHT midnight, so the run is measured from today when today counts and from yesterday when it does not. Only a missing _yesterday_ ends anything.
- Repair is **manual, prompted, and bounded** — chosen over auto-consume, because a scarce resource should not be spent while you sleep.
- Only a **single missed day flanked by logged days** can be repaired, and only within 2 days. Two consecutive misses is a genuinely broken chain; spending a save to paper over it would buy nothing.
- The prompt states the streak you would end up with, and that number is **computed, never estimated** — it makes a promise and has to keep it.
- Budget is charged to the **repaired day's month**, not the month you pressed the button in, so a save for the 31st is still spendable on the 1st.

**Storage:** migration `003_streak_saves.sql` — `(user_id, day_key)` PK, which makes repair idempotent by construction. localStorage was rejected because logout wipes IndexedDB and the caches, and a streak you lose by signing in elsewhere is worse than no streak. The ledger was rejected because a save is not money, and a non-money row in an append-only money log corrupts every balance and export it touches.

Writes are **online-only, direct to Supabase** (the `config.ts` precedent), not through the outbox. The outbox carries exactly two idempotent money ops on purpose; a save queued for two days could drain into a month whose budget was consumed meanwhile, and the queue has no way to reject it.

Two deliberate deviations, both commented at their site:

- `streak_saves` is the **only table with a DELETE policy**. Elsewhere deletes are denied because the rows are financial history. A save is a reversible choice about a habit counter, and nothing references it.
- Its mirror **applies an empty pull**, unlike `mirrorReplaceEnvelopes`. Because a delete policy exists, zero rows is a state a user can genuinely reach — refusing it would leave a deleted save propping up a streak forever.

### 9.3 The notification — in-app only, and why

An app that is closed cannot notify you without a server. Built: an evening banner on Home, gated to **18:00 PHT and later**, when nothing has been logged today. Earlier than that it is false in spirit — an app that warns you at breakfast about a midnight deadline is noise you learn to ignore, which costs it the one moment it needed to be heard.

It keys off `todayHasEntry`, **not** the streak — see §9.7 for why that distinction had to exist before check-ins could ship.

**Web Push was deliberately not built.** It needs VAPID keys, a `push_subscriptions` table, a Supabase Edge Function on cron — and, the hidden cost, a migration from `generateSW` to `injectManifest` so the service worker has somewhere to put a `push` listener. That means hand-writing the SW that currently makes the app work offline. Also: iOS only delivers web push to a PWA added to the Home Screen, and the server would necessarily learn whether you logged today. **If this is ever picked up, it is its own phase**, not a bolt-on.

### 9.4 Calmer backdrop

The old `body::after` stacked **two** noise layers — 3px scanlines _and_ a 4x4 ordered dither — at a combined 0.5 opacity, and the sum read as grain rather than as a screen. The dither is gone outright: it existed to stop banding on large flat fills, and since every card paints an opaque `--color-surface` over it, it was only ever visible in the gutters where there is nothing to band. Scanlines are 0.5 → 0.22 and the blooms are ~30% weaker.

**Settings ▸ Appearance ▸ Reduce texture** removes both entirely. Device-local (`lib/texture.ts`), because it describes _this screen_ — scanlines are far more noticeable on a low-DPR monitor than on a phone — so syncing it would push the wrong answer onto the other device. Applied from `main.tsx` **before React renders**: an effect runs after first paint and would flash the full texture every launch, and an inline script in `index.html` is blocked by `script-src 'self'` in production while working fine in dev.

Neither layer can affect text contrast — both sit at `z-index: 0` behind `#root`. `npm run check:contrast` still passes with the same worst pairing.

### 9.5 Smaller things in the same pass

- **Insights restructured.** Added spending **pace** (₱/day + straight-line projection, live month only), a **vs last month** panel with the three biggest category movers, and a **streak** panel. Envelope flows demoted to a `<details>` — it is reference data, not insight.
- **The ‹ arrow now stops** at the earliest month with entries (`earliestEntryAt`), instead of paging into empty months forever, which looked like data loss rather than the beginning of the ledger.
- **"Manila" → "PHT"** in History. The Philippines is one zone (UTC+8, no DST since 1978), so `Asia/Manila` is the IANA _identifier_, not a claim about where the user lives — Iloilo was always correct, but the label read wrong. `manilaHour` moved into `lib/dates.ts` and normalises the ICU `"24"` midnight case, which would have silently inverted the `hour < 18` banner gate.

### 9.6 Deploy order — this one bites

`pullStreakSaves` runs inside the sync loop's `Promise.all`, so a missing table would take down **the entire sync pass, including the outbox drain that pushes money**. Deploys are not transactional: `git push` ships the client via Netlify while migration 003 is applied by hand.

So the pull **swallows exactly one error** — "this table does not exist" (`PGRST205` / `42P01`) returns `[]`. Permission errors, network failures and everything else still throw, because those are real. Apply the migration when convenient; the app degrades to "no streak" until then instead of breaking. Migration 004 (§9.7) gets the same treatment through the shared `isMissingTable` helper.

### 9.7 Check-ins — opening the app counts too

**The rule shipped in 9.2 punished the wrong thing.** A day you spend nothing is a _good_ day, and requiring an entry meant frugality broke your chain. "Nothing to log" was indistinguishable from "didn't bother". So opening Tin now keeps a streak alive by itself.

**The hazard was raised before this was built, not discovered after.** A streak is only ever _visible_ from inside the app — so if opening it marks the day, every day you look is a day that just turned green, and the count degenerates into a mirror that reads 7/7 forever.

Three things keep that from happening, and they are the whole design:

1. **The two kinds of day stay distinct all the way to the screen.** `logged` means money was recorded; `checkedIn` means you only showed up. The strip draws an entry day solid and a check-in day as an **outline** — not a fainter solid, because at 10px "dimmer" and "different" are the same thing to the eye. The summary counts them separately: _"4 of 7 days with entries · 2 opened"_.
2. **They are mutually exclusive.** A day where you opened the app _and_ logged something is an entry day, full stop. Letting both be true would make the two counts overlap and stop summing to the week.
3. **`currentWithEntries`** rides alongside `current`, so Insights can say _"12 days running · 5 of those days have entries"_. A streak inflated by attendance can never pass itself off as a tracking record.

**`todayHasEntry` is kept apart from `todayCounted` for one concrete reason:** the evening nudge keys off entries. Keying it off the streak would have silently disabled the nudge the moment check-ins landed — the feature would have broken another feature on the way in, invisibly.

**Storage is local-first — the only thing outside the money path that is.** Opening the app is the event _most_ likely to happen with no connection, and an online-only write would mean a day you opened Tin in a dead spot never counted, failing invisibly on exactly the days this protects. So `recordCheckIn` writes to Dexie before anything touches the network, and the sync loop pushes unsynced days on the next pass.

This is **not** the outbox, and the distinction matters: the push is a blind idempotent upsert of a set of day keys, with no ordering requirement and nothing to reconcile. Every property that makes the outbox necessary for money is absent. Failure is free — the rows stay flagged and go again next pass.

Four details that would each have been a silent bug:

- **`add`, not `put`, in `recordCheckIn`.** Every app open calls it; `put` would reset an already-pushed day back to unsynced and re-upload it forever.
- **`synced` is `0 | 1`, not a boolean.** IndexedDB cannot index booleans — Dexie accepts `where('synced').equals(false)` and matches nothing, which would have left every check-in stuck as unpushed while looking like it worked.
- **The mirror merges, never replaces.** A day recorded offline exists locally and not yet on the server; clear-then-refill would delete precisely the rows not yet backed up. Safe because migration 004 grants no UPDATE and no DELETE, so the table is append-only on both sides.
- **`PulledCheckIn` is a separate type from `CheckInRow`.** `synced` is local bookkeeping the server neither has nor needs; casting pulled rows to the stored type was a lie the compiler could not catch.

Migration 004 is a **separate table from `streak_saves`**, not a `kind` column on it. Saves are capped at 3/month and that cap is a row count per month; folding unlimited check-ins into the same table would make every budget check filter on kind, and the first place that forgot would silently lock the user out of repairs for the month.


---

## 10. Phase 10 — the review surfaces (2026-07-24)

Six changes, from an audit of what a daily user can and cannot do with a ledger they have been keeping for months. The first two are not polish; they are promises the app had already made and was not keeping.

### 10.1 History stopped at 400 rows and never said so

`fetchEntries(limit = 400)`, called by History with no argument, no "load older", no marker. At three entries a day — and an income is three rows on its own — that is roughly four months before the ledger's past silently stops rendering. The rows were never lost: the mirror holds everything and the export reads all of it. But the screen whose entire job is to prove the ledger is honest was showing a truncated one.

Now `fetchEntryPage(limit)` returns `{ rows, hasMore }` and History pages in 200-row steps with an explicit end marker. **`hasMore` is exact, not inferred from `window.length === limit`** — whole-group expansion pulls in rows the window never reached, so the only truthful test is whether the table still holds something the page does not. An indexed `count()` is cheap enough to do properly.

### 10.2 Search and filter, over the WHOLE ledger

Text (notes, category names, envelope names, void reasons, amounts), category chips, kind chips. Three rules earned their own code:

1. **Filters run on groups, never on legs.** A 3-leg income matching on one leg must survive whole or its total is understated on screen — and "Fix" prefills from that total, so a half-matched group would put a wrong amount into a replacement entry. Same class of bug the whole-group window in `fetchEntries` exists to prevent.
2. **The group total is matched as well as each leg.** A ₱10,000 income is legs of 7,000 / 2,000 / 1,000; searching the amount you actually received would otherwise find nothing.
3. **A search reads the whole ledger, not the loaded page.** Filtering only what happens to be on screen would answer "3 results" to a question whose real answer is forty, and look identical to a complete search. `fetchAllEntriesNewestFirst` takes the same bet `prepareDrafts` already makes.

History also switched to `fetchCategoriesIncludingArchived`, which fixed a latent bug in passing: "delete" is `archived_at` here, so an entry on a retired category was rendering as the bare word "Expense".

### 10.3 Restore — the export finally has a second half

An export nothing can read back is a file, not a backup. `lib/restore.ts` + `db/restore.ts` + a two-stage Settings panel: picking a file only ever builds a **plan** and shows it; nothing is written until the count on the button is the count you agreed to.

**Entries only, by decision.** Envelopes and categories have a unique constraint on `(user_id, name)`, no DELETE policy, and a composite FK from entries that Postgres will not let you re-parent (§ db/config.ts). Writing to them during a restore turns one clear failure into a spread of half-applied config nobody can undo. So references are **remapped by name** onto whatever the account already has — which is exactly what works after a wipe, because `ensureSeeded` recreates Needs/Savings/Wants and the eight starter categories under fresh ids.

Five things this had to get right:

- **Refuse up front and name the gaps.** The outbox is strict FIFO, so one row the server rejects on a foreign key blocks every write behind it until someone finds the Discard button. A blocked plan writes nothing and lists the missing names.
- **An expense takes its envelope from the matched CATEGORY, not from the row.** Trusting the row's own envelope builds a `(category_id, envelope_id)` pair Postgres rejects — inside the outbox, after the UI already said it worked.
- **Categories match on BOTH names.** Uniqueness is `(user_id, envelope_id, name)`, so two envelopes may each hold a "Misc" and only the pair identifies one.
- **Voids replay as their own op, after the inserts, with the ORIGINAL timestamp.** A void only touches rows that exist and are not already voided, so replaying one before its group lands updates nothing and the entry comes back alive.
- **Archived categories are matched.** They are precisely what old entries point at; refusing them would block the history a restore exists to bring back.

Idempotent by construction — entry ids ride in the bundle, and both the mirror's `bulkAdd` and the server's upsert ignore ids they already hold. Verified live: exporting probe-b's own ledger and restoring it left the mirror at 64 rows and the balance at ₱0.00.

### 10.4 A forward-looking number on Home

Every figure on Home pointed backwards — what is in the tin, what left today. Neither answers the question the balance is actually being read for ten times a day, which is whether the next purchase is affordable. Each envelope card now carries `balance ÷ days left in the month`.

**Per envelope, and deliberately never summed.** An aggregate "safe to spend" would fold Savings into a spending allowance, and the one thing a 70/20/10 tracker must not do is quietly encourage raiding it. The app has no flag marking which envelope is savings — envelopes are user-named and user-shared (§0) — so it declines to guess.

The rate takes no "spent today" input and is **self-correcting**: the balance already reflects today's spending, so buying something now lowers the number on its own, with no before-and-after reconstruction that could drift. `floor`, never `round` — rounding up promises a peso the envelope cannot pay on the 31st.

The rate is now **hidden on any envelope nothing has ever been spent from**, which is the honest way to recognise Savings without the flag this section says the app cannot have. Category presence cannot stand in for it — the starter seed gives Savings a "Stash" category, so every envelope looks spendable from the schema alone. Spending history is the only signal that comes from what you actually do.

### 10.5 Note chips in AddSheet

The third feature squeezed out of the 90-day window the category ranking already fetches, after `frequentAmounts`. The note field is optional and hidden behind a disclosure, so the 2-tap path never passes through it and most entries carry no note — which is what left History's subtitles thin and gave 10.2's search little to match on.

**Global, not per category, and that is forced by the flow rather than chosen:** tapping a category _saves_ the entry, so at the moment the chips must be on screen the category is not yet known. Ranking them per category would mean showing them after the save, or breaking the two-tap path to insert a confirmation step.

### 10.6 Six months, as small multiples

A single month could be compared only against the one before it — "are my Wants creeping up since March" was unanswerable. The new panel is one **single-series row per envelope**, not one stacked column, and that is a colour-vision decision with a measurement behind it: running the envelope palette through a CVD check puts mint `#a8e6cf` and orchid `#ffb3d9` at **ΔE 3.2 under deuteranopia**, far under the 6–8 floor. Any chart asking a reader to tell two adjacent envelope segments apart by hue alone is unreadable for them. That is the §6 gap, now designed around instead of merely recorded: split into rows, no hue comparison is ever required, and identity comes from the row label.

**Each row is scaled to its own peak.** The honest cost is that heights mean nothing across rows, so the row's own figure is stated beside it and the hint says so outright. The gain is the only question the panel exists to answer — a within-row shape that a shared scale would flatten into an invisible line under the 70% envelope.

Two details found by looking at the rendered chart rather than at the code:

- **Every month gets a baseline whether or not it has a bar.** Without one, five quiet months and a busy one drew as a single block floating in empty space — which reads as data that failed to load, not as months you spent nothing in.
- **An in-progress month is marked in text (`Jul…`), never by a paler bar.** A partial column is the one value on the chart that is not comparable to its neighbours, and encoding that in opacity alone hides it from exactly the readers the small-multiples layout was chosen to serve.

`spendTrend` keeps spending on envelopes outside the list (archived ones) as an explicit `otherCentavos`, so the parts always sum to the total — the same discipline §9.1 imposed on "where it went".

### 10.7 What this pass did not do

- **Code-splitting the 698 KB bundle.** It is a PWA served from the service worker after the first visit; the split buys a Lighthouse number on a screen you see once.
- **App-icon badging as a push substitute.** It only updates while the app is running, which solves nothing the in-app evening banner does not already solve. Web Push remains out (§9.3).

## 11. The Home meter correction (2026-07-28)

### 11.1 The envelope meter was pointing the wrong way

The level meter under each card drew that envelope's balance **as a share of all money now**, against a tick at its 70/20/10 **plan share**. That is correct for exactly one instant — the moment income lands — and then inverts.

Walk a good month through it. ₱10,000 on the 1st; by the 20th you have spent ₱5,000 of Needs and ₱800 of Wants and left Savings alone:

| | Day 1 | Day 20 |
| --- | --- | --- |
| Needs | 70% vs plan 70% | 47.6% vs plan 70% — **under** |
| Savings | 20% vs plan 20% | 47.6% vs plan 20% — **way over** |
| Wants | 10% vs plan 10% | 4.8% vs plan 10% — **under** |

A textbook month rendered as three cards that all looked wrong, and it worsened as the month went on: the ideal end state — Needs empty, Wants empty, Savings intact — is the point of *maximum* divergence from the ticks.

**The implicit instruction was the damning part.** The only way to hold all three meters on their ticks is to draw the envelopes down proportionally, which means spending 20% of your savings every month. §10.4 spends three paragraphs refusing to build an aggregate that could invite raiding savings; the meter two components over was inviting it in pictures.

It was redundant besides. The 70/20/10 is enforced at income time by `splitByLargestRemainder`, so the card was showing a target the app had already hit on your behalf. The version of that comparison which carries information — actual **spending mix** vs plan — is `splitAdherence` on Insights, and a backward-looking verdict belongs there.

**What replaced it drains instead of filling.** Per envelope: `setAside = balance + expenses since the last top-up`, bar = `left / setAside`, tick = the fraction of the run still ahead on the calendar. The property that makes it work with no savings flag is that **above the line is good for every envelope**: Needs on pace sits on its tick, an untouched Savings stays pinned at 100% while the tick slides away beneath it, and a *raided* Savings falls toward the tick and reads as bad — correctly. One rule, one direction.

**The run is anchored to the last top-up, not to the 1st**, and the two halves have to agree or the meter contradicts itself. `setAside` counts expenses since the anchor and the tick's line starts at the anchor, so at the instant money lands both read 100% and drain together. A month-window `setAside` under a top-up-anchored tick would disagree the moment you were paid twice — spending before the second payday measured against a clock already reset.

The consequence is deliberate: **each allowance drop starts a fresh run**, so a top-up on the 28th after a blown month reads full again. For irregular income that is the correct mental model, and a tracker that keeps scolding you about money you no longer have is one you stop opening. The month-level verdict stays on Insights. Transfers deliberately do **not** re-anchor — otherwise covering an overdraft from Wants would hand Needs a fresh 100% meter, laundering a blown budget by shuffling.

`left + used = setAside` is an identity rather than a second measurement, so the two can never drift and the fill is provably within its own track for any non-negative balance. Nothing to clamp.

### 11.2 Decluttering the days-left line

Each card read `₱74.07/day for the 27 days left`. The clutter was **repetition, not wording**: `daysLeft` is one number computed once and passed to every card, so those five words rendered three times identically on the screen you read ten times a day.

It is now stated once, in the hero's metadata line — `across 3 envelopes · 27 days left` — and the cards carry only `₱181/day`.

The same pass took the cards from four rows to three by dropping what was already on them: `47% of your money` restated the bar, and the balance was already in the top-right corner. What remains is the size of the run and the rate it supports, neither of which is shown anywhere else. **No type got smaller** — the density came from deleting duplicated numbers.

Ahead-or-behind is a comparison of two positions on a bar, so the meter carries an `aria-label` stating the same reading in words. The §6 colour-vision audit is why this codebase does not leave that kind of thing as the only channel.

## 12. A logic audit of the whole app (2026-07-28)

A read of every module in `src/lib` and `src/db`, plus the money-critical paths in the screens, asking one question: does this make sense? The money core came through clean — largest-remainder split, integer centavos, append-only voids, the FIFO-with-stuck-head outbox, keyset pagination on `(updated_at, id)`, the server-clock cursor, restore's name-remapping, chunk boundaries falling between groups in both the importer and restore. What follows is everything that did not.

### 12.1 Check-ins only happened on a cold boot

`recordCheckIn` lived inside the once-per-session boot effect in `AppShell`, guarded by `bootedFor`. It ran once and never again.

Tin is an installed PWA. **A daily user's app is very often still resident from yesterday**, and the day they came back to it was never recorded. Nothing else re-anchored on a day rollover — `sync.ts` already listened for `visibilitychange`, but only to `kickSync()`.

So the streak quietly under-reported for exactly the people §9 built check-ins to protect, and the failure was invisible: a missing check-in looks identical to a day you did not open the app. The fix is `noteVisit()` — idempotent, ref-guarded against the Manila day — called on boot *and* on `visibilitychange`/`focus`. It also `bump()`s, which incidentally fixes the header date and the days-left figure going stale on a screen left open past midnight.

### 12.2 A pulled check-in never redrew anything

Every other pull in `runOnce` sets `changed`; `mirrorMergeCheckIns` did not. Another device's visit landed in the mirror and the strip kept showing pre-pull state until something unrelated bumped the ledger.

`mirrorMergeCheckIns` now returns whether any day was genuinely new. That **cannot be inferred from the write**: `bulkPut` rewrites the days this device already had (flipping `synced` to 1) on every single pass, so "we wrote something" is true always and means nothing. It reads the existing primary keys first and compares.

### 12.3 `repairDay` never checked the budget it was built around

`db/streak.ts` argues at length that saves are written online-only *because* the "3 per month" rule has to be checked against current server state at the instant of the write. It then checked `isOffline` and the repair window, and upserted. **The budget check did not exist.**

Enforcement was `findRepair` declining to show the prompt — a rule standing on the mirror, which is only as fresh as the last sync. A second device, or a tab open since morning, could believe a month had room it no longer had. 003 declines to enforce it in the database (a per-month row-count check needs a trigger, and the only account that could cheat is your own), so the client is genuinely the enforcement and had to actually do it. Now counted server-side, charged to the repaired **day's** month, with re-repairing an already-saved day still an idempotent no-op rather than an error.

### 12.4 `undoRepair` was built, granted a DELETE policy, and unreachable

Migration 003 gives `streak_saves` **the only DELETE policy in the schema** and justifies it outright: *"the user must be able to take one back if they spend it on the wrong day."* `undoRepair` implemented it. Nothing called it.

This is the §3.5 pattern exactly — promised in prose, plumbed at the database, never surfaced. It is now the Undo action on the repair toast, the same idiom AddSheet and the recurring catch-up already use, and the right moment for it: a save is scarce and the prompt is one tap, so a mis-tap gets noticed immediately.

### 12.5 `atRisk` was computed, documented, and never read

Six lines of comment explaining a flag no screen used. Check-ins are why: opening the app marks today counted, so by the time anything could read it, it was almost always false. It was **made obsolete by the 2026-07-24 check-in change rather than left unfinished** — and a field that cannot fire reads like a signal the UI forgot to use. Removed; `todayHasEntry` is the live version of that question and the evening nudge already keys off it.

### 12.6 Smaller things that were also wrong

- **`updateTemplate` dropped a guard `createTemplate` enforces.** An expense template with no category is not rejected by the schema (`category_id uuid`, nothing tying it to `kind`) — it is accepted and then silently stuck, with `runCatchUp` reporting "its category is gone" on every open, forever. Only the edit sheet's `ok` flag stood between the two. The guard is now on both paths; `kind` is passed in purely to check it, never written, because a template's kind is immutable.
- **`frequentNotes` claimed whitespace-insensitive folding it did not do.** `trim()` tidies the ends; `"Load  100"` and `"Load 100"` stayed two habits of one use each, so neither reached `MIN_USES` and the chip simply never appeared. Internal runs now collapse, the same way `normalizeDescription` already collapsed a merchant name.
- **`envelopeAllowances` had no callers.** A per-envelope mapper with two tests, standing between Home and the two functions it actually uses. Removed.
- **An unreachable branch in `findRepair`.** Reaching `back = n` requires every earlier day to have hit the loop's `continue` — which *is* the thing the inner "bridged" loop then tested. It could only confirm what getting there proved, for any window size. Replaced with the comment explaining the invariant.
- **`daysInMonth` and `pad2` existed twice**, in `lib/dates.ts` and `lib/recurring.ts`. Byte-identical, agreeing by coincidence. Month-length is precisely where a lone divergence would surface as rent posting on the wrong day of February and nowhere else. `daysInYearMonth` is now the shared primitive, with a test that holds the two modules in step.

## 13. Insights — the panel that was measuring the calendar (2026-07-28)

§12 asked "does this make sense?" of every module. This asks it of one screen. The month math came through clean — largest-remainder shares summing to exactly 10000 bp either way the tail is folded, transfers held out of the top line, gap months drawn as gaps rather than closed up, small multiples chosen over a stacked column on a measured colour-vision result. What follows is everything that did not.

### 13.1 "vs last month" was measuring the calendar, not the spending

The panel compared **a month in progress against a whole finished month**. On the 8th of July it put 8 days of July against 31 days of June and reported the shortfall as an improvement. Every early-month visit said you were doing brilliantly; the same panel said "about the same" on the 31st. **The sign of the number was decided by the date, not by anything the user did** — and the three category movers underneath it were drawn from the same mismatched pair, so the "biggest changes" were mostly just categories that had had more days to accumulate.

`entriesThroughDayOfMonth` trims the previous month to the current day-of-month, so both sides are the same length. The hint reads `Jun 1–8` rather than `June 2026`, because a label naming a whole month over numbers that cover eight days of it is the same bug in words.

Day-of-month rather than elapsed days, deliberately: it keeps both windows anchored to the same calendar dates. The cut is on the **Manila** day — cutting on the UTC date would include an evening the other side of the window does not have, which is the whole failure in miniature.

**The first version of this fix shipped its own version of the same bug, caught on review before merge.** The trim exists to make two spans equal, and there is a case where it cannot: the previous month may be **shorter than today's date**. On 29 March there is no 29th of February to trim to. The data was right — a shorter month simply contributes every day it had — but the panel labelled itself `Feb 1–29`, naming a day that does not exist, and printed "same stretch of each month" over a comparison of 29 days against 28. `comparableSpanDay` returns null once the previous month is exhausted, which is the same state a finished month is in: name it in full, make no like-for-like claim. It is a pure function with its own tests **because the original bug was in the wiring, where the suite could not see it** — the point §13.9 makes about this whole pass.

### 13.2 The projection ran from day one

One ₱3,000 purchase on the 2nd projected ₱46,500 for the month. Arithmetically exact, and worthless — a straight line multiplies whatever the first days held by up to 31, so the figure halves if you log nothing tomorrow. It sat in the same type and the same row as the real totals, which lent a coin flip the authority of a measurement.

`monthPace` now reports `isEarly` and the line says _"too early in the month to project a total"_ until day 5. Five is a judgement, not a derivation: roughly where one unusual day stops being able to move the projection by more than its own size, with ~85% of the month still left to act on the answer. A **complete** month is never early however short it is, because a finished month is not projected at all and disclaiming a number nobody is shown is just noise.

### 13.3 Month totals painted under the wrong month's name

`monthKey` updated on tap; `rows` updated when the Dexie read resolved. In between — every single ‹ tap — the screen showed the previous month's totals under the new month's heading. On a warm mirror that is a flicker; on a cold one it is a screenshot-able wrong answer, and nothing on screen admitted it.

The two are now one state value, so the mismatch is unrepresentable rather than merely unlikely. The cost is that paging shows the loading line for a beat instead of stale numbers, which is the correct trade: **this app's entire pitch is that its numbers are honest.**

### 13.4 The trend chart could draw every row under someone else's name

`TrendPanel` paired `envelopes[i]` against `perEnvelopeCentavos[i]`. Those two arrays are filled in by **different async effects** — the month effect sets `envelopes`, and a separate effect then issues six range reads before `trend` catches up. Add or archive an envelope and, for the length of those six reads, every row on the chart is labelled with the wrong envelope's name and colour. Nothing crashed and nothing looked broken.

`spendTrend` now carries its `envelopeIds` back out and labels resolve through them. An id with no envelope to name it is dropped rather than guessed at. The array is copied on the way out, because the caller's list is React state and must not be reachable for mutation through a derived result.

### 13.5 Two panels divided by different totals and neither said so

`splitAdherence` divides by spending in the **listed** envelopes; "Where it went" divides by **all** spending. Money charged to an archived envelope therefore appeared in one panel and silently vanished from the other's denominator, so the same month produced two disagreeing sets of percentages with nothing explaining the gap.

The trend panel already handles this exact case honestly, with its "Archived" row. The adherence panel now makes the same disclosure in one line. Same rule as `uncategorizedCentavos` in §9.1: **when a breakdown has a hole in it, name the hole.**

**The disclosure needed a guard of its own, also caught on review.** With no envelopes yet, `splitAdherence` returns `[]`, the panel body rendered nothing — and the new footnote then read *"…the mix above is of the rest"* over no mix at all. That state is reachable, not theoretical: sync pulls entries before it pulls envelopes, so a fresh device genuinely holds spending whose envelopes the mirror has not seen. The panel now has an explicit empty state and the footnote lives inside the non-empty branch. **§3.5 learned this once already** — `[]` is truthy, so `{list && …}` is not a loading guard — and it cost an evening then too.

### 13.6 Everything the trend chart knew was locked in a `title` attribute

Six months × five rows of per-month figures, every one of them reachable only by **hovering** — which never happens on a phone. On the device this app exists for, five of the six columns in every row were unreadable, and the panel's own `aria-label` summary was doing more for a screen-reader user than the visual chart did for a sighted one.

**The axis is now also the control.** Tapping a month moves every row to that month at once, which answers a better question than any single bar could — "what did March look like across the board?" The bars stay non-interactive: six months by five rows is thirty tap targets and thirty announced nodes, and each row already carries a full spoken summary.

Two details that would each have been a bug:

- **The selection is held as a month key, not an index.** Paging the picker slides the whole six-month window, so slot 2 stops meaning the month that was tapped — an index would silently re-point at a different month. A key that slides out of the window stops matching and the panel falls back to the latest; one still in it stays selected, which is what you want when stepping back a month to read the same column.
- **The selected column is marked on the track, not by recolouring the bar.** The bar's colour _is_ the envelope's identity. Borrowing it to also mean "selected" would put two meanings on one channel, on the chart that exists in small-multiples form precisely because §6 measured mint against orchid at ΔE 3.2 under deuteranopia.

### 13.7 Nowhere to go from a number

"Food, 32%, ₱4,200" and no path to **on what?** — which is the only question anyone asks next. Category rows and the movers list now hand History a starting filter through router state, and History opens with its filter panel expanded, because a filtered ledger whose filter is folded away looks like a screen that has lost entries.

Router **state** rather than a query string: a category id is a UUID that means nothing to a human, so it would make a URL nobody would ever want to share, and this app has no cross-device deep links to honour. The incoming value is validated rather than trusted — `location.state` holds whatever the last navigation put there, including a stale shape from an older deploy still sitting in a history entry.

### 13.8 Smaller things in the same pass

- **"Back to July 2026".** Paging back six months took six taps to undo, and › disables itself the moment you arrive, so nothing on screen said you had ever moved.
- **The composition bar told a screen reader nothing.** Its label was _"Spending split across 8 groups"_ — naming the chart without conveying one number from it. It now reads the split.
- **A month where every category is uncategorized** no longer prints "Tap a category to see those entries" over a list of rows that do nothing.

### 13.9 Still open

- **`UNCATEGORIZED` and `OTHER` begin with a literal NUL byte**, not the space the neighbouring `' total'` and `' archived'` keys use. Harmless at runtime — the values are sentinels, never persisted — but it makes git treat `lib/analytics.ts` as **binary**, so `git diff` on the file that holds every number on this screen shows nothing at all. Left as a decision rather than folded into an unrelated commit.
- **No render tests.** 436 unit tests cover the math; nothing covers the screen. Every finding above except 13.1 and 13.2 was invisible to the suite because it lived in the wiring, not in the functions.
- **Not built, considered:** biggest single expense of the month, and a weekday spending pattern. Both computable from data already fetched. Both new scope rather than corrections, which is why they are here and not above.

## 14. The conductors — testing the code that sequences the tested parts (2026-07-28)

§12 asked "does this make sense?" of every module. §13 asked it of one screen. This pass asked a narrower question with a sharper edge: **which code decides that money moves, and has no test at all?**

Three answers, all of them coordination code — the layer §13.9 had already named as the blind spot. The pieces underneath them were well covered (`drainOutbox` FIFO, cursor advancement, the mirror merges, the scheduling maths in `lib/recurring`); the code that *sequences* those pieces was not covered anywhere.

### 14.1 A `.test.tsx` file would not have run

`vite.config.ts` included `src/**/*.test.ts`. A render test — the thing §13.9 asks for by name — is a `.tsx` file, so it would have been **silently not collected**: never executed, never reported, suite still green. Anyone acting on §13.9 would have written passing-looking tests that never ran once.

The glob now takes `{ts,tsx}`. The default environment stays `node` so the 439 existing tests keep their ~6 s; a render test opts into jsdom per file with `// @vitest-environment jsdom`.

### 14.2 Recurring catch-up could invent money when an envelope was added

The module header states the invariant outright: *"Random IDs here would double-post rent; determinism IS the correctness."* The posting ids are UUIDv5 of `(template, due date, leg index)`, and the mirror insert ignores duplicate ids — so re-running a due date was documented as harmless, and the failed-cursor-write path leans on that: *"the next open re-posts into a no-op."*

**It is a no-op only while the envelope set is frozen.** The leg index runs over the *current* envelopes. Add a fourth envelope and the next catch-up mints `:3` — an id that has never existed — and it lands **alongside** the three original legs, which the dedupe correctly leaves alone. A ₱1,000 allowance became ₱1,100. The group's legs no longer sum to the template amount, and nothing anywhere reported an error.

Reachable two ways, neither exotic: the cursor write is *allowed* to fail (the code says so, and treats it as safe), and a second device catches up the same date against whatever envelope set its mirror happens to hold.

The same defect wearing a different hat: a posting the user **voided** was dedupable row by row, so an added envelope minted a leg index that had never been voided — and part of a deleted month came back alive.

The fix is to stop identifying a posting by its rows. `group_id` is already UUIDv5 of `(template, due)` alone — the stable identity of "this month's posting", independent of how many legs it happened to have. `postedGroupExists` checks it before posting, and the cursor still advances past an already-posted date so it is not retried forever. **Voided rows count**: a group the user voided is still a group that happened, and skipping it is what stops the resurrection.

`supabase/tests/recurring-integration.test.ts` claims to cover *"posts a due template once, idempotently"* — but it needs live credentials and self-skips, so it had never run in CI. A skipped test reads exactly like a covered path.

### 14.3 A kick that arrived in the teardown window was dropped

`syncNow` is single-flight with a dirty flag. `while (dirty)` reading false and the `.finally` clearing `inFlight` are two separate microtasks, and a `kickSync` landing between them set `dirty` with no loop left to read it. The write stayed local until an unrelated trigger — a tab focus, a connectivity change, another write — happened along.

Narrow, and self-healing rather than lossy, because this app is local-first and the outbox row is already durable. Fixed anyway: `dirty` is false at that point in every other case, so re-checking it in the `.finally` can only fire for exactly that window.

### 14.4 What the tests now hold

`src/db/sync-loop.test.ts` (10) and `src/db/recurring-catchup.test.ts` (5), against a real Dexie on `fake-indexeddb` with only the network stubbed — 439 → 454.

The sync loop came through **clean**: the offline short-circuit, cursor advancement on the server clock, single-flight coalescing, stuck-outbox reporting and recovery, and the §12.2 discipline of announcing a pass if and only if something genuinely changed. That is a result, not a blank — those were unverified assertions before and are now pinned.

### 14.5 Still open

- **Still no render tests.** 14.1 removed the trap in the way; it did not write them. Home, Insights and History remain the screens where a wrong number is worst.
- **The `dirty` teardown window has no test.** The race is two adjacent microtasks deep inside `syncNow` and is not reachable deterministically without a hook in production code. The fix is defensive and provably inert otherwise, which is the trade taken.
- **`AppShell.tsx` is still untested** — 7 effects, the boot sequence, and the check-in wake path that §12.1 already caught once.

---

## 15. Money type — the feature that never completed a round trip (2026-08-04)

Reported as three separate complaints: cash spending shows up as **Online**, changing the split in Settings **does nothing**, and the two figures together come to **more than the balance**. They are one broken data path and three independent bugs sitting on top of it, so the symptoms compounded and none of them pointed at the cause.

Nothing here was caught by the suite. 475 tests passed, `tsc` was clean, `eslint` was clean — and two of the tests asserted the broken behaviour as correct.

### 15.1 The tag was erased by the next sync pass

`money_type` was collected by the add sheet, written to the row, stored in Dexie, and queued to the outbox. Every one of those worked. Then:

- `ENTRY_COLUMNS` in `db/remote.ts` did not list `money_type`, so the pull never asked for it, and `pullEntriesPage` rebuilt each row field by field without it.
- `mirrorApplyPulledEntries` applies pulled rows with `bulkPut`, which **replaces the whole record**.
- `lib/sync-rules.ts` re-pulls a 60-second overlap window on purpose.

So a row tagged Cash was overwritten by an untagged copy of itself roughly one sync pass after it was saved. **The tag survived about a minute**, and the failure was silent in both directions — no error, no warning, and History's badge simply stopped rendering.

The push half was already broken and already known: `pushInsertEntries` catches Postgres 42703 and retries with `money_type` stripped. That fallback was added in `0eb8ae1` to stop the outbox jamming, and it worked — at the cost of discarding the field on every write, permanently, with a passing test pinning the behaviour.

**The column does not exist.** `money_type` appears in `001_core.sql`, but `git log -S` shows it was edited into that file in `0eb8ae1` — long after 001 had been applied. A migration already run is a historical record, not a spec: editing it changes what a fresh database gets and nothing about an existing one. `005_money_type.sql` adds it for real, idempotently, on both `entries` and `recurring_templates`.

Both the entry pull and the template fetch now tolerate the column being missing, the same way the habit-table pulls do and for the same reason: `git push` ships the client via Netlify while migrations are applied by hand, and a hard failure in that window would take the **outbox drain** down with it. Breaking money sync to protect a label would be the wrong trade.

The mirror now distinguishes `money_type: null` (the server holds the row and says untagged — overwrite) from the field being **absent** (the column was not selected — keep what is here). That distinction is what makes the deploy window safe rather than merely survivable.

### 15.2 Untagged money was being filed under Online

`summarizeMoneyTypeTotals` had two branches and both invented an answer:

- **Nothing tagged** → the entire ledger was reported as `online`, `reallife: 0`. Combined with §15.1 this is the whole of the "my cash is showing as online" report: after the first sync everything was untagged, so everything was Online.
- **Anything tagged** → untagged rows were dropped from both buckets silently. The two figures then could not add up to the balance, and nothing said so.

There is no honest two-bucket answer, because *untagged* is a real and permanent third state — every entry written before the feature existed is untagged and there is no backfill that isn't a guess. So it is now a **bucket you can see**: `online + reallife + untagged` is exactly the live balance, as an invariant with a test on it. Home draws the third line only when it is non-zero, so a fully-tagged ledger reads as the two lines it should.

### 15.3 The totals counted money that had been taken back

`summarizeMoneyTypeTotals` never filtered `voided_at`, and `fetchAllEntriesNewestFirst` returns voided rows. So **every entry the user had ever undone was still propping up the figures** — the single biggest reason they exceeded the balance.

This file was the *only* aggregator in `src/lib/` missing that filter. `balances.ts`, `allowance.ts`, `envelope-month.ts`, `logging-streak.ts`, `category-rank.ts` and both `frequent-*.ts` all had it. The rule was established, written down, and applied everywhere except here.

### 15.4 A transfer credited a bucket with nothing debiting it

`addTransfer` writes two legs. Only the **positive** one carried `money_type`. A transfer tagged Online therefore added `+₱500` to Online with no matching `−₱500` anywhere, because the untagged negative leg was being discarded by §15.2. Every transfer pushed the totals further past the balance.

Both legs now carry the same type and cancel. A transfer moves money between *envelopes*, not between GCash and your pocket — its net effect on either bucket is zero, and the two legs are what express that. The picker says so in the sheet, so the field stops reading as "which way is this money going?".

### 15.5 Settings wrote to a key nothing read

`Home.tsx` called `summarizeMoneyTypeSummaryItems(..., useSnapshot: false)` at all three call sites. The saved targets were written, read back into the Settings inputs, and **ignored by the only screen that displays them**.

Worse, the `tin-money-type-updated` listener recomputed the summary from an **empty row array**, so tapping Save reset the Home card to ₱0.00 / ₱0.00 until an unrelated refetch. The one action whose entire purpose was to update Home was the action that blanked it.

The two inputs were collapsed into one derived state slot, and that collapse is what broke both halves. They move on completely different triggers — ledger totals when entries change, targets when Settings is saved — so they are separate state now, combined in a `useMemo`. The listener re-reads only the targets.

A saved target is labelled **"target"** rather than "available", because a number the user asserted and a number the ledger computed should not be printed in the same weight and position. When targets pull the sum away from the balance, the card says so and links to Settings instead of quietly showing a total that contradicts the hero above it.

`untagged` is deliberately **not** snapshot-able: it is a residual, not a goal, and letting it be edited would let the one number that proves the other two add up be adjusted into agreement.

### 15.6 The Settings input showed one number and saved another

`updateValue` clamped the parsed value to the available balance but wrote the **unclamped** text to the field. Typing ₱50,000 against a ₱3,000 balance left the input reading `50,000` and stored `3,000`.

The panel also took its per-bucket figures from the entry rows and its total from `fetchBalances()` — two ledgers that disagreed by construction, since one counted voided rows and the other did not. "You are ₱X over your split target" was arithmetic across both. Every figure in the panel now comes from one call.

### 15.7 Three write paths could not record a money type at all

Opening balances hardcoded `money_type: null`; recurring catch-up and statement import never set it. Every entry they produced was untagged, permanently.

Opening balances matter most here — they are *by definition* everything you already had, so on a young ledger they **are** the balance. Leaving them unclassified meant the card could never account for most of the tin.

- **Opening balances** and **import** take an optional per-batch type. A statement is one account's history, so the importer asks once, at review, where the user can see what they pasted.
- **Recurring templates** store it on the template, because a catch-up runs with nobody there to ask. Migration 005 adds the column; the template list shows "no money type" on a row that lacks one, so an untagged template stops silently feeding the untagged line every month.

All three are **optional**, and that is the point: forcing a guess writes a wrong tag rather than an absent one. Money genuinely split across GCash and a wallet should land untagged and be visible as such.

### 15.8 Smaller things in the same pass

- **Three save controls looked live and did nothing.** The expense category chips, the income button and the transfer button all omitted `moneyTypeReady` from `disabled` while their handlers guarded on it. The second tap of the two-tap path gave the pressed animation and saved nothing.
- **"Fix" silently re-filed an entry.** It carried the amount, note and date but dropped the money type, and the sheet requires an answer — so correcting a typo in a cash expense became an opportunity to file it as online. `AddPrefill` now carries it, via a `groupMoneyType` helper that refuses to guess when a group's legs disagree.
- **History mixed filtered and unfiltered figures in one sentence.** The entry count and spend total described the filter; the money-type chips were computed over the whole ledger. Filter to Food and it read "3 entries · Online ₱42,000".
- **The card said "Real life" where every control said "Cash".** `getMoneyTypeLabel` and the summary item's `label` field had drifted apart. One function names all three buckets now.
- **Logout left the user's balances on the device.** `wipeLocalCaches` cleared Dexie and Cache Storage but never touched localStorage, so `tin.money-type-snapshot` — peso figures the user typed about their own accounts — greeted the next person on a shared laptop. Exactly the failure §6.6 exists to prevent, one storage API over. `lib/local-keys.ts` now holds every key with an explicit user-scoped list; `tin.texture` stays out of it on purpose, per `lib/texture.ts`.
- **`src/lib/analytics.ts` held two raw NUL bytes.** Deliberate sentinels (`'\0uncategorized'`), but written as literal bytes rather than escapes — which made ripgrep classify the file as binary and **skip it in every content search**. Now `\0` escapes: same string, greppable file.
- **A 0-byte file with a shell fragment for a name was sitting in the repo root**, from a botched command. Deleted.

### 15.9 Two tests were pinning the bugs in place

`money-type.test.ts` asserted that untagged rows are dropped from the totals, and that the snapshot is ignored by the Home summary. Both were the defect, written down as expected output — which is why the suite stayed green through all of it.

Rewritten, and the round trip is now covered where it was not: a pull that omits `money_type` leaves the local tag alone, an explicit `null` clears it, the pull falls back to the pre-005 column list instead of failing the sync, both transfer legs carry the type, voided rows are excluded, and the three buckets sum to the live balance. 475 → 496.

### 15.10 Still open

- **No render test for the money card.** The three-bucket arithmetic and the snapshot precedence are unit-tested; that Home *draws* them, and that the drift line appears when targets disagree with the balance, are not. Same gap §14.5 names for Home generally.
- **No backfill for untagged history.** By design — the app cannot know how a coffee in March was paid — but it means the untagged line will be large for existing users and there is no bulk-tagging tool. A "tag these N entries" flow in History is the obvious next step and is not built.
- **Migration 005 has to be applied by hand.** The client tolerates its absence on both the entry pull and the template fetch, so nothing breaks in the window; but until it is run, money types still do not persist to the server. **This is the deploy-order bite §9.6 warned about, and it is the one step that cannot be skipped.** *(Applied 2026-08-05 — see §17.8.)*

---

## 16. Settings, reorganised — and the one door that deletes (2026-08-04)

Two things asked for together, and they turned out to belong together: the screen needed a shape before it could safely hold something irreversible.

### 16.1 Nine cards in a flat column is not a layout

Settings had accreted one card per feature since Phase 3 — account, stuck writes, export, restore, MFA, money targets, appearance, and four navigation cards — all rendered at identical visual weight in a single column. Nothing was *wrong*; it was just unnavigable. "Change the split", "download a backup" and "turn off the texture" arrived as the same box, so finding anything meant reading every heading on the way past.

Now five labelled bands, ordered by how often you come here for them, with the irreversible one last: **Setup** (the four destinations, tiled) → **Money on hand** → **Your data** (export + restore) → **Appearance** → **Account** (2FA + log out) → **Danger zone**.

Smaller fixes in the same pass:

- **The nav cards are now cards, not cards containing a link.** Each was a ~100 px box that looked pressable with a ~20 px "Manage envelopes →" text link inside it. On a phone that is a miss waiting to happen, and it is the most common reason to open this screen. The whole card is the target, with `card-interactive` for the hover it already had a style for.
- **The Account card became a subtitle.** A whole bordered box held one line — the signed-in email. It answers "whose settings are these", which is worth a line under the `h1` and not a card in the middle.
- **Log out stopped being an orphan.** It was a bare `mt-auto` button floating below everything with no explanation; it now sits in the Account group with a sentence about the local wipe it performs (6.6), which is the part a user would want to know.
- **Heading levels were wrong and one was an outlier.** Every card used `h2`, so the new group headings had nowhere to sit — cards are `h3` now, giving `h1 → group h2 → card h3`. `MfaSection` had been styled `h2.font-medium` since Phase 7 while every other card used the display face; it matches now.
- The **split playground** was buried in an "Extras" card as a sentence. It is a destination, so it is a nav card like the others.

### 16.2 A reset needs a door, not a delete policy

"Clear everything and start over like a new account" cannot be done from the client as the schema stands, and that is deliberate: **§1 rule 3** means `entries`, `envelopes`, `categories` and `profiles` have no DELETE policy at all. The obvious move — add them — would have been a real mistake. It hands out *per-row* deletion in order to support one *all-or-nothing* operation, and every ledger guarantee in the app would then rest on the client choosing not to use it. An XSS, a bad refactor or a stray `.delete().eq('id', …)` would be enough.

`006_account_reset.sql` adds a `security definer` function instead, and the tables stay exactly as undeletable as they were:

- **It takes no arguments.** No id, no table, no filter — it scopes everything to `auth.uid()` itself. The only thing a caller can express is "delete all of *my* data", so the only privilege escalation available is against yourself.
- **`set search_path = ''`**, mandatory for a definer function: without it a caller could prepend a schema of their own and have `entries` resolve to a table they control.
- **One plpgsql call is one transaction.** A half-reset account — entries gone, envelopes left — would be worse than either outcome.
- **It returns row counts.** A reset that silently deleted nothing must not read as a success, so the UI reports what the server said it did rather than asserting that something happened. An all-zero result says so in plain words.
- **`auth.users` is untouched.** Login, password and any enrolled MFA factor survive. This is "empty the tin", not "close the account" — the latter needs the `service_role` key, which by §3 never reaches the client.

The RLS probe now covers it, and this is the block that matters most in that file: everywhere else the *database* enforces isolation, here the *function* does. B resets B; A's entry, envelope and check-ins must still be there afterwards; anon cannot call it; and `entries` must still refuse an ordinary DELETE.

### 16.3 Three stores, or it is not a reset

Server rows are only a third of it. Miss either of the others and the app repopulates itself from the survivor: a stale Dexie mirror re-renders the old balances, an uncleared delta cursor tells the next pull it is already up to date, and a leftover `tin.money-type-snapshot` puts the previous figures back on Home.

- **`clearLocalDataForReset` is not `wipeLocalDb`**, and the difference is the whole reason it exists. The logout wipe *deletes the database and re-arms the gate*, which leaves `localDb()` an unresolved promise — correct when the next thing on screen is the login form, fatal here, where the user stays signed in and every read in the app would simply hang. So the tables are cleared in place, in one transaction, and the owner row is written back.
- **The outbox goes too**, and that is the point rather than a casualty: every queued op is an insert or a void against a ledger the server no longer has. Pushing them afterwards would put back exactly the money the reset removed. The panel says so first if the queue is non-empty.
- **The sync loop is suspended across the whole operation.** `stopSync` was the wrong tool — it drops the listeners and forgets `onApplied`, and only `startSync` restores them, which lives in AppShell's once-per-session boot effect and will not run again for a session that never ended. A reset that called it would leave the app signed in with a permanently dead sync loop. `suspendSync`/`resumeSync` hold the loop still without tearing its wiring down.
- **Server first, local second.** If the local clear went first and the RPC then failed, the user would be looking at an empty app and an error and could reasonably conclude it had worked — while every peso was still on the server. Server-first inverts that: a failed RPC leaves the screen exactly as it was, which is the truth.
- **Re-seed, then pull, then return.** `ensureSeeded` puts the starter envelopes back (a clean slate with no envelopes is a broken app, not a fresh one), and the sync is *awaited* — returning early would hand the caller a "done" to navigate on while Home still had nothing to draw.

### 16.4 The ceremony is the feature

This is the only control in Tin that destroys money history, and there is no undo anywhere in the stack. The panel is collapsed behind a button, itemises the real counts (read from the mirror, so no network round trip in front of the one screen that must be clear), states explicitly what survives, and is gated on typing `RESET` — exact case, because matching case-insensitively would let autocorrect's "Reset" through and the entire value of the gate is that it cannot be satisfied accidentally.

The part that matters most is the **backup button inside the flow**. "Export first" as a sentence is advice; a button that downloads the JSON without leaving the panel is the difference between a recoverable mistake and a permanent one. It is weighted by how bad the situation is — never having exported reads differently from having exported last week, and a warning shown at the same weight for both teaches people to ignore it.

### 16.5 Still open

- **No render test for the danger panel.** `isResetConfirmed` and `describeResetSummary` are unit-tested and the local clear is covered against a fake IndexedDB, but that the button is *disabled* until the phrase is typed is one JSX expression with nothing asserting it. Same gap §14.5 and §15.10 name — the project still has no component-render harness.
- **The server half is only covered by the RLS probe**, which needs live credentials and is run by hand. There is no test that `reset_account` deletes in an FK-safe order; a future table with a `RESTRICT` reference to `entries` would break it at runtime, not at CI.
- **Migration 006 has to be applied by hand**, like 005. The client turns the missing-function error into a plain sentence ("this app is newer than its database") and deletes nothing, so the window is safe — but the danger zone does not work until it is run. *(Applied 2026-08-05 — see §17.8.)*
- **A reset does not propagate to other devices, and cannot with this sync design.** The delta pull carries changes forward by `updated_at`; a deleted row has no `updated_at` to carry, so a second device keeps rendering the old ledger indefinitely and will push any queued write back into the freshly-reset account. Tombstones would fix it properly and are wildly disproportionate here — the whole point of §6's "dumb queue instead of a CRDT research project". The panel tells the user to log out and back in on other devices, which wipes those mirrors wholesale (6.6). **This is an instruction, not a guarantee**, and it is the sharpest edge left on the feature.

---

## 17. Four quality-of-life fixes, and the app's first render tests (2026-08-05)

Four requests, three of them defects wearing polish clothes. The common thread is that every one of them was invisible from a desk: a caret you can only move with a finger, a back button a laptop does not have, a card that only overstays if you live with it for a week.

### 17.1 The keypad ignored the caret it invited you to move

The amount field carries `inputMode="none"` on a coarse pointer — that is the whole reason the custom pad exists (see the header of `lib/keypad.ts`: the OS keyboard covers the category grid the next tap needs). But it is still a real `<input>`, focused, drawing a caret, and happy to move that caret wherever you tap.

`applyKeypadKey` appended and backspaced **at the end of the string, unconditionally**. So on a phone — where tapping into the number is the *only* way to reach a digit inside it, there being no keyboard — the field accepted your tap, showed the caret where you put it, and then typed somewhere else. Fixing the 2 in ₱1,250 meant deleting four digits and retyping them.

`applyKeypadKeyAt(current, key, start, end)` returns `{ value, caret }`: insert at the caret, backspace the character before it, replace a selection whole. `AddSheet` restores the caret in a `useLayoutEffect` (before paint, so it never flickers to the end and back) and re-focuses the field, which is what brings the caret back after a pad key moved focus to a button. The pad's keys also `preventDefault` on mousedown so they do not steal focus in the first place.

The old append-at-the-end export survives as a one-line wrapper, and Settings' money targets keep using it deliberately: those inputs render **comma-grouped** text, so a caret offset in what is displayed does not address the same character in the digits underneath. Appending is the only honest thing to do there.

Three more things in the same field:

- **Hold ⌫ to clear.** Clearing a mistyped amount was up to twelve taps, on the control the entire 2-tap path runs through. A long press rather than a thirteenth key — the three-column grid is what makes the pad thumb-shaped, and the gesture belongs on the key that already means "undo what I typed". The press that follows the hold is swallowed, or letting go would immediately backspace the field it just emptied.
- **Typed and pasted text is filtered on the way in.** `₱1,250.00` pasted out of a chat, or a stray letter from a hardware keyboard, used to sit in the field with the save button silently dead and one line of red as the only explanation. `sanitizeTypedAmount` drops what cannot belong and carries the caret to wherever its character ended up — and it only repositions the caret when something was actually dropped, so ordinary typing is untouched.
- **The hint line says the two things you cannot see.** It reads "hold delete", not "hold ⌫": neither pixel face covers U+232B, so it painted as a tofu box in the browser — and the key is drawn as a *wedge* anyway, so naming a character that appears nowhere on the pad pointed at nothing.

**A fuzz test found a real bug in the fix.** 4,000 random key/caret pairs asserting the field stays parseable turned up `53630167534607` — fourteen integer digits. Backspacing the decimal point out of `12345678901.23` **merges the centavos into the pesos**, which is a *deletion* that overflows the twelve-digit cap. Not the shape of overflow anyone thinks to guard. Every path now funnels through one `settle()` that collapses leading zeros and then bounds-checks, insertions and deletions alike. It takes a ₱10-billion ledger to reach; "the pad cannot strand the field in an unsaveable state" is either true or it is not.

### 17.2 Back navigated away from a half-typed entry

On Android — and on an iOS swipe — back is what "cancel" means. With the add sheet open over Home it did the one thing it must not: left the screen, threw out the amount, and (the sheet living in `AppShell` rather than a route) often left it open on top of wherever you landed.

`useBackDismiss` pushes one dummy history entry at the same URL when a sheet opens and pops it again when the sheet closes any other way. It lives in `BottomSheet`, so **all five sheets** in the app inherit it — add, opening balances, envelope editor, category editor, recurring template — rather than the one that was complained about.

Two rules keep it from fighting react-router:

- **The existing `history.state` is spread through the push.** `pushState` replaces state wholesale, and nulling react-router's `idx`/`key` out from under it on every sheet open is not a trade worth making for a dismissal. `AppShell`'s PWA-shortcut cleanup was passing a literal `null` for the same reason and now carries state forward too — it runs *after* the sheet's push, child effects going first, so it was wiping the marker on exactly the deep link that opens a sheet.
- **Back is only consumed when the state landed on is no longer ours.** Navigate with a sheet open and its entry ends up buried; coming back *to* it must read as "here is the sheet again", and the close that follows must not silently steal a real navigation.

The sheet id is held in a ref rather than minted per effect run, which is what makes StrictMode's double-invoke benign: with a fresh id each time, the cleanup's `back()` and the second run's `push()` left the sheet watching for an id no longer on the stack, and back navigated away exactly as before — in development only, which is the worst place for a bug to hide.

### 17.3 "START FROM THE TRUTH" outstayed its welcome

This card has now been wrong in **both** directions, and the second one is instructive.

Gated on `hasAnyEntries` it was a one-shot door: log a coffee on day one and the only entry point to the opening-balances sheet was gone forever, with no path to it from Settings or History. The fix was to gate it on `hasOpeningBalances` instead — correct, and it made the card **permanent**. Decline it and a prompt headed "START FROM THE TRUTH" sat on the screen you read ten times a day, for as long as you kept declining, telling you to begin something your envelopes plainly already held.

It is now an offer with a shelf life: it retires after entries on **three distinct Manila days**. Days, not entries — a first session easily produces six entries and is still the session where "I should tell it what's in my GCash" has not occurred to you yet. Three days means the app has survived being closed and reopened twice. There is also a plain **"Skip"**, which outranks the window, because an answer that expires is not an answer.

**The expiry is only safe because of the other half.** Settings → Setup now holds a permanent door, so nothing becomes unreachable this time. That door needed a warning the old card never did: a second save **adds** a second adjustment group rather than replacing the first, so the balances double. The card says so when the group already exists, and the sheet repeats it above the inputs.

`OpeningBalancesSheet` moved to `features/entries/` in the process — it is a ledger write, and with two callers in different features, leaving it under `home/` meant Settings importing across a feature boundary.

### 17.4 "Other", and where a new category comes from

The starter set is seven categories; real spending is not. Anything outside it went into the note field — which lives behind a disclosure the 2-tap path never opens — filed under whichever chip was closest, and Insights then reported that chip.

A dashed **`+ Other`** chip closes the grid. Name the thing, pick the envelope it comes out of, save: it becomes a **real category**, so it is a one-tap chip from the next entry onward and appears under its own name in the breakdown. Same thing Settings' category manager does, reached from the moment you actually need it.

The chip itself is deliberately **not** disabled by the save guards the category chips carry — it opens a panel, it does not save — while its own button carries all of them (§15.8 is about save controls that look live and are not).

Three collisions, each with one right answer:

- **The name already exists here** → file under it, no write. Matched case-insensitively in the loaded list, because the unique constraint is case-*sensitive* and without this "food" under Needs becomes a second chip beside "Food". This path also works offline, since no category has to be created.
- **It exists but is archived** → the mirror hides it, so the insert hits `23505`; `ensureCategory` adopts the row and un-archives it. Naming a category again is the clearest possible statement that you want it back, and the alternative is a name you can neither use nor create.
- **You are offline** → said up front, in the panel, rather than after the tap. Entries are outbox-backed and save in a dead spot; `db/config.ts` writes go straight to Supabase and cannot.

### 17.5 The render harness the last three sections kept asking for

§14.5, §15.10 and §16.5 all close with the same admission: no component-render test exists, so anything only true in a DOM is unverified. Two of this pass's four items are *entirely* DOM behaviour — a caret on a live input, a history entry and a popstate — so the gap stopped being theoretical.

`vite.config.ts` already documented the opt-in (`// @vitest-environment jsdom`, and `.tsx` in the include glob or the file is silently not collected). Two files now use it: `BottomSheet.test.tsx` covers the back-button contract in all four of its states, and `AddSheet.test.tsx` renders the real sheet against stubbed db modules and drives the pad. 512 → **544 tests.** *(531 after §17.9 deleted the pad and its suite.)*

One trap worth writing down: `useCoarsePointer` reads `window.matchMedia`, which jsdom does not implement at all. The hook's optional call means it returns `false` — so without a stub the keypad is **never rendered** and every test of it passes vacuously.

Verified in a real browser as well (Edge at a 390 px touch viewport, against a throwaway route that seeded the Dexie mirror): typing `1250`, tapping the caret to position 2 and pressing 9 gives `12950`; a 700 ms hold on ⌫ empties the field; the Other panel lays out inside the sheet; console clean throughout.

### 17.6 Two more, and the bug that only existed in development

Added in the same pass, after the four above.

**"Fix" was still making you re-pick the category.** It carried the amount, note, date and money type; the one field it dropped is the one that *commits* the entry, since tapping a category is what saves an expense. So a correction reopened complete except for the control you have to find — in a grid ranked by use, where the category you want is not necessarily near the front.

The sheet now surfaces it as a single `Save ₱200.00 to Transport` button above the grid, with the chip itself marked (`aria-pressed`, full-strength border) so scrolling still shows where the entry came from. The grid is deliberately **not** reordered: it is ranked by use, and quietly moving a chip to the front would make every other chip's position depend on how you happened to open the sheet.

The category is looked up in the **live** list, not trusted from the prefill, so an archived one yields nothing and the grid behaves exactly as before. Offering to re-file into a retired category would be the one place in the app that puts an archived category back in front of you.

**The drag handle finally does something.** It has been drawn since Phase 3 as a touch affordance for a gesture that was never wired up — which is worse than drawing nothing, because it teaches you that pulling down does not work here.

The handle only, not the whole panel: the sheet scrolls and the add sheet is taller than a phone, so a drag starting anywhere in the body would compete with the scroll on every touch. The usual escape hatch (allow it only at `scrollTop === 0`) still fights the keypad and the category grid, both of which are twelve-plus tap targets you swipe a thumb across. The grab area is the full sheet width and ~28 px tall — the 4 px bar is the sign, the strip is the target — and `touch-none` on it is load-bearing: without it the browser claims the vertical drag for scrolling and the moves stop arriving the moment the finger travels far enough to mean anything.

Dismiss at 88 px, or on a flick (>24 px above 0.55 px/ms) so a decisive pull does not have to be a long one. Below both it snaps back, because the failure that matters is a thumb brushing the handle on the way to the mode tabs and throwing away a half-typed entry. The transform is written straight to the node during the drag rather than held in state — a React render per frame to move one element is what makes a cheap phone feel like a cheap phone.

#### The StrictMode traversal race

Driving the sheet in a real browser found §17.2 closing itself **the instant it opened**, in development only. It is worth writing down because every test was green and the production build was fine.

React StrictMode runs each effect twice in development — run, clean up, run. The first version of `useBackDismiss` pushed an entry on each run and called `history.back()` in the cleanup between them. **Chrome resolves a traversal against the entry it was called from**, not the one current when the traversal task actually runs: so the `back()` issued while sitting on entry A targeted the entry *beneath* A, run 2 then pushed B on top, and the traversal landed two entries down on something carrying no marker — which `onPop` read, correctly by its own rules, as a dismissal.

**jsdom resolves the delta the other way**, against the current entry. So the jsdom tests modelled the sequence faithfully and still passed. Two engines, two defensible readings of the same spec, and the test environment happened to pick the one where the bug does not appear.

The fix does not reason about the delta at all. The pop is **deferred by a tick** so an immediately-following re-run can cancel it, and the push is **skipped** when the hook already owns the current entry. A double-invoke is then a genuine no-op rather than a race. The regression test asserts *one push and no traversal* — deliberately not where you land, because that is exactly the assertion jsdom would keep passing.

The lesson generalises past this hook: **a browser-history test in jsdom verifies your bookkeeping, not the browser's.** Anything that depends on when a traversal resolves has to be driven in a real engine.

### 17.7 Still open

- **The Home card and the Settings card have no render test.** `shouldOfferOpeningBalances` is unit-tested and the sheet is not, so "the offer disappears on day three" and "the double-save warning appears" are both still JSX with nothing asserting them. The harness exists now — this is a gap of coverage, not of capability.
- **`ensureCategory`'s archived-revival path is not covered.** It needs a live Postgres to produce the `23505` the branch keys on; the RLS probe is where it would go.
- **The back-dismiss leaves one stale history entry** if a sheet is closed while it is buried under a navigation. Popping it would mean undoing that navigation, which is worse; the entry is at the same URL, so the cost is one invisible back press.
- **The drag never runs in CI against a real compositor.** The jsdom tests fire synthetic pointer events, so the thresholds, the `touch-none` scroll hand-off and the snap-back transition are verified by eye in a browser and by nothing afterwards. The same caveat §17.6 draws about traversals applies here: jsdom confirms the arithmetic, not the gesture.
- **The RLS probe does not cover `money_type` at all** — zero references to it in the file. It is the thing you re-run after every migration, so it is easy to read a green probe as "the migration worked" when for 005 it proves nothing. Verifying that one needs `information_schema.columns` or the app itself.

### 17.8 Migrations 005 and 006 applied (2026-08-05)

Both were outstanding since the passes that wrote them, and both are now on the live database — §15.10's "the one step that cannot be skipped" and §16.5's counterpart are closed.

Applied by hand through the dashboard SQL editor rather than `supabase db push`, and that choice is worth recording: the CLI applies every migration the remote history table does not list, and `001_core.sql` uses plain `create table` with no `if not exists`. On a database that already has those tables it fails partway. 005 and 006 are both idempotent on their own (`if not exists`, guarded `do $$` blocks, `create or replace`), so pasting them is safe and re-pasting them is a no-op.

Verified in four places, because each covers something the others do not:

- **`information_schema.columns`** — two `money_type` columns, on `entries` and `recurring_templates`. The only check that covers 005, since the probe does not.
- **`pg_proc`** — `reset_account` present, `prosecdef = true`, `proconfig = {search_path=}`. That empty search path is the security property, not a formatting detail.
- **The RLS probe** — 38 checks, all green, including the eight-line reset block. Everywhere else the database enforces isolation; there the function does, and this is the only thing that says it aims correctly.
- **Real rows, both directions.** A schema check proves the column exists, not that anything uses it — and §15.1's failure was a *silent* one at both ends: the push stripped the field after a 42703 and the pull never selected it, so the tag survived about a minute and then vanished with no error anywhere. Server rows written since carry real values (an income's three legs all tagged `reallife`, which is §15.4's both-legs fix holding), and History draws the badges from what it pulled back. Push and pull, closed.

### 17.9 The keypad is gone, and it took two bugs with it (2026-08-05)

Reported from a phone within hours of §17 shipping: *"when pressing any number it automatically goes to something like 1.00, and can't edit it anymore — have to clear it and the same thing happens."* The owner's call was to delete the pad and use the phone's keyboard. That was the right one, and the reasoning is worth keeping because §17.1 had just finished *improving* this thing.

**The dead end.** `applyKeypadKeyAt` refuses any key that would produce an unparseable amount — including a digit typed at the end of a value whose two centavos are already spent. Correct in isolation, and fatal in combination with the other half: **every pre-filled amount went through `(c / 100).toFixed(2)`**, so the frequent-amount chips, History's "Fix" and Settings' money targets all handed you a string ending in `.00`. One tap on any of them and the pad went permanently, silently dead. Clear and retype was genuinely the only move.

**And there was no way out**, which is what turned an annoyance into a wall. `inputMode="none"` suppressed the OS keyboard so the pad would not be covered — so once the pad refused an edit there was no second input method to fall back on. The two decisions were individually defensible and jointly a trap.

The chips also *looked* like a keypad row — same `border-2 border-line bg-raised` and the same offset shadow, sitting directly above the pad — so "pressing a number" and "tapping ₱1.00" were easy to confuse. That is most likely how the `1.00` in the report got there in the first place.

**What replaced it is less code, not more.** `inputMode="decimal"` on a plain text input: the browser inserts at the caret, gives real selection handles and a real backspace, and handles every locale and assistive-input case for free. `lib/keypad.ts`, `components/Keypad.tsx` and `components/useCoarsePointer.ts` are deleted; what survives moved into `lib/money.ts`, because it was always about the field rather than the pad:

- `sanitizeAmountInput` — **only ever removes.** Insertion is the browser's, so a caret the user placed mid-number survives being typed into. That is the whole difference from the pad.
- `centavosToAmountText` — drops a trailing `.00`, so `₱50.00` pre-fills as `"50"` and stays open for another digit. This is the actual fix for the dead end, independent of the keypad's removal.

`type` stays `text` rather than `number` on purpose: a number input silently discards what it cannot parse, so a half-typed `"1."` reads back as `""`.

**A second bug, found only in the browser.** With the pad gone, typing `12ab.99xx` produced `1299.` — the decimal point landing in front of the digits. Refused characters leave the text *unchanged*, so a caret-restoring effect keyed on the text never fires, and the position it stored goes stale; the next *accepted* character then gets that old position applied to it. The effect is keyed on a counter that increments on every refused edit as well, and a keystroke that drops nothing now explicitly clears the pending caret.

This is the second time in two passes that a real engine found what jsdom could not (§17.6 was the first), and the pattern is the same both times: **jsdom models the state you keep, not the state the browser keeps.** A caret and a history cursor are both the browser's, not React's.

**One thing lost, and it was worth losing.** The pad existed because the OS keyboard covers the category grid that the 2-tap path's second tap needs (ROADMAP 3.2). That trade-off is real and now runs the other way. It is smaller than it was, though: the sheet without a twelve-key pad in it is short enough that the whole category grid fits on one phone screen, and `enterKeyHint="done"` plus Enter-to-blur gives a one-tap way to put the keyboard down.

**Still open:** whether the keyboard covering the grid is actually a problem in daily use. It is the reason the pad was built, and the pad is now gone on the strength of one report; if the second tap starts feeling slow, the fix is a scroll-into-view on blur rather than bringing twelve buttons back.

### 17.10 The same bug, one screen over — and why it was two screens (2026-08-05)

Reported straight after §17.9 shipped: in Settings → Current money, *"putting a number, like 4, automatically makes it 4.00, and the line where I type is at the decimal, so I have to move it into the middle to be able to edit."*

Identical to the add sheet's dead end, arrived at by a different route. `updateValue` ran the field through `centavosToInput` — i.e. `toFixed(2)` — **on every keystroke**. Type `4`, get `4.00`, caret parked after the centavos; the centavos are now full, so the next digit is dropped by the sanitiser and the field appears frozen. Moving the caret by hand was the only way to keep typing, which is exactly what the report describes.

**Why the two screens broke separately is the part worth keeping.** They had two different money-input parsers. `lib/money.ts` had `parseAmountToCentavos` for the add sheet; `lib/money-type.ts` had `sanitizeMoneyInput` / `formatMoneyInput` / `parseMoneyInputToCentavos` for this panel, with its own comma handling and its own idea of when to reformat. One job, two implementations, two screens that could — and did — fail in unrelated ways and get fixed one at a time.

So the fix is a deletion and a merge, not a patch:

- The `money-type.ts` trio is **gone**. Its comma-as-decimal-separator handling (`"12,34"` → 12.34) went with it deliberately: that is a European convention, and in en-PH a comma is a thousands separator and nothing else. `clampMoneyAmountToMax` stays — the clamp was never the problem.
- `useAmountField` (`components/`) is now the single amount input in the app, used by both. Its rule is the one §17.9 arrived at: **it may only ever remove characters.** Insertion, caret placement, selection and backspace all belong to the browser.
- `normalize` is the one escape hatch, and Settings is why it exists. A target above the available balance must not be *displayable*, or the screen and the stored value disagree — §15.6, which is a real bug that was fixed once and must not come back. A normalised rewrite is no longer what the user typed, so the caret goes to the end of it; a half-typed `"12."` has no parse yet and is left alone.
- The two inputs became `MoneyTargetInput`, a component, because `useAmountField` is a hook and they are rendered from a `.map`.

**The stale-caret bug from §17.9 was in here too**, unshipped but present, and would have been the third copy. It is fixed once now, in the hook, with the test that pins it (`12ab.99xx` → `12.99`).

Verified in Edge at 390 px against a seeded ₱5,000 balance: typing `4` gives `4` with the caret after it, `450`, `450.25`, garbage filtered, clear works, no console errors. `useAmountField.test.tsx` covers the rules in jsdom — including the clamp, which had no test at all before.

**One thing the browser run exposed that is not a bug:** on a ledger with a zero balance every keystroke clamps to `0`, because the maximum a target may claim is the balance. That is the §15.6 rule behaving correctly on an empty tin, and it is only reachable before any money has been logged — but if it ever reads as broken, the answer is to disable the inputs and say why, not to loosen the clamp.

## 18. Thirteen quality-of-life changes, and a keypad that came back (2026-08-05)

A QOL pass, chosen off a longer list. Most of it is small; two items are corrections to decisions this document made in the last two sections, and those are the ones worth reading.

The tracking checklist is `QOL-CHECKLIST.md`. 532 → **631 tests.**

### 18.0 The keypad was deleted for the wrong screen's bug

§17.9 removed the on-screen amount pad app-wide, on the strength of one report from a phone. The report was about **Settings → Current money**. The pad was on the add sheet.

The diagnosis in §17.9 was right about the mechanism and wrong about the blast radius, and §17.10 is the proof: it found the _same dead end_ in Settings, arrived at by a different route (`updateValue` running the field through `toFixed(2)` on every keystroke), and fixed it there without any pad being involved. Settings never had a pad. Deleting the pad could not have fixed the screen that was actually broken.

So the pad is back on the add sheet, and Settings keeps the native field §17.10 gave it. What is **not** back is the trap, and both halves of it had to be answered because either one alone was survivable:

- **The pad refuses any key that would leave the field unparseable.** Correct in isolation.
- **`inputMode="none"` suppressed the OS keyboard** so the pad would not be covered. Also correct in isolation — it is the pad's entire reason for existing, since the keyboard is ~40% of a phone screen and it lands on the category grid the next tap needs.
- **Every pre-filled amount went through `(c / 100).toFixed(2)`**, so the frequent-amount chips, History's "Fix" and Settings' targets all handed you a string whose centavos were already full. One tap and the pad went permanently, silently dead with no second way in.

The third item is already fixed and stays fixed: `centavosToAmountText` drops a trailing `.00`, so no pre-fill arrives with its centavos spent. That alone kills the reported failure. The other half is new: **the sheet carries a keyboard toggle**, persisted per device, so a refusal is never the end of the road.

That escape hatch started as a **required prop** on `Keypad`, to put "this pad always has a way off it" in the type system rather than in a comment. It ended up somewhere better. The toggle now lives on a row in `AddSheet` that renders under the same `coarse` condition which can show the pad, and sits **outside** the `padOpen` branch — so a pad without an escape hatch is not merely discouraged, it is unrepresentable, and the guarantee also holds in the other direction (the way back to the pad is on the same row). Structure beat the type signature here.

`lib/keypad.ts` came back smaller than it left. `sanitizeTypedAmount` did not return with it: `money.ts` owns sanitising now and §17.10's one-parser rule is not being un-done. `collapseAmountLeadingZeros` moved _into_ `money.ts` and is shared, for the same reason.

### 18.1 The fuzz test found the second deletion-overflow

§17.1's fuzz test found that backspacing the point out of `12345678901.23` merges the centavos into the pesos and produces thirteen integer digits — a _deletion_ that overflows, which is not the shape of overflow anyone guards against.

Adding sums (§18.3) gave it a sibling, and the fuzz test found that one too, on the first run: backspacing the `5` out of `69.5+0.77` leaves `69.` stranded **mid-sum**. A trailing dot at the very end is the documented mid-entry state — it is what pressing `.` looks like before the centavos arrive — but in the middle it is a term nothing will ever complete, so the whole expression stops parsing and the save goes quiet with no visible cause.

The fix is not another special case. `settle()` now asks **`parseAmountExpression` itself** whether a candidate edit is allowed, instead of re-implementing its rules as a bounds check. The promise this module makes is "the pad cannot strand the field in a state the save gate rejects", and the only way to keep that promise without drift is to ask the save gate. The one forgiven state — a trailing dot after a digit, at the end of the string — is now a single named function (`stripTypingDot`) rather than a condition spread across two checks.

### 18.2 Three taps for a two-tap path — and the one that stays three

The money type is required before any save control on the add sheet lights up, and it started at `null` on every open. It is also the same answer on almost every entry. So the "2-tap path" that ROADMAP 3.2 sets a 5-second budget for was really three taps, one of which looked like ceremony.

**It was made to default to the last one saved, and then that was taken back out.** The reversal is the part worth keeping, because the convenience argument was the strongest of the three and it still loses.

§15 exists because untagged money is dishonest. But the failure it was built to prevent is a *gap*, and defaulting introduces a different failure: a **wrong** tag. The first cash spend after a run of online ones gets filed as Online, silently, and the two are not equivalent —

- an untagged row is an honest gap, and the Home card reports it as its own third bucket precisely so the app never invents an answer only the user can give (§15's whole argument);
- a mis-tagged row is a confident lie, and it is **invisible**. A wrongly-remembered envelope shows up in the split the moment you look at Home. A wrongly-defaulted money type looks exactly like a correctly-picked one, in every screen, forever.

The tap is real and it is the price of the ledger meaning what it says. The envelope memories stay — the transfer pair and the single-envelope income target, both in `lib/entry-prefs.ts` — because their mistakes are legible.

Two rules keep those memories from becoming a liability:

- **It is only written on SUCCESS.** A write that failed is not evidence of anything, and quietly moving a picker on the strength of one would be a second surprise stacked on the error toast. There is a test for this.
- **Envelope ids are reconciled against the live list, not trusted.** An id whose envelope has since been archived degrades to "nothing remembered" rather than to a picker pointing at a row that no longer exists behind a save button that looks live. That reconciliation cannot happen in a state initialiser, because until the fetch resolves there is no list to check against.

A stored blob written by the build that *did* remember a money type still has one in it. It is simply never read — the field is gone from `EntryPrefs`, so nothing can reach it, and the next write drops it. There is a test pinning that, because "we removed the feature" and "the old data cannot come back" are two different claims.

`ENTRY_PREFS_KEY` is user-scoped and clears on logout; `AMOUNT_INPUT_KEY` is not. The line between them is the one `lib/texture.ts` already argues: "I hold my phone and prefer a pad" describes the device, while "my money is usually cash and my transfers run Savings → Needs" is a description of someone's finances and has no business greeting the next person on a shared laptop.

### 18.3 The rest of the add sheet

- **`120+45`.** One purchase is often several prices, and the alternative to typing the sum is doing the arithmetic in your head first — which is where a mistyped total comes from. `parseAmountExpression` sums the terms; each one goes through `parseAmountToCentavos`, so every existing rule holds per term, and **the sum is bounds-checked too** (twelve terms at the ceiling are individually legal and jointly nonsense). A trailing `+` is explicitly _not_ an error: that is the field mid-thought, and greying the grid out there would punish you for knowing there is more to come. The total is shown as working (`120 + 45 = ₱165.00`) because it is what actually gets saved. `allowPlus` is opt-in, so Settings — which parses with `parseAmountToCentavos` — cannot end up with a `+` sitting in a field over a value that reads as null.

  **`+ add` is not on the pad, and the reason is only visible on a phone.** It started in the pad's footer, outside the 3×4 grid because three columns is what makes the pad thumb-shaped. But `inputMode="decimal"` gives a phone a numeric keyboard with **no `+` key at all** — so a `+` that belonged to the pad made sums silently impossible for anyone who had taken the keyboard escape hatch, which is precisely the person already having trouble. It moved to the shared row above the pad. The argument that kept it out of the grid — it is an *action*, not a digit — turns out to say it belongs to the **field** rather than to the pad, and following it one step further closed a gap nobody had reported yet. A laptop needs no button: a hardware keyboard has a `+` on it.
- **A category filter**, past twelve chips. Below that the grid _is_ the filter. It does **not** re-sort what survives — the grid is ranked by use, and re-ordering on each keystroke would move the chip you are aiming at as you type the letter that was going to select it. A no-match hands the typed name straight to `+ Other`, already filled in.
- **A `⇄` between the transfer pickers.** It earns its place _because_ of the memory: the remembered pair is right about which two envelopes and wrong about the direction roughly half the time.

### 18.4 History

- **Dates**, which this screen simply did not have — kinds and categories only, so "what did I spend last week" was unanswerable on the one screen built to answer it. Four presets plus two date inputs. The comparison is lexical on Manila day keys: they are zero-padded and fixed-width, so string order _is_ calendar order and no `Date` arithmetic happens near a month boundary. A date bound counts as an active query, which is what makes the whole ledger get read instead of the loaded page — "last month" over the newest 200 rows would answer a question about last month with whatever happened to be in memory.
- **Undo on a void.** Every other confirmation in the app offers one (save, streak repair, recurring catch-up); a void that could not be taken back taught you the toast was safe in three places and then wasn't in the fourth. **This needed no migration**, which is worth recording: `001_core.sql` revokes UPDATE on entries and grants back exactly `(voided_at, void_reason)`, so writing null into that pair is already inside the grant. The schema's rule is "the only mutation is the voiding pair", not "voiding is one-way". Nor does it break rule 3 — `voided_at` is a flag on a row that never went anywhere, so clearing it rewrites no history and creates no entry. `unvoid_group` is a **third** outbox op rather than a void with a null in it, and it retries the same way the other two do: the push filters on rows that are currently voided, so a replay after a lost response updates zero rows. `describeOp` in Settings is now a `switch` with no default, so a fourth op is a compile error on the one screen whose job is telling you what you are about to discard.
- **Month separators**, suppressed when the whole list is one month.
- **Envelope filters**, so the one Home now sends is legible and clearable rather than invisible.
- **The sticky day header no longer collides with the sync pill.** The pill is `fixed` at `top-3` with a higher z-index, so when a write was stuck — exactly when you come to History to check something — it parked itself on the day header. `SyncPill` publishes `--sticky-top` on the document while it is visible; the header reads it. Written to the document rather than threaded through the router, because the readers are sticky headers on screens the pill knows nothing about.

### 18.5 Home and Insights

- **Envelope cards open their own entries.** Insights already did this for categories; envelopes were the missing half, and Home is where the question gets asked. Only the card _header_ is the button — the meter carries its own `aria-label` and a red card carries a "cover from" button, and nesting either inside a button is both invalid and a mis-tap waiting to happen.
- **A weekly number**, beside the daily one. Rolling seven days rather than week-to-date: a week-to-date figure is near-zero every Monday and near-complete every Sunday, so it says more about the weekday than about the spending — and it sits next to a daily allowance whose whole job is being comparable from one glance to the next. `spentOnDay` is now literally `spentInRange` with both bounds equal, so the two cannot drift apart on what counts as spending.
- **Insights' month label is a picker.** Paging back a year took twelve taps, and ‹ disables itself at the first month with anything in it — so the arrows knew where the ledger began and would not say. Bounded at both ends by the same rules the arrows enforce, with a hard iteration cap so a corrupt `earliestMonth` from the future cannot build a list forever.

### 18.6 Still open

- ~~**None of this ran in a real browser.**~~ **Done before the pass was committed.** Edge at 390×844 with touch emulation: the pad renders on a coarse pointer with `inputMode="none"`; typing `1250`, tapping to caret 2 and pressing `9` gives `12950` with the caret at 3 — §17.1's bug does not recur on the restored pad; hold-⌫ clears; `+ add` leaves `120+` in the field before anything else is typed; `120+45` draws `120 + 45 = ₱165.00` and stays live while a term is edited (`120 + 4 = ₱124.00`); a single amount draws no working line; the keyboard toggle flips `inputMode` to `decimal`, hides the pad, and **survives a full reload**; a 2-tap save closes the sheet. No console errors. The caveat §17.6 and §17.9 both raise still stands for everything not on that list.
- **A void can only be undone from its toast**, which lasts eight seconds. A mis-tap noticed a minute later has no path back, and `unvoidGroup` exists and would serve it. A permanent "restore" button on every voided entry was deliberately not built in this pass — it changes the ledger's character rather than adding a convenience, and that is a decision to make on purpose rather than as a side effect of adding an undo.
- ~~**`pushUnvoidGroup` has no RLS-probe coverage.**~~ **Closed before the pass was committed — and it was the right thing to have worried about.** The claim was load-bearing and had no execution behind it: a wrong reading of `revoke update … grant update (voided_at, void_reason)` would have meant every undo applied to the mirror, looked like it worked, and then sat at the head of the outbox failing forever — **blocking every money write queued behind it**, which is a data-loss-shaped failure dressed as a UI convenience. The probe now has an `un-voiding (§18)` block against real Postgres, in its own group so the reset block's assertions are untouched: the grant does permit writing `null` back, the row comes back live with its reason cleared, a replay updates zero rows, and editing an amount is *still* refused. Observed, not reasoned about. **A migration would have dragged the probe along with it; this needed none, which is exactly how the gap opened** — worth remembering the next time something ships without one.
- **`--sticky-top` has one publisher and one reader**, and nothing asserts they agree. If the pill's height changes, the header's offset goes wrong silently.
- **`History.tsx` has no render test, and this pass proved what that costs.** A JSX comment placed illegally inside a `&&` expression left the file with an outright **syntax error** — and `npm test` reported 631 passing, because nothing imports that module. `tsc` caught it; the suite structurally could not. The same is true of `Home.tsx`'s and `Insights.tsx`'s changes here. Green tests say nothing about a screen no test renders, and this pass touched three of them. **Run `tsc` as well as the suite** until they have one.
- **The category filter threshold is a guess.** Twelve is where a wrapped grid stops fitting a phone screen in the layouts checked by eye, not a measured number.
