import { afterEach, describe, expect, it, vi } from 'vitest';
import { draftEmailWithGemini, isGeminiEmailEnabled } from './gemini-email.js';
import type { EmailDraftContext } from './ai.js';

const context: EmailDraftContext = {
  firstName: 'Olivia', companyName: 'Acme Packaging', eventName: 'Packaging Expo',
  productsOfInterest: ['Recycled mailers'], companyProducts: ['Recycled mailers'],
  latestNote: 'Asked for sample sizes for the next shipment.',
  recentConversations: [
    { date: '2026-10-02', eventName: 'Packaging Expo', note: 'Asked for sample sizes for the next shipment.' },
    { date: '2026-09-20', eventName: null, note: 'Earlier interest in recycled materials.' },
  ],
  tone: 'Professional', signature: 'Maya', neverPromise: 'No delivery guarantee', aboutMe: 'We make packaging',
};

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Gemini email drafts', () => {
  it('uses the configured free-tier key and only the scoped context for an editable suggestion', async () => {
    vi.stubEnv('AI_MODE', 'provider'); vi.stubEnv('AI_PROVIDER', 'gemini'); vi.stubEnv('GEMINI_API_KEY', 'test-only-key');
    const fetch = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ subject: 'Sample sizes after Packaging Expo', body: 'Hi Olivia,\n\nYou asked about sample sizes for recycled mailers. Would you like me to share the available options?\n\nMaya' }) }] } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(isGeminiEmailEnabled()).toBe(true);
    const draft = await draftEmailWithGemini(context);
    expect(draft?.body).toContain('sample sizes');
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/models/gemini-3.1-flash-lite:generateContent');
    expect((options.headers as Record<string, string>)['x-goog-api-key']).toBe('test-only-key');
    const payload = JSON.parse(options.body as string) as { contents: Array<{ parts: Array<{ text: string }> }> };
    expect(payload.contents[0].parts[0].text).toContain('Packaging Expo');
    expect(payload.contents[0].parts[0].text).toContain('Asked for sample sizes');
  });

  it('does not call a provider when disabled', async () => {
    vi.stubEnv('AI_MODE', 'off'); vi.stubEnv('AI_PROVIDER', 'gemini'); vi.stubEnv('GEMINI_API_KEY', 'test-only-key');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(isGeminiEmailEnabled()).toBe(false);
    expect(await draftEmailWithGemini(context)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an unsafe or malformed model response instead of saving it', async () => {
    vi.stubEnv('AI_MODE', 'provider'); vi.stubEnv('AI_PROVIDER', 'gemini'); vi.stubEnv('GEMINI_API_KEY', 'test-only-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"subject":"Hello","body":"Hi","send":true}' }] } }] }), { status: 200 })));
    await expect(draftEmailWithGemini(context)).rejects.toThrow();
  });
});
