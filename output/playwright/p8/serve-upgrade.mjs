import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile,readdir,writeFile} from 'node:fs/promises'
import {resolve,extname,sep} from 'node:path'
import {protectedProjectRefs,validateStagingTarget} from '../../../scripts/p2-staging.mjs'
const config=JSON.parse(await readFile('output/playwright/p8/staging-config.local.json','utf8'))
validateStagingTarget({P2_STAGING_PROJECT_REF:config.projectRef,P2_STAGING_DISPOSABLE:'true'},await protectedProjectRefs())
const builds={legacy:resolve('output/playwright/p4/staging-dist'),current:resolve('output/playwright/p8/staging-dist')}
for(const root of Object.values(builds)) {
 const js=await Promise.all((await readdir(root+'/assets')).filter(f=>f.endsWith('.js')).map(f=>readFile(root+'/assets/'+f,'utf8')))
 assert.ok(js.some(body=>body.includes(config.url)),'Both builds must use the guarded disposable project')
}
await writeFile('output/playwright/p8/upgrade-phase.local','legacy')
const state=JSON.parse(await readFile('output/playwright/p8/browser-state.local.json','utf8'))
state.origins[0].origin='http://127.0.0.1:5199'
await writeFile('output/playwright/p8/upgrade-state.local.json',JSON.stringify(state))
const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml'}
createServer(async(req,res)=>{
 try {
  const phase=(await readFile('output/playwright/p8/upgrade-phase.local','utf8')).trim(),root=builds[phase];assert.ok(root)
  const path=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname),candidate=resolve(root,'.'+path)
  assert.ok(candidate===root||candidate.startsWith(root+sep))
  let file=candidate,body
  try {body=await readFile(file)} catch {file=root+'/index.html';body=await readFile(file)}
  res.writeHead(200,{'Content-Type':types[extname(file)]??'application/octet-stream','Cache-Control':'no-cache'});res.end(body)
 }catch {res.writeHead(500);res.end('Fixture unavailable')}
}).listen(5199,'127.0.0.1',()=>console.log('Guarded legacy/current service-worker upgrade fixture ready on 5199'))
