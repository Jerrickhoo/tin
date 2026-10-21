// Called by the disposable PostgreSQL rehearsal; no external credentials.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export async function checkGoalsSql(db) {
  let passed = 0
  await db.exec('reset role')
  const uid = randomUUID(),
    foreign = randomUUID(),
    env = randomUUID(),
    otherEnv = randomUUID(),
    goal = randomUUID(),
    second = randomUUID()
  await db.query('insert into auth.users values($1),($2)', [uid, foreign])
  await db.query('insert into public.envelopes(id,user_id,name) values($1,$2,$3),($4,$5,$6)', [
    env,
    uid,
    'Wants',
    otherEnv,
    foreign,
    'Foreign',
  ])
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid])
  await db.exec(
    `set role authenticated; select set_config('request.headers','{"x-client-info":"tin-ledger/2","x-tin-goals":"1"}',false)`,
  )
  const base = (type, key, extra = {}, previous = null) => ({
    id: randomUUID(),
    type,
    key,
    previous_event_id: previous,
    envelope_id: env,
    ...extra,
  })
  const command = (
    events = [],
    amount = 0,
    intent = amount < 0 ? 'purchase' : 'ordinary_income',
  ) => {
    const id = randomUUID(),
      chain = randomUUID(),
      at = new Date().toISOString()
    return {
      id,
      action: 'post',
      recorded_at: at,
      goal_events: events,
      rows: amount
        ? [
            {
              id: randomUUID(),
              group_id: chain,
              kind: amount < 0 ? 'expense' : 'income',
              envelope_id: env,
              category_id: null,
              amount_centavos: amount,
              note: null,
              money_type: 'online',
              occurred_at: at,
              voided_at: null,
              void_reason: null,
              financial: { version: 1, intent, operation_id: id, recorded_at: at, chain_id: chain },
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
  const projection = async () => {
    await db.exec('reset role')
    const g = (await db.query('select * from public.goal_projection($1,$2)', [uid, env])).rows
    const free = Number(
      (await db.query('select public.goal_free($1,$2) free', [uid, env])).rows[0].free,
    )
    await db.exec('set role authenticated')
    return { goals: g, free }
  }
  const month = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date())
  const definition = base('goal', `goal:${goal}`, {
    goal_id: goal,
    name: 'Watch',
    target_centavos: 100000,
    mode: 'one_time',
    deadline: null,
    state: 'active',
  })
  const secondary = base('goal', `goal:${second}`, {
    goal_id: second,
    name: 'ETF',
    target_centavos: 100000,
    mode: 'ongoing',
    deadline: null,
    state: 'active',
  })
  const receipt = command([], 100000)
  await call(receipt)
  await call(command([definition, secondary]))
  passed++
  const reserve = (n) => {
    const e = base('reserve', '', { goal_id: goal, amount_centavos: n, month })
    e.key = `reserve:${e.id}`
    return e
  }
  const funded = command([reserve(30000)])
  await call(funded)
  await call(funded)
  assert.equal((await projection()).free, 70000)
  passed++
  const release = base('release', '', { goal_id: goal, amount_centavos: 10000 })
  release.key = `release:${release.id}`
  await call(command([release]))
  assert.equal((await projection()).free, 80000)
  passed++
  const buy = command([], 20000 * -1)
  buy.goal_events = [
    base('purchase', `purchase:${buy.rows[0].group_id}`, {
      goal_id: goal,
      purchase_chain_id: buy.rows[0].group_id,
    }),
  ]
  await call(buy)
  let p = await projection()
  assert.equal(p.free, 80000)
  assert.equal(Number(p.goals.find((g) => g.goal_id === goal).reserved), 0)
  assert.equal(Number(p.goals.find((g) => g.goal_id === goal).spent), 20000)
  passed++
  await call({ ...command(), action: 'void', target_group_id: buy.rows[0].group_id })
  assert.equal((await projection()).free, 80000)
  passed++
  await call({ ...command(), action: 'restore', target_group_id: buy.rows[0].group_id })
  passed++
  await reject(command([reserve(90000)]))
  await reject(command([{ ...reserve(1), envelope_id: otherEnv }]))
  await reject(command([{ ...reserve(1), goal_id: randomUUID() }]))
  await reject(command([{ ...definition, id: randomUUID(), state: 'held' }]))
  await reject(command([{ ...reserve(1), unknown: 'silently dropped' }]))
  await db.exec(`select set_config('request.headers','{"x-client-info":"tin-ledger/2"}',false)`)
  await reject(command([], 1))
  await db.exec(
    `select set_config('request.headers','{"x-client-info":"tin-ledger/2","x-tin-goals":"1"}',false)`,
  )
  await assert.rejects(
    db.query(
      "insert into public.entries(id,group_id,kind,envelope_id,amount_centavos,occurred_at) values($1,$1,'income',$2,1,now())",
      [randomUUID(), env],
    ),
  )
  passed++
  const split = base('split', `split:${env}`, {
    shares: [{ goal_id: goal, bp: 3000 }],
    unreserved_bp: 7000,
  })
  await call(command([split]))
  passed++
  await reject(command([], 100000)) // cannot omit captured allocation
  const capturedIncome = command([], 100000),
    chain = capturedIncome.rows[0].group_id
  const capture = base('capture', `capture:${chain}:${env}`, {
    receipt_chain_id: chain,
    split_event_id: split.id,
    month,
    source_centavos: 100000,
    allocations: [{ goal_id: goal, requested_centavos: 30000, amount_centavos: 30000 }],
  })
  capturedIncome.goal_events = [capture]
  await call(capturedIncome)
  await call(capturedIncome)
  assert.equal((await projection()).free, 150000)
  passed++
  await reject(
    command([
      {
        ...capture,
        id: randomUUID(),
        allocations: [{ goal_id: goal, requested_centavos: 90000, amount_centavos: 90000 }],
      },
    ]),
  )
  const split40 = {
    ...split,
    id: randomUUID(),
    previous_event_id: split.id,
    shares: [{ goal_id: goal, bp: 4000 }],
    unreserved_bp: 6000,
  }
  await call(command([split40]))
  passed++
  await call({ ...command(), action: 'void', target_group_id: chain })
  p = await projection()
  assert.equal(p.free, 80000)
  passed++
  await call({ ...command(), action: 'restore', target_group_id: chain })
  assert.equal((await projection()).free, 150000)
  passed++
  const correction = command([], 50000)
  correction.action = 'correct'
  correction.predecessor = capturedIncome.rows
  correction.rows[0].financial = {
    ...correction.rows[0].financial,
    corrects_group_id: chain,
    chain_id: chain,
  }
  await call(correction)
  assert.equal((await projection()).free, 115000)
  passed++
  const ruleId = randomUUID(),
    rule = base('rule', `rule:${ruleId}`, {
      rule_id: ruleId,
      goal_id: second,
      method: 'fixed',
      value: 200000,
      day: 31,
      state: 'active',
    })
  await call(command([rule]))
  passed++
  const occurrence = base('occurrence', `occurrence:${ruleId}:${month}`, {
      rule_id: ruleId,
      rule_event_id: rule.id,
      goal_id: second,
      month,
      requested_centavos: 200000,
      amount_centavos: 115000,
    }),
    occOp = command([occurrence])
  await call(occOp)
  await call(occOp)
  assert.equal((await projection()).free, 0)
  passed++
  await reject(command([{ ...occurrence, id: randomUUID() }]))
  await reject(
    command([
      {
        ...occurrence,
        id: randomUUID(),
        previous_event_id: occurrence.id,
        amount_centavos: 115001,
      },
    ]),
  )
  const partialTopUp = command([], 10000),
    nextChain = partialTopUp.rows[0].group_id
  partialTopUp.goal_events = [
    base('capture', `capture:${nextChain}:${env}`, {
      receipt_chain_id: nextChain,
      split_event_id: split40.id,
      month,
      source_centavos: 10000,
      allocations: [{ goal_id: goal, requested_centavos: 4000, amount_centavos: 4000 }],
    }),
  ]
  await call(partialTopUp)
  passed++
  const retry = {
    ...occurrence,
    id: randomUUID(),
    previous_event_id: occurrence.id,
    amount_centavos: 121000,
  }
  await call(command([retry]))
  assert.equal((await projection()).free, 0)
  passed++
  await call(command([{ ...rule, id: randomUUID(), previous_event_id: rule.id, state: 'paused' }]))
  await reject(
    command([{ ...retry, id: randomUUID(), previous_event_id: retry.id, amount_centavos: 121001 }]),
  )
  const close = {
    ...definition,
    id: randomUUID(),
    previous_event_id: definition.id,
    state: 'closed',
  }
  await call(command([close]))
  p = await projection()
  assert.equal(Number(p.goals.find((g) => g.goal_id === goal).reserved), 0)
  passed++
  await reject(
    command([{ ...close, id: randomUUID(), previous_event_id: close.id, state: 'active' }]),
  )
  const backup = {
    rows: (await db.query('select * from public.entries')).rows,
    audit: (await db.query('select * from public.ledger_audit')).rows,
  }
  await db.query('select public.reset_account()')
  await db.query('insert into public.envelopes(id,name) values($1,$2)', [env, 'Wants'])
  await call({ ...command(), action: 'import', ...backup })
  p = await projection()
  assert.equal(p.goals.length, 2)
  assert.equal(Number(p.goals.find((g) => g.goal_id === goal).reserved), 0)
  passed++
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [foreign])
  assert.equal((await db.query('select count(*)::int n from public.ledger_audit')).rows[0].n, 0)
  await reject(command([reserve(1)]))
  passed++
  await assert.rejects(db.query('select * from public.goal_events($1)', [uid]))
  passed++
  await db.exec('set role anon')
  await assert.rejects(db.query('select public.goals_capabilities()'))
  passed++
  // Exercise clock skew and future revisions independently of earlier caps.
  await db.exec('reset role')
  const futureOwner = randomUUID(),
    futureEnv = randomUUID(),
    futureGoal = randomUUID()
  await db.query('insert into auth.users values($1)', [futureOwner])
  await db.query('insert into public.envelopes(id,user_id,name) values($1,$2,$3)', [
    futureEnv,
    futureOwner,
    'Future wants',
  ])
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [futureOwner])
  await db.exec('set role authenticated')
  const futureCommand = (events = [], amount = 0) => {
    const op = command(events, amount),
      at = new Date(Date.now() + 1000).toISOString()
    return {
      ...op,
      recorded_at: at,
      rows: op.rows.map((r) => ({
        ...r,
        envelope_id: futureEnv,
        occurred_at: at,
        financial: { ...r.financial, recorded_at: at },
      })),
    }
  }
  const futureBase = (type, key, extra = {}, previous = null) => ({
    ...base(type, key, extra, previous),
    envelope_id: futureEnv,
  })
  const futureDefinition = futureBase('goal', `goal:${futureGoal}`, {
    goal_id: futureGoal,
    name: 'Future goal',
    target_centavos: 100000,
    mode: 'one_time',
    deadline: null,
    state: 'active',
  })
  await call(futureCommand([], 100000))
  await call(futureCommand([futureDefinition]))
  const fReserve = futureBase('reserve', '', { goal_id: futureGoal, amount_centavos: 1000, month })
  fReserve.key = `reserve:${fReserve.id}`
  await call(futureCommand([fReserve]))
  passed++ // device is one second ahead
  const fPurchase = futureCommand([], -500)
  fPurchase.goal_events = [
    futureBase('purchase', `purchase:${fPurchase.rows[0].group_id}`, {
      goal_id: futureGoal,
      purchase_chain_id: fPurchase.rows[0].group_id,
    }),
  ]
  await call(fPurchase)
  const fSplit = futureBase('split', `split:${futureEnv}`, {
    shares: [{ goal_id: futureGoal, bp: 3000 }],
    unreserved_bp: 7000,
  })
  await call(futureCommand([fSplit]))
  const [year, monthNumber] = month.split('-').map(Number),
    nextMonth = `${monthNumber === 12 ? year + 1 : year}-${String(monthNumber === 12 ? 1 : monthNumber + 1).padStart(2, '0')}`
  const futureIncome = futureCommand([], 10000),
    futureChain = futureIncome.rows[0].group_id
  futureIncome.budget_event = {
    type: 'assignment',
    key: `assignment:${futureChain}`,
    previous_event_id: null,
    receipt_chain_id: futureChain,
    month: nextMonth,
  }
  const fCapture = futureBase('capture', `capture:${futureChain}:${futureEnv}`, {
    receipt_chain_id: futureChain,
    split_event_id: fSplit.id,
    month: nextMonth,
    source_centavos: 10000,
    allocations: [{ goal_id: futureGoal, requested_centavos: 3000, amount_centavos: 3000 }],
  })
  futureIncome.goal_events = [fCapture]
  await call(futureIncome)
  passed++
  const fSplit40 = {
    ...fSplit,
    id: randomUUID(),
    previous_event_id: fSplit.id,
    shares: [{ goal_id: futureGoal, bp: 4000 }],
    unreserved_bp: 6000,
  }
  await call(futureCommand([fSplit40]))
  const fCapture40 = {
    ...fCapture,
    id: randomUUID(),
    previous_event_id: fCapture.id,
    split_event_id: fSplit40.id,
    allocations: [{ goal_id: futureGoal, requested_centavos: 4000, amount_centavos: 4000 }],
  }
  await call(futureCommand([fCapture40]))
  passed++
  await db.exec('reset role')
  let fp = (
    await db.query('select * from public.goal_projection($1,$2,$3)', [
      futureOwner,
      futureEnv,
      new Date(Date.now() + 2000).toISOString(),
    ])
  ).rows[0]
  assert.equal(Number(fp.future), 4000)
  assert.equal(Number(fp.reserved), 500)
  passed++
  fp = (
    await db.query('select * from public.goal_projection($1,$2,$3)', [
      futureOwner,
      futureEnv,
      `${nextMonth}-01T00:00:00+08:00`,
    ])
  ).rows[0]
  assert.equal(Number(fp.future), 0)
  assert.equal(Number(fp.reserved), 4500)
  passed++
  return passed
}
