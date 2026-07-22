# Tin — Build Roadmap

> A cozy 70/20/10 savings & spending tracker. One real pot of money (GCash), three virtual envelopes, an honest append-only ledger.
>
> Solo dev · ₱0 budget · PHP centavos · Asia/Manila · multi-user-safe from day one.

---

## Status — all phases closed (2026-07-22)

**Live at <https://tin-jar.netlify.app>.** Phases 0–8 are done, plus a Phase 3.5 retrofit. 185 tests; lint, build and the AA-contrast script all clean. `git push` to `main` deploys.

| Phase | State |
| ----- | ----- |
| 0–2 Setup, money brain, accounts & RLS | ✅ |
| 3 The ledger ★ | ✅ |
| 3.5 Envelope/category management | ✅ **retrofit** — §0 promised it, no phase ever gave it a task line, so it was never built. Found by auditing prose against code. |
| 4–7 Analytics, recurring, offline, hardening | ✅ |
| 8 Statement importer | ✅ **closed** — importer shipped; the GCash-PDF-specific reader was **dropped by decision**, not left pending |

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

