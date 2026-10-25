async (page) => {
  await page.getByRole('checkbox',{name:'Enable in-app reminders',exact:true}).uncheck();
  await page.goto('http://127.0.0.1:5195/recurring');
  await page.getByText('Reminders are disabled. Your debts and plans are unchanged.',{exact:true}).waitFor();
  await page.goto('http://127.0.0.1:5195/debts');
  await page.getByText('Owed to me: ₱300.03',{exact:true}).waitFor();
  await page.getByText('I owe: ₱0.00',{exact:true}).waitFor();
  await page.goto('http://127.0.0.1:5195/settings#reminder-preferences');
  await page.getByRole('checkbox',{name:'Enable in-app reminders',exact:true}).check();
  await page.getByRole('checkbox',{name:'Balance check after 30 days (or never checked)',exact:true}).check();
  await page.goto('http://127.0.0.1:5195/recurring#reminders');
  await page.getByRole('link',{name:'Check Cash balance',exact:true}).waitFor();
  await page.getByRole('link',{name:'Check Online balance',exact:true}).waitFor();
  return {disablePreservesBalances:true,optionalChecks:true};
}
