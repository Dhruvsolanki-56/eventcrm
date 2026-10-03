import { expect, test } from '@playwright/test';

test('assisted company setup validates source text and never saves an unreviewed AI suggestion', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect.poll(async () => (await (await page.request.get('/api/auth/me')).json() as { user?: { name?: string } }).user?.name).toBe('Maya Chen');
  const csrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  const headers = { 'X-CSRF-Token': csrf.csrfToken, 'X-Workspace-Id': 'demo-northstar' };
  const before = await (await page.request.get('/api/settings', { headers })).json() as { knowledge: unknown };
  const invalid = await page.request.post('/api/setup/profile-suggestion', { headers, data: { sourceText: 'Short' } });
  expect(invalid.status()).toBe(400);
  const unavailable = await page.request.post('/api/setup/profile-suggestion', { headers, data: { sourceText: 'We make reusable transit packaging and returnable crates for small production teams.' } });
  expect(unavailable.status()).toBe(503);
  const after = await (await page.request.get('/api/settings', { headers })).json() as { knowledge: unknown };
  expect(after.knowledge).toEqual(before.knowledge);
});

test('first-time setup saves resumable progress and offers honest no-mail fallback', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: 'Make Gather yours.' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByLabel('What does your team sell?').fill('Reusable transit packaging and returnable crates.');
  await page.getByLabel('Our role in client conversations').fill('We supply packaging options for client review.');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('heading', { name: 'Sending email' })).toBeVisible();
  const settings = await (await page.request.get('/api/settings')).json() as { knowledge: { ourRole: string } };
  expect(settings.knowledge.ourRole).toBe('We supply packaging options for client review.');
  await page.getByRole('button', { name: 'Send me a test email' }).click();
  await expect(page.getByRole('alert')).toContainText('No test email was sent');
  expect(await (await page.request.get('/api/onboarding')).json()).toMatchObject({ state: { completed: ['knowledge'], skipped: [] } });

  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.getByRole('heading', { name: 'Scan your first card' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.getByRole('heading', { name: 'You can come back any time.' })).toBeVisible();
  expect(await (await page.request.get('/api/onboarding')).json()).toMatchObject({ state: { completed: ['knowledge'], skipped: ['email', 'capture'] } });

  await page.getByRole('button', { name: 'Review skipped step' }).click();
  await expect(page.getByRole('heading', { name: 'Sending email' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'You can come back any time.' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('workspace email sender can be saved in Settings without claiming mail was sent', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Choose how your messages appear.' })).toBeVisible();
  await page.getByLabel('From name').fill('Northstar Sample Team');
  await page.getByLabel('From email').fill('hello@northstar.example');
  await page.getByRole('button', { name: 'Save email details' }).click();
  await expect(page.locator('.email-settings-panel .form-status')).toContainText('Sender details saved');
  await page.reload();
  await expect(page.getByLabel('From name')).toHaveValue('Northstar Sample Team');
  await expect(page.getByLabel('From email')).toHaveValue('hello@northstar.example');
  await page.getByRole('button', { name: 'Send a test email' }).click();
  await expect(page.getByRole('alert')).toContainText('No test email was sent');
});

test('attendee first setup asks for only the planned About me details at desktop and phone widths', async ({ page }) => {
  let submittedSetting: unknown;
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'PUT') {
      submittedSetting = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ saved: true }) });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/onboarding', async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: route.request().postDataJSON() }) });
      return;
    }
    await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Sam Patel/ }).click();
  await page.goto('/setup');
  await page.getByRole('button', { name: /About me/ }).click();
  await expect(page.getByRole('heading', { name: 'About me' })).toBeVisible();
  for (const field of ['Your name', 'Your role', 'Your company', 'What are you looking for?', 'Email signature']) {
    await expect(page.getByLabel(field)).toBeVisible();
  }
  await page.getByLabel('Your name').fill('Sam Patel');
  await page.getByLabel('Your role').fill('Product designer');
  await page.getByLabel('Your company').fill('Studio North');
  await page.getByLabel('What are you looking for?').fill('Small-batch materials');
  await page.getByLabel('Email signature').fill('Sam');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('heading', { name: 'Sending email' })).toBeVisible();
  expect(submittedSetting).toEqual({ key: 'aboutMe', value: {
    name: 'Sam Patel', role: 'Product designer', company: 'Studio North',
    lookingFor: 'Small-batch materials', signature: 'Sam',
  } });
  await expect(page.getByLabel('A little about you')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /About me/ }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const field of ['Your name', 'Your role', 'Your company', 'What are you looking for?', 'Email signature']) {
    await expect(page.getByLabel(field)).toBeVisible();
  }
});
