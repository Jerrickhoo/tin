import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'
import { protectedProjectRefs, validateStagingTarget } from '../../../scripts/p2-staging.mjs'
const config=JSON.parse(await readFile('output/playwright/p5/staging-config.local.json','utf8'))
validateStagingTarget({P2_STAGING_PROJECT_REF:config.projectRef,P2_STAGING_DISPOSABLE:'true'},await protectedProjectRefs())
assert.equal(config.url,`https://${config.projectRef}.supabase.co`)
const client=createClient(config.url,config.anonKey,{auth:{persistSession:false,autoRefreshToken:false}})
const auth=await client.auth.signInWithPassword({email:config.email,password:config.password})
assert.equal(auth.error,null)
const {data:debts,error}=await client.from('obligations').select('*').like('person','P6 %')
assert.equal(error,null);assert.equal(debts.length,3)
const {data:rows,error:rowError}=await client.from('entries').select('*').eq('user_id',auth.data.user.id)
assert.equal(rowError,null)
const checks=[]
for(const debt of debts){
 const payments=rows.filter(r=>r.financial?.obligation_id===debt.id)
 const paid=payments.filter(r=>!r.voided_at).reduce((n,r)=>n+Math.abs(r.amount_centavos),0)
 if(debt.person==='P6 borrowed Alex'){assert.equal(paid,20002);assert.equal(payments[0].amount_centavos,-20002)}
 if(debt.person==='P6 historical Sam'){assert.equal(debt.origin_group_id,null);assert.equal(paid,0);assert.ok(payments.some(r=>r.voided_at && r.amount_centavos===4001))}
 if(debt.person==='P6 lent Alex'){assert.equal(paid,0);assert.equal(rows.find(r=>r.group_id===debt.origin_group_id).amount_centavos,-20002)}
 checks.push({person:debt.person,original:debt.amount_centavos,paid,remaining:debt.amount_centavos-paid,payments:payments.length})
}
const report={passed:true,dailyProjectExcluded:true,checks}
await writeFile('output/playwright/p6/server-verification.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report))
await client.auth.signOut()
