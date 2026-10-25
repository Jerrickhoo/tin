async page => {
  await page.getByText('Build 2026.10.25.p8',{exact:true}).waitFor();
  await page.getByRole('button',{name:/queued|Syncing|Sync stuck|Offline/}).waitFor({state:'hidden'});
  await page.getByRole('link',{name:'Home',exact:true}).click();await page.locator('.balance-hero').getByText('₱9,534.98',{exact:true}).waitFor();
  const queued=await page.evaluate(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('tin-local');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});const count=await new Promise((resolve,reject)=>{const r=db.transaction('outbox').objectStore('outbox').count();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});db.close();return count});
  if(queued!==0) throw new Error('Queue did not drain');
  return {passed:true,legacy:'P4 cached service worker',currentPatch:'2026.10.25.p8',queueBeforeUpgrade:1,queueAfterReconnect:queued,finalBalance:'953498 centavos'};
}
