import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createClient} from '@supabase/supabase-js'
import {protectedProjectRefs,validateStagingTarget} from '../../../scripts/p2-staging.mjs'
const config=JSON.parse(await readFile('output/playwright/p8/staging-config.local.json','utf8'))
validateStagingTarget({P2_STAGING_PROJECT_REF:config.projectRef,P2_STAGING_DISPOSABLE:'true'},await protectedProjectRefs())
const api=createClient(config.url,config.anonKey,{auth:{persistSession:false,autoRefreshToken:false},global:{headers:{'X-Client-Info':'tin-ledger/2','X-Tin-Goals':'1','X-Tin-Schedules':'1'}}})
const session=await api.auth.setSession(config.session);assert.equal(session.error,null)
assert.equal(session.data.user.email,'p8-browser@tin-staging.test')
const result=await api.from('entries').select('id,group_id,amount_centavos,money_type,note,voided_at');assert.equal(result.error,null)
const entries=result.data, expected=[['P8 device A offline',-16500],['P8 device B offline',-20002],['P8 cached client queued',-10001]]
for(const [note,cents] of expected) {const rows=entries.filter(r=>r.note===note);assert.equal(rows.length,1,note);assert.equal(rows[0].amount_centavos,cents);assert.equal(rows[0].money_type,'online');assert.equal(rows[0].voided_at,null)}
assert.equal(entries.length,4)
assert.equal(entries.filter(r=>!r.voided_at).reduce((s,r)=>s+BigInt(r.amount_centavos),0n),953498n)
const report={passed:true,daily_project_excluded:true,mode:'authenticated read-only fixture verification',financial_entries:entries.length,unique_groups:new Set(entries.map(r=>r.group_id)).size,signed_balance_centavos:953498,exactly_once_offline_writes:true,old_client_queue_preserved:true}
await writeFile('output/playwright/p8/server-verification.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
