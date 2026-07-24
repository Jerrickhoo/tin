-- Check-in days (2026-07-24).
--
-- A check-in records that Tin was opened on a given Philippine day. It keeps a
-- logging streak alive on days with nothing to log — which is the case this
-- feature exists for: a day you spend NOTHING is a good day, and the original
-- entry-only rule broke your streak for it. Frugality was being punished.
--
-- Distinct from streak_saves (003) rather than a `kind` column on it, and the
-- reason is the budget: saves are capped at 3 per month and that cap is a
-- simple row count per month. Folding unlimited check-ins into the same table
-- would make every budget check filter on kind, and the first place that
-- forgot to would silently lock the user out of repairs for the month.
--
-- Append-only in the strongest sense: no UPDATE, no DELETE. A day either was
-- opened or it was not, and neither is something to revise later. That also
-- means the local mirror never has to clear rows — it only ever merges, which
-- is what makes the offline path below safe.

create table public.checkin_days (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- Philippine calendar day, as a date not a timestamp: a day key, not an
  -- instant. Same reasoning as streak_saves.day_key.
  day_key    date not null,
  created_at timestamptz not null default now(),
  -- Idempotent by construction. The client writes locally first (so a day
  -- opened in a dead spot counts immediately) and pushes on the next sync, and
  -- that push is a blind upsert of anything the server has not got — it cannot
  -- know whether an earlier attempt landed, and with this key it never has to.
  primary key (user_id, day_key)
);

-- The PK's leading user_id already indexes the only query this table serves
-- ("all check-ins for me"), so no additional index is created.

-- ============ RLS ============
alter table public.checkin_days enable row level security;

create policy checkin_days_select on public.checkin_days
  for select using (auth.uid() = user_id);
create policy checkin_days_insert on public.checkin_days
  for insert with check (auth.uid() = user_id);

-- No UPDATE and no DELETE policy, matching the rest of the schema: these rows
-- are a record of what happened, and the only honest edit to that is none.
-- (streak_saves is the one exception in this database, and 003 argues its own
-- case; a check-in is not a spent resource, so nothing needs taking back.)

-- ============ APPEND-ONLY, ENFORCED (column grants) ============
revoke update on public.checkin_days from authenticated;
