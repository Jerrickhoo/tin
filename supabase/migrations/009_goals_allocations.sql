-- Immutable envelope reservations use the existing owner-locked command,
-- outbox, RLS, backup and reset lifecycle. They never insert cash movements.
begin;

create function public.goal_events(p_uid uuid) returns setof jsonb
language sql stable set search_path = '' as $$
  select e from public.ledger_audit a cross join lateral jsonb_array_elements(a.details->'goals') e where a.user_id=p_uid
$$;
create function public.goal_heads(p_uid uuid) returns setof jsonb
language sql stable set search_path = '' as $$
  select e from public.goal_events(p_uid) e where not exists(select 1 from public.goal_events(p_uid) n where n->>'previous_event_id'=e->>'id')
$$;
create function public.goal_amount(n jsonb, allow_zero boolean default false) returns numeric
language plpgsql immutable set search_path = '' as $$
declare v numeric;
begin
  if jsonb_typeof(n) is distinct from 'number' then raise exception 'Invalid goal amount' using errcode='23514'; end if;
  v:=n::text::numeric;
  if v<>trunc(v) or v<(case when allow_zero then 0 else 1 end) or v>99999999999999 then raise exception 'Invalid goal amount' using errcode='23514'; end if;
  return v;
end $$;
create function public.goal_income_month(p_uid uuid, chain text, fallback text) returns text
language sql stable set search_path = '' as $$
  select coalesce((select a.details->'budget'->>'month' from public.ledger_audit a
    where a.user_id=p_uid and a.details->'budget'->>'receipt_chain_id'=chain
      and (a.details->'budget'->>'type'='assignment' or (a.details->'budget'->>'type'='expected' and a.details->'budget'->>'state'='received'))
      and not exists(select 1 from public.ledger_audit n where n.user_id=p_uid and n.details->'budget'->>'previous_event_id'=a.id::text)
    order by case a.details->'budget'->>'type' when 'assignment' then 0 else 1 end limit 1),fallback)
$$;

create function public.validate_goal_event(e jsonb, p_uid uuid) returns void
language plpgsql set search_path = '' as $$
declare allowed text[]; typ text:=e->>'type'; k text; a jsonb; n numeric; total numeric; expected_key text;
begin
  allowed:=array['id','type','key','previous_event_id','envelope_id']||case typ
    when 'goal' then array['goal_id','name','target_centavos','mode','deadline','state']
    when 'split' then array['shares','unreserved_bp']
    when 'rule' then array['rule_id','goal_id','method','value','day','state']
    when 'capture' then array['receipt_chain_id','split_event_id','month','source_centavos','allocations']
    when 'reserve' then array['goal_id','amount_centavos','month']
    when 'release' then array['goal_id','amount_centavos']
    when 'purchase' then array['goal_id','purchase_chain_id']
    when 'occurrence' then array['rule_id','rule_event_id','goal_id','month','requested_centavos','amount_centavos']
    else null end;
  if jsonb_typeof(e) is distinct from 'object' or allowed is null or not (e ?& allowed) or exists(select 1 from jsonb_object_keys(e) x where x<>all(allowed)) then raise exception 'Unsupported goal event' using errcode='23514'; end if;
  foreach k in array array['id','envelope_id','goal_id','rule_id','receipt_chain_id','split_event_id','purchase_chain_id','rule_event_id'] loop
    if e ? k and (e->>k is null or e->>k is distinct from ((e->>k)::uuid)::text) then raise exception 'Invalid goal identity' using errcode='23514'; end if;
  end loop;
  if e->>'previous_event_id' is not null and e->>'previous_event_id' is distinct from ((e->>'previous_event_id')::uuid)::text then raise exception 'Invalid goal predecessor' using errcode='23514'; end if;
  if not exists(select 1 from public.envelopes where user_id=p_uid and id=(e->>'envelope_id')::uuid) then raise exception 'Goal envelope ownership' using errcode='23514'; end if;
  if e ? 'month' and coalesce(e->>'month','') !~ '^(20[0-9]{2}|21[0-9]{2})-(0[1-9]|1[0-2])$' then raise exception 'Invalid goal month' using errcode='23514'; end if;
  expected_key:=case typ when 'goal' then 'goal:'||(e->>'goal_id') when 'split' then 'split:'||(e->>'envelope_id')
    when 'rule' then 'rule:'||(e->>'rule_id') when 'capture' then 'capture:'||(e->>'receipt_chain_id')||':'||(e->>'envelope_id')
    when 'purchase' then 'purchase:'||(e->>'purchase_chain_id') when 'occurrence' then 'occurrence:'||(e->>'rule_id')||':'||(e->>'month')
    else typ||':'||(e->>'id') end;
  if e->>'key' is distinct from expected_key then raise exception 'Invalid goal key' using errcode='23514'; end if;
  if e ? 'amount_centavos' then perform public.goal_amount(e->'amount_centavos',typ='occurrence'); end if;
  if typ in ('reserve','release','purchase') and e->>'previous_event_id' is not null then raise exception 'Immutable goal action' using errcode='23514'; end if;
  if typ='goal' then
    perform public.goal_amount(e->'target_centavos');
    if jsonb_typeof(e->'name') is distinct from 'string' or length(btrim(e->>'name'))=0 or length(e->>'name')>100 or e->>'mode' not in ('one_time','ongoing') or e->>'state' not in ('active','held','closed','archived') or e->>'mode' is null or e->>'state' is null then raise exception 'Invalid goal definition' using errcode='23514'; end if;
    if e->>'deadline' is not null and ((e->>'deadline') !~ '^(20[0-9]{2}|21[0-9]{2})-[0-9]{2}-[0-9]{2}$' or to_char((e->>'deadline')::date,'YYYY-MM-DD')<>e->>'deadline') then raise exception 'Invalid deadline' using errcode='23514'; end if;
  elsif typ='split' then
    if jsonb_typeof(e->'shares') is distinct from 'array' or jsonb_array_length(e->'shares')>100 then raise exception 'Invalid child split' using errcode='23514'; end if;
    total:=public.goal_amount(e->'unreserved_bp',true);
    for a in select * from jsonb_array_elements(e->'shares') loop
      if jsonb_typeof(a) is distinct from 'object' or not (a ?& array['goal_id','bp']) or (select count(*) from jsonb_object_keys(a))<>2 or a->>'goal_id' is distinct from ((a->>'goal_id')::uuid)::text then raise exception 'Invalid split child' using errcode='23514'; end if;
      n:=public.goal_amount(a->'bp',true); if n>10000 then raise exception 'Invalid share' using errcode='23514'; end if;
      total:=total+n;
    end loop;
    if total<>10000 or (select count(*)<>count(distinct item->>'goal_id') from jsonb_array_elements(e->'shares') item) then raise exception 'Split must total 100 percent' using errcode='23514'; end if;
  elsif typ='rule' then
    n:=public.goal_amount(e->'value');
    if e->>'method' not in ('fixed','percent') or e->>'method' is null or e->>'state' not in ('active','paused') or e->>'state' is null or (e->>'method'='percent' and n>10000) or jsonb_typeof(e->'day') is distinct from 'number' or (e->>'day')::numeric<>trunc((e->>'day')::numeric) or (e->>'day')::numeric not between 1 and 31 then raise exception 'Invalid monthly rule' using errcode='23514'; end if;
  elsif typ='capture' then
    total:=0; n:=public.goal_amount(e->'source_centavos');
    if jsonb_typeof(e->'allocations') is distinct from 'array' or jsonb_array_length(e->'allocations')>100 then raise exception 'Invalid captured allocations' using errcode='23514'; end if;
    for a in select * from jsonb_array_elements(e->'allocations') loop
      if jsonb_typeof(a) is distinct from 'object' or not(a ?& array['goal_id','requested_centavos','amount_centavos']) or (select count(*) from jsonb_object_keys(a))<>3 or a->>'goal_id' is distinct from ((a->>'goal_id')::uuid)::text or public.goal_amount(a->'amount_centavos',true)>public.goal_amount(a->'requested_centavos',true) then raise exception 'Invalid captured funding' using errcode='23514'; end if;
      total:=total+(a->>'amount_centavos')::numeric;
    end loop;
    if total>n or (select count(*)<>count(distinct item->>'goal_id') from jsonb_array_elements(e->'allocations') item) then raise exception 'Receipt overallocated' using errcode='23514'; end if;
  elsif typ='occurrence' then
    if public.goal_amount(e->'amount_centavos',true)>public.goal_amount(e->'requested_centavos',true) then raise exception 'Occurrence overallocated' using errcode='23514'; end if;
  end if;
end $$;

create function public.goal_projection(p_uid uuid, p_env uuid, p_now timestamptz default now())
returns table(goal_id text, definition jsonb, reserved numeric, future numeric, spent numeric, released numeric, funded numeric, remaining_target numeric, shortfall numeric)
language plpgsql stable set search_path = '' as $$
declare g jsonb; e jsonb; a jsonb; n numeric; source numeric; current_month text:=to_char(p_now at time zone 'Asia/Manila','YYYY-MM'); allocation_month text;
begin
  for g in select h from public.goal_heads(p_uid) h where h->>'type'='goal' and h->>'envelope_id'=p_env::text loop
    goal_id:=g->>'goal_id'; definition:=g; funded:=0; future:=0; spent:=0; released:=0;
    for e in select h from public.goal_heads(p_uid) h where h->>'envelope_id'=p_env::text loop
      if e->>'type'='capture' then
        select x into a from jsonb_array_elements(e->'allocations') x where x->>'goal_id'=g->>'goal_id';
        if a is null then continue; end if;
        select greatest(0,coalesce(sum(amount_centavos::numeric),0)) into source from public.entries r where r.user_id=p_uid and r.envelope_id=p_env and r.voided_at is null and r.occurred_at<=p_now and coalesce(r.financial->>'chain_id',r.group_id::text)=e->>'receipt_chain_id';
        n:=trunc((a->>'amount_centavos')::numeric*least(source,(e->>'source_centavos')::numeric)/(e->>'source_centavos')::numeric);
        allocation_month:=public.goal_income_month(p_uid,e->>'receipt_chain_id',coalesce((select to_char(min(r.occurred_at) at time zone 'Asia/Manila','YYYY-MM') from public.entries r where r.user_id=p_uid and r.envelope_id=p_env and r.voided_at is null and coalesce(r.financial->>'chain_id',r.group_id::text)=e->>'receipt_chain_id'),e->>'month'));
        if allocation_month>current_month then future:=future+n; else funded:=funded+n; end if;
      elsif e->>'goal_id'=g->>'goal_id' then
        if e->>'type' in ('reserve','occurrence') then
          if e->>'month'>current_month then future:=future+(e->>'amount_centavos')::numeric; else funded:=funded+(e->>'amount_centavos')::numeric; end if;
        elsif e->>'type'='release' then released:=released+(e->>'amount_centavos')::numeric;
        elsif e->>'type'='purchase' then
          select greatest(0,-coalesce(sum(amount_centavos::numeric),0)) into n from public.entries r where r.user_id=p_uid and r.envelope_id=p_env and r.voided_at is null and r.occurred_at<=p_now and coalesce(r.financial->>'chain_id',r.group_id::text)=e->>'purchase_chain_id';
          spent:=spent+n;
        end if;
      end if;
    end loop;
    reserved:=greatest(0,funded-released-spent); shortfall:=greatest(0,released+spent-funded);
    remaining_target:=case when g->>'mode'='ongoing' then 9007199254740991 else greatest(0,(g->>'target_centavos')::numeric-reserved-future-spent) end;
    if g->>'state' in ('closed','archived') then reserved:=0; future:=0; end if;
    if greatest(funded,future,spent,released,reserved,shortfall)>9007199254740991 then raise exception 'Goal accumulation too large' using errcode='23514'; end if;
    return next;
  end loop;
end $$;
create function public.goal_free(p_uid uuid, p_env uuid, p_now timestamptz default now()) returns numeric
language sql stable set search_path = '' as $$
  select greatest(0,coalesce((select sum(amount_centavos::numeric) from public.entries r where r.user_id=p_uid and r.envelope_id=p_env and r.voided_at is null and r.occurred_at<=p_now),0)
    -coalesce((select sum(amount_centavos::numeric) from public.entries r where r.user_id=p_uid and r.envelope_id=p_env and r.voided_at is null and r.occurred_at<=p_now and coalesce(r.financial->>'intent',case r.kind when 'income' then 'ordinary_income' end)='ordinary_income'
      and public.goal_income_month(p_uid,coalesce(r.financial->>'chain_id',r.group_id::text),to_char(r.occurred_at at time zone 'Asia/Manila','YYYY-MM'))>to_char(p_now at time zone 'Asia/Manila','YYYY-MM')),0)
    -coalesce((select sum(reserved) from public.goal_projection(p_uid,p_env,p_now)),0))
$$;

create function public.validate_goal_history(p_uid uuid) returns void
language plpgsql set search_path = '' as $$
declare e jsonb; previous jsonb; reference jsonb; gid text; n bigint; reachable bigint;
begin
  if exists(select 1 from public.ledger_audit where user_id=p_uid and details ? 'goals' and jsonb_typeof(details->'goals') is distinct from 'array') then raise exception 'Invalid goal history' using errcode='23514'; end if;
  for e in select * from public.goal_events(p_uid) loop
    perform public.validate_goal_event(e,p_uid);
    select p into previous from public.goal_events(p_uid) p where p->>'id'=e->>'previous_event_id';
    if e->>'previous_event_id' is not null and (previous is null or previous->>'key'<>e->>'key' or previous->>'envelope_id'<>e->>'envelope_id') then raise exception 'Missing goal predecessor' using errcode='23514'; end if;
    if e->>'type'='goal' and previous is not null and (previous->>'mode'<>e->>'mode' or (previous->>'state' in ('closed','archived') and e->>'state'<>'archived')) then raise exception 'Closed goal or changed identity' using errcode='23514'; end if;
    for gid in select e->>'goal_id' where e ? 'goal_id' and e->>'type'<>'goal'
      union all select x->>'goal_id' from jsonb_array_elements(case when e->>'type'='split' then e->'shares' when e->>'type'='capture' then e->'allocations' else '[]'::jsonb end) x loop
      if not exists(select 1 from public.goal_heads(p_uid) g where g->>'type'='goal' and g->>'goal_id'=gid and g->>'envelope_id'=e->>'envelope_id') then raise exception 'Foreign goal reference' using errcode='23514'; end if;
    end loop;
    if e->>'type'='capture' then
      select r into reference from public.goal_events(p_uid) r where r->>'id'=e->>'split_event_id' and r->>'type'='split' and r->>'envelope_id'=e->>'envelope_id';
      if reference is null or (select jsonb_agg(a->>'goal_id' order by ord) from jsonb_array_elements(e->'allocations') with ordinality t(a,ord)) is distinct from (select jsonb_agg(a->>'goal_id' order by ord) from jsonb_array_elements(reference->'shares') with ordinality t(a,ord)) then raise exception 'Missing captured rule' using errcode='23514'; end if;
      if not exists(select 1 from public.entries r where r.user_id=p_uid and r.group_id=(e->>'receipt_chain_id')::uuid and coalesce(r.financial->>'intent',case r.kind when 'income' then 'ordinary_income' end)='ordinary_income') then raise exception 'Missing funding receipt' using errcode='23514'; end if;
    elsif e->>'type'='purchase' then
      if not exists(select 1 from public.entries r where r.user_id=p_uid and r.envelope_id=(e->>'envelope_id')::uuid and coalesce(r.financial->>'chain_id',r.group_id::text)=e->>'purchase_chain_id' and coalesce(r.financial->>'intent',case r.kind when 'expense' then 'purchase' end)='purchase') then raise exception 'Missing goal purchase' using errcode='23514'; end if;
    elsif e->>'type'='rule' and previous is not null and previous->>'goal_id'<>e->>'goal_id' then raise exception 'Changed rule identity' using errcode='23514';
    elsif e->>'type'='occurrence' then
      if not exists(select 1 from public.goal_events(p_uid) r where r->>'type'='rule' and r->>'id'=e->>'rule_event_id' and r->>'rule_id'=e->>'rule_id' and r->>'goal_id'=e->>'goal_id' and r->>'envelope_id'=e->>'envelope_id') then raise exception 'Missing monthly rule' using errcode='23514'; end if;
      if previous is not null and ((previous-array['id','previous_event_id','amount_centavos'])<>(e-array['id','previous_event_id','amount_centavos']) or (e->>'amount_centavos')::numeric<(previous->>'amount_centavos')::numeric) then raise exception 'Rewritten occurrence' using errcode='23514'; end if;
    end if;
  end loop;
  if exists(select 1 from public.goal_events(p_uid) ev group by ev->>'id' having count(*)>1) or exists(select 1 from public.goal_events(p_uid) ev group by ev->>'key',ev->>'previous_event_id' having count(*)>1) then raise exception 'Conflicting goal history' using errcode='23514'; end if;
  select count(*) into n from public.goal_events(p_uid);
  with recursive events(ev) as (select * from public.goal_events(p_uid)), walk(ev) as (
    select ev from events where ev->>'previous_event_id' is null
    union all select v.ev from events v join walk w on v.ev->>'previous_event_id'=w.ev->>'id'
  ) select count(*) into reachable from walk;
  if reachable<>n then raise exception 'Goal history cycle' using errcode='23514'; end if;
end $$;

alter function public.apply_financial_operation(jsonb) rename to apply_financial_operation_before_goals;
revoke all on function public.apply_financial_operation_before_goals(jsonb) from public,anon,authenticated;
create function public.apply_financial_operation(p_operation jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=auth.uid(); e jsonb; old jsonb; g record; parent public.envelopes; rule jsonb; a jsonb; share jsonb;
  typ text; at_time timestamptz:=now(); current_month text:=to_char(now() at time zone 'Asia/Manila','YYYY-MM');
  prior public.ledger_operations; events jsonb:=coalesce(p_operation->'goal_events','[]'::jsonb); free numeric; source numeric; requested numeric; funded numeric; additional numeric; allocation_month text;
  portions numeric[]; remainders numeric[]; idx integer; winner integer; leftover integer; total_bp integer; same_goals boolean; action text:=p_operation->>'action'; old_context text;
begin
  if uid is null then raise exception 'Authentication required' using errcode='28000'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text,7107));
  select * into prior from public.ledger_operations where id=(p_operation->>'id')::uuid;
  if found then perform public.apply_financial_operation_before_goals(p_operation); return; end if;
  if jsonb_typeof(events) is distinct from 'array' or jsonb_array_length(events)>100 then raise exception 'Invalid goal commands' using errcode='23514'; end if;
  if (jsonb_array_length(events)>0 or exists(select 1 from public.ledger_audit where user_id=uid and details ? 'goals') or exists(select 1 from jsonb_array_elements(coalesce(p_operation->'audit','[]')) x where x->'details' ? 'goals'))
    and coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'x-tin-goals','')<>'1' then raise exception 'Refresh Tin before using goals' using errcode='P0001'; end if;
  if jsonb_array_length(events)>0 and action<>'post' then raise exception 'Invalid goal command action' using errcode='23514'; end if;
  old_context:=current_setting('tin.goal_operation',true);
  perform set_config('tin.goal_operation',uid::text,true);
  perform public.apply_financial_operation_before_goals(p_operation);
  for e in select * from jsonb_array_elements(events) loop
    perform public.validate_goal_event(e,uid); typ:=e->>'type';
    select h into old from public.goal_heads(uid) h where h->>'key'=e->>'key';
    if old->>'id' is distinct from e->>'previous_event_id' then raise exception 'Stale goal preview' using errcode='23514'; end if;
    select * into parent from public.envelopes where user_id=uid and id=(e->>'envelope_id')::uuid;
    if parent.archived_at is not null and (typ not in ('release','goal') or (typ='goal' and e->>'state' in ('active','held'))) then raise exception 'Archived goal parent' using errcode='23514'; end if;
    select * into g from public.goal_projection(uid,(e->>'envelope_id')::uuid,at_time) x where x.goal_id=e->>'goal_id';
    if typ='goal' then
      if old is not null and (old->>'mode'<>e->>'mode' or (old->>'state' in ('closed','archived') and e->>'state'<>'archived')) then raise exception 'Closed goal' using errcode='23514'; end if;
    elsif typ in ('reserve','release','purchase','rule','occurrence') then
      if g.goal_id is null then raise exception 'Missing owned goal' using errcode='23514'; end if;
      if typ='reserve' and (g.definition->>'state'<>'active' or e->>'month'<>current_month or (e->>'amount_centavos')::numeric>least(g.remaining_target,public.goal_free(uid,parent.id,at_time))) then raise exception 'Insufficient free goal funds' using errcode='23514'; end if;
      if typ='release' and (e->>'amount_centavos')::numeric>g.reserved then raise exception 'Excess goal release' using errcode='23514'; end if;
      if typ='purchase' and (g.definition->>'state' not in ('active','held') or jsonb_array_length(p_operation->'rows')=0 or exists(select 1 from jsonb_array_elements(p_operation->'rows') r where r->>'envelope_id'<>e->>'envelope_id' or r->'financial'->>'intent'<>'purchase' or r->'financial'->>'chain_id'<>e->>'purchase_chain_id')) then raise exception 'Goal purchase must match actual expense' using errcode='23514'; end if;
      if typ='rule' and old is not null and old->>'goal_id'<>e->>'goal_id' then raise exception 'Changed rule identity' using errcode='23514'; end if;
      if typ='occurrence' then
        select h into rule from public.goal_heads(uid) h where h->>'key'='rule:'||(e->>'rule_id');
        if rule is null or rule->>'state'<>'active' or rule->>'goal_id'<>e->>'goal_id' or g.definition->>'state'<>'active' or e->>'month'>current_month then raise exception 'Closed monthly rule' using errcode='23514'; end if;
        if old is null then
          select coalesce(sum(amount_centavos::numeric),0) into source from public.entries r where r.user_id=uid and r.envelope_id=parent.id and r.voided_at is null and r.occurred_at<=at_time and coalesce(r.financial->>'intent',case r.kind when 'income' then 'ordinary_income' end)='ordinary_income' and public.goal_income_month(uid,coalesce(r.financial->>'chain_id',r.group_id::text),to_char(r.occurred_at at time zone 'Asia/Manila','YYYY-MM'))=e->>'month';
          requested:=case when rule->>'method'='fixed' then (rule->>'value')::numeric else trunc(source*(rule->>'value')::numeric/10000) end; funded:=0;
        else requested:=(old->>'requested_centavos')::numeric; funded:=(old->>'amount_centavos')::numeric; end if;
        additional:=greatest(0,least(requested-funded,g.remaining_target,public.goal_free(uid,parent.id,at_time)));
        if e->>'rule_event_id'<>coalesce(old->>'rule_event_id',rule->>'id') or (e->>'requested_centavos')::numeric<>requested or (e->>'amount_centavos')::numeric<>funded+additional or (old is not null and additional=0) then raise exception 'Stale monthly allocation' using errcode='23514'; end if;
      end if;
    elsif typ='capture' then
      select h into rule from public.goal_heads(uid) h where h->>'key'='split:'||(e->>'envelope_id');
      if rule is null or rule->>'id'<>e->>'split_event_id' then raise exception 'Stale income split' using errcode='23514'; end if;
      if old is null then
        if not exists(select 1 from jsonb_array_elements(p_operation->'rows') r where r->>'group_id'=e->>'receipt_chain_id' and r->'financial'->>'intent'='ordinary_income') then raise exception 'Only new income is eligible' using errcode='23514'; end if;
      else
        if old->>'month'<=current_month or public.goal_income_month(uid,e->>'receipt_chain_id',old->>'month')<=current_month then raise exception 'Consumed assignment' using errcode='23514'; end if;
        if exists(select 1 from public.goal_projection(uid,parent.id,at_time) x where (x.spent>0 or x.released>0) and exists(select 1 from jsonb_array_elements(old->'allocations') allocation where allocation->>'goal_id'=x.goal_id)) then raise exception 'Consumed assignment' using errcode='23514'; end if;
      end if;
      select coalesce(sum(amount_centavos::numeric),0) into source from public.entries r where r.user_id=uid and r.envelope_id=parent.id and r.voided_at is null and r.occurred_at<=at_time and coalesce(r.financial->>'chain_id',r.group_id::text)=e->>'receipt_chain_id';
      allocation_month:=public.goal_income_month(uid,e->>'receipt_chain_id',to_char((select min(occurred_at) from public.entries where user_id=uid and group_id=(e->>'receipt_chain_id')::uuid) at time zone 'Asia/Manila','YYYY-MM'));
      if source<=0 or source<>(e->>'source_centavos')::numeric or allocation_month<>e->>'month' then raise exception 'Stale funding receipt' using errcode='23514'; end if;
      -- Stable largest remainder, including the explicit unreserved share last.
      portions:=array[]::numeric[]; remainders:=array[]::numeric[]; total_bp:=0;
      for share in select * from jsonb_array_elements(rule->'shares') loop
        portions:=array_append(portions,trunc(source*(share->>'bp')::numeric/10000)); remainders:=array_append(remainders,mod(source*(share->>'bp')::numeric,10000)); total_bp:=total_bp+(share->>'bp')::integer;
      end loop;
      portions:=array_append(portions,trunc(source*(10000-total_bp)/10000)); remainders:=array_append(remainders,mod(source*(10000-total_bp),10000));
      select (source-coalesce(sum(x),0))::integer into leftover from unnest(portions) x;
      while leftover>0 loop
        winner:=1; for idx in 1..array_length(remainders,1) loop if remainders[idx]>remainders[winner] then winner:=idx; end if; end loop;
        portions[winner]:=portions[winner]+1; remainders[winner]:=-1; leftover:=leftover-1;
      end loop;
      select (select jsonb_agg(x->>'goal_id' order by ord) from jsonb_array_elements(rule->'shares') with ordinality t(x,ord)) is not distinct from (select jsonb_agg(x->>'goal_id' order by ord) from jsonb_array_elements(e->'allocations') with ordinality t(x,ord)) into same_goals;
      if not same_goals then raise exception 'Captured split children mismatch' using errcode='23514'; end if;
      free:=case when allocation_month>current_month then source else public.goal_free(uid,parent.id,at_time) end; idx:=0;
      for a in select * from jsonb_array_elements(e->'allocations') loop
        idx:=idx+1; select * into g from public.goal_projection(uid,parent.id,at_time) x where x.goal_id=a->>'goal_id';
        if g.goal_id is null then raise exception 'Missing split child' using errcode='23514'; end if;
        -- Replacing an unconsumed future capture removes that capture's own cap use.
        additional:=0;
        if old is not null then select trunc(coalesce((x->>'amount_centavos')::numeric,0)*least(source,(old->>'source_centavos')::numeric)/(old->>'source_centavos')::numeric) into additional from jsonb_array_elements(old->'allocations') x where x->>'goal_id'=a->>'goal_id'; end if;
        requested:=case when g.definition->>'state'='active' then least(portions[idx],g.remaining_target+coalesce(additional,0)) else 0 end;
        funded:=least(requested,free); free:=free-funded;
        if (a->>'requested_centavos')::numeric<>requested or (a->>'amount_centavos')::numeric<>funded then raise exception 'Stale captured funding' using errcode='23514'; end if;
      end loop;
    end if;
    if typ not in ('capture','purchase') and jsonb_array_length(p_operation->'rows')<>0 then raise exception 'Goal planning cannot move money' using errcode='23514'; end if;
    update public.ledger_audit set details=jsonb_set(details,'{goals}',coalesce(details->'goals','[]'::jsonb)||jsonb_build_array(e)) where user_id=uid and id=(p_operation->>'id')::uuid;
  end loop;
  if action='post' and exists(select 1 from jsonb_array_elements(p_operation->'rows') r where r->'financial'->>'intent'='ordinary_income'
    and exists(select 1 from public.goal_heads(uid) h where h->>'key'='split:'||(r->>'envelope_id'))
    and not exists(select 1 from jsonb_array_elements(events) captured where captured->>'type'='capture' and captured->>'receipt_chain_id'=r->>'group_id' and captured->>'envelope_id'=r->>'envelope_id')) then raise exception 'Refresh Tin to capture income allocations' using errcode='23514'; end if;
  perform public.validate_goal_history(uid);
  perform set_config('tin.goal_operation',coalesce(old_context,''),true);
end $$;
revoke all on function public.apply_financial_operation(jsonb) from public,anon;
grant execute on function public.apply_financial_operation(jsonb) to authenticated;

create function public.guard_goal_legacy_write() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text,7107));
  if auth.uid() is not null and exists(select 1 from public.ledger_audit where user_id=new.user_id and details ? 'goals') and current_setting('tin.goal_operation',true) is distinct from new.user_id::text then raise exception 'Refresh Tin before changing a ledger with goals' using errcode='P0001'; end if;
  return new;
end $$;
create trigger guard_goal_legacy_write before insert or update on public.entries for each row execute function public.guard_goal_legacy_write();
create function public.goals_capabilities() returns integer language sql stable set search_path = '' as $$ select 1 $$;
revoke all on function public.goals_capabilities() from public,anon;
grant execute on function public.goals_capabilities() to authenticated;

revoke all on function public.goal_events(uuid),public.goal_heads(uuid),public.goal_amount(jsonb,boolean),public.goal_income_month(uuid,text,text),public.validate_goal_event(jsonb,uuid),public.goal_projection(uuid,uuid,timestamptz),public.goal_free(uuid,uuid,timestamptz),public.validate_goal_history(uuid),public.guard_goal_legacy_write() from public,anon,authenticated;
notify pgrst, 'reload schema';
commit;
