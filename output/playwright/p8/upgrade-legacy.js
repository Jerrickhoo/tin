async page => {
  await page.goto('http://127.0.0.1:5199/');await page.getByRole('button',{name:/Needs:/}).waitFor();
  await page.evaluate(async()=>await navigator.serviceWorker.ready);await page.reload();await page.getByRole('button',{name:/Needs:/}).waitFor();
  if(!await page.evaluate(()=>!!navigator.serviceWorker.controller)) throw new Error('Legacy worker not controlling');
  await page.getByRole('link',{name:'Settings',exact:true}).click();await page.getByRole('link',{name:/Patch notes/}).click();
  if((await page.locator('main').innerText()).includes('2026.10.25.p8')) throw new Error('Legacy fixture already current');
  await page.getByRole('link',{name:'Home',exact:true}).click();await page.getByRole('button',{name:/Needs:/}).waitFor();
  await page.context().setOffline(true);
  await page.getByRole('button',{name:'Add an entry',exact:true}).click();const d=page.getByRole('dialog');
  await d.getByRole('textbox',{name:'Amount in pesos'}).fill('100.01');await d.getByLabel('Note',{exact:true}).fill('P8 cached client queued');
  await d.getByRole('button',{name:'Online',exact:true}).click();await d.getByRole('button',{name:'Bills',exact:true}).click();await d.waitFor({state:'detached'});
  await page.locator('.balance-hero').getByText('₱9,534.98',{exact:true}).waitFor();
  await page.getByRole('button',{name:/Offline.*1 queued/}).waitFor();
  return {legacyWorkerControlled:true,queuedBeforeUpgrade:1,offlineBalance:'953498 centavos',backendWrites:false};
}
