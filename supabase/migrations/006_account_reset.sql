-- Account reset — start over without making a new account (2026-08-04).
--
-- WHY THIS IS A FUNCTION AND NOT A SET OF DELETE POLICIES.
--
-- §1 rule 3 is the spine of this schema: the ledger is append-only, deletes do
-- not exist, and 001_core.sql enforces that by simply never writing a DELETE
-- policy for entries/envelopes/categories/profiles. That rule is what makes a
-- balance trustworthy — nobody, including the account's owner in a bad mood,
-- can quietly remove the one entry that makes the month look wrong.
--
-- "Wipe my account and start fresh" is a legitimate need that cannot be met
-- without deleting those rows, and the naive way to grant it is to add DELETE
-- policies. That would be a mistake: it hands out per-row deletion in order to
-- support one all-or-nothing operation, and every ledger guarantee in the app
-- would then rest on the client choosing not to use it (an XSS, a bad refactor
-- or a stray `.delete().eq('id', …)` would be enough).
--
-- So the tables stay undeletable and this security-definer function is the ONE
-- door. It bypasses RLS by design — which is exactly why it takes no arguments:
-- there is no id, no table name, no filter to pass. It scopes everything to
-- auth.uid() itself, so the only thing a caller can ever express is "delete all
-- of MY data", and the only privilege escalation available is against yourself.
--
-- Being one plpgsql call, it is also one transaction: either the whole account
-- is cleared or nothing is. A half-reset account — entries gone, envelopes left
-- — would be worse than either outcome.
--
-- WHAT IT DELIBERATELY DOES NOT TOUCH: auth.users. The login, the password and
-- any enrolled MFA factor all survive, because this is "empty the tin", not
-- "close the account". Deleting the user is a Supabase-dashboard action and
-- needs the service_role key, which by §3's rules never reaches the client.

create or replace function public.reset_account()
returns jsonb
language plpgsql
security definer
-- Empty search_path is mandatory for a security-definer function: without it a
-- caller could prepend a schema of their own and have `entries` resolve to a
-- table they control, running this function's privileges against it. Every
-- object below is therefore fully qualified.
set search_path = ''
as $$
declare
  uid             uuid;
  n_entries       bigint;
  n_recurring     bigint;
  n_categories    bigint;
  n_envelopes     bigint;
  n_checkins      bigint;
  n_streak_saves  bigint;
begin
  uid := auth.uid();
  -- Belt and braces. `user_id = null` matches no rows, so an anonymous call
  -- would already be a harmless no-op — but a no-op that reports success is how
  -- a caller ends up believing their data is gone when it is not.
  if uid is null then
    raise exception 'reset_account requires a signed-in user'
      using errcode = '28000';
  end if;

  -- ORDER IS FK-DICTATED, not stylistic. entries carry composite ownership FKs
  -- to both categories and envelopes with ON DELETE RESTRICT (§3), and
  -- categories carry one to envelopes, so the ledger has to go first and the
  -- envelopes last. recurring_templates only SET NULLs its category on delete,
  -- but clearing it before categories saves Postgres a pointless rewrite of
  -- rows that are about to be deleted anyway.
  delete from public.entries where user_id = uid;
  get diagnostics n_entries = row_count;

  delete from public.recurring_templates where user_id = uid;
  get diagnostics n_recurring = row_count;

  delete from public.categories where user_id = uid;
  get diagnostics n_categories = row_count;

  delete from public.envelopes where user_id = uid;
  get diagnostics n_envelopes = row_count;

  -- The habit tables. Not money, but they describe the person just as plainly:
  -- a streak is a record of which days you opened the app.
  delete from public.checkin_days where user_id = uid;
  get diagnostics n_checkins = row_count;

  delete from public.streak_saves where user_id = uid;
  get diagnostics n_streak_saves = row_count;

  -- The profile ROW survives (client seeding upserts it and everything assumes
  -- it exists); the one field a user ever authors into it does not.
  update public.profiles set display_name = null where id = uid;

  -- Counts, so the client can report what actually happened instead of assuring
  -- the user that something did. A reset that silently deleted nothing — wrong
  -- session, RLS quirk, already-empty account — must not read as a success.
  return jsonb_build_object(
    'entries',      n_entries,
    'recurring',    n_recurring,
    'categories',   n_categories,
    'envelopes',    n_envelopes,
    'checkins',     n_checkins,
    'streak_saves', n_streak_saves
  );
end;
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default, and both
-- `anon` and `authenticated` inherit from PUBLIC — so without this revoke, a
-- logged-out visitor could call it. (Harmlessly, since auth.uid() is null and
-- the guard above raises, but an RLS-bypassing entry point should not be
-- reachable without a session in the first place.)
revoke execute on function public.reset_account() from public;
revoke execute on function public.reset_account() from anon;
grant  execute on function public.reset_account() to authenticated;

-- No new policies, no new grants on any table: the point of this migration is
-- that the tables remain exactly as undeletable as they were. Re-run the RLS
-- probe after applying it — the assertion that user B cannot delete user A's
-- rows must still pass, and B calling reset_account() must clear only B.
