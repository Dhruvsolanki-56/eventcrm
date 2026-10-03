import { afterEach, expect, test, vi } from 'vitest';
import { summarizeCheckedTranscript } from './gemini-conversation.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

test('checked voice text can produce a bounded suggestion without saving it', async () => {
  vi.stubEnv('GEMINI_API_KEY', 'local-test-key');
  vi.stubEnv('AI_MODE', 'provider'); vi.stubEnv('AI_PROVIDER', 'gemini');
  const mocked = vi.fn(async (_url: string, options: RequestInit) => {
    const request = JSON.parse(String(options.body));
    expect(request.contents[0].parts[0].text).toContain('Asked for samples next week');
    return { ok: true, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'Asked for samples next week.' }) }] } }] }) };
  });
  vi.stubGlobal('fetch', mocked);
  expect(await summarizeCheckedTranscript('Asked for samples next week')).toBe('Asked for samples next week.');
  expect(mocked).toHaveBeenCalledTimes(1);
});

test('voice summary fails closed when the provider gives unusable output', async () => {
  vi.stubEnv('GEMINI_API_KEY', 'local-test-key');
  vi.stubEnv('AI_MODE', 'provider'); vi.stubEnv('AI_PROVIDER', 'gemini');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '{"candidates":[]}' })));
  await expect(summarizeCheckedTranscript('Checked words')).rejects.toThrow('AI could not prepare a usable summary');
});
