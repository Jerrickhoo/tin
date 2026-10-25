async (page) => {
  const issues=[],errors=[]; let checked=0;
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:5195/insights?month=2026-10');
  await page.getByRole('link',{name:/Bills.*100.0%/}).waitFor();
  for(const theme of ['Pixel Plum','Ocean','Forest','Rose','Amber','Daylight','Neo Pop']){
    await page.goto('http://127.0.0.1:5195/settings');
    await page.getByText(theme,{exact:true}).click();
    for(const width of [1280,390,320]){
      await page.setViewportSize({width,height:900});
      for(const [path,heading] of [['/calendar?month=2026-10','October 2026 · agenda'],['/calendar?month=2026-10&day=2026-10-22','2026-10-22 · agenda'],['/calendar?month=2027-02','February 2027 · agenda'],['/insights?month=2026-10','Recent spending'],['/insights?month=2026-09','Recent spending'],['/insights?month=2026-12','Recent spending']]){
        await page.goto('http://127.0.0.1:5195'+path);
        await page.getByRole('heading',{name:heading,exact:true}).waitFor();
        if(path.startsWith('/calendar')) await page.getByRole('region',{name:'Agenda'}).getByRole('link',{name: path.includes('2027') ? 'Music subscription' : 'Expense · Music subscription',exact:true}).waitFor();
        if(path==='/insights?month=2026-10') await page.getByRole('link',{name:/Bills.*100.0%/}).waitFor();
        await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))});
        const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
        checked++;
        if(layout.scroll>width+1) issues.push({theme,width,path,layout});
        if(width===320 && ['Pixel Plum','Daylight','Neo Pop'].includes(theme) && ['/calendar?month=2026-10','/insights?month=2026-10'].includes(path)) await page.screenshot({animations:'disabled',fullPage:true,path:'output/playwright/p7/'+path.split('?')[0].slice(1)+'-'+theme.replaceAll(' ','-')+'-320.png'});
      }
    }
  }
  return {checked,issues,errors,passed:!issues.length&&!errors.length};
}
