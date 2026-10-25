async (page) => {
  const create = async (person, direction) => {
    await page.getByRole('button', {name:'Lend, borrow or enter old debt'}).click();
    await page.getByLabel('Debt direction').selectOption(direction);
    await page.getByLabel('Financial amount').fill('200.02');
    await page.getByLabel('Person (optional)').fill(person);
    await page.getByLabel('Due date (optional)').fill('2026-10-24');
    await page.getByLabel('Financial envelope').selectOption({label:'Needs'});
    await page.getByRole('button', {name:'Cash',exact:true}).click();
    await page.getByRole('button', {name:'Confirm financial entry'}).click();
    await page.getByRole('heading',{name:new RegExp(person)}).waitFor();
  };
  await create('P6 lent Alex','receivable_principal');
  await create('P6 borrowed Alex','payable_principal');
  await page.getByRole('region',{name:'Owed to me P6 historical Sam'}).getByRole('button',{name:'Record repayment'}).click();
  await page.getByLabel('Financial amount').fill('40.01');
  await page.getByLabel('Financial envelope').selectOption({label:'Needs'});
  await page.getByRole('button',{name:'Online',exact:true}).click();
  await page.getByRole('button',{name:'Confirm financial entry'}).click();
  await page.getByText('Original ₱100.01 · Paid ₱40.01 · Remaining ₱60.00').waitFor();
  return { created: ['historical receivable','cash lending','cash borrowing'], partialReceived: '40.01 Online' };
}
