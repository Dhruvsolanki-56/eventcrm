import { expect, test, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type CrawlRoute = { path: string; heading: RegExp };
type NamedControl = { name: string; occurrence: number; index: number };

async function signIn(page: Page, account: RegExp) {
  const targetViewport = page.viewportSize();
  if (targetViewport) await page.setViewportSize({ ...targetViewport, width: 1440 });
  await page.goto('/');
  if (await page.locator('[data-account-trigger]').count()) {
    await page.locator('[data-account-trigger]').click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
  }
  await page.getByRole('button', { name: account }).click();
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();
  if (targetViewport) await page.setViewportSize(targetViewport);
}

async function buttonsOnPage(page: Page): Promise<NamedControl[]> {
  return page.locator('button:not([disabled])').evaluateAll((buttons) => {
    const seen = new Map<string, number>();
    return buttons.map((button, index) => {
      const rect = button.getBoundingClientRect();
      const name = (button.getAttribute('aria-label') || button.innerText || button.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      const occurrence = seen.get(name) ?? 0;
      seen.set(name, occurrence + 1);
      const inViewport = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
      const hit = inViewport ? document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2)), Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2))) : null;
      const receivesPointer = !!hit && (hit === button || button.contains(hit));
      return { name, occurrence, index, inViewport: inViewport && receivesPointer };
    }).filter((button) => button.inViewport && button.occurrence === 0);
  });
}

async function undersizedTapTargets(page: Page): Promise<string[]> {
  return page.locator('button:not([disabled]), a[href^="/"], a[href^="#"]').evaluateAll((elements) => elements.flatMap((element) => {
    const rect = element.getBoundingClientRect();
    const inViewport = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
    if (!inViewport || (rect.width >= 44 && rect.height >= 44)) return [];
    const name = (element.getAttribute('aria-label') || element.textContent || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    return [`${name || element.tagName}: ${Math.round(rect.width)}x${Math.round(rect.height)}px`];
  }));
}

async function clickVisibleControls(page: Page, path: string, heading: RegExp) {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  const undersizedTargets = await undersizedTapTargets(page);
  const buttons = await buttonsOnPage(page);
  const unnamed = buttons.filter((button) => !button.name);
  expect(unnamed, `Every visible enabled button on ${path} needs a readable name`).toEqual([]);

  for (const button of buttons) {
    const locator = page.getByRole('button', { name: button.name, exact: true }).first();
    if (!(await locator.count())) continue;
    if (!(await locator.isEnabled())) continue;
    await locator.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    try { await locator.click({ timeout: 5_000 }); }
    catch (error) {
      if (new URL(page.url()).pathname !== path || !(await locator.count()) || !(await locator.isEnabled())) continue;
      throw error;
    }
    await page.locator('audio').evaluateAll((players) => players.forEach((player) => (player as HTMLAudioElement).pause()));
    await page.waitForTimeout(100);
    await page.keyboard.press('Escape');
    const closeReminders = page.getByRole('button', { name: 'Close reminders' });
    if (await closeReminders.count()) await closeReminders.click();
    const closeNavigation = page.getByRole('button', { name: 'Close navigation' });
    if (await closeNavigation.count()) await closeNavigation.click();
    if (await page.locator('.camera-live').count()) await page.getByRole('button', { name: 'Close camera' }).click();
    if (new URL(page.url()).pathname !== path || await page.locator('.dialog-backdrop, .confirm-backdrop').count()) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }
  }

  await page.goto(path);
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  const links = await page.locator('a[href^="/"], a[href^="#"]').evaluateAll((anchors) => {
    const seen = new Set<string>();
    return anchors.flatMap((anchor) => {
    const rect = anchor.getBoundingClientRect();
    const inViewport = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
    const hit = inViewport ? document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2)), Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2))) : null;
    if (!inViewport || !hit || (hit !== anchor && !anchor.contains(hit))) return [];
    const href = anchor.getAttribute('href') || '';
    if (seen.has(href)) return [];
    seen.add(href);
    return [{
      name: (anchor.getAttribute('aria-label') || anchor.innerText || anchor.getAttribute('title') || '').replace(/\s+/g, ' ').trim(),
      href,
    }];
  });
  });
  expect(links.filter((link) => !link.name), `Every visible in-app link on ${path} needs a readable name`).toEqual([]);
  for (const link of links) {
    const target = new URL(link.href, page.url());
    if (target.origin !== new URL(page.url()).origin) continue;
    const safeHref = link.href.replace(/"/g, '\\"');
    const locator = page.locator(`a[href="${safeHref}"]:visible`).last();
    if (!(await locator.count())) continue;
    await locator.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await locator.click({ timeout: 5_000 });
    await page.waitForTimeout(100);
    if (new URL(page.url()).pathname !== path || await page.locator('.dialog-backdrop, .confirm-backdrop').count()) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }
  }
  return { buttons: buttons.length, links: links.length, undersizedTargets };
}

async function openUploadedReview(page: Page) {
  console.log('Review route audit: opening capture and uploading the demo card.');
  await page.goto('/scan');
  const upload = page.waitForResponse((response) => response.url().endsWith('/api/scans') && response.request().method() === 'POST', { timeout: 30_000 });
  await page.locator('#capture-gallery').setInputFiles({
    name: 'audit-sample-card.png', mimeType: 'image/png', buffer: readFileSync(resolve('public/demo/sample-card.png')),
  });
  const response = await upload;
  expect(response.status()).toBe(201);
  const { scan } = await response.json() as { scan: { id: string; status: string } };
  expect(scan.status).toBe('queued');
  console.log(`Review route audit: uploaded; reading started automatically (${scan.status}).`);
  await expect.poll(async () => {
    const result = await (await page.request.get(`/api/scans/${scan.id}`)).json() as { scan: { status: string } };
    return result.scan.status;
  }, { timeout: 15_000 }).toBe('ready');
  console.log('Review route audit: background reading is ready; opening the review route.');
  await page.goto(`/review/${scan.id}`);
  console.log(`Review route audit: browser is at ${new URL(page.url()).pathname}.`);
  await expect(page.getByRole('heading', { name: /Review this card/ })).toBeVisible();
  console.log('Review route audit: review screen heading is visible.');
}

async function exerciseReviewControls(page: Page) {
  await openUploadedReview(page);
  await expect(page.getByLabel('Name *')).toHaveValue('Demo Contact');
  await expect(page.getByLabel('Company')).toHaveValue('Acme Packaging');
  await page.getByRole('button', { name: 'Company brochure' }).click();
  console.log('Review route audit: switched to brochure review.');
  await expect(page.getByLabel('Company name')).toHaveValue('Acme Packaging');
  await page.getByRole('button', { name: 'Person lead' }).click();
  console.log('Review route audit: switched back to person review.');
  await expect(page.getByLabel('Name *')).toHaveValue('Demo Contact');
  await page.getByRole('button', { name: 'Tomorrow', exact: true }).click();
  await expect(page.getByLabel('Next follow-up date')).not.toHaveValue('');
  await page.getByRole('button', { name: 'No follow-up', exact: true }).click();
  await expect(page.getByLabel('Next follow-up date')).toHaveValue('');
  if ((page.viewportSize()?.width ?? 0) > 600) await expect(page.getByRole('button', { name: 'Save person' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Save & scan next' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Save & prepare email' })).toBeEnabled();
  const buttons = await buttonsOnPage(page);
  expect(buttons.filter((button) => !button.name), 'Every visible enabled review button needs a readable name').toEqual([]);
  const links = await page.locator('a[href^="/"]:visible').count();
  const undersizedTargets = await undersizedTapTargets(page);
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page).toHaveURL(/\/scan$/);
  await expect(page.locator('.tray-item').filter({ hasText: 'Demo Contact' })).toHaveCount(0);
  return { buttons: buttons.length, links, undersizedTargets };
}

test('click visible buttons and in-app links across company and private routes at desktop and phone widths', async ({ page }) => {
  test.skip(process.env.GATHER_FULL_CONTROL_CRAWL !== '1', 'Run with npm run audit:controls; this intentionally exhaustive sweep is separate from the fast regression suite.');
  test.setTimeout(900_000);
  const browserErrors: string[] = [];
  const failedRequests: string[] = [];
  const tapTargetFailures = new Set<string>();
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'unknown';
    if (failure !== 'net::ERR_ABORTED') failedRequests.push(`${request.method()} ${request.url()} failed: ${failure}`);
  });
  page.on('response', (response) => { if (response.status() >= 500) failedRequests.push(`${response.status()} ${response.url()}`); });
  page.on('dialog', (dialog) => void dialog.dismiss());

  const companyRoutes: CrawlRoute[] = [
    { path: '/home', heading: /Good morning, Maya/ },
    { path: '/setup', heading: /Make Gather yours/ },
    { path: '/scan', heading: /Keep the next conversation/ },
    { path: '/email', heading: /^Email Desk$/ },
    { path: '/people', heading: /Keep the person close/ },
    { path: '/people/demo-ns-contact-1', heading: /Tessa Morgan/ },
    { path: '/companies', heading: /One company, many people/ },
    { path: '/companies/demo-ns-acme', heading: /Acme Packaging/ },
    { path: '/follow-ups', heading: /Keep the next step from slipping/ },
    { path: '/pipeline', heading: /Move the conversation forward/ },
    { path: '/reports', heading: /See the work at a glance/ },
    { path: '/analytics', heading: /^Analytics$/ },
    { path: '/settings', heading: /What your team sells/ },
    { path: '/reset-password', heading: /Choose a new password/ },
    { path: '/verify-email', heading: /Verify your email/ },
  ];
  const attendeeRoutes: CrawlRoute[] = [
    { path: '/home', heading: /Good morning, Sam/ },
    { path: '/setup', heading: /Make Gather yours/ },
    { path: '/scan', heading: /Keep the next conversation/ },
    { path: '/email', heading: /^Email Desk$/ },
    { path: '/people', heading: /Keep the person close/ },
    { path: '/people/demo-sam-contact-1', heading: /Morgan Ellis/ },
    { path: '/analytics', heading: /^Analytics$/ },
    { path: '/follow-ups', heading: /Keep the next step from slipping/ },
    { path: '/settings', heading: /About me/ },
    { path: '/reset-password', heading: /Choose a new password/ },
    { path: '/verify-email', heading: /Verify your email/ },
  ];
  let controlsClicked = 0;

  const widths = process.env.GATHER_CONTROL_WIDTHS ? process.env.GATHER_CONTROL_WIDTHS.split(',').map(Number) : [1440, 390];
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await signIn(page, /Maya Chen/);
    for (const route of companyRoutes) {
      const counts = await clickVisibleControls(page, route.path, route.heading);
      if (width <= 430) for (const target of counts.undersizedTargets) tapTargetFailures.add(`${route.path} ${target}`);
      controlsClicked += counts.buttons + counts.links;
      console.log(`${width}px company ${route.path}: ${counts.buttons} distinct buttons, ${counts.links} links.`);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await signIn(page, /Sam Patel/);
    for (const route of attendeeRoutes) {
      const counts = await clickVisibleControls(page, route.path, route.heading);
      if (width <= 430) for (const target of counts.undersizedTargets) tapTargetFailures.add(`${route.path} ${target}`);
      controlsClicked += counts.buttons + counts.links;
      console.log(`${width}px private ${route.path}: ${counts.buttons} distinct buttons, ${counts.links} links.`);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  }

  expect(controlsClicked).toBeGreaterThan(100);
  console.log(`Route/button/link crawl exercised ${controlsClicked} controls across company/private roles at ${widths.join(' and ')} px.`);
  expect(failedRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
  if (widths.some((width) => width <= 430)) {
    console.log(`Undersized phone tap targets (<44px in either dimension): ${tapTargetFailures.size}`);
    for (const failure of tapTargetFailures) console.log(`  ${failure}`);
    expect([...tapTargetFailures], 'Every visible phone button and in-app link should offer a 44px minimum hit area').toEqual([]);
  }
});

test('upload immediately starts reading and the generated one-lead review route works at desktop and phone widths', async ({ page }) => {
  test.skip(process.env.GATHER_FULL_CONTROL_CRAWL !== '1', 'Run with npm run audit:controls; the upload-generated route is kept out of the fast suite.');
  test.setTimeout(180_000);
  const widths = process.env.GATHER_CONTROL_WIDTHS ? process.env.GATHER_CONTROL_WIDTHS.split(',').map(Number) : [1440, 390];
  const tapTargetFailures = new Set<string>();
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await signIn(page, /Maya Chen/);
    const counts = await exerciseReviewControls(page);
    if (width <= 430) for (const target of counts.undersizedTargets) tapTargetFailures.add(target);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    console.log(`${width}px review route: ${counts.buttons} visible buttons, ${counts.links} in-app links.`);
  }
  if (widths.some((width) => width <= 430)) {
    expect([...tapTargetFailures], 'Every visible phone button and in-app link on dynamic review should offer a 44px minimum hit area').toEqual([]);
  }
});

test('every repeated follow-up and meeting-row action works on desktop and phone', async ({ page }) => {
  test.skip(process.env.GATHER_FULL_CONTROL_CRAWL !== '1', 'Run with npm run audit:controls; this exhaustive repeated-control sweep is separate from the fast regression suite.');
  test.setTimeout(180_000);
  const database = new Database(resolve(process.env.DATABASE_PATH ?? 'data/gather-e2e.sqlite'));
  const widths = process.env.GATHER_CONTROL_WIDTHS ? process.env.GATHER_CONTROL_WIDTHS.split(',').map(Number) : [1440, 390];
  const dueAt = new Date(Date.now() + 86_400_000).toISOString();
  try {
    for (const width of widths) {
      database.prepare("UPDATE tasks SET status='open',snoozed_until=NULL WHERE id IN ('demo-task-noah','demo-task-tessa-overdue','demo-task-mina-today','demo-task-ari-upcoming')").run();
      database.prepare("UPDATE tasks SET status='confirmed' WHERE id='demo-task-june-meeting'").run();
      database.prepare("UPDATE tasks SET status='no_show' WHERE id='demo-task-rowan-no-show'").run();
      database.prepare("DELETE FROM tasks WHERE id IN ('audit-meeting-done','audit-meeting-cancel','audit-meeting-no-show')").run();
      const insertMeeting = database.prepare(`INSERT INTO tasks(id,workspace_id,contact_id,kind,status,due_at,time_zone,title,note,created_by)
        VALUES (?, 'demo-northstar', ?, 'meeting', 'proposed', ?, 'America/Los_Angeles', ?, 'Created for the repeated action audit.', 'demo-owner')`);
      insertMeeting.run('audit-meeting-done', 'demo-ns-contact-1', dueAt, 'Audit meeting to complete');
      insertMeeting.run('audit-meeting-cancel', 'demo-ns-contact-2', dueAt, 'Audit meeting to cancel');
      insertMeeting.run('audit-meeting-no-show', 'demo-ns-contact-3', dueAt, 'Audit meeting to mark no-show');

      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await signIn(page, /Maya Chen/);
      await page.goto('/follow-ups');
      await expect(page.getByRole('heading', { name: /Keep the next step from slipping/ })).toBeVisible();

      for (const [taskId, action] of [
        ['demo-task-noah', '1 day'],
        ['demo-task-tessa-overdue', '3 days'],
        ['demo-task-mina-today', '1 week'],
        ['demo-task-ari-upcoming', 'Done'],
      ] as const) {
        const row = page.locator(`.task-row[data-task-id="${taskId}"]`);
        await expect(row).toBeVisible();
        await row.getByRole('button', { name: action, exact: true }).click();
        if (action === 'Done') await expect(row.getByText('Done', { exact: true })).toBeVisible();
        else await expect(row.getByRole('button', { name: action, exact: true })).toBeVisible();
      }

      const doneMeeting = page.locator('.task-row[data-task-id="audit-meeting-done"]');
      await expect(doneMeeting).toBeVisible();
      await doneMeeting.getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect(doneMeeting.getByText('Confirmed', { exact: true })).toBeVisible();
      await doneMeeting.getByRole('button', { name: 'Mark done', exact: true }).click();
      await expect(doneMeeting.getByText('Done', { exact: true })).toBeVisible();

      const cancelMeeting = page.locator('.task-row[data-task-id="audit-meeting-cancel"]');
      await expect(cancelMeeting).toBeVisible();
      await cancelMeeting.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(cancelMeeting.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);

      const noShowMeeting = page.locator('.task-row[data-task-id="audit-meeting-no-show"]');
      await expect(noShowMeeting).toBeVisible();
      await noShowMeeting.getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect(noShowMeeting.getByText('Confirmed', { exact: true })).toBeVisible();
      await noShowMeeting.getByRole('button', { name: 'No-show', exact: true }).click();
      await expect(noShowMeeting.getByText('No-show', { exact: true })).toBeVisible();

      const failedTargets = width <= 430 ? await undersizedTapTargets(page) : [];
      expect(failedTargets, `${width}px follow-up route has undersized visible targets`).toEqual([]);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      console.log(`${width}px repeated-row audit: four follow-up actions and five meeting actions verified.`);
    }
  } finally {
    database.close();
  }
});

test('phone password recovery routes keep their actions large enough to tap', async ({ page }) => {
  test.skip(process.env.GATHER_FULL_CONTROL_CRAWL !== '1', 'Included in the exhaustive route audit.');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, heading] of [['/reset-password', /Choose a new password/], ['/verify-email', /Verify your email/]] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    expect(await undersizedTapTargets(page), `${path} has an undersized visible phone target`).toEqual([]);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
