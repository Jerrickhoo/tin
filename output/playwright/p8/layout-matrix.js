async (page) => {
  const context=await page.context().browser().newContext({storageState:await page.context().storageState(),viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  const p=await context.newPage(),issues=[],errors=[];let checked=0;
  p.on('pageerror',e=>errors.push(e.message));
  const settle=()=>p.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))});
  try {
    await p.goto('http://127.0.0.1:5198/');await p.getByRole('button',{name:'Needs: ₱9,634.99 — show these entries',exact:true}).waitFor();
    for(const theme of ['Pixel Plum','Ocean','Forest','Rose','Amber','Daylight','Neo Pop']) {
      await p.goto('http://127.0.0.1:5198/settings');await p.getByText(theme,{exact:true}).click();
      for(const width of [1280,390,320]) {
        await p.setViewportSize({width,height:900});
        for(const kind of ['home','history','insights','settings','reset','expense']) {
          const path={home:'/',history:'/history',insights:'/insights',settings:'/settings',reset:'/settings',expense:'/'}[kind];
          await p.goto('http://127.0.0.1:5198'+path);
          if(path==='/') await p.getByRole('button',{name:'Needs: ₱9,634.99 — show these entries',exact:true}).waitFor();
          if(kind==='history') await p.getByRole('region',{name:'Results'}).waitFor();
          if(kind==='insights') await p.getByRole('heading',{name:'Recent spending',exact:true}).waitFor();
          if(kind==='reset') {await p.getByRole('button',{name:'Reset this account…',exact:true}).click();await p.getByRole('textbox',{name:'Type RESET to confirm'}).waitFor()}
          if(kind==='expense') {await p.getByRole('button',{name:'Add an entry',exact:true}).click();await p.getByRole('dialog',{name:'Expense entry'}).waitFor()}
          await settle();
          const layout=await p.evaluate(()=>({viewport:innerWidth,page:document.documentElement.scrollWidth,dialogs:[...document.querySelectorAll('[role=dialog]')].map(e=>({width:e.clientWidth,scroll:e.scrollWidth,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right}))}));
          checked++;
          if(layout.page>width+1||layout.dialogs.some(d=>d.scroll>d.width+1||d.left<0||d.right>width+1)) issues.push({theme,width,kind,layout});
          if(width===320&&['Pixel Plum','Daylight','Neo Pop'].includes(theme)&&['reset','expense'].includes(kind)) await p.screenshot({path:`output/playwright/p8/${kind}-${theme.replaceAll(' ','-')}-320.png`,fullPage:true,animations:'disabled'});
          if(kind==='expense') {await p.keyboard.press('Escape');await p.waitForFunction(()=>!history.state?.tinSheet)}
        }
      }
    }
    // 1280px desktop at 200% browser zoom has a 640 CSS-pixel layout viewport.
    await p.setViewportSize({width:640,height:450});
    for(const path of ['/','/history','/settings']) {
      await p.goto('http://127.0.0.1:5198'+path);await p.getByRole('button',{name:'Add an entry',exact:true}).waitFor();await settle();
      const width=await p.evaluate(()=>document.documentElement.scrollWidth);checked++;
      if(width>641) issues.push({kind:'200%-zoom-equivalent',path,width});
    }
    await p.goto('http://127.0.0.1:5198/');const opener=p.getByRole('button',{name:'Add an entry',exact:true});await opener.focus();await p.keyboard.press('Enter');
    const dialog=p.getByRole('dialog');await dialog.waitFor();await settle();
    await dialog.evaluate(e=>{const controls=[...e.querySelectorAll('button,input,select,textarea,[href]')].filter(x=>!x.disabled&&x.getClientRects().length);controls.at(-1).focus()});
    await p.keyboard.press('Tab');
    if(!await dialog.evaluate(e=>e.contains(document.activeElement))) issues.push('Tab escaped modal');
    await p.keyboard.press('Escape');await p.waitForFunction(()=>!history.state?.tinSheet);
    if(!await opener.evaluate(e=>document.activeElement===e)) issues.push('Keyboard opener focus was lost');
    return {passed:!issues.length&&!errors.length,checked,issues,errors,keyboardFocus:true,zoom:'640 CSS pixels for a 1280px/200% equivalent'};
  } finally {await context.close()}
}
