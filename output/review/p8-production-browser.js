async (page) => {
  const errors=[],cspErrors=[],blocked=[],reads=[];
  const context=page.context();
  const assert=(value,message)=>{if(!value)throw new Error(message)};
  await context.route('**/*.supabase.co/**', async route=>{
    const request=route.request(),url=new URL(request.url());
    if(['GET','HEAD','OPTIONS'].includes(request.method())){
      // The smoke checks current readers, without running legacy auto-posting.
      if(url.pathname==='/rest/v1/recurring_templates' && request.method()==='GET')return route.fulfill({status:200,contentType:'application/json',body:'[]'});
      return route.continue();
    }
    if(request.method()==='POST' && /^\/rest\/v1\/rpc\/(financial|budget|goals|schedules)_capabilities$/.test(url.pathname))return route.continue();
    if(request.method()==='POST' && url.pathname==='/rest/v1/checkin_days')return route.fulfill({status:204,body:''});
    blocked.push({method:request.method(),path:url.pathname});
    return route.abort('blockedbyclient');
  });
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(/violates.*Content Security Policy|Refused to.*(script|style|font)/i.test(message.text()))cspErrors.push(message.text())});
  page.on('response',response=>{const url=new URL(response.url());if(url.hostname.endsWith('.supabase.co')&&url.pathname.startsWith('/rest/v1/'))reads.push({path:url.pathname,status:response.status()})});
  const response=await page.goto('https://tin-jar.netlify.app/history');
  assert(response.status()===200,'History deep link failed');
  assert(response.headers()['content-security-policy'].includes("script-src 'self'"),'Strict production CSP missing');
  await page.getByRole('region',{name:'Results'}).waitFor();
  // Wait for a completed first pull before navigating away from a cold mirror.
  for(let attempt=0;attempt<200&&!reads.some(read=>read.path==='/rest/v1/ledger_audit'&&read.status>=200&&read.status<300);attempt++)await page.waitForTimeout(100);
  await page.getByRole('region',{name:'Results'}).filter({hasText:/[1-9]\d* records?/}).waitFor();
  const routes=[['/',''],['/history','History'],['/insights','Insights'],['/calendar','Calendar'],['/debts','Debts · Utang'],['/recurring','Upcoming'],['/budget','Budget planning'],['/goals','Goals & allocations'],['/settings','Settings'],['/patch-notes','Patch notes']];
  let checked=0;
  for(const width of [1280,390,320]){
    await page.setViewportSize({width,height:900});
    for(const [path,heading] of routes){
      const result=await page.goto('https://tin-jar.netlify.app'+path);
      assert(result.status()===200,`${path} deep link failed`);
      await page.getByRole('button',{name:'Add an entry',exact:true}).waitFor();
      if(heading)await page.getByRole('heading',{name:heading,exact:true}).first().waitFor();
      await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${path} overflowed ${width}px`);
      if(path==='/patch-notes')assert((await page.locator('body').innerText()).includes('Build 2026.10.25.p8'),'P8 build marker missing');
      checked++;
    }
  }
  await page.goto('https://tin-jar.netlify.app/debts');
  await page.getByRole('button',{name:'Lend, borrow or enter old debt',exact:true}).click();
  await page.getByRole('dialog',{name:'Lend or borrow',exact:true}).waitFor();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
  await page.waitForFunction(()=>!history.state?.tinSheet);
  await page.goto('https://tin-jar.netlify.app/calendar');
  await page.getByRole('heading',{name:'Calendar',exact:true}).waitFor();
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}))});
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('heading',{name:'Calendar',exact:true}).waitFor();
  await page.getByRole('region',{name:'Agenda'}).waitFor();
  await page.screenshot({path:'output/playwright/p8/live-calendar-320.png',fullPage:true});
  await context.setOffline(false);
  assert(errors.length===0,'Uncaught browser error');
  assert(cspErrors.length===0,'CSP error');
  assert(blocked.length===0,'Unexpected mutation attempted');
  assert(reads.some(read=>read.path==='/rest/v1/entries'&&read.status===200),'No real entry read');
  assert(reads.some(read=>read.path==='/rest/v1/ledger_audit'&&read.status>=200&&read.status<300),'No real audit read');
  return {checked_at:new Date().toISOString(),passed:true,url:'https://tin-jar.netlify.app',build:'2026.10.25.p8',authenticated_existing_account:true,production_ledger_writes:false,visit_checkin_suppressed:true,legacy_auto_posting_suppressed:true,strict_csp:true,deep_link_layout_cases:checked,widths:[1280,390,320],debt_form_cancel:true,offline_service_worker_reload:true,real_backend_reads:true,errors,cspErrors,blocked};
}
