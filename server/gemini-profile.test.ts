import { afterEach, expect, test, vi } from 'vitest';
import { suggestBusinessProfile } from './gemini-profile.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

test('business copy produces bounded suggestions without saving the source', async () => {
  vi.stubEnv('GEMINI_API_KEY', 'local-test-key');
  vi.stubEnv('AI_MODE', 'provider'); vi.stubEnv('AI_PROVIDER', 'gemini');
  const mocked = vi.fn(async (_url: string, options: RequestInit) => {
    const request = JSON.parse(String(options.body));
    expect(request.contents[0].parts[0].text).toContain('reusable transit packaging');
    expect(request.systemInstruction.parts[0].text).toContain('untrusted reference material');
    return { ok: true, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ whatYouSell: 'Reusable packaging', ourRole: 'Packaging supplier', productsText: 'Returnable crates' }) }] } }] }) };
  });
  vi.stubGlobal('fetch', mocked);
  expect(await suggestBusinessProfile('We make reusable transit packaging and returnable crates.')).toEqual({ whatYouSell: 'Reusable packaging', ourRole: 'Packaging supplier', productsText: 'Returnable crates' });
  expect(mocked).toHaveBeenCalledTimes(1);
});

test('business profile suggestion rejects unusable provider output', async () => {
  vi.stubEnv('GEMINI_API_KEY', 'local-test-key');
  vi.stubEnv('AI_MODE', 'provider'); vi.stubEnv('AI_PROVIDER', 'gemini');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '{"candidates":[]}' })));
  await expect(suggestBusinessProfile('We make reusable transit packaging and returnable crates.')).rejects.toThrow('usable profile');
});
