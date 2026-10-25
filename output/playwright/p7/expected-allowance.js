async (page) => {
  if (!page.url().startsWith('http://127.0.0.1:5195/budget')) throw new Error('Disposable budget view required');
  await page.getByLabel('Expected amount (₱)').fill('777.77');
  await page.getByLabel('Allowance note (optional)').fill('P7 expected allowance');
  await page.getByRole('button',{name:'Review expectation',exact:true}).click();
  await page.getByRole('button',{name:'Confirm budget change',exact:true}).click();
  await page.getByText(/P7 expected allowance/).first().waitFor();
  await page.goto('http://127.0.0.1:5195/calendar?month=2026-11');
  const section = page.getByRole('region',{name:'Expected allowance'});
  await section.getByRole('link',{name:'P7 expected allowance',exact:true}).waitFor();
  const expected = await section.innerText();
  const agenda = await page.getByRole('region',{name:'Agenda'}).innerText();
  if (!expected.includes('₱777.77') || !expected.includes('day not set') || agenda.includes('P7 expected allowance') || !agenda.includes('Income ₱0.00')) throw new Error('Expected income leaked into dated or actual activity');
  await section.getByRole('link',{name:'P7 expected allowance',exact:true}).click();
  await page.getByRole('heading',{name:'Budget planning'}).waitFor();
  if (!page.url().includes('month=2026-11')) throw new Error('Expected allowance link lost month');
  return {passed:true,expected,agenda};
}
