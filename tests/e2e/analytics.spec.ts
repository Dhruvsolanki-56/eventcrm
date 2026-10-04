import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { AnalyticsData } from '../../shared/analytics.js';

test('analytics filters, chart controls, export and record links work on desktop and phone', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Analytics', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Analytics', exact: true })).toBeVisible();
  await expect(page.locator('.analytics-kpis article').first().locator('strong')).not.toHaveText('0');
  await expect(page.getByRole('status').filter({ hasText: 'Updating analytics' })).toHaveCount(0);
  await page.screenshot({ path: resolve('docs/screenshots/analytics-desktop.png'), fullPage: true });
  await page.getByLabel('Analytics period').selectOption('7');
  await expect(page).toHaveURL(/days=7/);
  await page.getByLabel('Analytics event').selectOption('event-main-active');
  await expect(page).toHaveURL(/event=event-main-active/);
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Conversations', exact: true })).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.analytics-chart')).toHaveAttribute('aria-label', /Daily conversations/);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export activity' }).click();
  expect((await download).suggestedFilename()).toMatch(/^gather-activity-.*\.csv$/);
  await page.getByRole('button', { name: 'Refresh analytics' }).click();
  await expect(page.getByRole('button', { name: 'Refresh analytics' })).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: resolve('docs/screenshots/analytics-phone.png'), fullPage: true });
  await page.locator('.analytics-table a').first().click();
  await expect(page).toHaveURL(/\/people\//);
  expect(errors).toEqual([]);
});

test('analytics counts over 200 records, deduplicates companies and respects event and role access', async ({ page }) => {
  const database = new Database(resolve(process.env.DATABASE_PATH!));
  const companyId = randomUUID(), eventId = randomUUID();
  const contacts: string[] = [];
  try {
    database.transaction(() => {
      database.prepare(`INSERT INTO companies(id,workspace_id,name,normalized_name,deal_value_minor,deal_status) VALUES (?,'demo-northstar','Analytics fixture',?,990000,'won')`).run(companyId, companyId);
      database.prepare(`INSERT INTO events(id,workspace_id,name,starts_at,ends_at,time_zone) VALUES (?,'demo-northstar','Private analytics fixture',?,?,'Pacific/Kiritimati')`).run(eventId, new Date().toISOString(), new Date().toISOString());
      database.prepare(`INSERT INTO event_access(workspace_id,event_id,user_id) VALUES ('demo-northstar',?,'demo-owner')`).run(eventId);
      const contact = database.prepare(`INSERT INTO contacts(id,workspace_id,company_id,name,owner_user_id,archived_at) VALUES (?,'demo-northstar',?,?,'demo-owner',?)`);
      const encounter = database.prepare(`INSERT INTO encounters(id,workspace_id,contact_id,event_id,occurred_at) VALUES (?,'demo-northstar',?,?,?)`);
      for (let index=0; index<207; index++) {
        const id=randomUUID(); contacts.push(id);
        contact.run(id,companyId,`Analytics ${index}`,index===205 ? new Date().toISOString() : null);
        encounter.run(randomUUID(),id,eventId,new Date(Date.now()-(index===206 ? 10*86400000 : 0)).toISOString());
        if(index===0) encounter.run(randomUUID(),id,eventId,new Date().toISOString());
      }
    })();
    await page.goto('/'); await page.getByRole('button',{name:/Maya Chen/}).click();
    await expect(page.getByRole('heading',{name:'Keep the next conversation.'})).toBeVisible();
    const data=await (await page.request.get(`/api/analytics?days=7&eventId=${eventId}`)).json() as AnalyticsData;
    expect(data.metrics).toMatchObject({people:205,previousPeople:1,companies:1,conversations:206,wonValue:990000,wonCompanies:1});
    expect(data.daily).toHaveLength(7);
    expect(data.daily.reduce((sum,row)=>sum+row.conversations,0)).toBe(206);
    expect(data.period.timeZone).toBe('Pacific/Kiritimati');
    expect((await page.request.get('/api/analytics?days=999')).status()).toBe(400);
    await page.locator('[data-account-trigger]').click(); await page.getByRole('menuitem',{name:'Sign out'}).click();
    await page.getByRole('button',{name:/Priya Shah/}).click();
    await expect(page.getByRole('heading',{name:'Keep the next conversation.'})).toBeVisible();
    expect((await page.request.get(`/api/analytics?days=7&eventId=${eventId}`)).status()).toBe(400);
    const scoped=await (await page.request.get('/api/analytics')).json() as AnalyticsData;
    expect(scoped.events.some((event)=>event.id===eventId)).toBe(false);
    expect(scoped.sources.some((event)=>event.id===eventId)).toBe(false);
    await page.locator('[data-account-trigger]').click(); await page.getByRole('menuitem',{name:'Sign out'}).click();
    await page.getByRole('button',{name:/Jordan Lee/}).click();
    await expect(page.getByRole('heading',{name:'Keep the next conversation.'})).toBeVisible();
    expect((await page.request.get('/api/analytics')).status()).toBe(403);
    await page.locator('[data-account-trigger]').click(); await page.getByRole('menuitem',{name:'Sign out'}).click();
    await page.getByRole('button',{name:/Sam Patel/}).click();
    await expect(page.getByRole('heading',{name:'Keep the next conversation.'})).toBeVisible();
    const personal=await (await page.request.get('/api/analytics')).json() as AnalyticsData;
    expect(personal.recent.every((person)=>person.id.startsWith('demo-sam'))).toBe(true);
    expect(personal.events.some((event)=>event.id===eventId)).toBe(false);
  } finally {
    database.transaction(()=>{
      for(const id of contacts) { database.prepare('DELETE FROM encounters WHERE contact_id=?').run(id); database.prepare('DELETE FROM contacts WHERE id=?').run(id); }
      database.prepare('DELETE FROM event_access WHERE event_id=?').run(eventId);
      database.prepare('DELETE FROM events WHERE id=?').run(eventId);
      database.prepare('DELETE FROM companies WHERE id=?').run(companyId);
    })(); database.close();
  }
});
