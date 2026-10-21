-- A 120-term payoff has 120 occurrence snapshots plus its one payment link.
-- Keep this reviewed command atomic, including a definition/term revision batch.
begin;
create or replace function public.apply_financial_operation_before_terms(p_operation jsonb) returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); events jsonb:=coalesce(p_operation->'schedule_events','[]'::jsonb); e jsonb; old jsonb; o jsonb; d jsonb; a jsonb; t public.recurring_templates; cursor_day text; gid uuid; old_context text; remaining numeric; own_hold numeric; free numeric;
  at_time timestamptz:=greatest(now(),least((p_operation->>'recorded_at')::timestamptz,now()+interval '2 minutes'));
begin
  if uid is null then raise exception 'Authentication required' using errcode='28000'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text,7107));
  if exists(select 1 from public.ledger_operations where id=(p_operation->>'id')::uuid) then perform public.apply_financial_operation_before_schedules(p_operation); return; end if;
  if jsonb_typeof(events) is distinct from 'array' or jsonb_array_length(events)>256 or (jsonb_array_length(events)>0 and (p_operation->>'action'<>'post' or jsonb_array_length(coalesce(p_operation->'goal_events','[]'))>0)) then raise exception 'Invalid schedule command' using errcode='23514'; end if;
  if (jsonb_array_length(events)>0 or exists(select 1 from public.schedule_events(uid)) or exists(select 1 from jsonb_array_elements(coalesce(p_operation->'audit','[]')) x where x->'details' ? 'schedules')) and coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'x-tin-schedules','')<>'1' then raise exception 'Refresh Tin before using schedules' using errcode='P0001'; end if;
  old_context:=current_setting('tin.schedule_operation',true); perform set_config('tin.schedule_operation',uid::text,true);
  perform public.apply_financial_operation_before_schedules(p_operation);
  for e in select * from jsonb_array_elements(events) loop
    perform public.validate_schedule_event(e,uid);
    select h into old from public.schedule_heads(uid) h where h->>'key'=e->>'key';
    if old->>'id' is distinct from e->>'previous_event_id' then raise exception 'Stale schedule preview' using errcode='23514'; end if;
    if e->>'type'='schedule' then
      if jsonb_array_length(p_operation->'rows')<>0 or not exists(select 1 from public.categories c join public.envelopes v on v.id=c.envelope_id where c.user_id=uid and c.id=(e->>'category_id')::uuid and c.archived_at is null and v.archived_at is null) then raise exception 'Choose active schedule category' using errcode='23514'; end if;
      if old is not null and e->>'effective_month'<=to_char(at_time at time zone 'Asia/Manila','YYYY-MM') then raise exception 'Changes begin next month' using errcode='23514'; end if;
      if old is null and e->>'legacy_template_id' is not null then
        select * into t from public.recurring_templates where user_id=uid and id=(e->>'legacy_template_id')::uuid for update;
        if not found or t.kind<>'expense' or t.category_id::text<>e->>'category_id' or t.money_type is distinct from e->>'money_type' or t.day_of_month<>(e->>'day')::integer or t.amount_centavos<>(e->'amounts'->>0)::numeric then raise exception 'Legacy template changed' using errcode='23514'; end if;
        cursor_day:=t.next_run_on::text;
        for i in 1..2400 loop
          gid:=extensions.uuid_generate_v5('5f0be0b2-f0aa-4dcf-9f39-4f4a30e5f524'::uuid,t.id::text||':'||cursor_day||':group');
          exit when not exists(select 1 from public.entries where user_id=uid and group_id=gid);
          cursor_day:=public.schedule_due(to_char((left(cursor_day,7)||'-01')::date+interval '1 month','YYYY-MM')||'-01',t.day_of_month);
          if i=2400 then raise exception 'Legacy cursor exceeds review window' using errcode='23514'; end if;
        end loop;
        if cursor_day<>e->>'cutover_on' or cursor_day<>e->>'start_on' then raise exception 'Legacy cutover changed' using errcode='23514'; end if;
        update public.recurring_templates set paused_at=now() where id=t.id;
      end if;
    elsif e->>'type'='occurrence' then
      select x into d from public.schedule_events(uid) x where x->>'id'=e->>'definition_id';
      if d is null or exists(select 1 from public.schedule_events(uid) n where n->>'type'='schedule' and n->>'schedule_id'=e->>'schedule_id' and n->>'previous_event_id'=d->>'id' and n->>'effective_month'<=left(e->>'due_on',7)) then raise exception 'Billing rule changed' using errcode='23514'; end if;
    elsif e->>'type' in ('reservation','resolution') then
      if jsonb_array_length(p_operation->'rows')<>0 then raise exception 'Planning cannot move money' using errcode='23514'; end if;
      if e->>'type'='reservation' then
        select x into o from public.schedule_heads(uid) x where x->>'key'=e->>'occurrence_key';
        select x into d from public.schedule_events(uid) x where x->>'id'=o->>'definition_id';
        remaining:=(o->>'amount_centavos')::numeric+(o->>'fee_centavos')::numeric-public.schedule_paid(uid,o->>'key',at_time);
        own_hold:=least(remaining,coalesce((old->>'amount_centavos')::numeric,0)); free:=public.schedule_free_raw(uid,(d->>'envelope_id')::uuid,at_time);
        if d is null or (e->>'amount_centavos')::numeric>remaining or (e->>'amount_centavos')::numeric>greatest(0,free+own_hold) or exists(select 1 from public.schedule_heads(uid) c where c->>'key'='schedule:'||(d->>'schedule_id') and c->>'state'='canceled') or exists(select 1 from public.schedule_heads(uid) c where c->>'key'='resolution:'||(o->>'key') and c->>'state' in ('skipped','canceled')) then raise exception 'Insufficient free commitment funds' using errcode='23514'; end if;
      end if;
    elsif e->>'type'='payment' then
      if not exists(select 1 from public.entries r where r.user_id=uid and r.voided_at is null and r.occurred_at<=at_time and coalesce(r.financial->>'chain_id',r.group_id::text)=e->>'purchase_chain_id') then raise exception 'Choose an actual active expense' using errcode='23514'; end if;
      for a in select * from jsonb_array_elements(e->'allocations') loop
        select x into o from public.schedule_heads(uid) x where x->>'key'=a->>'occurrence_key';
        remaining:=(o->>'amount_centavos')::numeric+(o->>'fee_centavos')::numeric-public.schedule_paid(uid,o->>'key','infinity');
        if o is null or (a->>'amount_centavos')::numeric>remaining or exists(select 1 from public.schedule_heads(uid) c where c->>'key'='schedule:'||(o->>'schedule_id') and c->>'state'='canceled') or exists(select 1 from public.schedule_heads(uid) c where c->>'key'='resolution:'||(o->>'key') and c->>'state' in ('skipped','canceled')) then raise exception 'Payment exceeds unpaid item' using errcode='23514'; end if;
      end loop;
    end if;
    update public.ledger_audit set details=jsonb_set(details,'{schedules}',coalesce(details->'schedules','[]'::jsonb)||jsonb_build_array(e)) where user_id=uid and id=(p_operation->>'id')::uuid;
  end loop;
  perform public.validate_schedule_history(uid);
  perform set_config('tin.schedule_operation',coalesce(old_context,''),true);
end $$;
revoke all on function public.apply_financial_operation_before_terms(jsonb) from public,anon,authenticated;
commit;
