-- Money type — the column the feature was already shipping against (2026-08-04).
--
-- `entries.money_type` is declared in 001_core.sql, but it was EDITED INTO that
-- file in commit 0eb8ae1, long after 001 had been applied. A migration already
-- run is a historical record, not a spec: editing it changes what a fresh
-- database gets and nothing at all about an existing one. So every database
-- created before that commit — which is every real one — has been missing the
-- column while the client wrote to it.
--
-- The symptom was not an error, which is what made it expensive. `pushInsertEntries`
-- catches the 42703 and retries with the field stripped, so writes kept
-- succeeding with the tag quietly discarded; the pull never selected the column
-- at all, and the mirror's `bulkPut` then overwrote the locally-tagged row with
-- an untagged one. A money type survived roughly one sync pass. Everything
-- downstream read a ledger where nothing was ever tagged.
--
-- `if not exists` throughout, so this is a no-op on a database created from the
-- edited 001 and the fix on one created from the original. Both are real and
-- there is no way to tell them apart from here.

alter table public.entries
  add column if not exists money_type text;

-- Added separately and only when missing: `add column` above skips its inline
-- constraint entirely on a database that already has the column, which would
-- leave exactly the pre-0eb8ae1 databases this migration exists for without the
-- check. Named explicitly so this block is idempotent.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.entries'::regclass
      and conname = 'entries_money_type_check'
  ) then
    alter table public.entries
      add constraint entries_money_type_check
      check (money_type in ('online', 'reallife'));
  end if;
end $$;

-- Nullable, and deliberately so: null means "not tagged", which is a real and
-- permanent state for this ledger. Every entry written before the feature
-- existed is untagged and always will be — there is no honest backfill, because
-- the app cannot know whether a coffee in March was paid in cash or GCash.
-- Guessing would put invented money in a bucket the user reads as fact.
--
-- The client surfaces untagged money as its own line rather than folding it into
-- either bucket, so `online + reallife + untagged` always reconciles with the
-- tin total. See lib/money-type.ts.

-- ============ recurring templates ============
--
-- A template posts unattended, so it cannot ask which bucket at post time — the
-- choice has to be stored with the template. Rent is paid the same way every
-- month; that is what makes it a template in the first place.
--
-- Null here means the same thing it means on an entry: not tagged. An existing
-- template keeps posting untagged money until its owner edits it, which is the
-- honest default — the alternative is picking a bucket on the user's behalf and
-- being silently wrong every month.
alter table public.recurring_templates
  add column if not exists money_type text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.recurring_templates'::regclass
      and conname = 'recurring_templates_money_type_check'
  ) then
    alter table public.recurring_templates
      add constraint recurring_templates_money_type_check
      check (money_type in ('online', 'reallife'));
  end if;
end $$;

-- No RLS changes: both tables already scope every policy to auth.uid() = user_id,
-- and a new column inherits that.
--
-- No new grants either, and on `entries` that is load-bearing rather than
-- incidental. 001 revokes UPDATE table-wide and grants it back for exactly
-- (voided_at, void_reason); a column added afterwards is therefore NOT updatable
-- by `authenticated`, which is precisely the append-only rule §1 asks for — a
-- money type is set when the entry is written and revised by voiding and
-- re-entering, like every other field on the row. INSERT was granted at table
-- level and so covers this column automatically.
