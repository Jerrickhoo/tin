async (page) => {
  const issues=[],errors=[]; let checked=0;
  page.on('pageerror',e=>errors.push(e.message));
  const check=async(theme,width,view)=>{
    await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))});
    const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,dialogs:[...document.querySelectorAll('[role=dialog]')].map(e=>({client:e.clientWidth,scroll:e.scrollWidth}))}));
    if(view.includes('form') && layout.dialogs.length!==1) issues.push({theme,width,view,problem:'Expected exactly one open form'});
    checked++;
    if(layout.scroll>width+1 || layout.dialogs.some(d=>d.scroll>d.client+1)) issues.push({theme,width,view,layout});
  };
  for(const theme of ['Pixel Plum','Ocean','Forest','Rose','Amber','Daylight','Neo Pop']){
    await page.goto('http://127.0.0.1:5195/settings');
    await page.getByText(theme,{exact:true}).click();
    for(const width of [1280,390,320]){
      await page.setViewportSize({width,height:900});
      for(const [path,heading] of [['/debts','Debts · Utang'],['/recurring','Your reminders'],['/settings','In-app reminders'],['/','']]){
        await page.goto('http://127.0.0.1:5195'+path);
        if(heading) await page.getByRole('heading',{name:heading,exact:true}).waitFor();
        else await page.getByRole('link',{name:/new reminders.*Open Upcoming/}).waitFor();
        await check(theme,width,path);
        if(width===320 && ['Pixel Plum','Daylight','Neo Pop'].includes(theme) && path==='/debts') await page.screenshot({animations:'disabled',path:'output/playwright/p6/debts-'+theme.replaceAll(' ','-')+'-320.png'});
      }
      await page.goto('http://127.0.0.1:5195/debts');
      await page.getByRole('button',{name:'Lend, borrow or enter old debt'}).click();
      await page.getByLabel('Person (optional)').fill('LongPerson'.repeat(10));
      await check(theme,width,'debt form');
      await page.getByRole('button',{name:'Cancel',exact:true}).click();
      await page.waitForFunction(()=>!history.state?.tinSheet);
      await page.getByRole('region',{name:'Owed to me P6 lent Alex'}).getByRole('button',{name:'Record repayment'}).click();
      await page.getByText('Still owed: ₱200.02',{exact:true}).waitFor();
      await check(theme,width,'repayment form');
      if(width===320 && theme==='Neo Pop') await page.screenshot({animations:'disabled',path:'output/playwright/p6/repayment-Neo-Pop-320.png'});
      await page.getByRole('button',{name:'Cancel',exact:true}).click();
      await page.waitForFunction(()=>!history.state?.tinSheet);
    }
  }
  return {checked,issues,errors,passed:!issues.length&&!errors.length};
}
