import { expect, test, type Page } from '@playwright/test';

async function inspectRoute(page: Page, route: string, width: number) {
  await page.setViewportSize({ width, height: 950 });
  await page.goto(route);
  await expect(page.locator('main')).toBeVisible();
  const audit = await page.evaluate(() => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0;
    };
    const textForIds = (value: string | null) => value?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim() ?? '';
    const issues: string[] = [];
    if (!document.documentElement.lang.trim()) issues.push('document language is missing');
    if (!document.title.trim()) issues.push('document title is missing');
    if (document.querySelectorAll('main').length !== 1) issues.push('expected exactly one main landmark');
    if (!document.querySelector('nav,[role="navigation"]')) issues.push('navigation landmark is missing');
    for (const element of document.querySelectorAll('button,a[href],[role="button"],[role="link"],[role="tab"],[role="menuitem"],input:not([type="hidden"]),textarea,select,[role="combobox"],[role="checkbox"],[role="switch"]')) {
      if (!visible(element) || element.closest('[aria-hidden="true"],[inert]')) continue;
      const ariaName = element.getAttribute('aria-label')?.trim() || textForIds(element.getAttribute('aria-labelledby'));
      const labels = 'labels' in element ? Array.from((element as HTMLInputElement).labels ?? []).map((label) => label.textContent?.trim() ?? '').filter(Boolean).join(' ') : '';
      const contentName = /^(BUTTON|A)$/.test(element.tagName) || ['button', 'link', 'tab', 'menuitem'].includes(element.getAttribute('role') ?? '')
        ? (element as HTMLElement).innerText?.trim() || element.textContent?.trim() || '' : '';
      const name = ariaName || labels || contentName || element.getAttribute('title')?.trim() || '';
      if (!name) issues.push(`${element.tagName.toLowerCase()} has no accessible name`);
    }
    for (const image of document.querySelectorAll('img')) if (!image.hasAttribute('alt')) issues.push('image is missing an alt attribute');
    return issues;
  });
  expect(audit, `${route} at ${width}px`).toEqual([]);
  await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return { focused: false, visible: false };
    const style = getComputedStyle(element);
    return { focused: true, visible: style.outlineStyle !== 'none' && style.outlineWidth !== '0px' || style.boxShadow !== 'none' };
  });
  expect(focus.focused, `keyboard focus target for ${route} at ${width}px`).toBe(true);
  expect(focus.visible, `visible focus indication for ${route} at ${width}px`).toBe(true);
}

test('company and private attendee routes retain named controls, labeled fields, landmarks, and keyboard focus on desktop and phone', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();

  const companyRoutes = ['/home', '/scan', '/email', '/people', '/people/demo-ns-contact-1', '/companies', '/companies/demo-ns-acme', '/pipeline', '/analytics', '/reports', '/follow-ups', '/settings'];
  for (const width of [1440, 390]) for (const route of companyRoutes) await inspectRoute(page, route, width);

  await page.setViewportSize({ width: 1440, height: 950 });
  await page.locator('.profile-button').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Good to see you.' })).toBeVisible();
  await page.getByRole('button', { name: /Sam Patel/ }).click();
  await expect(page.getByRole('heading', { name: 'Keep the next conversation.' })).toBeVisible();

  const attendeeRoutes = ['/home', '/setup', '/scan', '/people', '/people/demo-sam-contact-1', '/companies', '/pipeline', '/analytics', '/reports', '/follow-ups', '/settings'];
  for (const width of [1440, 390]) for (const route of attendeeRoutes) await inspectRoute(page, route, width);
});
