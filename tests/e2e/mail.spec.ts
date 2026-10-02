import { expect, test, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

async function distinctCard(page: Page, marker: number) {
  const image = readFileSync(resolve('public/demo/sample-card.png')).toString('base64');
  const encoded = await page.evaluate(async ({ image, marker }) => {
    const source = new Image(); source.src = `data:image/png;base64,${image}`; await source.decode();
    const canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height;
    const context = canvas.getContext('2d')!; context.drawImage(source, 0, 0);
    context.fillStyle = `rgb(${marker * 31 % 255},${marker * 53 % 255},${marker * 79 % 255})`;
    context.fillRect(canvas.width - 12, canvas.height - 12, 7, 7);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/png'));
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  }, { image, marker });
  return Buffer.from(encoded, 'base64');
}

test('production signup uses the same public response for an existing and a new email', async ({ page }) => {
  await page.goto('/');
  const submit = async (email: string) => {
    await page.getByRole('button', { name: /Create an account/ }).click();
    await page.getByLabel('Your name').fill('Signup Check');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('a-long-test-password');
    await page.getByLabel('Your space').selectOption('personal');
    await page.getByRole('button', { name: 'Create account' }).click();
    const status = page.getByRole('status');
    await expect(status).toContainText('If this email can receive account instructions');
    return (await status.innerText()).trim();
  };
  const existing = await submit('maya@gather.test');
  const fresh = await submit(`signup-${Date.now()}@example.test`);
  expect(existing).toBe(fresh);
});

test('a scanned demo card can be reviewed, saved, and emailed after explicit approval', async ({ page }) => {
  const capturePath = process.env.SMTP_CAPTURE_PATH;
  expect(capturePath).toBeTruthy();
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: /^Scan/ }).first().click();

  const upload = page.waitForResponse((response) => response.url().endsWith('/api/scans') && response.request().method() === 'POST');
  await page.locator('#capture-gallery').setInputFiles({
    name: 'sample-card.png', mimeType: 'image/png', buffer: readFileSync(resolve('public/demo/sample-card.png')),
  });
  const uploadResponse = await upload;
  expect(uploadResponse.status()).toBe(201);
  const uploadedScan = (await uploadResponse.json()) as { scan: { id: string; status: string } };
  expect(uploadedScan.scan.status).toBe('queued');
  // Upload starts reading immediately; a single photo opens Review while it runs.
  await expect.poll(async () => {
    const response = await page.request.get(`/api/scans/${uploadedScan.scan.id}`);
    return ((await response.json()) as { scan: { status: string } }).scan.status;
  }, { timeout: 10_000 }).toBe('ready');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page).toHaveURL(/\/review\//);
  await expect(page.getByLabel('Name *')).toHaveValue('Demo Contact');
  await page.getByLabel('Company').fill('Acme Packaging');
  await expect(page.getByLabel('Email')).toHaveValue('demo.contact@sample.invalid');
  const recipient = `approved-${Date.now()}@example.test`;
  await page.getByLabel('Email').fill(recipient);
  await page.locator('.review-form input[type="tel"]').fill('');
  await page.getByRole('button', { name: 'Save & prepare email' }).click();

  const composer = page.locator('.email-compose');
  await expect(composer.getByLabel('Subject')).toHaveValue(/Following up/);
  await expect(composer.getByRole('textbox', { name: 'Message' })).toHaveValue(/Acme Packaging/);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const subject = `Approved scanned-card follow-up ${Date.now()}`;
  const body = 'Thanks for meeting at the event. I will send the sample details we discussed.';
  await composer.getByLabel('Subject').fill(subject);
  await composer.getByRole('textbox', { name: 'Message' }).fill(body);
  await composer.getByRole('button', { name: 'Send email' }).click();

  await expect(composer.locator('.email-state')).toContainText('does not confirm inbox delivery', { timeout: 10_000 });
  await expect.poll(() => existsSync(capturePath!) ? readFileSync(capturePath!, 'utf8') : '', { timeout: 10_000 }).toContain(subject);
  const acceptedMessage = readFileSync(capturePath!, 'utf8').replace(/=\r\n/g, '').replace(/\r\n/g, '\n');
  expect(acceptedMessage).toContain(recipient);
  expect(acceptedMessage).toContain(subject);
  expect(acceptedMessage).toContain(body);
  expect(acceptedMessage).toContain('List-Unsubscribe:');
  await expect(composer.locator('.email-state')).toContainText('does not confirm inbox delivery');

  const unsubscribeUrl = acceptedMessage.match(/List-Unsubscribe:\s*<([^>]+)>/i)?.[1];
  expect(unsubscribeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/unsubscribe\/[A-Za-z0-9_-]{40,60}$/);
  const confirmPage = await page.request.get(unsubscribeUrl!);
  expect(confirmPage.status()).toBe(200);
  expect(await confirmPage.text()).toContain('Stop follow-up emails?');
  expect(acceptedMessage).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  const unsubscribed = await page.request.post(unsubscribeUrl!, {
    form: { 'List-Unsubscribe': 'One-Click' },
  });
  expect(unsubscribed.status()).toBe(200);
  expect(await unsubscribed.text()).toContain('You are unsubscribed.');

  const scanDetail = await (await page.request.get(`/api/scans/${uploadedScan.scan.id}`)).json() as { scan: { contactId: string } };
  const csrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  const blockedDraft = await page.request.post(`/api/contacts/${scanDetail.scan.contactId}/email-draft`, {
    headers: { 'X-CSRF-Token': csrf.csrfToken },
  });
  expect(blockedDraft.status()).toBe(409);
  expect((await blockedDraft.json() as { message: string }).message).toContain('asked not to receive follow-up email');
});

test('the edited email draft is what the configured mail server accepts', async ({ page }) => {
  const capturePath = process.env.SMTP_CAPTURE_PATH;
  expect(capturePath).toBeTruthy();
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Choose how your messages appear.' })).toBeVisible();
  await page.getByLabel('From name').fill('Northstar Team');
  await page.getByLabel('From email').fill('leads@northstar.example');
  await page.getByRole('button', { name: 'Save email details' }).click();
  await expect(page.locator('.email-settings-panel .form-status')).toContainText('Sender details saved');
  await page.goto('/scan');
  const image = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 840; canvas.height = 480;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#f4f1e8'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#202020'; context.font = 'bold 42px sans-serif'; context.fillText('Tessa Morgan', 54, 140);
    context.font = '28px sans-serif'; context.fillText('Acme Packaging', 54, 200); context.fillText('tessa@acmepackaging.example', 54, 255);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/jpeg', .9));
    const data = await blob.arrayBuffer();
    return btoa(String.fromCharCode(...new Uint8Array(data)));
  });
  const upload = page.waitForRequest((request) => request.url().includes('/api/scans') && request.method() === 'POST');
  await page.locator('#capture-gallery').setInputFiles({ name: 'tessa-card.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(image, 'base64') });
  await upload;
  await expect(page).toHaveURL(/\/review\//);
  await expect(page.getByLabel('Name *')).toBeVisible();
  await page.getByLabel('Name *').fill('Tessa Morgan');
  await page.getByLabel('Company').fill('Acme Packaging');
  await page.getByLabel('Email').fill('tessa@acmepackaging.example');
  await page.getByRole('button', { name: 'Save & prepare email' }).click();
  await expect(page.getByRole('group', { name: 'Possible existing person' })).toBeVisible();
  await page.getByRole('button', { name: 'Yes, same person' }).click();
  await page.getByRole('button', { name: 'Save & prepare email' }).click();
  await expect(page.getByLabel('Subject')).toBeVisible();

  const subject = 'Sample options, as promised';
  const body = 'Thanks for the useful conversation.\nI will send the sample sizes this afternoon.';
  await page.getByLabel('Subject').fill(subject);
  await page.getByRole('textbox', { name: 'Message' }).fill(body);
  await page.getByRole('button', { name: 'Send email' }).click();
  await expect(page.locator('.email-state')).toContainText('does not confirm inbox delivery', { timeout: 10_000 });
  await expect.poll(() => existsSync(capturePath!) ? readFileSync(capturePath!, 'utf8') : '', { timeout: 10_000 }).toContain(subject);
  const acceptedMessage = readFileSync(capturePath!, 'utf8');
  expect(acceptedMessage).toContain('tessa@acmepackaging.example');
  expect(acceptedMessage).toContain('Northstar Team');
  expect(acceptedMessage).toContain('leads@northstar.example');
  const normalizedMessage = acceptedMessage.replace(/=\r\n/g, '').replace(/\r\n/g, '\n');
  expect(normalizedMessage).toContain(body);
  expect(acceptedMessage).toContain('List-Unsubscribe:');
  expect(await page.locator('.email-state').innerText()).toContain('does not confirm inbox delivery');
});

test('a rejected email is labeled failed and the person can retry after fixing the mail server', async ({ page }) => {
  const capturePath = process.env.SMTP_CAPTURE_PATH;
  const rejectPath = process.env.SMTP_REJECT_PATH;
  expect(capturePath).toBeTruthy();
  expect(rejectPath).toBeTruthy();
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/people/demo-ns-contact-1');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Draft an email' }).click();
  const composer = page.locator('.email-compose');
  await expect(composer.getByLabel('Subject')).toBeVisible();
  const subject = `Rejected then retried ${Date.now()}`;
  await composer.getByLabel('Subject').fill(subject);
  await composer.getByRole('textbox', { name: 'Message' }).fill('This local test proves the failed-send retry path.');
  writeFileSync(rejectPath!, 'Reject local SMTP recipient commands until the test removes this file.');
  try {
    await composer.getByRole('button', { name: 'Send email' }).click();
    await expect(composer.locator('.email-state')).toContainText('The mail server did not accept it. You can retry.', { timeout: 12_000 });
    await expect(composer.getByRole('button', { name: 'Retry send' })).toBeVisible();
  } finally {
    if (existsSync(rejectPath!)) unlinkSync(rejectPath!);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await composer.getByRole('button', { name: 'Retry send' }).click();
  await expect(composer.locator('.email-state')).toContainText('does not confirm inbox delivery', { timeout: 12_000 });
  await expect.poll(() => existsSync(capturePath!) ? readFileSync(capturePath!, 'utf8') : '', { timeout: 10_000 }).toContain(subject);
  expect(readFileSync(capturePath!, 'utf8')).toContain('This local test proves the failed-send retry path.');
});

test('setup test email goes only to the signed-in user and reports mail-server acceptance', async ({ page }) => {
  const capturePath = process.env.SMTP_CAPTURE_PATH;
  expect(capturePath).toBeTruthy();
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.goto('/setup');
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByLabel('From name').fill('Northstar Events');
  await page.getByLabel('From email').fill('events@northstar.example');
  const response = page.waitForResponse((item) => item.url().endsWith('/api/onboarding/test-email') && item.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send me a test email' }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole('status').filter({ hasText: 'The mail server accepted a test message for maya@gather.test' })).toBeVisible();
  await expect.poll(() => existsSync(capturePath!) ? readFileSync(capturePath!, 'utf8') : '', { timeout: 10_000 }).toContain('Gather test email');
  const captured = readFileSync(capturePath!, 'utf8').replace(/=\r?\n/g, '').replace(/=3D/gi, '=');
  expect(captured.toLowerCase()).toContain('to: maya@gather.test');
  expect(captured).toContain('The mail server accepted it; that does not confirm inbox delivery.');
  const setupState = await (await page.request.get('/api/onboarding')).json() as { state: { completed: string[]; skipped: string[] } };
  expect(setupState.state.completed).toContain('email');
  expect(setupState.state.skipped).toContain('knowledge');
});

test('Settings lets the demo sender and test recipient be changed without changing lead recipients', async ({ page }) => {
  const capturePath = process.env.SMTP_CAPTURE_PATH;
  expect(capturePath).toBeTruthy();
  const settingsDb = new Database(resolve(process.env.DATABASE_PATH ?? ''));
  const prior = settingsDb.prepare("SELECT value_json FROM workspace_settings WHERE workspace_id='demo-northstar' AND key='email'").get() as { value_json: string } | undefined;
  settingsDb.prepare("DELETE FROM workspace_settings WHERE workspace_id='demo-northstar' AND key='email'").run();
  settingsDb.close();
  try {
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByLabel('From email')).toHaveValue('dhruvtube11@gmail.com');
  await expect(page.getByLabel('Test email recipient')).toHaveValue('dhruvtube11@gmail.com');
  const recipient = `demo-test-${Date.now()}@example.test`;
  await page.getByLabel('Test email recipient').fill(recipient);
  await page.getByRole('button', { name: 'Send a test email' }).click();
  await expect(page.locator('.email-settings-panel .form-status')).toContainText(`accepted a test message for ${recipient}`);
  await expect.poll(() => existsSync(capturePath!) ? readFileSync(capturePath!, 'utf8') : '', { timeout: 10_000 }).toContain(recipient);
  const saved = await (await page.request.get('/api/settings')).json() as { email: { fromAddress: string; testRecipient: string } };
  expect(saved.email).toMatchObject({ fromAddress: 'dhruvtube11@gmail.com', testRecipient: recipient });
  } finally {
    const restoreDb = new Database(resolve(process.env.DATABASE_PATH ?? ''));
    try {
      if (prior) restoreDb.prepare("INSERT INTO workspace_settings(workspace_id,key,value_json) VALUES ('demo-northstar','email',?) ON CONFLICT(workspace_id,key) DO UPDATE SET value_json=excluded.value_json").run(prior.value_json);
      else restoreDb.prepare("DELETE FROM workspace_settings WHERE workspace_id='demo-northstar' AND key='email'").run();
    } finally { restoreDb.close(); }
  }
});

test('Email now from Save & scan next sends only after approval and returns to capture', async ({ page }) => {
  const capturePath = process.env.SMTP_CAPTURE_PATH;
  expect(capturePath).toBeTruthy();
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  const unique = Date.now();
  const image = await page.evaluate(async (id) => {
    const canvas = document.createElement('canvas'); canvas.width = 840; canvas.height = 480;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#f4f1e8'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#202020'; context.font = 'bold 42px sans-serif'; context.fillText(`Toast Contact ${id}`, 54, 140);
    context.font = '28px sans-serif'; context.fillText('Acme Packaging', 54, 200); context.fillText(`toast-${id}@acmepackaging.example`, 54, 255);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/jpeg', .9));
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  }, unique);
  const upload = page.waitForRequest((request) => request.url().includes('/api/scans') && request.method() === 'POST');
  await page.locator('#capture-gallery').setInputFiles({ name: 'toast-contact.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(image, 'base64') });
  await upload;
  await expect(page).toHaveURL(/\/review\//);
  await expect(page.getByLabel('Name *')).toBeVisible();
  const contactName = `Toast Contact ${unique}`;
  const recipient = `toast-${unique}@acmepackaging.example`;
  await page.getByLabel('Name *').fill(contactName);
  await page.getByLabel('Company').fill('Acme Packaging');
  await page.getByLabel('Email').fill(recipient);
  await page.getByRole('button', { name: 'Save & scan next' }).click();
  await expect(page.getByRole('button', { name: 'Email now' })).toBeVisible();
  await page.getByRole('button', { name: 'Email now' }).click();
  const dialog = page.getByRole('dialog', { name: 'Email this person' });
  await expect(dialog.getByLabel('Subject')).toHaveValue(/Following up/);
  const subject = `Approved toast follow-up ${unique}`;
  await dialog.getByLabel('Subject').fill(subject);
  await dialog.getByRole('textbox', { name: 'Message' }).fill('This was approved from the optional Email now toast.');
  await dialog.getByRole('button', { name: 'Send email' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('queued for the mail server');
  await expect.poll(() => existsSync(capturePath!) ? readFileSync(capturePath!, 'utf8') : '', { timeout: 10_000 }).toContain(subject);
  const acceptedMessage = readFileSync(capturePath!, 'utf8');
  expect(acceptedMessage).toContain(recipient);
  expect(acceptedMessage).not.toContain('inbox delivery is confirmed');
});

test('password reset uses a one-time link, changes the credential, and revokes old sessions', async ({ page, browser }) => {
  const capturePath = process.env.SMTP_CAPTURE_PATH;
  expect(capturePath).toBeTruthy();
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  const recoveryPage = await browser.newPage();
  try {
    await recoveryPage.goto('/');
    await recoveryPage.getByRole('button', { name: 'Forgot password?' }).click();
    await recoveryPage.getByLabel('Email').fill('maya@gather.test');
    await recoveryPage.getByRole('button', { name: 'Request a reset link' }).click();
    await expect(recoveryPage.getByRole('status')).toContainText('Mail-server acceptance does not confirm inbox delivery');
    await expect.poll(() => existsSync(capturePath!) ? readFileSync(capturePath!, 'utf8') : '', { timeout: 10_000 }).toContain('Reset your Gather password');
    const message = readFileSync(capturePath!, 'utf8').replace(/=\r?\n/g, '').replace(/=3D/gi, '=');
    const resetUrl = message.match(/http:\/\/127\.0\.0\.1:\d+\/reset-password#reset=[A-Za-z0-9_-]{40,100}/)?.[0];
    expect(resetUrl, 'reset mail includes a fragment token without putting it in a request URL').toBeTruthy();

    await recoveryPage.setViewportSize({ width: 390, height: 844 });
    await recoveryPage.goto(resetUrl!);
    await expect(recoveryPage.getByLabel('New password')).toBeVisible();
    expect(await recoveryPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const newPassword = 'Gather-Recovered-2026!';
    await recoveryPage.getByLabel('New password').fill(newPassword);
    await recoveryPage.getByRole('button', { name: 'Update password' }).click();
    await expect(recoveryPage.getByRole('status')).toContainText('Password updated. Sign in with your new password.');

    const oldSession = await page.request.get('/api/auth/me');
    expect(await oldSession.json()).toMatchObject({ authenticated: false });
    await recoveryPage.setViewportSize({ width: 1440, height: 1000 });
    await recoveryPage.getByLabel('Email').fill('maya@gather.test');
    await recoveryPage.getByLabel('Password').fill(newPassword);
    await recoveryPage.getByRole('button', { name: 'Sign in' }).click();
    await expect(recoveryPage.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
    const csrf = await (await recoveryPage.request.get('/api/auth/csrf')).json() as { csrfToken: string };
    const reused = await recoveryPage.request.post('/api/auth/password-reset/confirm', {
      data: { token: new URL(resetUrl!).hash.slice('#reset='.length), password: newPassword },
      headers: { 'X-CSRF-Token': csrf.csrfToken },
    });
    expect(reused.status()).toBe(400);
  } finally { await recoveryPage.close(); }
});

test('one captured lead completes the sample-to-won lifecycle under one shared company', async ({ page, context }) => {
  const capturePath = process.env.SMTP_CAPTURE_PATH;
  expect(capturePath).toBeTruthy();
  await context.grantPermissions(['microphone']);
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('link', { name: 'Companies' })).toBeVisible();

  const companyBeforeResponse = await page.request.get('/api/companies/demo-ns-acme');
  expect(companyBeforeResponse.status()).toBe(200);
  const companyBefore = await companyBeforeResponse.json() as { company: { id: string; deal_value_minor: number }; people: Array<{ id: string }> };
  const unique = Date.now();
  const leadName = `Sample Buyer ${unique}`;
  const recipient = `sample-buyer-${unique}@acmepackaging.example`;
  const voiceText = 'Asked for a small-run sample and carton sizes.';
  const upload = page.waitForResponse((response) => response.url().endsWith('/api/scans') && response.request().method() === 'POST');
  await page.locator('#capture-gallery').setInputFiles({
    name: 'sample-card-lifecycle.png', mimeType: 'image/png', buffer: await distinctCard(page, 10),
  });
  const uploaded = await upload;
  expect(uploaded.status()).toBe(201);
  const scan = (await uploaded.json() as { scan: { id: string; status: string } }).scan;
  expect(scan.status).toBe('queued');
  await expect.poll(async () => (((await page.request.get(`/api/scans/${scan.id}`)).json()) as Promise<{ scan: { status: string } }>).then((value) => value.scan.status), { timeout: 10_000 }).toBe('ready');
  await expect(page).toHaveURL(/\/review\//);
  await expect(page.getByLabel('Name *')).toHaveValue('Demo Contact');
  await page.getByLabel('Name *').fill(leadName);
  await page.getByLabel('Company').fill('Acme Packaging');
  await page.getByLabel('Email').fill(recipient);
  await page.locator('.review-form input[type="tel"]').fill('');
  await page.getByRole('button', { name: 'Flexible cartons' }).click();
  await page.getByRole('button', { name: 'Record voice note' }).click();
  await expect(page.getByText(/Recording ·/)).toBeVisible();
  await page.waitForTimeout(1300);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await page.getByLabel('Text you typed (optional)').fill(voiceText);
  await page.getByRole('button', { name: 'Save & prepare email' }).click();

  const composer = page.locator('.email-compose');
  await expect(composer.getByLabel('Subject')).toBeVisible();
  await expect(composer.locator('.email-sources')).toContainText(voiceText);
  await expect(composer.locator('.email-sources')).toContainText('Flexible cartons');
  const subject = `Sample options for ${leadName}`;
  const body = `Thanks for stopping by. I noted your request: ${voiceText}`;
  await composer.getByLabel('Subject').fill(subject);
  await composer.getByRole('textbox', { name: 'Message' }).fill(body);
  await composer.getByRole('button', { name: 'Send email' }).click();
  await expect(composer.locator('.email-state')).toContainText('does not confirm inbox delivery', { timeout: 10_000 });
  await expect.poll(() => existsSync(capturePath!) ? readFileSync(capturePath!, 'utf8') : '', { timeout: 10_000 }).toContain(subject);
  const acceptedMessage = readFileSync(capturePath!, 'utf8').replace(/=\r\n/g, '').replace(/\r\n/g, '\n');
  expect(acceptedMessage).toContain(recipient);
  expect(acceptedMessage).toContain(body);

  const savedScan = await (await page.request.get(`/api/scans/${scan.id}`)).json() as { scan: { contactId: string } };
  const contactId = savedScan.scan.contactId;
  const companyAfter = await (await page.request.get('/api/companies/demo-ns-acme')).json() as { company: { id: string }; people: Array<{ id: string; name: string }> };
  expect(companyAfter.company.id).toBe(companyBefore.company.id);
  expect(companyAfter.people).toHaveLength(companyBefore.people.length + 1);
  expect(companyAfter.people.some((person) => person.name === leadName)).toBe(true);
  await page.goto(`/people/${contactId}`);
  await expect(page.getByRole('heading', { name: leadName })).toBeVisible();
  await page.getByRole('button', { name: 'They replied' }).click();
  await expect.poll(async () => (((await page.request.get(`/api/contacts/${contactId}`)).json()) as Promise<{ person: { stage: string } }>).then((value) => value.person.stage)).toBe('replied');
  const replyState = await (await page.request.get(`/api/contacts/${contactId}`)).json() as { person: { version: number }; timeline: Array<{ kind: string; detail: string }> };
  const replyCsrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const repeatedReply = await page.request.post(`/api/contacts/${contactId}/reply`, { headers: { 'X-CSRF-Token': replyCsrf.csrfToken } });
    expect(repeatedReply.status()).toBe(200);
  }
  const repeatedReplyState = await (await page.request.get(`/api/contacts/${contactId}`)).json() as { person: { version: number }; timeline: Array<{ kind: string; detail: string }> };
  expect(repeatedReplyState.person.version).toBe(replyState.person.version);
  expect(repeatedReplyState.timeline.filter((item) => item.kind === 'reply')).toHaveLength(1);

  const meetingNote = `Sample review meeting ${unique}`;
  const meetingTime = await page.evaluate(() => {
    const date = new Date(Date.now() + 14 * 86400000);
    date.setHours(11, 0, 0, 0);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  });
  await page.getByLabel('What would you like to add?').selectOption('meeting');
  await page.getByLabel('Meeting time').fill(meetingTime);
  await page.getByLabel('Note (optional)').fill(meetingNote);
  await page.getByRole('button', { name: 'Add meeting' }).click();
  await expect(page.getByRole('status').getByText('Meeting added to this person.')).toBeVisible();
  await page.getByRole('link', { name: 'Follow-ups' }).first().click();
  const meeting = page.locator('.task-row').filter({ hasText: meetingNote });
  await expect(meeting).toBeVisible();
  await meeting.getByRole('button', { name: 'Confirm' }).click();
  await expect(meeting).toContainText('Confirmed');
  await page.goto(`/people/${contactId}`);
  await page.getByLabel('Change stage').selectOption('won');
  await expect.poll(async () => (((await page.request.get(`/api/contacts/${contactId}`)).json()) as Promise<{ person: { stage: string } }>).then((value) => value.person.stage)).toBe('won');
  await page.getByLabel('Potential value (USD)').fill('4200');
  await page.getByLabel('Deal status').selectOption('won');
  await page.getByRole('button', { name: 'Save deal' }).click();
  await expect(page.getByRole('status').getByText('Company deal details saved.')).toBeVisible();
  const companyWon = await (await page.request.get('/api/companies/demo-ns-acme')).json() as { company: { id: string; deal_status: string; deal_value_minor: number } };
  expect(companyWon.company).toMatchObject({ deal_status: 'won', deal_value_minor: 420000 });
  expect(companyWon.company.id).toBe(companyBefore.company.id);

  await page.goto('/reports');
  await expect(page.locator('.metric-card').filter({ hasText: 'Won companies' }).locator('.metric-number')).toHaveText('1');
  await expect(page.locator('.metric-card').filter({ hasText: 'Won deal value' }).locator('.metric-number')).toHaveText('$4,200');
});

test('new accounts cannot sign in before email verification and receive a one-time verify link', async ({ browser }) => {
  const capturePath = process.env.SMTP_CAPTURE_PATH;
  expect(capturePath).toBeTruthy();
  const page = await browser.newPage();
  try {
    await page.goto('/');
    let unverifiedLoginStatus = 0;
    page.on('response', (response) => { if (response.url().includes('/api/auth/login')) unverifiedLoginStatus = response.status(); });
    await page.getByRole('button', { name: /Create an account/ }).click();
    const email = `verify-${Date.now()}@example.test`;
    await page.getByLabel('Your name').fill('Verified User');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('Gather-Verify-2026!');
    await page.getByLabel('Company name').fill('Verified Sample Company');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('status')).toContainText('If this email can receive account instructions');

    await page.getByLabel('Password').fill('Gather-Verify-2026!');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect.poll(() => unverifiedLoginStatus).toBe(403);
    await expect(page.getByRole('status')).toContainText('Verify your email before signing in');
    await expect(page.getByRole('button', { name: 'Resend verification email' })).toBeVisible();
    await page.getByRole('button', { name: 'Resend verification email' }).click();
    await expect(page.getByRole('status')).toContainText('If the account still needs verification');

    await expect.poll(() => existsSync(capturePath!) ? readFileSync(capturePath!, 'utf8') : '', { timeout: 10_000 }).toContain('Verify your Gather email');
    const message = readFileSync(capturePath!, 'utf8').replace(/=\r?\n/g, '').replace(/=3D/gi, '=');
    const verifyUrl = message.match(/http:\/\/127\.0\.0\.1:\d+\/verify-email#verify=[A-Za-z0-9_-]{40,100}/)?.[0];
    expect(verifyUrl, 'verification email contains a one-time fragment link').toBeTruthy();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(verifyUrl!);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Verify email' }).click();
    await expect(page.getByRole('heading', { name: 'Make Gather yours.' })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
    expect(await (await page.request.get('/api/auth/me')).json()).toMatchObject({ user: { email } });

    const verifiedCsrf = await (await page.request.get('/api/auth/csrf')).json() as { csrfToken: string };
    const reused = await page.request.post('/api/auth/email-verification/confirm', {
      data: { token: new URL(verifyUrl!).hash.slice('#verify='.length) }, headers: { 'X-CSRF-Token': verifiedCsrf.csrfToken },
    });
    expect(reused.status()).toBe(400);
  } finally { await page.close(); }
});

test('daily digest includes due follow-ups and reports mail-server acceptance only', async ({ page }) => {
  const capturePath = process.env.SMTP_CAPTURE_PATH;
  expect(capturePath).toBeTruthy();
  const db = new Database(resolve(process.env.DATABASE_PATH ?? ''));
  try {
    db.prepare(`UPDATE tasks SET status='done' WHERE workspace_id='demo-northstar' AND kind='follow_up' AND status='open'`).run();
  }
  finally { db.close(); }
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: 'People', exact: true }).first().click();
  await page.getByLabel('Search companies and people').fill('June Kim');
  await page.getByRole('link', { name: /June Kim/ }).click();
  const followUpTime = page.getByLabel('Follow-up time');
  await expect(followUpTime).not.toHaveValue('');
  const yesterday = await page.evaluate(() => {
    const date = new Date(Date.now() - 86_400_000);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T00:00`;
  });
  await followUpTime.fill(yesterday);
  await expect(followUpTime).toHaveValue(yesterday);
  await page.getByRole('button', { name: 'Add follow-up' }).click();
  await expect(page.getByRole('status').getByText('Follow-up added to this person.')).toBeVisible();
  const taskDb = new Database(resolve(process.env.DATABASE_PATH ?? ''));
  try {
    const taskCount = taskDb.prepare(`SELECT COUNT(*) AS total FROM tasks WHERE workspace_id='demo-northstar' AND contact_id='demo-ns-contact-6' AND kind='follow_up' AND status='open' AND datetime(due_at)<=datetime('now','+1 day')`).get() as { total: number };
    expect(taskCount.total).toBe(1);
  } finally { taskDb.close(); }

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.locator('.reminder-choice').nth(1).locator('input').check();
  await page.locator('.reminder-fields input[type=time]').fill('00:00');
  await page.locator('.reminder-fields label').filter({ hasText: 'Time zone' }).locator('input').fill('UTC');
  await page.getByRole('button', { name: 'Save reminders' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();

  const today = new Date().toISOString().slice(0, 10);
  await expect.poll(async () => {
    const value = await (await page.request.get('/api/reminders')).json() as {
      recentDigests: Array<{ local_date: string; status: string; sent_to_server_at: string | null }>;
    };
    const run = value.recentDigests.find((item) => item.local_date === today);
    return run ? `${run.status}:${Boolean(run.sent_to_server_at)}` : '';
  }, { timeout: 15_000 }).toBe('sent_to_server:true');

  const subject = `Your Gather follow-ups for ${today}`;
  await expect.poll(() => existsSync(capturePath!) ? readFileSync(capturePath!, 'utf8') : '', { timeout: 10_000 }).toContain(subject);
  const message = readFileSync(capturePath!, 'utf8').replace(/=\r?\n/g, '').replace(/=3D/gi, '=');
  expect(message).toContain('June Kim at Bluebird Labs');
  expect(message).toContain('Follow up');
  expect(message).toContain('Open Gather to review or update each next step.');
  expect(message).not.toContain('inbox delivery is confirmed');

  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: `Accepted by the mail server; delivery is not confirmed. (${today} digest)` })).toBeVisible();
});
