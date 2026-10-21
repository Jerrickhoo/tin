-- Additive financial meaning. Legacy four-kind rows keep unknown metadata.
-- All new financial commands use one idempotent, owner-scoped transaction.
begin;

alter table public.entries add column financial jsonb;
alter table public.profiles add column week_start text not null default 'monday' check (week_start in ('monday','sunday'));

create table public.ledger_groups (
  id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  metadata jsonb,
  origin_group_id uuid,
  corrects_group_id uuid,
  chain_id uuid,
  created_xid bigint not null default txid_current(),
  primary key (id,user_id),
  unique (user_id,corrects_group_id),
  foreign key (origin_group_id,user_id) references public.ledger_groups(id,user_id) deferrable initially deferred,
  foreign key (corrects_group_id,user_id) references public.ledger_groups(id,user_id) deferrable initially deferred
);
insert into public.ledger_groups(id,user_id) select distinct group_id,user_id from public.entries;
alter table public.entries add foreign key (group_id,user_id) references public.ledger_groups(id,user_id) deferrable initially deferred;
-- Backfilled groups can have deferred FK events. Flush them before subsequent
-- ALTER TABLE / RLS changes; retain deferred link semantics for imported chains.
set constraints all immediate;
set constraints all deferred;

create table public.obligations (
  id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('expense_reimbursement','receivable_principal','payable_principal')),
  origin_group_id uuid,
  amount_centavos bigint not null check (amount_centavos between 1 and 99999999999999),
  person text check (char_length(person) <= 100),
  due_on date,
  note text check (char_length(note) <= 500),
  recorded_at timestamptz not null,
  effective_at timestamptz,
  voided_at timestamptz,
  primary key (id,user_id),
  foreign key (origin_group_id,user_id) references public.ledger_groups(id,user_id) deferrable initially deferred,
  check (type <> 'expense_reimbursement' or origin_group_id is not null)
);
create table public.ledger_operations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  payload jsonb not null,
  recorded_at timestamptz not null
);
create table public.ledger_audit (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  group_id uuid,
  action text not null check (action in ('post','correct','void','restore','claim','cancel_claim','reconcile','import')),
  recorded_at timestamptz not null,
  details jsonb not null default '{}',
  foreign key (group_id,user_id) references public.ledger_groups(id,user_id) deferrable initially deferred
);
create index obligations_owner on public.obligations(user_id);
create index ledger_audit_owner on public.ledger_audit(user_id);
create index entries_origin on public.entries(user_id,((financial->>'origin_group_id')::uuid));
create index entries_obligation on public.entries(user_id,((financial->>'obligation_id')::uuid));

alter table public.ledger_groups enable row level security;
alter table public.obligations enable row level security;
alter table public.ledger_operations enable row level security;
alter table public.ledger_audit enable row level security;
create policy ledger_groups_read on public.ledger_groups for select to authenticated using (user_id = auth.uid());
create policy obligations_read on public.obligations for select to authenticated using (user_id = auth.uid());
create policy ledger_operations_read on public.ledger_operations for select to authenticated using (user_id = auth.uid());
create policy ledger_audit_read on public.ledger_audit for select to authenticated using (user_id = auth.uid());
revoke all on public.ledger_groups, public.obligations, public.ledger_operations, public.ledger_audit from anon, authenticated;
grant select on public.ledger_groups, public.obligations, public.ledger_operations, public.ledger_audit to authenticated;
-- Revoke table-wide insert, then grant precisely the legacy wire columns.
-- A caller cannot inject financial metadata outside the validated RPC.
revoke insert on public.entries from authenticated;
grant insert (id,user_id,group_id,kind,envelope_id,category_id,amount_centavos,note,occurred_at,money_type,voided_at,void_reason) on public.entries to authenticated;
create policy entries_legacy_update_only on public.entries as restrictive for update to authenticated using (financial is null) with check (financial is null);

create function public.guard_financial_entry() returns trigger language plpgsql security definer set search_path = '' as $$
declare g public.ledger_groups; existing public.entries;
begin
  -- Write compatibility guard, not authorization: RLS and the RPC still enforce
  -- ownership and semantics. Old cached clients must not run void-then-insert
  -- corrections beside the new atomic protocol. Current clients also stamp
  -- this header when replaying historical outbox payloads.
  if auth.uid() is not null and coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'x-client-info','')<>'tin-ledger/1' then
    raise exception 'Refresh Tin before writing to the upgraded ledger' using errcode='P0001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text,7107));
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
revoke all on function public.guard_financial_entry() from public;
create trigger guard_financial_entry before insert or update on public.entries for each row execute function public.guard_financial_entry();

create function public.validate_financial_ledger(p_uid uuid) returns void language plpgsql set search_path = '' as $$
declare g record; m jsonb; n bigint; total numeric; c record; recovered numeric; reserved numeric; gross numeric;
begin
  for g in select group_id, min(kind) kind, count(*) n, sum(amount_centavos) total,
    count(distinct envelope_id) envelopes, count(distinct coalesce(money_type,'untagged')) accounts,
    count(distinct occurred_at) times, count(distinct kind) kinds, count(distinct coalesce(note,'')) notes,
    count(*) filter(where voided_at is null) active, count(*) filter(where amount_centavos>0) positives,
    count(distinct financial) meanings, bool_and(money_type is not null) tagged
    from public.entries where user_id=p_uid group by group_id
  loop
    if g.active <> 0 and g.active <> g.n then raise exception 'Partial group void' using errcode='23514'; end if;
    select metadata into m from public.ledger_groups where id=g.group_id and user_id=p_uid;
    if m is null then continue; end if;
    if g.meanings<>1 or g.times<>1 or g.notes<>1 or g.kinds<>1 then raise exception 'Inconsistent group' using errcode='23514'; end if;
    if m->>'intent' in ('ordinary_income','merchant_refund','expense_reimbursement','borrow_principal','principal_received') and (g.kind<>'income' or g.positives<>g.n) then raise exception 'Invalid incoming signs' using errcode='23514'; end if;
    if m->>'intent' in ('purchase','lend_principal','principal_paid') and (g.kind<>'expense' or g.positives<>0) then raise exception 'Invalid outgoing signs' using errcode='23514'; end if;
    if m->>'intent' in ('reconciliation','opening_balance') and g.kind<>'adjustment' then raise exception 'Invalid adjustment kind' using errcode='23514'; end if;
    if m->>'intent' in ('envelope_transfer','account_transfer','account_reclassification') then
      if g.kind<>'transfer' or g.n<>2 or g.total<>0 or g.positives<>1 then raise exception 'Unbalanced transfer' using errcode='23514'; end if;
      if m->>'intent'='envelope_transfer' and (g.envelopes<>2 or g.accounts<>1) then raise exception 'Invalid envelope transfer' using errcode='23514'; end if;
      if m->>'intent'<>'envelope_transfer' and (g.envelopes<>1 or g.accounts<>2) then raise exception 'Invalid account transfer' using errcode='23514'; end if;
      if m->>'intent'='account_transfer' and not g.tagged then raise exception 'Choose both accounts' using errcode='23514'; end if;
    end if;
    if m->>'intent'='merchant_refund' and m->>'origin_group_id' is null and (m->>'origin_unknown') is distinct from 'true' then raise exception 'Refund origin required' using errcode='23514'; end if;
    if m->>'intent' in ('expense_reimbursement','principal_received','principal_paid') then
      select * into c from public.obligations where id=(m->>'obligation_id')::uuid and user_id=p_uid and (voided_at is null or g.active=0);
      if not found or (c.origin_group_id is distinct from (m->>'origin_group_id')::uuid) or m->>'intent' <> (case c.type when 'expense_reimbursement' then 'expense_reimbursement' when 'receivable_principal' then 'principal_received' else 'principal_paid' end) then raise exception 'Invalid settlement link' using errcode='23514'; end if;
    end if;
  end loop;
  -- Reimbursement claims reserve only their unpaid portion; all actual
  -- refunds/reimbursements plus reservations must fit the original purchase.
  for c in select distinct origin_group_id from public.ledger_groups where user_id=p_uid and origin_group_id is not null
    union select origin_group_id from public.obligations where user_id=p_uid and type='expense_reimbursement' and voided_at is null
  loop
    if c.origin_group_id is null then continue; end if;
    select count(*),coalesce(sum(-amount_centavos),0) into n,gross from public.entries where user_id=p_uid and group_id=c.origin_group_id and voided_at is null and coalesce(financial->>'intent',case kind when 'expense' then 'purchase' end)='purchase';
    -- Principal disbursement origins are checked through obligations below.
    if not exists(select 1 from public.ledger_groups where user_id=p_uid and origin_group_id=c.origin_group_id and metadata->>'intent' in ('merchant_refund','expense_reimbursement')) and not exists(select 1 from public.obligations where user_id=p_uid and origin_group_id=c.origin_group_id and type='expense_reimbursement') then continue; end if;
    if n=0 then raise exception 'Active purchase origin required' using errcode='23514'; end if;
    select coalesce(sum(amount_centavos),0) into recovered from public.entries where user_id=p_uid and voided_at is null and financial->>'origin_group_id'=c.origin_group_id::text and financial->>'intent' in ('merchant_refund','expense_reimbursement');
    select coalesce(sum(o.amount_centavos-coalesce((select sum(abs(e.amount_centavos)) from public.entries e where e.user_id=p_uid and e.voided_at is null and e.financial->>'obligation_id'=o.id::text),0)),0) into reserved from public.obligations o where o.user_id=p_uid and o.origin_group_id=c.origin_group_id and o.type='expense_reimbursement' and o.voided_at is null;
    if recovered+reserved > gross then raise exception 'Expense recovery cap exceeded' using errcode='23514'; end if;
  end loop;
  for c in select * from public.obligations where user_id=p_uid and voided_at is null loop
    select coalesce(sum(abs(amount_centavos)),0) into total from public.entries where user_id=p_uid and voided_at is null and financial->>'obligation_id'=c.id::text;
    if total>c.amount_centavos then raise exception 'Obligation overpayment' using errcode='23514'; end if;
    if c.type<>'expense_reimbursement' and c.origin_group_id is not null then
      select coalesce(sum(abs(amount_centavos)),0) into total from public.entries where user_id=p_uid and group_id=c.origin_group_id and voided_at is null and financial->>'intent'=case c.type when 'receivable_principal' then 'lend_principal' else 'borrow_principal' end;
      if total<>c.amount_centavos then raise exception 'Invalid principal origin' using errcode='23514'; end if;
    end if;
  end loop;
  if exists(select 1 from public.entries e join public.ledger_groups successor on successor.user_id=e.user_id and successor.corrects_group_id=e.group_id where e.user_id=p_uid and e.voided_at is null) then raise exception 'Correction predecessor still active' using errcode='23514'; end if;
  if exists(
    with recursive ancestry as (
      select h.id start_id,h.id current_id,h.corrects_group_id parent,h.chain_id declared,array[h.id] path
      from public.ledger_groups h where h.user_id=p_uid and h.metadata is not null
      union all
      select a.start_id,h.id,h.corrects_group_id,a.declared,a.path||h.id
      from ancestry a join public.ledger_groups h on h.user_id=p_uid and h.id=a.parent where not h.id=any(a.path)
    )
    select 1 from public.ledger_groups h where h.user_id=p_uid and h.metadata is not null and not exists(select 1 from ancestry a where a.start_id=h.id and a.parent is null and a.current_id=a.declared)
  ) then raise exception 'Invalid correction ancestry' using errcode='23514'; end if;
  if exists(select 1 from public.entries where user_id=p_uid and voided_at is null group by coalesce(money_type,'untagged') having abs(sum(amount_centavos))>9007199254740991)
    or exists(select 1 from public.entries where user_id=p_uid and voided_at is null having abs(sum(amount_centavos))>9007199254740991 or sum(amount_centavos) filter(where amount_centavos>0)>9007199254740991 or -sum(amount_centavos) filter(where amount_centavos<0)>9007199254740991)
  then raise exception 'Unsafe accumulated account total' using errcode='22003'; end if;
  if exists(select 1 from public.entries where user_id=p_uid group by envelope_id having abs(sum(amount_centavos) filter(where voided_at is null))>9007199254740991) then raise exception 'Unsafe accumulated balance' using errcode='22003'; end if;
end $$;
revoke all on function public.validate_financial_ledger(uuid) from public;

-- Legacy clients can still void their old rows, but cannot commit a partial
-- group or bypass linked-state validation through column-level updates.
create function public.check_financial_update() returns trigger language plpgsql security definer set search_path = '' as $$
begin perform public.validate_financial_ledger(new.user_id); return null; end $$;
revoke all on function public.check_financial_update() from public;
create constraint trigger check_financial_update after update on public.entries deferrable initially deferred for each row execute function public.check_financial_update();

create function public.apply_financial_operation(p_operation jsonb) returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid:=auth.uid(); op_id uuid:=(p_operation->>'id')::uuid; action text:=p_operation->>'action'; at_time timestamptz:=(p_operation->>'recorded_at')::timestamptz;
  prior public.ledger_operations; r record; m jsonb; target uuid; item jsonb; expected numeric; changed numeric; check_data jsonb; group_count integer; link_key text;
begin
  if uid is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if op_id is null or at_time is null or action is null or action not in ('post','correct','void','restore','claim','cancel_claim','reconcile','import') then raise exception 'Invalid operation' using errcode='23514'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text,7107));
  select * into prior from public.ledger_operations where id=op_id;
  if found then
    if prior.user_id<>uid or prior.payload<>p_operation then raise exception 'Operation identity conflict' using errcode='23514'; end if;
    return;
  end if;
  if jsonb_typeof(p_operation->'rows')<>'array' or jsonb_array_length(p_operation->'rows')>10000 then raise exception 'Invalid rows' using errcode='23514'; end if;
  target:=coalesce((p_operation->'predecessor'->0->>'group_id')::uuid,(p_operation->>'target_group_id')::uuid);
  if target is not null and not exists(select 1 from public.entries where user_id=uid and group_id=target) then raise exception 'Unknown owned predecessor' using errcode='23514'; end if;
  if action='correct' then
    if exists(select 1 from public.entries where user_id=uid and group_id=target and financial->>'intent' not in ('purchase','ordinary_income','envelope_transfer','account_transfer')) then raise exception 'Resolve linked movement first' using errcode='23514'; end if;
    if target is null or jsonb_typeof(p_operation->'predecessor')<>'array' or jsonb_array_length(p_operation->'predecessor')<>(select count(*) from public.entries where user_id=uid and group_id=target) then raise exception 'Stale predecessor' using errcode='23514'; end if;
    for r in select * from jsonb_to_recordset(p_operation->'predecessor') as x(id uuid, group_id uuid, kind text,envelope_id uuid,category_id uuid,amount_centavos bigint,note text,occurred_at timestamptz,voided_at timestamptz,void_reason text,money_type text,financial jsonb) loop
      if not exists(select 1 from public.entries e where e.user_id=uid and e.group_id=target and e.voided_at is null and row(e.id,e.group_id,e.kind,e.envelope_id,e.category_id,e.amount_centavos,e.note,e.occurred_at,e.voided_at,e.void_reason,e.money_type,e.financial) is not distinct from row(r.id,r.group_id,r.kind,r.envelope_id,r.category_id,r.amount_centavos,r.note,r.occurred_at,r.voided_at,r.void_reason,r.money_type,r.financial)) then raise exception 'Stale predecessor' using errcode='23514'; end if;
    end loop;
  elsif p_operation ? 'predecessor' then raise exception 'Unexpected predecessor' using errcode='23514'; end if;
  if action in ('void','restore') and (target is null or jsonb_array_length(p_operation->'rows')<>0) then raise exception 'Invalid void/restore' using errcode='23514'; end if;
  check_data:=p_operation->'check';
  if check_data is not null then
    if action<>'reconcile' or check_data->>'account' not in ('online','reallife') or coalesce(length(trim(check_data->>'reason')),0)=0 then raise exception 'Invalid balance check' using errcode='23514'; end if;
    select coalesce(sum(amount_centavos),0) into expected from public.entries where user_id=uid and voided_at is null and money_type=check_data->>'account' and occurred_at<=(check_data->>'as_of')::timestamptz;
    if expected<>(check_data->>'expected_centavos')::numeric or (check_data->>'observed_centavos')::numeric-expected<>(check_data->>'delta_centavos')::numeric then raise exception 'Stale balance preview' using errcode='23514'; end if;
    if (select count(*) from public.entries where user_id=uid)<>jsonb_array_length(check_data->'expected_rows') or exists(select 1 from public.entries e where e.user_id=uid and not exists(select 1 from jsonb_to_recordset(check_data->'expected_rows') as x(id uuid,voided_at timestamptz) where x.id=e.id and x.voided_at is not distinct from e.voided_at)) then raise exception 'Stale balance preview' using errcode='23514'; end if;
    select coalesce(sum((x->>'amount_centavos')::numeric),0) into changed from jsonb_array_elements(p_operation->'rows') x where x->>'money_type'=check_data->>'account';
    if changed<>(check_data->>'delta_centavos')::numeric or (changed=0 and jsonb_array_length(p_operation->'rows')<>0) then raise exception 'Check difference mismatch' using errcode='23514'; end if;
  elsif action='reconcile' then raise exception 'Check preview required' using errcode='23514'; end if;

  insert into public.ledger_operations(id,user_id,payload,recorded_at) values(op_id,uid,p_operation,at_time);
  select count(distinct x->>'group_id') into group_count from jsonb_array_elements(p_operation->'rows') x;
  if action='correct' and group_count<>1 then raise exception 'One replacement required' using errcode='23514'; end if;
  for item in select value from jsonb_array_elements(p_operation->'rows') loop
    m:=nullif(item->'financial','null'::jsonb);
    if not (action='import' and m is null) then
    if m is null or jsonb_typeof(m)<>'object' or (m->'version') is distinct from '1'::jsonb or m->>'intent' is null or m->>'intent' not in ('ordinary_income','purchase','merchant_refund','expense_reimbursement','lend_principal','borrow_principal','principal_received','principal_paid','envelope_transfer','account_transfer','account_reclassification','reconciliation','opening_balance') or m->>'chain_id' is null or m->>'operation_id' is null or m->>'recorded_at' is null or exists(select 1 from jsonb_object_keys(m) k where k not in ('version','intent','operation_id','recorded_at','chain_id','origin_group_id','corrects_group_id','obligation_id','origin_unknown')) then raise exception 'Unknown financial meaning' using errcode='23514'; end if;
    foreach link_key in array array['operation_id','chain_id','origin_group_id','corrects_group_id','obligation_id'] loop
      if m->>link_key is not null then
        if jsonb_typeof(m->link_key)<>'string' then raise exception 'Invalid financial link type' using errcode='23514'; end if;
        m:=jsonb_set(m,array[link_key],to_jsonb(((m->>link_key)::uuid)::text));
      end if;
    end loop;
    if jsonb_typeof(m->'recorded_at')<>'string' then raise exception 'Invalid recorded timestamp type' using errcode='23514'; end if;
    m:=jsonb_set(m,array['recorded_at'],to_jsonb(to_char((m->>'recorded_at')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    if m->>'obligation_id' is not null and m->>'intent' not in ('expense_reimbursement','principal_received','principal_paid') or m->>'origin_group_id' is not null and m->>'intent' not in ('merchant_refund','expense_reimbursement','principal_received','principal_paid') then raise exception 'Invalid typed financial link' using errcode='23514'; end if;
    if m ? 'origin_unknown' and (m->'origin_unknown'<>'true'::jsonb or m->>'intent'<>'merchant_refund' or m->>'origin_group_id' is not null) then raise exception 'Invalid unknown origin' using errcode='23514'; end if;
    if action<>'import' and ((m->>'operation_id')::uuid<>op_id or (m->>'recorded_at')::timestamptz<>at_time or item->>'voided_at' is not null) then raise exception 'Operation metadata mismatch' using errcode='23514'; end if;
    if action='correct' then
      if (m->>'corrects_group_id')::uuid is distinct from target or (m->>'chain_id')::uuid is distinct from coalesce((select chain_id from public.ledger_groups where id=target and user_id=uid),target) then raise exception 'Invalid correction link' using errcode='23514'; end if;
    elsif action<>'import' and (m->>'chain_id')::uuid is distinct from (item->>'group_id')::uuid then raise exception 'New movement chain mismatch' using errcode='23514';
    elsif action<>'import' and m->>'corrects_group_id' is not null then raise exception 'Correction command required' using errcode='23514'; end if;
    end if;
    if abs((item->>'amount_centavos')::numeric) not between 1 and 99999999999999 then raise exception 'Amount outside supported bounds' using errcode='22003'; end if;
    insert into public.ledger_groups(id,user_id,metadata,origin_group_id,corrects_group_id,chain_id) values((item->>'group_id')::uuid,uid,m,(m->>'origin_group_id')::uuid,(m->>'corrects_group_id')::uuid,(m->>'chain_id')::uuid) on conflict (id,user_id) do nothing;
    if exists(select 1 from public.entries e where e.id=(item->>'id')::uuid) then
      if action<>'import' or not exists(select 1 from public.entries e where e.id=(item->>'id')::uuid and e.user_id=uid and row(e.financial,e.amount_centavos,e.group_id,e.envelope_id,e.category_id,e.kind,e.note,e.occurred_at,e.money_type,e.voided_at,e.void_reason) is not distinct from row(m,(item->>'amount_centavos')::bigint,(item->>'group_id')::uuid,(item->>'envelope_id')::uuid,(item->>'category_id')::uuid,item->>'kind',item->>'note',(item->>'occurred_at')::timestamptz,item->>'money_type',(item->>'voided_at')::timestamptz,item->>'void_reason')) then raise exception 'Entry identity conflict' using errcode='23514'; end if;
    else
      insert into public.entries(id,user_id,group_id,kind,envelope_id,category_id,amount_centavos,note,occurred_at,money_type,financial,voided_at,void_reason) values((item->>'id')::uuid,uid,(item->>'group_id')::uuid,item->>'kind',(item->>'envelope_id')::uuid,(item->>'category_id')::uuid,(item->>'amount_centavos')::bigint,item->>'note',(item->>'occurred_at')::timestamptz,item->>'money_type',m,(item->>'voided_at')::timestamptz,item->>'void_reason');
    end if;
  end loop;
  if action in ('correct','void','restore') then
    update public.entries set voided_at=case when action='restore' then null else at_time end,void_reason=case when action='restore' then null else coalesce(p_operation->>'reason',case when action='correct' then 'Corrected' end) end where user_id=uid and group_id=target;
  end if;
  if p_operation ? 'obligation' then
    item:=p_operation->'obligation';
    insert into public.obligations(id,user_id,type,origin_group_id,amount_centavos,person,due_on,note,recorded_at,voided_at,effective_at) values((item->>'id')::uuid,uid,item->>'type',(item->>'origin_group_id')::uuid,(item->>'amount_centavos')::bigint,item->>'person',(item->>'due_on')::date,item->>'note',(item->>'recorded_at')::timestamptz,(item->>'voided_at')::timestamptz,(item->>'effective_at')::timestamptz);
  end if;
  if action='import' then
    for item in select value from jsonb_array_elements(coalesce(p_operation->'obligations','[]')) loop
      if exists(select 1 from public.obligations where id=(item->>'id')::uuid and user_id=uid) then
        if not exists(select 1 from public.obligations o where o.id=(item->>'id')::uuid and o.user_id=uid and row(o.type,o.origin_group_id,o.amount_centavos,o.person,o.due_on,o.note,o.recorded_at,o.voided_at,o.effective_at) is not distinct from row(item->>'type',(item->>'origin_group_id')::uuid,(item->>'amount_centavos')::bigint,item->>'person',(item->>'due_on')::date,item->>'note',(item->>'recorded_at')::timestamptz,(item->>'voided_at')::timestamptz,(item->>'effective_at')::timestamptz)) then raise exception 'Obligation identity conflict' using errcode='23514'; end if;
      else
        insert into public.obligations(id,user_id,type,origin_group_id,amount_centavos,person,due_on,note,recorded_at,voided_at,effective_at) values((item->>'id')::uuid,uid,item->>'type',(item->>'origin_group_id')::uuid,(item->>'amount_centavos')::bigint,item->>'person',(item->>'due_on')::date,item->>'note',(item->>'recorded_at')::timestamptz,(item->>'voided_at')::timestamptz,(item->>'effective_at')::timestamptz);
      end if;
    end loop;
    for item in select value from jsonb_array_elements(coalesce(p_operation->'audit','[]')) loop
      if exists(select 1 from public.ledger_audit where id=(item->>'id')::uuid) then
        if not exists(select 1 from public.ledger_audit a where a.id=(item->>'id')::uuid and a.user_id=uid and row(a.operation_id,a.group_id,a.action,a.recorded_at,a.details) is not distinct from row((item->>'operation_id')::uuid,(item->>'group_id')::uuid,item->>'action',(item->>'recorded_at')::timestamptz,item->'details')) then raise exception 'Audit identity conflict' using errcode='23514'; end if;
      else
        insert into public.ledger_audit(id,user_id,operation_id,group_id,action,recorded_at,details) values((item->>'id')::uuid,uid,(item->>'operation_id')::uuid,(item->>'group_id')::uuid,item->>'action',(item->>'recorded_at')::timestamptz,item->'details');
      end if;
    end loop;
  elsif p_operation ? 'obligations' or p_operation ? 'audit' then raise exception 'Import command required' using errcode='23514'; end if;
  if action='cancel_claim' then
    if jsonb_array_length(p_operation->'rows')<>0 or not exists(select 1 from public.obligations where user_id=uid and id=(p_operation->>'cancel_obligation_id')::uuid and voided_at is null and (type='expense_reimbursement' or origin_group_id is null)) or exists(select 1 from public.entries where user_id=uid and voided_at is null and financial->>'obligation_id'=p_operation->>'cancel_obligation_id') then raise exception 'Resolve payments before cancellation' using errcode='23514'; end if;
    update public.obligations set voided_at=at_time where user_id=uid and id=(p_operation->>'cancel_obligation_id')::uuid;
  elsif p_operation ? 'cancel_obligation_id' then raise exception 'Cancellation command required' using errcode='23514'; end if;
  perform public.validate_financial_ledger(uid);
  insert into public.ledger_audit(id,user_id,operation_id,group_id,action,recorded_at,details) values(op_id,uid,op_id,coalesce((p_operation->'rows'->0->>'group_id')::uuid,target,(p_operation->'obligation'->>'origin_group_id')::uuid),action,at_time,coalesce(check_data-'expected_rows',jsonb_build_object('reason',p_operation->>'reason')));
end $$;
revoke all on function public.apply_financial_operation(jsonb) from public, anon;
grant execute on function public.apply_financial_operation(jsonb) to authenticated;

create function public.financial_capabilities() returns integer language sql stable set search_path = '' as $$ select 1 $$;
revoke all on function public.financial_capabilities() from public,anon;
grant execute on function public.financial_capabilities() to authenticated;

-- Keep the prior reset's public result contract; extend cleanup atomically.
alter function public.reset_account() rename to reset_account_before_financial;
revoke all on function public.reset_account_before_financial() from public,anon,authenticated;
create function public.reset_account() returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid:=auth.uid(); result jsonb; n_obligations bigint; n_audit bigint;
begin
  if uid is null then raise exception 'Authentication required' using errcode='28000'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text,7107));
  select count(*) into n_obligations from public.obligations where user_id=uid;
  select count(*) into n_audit from public.ledger_audit where user_id=uid;
  delete from public.ledger_audit where user_id=uid;
  delete from public.ledger_operations where user_id=uid;
  delete from public.obligations where user_id=uid;
  result:=public.reset_account_before_financial();
  delete from public.ledger_groups where user_id=uid;
  update public.profiles set week_start='monday' where id=uid;
  return result||jsonb_build_object('obligations',n_obligations,'ledger_audit',n_audit);
end $$;
revoke all on function public.reset_account() from public,anon;
grant execute on function public.reset_account() to authenticated;
commit;
