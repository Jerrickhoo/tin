import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

/** Runs against disposable PostgreSQL; no live credentials or production writes. */
export async function checkSchedulesSql(db) {
  let passed = 0
  await db.exec('reset role')
  const uid = randomUUID(),
    other = randomUUID(),
    env = randomUUID(),
    foreign = randomUUID(),
    cat = randomUUID(),
    sid = randomUUID()
  await db.query('insert into auth.users values($1),($2)', [uid, other])
  await db.query('insert into public.envelopes(id,user_id,name) values($1,$2,$3),($4,$5,$6)', [
    env,
    uid,
    'Schedules',
    foreign,
    other,
    'Foreign',
  ])
  await db.query('insert into public.categories(id,user_id,envelope_id,name) values($1,$2,$3,$4)', [
    cat,
    uid,
    env,
    'Bills',
  ])
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid])
  const headers = `select set_config('request.headers','{"x-client-info":"tin-ledger/2","x-tin-goals":"1","x-tin-schedules":"1"}',false)`
  await db.exec(`set role authenticated; ${headers}`)
  const now = new Date().toISOString(),
    month = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
    }).format(new Date()),
    due = `${month}-01`
  const base = (type, key, extra, previous = null) => ({
    id: randomUUID(),
    type,
    key,
    previous_event_id: previous,
    ...extra,
  })
  const definition = base('schedule', `schedule:${sid}`, {
    schedule_id: sid,
    name: 'Installments',
    kind: 'installment',
    envelope_id: env,
    category_id: cat,
    money_type: 'online',
    start_on: due,
    day: 1,
    effective_month: month,
    state: 'active',
    amounts: [100000, 100000, 100000],
    fees: [0, 0, 1],
    purchase_reviewed: true,
    legacy_template_id: null,
    cutover_on: null,
  })
  const command = (events = [], amount = 0) => {
    const id = randomUUID(),
      group = randomUUID()
    return {
      id,
      action: 'post',
      recorded_at: now,
      schedule_events: events,
      rows: amount
        ? [
            {
              id: randomUUID(),
              group_id: group,
              kind: amount < 0 ? 'expense' : 'income',
              envelope_id: env,
              category_id: amount < 0 ? cat : null,
              amount_centavos: amount,
              note: null,
              money_type: 'online',
              occurred_at: now,
              voided_at: null,
              void_reason: null,
              financial: {
                version: 1,
                intent: amount < 0 ? 'purchase' : 'ordinary_income',
                operation_id: id,
                recorded_at: now,
                chain_id: group,
              },
            },
          ]
        : [],
    }
  }
  const call = (op) =>
    db.query('select public.apply_financial_operation($1::jsonb)', [JSON.stringify(op)])
  const reject = async (op) => {
    await assert.rejects(call(op))
    passed++
  }
  const check = async (sql, params, expected) => {
    await db.exec('reset role')
    const result = (await db.query(sql, params)).rows[0]
    assert.equal(Number(Object.values(result)[0]), expected)
    await db.exec('set role authenticated')
    passed++
  }
  const first = base('occurrence', `due:${sid}:1`, {
    schedule_id: sid,
    definition_id: definition.id,
    period: '1',
    due_on: due,
    amount_centavos: 100000,
    fee_centavos: 0,
  })
  await call(command([], 500000))
  await call(command([definition]))
  passed++
  await check('select count(*) from public.entries where user_id=$1', [uid], 1)
  await reject(command([{ ...definition, id: randomUUID(), key: `schedule:${randomUUID()}` }]))
  await reject(command([{ ...definition, id: randomUUID(), envelope_id: foreign }]))
  await reject(command([{ ...definition, id: randomUUID(), purchase_reviewed: false }]))
  await reject(command([{ ...first, amount_centavos: 99999 }]))
  const reserve = base('reservation', `reservation:${first.key}`, {
    occurrence_key: first.key,
    amount_centavos: 100000,
  })
  await call(command([first, reserve]))
  passed++
  await check('select public.goal_free($1,$2)', [uid, env], 400000)
  await reject(
    command([
      { ...reserve, id: randomUUID(), previous_event_id: reserve.id, amount_centavos: 100001 },
    ]),
  )
  const partial = command([], -40000),
    chain = partial.rows[0].group_id
  partial.schedule_events = [
    base('payment', `payment:${chain}`, {
      purchase_chain_id: chain,
      allocations: [{ occurrence_key: first.key, amount_centavos: 40000 }],
    }),
  ]
  await call(partial)
  await call(partial)
  passed++
  await check('select public.schedule_paid($1,$2)', [uid, first.key], 40000)
  await check('select public.schedule_reserved($1,$2)', [uid, env], 60000)
  await check('select public.goal_free($1,$2)', [uid, env], 400000)
  const stale = command([], -70000),
    staleChain = stale.rows[0].group_id
  stale.schedule_events = [
    base('payment', `payment:${staleChain}`, {
      purchase_chain_id: staleChain,
      allocations: [{ occurrence_key: first.key, amount_centavos: 70000 }],
    }),
  ]
  await reject(stale)
  await check('select count(*) from public.entries where group_id=$1', [staleChain], 0)
  const rest = command([], -60000),
    restChain = rest.rows[0].group_id
  rest.schedule_events = [
    base('payment', `payment:${restChain}`, {
      purchase_chain_id: restChain,
      allocations: [{ occurrence_key: first.key, amount_centavos: 60000 }],
    }),
  ]
  await call(rest)
  passed++
  await check('select public.schedule_reserved($1,$2)', [uid, env], 0)
  await call({
    id: randomUUID(),
    action: 'void',
    recorded_at: now,
    rows: [],
    target_group_id: restChain,
  })
  passed++
  await check('select public.schedule_paid($1,$2)', [uid, first.key], 40000)
  await call({
    id: randomUUID(),
    action: 'restore',
    recorded_at: now,
    rows: [],
    target_group_id: restChain,
  })
  passed++
  await check('select public.schedule_paid($1,$2)', [uid, first.key], 100000)
  // Existing expenses link without a second signed row.
  const secondMonth = new Date(`${month}-01T00:00:00Z`)
  secondMonth.setUTCMonth(secondMonth.getUTCMonth() + 1)
  const next = secondMonth.toISOString().slice(0, 7),
    second = base('occurrence', `due:${sid}:2`, {
      schedule_id: sid,
      definition_id: definition.id,
      period: '2',
      due_on: `${next}-01`,
      amount_centavos: 100000,
      fee_centavos: 0,
    })
  const existing = command([], -100000)
  await call(existing)
  const link = base('payment', `payment:${existing.rows[0].group_id}`, {
    purchase_chain_id: existing.rows[0].group_id,
    allocations: [{ occurrence_key: second.key, amount_centavos: 100000 }],
  })
  await call(command([second, link]))
  passed++
  await reject(command([{ ...link, id: randomUUID() }]))
  await check(
    'select count(*) from public.entries where group_id=$1',
    [existing.rows[0].group_id],
    1,
  )
  // Finite obligations cannot be hidden by subscription lifecycle controls.
  const cancel = {
    ...definition,
    ...base('schedule', definition.key, {}, definition.id),
    effective_month: next,
    state: 'canceled',
  }
  await reject(command([cancel]))
  await reject(command([{ ...cancel, state: 'paused' }]))
  await reject(
    command([
      base('resolution', `resolution:${first.key}`, {
        occurrence_key: first.key,
        state: 'skipped',
      }),
    ]),
  )
  const subscriptionId = randomUUID(),
    subscription = {
      ...definition,
      ...base('schedule', `schedule:${subscriptionId}`, {}),
      schedule_id: subscriptionId,
      kind: 'subscription',
      amounts: [29900],
      fees: [0],
      purchase_reviewed: false,
    }
  const subDue = base('occurrence', `due:${subscriptionId}:${month}`, {
      schedule_id: subscriptionId,
      definition_id: subscription.id,
      period: month,
      due_on: due,
      amount_centavos: 29900,
      fee_centavos: 0,
    }),
    subReserve = base('reservation', `reservation:${subDue.key}`, {
      occurrence_key: subDue.key,
      amount_centavos: 29900,
    })
  await call(command([subscription]))
  await call(command([subDue, subReserve]))
  await call(command([], -280000))
  passed++
  await check('select public.schedule_free_raw($1,$2)', [uid, env], -9900)
  await reject(command([{ ...subReserve, id: randomUUID(), previous_event_id: subReserve.id }]))
  await call(
    command([
      { ...subReserve, id: randomUUID(), previous_event_id: subReserve.id, amount_centavos: 0 },
    ]),
  )
  passed++
  await call(
    command([
      {
        ...subscription,
        ...base('schedule', subscription.key, {}, subscription.id),
        effective_month: next,
        state: 'canceled',
      },
    ]),
  )
  passed++
  await reject(
    command([
      base('reservation', subReserve.key, { occurrence_key: subDue.key, amount_centavos: 1 }),
    ]),
  )
  await db.exec(
    `select set_config('request.headers','{"x-client-info":"tin-ledger/2","x-tin-goals":"1"}',false)`,
  )
  await reject(command([], 1))
  await db.exec(headers)
  await assert.rejects(db.query('select public.schedule_events($1)', [uid]))
  passed++
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [other])
  await reject(command([{ ...definition, id: randomUUID() }]))
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid])
  // Reviewed conversion skips an already posted *voided* legacy group.
  const thirdDate = new Date(`${due}T00:00:00Z`)
  thirdDate.setUTCMonth(thirdDate.getUTCMonth() + 2)
  const third = base('occurrence', `due:${sid}:3`, {
      schedule_id: sid,
      definition_id: definition.id,
      period: '3',
      due_on: thirdDate.toISOString().slice(0, 10),
      amount_centavos: 100000,
      fee_centavos: 1,
    }),
    thirdHold = base('reservation', `reservation:due:${sid}:3`, {
      occurrence_key: `due:${sid}:3`,
      amount_centavos: 10000,
    })
  await call(command([third, thirdHold]))
  passed++
  const revised = {
      ...definition,
      ...base('schedule', definition.key, {}, definition.id),
      effective_month: next,
      amounts: [100000, 100000, 120000],
    },
    revisedThird = {
      ...third,
      id: randomUUID(),
      previous_event_id: third.id,
      definition_id: revised.id,
      amount_centavos: 120000,
    }
  await call(command([revised, revisedThird]))
  passed++
  await check(
    "select count(*) from public.schedule_events($1) h where h->>'key'=$2",
    [uid, third.key],
    2,
  )
  await check('select public.schedule_reserved($1,$2)', [uid, env], 10000)
  await reject(
    command([
      { ...second, id: randomUUID(), previous_event_id: second.id, definition_id: revised.id },
    ]),
  )
  const thirdPayment = command([], -120001),
    thirdChain = thirdPayment.rows[0].group_id
  thirdPayment.schedule_events = [
    base('payment', `payment:${thirdChain}`, {
      purchase_chain_id: thirdChain,
      allocations: [{ occurrence_key: third.key, amount_centavos: 120001 }],
    }),
  ]
  await call(thirdPayment)
  passed++
  await reject(command([{ ...revisedThird, id: randomUUID(), previous_event_id: revisedThird.id }]))
  const maxId = randomUUID(),
    maxDefinition = {
      ...definition,
      ...base('schedule', `schedule:${maxId}`, {}),
      schedule_id: maxId,
      amounts: Array(120).fill(1),
      fees: Array(120).fill(0),
    }
  await call(command([maxDefinition]))
  const maxPay = command([], -120),
    maxChain = maxPay.rows[0].group_id,
    terms = Array.from({ length: 120 }, (_, i) => {
      const date = new Date(`${due}T00:00:00Z`)
      date.setUTCMonth(date.getUTCMonth() + i)
      return base('occurrence', `due:${maxId}:${i + 1}`, {
        schedule_id: maxId,
        definition_id: maxDefinition.id,
        period: String(i + 1),
        due_on: date.toISOString().slice(0, 10),
        amount_centavos: 1,
        fee_centavos: 0,
      })
    })
  maxPay.schedule_events = [
    ...terms,
    base('payment', `payment:${maxChain}`, {
      purchase_chain_id: maxChain,
      allocations: terms.map((o) => ({ occurrence_key: o.key, amount_centavos: 1 })),
    }),
  ]
  await call(maxPay)
  passed++
  await check('select count(*) from public.entries where group_id=$1', [maxChain], 1)
  await db.exec("reset role; select set_config('request.jwt.claim.sub','',false)")
  const template = randomUUID(),
    legacySid = randomUUID()
  await db.query(
    "insert into public.recurring_templates(id,user_id,kind,category_id,amount_centavos,note,day_of_month,next_run_on,money_type) values($1,$2,'expense',$3,29900,'Legacy',1,$4,'online')",
    [template, uid, cat, due],
  )
  const legacyGroup = (
    await db.query(
      "select extensions.uuid_generate_v5('5f0be0b2-f0aa-4dcf-9f39-4f4a30e5f524',$1) id",
      [`${template}:${due}:group`],
    )
  ).rows[0].id
  await db.query(
    "insert into public.entries(id,user_id,group_id,kind,envelope_id,category_id,amount_centavos,occurred_at,voided_at) values($1,$2,$1,'expense',$3,$4,-29900,$5,now())",
    [legacyGroup, uid, env, cat, `${due}T04:00:00Z`],
  )
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid])
  await db.exec('set role authenticated')
  const conversion = {
    ...definition,
    ...base('schedule', `schedule:${legacySid}`, {}),
    schedule_id: legacySid,
    name: 'Legacy',
    kind: 'subscription',
    amounts: [29900],
    fees: [0],
    purchase_reviewed: false,
    start_on: `${next}-01`,
    effective_month: next,
    legacy_template_id: template,
    cutover_on: `${next}-01`,
  }
  await reject(command([{ ...conversion, start_on: due, cutover_on: due, effective_month: month }]))
  await call(command([conversion]))
  passed++
  await check(
    'select count(*) from public.recurring_templates where id=$1 and paused_at is not null',
    [template],
    1,
  )
  await assert.rejects(
    db.query('update public.recurring_templates set paused_at=null where id=$1', [template]),
  )
  passed++
  const repost = command([], -29900)
  await db.exec('reset role')
  const convertedGroup = (
    await db.query(
      "select extensions.uuid_generate_v5('5f0be0b2-f0aa-4dcf-9f39-4f4a30e5f524',$1) id",
      [`${template}:${next}-01:group`],
    )
  ).rows[0].id
  await db.exec('set role authenticated')
  repost.rows[0].group_id = convertedGroup
  repost.rows[0].financial.chain_id = convertedGroup
  repost.rows[0].occurred_at = `${next}-01T04:00:00Z`
  await reject(repost)
  // Account reset includes all schedule history and preserved converted templates.
  const resetTables = [
    'entries',
    'recurring_templates',
    'categories',
    'envelopes',
    'checkin_days',
    'streak_saves',
    'obligations',
    'ledger_audit',
    'ledger_operations',
    'ledger_groups',
  ]
  const beforeReset = {}
  for (const table of resetTables)
    beforeReset[table] = Number(
      (await db.query(`select count(*) n from public.${table} where user_id=$1`, [uid])).rows[0].n,
    )
  const resetSummary = (await db.query('select public.reset_account() summary')).rows[0].summary
  for (const [key, table] of Object.entries({
    entries: 'entries',
    recurring: 'recurring_templates',
    categories: 'categories',
    envelopes: 'envelopes',
    checkins: 'checkin_days',
    streak_saves: 'streak_saves',
    obligations: 'obligations',
    ledger_audit: 'ledger_audit',
  })) {
    assert.equal(Number(resetSummary[key]), beforeReset[table], `Reset summary ${key}`)
    passed++
  }
  passed++
  for (const table of resetTables)
    await check(`select count(*) from public.${table} where user_id=$1`, [uid], 0)
  await db.exec('reset role')
  await check(
    'select count(*) from public.envelopes where id=$1 and user_id=$2',
    [foreign, other],
    1,
  )
  return passed
}
