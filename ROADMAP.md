# Tin — Build Roadmap

> A cozy 70/20/10 savings & spending tracker. One real pot of money (GCash), three virtual envelopes, an honest append-only ledger.
>
> Solo dev · ₱0 budget · PHP centavos · Asia/Manila · multi-user-safe from day one.

---

## Status — all phases closed (2026-07-22), Phases 9 and 10 added 2026-07-24, Phases 11-12 2026-07-28

**Live at <https://tin-jar.netlify.app>.** Phases 0–12 are done, plus a Phase 3.5 retrofit. 544 tests — including the first component-render tests, added in §17; lint, build and the AA-contrast script all clean. `git push` to `main` deploys.

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

This document stops being a plan here and becomes the record of why things are the way they are. The parts worth reading before changing anything: **§1 engineering law**, the **§3** notes on composite ownership FKs and the missing sum-to-10000 check, **§6**'s known CVD gap, and the closure note on Phase 8.

Two lessons this roadmap taught the hard way, both worth keeping:

1. **A ticked checklist is not a built product.** Every box for Phases 0–7 was ticked while an entire promised feature (editable percentages, category management) did not exist — because it only ever lived in prose and a file-tree comment, never in a task line. Audit promises against code, not against boxes.
2. **`[]` is truthy.** `{list && …}` is not a loading guard. On a cold load the local mirror is empty until the first pull; that bug shipped twice, once leaving a picker permanently empty and once crashing a screen outright.

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

`vite.config.ts` already documented the opt-in (`// @vitest-environment jsdom`, and `.tsx` in the include glob or the file is silently not collected). Two files now use it: `BottomSheet.test.tsx` covers the back-button contract in all four of its states, and `AddSheet.test.tsx` renders the real sheet against stubbed db modules and drives the pad. 512 → **544 tests.**

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
