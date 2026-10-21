-- Preserve 009 as rehearsed/applied. Accept bounded device clock skew and
-- queued earlier-month reservations, while checking current free funds.
-- A future-held capture cannot have been consumed by an earlier purchase.
begin;

create or replace function public.apply_financial_operation(p_operation jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=auth.uid(); e jsonb; old jsonb; g record; parent public.envelopes; rule jsonb; a jsonb; share jsonb;
  typ text; at_time timestamptz:=greatest(now(),least((p_operation->>'recorded_at')::timestamptz,now()+interval '2 minutes')); current_month text:=to_char(at_time at time zone 'Asia/Manila','YYYY-MM');
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
      if typ='reserve' and (g.definition->>'state'<>'active' or e->>'month'>current_month or (e->>'amount_centavos')::numeric>least(g.remaining_target,public.goal_free(uid,parent.id,at_time))) then raise exception 'Insufficient free goal funds' using errcode='23514'; end if;
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
notify pgrst, 'reload schema';
commit;
