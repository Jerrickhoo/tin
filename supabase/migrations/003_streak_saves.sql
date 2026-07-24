-- Streak repair saves (2026-07-24).
--
-- A save is the record that a day with no entries should nonetheless count
-- toward the logging streak. Three per Philippine calendar month, spent
-- deliberately from Home when a single missed day breaks an otherwise intact
-- run. See src/lib/logging-streak.ts for the rules; this table only stores
-- which days were bought back.
--
-- WHY A TABLE AND NOT localStorage: logout wipes IndexedDB and the caches
-- (db/cacheWipe.ts), so anything kept client-side dies on the next device
-- switch — and a streak you can lose by signing in elsewhere is worse than no
-- streak at all. WHY NOT THE LEDGER: a save is not money. Phase 7 already
-- rejected writing habit state into entries (the export reminder was kept out
-- of the ledger for the same reason); a non-money row in an append-only money
-- log would corrupt every balance and export it touched.
--
-- The whole table is at most 36 rows per user per year, so sync pulls it whole
-- (remote.ts pullStreakSaves) exactly like envelopes and categories. No
-- keyset cursor, no delta window.

create table public.streak_saves (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- The Philippine calendar day being bought back, as a date rather than a
  -- timestamp: this is a day key, not an instant, and storing it as one keeps
  -- the "3 per month" budget a plain `substring(day_key, 1, 7)` on both sides
  -- of the wire with no timezone conversion to get wrong.
  day_key    date not null,
  created_at timestamptz not null default now(),
  -- Idempotent by construction: repairing the same day twice is a no-op rather
  -- than a second charge against the month's budget. The client re-inserts
  -- freely (it cannot always know whether an earlier attempt landed).
  primary key (user_id, day_key)
);

-- The PK's leading user_id already indexes every query this table serves
-- (always "all saves for me"), so no additional index is created.

-- ============ RLS ============
alter table public.streak_saves enable row level security;

create policy streak_saves_select on public.streak_saves
  for select using (auth.uid() = user_id);
create policy streak_saves_insert on public.streak_saves
  for insert with check (auth.uid() = user_id);
create policy streak_saves_delete on public.streak_saves
  for delete using (auth.uid() = user_id);

-- A DELETE policy exists here, unlike everywhere else in this schema, and the
-- exception is deliberate. Elsewhere "delete" is denied because the rows are
-- financial history that must never vanish. A save is neither money nor
-- history — it is a reversible choice about a habit counter, and the user must
-- be able to take one back if they spend it on the wrong day. Nothing
-- references these rows, so a delete cannot orphan anything.
--
-- There is deliberately NO update policy: a save is a fact about one specific
-- day. Moving it to another day is delete + insert, which correctly re-checks
-- the budget for both months.

-- ============ APPEND-ONLY-ISH (column grants) ============
-- Nothing about an existing save may be edited; the row is its own statement.
revoke update on public.streak_saves from authenticated;

-- The budget itself is NOT enforced here. Like "envelope shares sum to 10000"
-- (001_core.sql), the rule lives in src/lib/logging-streak.ts, because a
-- per-month row-count check needs a trigger and the only account that could
-- cheat it is the user's own — there is no adversary to defend against, and
-- the cost of a wrong trigger (a locked-out repair) is worse than the cost of
-- the rule being client-side (a streak number that flatters its owner).
