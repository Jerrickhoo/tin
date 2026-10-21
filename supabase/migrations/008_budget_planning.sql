-- Budget events share the immutable, owner-scoped audit/outbox protocol.
-- No second cash ledger: assignments refer to an income correction chain.
begin;

create index ledger_audit_budget_key on public.ledger_audit(user_id, (details->'budget'->>'key')) where details ? 'budget';

create function public.validate_budget_event(e jsonb, p_uid uuid) returns void
language plpgsql set search_path = '' as $$
declare typ text:=e->>'type'; identity_id uuid; allowed text[]; d text; n numeric;
begin
  if jsonb_typeof(e) is distinct from 'object' or coalesce(e->>'month','') !~ '^(20[0-9]{2}|21[0-9]{2})-(0[1-9]|1[0-2])$'
    or not (e ? 'previous_event_id') then raise exception 'Invalid budget event' using errcode='23514'; end if;
  if e->>'previous_event_id' is not null and e->>'previous_event_id' is distinct from ((e->>'previous_event_id')::uuid)::text then raise exception 'Invalid budget predecessor' using errcode='23514'; end if;
  if typ='assignment' then
    identity_id:=(e->>'receipt_chain_id')::uuid; allowed:=array['receipt_chain_id'];
  elsif typ='expected' then
    identity_id:=(e->>'plan_id')::uuid; allowed:=array['plan_id','amount_centavos','envelope_id','note','state','receipt_chain_id'];
    n:=(e->>'amount_centavos')::numeric;
    if jsonb_typeof(e->'amount_centavos') is distinct from 'number' or n is null or n<>trunc(n) or n<=0 or n>99999999999999
      or jsonb_typeof(e->'note') is distinct from 'string' or length(e->>'note')>500 or coalesce(e->>'state','') not in ('expected','received','canceled')
      or not (e ? 'envelope_id') or not (e ? 'receipt_chain_id') then raise exception 'Invalid expected allowance' using errcode='23514'; end if;
    if e->>'state'='received' then
      if e->>'receipt_chain_id' is null then raise exception 'Missing received link' using errcode='23514'; end if;
      if e->>'receipt_chain_id' is distinct from ((e->>'receipt_chain_id')::uuid)::text then raise exception 'Invalid receipt identity' using errcode='23514'; end if;
    elsif e->>'receipt_chain_id' is not null then raise exception 'Unexpected received link' using errcode='23514'; end if;
  elsif typ='schedule' then
    identity_id:=(e->>'envelope_id')::uuid; allowed:=array['envelope_id','weekdays','remaining_days','excluded','extra'];
    if not (e ? 'weekdays') or not (e ? 'remaining_days') then raise exception 'Incomplete schedule' using errcode='23514'; end if;
    if e->'weekdays'<>'null'::jsonb then
      if jsonb_typeof(e->'weekdays') is distinct from 'array' then raise exception 'Invalid weekdays' using errcode='23514'; end if;
      if jsonb_array_length(e->'weekdays')>7 or exists(select 1 from jsonb_array_elements(e->'weekdays') x where jsonb_typeof(x)<>'number' or x::text !~ '^[0-6]$')
        or (select count(*)<>count(distinct x) from jsonb_array_elements(e->'weekdays') x) then raise exception 'Invalid weekdays' using errcode='23514'; end if;
    end if;
    if e->'remaining_days'<>'null'::jsonb then
      n:=(e->>'remaining_days')::numeric;
      if jsonb_typeof(e->'remaining_days') is distinct from 'number' or n<>trunc(n) or n<0 or n>366 then raise exception 'Invalid remaining days' using errcode='23514'; end if;
    end if;
    foreach d in array array['excluded','extra'] loop
      if jsonb_typeof(e->d) is distinct from 'array' then raise exception 'Invalid exceptions' using errcode='23514'; end if;
      if jsonb_array_length(e->d)>31 or (select count(*)<>count(distinct x) from jsonb_array_elements(e->d) x) then raise exception 'Invalid exceptions' using errcode='23514'; end if;
      if exists(select 1 from jsonb_array_elements_text(e->d) x where x !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or left(x,7)<>e->>'month' or to_char(x::date,'YYYY-MM-DD')<>x) then raise exception 'Invalid exception date' using errcode='23514'; end if;
    end loop;
    if exists(select 1 from jsonb_array_elements_text(e->'excluded') a join jsonb_array_elements_text(e->'extra') b on a=b) then raise exception 'Conflicting exception date' using errcode='23514'; end if;
  else raise exception 'Unknown budget event' using errcode='23514'; end if;
  if identity_id is null or (case typ when 'assignment' then e->>'receipt_chain_id' when 'expected' then e->>'plan_id' else e->>'envelope_id' end) is distinct from identity_id::text or e->>'key' is distinct from typ||':'||identity_id::text or exists(select 1 from jsonb_object_keys(e) k where k<>all(array['type','key','previous_event_id','month']||allowed)) then raise exception 'Invalid budget identity' using errcode='23514'; end if;
  if typ='expected' and e->>'envelope_id' is not null and e->>'envelope_id' is distinct from ((e->>'envelope_id')::uuid)::text then raise exception 'Invalid envelope identity' using errcode='23514'; end if;
  if typ in ('schedule','expected') and e->>'envelope_id' is not null and not exists(select 1 from public.envelopes where user_id=p_uid and id=(e->>'envelope_id')::uuid) then raise exception 'Budget envelope ownership' using errcode='23514'; end if;
end $$;
revoke all on function public.validate_budget_event(jsonb,uuid) from public,anon,authenticated;

create function public.validate_budget_history(p_uid uuid) returns void
language plpgsql set search_path = '' as $$
declare r record; n bigint; reachable bigint; previous jsonb;
begin
  for r in select id,details->'budget' e from public.ledger_audit where user_id=p_uid and details ? 'budget' loop
    perform public.validate_budget_event(r.e,p_uid);
    if r.e->>'previous_event_id' is not null and not exists(select 1 from public.ledger_audit p where p.user_id=p_uid and p.id=(r.e->>'previous_event_id')::uuid and p.details->'budget'->>'key'=r.e->>'key') then raise exception 'Missing budget predecessor' using errcode='23514'; end if;
    if r.e->>'type'='expected' then
      select details->'budget' into previous from public.ledger_audit where user_id=p_uid and id=(r.e->>'previous_event_id')::uuid;
      if (previous is null and r.e->>'state'<>'expected') or (previous is not null and previous->>'state'<>'expected') then raise exception 'Invalid expected history' using errcode='23514'; end if;
      if r.e->>'state'='received' and (previous-array['state','receipt_chain_id','previous_event_id'])<>(r.e-array['state','receipt_chain_id','previous_event_id']) then raise exception 'Received plan mismatch' using errcode='23514'; end if;
    end if;
    if r.e->>'type'='assignment' or (r.e->>'type'='expected' and r.e->>'state'='received') then
      if not exists(select 1 from public.entries e where e.user_id=p_uid and e.group_id=(r.e->>'receipt_chain_id')::uuid and coalesce(e.financial->>'intent',case e.kind when 'income' then 'ordinary_income' end)='ordinary_income') then raise exception 'Missing income receipt' using errcode='23514'; end if;
    end if;
  end loop;
  if exists(select 1 from public.ledger_audit where user_id=p_uid and details ? 'budget' group by details->'budget'->>'key',details->'budget'->>'previous_event_id' having count(*)>1) then raise exception 'Conflicting budget history' using errcode='23514'; end if;
  select count(*) into n from public.ledger_audit where user_id=p_uid and details ? 'budget';
  with recursive events as (select id,details->'budget' e from public.ledger_audit where user_id=p_uid and details ? 'budget'), walk as (
    select id,e from events where e->>'previous_event_id' is null
    union all select e.id,e.e from events e join walk w on e.e->>'previous_event_id'=w.id::text
  ) select count(*) into reachable from walk;
  if n<>reachable then raise exception 'Budget history cycle' using errcode='23514'; end if;
  if exists(select 1 from public.ledger_audit where user_id=p_uid and details->'budget'->>'type'='expected' and details->'budget'->>'state'='received' group by details->'budget'->>'receipt_chain_id' having count(*)>1) then raise exception 'Duplicate expected receipt' using errcode='23514'; end if;
end $$;
revoke all on function public.validate_budget_history(uuid) from public,anon,authenticated;

alter function public.apply_financial_operation(jsonb) rename to apply_financial_operation_before_budget;
revoke all on function public.apply_financial_operation_before_budget(jsonb) from public,anon,authenticated;
create function public.apply_financial_operation(p_operation jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=auth.uid(); event jsonb:=p_operation->'budget_event'; previous public.ledger_audit; old_event jsonb; chain uuid; actual numeric; prior public.ledger_operations;
begin
  if uid is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'x-client-info','')<>'tin-ledger/2' then raise exception 'Refresh Tin before writing to the upgraded ledger' using errcode='P0001'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text,7107));
  select * into prior from public.ledger_operations where id=(p_operation->>'id')::uuid;
  if found then perform public.apply_financial_operation_before_budget(p_operation); return; end if;
  if event is not null then
    perform public.validate_budget_event(event,uid);
    if p_operation->>'action' not in ('post','correct') then raise exception 'Invalid budget command' using errcode='23514'; end if;
    select * into previous from public.ledger_audit a where a.user_id=uid and a.details->'budget'->>'key'=event->>'key'
      and not exists(select 1 from public.ledger_audit b where b.user_id=uid and b.details->'budget'->>'previous_event_id'=a.id::text);
    if previous.id is distinct from (event->>'previous_event_id')::uuid then raise exception 'Stale budget preview' using errcode='23514'; end if;
    old_event:=previous.details->'budget';
    if event->>'type'='expected' and old_event is not null and old_event->>'state'<>'expected' then raise exception 'Expected allowance already closed' using errcode='23514'; end if;
    if event->>'type'<>'assignment' and not (event->>'type'='expected' and event->>'state'='received') and jsonb_array_length(p_operation->'rows')<>0 then raise exception 'Planning cannot move money' using errcode='23514'; end if;
    if event->>'type'='assignment' and exists(select 1 from jsonb_array_elements(p_operation->'rows') x where coalesce(x->'financial'->>'chain_id',x->>'group_id')<>event->>'receipt_chain_id' or x->'financial'->>'intent'<>'ordinary_income') then raise exception 'Assignment receipt mismatch' using errcode='23514'; end if;
    if event->>'type'='expected' and event->>'state'='received' then
      if old_event is null or (old_event-array['state','receipt_chain_id','previous_event_id'])<>(event-array['state','receipt_chain_id','previous_event_id']) then raise exception 'Review the expected allowance first' using errcode='23514'; end if;
      if jsonb_array_length(p_operation->'rows')=0 or exists(select 1 from jsonb_array_elements(p_operation->'rows') x where x->>'group_id'<>event->>'receipt_chain_id' or x->'financial'->>'intent'<>'ordinary_income' or (event->>'envelope_id' is not null and x->>'envelope_id'<>event->>'envelope_id')) then raise exception 'Received allowance mismatch' using errcode='23514'; end if;
      select sum((x->>'amount_centavos')::numeric) into actual from jsonb_array_elements(p_operation->'rows') x;
      if actual<>(event->>'amount_centavos')::numeric then raise exception 'Received amount mismatch' using errcode='23514'; end if;
    end if;
  end if;
  perform public.apply_financial_operation_before_budget(p_operation);
  if event is not null then
    if event->>'type'='assignment' or (event->>'type'='expected' and event->>'state'='received') then
      chain:=(event->>'receipt_chain_id')::uuid;
      if not exists(select 1 from public.entries where user_id=uid and coalesce(financial->>'chain_id',group_id::text)=chain::text and voided_at is null)
        or exists(select 1 from public.entries where user_id=uid and coalesce(financial->>'chain_id',group_id::text)=chain::text and voided_at is null and coalesce(financial->>'intent',case kind when 'income' then 'ordinary_income' else 'other' end)<>'ordinary_income') then raise exception 'Choose an active income receipt' using errcode='23514'; end if;
    end if;
    update public.ledger_audit set details=details||jsonb_build_object('budget',event) where user_id=uid and id=(p_operation->>'id')::uuid;
  end if;
  if event is not null or p_operation->>'action'='import' then perform public.validate_budget_history(uid); end if;
end $$;
revoke all on function public.apply_financial_operation(jsonb) from public,anon;
grant execute on function public.apply_financial_operation(jsonb) to authenticated;

create function public.budget_capabilities() returns integer language sql stable set search_path = '' as $$ select 1 $$;
revoke all on function public.budget_capabilities() from public,anon;
grant execute on function public.budget_capabilities() to authenticated;

-- The entry compatibility trigger below retains 007's invariant checks and
-- advances the required client protocol to 2.
create or replace function public.guard_financial_entry() returns trigger language plpgsql security definer set search_path = '' as $$
declare g public.ledger_groups; existing public.entries;
begin
  -- Write compatibility guard, not authorization: RLS and the RPC still enforce
  -- ownership and semantics. Old cached clients must not run void-then-insert
  -- corrections beside the new atomic protocol. Current clients also stamp
  -- this header when replaying historical outbox payloads.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text,7107));
  -- Expand first: an account that has never used the new financial protocol
  -- may keep using its deployed legacy client during the migration/deploy gap.
  -- The first new financial record or budget plan closes that compatibility
  -- window atomically under the same owner lock. Refresh replays old outboxes
  -- with protocol 2; no financial meaning is ever stripped.
  if auth.uid() is not null and coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'x-client-info','')<>'tin-ledger/2'
    and (exists(select 1 from public.entries where user_id=new.user_id and financial is not null)
      or exists(select 1 from public.ledger_audit where user_id=new.user_id and details ? 'budget')) then
    raise exception 'Refresh Tin before writing to the upgraded ledger' using errcode='P0001';
  end if;
  if tg_op = 'INSERT' then
    select * into existing from public.entries where id = new.id;
    if found then
      if existing.user_id <> new.user_id then raise exception 'Entry ownership conflict' using errcode='23514'; end if;
      return new; -- ON CONFLICT DO NOTHING remains compatible with old outboxes.
    end if;
    select * into g from public.ledger_groups where id=new.group_id and user_id=new.user_id;
    if not found then
      if new.financial is not null then raise exception 'Financial command required' using errcode='23514'; end if;
      insert into public.ledger_groups(id,user_id) values(new.group_id,new.user_id) returning * into g;
    end if;
    if g.metadata is distinct from new.financial or g.created_xid <> txid_current() then
      raise exception 'Immutable group conflict' using errcode='23514';
    end if;
  else
    if new.voided_at is not distinct from old.voided_at and new.void_reason is not distinct from old.void_reason then return new; end if;
    if exists(select 1 from public.entries where user_id=new.user_id and financial->>'origin_group_id'=new.group_id::text)
      or exists(select 1 from public.obligations where user_id=new.user_id and origin_group_id=new.group_id and voided_at is null) then
      raise exception 'Resolve linked activity first' using errcode='23514';
    end if;
    if new.voided_at is null and exists(select 1 from public.ledger_groups where user_id=new.user_id and corrects_group_id=new.group_id) then
      raise exception 'Superseded originals cannot be restored' using errcode='23514';
    end if;
  end if;
  return new;
end $$;

notify pgrst, 'reload schema';
commit;
