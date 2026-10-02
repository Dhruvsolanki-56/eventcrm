import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { isGeminiCardEnabled, readCardWithGemini } from './gemini-card.js';

const photo = resolve('public/demo/sample-card.png');

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('opt-in Gemini card extraction', () => {
  it('requires provider mode and a server-side key', async () => {
    vi.stubEnv('AI_MODE', 'off'); vi.stubEnv('AI_PROVIDER', 'gemini'); vi.stubEnv('GEMINI_API_KEY', 'test-key');
    expect(isGeminiCardEnabled()).toBe(false);
    await expect(readCardWithGemini(photo, 'image/png')).rejects.toThrow('not configured');
    vi.stubEnv('AI_MODE', 'provider');
    expect(isGeminiCardEnabled()).toBe(true);
    vi.stubEnv('GEMINI_API_KEY', '');
    expect(isGeminiCardEnabled()).toBe(false);
  });

  it('sends only the selected image to the fixed provider endpoint and validates fields', async () => {
    vi.stubEnv('AI_MODE', 'provider'); vi.stubEnv('AI_PROVIDER', 'gemini'); vi.stubEnv('GEMINI_API_KEY', 'private-test-key');
    const fields = { name: 'Avery Chen', title: '', company: 'Northstar', email: 'avery@example.com', phone: '', website: '', products: [], topics: [], uncertain: [] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(fields) }] } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await readCardWithGemini(photo, 'image/png')).toEqual(fields);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\//);
    expect(url).not.toContain('private-test-key');
    expect((options.headers as Record<string, string>)['x-goog-api-key']).toBe('private-test-key');
    expect(JSON.parse(String(options.body)).contents[0].parts[0].inline_data.mime_type).toBe('image/png');
  });

  it('fails safely on free-tier limits and invalid suggestions', async () => {
    vi.stubEnv('AI_MODE', 'provider'); vi.stubEnv('AI_PROVIDER', 'gemini'); vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })));
    await expect(readCardWithGemini(photo, 'image/png')).rejects.toThrow('free-tier limit');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"name":23}' }] } }] }), { status: 200 })));
    await expect(readCardWithGemini(photo, 'image/png')).rejects.toThrow('unexpected format');
  });
});
