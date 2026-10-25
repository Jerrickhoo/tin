async (page) => {
  await page.getByRole('region',{name:'I owe P6 borrowed Alex'}).getByRole('button',{name:'Record repayment'}).click();
  await page.getByLabel('Financial amount').fill('200.02');
  await page.getByLabel('Financial envelope').selectOption({label:'Needs'});
  await page.getByRole('button',{name:'Online',exact:true}).click();
  await page.getByRole('button',{name:'Confirm financial entry'}).click();
  await page.getByText('I owe: ₱0.00',{exact:true}).waitFor();
  await page.reload();
  await page.getByText('I owe: ₱0.00',{exact:true}).waitFor();
  await page.context().setOffline(false);
  await page.getByRole('button',{name:/Offline/}).waitFor({state:'hidden'});
  await page.goto('http://127.0.0.1:5195/recurring#reminders');
  await page.getByRole('heading',{name:'Your reminders'}).waitFor();
  if(await page.getByRole('link',{name:'I owe · P6 borrowed Alex',exact:true}).count()) throw new Error('Settled reminder remains');
  if(await page.getByRole('link',{name:'Owed to me · P6 historical Sam',exact:true}).count()) throw new Error('Snoozed reminder reappeared');
  return {offlinePayment:'200.02 Online',survivedReload:true,settledRemoved:true,snoozePersisted:true};
}
