# QOL pass 18 — working checklist

Thirteen items, agreed 2026-08-05. This file is the tracker; the reasoning gets
folded into `ROADMAP.md` §18 when the pass closes.

Order is dependency-first: pure `lib/` changes, then `components/`, then `db/`,
then the screens that consume them, then tests.

---

## 0. The keypad comes back — on the add sheet only

**The correction.** §17.9 deleted the pad app-wide on the strength of one bug
report. The report was about **Settings → Current money**, not the add sheet.
The pad is wanted where money is entered; the native field is wanted in
Settings (where §17.10 already put it).

But the pad cannot come back as it was — §17.9's diagnosis of _why_ it became a
trap still stands, and both halves have to be answered:

- [x] **Prefills go through `centavosToAmountText`, never `toFixed(2)`.** This is
      already true app-wide as of §17.9 and is what kills the `1.00` dead end at
      the source.
- [x] **There is always a second way in.** A toggle switches the field to the OS
      keyboard and the choice persists per-device. `inputMode="none"` + a pad
      that can refuse a key is only a trap when it is the _only_ input method;
      this is what makes the two decisions no longer jointly fatal.
- [x] The toggle is **structurally** inseparable from the pad — same `coarse`
      block, outside the `padOpen` branch — rather than a required prop on
      `Keypad`. Stronger: it also holds while the pad is closed.
- [x] Kept the pad on **all three modes** (owner's call). Splitting it would flip
      `inputMode` on a tab switch, which does not reliably re-summon the iOS
      keyboard without a blur/refocus — §17.9's trap rebuilt from another angle.
- [x] Restore `lib/keypad.ts`, `components/Keypad.tsx`, `components/useCoarsePointer.ts`
      from `9ad7701`, minus the duplicated sanitiser — `money.ts` owns that now
      (§17.10's one-parser rule is not being un-done).
- [x] Pad shows on coarse pointers only, on all three add-sheet modes.
- [x] Settings' `MoneyTargetInput` keeps the native field. Unchanged.
- [x] Caret-aware insertion (`applyKeypadKeyAt`) and hold-⌫-to-clear survive.

## 1. ~~Remember the last money type~~ — built, then reversed by decision

- [x] `lib/entry-prefs.ts` — device-local add-sheet memory, one module.
- [x] Register the key in `lib/local-keys.ts` as **user-scoped** (it describes a
      habit, so it must not survive a logout on a shared laptop).
- [ ] ~~Money type defaults to last used instead of `null`.~~ **Removed.**

**Why it came back out.** It shipped, and it was the biggest single tap saving in
the pass — the type gates every save control, so it costs a tap on _every_ entry.
It is still wrong. §15 exists because untagged money is dishonest, but a **wrong**
tag is worse than a missing one: an untagged row is an honest gap the Home card
reports as its own bucket, while a cash spend silently filed as Online is a
confident lie on a ledger whose entire premise is that it does not lie to you.
The failure is also invisible — a wrongly-picked envelope shows up in the split
the moment you look, a wrongly-defaulted money type looks exactly like a
correctly-picked one.

The envelope memories (transfer pair, income target) stay: same convenience, and
their mistakes are legible.

## 2. Category grid filter

- [x] Type-to-filter box above the grid, shown only past a threshold (12).
- [x] Filters by name, case-insensitive; ranking order preserved.
- [x] Says so when nothing matches, with `+ Other` still reachable.

## 3. Transfer: swap button + memory

- [x] `⇄` between From and To.
- [x] From/To default to the last transfer's pair (via `entry-prefs`).

## 4. Income single-envelope target remembered

- [x] Last chosen envelope instead of `envelopes[0]` (via `entry-prefs`).

## 5. Arithmetic in the amount field

- [x] `parseAmountExpression` in `money.ts` — `120+45` → 16500 centavos.
- [x] `sanitizeAmountInput` gains an opt-in `allowPlus`; **Settings does not opt in**
      (a target of `50+20` would parse to null there).
- [x] `+ add` button and a live `120 + 45 = ₱165.00` line under the field.
- [x] **`+ add` is on the shared row, not on the pad.** `inputMode="decimal"`
      gives a phone a numeric keyboard with **no `+` key**, so a `+` living on
      the pad made sums silently impossible in keyboard mode — for exactly the
      person who just needed the escape hatch. Covered by a test that asserts
      the field reads `120+` _before_ any further typing, so it cannot pass
      vacuously.
- [x] Deliberately **not** collapsed on blur — blur happens at the moment a
      category tap saves, so rewriting the field there would change what you are
      looking at as you commit it.

## 6. History: date filter

- [x] `LedgerQuery` gains `from` / `to` Manila day keys.
- [x] Quick chips: 7 days · 30 days · This month · Last month, plus two date inputs.
- [x] A date filter counts as "searching", so it reads the whole ledger and not
      just the loaded page.

## 7. History: undo a void

- [x] `unvoid_group` outbox op — a **third** op type, so `outbox.ts`'s "exactly
      two" header is now wrong and gets rewritten.
- [x] Idempotent on retry the same way void is: filters on `voided_at is not null`,
      so a replayed push updates zero rows.
- [x] No migration needed — `grant update (voided_at, void_reason)` already covers
      writing `null` back (verified against `001_core.sql:166`).
- [x] Undo action on the void toast, matching save / repair / catch-up.
- [x] `describeOp` in Settings switched exhaustively, so a fourth op is a compile
      error on the screen whose job is saying what you are about to discard.
- [x] **Covered.** Shipped untested at first — a new op in the app's most complex
      subsystem, while the void beside it had end-to-end coverage since Phase 6.
      Now: the local round trip and outbox enqueue (`local-first`), the
      voided-again replay, and the `.not('voided_at','is','null')` filter that is
      the whole idempotency argument (`remote`). `sync-loop`'s `./remote` mock
      also lacked `pushUnvoidGroup` — a missing key there is a TypeError, not a
      silent stub.
- **Deliberately not built:** a permanent "restore" button on voided entries.
  `unvoidGroup` would serve it, but making every void freely reversible
  changes the ledger's character — that is a decision to take on purpose,
  not a side effect of adding an undo. Recorded in ROADMAP §18.6.

## 8. Sticky day header vs the sync pill

- [x] `--sticky-top` CSS var, set by `SyncPill` while it is on screen.
- [x] History's day header reads it instead of a hardcoded `top-0`.

## 9. History: month separators

- [x] A month heading when the month changes mid-scroll.
- [x] Suppressed when the whole list is one month — a lone "August 2026" over the
      first day is noise.

## 10. Home: envelope cards open the filtered ledger

- [x] `LedgerQuery.envelopeIds`, mirroring `categoryIds`.
- [x] Card header navigates to `/history` with the envelope in router state.
- [x] Envelope chips in the filter panel, so an incoming filter is legible and
      clearable rather than invisible.

## 11. Home: a weekly number

- [x] `spentInRange` in `lib/logging-streak.ts` beside `spentOnDay`.
- [x] "this week" next to "spent today" — same line, same rules (hidden at zero).

## 12. Insights: jump to a month

- [x] The month label in the header becomes a picker.
- [x] Bounded by `earliestMonth` at one end and the current month at the other,
      matching what the ‹ › arrows already refuse to cross.

---

## Verification

- [x] `npm run lint` — clean
- [x] `npm run build` — clean
- [x] `npm test` — **631 passing**, 3 skipped (was 532)
- [x] New coverage: `keypad.test.ts` (45, incl. a widened fuzz over `+`),
      `entry-prefs.test.ts` (13), plus expression / date-range / envelope-filter /
      `spentInRange` cases and 27 render tests in `AddSheet.test.tsx`.
- [x] **Real Edge touch emulation completed 2026-10-21.** At 390px, entering
      `1250`, placing the caret at position 2 and pressing `9` produced `12950`.
      Holding delete cleared the amount; `120+45` showed `₱165.00` and saved
      exactly 16500 centavos. Undo restored the original balance. The Keyboard
      preference survived closing/reopening, and dialog focus returned to its
      opener. All seven themes fit the touch keypad at 390px and 320px. This is
      browser touch emulation, not a physical-phone test. The release review also
      fixed a digit being swallowed after a delete hold ended outside its key.
      See [release review](docs/release-readiness-2026-10-21.md) and
      `output/review/browser-flows.log`.

## A green suite is not a compiling app

Mid-pass, `History.tsx` held an outright **syntax error** (a JSX comment inside a
`&&` expression) and `npm test` still reported 631 passing — nothing imports that
module, so nothing ever parsed it. Only `tsc` caught it.

`History`, `Home` and `Insights` all have no render test and all changed in this
pass. **Run `npx tsc --noEmit -p tsconfig.app.json` alongside the suite** until
they do.

## What the fuzz test caught

`69.5+0.77`, backspace at caret 4 → `69.` stranded mid-sum, whole expression
stops parsing, save goes quiet with no visible cause. Second deletion-overflow
this pad has produced (§17.1 was the first). Fixed by making `settle()` ask
`parseAmountExpression` itself rather than re-implementing its rules.
