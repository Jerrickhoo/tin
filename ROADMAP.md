# Tin — Build Roadmap

> A cozy 70/20/10 savings & spending tracker. One real pot of money (GCash), three virtual envelopes, an honest append-only ledger.
>
> Solo dev · ₱0 budget · PHP centavos · Asia/Manila · multi-user-safe from day one.

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

### Phase 8 — GCash statement importer (optional; 4–8 evenings, high variance)

**Goal:** backfill history from GCash's emailed, password-protected transaction export. **Entirely client-side — the file never leaves the machine.** This is an _importer with review_, not a sync.

- Parse in-browser (pdf.js handles password-protected PDFs; if GCash sends XLSX, SheetJS community edition).
- Map rows → draft entries; **review-and-confirm table** (edit category/envelope per row; nothing auto-commits).
- **Duplicate detection:** flag drafts matching an existing entry within ±amount-exact and ±36 h, and drafts identical to a previous import (store a source-row hash on imported entries).
- Batch insert as backdated entries with client UUIDs.

**Risk note:** statement-format parsing is the flakiest code you'll write; GCash can change the layout any time. That's why it's last and optional.

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
│  │  └─ export.ts                     #   entries → CSV / JSON
│  ├─ db/
│  │  ├─ supabase.ts                   # client init (reads VITE_ vars)
│  │  ├─ dexie.ts                      # local mirror schema        (Phase 6)
│  │  ├─ outbox.ts                     # pending-writes queue       (Phase 6)
│  │  └─ sync.ts                       # push outbox / delta pull   (Phase 6)
│  ├─ features/
│  │  ├─ auth/                         # login, signup, session, logout(+cache wipe)
│  │  ├─ home/                         # balance cards + Add button
│  │  ├─ entries/                      # keypad sheet, income split, timeline, void/fix, cover-transfer
│  │  ├─ analytics/                    # month picker, flows, adherence
│  │  ├─ recurring/                    # templates + catch-up poster (Phase 5)
│  │  ├─ settings/                     # envelopes, categories, percentages, export, account
│  │  └─ import-gcash/                 # client-side statement parser (Phase 8)
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

- [ ] 0.1 Create GitHub repo `tin`; init Vite React-TS app
- [ ] 0.2 Add Tailwind, ESLint, Prettier, Vitest
- [ ] 0.3 `.gitignore` with `.env`; commit `.env.example`
- [ ] 0.4 `public/_headers` + `public/_redirects`
- [ ] 0.5 Connect Netlify → auto-deploy `main`; verify live URL
- [ ] 0.6 Themed hello page with the §6 background/text tokens (first taste of cozy)

**Phase 1 — Money brain**

- [ ] 1.1 `money.ts` (+tests: format, parse, reject bad input)
- [ ] 1.2 `split.ts` (+tests: ₱0.01, ₱0.03, ₱1,234.57, ₱888,888,888.88, 10k-random sum invariant, tie-break determinism)
- [ ] 1.3 `dates.ts` (+tests: UTC/Manila month boundary both directions)
- [ ] 1.4 Deployed split-preview screen

**Phase 2 — Accounts & vault**

- [x] 2.1 Create Supabase project (leaked-password protection: Pro-only, skipped)
- [ ] 2.2 Write & apply `001_core.sql`; commit it
- [ ] 2.3 Netlify env vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`); local `.env`
- [ ] 2.4 Auth screens + session handling + route guard + password-reset flow (redirect URL allowlisted in Supabase)
- [ ] 2.5 First-run seeding: profile row + 3 envelopes (7000/2000/1000 bp) + starter categories, idempotent
- [ ] 2.6 `rls-probe.ts`: second account (dashboard-created, auto-confirmed) cannot read/write first account's rows — **passes**
- [ ] 2.7 Logout works (cache-wipe hook stubbed for Phase 6)

**Phase 3 — The ledger ★**

- [ ] 3.1 Home: balance cards from `envelope_balances` + bottom nav + Add button
- [ ] 3.2 Expense bottom sheet: keypad-first, category chips, note, editable `occurred_at` — measure: ≤2 taps, <5 s
- [ ] 3.3 Income flow: amount → live split preview → 3-row insert w/ shared `group_id`
- [ ] 3.4 Onboarding opening balances (`adjustment` entries)
- [ ] 3.5 Timeline grouped by Manila day; group legs collapsed into one item; entry detail
- [ ] 3.6 Void with reason — always the whole `group_id`, never a single leg; "Fix" = void + prefilled re-entry
- [ ] 3.7 Transfer flow + one-tap "cover from…" on red envelopes
- [ ] 3.8 Export JSON + CSV from Settings
- [ ] 3.9 PWA manifest + icons (installable; offline comes later)
- [ ] 3.10 **Start using Tin daily. This is the finish line for “usable.”**

**Phase 4 — Analytics**

- [ ] 4.1 Month picker on Manila boundaries
- [ ] 4.2 Income vs spending + net for month (transfers excluded from totals)
- [ ] 4.3 Per-envelope and per-category breakdowns (CSS/SVG bars)
- [ ] 4.4 Split adherence: actual mix vs plan

**Phase 5 — Recurring**

- [ ] 5.1 Catch-up poster logic: compute due dates from templates (table already shipped in `001_core.sql`), Manila-correct, clamp day 29–31 to month end; deterministic UUIDv5 posting IDs; income templates post the full split
- [ ] 5.2 On-open catch-up with confirm/undo toast
- [ ] 5.3 Manage screen (add/edit/pause/delete)

**Phase 6 — PWA + offline** _(done 2026-07-19)_

- [x] 6.1 `vite-plugin-pwa` service worker, app shell cached
- [x] 6.2 Dexie mirror; UI reads local-first
- [x] 6.3 Outbox queue; writes go local + queue
- [x] 6.4 Sync loop: push entry upserts (`ignoreDuplicates`) + void-group updates; delta pull by `updated_at` (server-side cursor, ~60 s overlap)
- [x] 6.5 Online/offline indicator + queued-writes badge
- [x] 6.6 Logout wipes Dexie + outbox + SW caches (warn if outbox non-empty)
- [x] 6.7 PWA shortcut → Add expense; airplane-mode end-to-end test (headless-Edge Playwright: offline reload from SW → offline expense queued → reconnect → outbox drained → logout wipe verified)

**Phase 7 — Hardening**

- [ ] 7.1 TOTP MFA enroll + challenge
- [ ] 7.2 CSP tightened to strict allowlist
- [ ] 7.3 Keep-alive workflow + repo secrets
- [ ] 7.4 Error boundary; failure-path audit
- [ ] 7.5 Lighthouse a11y/PWA pass; AA contrast verification
- [ ] 7.6 Monthly export reminder set up

**Phase 8 — GCash importer (optional)**

- [ ] 8.1 Request own GCash export; inspect real file format
- [ ] 8.2 Client-side parse (pdf.js w/ password, or SheetJS if XLSX)
- [ ] 8.3 Row → draft-entry mapping + review/confirm table
- [ ] 8.4 Duplicate detection (existing-entry window match + source-row hash)
- [ ] 8.5 Batch insert as backdated entries

---

## 6. Design system — midnight violet

> Remade 2026-07-18 (v2). The original "cozy dark" was espresso/honey — too brown. Direction now follows the `theme reference/` folder (near-black neutral surfaces, hairline borders, one confident accent) plus the owner's call: dark + purple. Coziness lives in shape, spacing, and soft pastels — not warm browns.

A dark room lit by one lamp: near-black violet surfaces, lavender light. All ratios below are **measured** (WCAG relative-luminance script, not eyeballed); every text token clears AA (4.5:1) on `bg-base`, `bg-surface`, *and* `bg-raised` — worst case is `text-muted` on `bg-raised` at 4.86:1.

### Palette

Token names in code are role-based (`src/styles/theme.css`) so a future restyle touches one file. §6-name → code-name mapping is commented in that file.

| Token            | Hex       | Use                                     | Contrast on `bg-base` |
| ---------------- | --------- | --------------------------------------- | --------------------- |
| `bg-base`        | `#131118` | app background (violet-tinted near-black) | —                   |
| `bg-surface`     | `#1C1923` | cards                                   | —                     |
| `bg-raised`      | `#262230` | bottom sheets, modals                   | —                     |
| `border`         | `#363044` | hairlines, dividers                     | —                     |
| `text-primary`   | `#EAE6F2` | body & amounts (lavender-white)         | 15.25 : 1             |
| `text-secondary` | `#AFA7C2` | labels, secondary                       | 8.14 : 1              |
| `text-muted`     | `#948CA9` | timestamps, hints                       | 5.87 : 1              |
| `accent`         | `#B49BF5` | primary buttons, focus rings, links (lavender) | 7.98 : 1       |
| `on-accent`      | `#1D1530` | text on accent buttons                  | 7.44 : 1 on accent    |
| `positive`       | `#93CFA9` | income, positive deltas (mint)          | 10.47 : 1             |
| `negative`       | `#E4808A` | expenses, red envelopes (dusty rose)    | 6.92 : 1              |
| `env-needs`      | `#B49BF5` | Needs identity (violet)                 | —                     |
| `env-savings`    | `#93CFA9` | Savings identity (mint)                 | —                     |
| `env-wants`      | `#EFA9D6` | Wants identity (orchid)                 | 10.09 : 1             |

Note `env-needs` deliberately shares the accent lavender (same trade-off the honey palette made): Needs is the app's center of gravity. If Needs cards ever read as "buttons," shift Needs to a deeper violet like `#9A7FE0` and re-run the contrast script. `negative` (rose-red) vs `env-wants` (orchid-pink) are neighbors — keep negative for amounts/errors only, wants for identity dots/bars only, and they never sit side by side ambiguously.

### Type & shape

- **Typeface:** Inter, self-hosted via Fontsource (CSP-friendly, no external requests), fallback `system-ui`. Coziness comes from color, spacing, and rounded shapes — not a novelty font. All amounts use `font-variant-numeric: tabular-nums` so columns of money align. Optional garnish later: Nunito Sans for headings.
- **Scale (mobile-first, px/line-height):** balance hero 34/40 semibold · amount-lg 28/34 semibold · title 20/28 semibold · body 16/24 · secondary 14/20 · caption 12/16.
- **Shape:** 16 px card radius, 12 px buttons, 24 px top radius on bottom sheets; min 44 px tap targets; bottom nav + Add button in the thumb zone.
- **Motion:** 150–200 ms ease-out on sheets; none on data updates (numbers just change — it's a ledger, not a slot machine).

---

## 7. Risk list — top 5, blunt

1. **You stop logging. (The #1 killer — not a bug, a habit.)** Every abandoned tracker died here. _Mitigation:_ Phase 3 is ruthlessly optimized for 2-tap entry; installable icon in Phase 3, not Phase 6; backdating for forgotten days; dogfooding starts at end of Phase 3, not when it's "done." If entry ever takes >5 s, that's a P0 bug.
2. **Offline sync scope creep.** A solo dev building a general sync engine is a tar pit; this is where the project quietly dies in month 3. _Mitigation:_ app is fully usable online-only through Phase 5; Phase 6 is strictly mirror + outbox + delta pull; append-only + client UUIDs means there is no conflict resolution to build. If Phase 6 exceeds ~6 evenings, stop and ship online-only — it's already a complete product.
3. **An RLS mistake exposes your finances on a public URL.** One table created without RLS is world-readable via the anon key. _Mitigation:_ RLS lives in the same migration as `CREATE TABLE`; the two-account probe test is written in Phase 2 and re-run after every migration; `service_role` never leaves the dashboard.
4. **Supabase free-tier project pause or loss.** Pauses after 7 days idle; free tier has no automated backups — a deleted project is gone. _Mitigation:_ keep-alive Action (₱0); migrations in the repo mean rebuild-from-zero is ~10 minutes; export button ships in Phase 3 and a monthly export reminder makes backups a habit. Your data outlives any Supabase project.
5. **Perfectionism before dogfood (solo student edition).** Tinkering with analytics colors in week 2 while expenses still can't be logged, then exams hit and the repo goes cold. _Mitigation:_ the phase order **is** the mitigation — nothing about polish precedes daily usability; every phase ends deployed; if a phase stalls, cut its scope, not the shipping.
