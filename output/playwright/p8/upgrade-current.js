async page => {
  await page.context().route('https://*.supabase.co/**',r=>r.abort());
  await page.context().setOffline(false);
  await page.goto('http://127.0.0.1:5199/');await page.getByRole('button',{name:/Needs:/}).waitFor();
  await page.evaluate(async()=>{const registration=await navigator.serviceWorker.getRegistration();await registration.update()});
  await page.waitForFunction(async()=>{const registration=await navigator.serviceWorker.getRegistration();return registration&&!registration.installing&&!registration.waiting});
  await page.reload();await page.getByRole('button',{name:/Needs:/}).waitFor();
  await page.getByRole('link',{name:'Settings',exact:true}).click();await page.getByRole('link',{name:/Patch notes/}).click();
  await page.getByText('Build 2026.10.25.p8',{exact:true}).waitFor();
  const queued=await page.evaluate(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('tin-local');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});const count=await new Promise((resolve,reject)=>{const r=db.transaction('outbox').objectStore('outbox').count();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});db.close();return count});
  if(queued!==1) throw new Error('Upgrade changed the pending queue: '+queued);
  await page.context().unroute('https://*.supabase.co/**');await page.reload();await page.getByRole('heading',{name:'Patch notes',exact:true}).waitFor();
  await page.getByRole('button',{name:/queued|Syncing|Sync stuck|Offline/}).waitFor({state:'hidden'});
  await page.getByRole('link',{name:'Home',exact:true}).click();await page.locator('.balance-hero').getByText('₱9,534.98',{exact:true}).waitFor();
  return {passed:true,currentPatch:'2026.10.25.p8',queuePreservedDuringUpgrade:queued,drainedAfterReconnect:true,finalBalance:'953498 centavos'};
}
