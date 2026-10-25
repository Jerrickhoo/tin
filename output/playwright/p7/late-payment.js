async (page) => {
  // Run only in the guarded disposable staging account, starting in New subscription.
  if (!page.url().startsWith('http://127.0.0.1:5195/')) throw new Error('Disposable server required');
  await page.getByLabel('Name',{exact:true}).fill('P7 late bill');
  await page.getByRole('combobox',{name:'Category',exact:true}).selectOption({label:'Bills'});
  await page.getByRole('button',{name:'Online',exact:true}).click();
  await page.getByLabel('First due month / start date (Manila)').fill('2026-10-24');
  await page.getByLabel('Monthly amount').fill('321.09');
  await page.getByRole('button',{name:'Review schedule',exact:true}).click();
  await page.getByRole('button',{name:'Confirm reviewed change',exact:true}).click();
  await page.getByRole('region',{name:'P7 late bill',exact:true}).waitFor();
  await page.goto('http://127.0.0.1:5195/calendar?month=2026-10&day=2026-10-24');
  const agenda = page.getByRole('region',{name:'Agenda'});
  await agenda.getByRole('link',{name:'P7 late bill',exact:true}).waitFor();
  const before = await agenda.innerText();
  const source = await agenda.getByRole('link',{name:'P7 late bill',exact:true}).getAttribute('href');
  await agenda.getByRole('link',{name:'P7 late bill',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById(location.hash.slice(1))?.open === true);
  const due = page.locator('[id="'+source.split('#')[1]+'"]');
  await due.getByRole('button',{name:'Confirm payment',exact:true}).click();
  await page.getByRole('button',{name:'Online',exact:true}).click();
  await page.getByLabel('Actual payment date (Manila)').fill('2026-10-25');
  await page.getByRole('button',{name:'Review payment',exact:true}).click();
  await page.getByRole('button',{name:'Confirm reviewed change',exact:true}).click();
  await page.getByRole('region',{name:'P7 late bill',exact:true}).getByText(/2026-10-24.*paid/).waitFor();
  await page.goto('http://127.0.0.1:5195/calendar?month=2026-10&day=2026-10-24');
  await page.getByRole('region',{name:'Agenda'}).getByRole('link',{name:'P7 late bill',exact:true}).waitFor();
  const resolved = await page.getByRole('region',{name:'Agenda'}).innerText();
  await page.getByRole('button',{name:/2026-10-25, \d+ items/}).click();
  await page.getByRole('link',{name:'Expense · P7 late bill',exact:true}).waitFor();
  const paid = await page.getByRole('region',{name:'Agenda'}).innerText();
  const count = await page.getByRole('link',{name:'Expense · P7 late bill',exact:true}).count();
  if (!before.includes('Overdue') || !resolved.includes('Resolved · paid') || !resolved.includes('Actual payment · 2026-10-25') || !paid.includes('Actual gross spending ₱321.09') || count!==1) throw new Error('Late payment projection disagrees');
  await page.getByRole('link',{name:'View these dates in History'}).click();
  await page.getByRole('region',{name:'Results'}).waitFor();
  const history = await page.getByRole('region',{name:'Results'}).innerText();
  if (!history.includes('Gross spending ₱321.09')) throw new Error('History disagrees with payment day');
  return {passed:true,source,before,resolved,paid,history};
}
