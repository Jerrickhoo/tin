-- 011 was already rehearsed on isolated staging. Preserve that history.
-- Finite payment obligations cannot be erased by subscription pause/cancel.
begin;
alter function public.validate_schedule_event(jsonb,uuid) rename to validate_schedule_event_before_finite;
revoke all on function public.validate_schedule_event_before_finite(jsonb,uuid) from public,anon,authenticated;
create function public.validate_schedule_event(e jsonb,p_uid uuid) returns void language plpgsql set search_path='' as $$
begin
  perform public.validate_schedule_event_before_finite(e,p_uid);
  if e->>'type'='schedule' and e->>'kind'='installment' and e->>'state'<>'active' then
    raise exception 'Finite obligations remain until explicitly paid; pause and cancel apply only to subscriptions' using errcode='23514';
  end if;
  if e->>'type'='resolution' and e->>'state'<>'open' and exists(
    select 1 from public.schedule_heads(p_uid) o join public.schedule_events(p_uid) d on d->>'id'=o->>'definition_id'
    where o->>'key'=e->>'occurrence_key' and d->>'kind'='installment'
  ) then raise exception 'Installment obligations remain until paid' using errcode='23514'; end if;
end $$;
revoke all on function public.validate_schedule_event(jsonb,uuid) from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
