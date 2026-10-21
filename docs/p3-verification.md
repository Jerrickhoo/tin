# P3 verification — 2026-10-21 (Asia/Manila)

P3.1–P3.3 are implemented. D7 and D8's recommended defaults were adopted under the user's instruction to proceed with recommended work without waiting for input. P4–P8 remain outside this slice.

## Behavior

- Received income can have a separate budget month. Actual Cash/Online receives it once; a future assignment reduces the current envelope's available money. Manila month evaluation releases the hold without a scheduled income insert. Existing unreserved carryover stays available. Spending held funds remains recordable and produces a funding shortfall.
- Expected allowance is a zero-cash plan. Review and explicit receipt confirmation create one linked income operation. Revision checks and the owner-locked server transaction prevent two devices from confirming it twice. Expectations can be edited or canceled before receipt.
- Budget planning is available from Settings, Home envelope cards, History, and Insights. Month navigation covers historical context, twelve future months, and stored later assignments. Budget references link to the same actual receipt chain in History, with received/recorded/budget labels. Future views contain no spending-performance claims.
- Spending days are opt-in per selected envelope ID. Calendar fallback, weekdays, Mon–Thu, excluded/extra dates, and month-specific remaining-day overrides are supported. Today counts until excluded. Overrides stay fixed until changed or cleared. The formula uses current available centavos, floors the result, and handles zero days explicitly. The quick calculator changes no saved plan or money.

## Persistence and compatibility

Budget events are stored in immutable `ledger_audit.details.budget`, within the existing financial operation, mirror, journal, outbox, RLS, and reset lifecycle. No second cash ledger or new mutable preference table is introduced. Assignment identities refer to income correction chains, so corrections/voids/restore retain their financial meaning and adjust the hold with the active signed legs.

Revision links determine the latest event, rather than device timestamps. Local and server validation reject stale edits, forks, cycles, unknown fields, invalid dates/counts, foreign references, orphaned receipts, and duplicate confirmations. A schedule draft retains its original revision while background sync updates the page; sync cannot silently discard the draft or authorize it against a newer revision.

JSON format 3 preserves the full budget history and prevents older clients from accepting a backup whose meaning they cannot read. Versions 1 and 2 remain readable. Envelope references and schedule keys remap together during restore. Home and Settings export the same complete, atomic backup snapshot; CSV includes each income's budget month.

Pulled entries, financial audit/obligations, envelope/category data, and the sync cursor commit in one local transaction. Failure to fetch or validate holds leaves the previous complete snapshot. Smaller server pages continue until completion; a non-advancing cursor fails without committing partial money.

## Evidence

- Full local suite: **788 passed, 3 credentialed tests skipped**. The three credentialed cases passed separately on isolated staging, together with the full RLS probe.
- Mandatory deployment checks: dependency audit **0 vulnerabilities**, lint, formatting, contrast, token checks, and **9 deployment/staging guard tests** pass. The production build passes.
- Disposable PostgreSQL rehearsal: **76 assertions passed** across migrations 001–008, including legacy compatibility, atomic receipt/assignment replay, conflicting revisions, invalid schedules, linked restore, and the retained P2 monetary invariants.
- Real isolated Supabase/PostgREST: **8 P3 scenario groups passed**. These cover anonymous/foreign-owner isolation, the legacy-only compatibility window, atomic receipt/replay, upgrade enforcement, competing assignments, competing receipt confirmations, validated schedules, and cross-account linked restore after source reset.
- Real staging app in Edge with a mobile touch context and Los Angeles device timezone: expected receipt, offline plan creation, offline confirmation/reload, service-worker reload, reconnect and queue drain passed. Actual money was **₱4,700**, November holds **₱1,500**, current availability **₱3,200**, and the saved 16-day rate **₱200/day**. The actual downloaded JSON was version 3 and retained all six budget events (including a prior schedule revision).
- Browser layout matrix: **315/315 passed**, covering 15 views (14 routes plus the envelope spending-day form), seven themes, and widths 1280/390/320. No uncaught errors or horizontal overflow were found.
- Final actual staging build: a cold device with its audit response deliberately delayed exposed no incoming cash until the receipt and holds could commit together. It then showed the correct ₱4,700/₱1,500/₱3,200 projection. A schedule draft survived sync, actual receipt navigation/Back preserved context, and Home's downloaded backup retained all three signed rows and six budget events.
- Clean installation: an isolated source copy with no daily environment file passed `npm ci`, the mandatory check command and the production build. All **192 runtime/configuration files** compared identically to the reviewed workspace. Result: `output/review/p3-clean-room-result.json`.
- Final production build with the deployed CSP passed saved Neo Pop startup, service-worker control, offline public-route reloads and offline sign-in recovery, with no CSP/uncaught errors. Daily-backend requests were blocked in that browser context.

Browser evidence is retained under `output/review/` and `output/playwright/p3/`. Reports distinguish disposable fixtures from real staging transport.

Private staging sessions, public-key staging build configuration, and daily backup data use ignored `.local` files. A publishable-file scan checks for configured private credentials, private JWTs, and source NUL bytes. No staging probe is run against the daily project.

## Daily schema release

Migrations **007 and 008 are applied to the daily database**. Before applying them, a private backup of all seven original tables was restored into disposable PostgreSQL, migrated, and compared field-for-field: all **420 entries** and every original field were preserved. Financial invariants passed for the existing owner.

The production application used one guarded transaction: lock the original tables, verify the backup fingerprint still matches, apply the exact rehearsed migrations, compare every original field, validate financial invariants, register the two migrations, and commit. Any mismatch would roll back. No ledger probe entries or payments were created in production.

Post-migration authenticated-role read checks matched the owner's original row count, denied foreign-owner rows, and returned capability 1 for both financial and budget operations. The read-only public-key deployment check confirms PostgREST discovers both authenticated-only functions. Evidence is in `output/review/production-backup-rehearsal.json`, `production-migration.json`, and `production-verification.json`.

An account with only legacy records can keep using the deployed legacy client during the migration/deploy gap. The first new financial record or budget plan closes that window under the same owner lock; older clients must then refresh. The refreshed app can replay historical outbox payloads with protocol 2. No financial fields are stripped to force a save through.

Netlify now runs mandatory checks and the read-only server prerequisite gate before building/publishing. Its check subprocess clears live probe credentials and uses an invalid test backend; the actual build retains the public deployment environment. A main push cannot bypass these checks merely because GitHub CI runs separately.

## Limits

Browser touch and timezone checks are emulated; physical phone/OS sleep behavior was not tested. Cross-device reset propagation remains the documented existing limitation. Goal/commitment reservations belong to P4/P5 and are not silently invented here. The existing bundle-size warning is a performance follow-up. No Git push or application deployment was performed during this work.
