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
