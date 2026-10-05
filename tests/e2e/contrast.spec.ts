import { expect, test } from '@playwright/test';
// Every visible piece of text meets WCAG AA contrast (4.5:1, or 3:1 for large text) on the main screens, on a desktop and a phone.
test('text contrast meets WCAG AA on the main screens at desktop and phone width', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await expect(page.getByRole('heading', { name: 'Scan cards', exact: true })).toBeVisible();
  const seen = new Map<string, { n: number; where: string }>();
  for (const width of [1280, 390]) {
  await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
  for (const path of ['/', '/scan', '/people', '/pipeline', '/companies', '/email', '/analytics', '/settings', '/settings?tab=team', '/people/demo-ns-contact-1', '/companies/demo-ns-acme', '/follow-ups', '/problems']) {
    await page.goto(path); await page.waitForLoadState('networkidle');
    const found = await page.evaluate(() => {
      const parse = (c: string) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1]!.split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: p[0]!, g: p[1]!, b: p[2]!, a: p[3] ?? 1 }; };
      const lum = (c: { r: number; g: number; b: number }) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
      const bgOf = (el: Element) => { let layers: Array<{ r: number; g: number; b: number; a: number }> = []; for (let e: Element | null = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } } let base = { r: 255, g: 255, b: 255 }; for (const c of layers.reverse()) base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) }; return base; };
      const out: Array<{ key: string; text: string; ratio: number; size: number; fg: string; bg: string }> = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent!.trim(); if (!text) continue;
        const el = node.parentElement!; const st = getComputedStyle(el);
        const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
        if ((el as HTMLElement).closest('[disabled],[aria-disabled=true]')) continue;
        const fgc = parse(st.color); if (!fgc) continue; const bg = bgOf(el);
        const fg = { r: fgc.r * fgc.a + bg.r * (1 - fgc.a), g: fgc.g * fgc.a + bg.g * (1 - fgc.a), b: fgc.b * fgc.a + bg.b * (1 - fgc.a) };
        const a = lum(fg), b = lum(bg); const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        const size = parseFloat(st.fontSize); const bold = Number(st.fontWeight) >= 700; const large = size >= 24 || (size >= 18.66 && bold);
        if (ratio < (large ? 3 : 4.5)) out.push({ key: `${st.color}|${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}`, text: text.slice(0, 30), ratio: Math.round(ratio * 100) / 100, size, fg: st.color, bg: `${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}` });
      }
      return out;
    });
    for (const f of found) { const k = `${width}px ${f.fg} on ${f.bg} (${f.ratio}:1, ${f.size}px)`; const cur = seen.get(k); seen.set(k, { n: (cur?.n ?? 0) + 1, where: cur?.where ?? `${path} "${f.text}"` }); }
  }
  }
  expect([...seen].map(([k, v]) => `${v.n}x ${k} e.g. ${v.where}`)).toEqual([]);
});
