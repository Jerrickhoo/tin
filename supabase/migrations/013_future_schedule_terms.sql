-- Explicit revision of saved future terms without payment links.
-- Preserve the already applied 011/012 migrations.
begin;
create or replace function public.validate_schedule_event_before_finite(e jsonb,p_uid uuid) returns void language plpgsql set search_path='' as $$
declare allowed text[]:=array['id','key','previous_event_id','type']; typ text:=e->>'type'; expected_key text; k text; a jsonb; n numeric; total numeric:=0;
begin
  allowed:=allowed || case typ
    when 'schedule' then array['schedule_id','name','kind','envelope_id','category_id','money_type','start_on','day','effective_month','state','amounts','fees','purchase_reviewed','legacy_template_id','cutover_on']
    when 'occurrence' then array['schedule_id','definition_id','period','due_on','amount_centavos','fee_centavos']
    when 'reservation' then array['occurrence_key','amount_centavos'] when 'resolution' then array['occurrence_key','state']
    when 'payment' then array['purchase_chain_id','allocations'] end;
  if jsonb_typeof(e) is distinct from 'object' or allowed is null or not(e ?& allowed) or exists(select 1 from jsonb_object_keys(e) x where x<>all(allowed)) then raise exception 'Unsupported schedule event' using errcode='23514'; end if;
  foreach k in array array['id','schedule_id','envelope_id','category_id','definition_id','purchase_chain_id'] loop
    if e ? k and (e->>k is null or e->>k is distinct from ((e->>k)::uuid)::text) then raise exception 'Invalid schedule identity' using errcode='23514'; end if;
  end loop;
  if e->>'previous_event_id' is not null and e->>'previous_event_id' is distinct from ((e->>'previous_event_id')::uuid)::text then raise exception 'Invalid revision' using errcode='23514'; end if;
  expected_key:=case typ when 'schedule' then 'schedule:'||(e->>'schedule_id') when 'occurrence' then 'due:'||(e->>'schedule_id')||':'||(e->>'period') when 'payment' then 'payment:'||(e->>'purchase_chain_id') else typ||':'||(e->>'occurrence_key') end;
  if e->>'key' is distinct from expected_key then raise exception 'Invalid schedule key' using errcode='23514'; end if;
  if typ='schedule' then
    if jsonb_typeof(e->'name') is distinct from 'string' or length(btrim(e->>'name')) not between 1 and 100 or coalesce(e->>'kind','') not in ('subscription','installment') or coalesce(e->>'state','') not in ('active','paused','canceled') or coalesce(e->>'money_type','') not in ('online','reallife') or jsonb_typeof(e->'purchase_reviewed') is distinct from 'boolean' or (e->>'kind'='installment' and e->>'purchase_reviewed'<>'true') then raise exception 'Review schedule and existing purchase' using errcode='23514'; end if;
    n:=public.goal_amount(e->'day'); if n>31 then raise exception 'Invalid billing day' using errcode='23514'; end if;
    if coalesce(e->>'effective_month','') !~ '^(20[0-9]{2}|21[0-9]{2})-(0[1-9]|1[0-2])$' or coalesce(e->>'start_on','') !~ '^(20[0-9]{2}|21[0-9]{2})-[0-9]{2}-[0-9]{2}$' or (e->>'start_on')::date::text<>e->>'start_on' then raise exception 'Invalid start date' using errcode='23514'; end if;
    if e->>'effective_month'<left(e->>'start_on',7) or (e->>'kind'='installment' and public.schedule_due(left(e->>'start_on',7)||'-01',(e->>'day')::integer)<e->>'start_on') then raise exception 'First installment precedes start' using errcode='23514'; end if;
    if jsonb_typeof(e->'amounts') is distinct from 'array' or jsonb_typeof(e->'fees') is distinct from 'array' or jsonb_array_length(e->'amounts') not between 1 and 120 or jsonb_array_length(e->'amounts')<>jsonb_array_length(e->'fees') or (e->>'kind'='subscription' and jsonb_array_length(e->'amounts')<>1) then raise exception 'Invalid installment amounts' using errcode='23514'; end if;
    for a in select * from jsonb_array_elements(e->'amounts') loop total:=total+public.goal_amount(a); end loop;
    for a in select * from jsonb_array_elements(e->'fees') loop total:=total+public.goal_amount(a,true); end loop;
    if total>9007199254740991 then raise exception 'Unsafe plan total' using errcode='22003'; end if;
    if not exists(select 1 from public.categories c where c.user_id=p_uid and c.id=(e->>'category_id')::uuid and c.envelope_id=(e->>'envelope_id')::uuid) then raise exception 'Foreign schedule category' using errcode='23514'; end if;
    if (e->>'legacy_template_id' is null)<>(e->>'cutover_on' is null) or (e->>'legacy_template_id' is not null and (e->>'legacy_template_id' is distinct from ((e->>'legacy_template_id')::uuid)::text or (e->>'cutover_on')::date::text<>e->>'cutover_on')) then raise exception 'Invalid cutover' using errcode='23514'; end if;
  elsif typ='occurrence' then
    perform public.goal_amount(e->'amount_centavos'); perform public.goal_amount(e->'fee_centavos',true);
    if coalesce(e->>'due_on','') !~ '^(20[0-9]{2}|21[0-9]{2})-[0-9]{2}-[0-9]{2}$' or (e->>'due_on')::date::text<>e->>'due_on' then raise exception 'Invalid occurrence date' using errcode='23514'; end if;
  elsif typ='reservation' then perform public.goal_amount(e->'amount_centavos',true);
  elsif typ='resolution' then if coalesce(e->>'state','') not in ('open','skipped','canceled') then raise exception 'Invalid due status' using errcode='23514'; end if;
  else
    if e->>'previous_event_id' is not null or jsonb_typeof(e->'allocations') is distinct from 'array' or jsonb_array_length(e->'allocations') not between 1 and 120 then raise exception 'Invalid payment links' using errcode='23514'; end if;
    for a in select * from jsonb_array_elements(e->'allocations') loop
      if jsonb_typeof(a) is distinct from 'object' or not(a ?& array['occurrence_key','amount_centavos']) or (select count(*) from jsonb_object_keys(a))<>2 or jsonb_typeof(a->'occurrence_key') is distinct from 'string' then raise exception 'Invalid allocation' using errcode='23514'; end if;
      perform public.goal_amount(a->'amount_centavos');
    end loop;
    if (select count(*)<>count(distinct x->>'occurrence_key') from jsonb_array_elements(e->'allocations') x) then raise exception 'Duplicate payment allocation' using errcode='23514'; end if;
  end if;
end $$;
alter function public.validate_schedule_history(uuid) rename to validate_schedule_history_before_terms;
revoke all on function public.validate_schedule_history_before_terms(uuid) from public,anon,authenticated;
create or replace function public.validate_schedule_history_before_terms(p_uid uuid) returns void language plpgsql set search_path='' as $$
declare e jsonb; old jsonb; d jsonb; o jsonb; a jsonb; month text; idx integer; total numeric; expected numeric;
begin
  if exists(select 1 from public.ledger_audit where user_id=p_uid and details ? 'schedules' and jsonb_typeof(details->'schedules') is distinct from 'array') then raise exception 'Invalid schedule history' using errcode='23514'; end if;
  if exists(select 1 from public.schedule_events(p_uid) ev group by ev->>'id' having count(*)>1) or exists(select 1 from public.schedule_events(p_uid) ev group by ev->>'key',ev->>'previous_event_id' having count(*)>1) then raise exception 'Conflicting schedule history' using errcode='23514'; end if;
  if exists(with recursive walk as (select ev->>'id' root,ev->>'previous_event_id' parent,array[ev->>'id'] path from public.schedule_events(p_uid) ev union all select w.root,ev->>'previous_event_id',w.path||(ev->>'id') from walk w join public.schedule_events(p_uid) ev on ev->>'id'=w.parent where not (ev->>'id'=any(w.path))) select 1 from walk where parent=any(path)) then raise exception 'Schedule cycle' using errcode='23514'; end if;
  for e in select * from public.schedule_events(p_uid) loop
    perform public.validate_schedule_event(e,p_uid);
    select p into old from public.schedule_events(p_uid) p where p->>'id'=e->>'previous_event_id';
    if e->>'previous_event_id' is not null and (old is null or old->>'key'<>e->>'key') then raise exception 'Missing schedule revision' using errcode='23514'; end if;
    if e->>'type'='schedule' and old is not null and ((old-array['id','previous_event_id','name','category_id','money_type','day','effective_month','state','amounts','fees'])<>(e-array['id','previous_event_id','name','category_id','money_type','day','effective_month','state','amounts','fees']) or old->>'effective_month'>e->>'effective_month' or old->>'state'='canceled' or jsonb_array_length(old->'amounts')<>jsonb_array_length(e->'amounts')) then raise exception 'Invalid prospective terms' using errcode='23514'; end if;
    if e->>'type'='occurrence' then
      select x into d from public.schedule_events(p_uid) x where x->>'type'='schedule' and x->>'id'=e->>'definition_id' and x->>'schedule_id'=e->>'schedule_id';
      if d is null or d->>'state'<>'active' then raise exception 'Missing occurrence definition' using errcode='23514'; end if;
      if d->>'kind'='subscription' then
        if coalesce(e->>'period','') !~ '^(20[0-9]{2}|21[0-9]{2})-(0[1-9]|1[0-2])$' then raise exception 'Invalid due month' using errcode='23514'; end if;
        month:=e->>'period'; idx:=0;
      else
        if coalesce(e->>'period','') !~ '^[1-9][0-9]{0,2}$' or (e->>'period')::integer>jsonb_array_length(d->'amounts') then raise exception 'Invalid term ordinal' using errcode='23514'; end if;
        idx:=(e->>'period')::integer-1; month:=to_char((left(d->>'start_on',7)||'-01')::date+idx*interval '1 month','YYYY-MM');
      end if;
      if e->>'due_on'<>public.schedule_due(month||'-01',(d->>'day')::integer) or e->'amount_centavos'<>d->'amounts'->idx or e->'fee_centavos'<>d->'fees'->idx or e->>'due_on'<d->>'start_on' or e->>'due_on'<d->>'cutover_on' then raise exception 'Due snapshot differs from terms' using errcode='23514'; end if;
      if not exists(select 1 from public.schedule_events(p_uid) h where h->>'previous_event_id'=e->>'id') and public.schedule_paid(p_uid,e->>'key','infinity')>(e->>'amount_centavos')::numeric+(e->>'fee_centavos')::numeric then raise exception 'Payment exceeds remaining amount' using errcode='23514'; end if;
    elsif e->>'type' in ('reservation','resolution') then
      if not exists(select 1 from public.schedule_heads(p_uid) x where x->>'type'='occurrence' and x->>'key'=e->>'occurrence_key') then raise exception 'Missing saved occurrence' using errcode='23514'; end if;
    elsif e->>'type'='payment' then
      select sum((x->>'amount_centavos')::numeric) into total from jsonb_array_elements(e->'allocations') x;
      if not exists(select 1 from public.entries r where r.user_id=p_uid and coalesce(r.financial->>'chain_id',r.group_id::text)=e->>'purchase_chain_id') or exists(select 1 from public.entries r where r.user_id=p_uid and coalesce(r.financial->>'chain_id',r.group_id::text)=e->>'purchase_chain_id' and coalesce(r.financial->>'intent',case r.kind when 'expense' then 'purchase' end) is distinct from 'purchase') or exists(select 1 from public.entries r where r.user_id=p_uid and coalesce(r.financial->>'chain_id',r.group_id::text)=e->>'purchase_chain_id' group by r.group_id having sum(-amount_centavos)<>total) then raise exception 'Payment must match actual expense' using errcode='23514'; end if;
      for a in select * from jsonb_array_elements(e->'allocations') loop
        select x into o from public.schedule_heads(p_uid) x where x->>'type'='occurrence' and x->>'key'=a->>'occurrence_key';
        select x into d from public.schedule_events(p_uid) x where x->>'id'=o->>'definition_id';
        if d is null or exists(select 1 from public.entries r where r.user_id=p_uid and coalesce(r.financial->>'chain_id',r.group_id::text)=e->>'purchase_chain_id' and r.envelope_id::text<>d->>'envelope_id') then raise exception 'Foreign payment allocation' using errcode='23514'; end if;
      end loop;
      if exists(select 1 from public.goal_events(p_uid) g where g->>'type'='purchase' and g->>'purchase_chain_id'=e->>'purchase_chain_id') then raise exception 'Payment already consumes a goal hold' using errcode='23514'; end if;
    end if;
  end loop;
  if exists(select 1 from public.schedule_heads(p_uid) h where h->>'type'='schedule' and h->>'legacy_template_id' is not null group by h->>'legacy_template_id' having count(*)>1) then raise exception 'Template already converted' using errcode='23514'; end if;
end $$;

create function public.validate_schedule_history(p_uid uuid) returns void language plpgsql set search_path='' as $$
declare e jsonb; old jsonb;
begin
  perform public.validate_schedule_history_before_terms(p_uid);
  for e in select * from public.schedule_events(p_uid) h where h->>'type'='occurrence' and h->>'previous_event_id' is not null loop
    select h into old from public.schedule_events(p_uid) h where h->>'id'=e->>'previous_event_id';
    if old->>'type' is distinct from 'occurrence' or old->>'schedule_id' is distinct from e->>'schedule_id' or old->>'period' is distinct from e->>'period' then raise exception 'Occurrence identity cannot change' using errcode='23514'; end if;
  end loop;
end $$;
alter function public.apply_financial_operation(jsonb) rename to apply_financial_operation_before_terms;
revoke all on function public.apply_financial_operation_before_terms(jsonb) from public,anon,authenticated;
create function public.apply_financial_operation(p_operation jsonb) returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); e jsonb; old jsonb;
  at_time timestamptz:=greatest(now(),least((p_operation->>'recorded_at')::timestamptz,now()+interval '2 minutes'));
  month text:=to_char(at_time at time zone 'Asia/Manila','YYYY-MM');
begin
  if uid is null then raise exception 'Authentication required' using errcode='28000'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text,7107));
  if exists(select 1 from public.ledger_operations where id=(p_operation->>'id')::uuid) then perform public.apply_financial_operation_before_terms(p_operation); return; end if;
  for e in select * from jsonb_array_elements(coalesce(p_operation->'schedule_events','[]')) h where h->>'type'='occurrence' and h->>'previous_event_id' is not null loop
    select h into old from public.schedule_heads(uid) h where h->>'key'=e->>'key';
    if old is null or old->>'id' is distinct from e->>'previous_event_id' or left(old->>'due_on',7)<=month or left(e->>'due_on',7)<=month or exists(
      select 1 from public.schedule_events(uid) p cross join lateral jsonb_array_elements(p->'allocations') a
      where p->>'type'='payment' and a->>'occurrence_key'=e->>'key'
    ) then raise exception 'Only future terms without payment links can be revised' using errcode='23514'; end if;
  end loop;
  perform public.apply_financial_operation_before_terms(p_operation);
end $$;
revoke all on function public.apply_financial_operation(jsonb) from public,anon;
grant execute on function public.apply_financial_operation(jsonb) to authenticated;
revoke all on function public.validate_schedule_event_before_finite(jsonb,uuid),public.validate_schedule_history(uuid) from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
