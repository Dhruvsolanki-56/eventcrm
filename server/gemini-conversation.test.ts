import { afterEach, expect, test, vi } from 'vitest';
import { suggestConversationContext, summarizeCheckedTranscript } from './gemini-conversation.js';

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

test('conversation interpretation keeps our role separate and returns review-only fields', async () => {
  vi.stubEnv('GEMINI_API_KEY', 'local-test-key');
  vi.stubEnv('AI_MODE', 'provider'); vi.stubEnv('AI_PROVIDER', 'gemini');
  const mocked = vi.fn(async (_url: string, options: RequestInit) => {
    const request = JSON.parse(String(options.body));
    expect(request.contents[0].parts[0].text).toContain('development partner');
    expect(request.systemInstruction.parts[0].text).toContain('Preserve WHO requested');
    return { ok: true, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'Mariana requested a written overview of both projects.', openQuestion: 'What scope should the overview cover?', promisedNextStep: '', changedSinceLast: 'She now wants one email covering both projects.' }) }] } }] }) };
  });
  vi.stubGlobal('fetch', mocked);
  const result = await suggestConversationContext({ note: 'Client wants official email for both projects; we are development partner.', personName: 'Mariana', ourRole: 'development partner', whatWeSell: 'Software services', previousSummary: 'Discussed two projects.' });
  expect(result.promisedNextStep).toBe('');
  expect(result.summary).toContain('Mariana');
});
