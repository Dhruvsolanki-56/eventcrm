import { expect, test } from '@playwright/test';

// Structural basics on every main screen, at phone width: no repeated ids, every field has a label, every image has alt text,
// and the selects people tap are full size.
test('main screens keep unique ids, labelled fields and full-size selects on a phone', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/', '/scan', '/people', '/pipeline', '/events', '/events/event-main-active', '/campaigns', '/companies', '/email', '/analytics', '/settings', '/settings?tab=team', '/people/demo-ns-contact-1', '/companies/demo-ns-acme', '/follow-ups', '/problems']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const found = await page.evaluate(() => {
      const shown = (el: Element) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
      const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
      const unlabeled = [...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter((el) => shown(el) && !(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label'))).map((el) => el.outerHTML.slice(0, 80));
      return {
        repeatedIds: [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))],
        unlabeled,
        noAlt: [...document.querySelectorAll('img:not([alt])')].length,
        smallSelects: [...document.querySelectorAll('select')].filter((el) => shown(el) && el.getBoundingClientRect().height < 43).map((el) => el.getAttribute('aria-label') ?? el.outerHTML.slice(0, 60)),
        sideways: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        language: document.documentElement.lang,
      };
    });
    expect(found, path).toEqual({ repeatedIds: [], unlabeled: [], noAlt: 0, smallSelects: [], sideways: 0, language: 'en' });
  }
});
