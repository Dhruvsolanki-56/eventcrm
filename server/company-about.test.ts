import { afterEach, describe, expect, it, vi } from 'vitest';
import { suggestCompanyAbout } from './company-about.js';

const groq = (about: string) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ about }) } }] }), { status: 200 });
const gemini = (about: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ about }) }] } }] }), { status: 200 });
const enable = () => { vi.stubEnv('AI_MODE', 'provider'); vi.stubEnv('AI_PROVIDER', 'gemini'); vi.stubEnv('GEMINI_API_KEY', 'g-test'); vi.stubEnv('GROQ_API_KEY', 'q-test'); };

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('company description from website text', () => {
  it('returns the model sentence and sends the page text only as data', async () => {
    enable();
    const fetch = vi.fn(async () => groq('Makes recyclable packaging for beauty brands.'));
    vi.stubGlobal('fetch', fetch);
    expect(await suggestCompanyAbout('Acme', 'Acme makes recyclable packaging.')).toBe('Makes recyclable packaging for beauty brands.');
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0].content).toContain('untrusted');
    expect(body.messages[1].content).toContain('Acme makes recyclable packaging.');
  });

  it('falls back to Gemini when Groq fails, and refuses a reply with a link or price', async () => {
    enable();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('groq.com') ? new Response('{}', { status: 429 }) : gemini('Sells boxes.')));
    expect(await suggestCompanyAbout('Acme', 'text')).toBe('Sells boxes.');
    vi.stubGlobal('fetch', vi.fn(async () => groq('Visit https://acme.example for $5 boxes.')));
    vi.stubEnv('GEMINI_API_KEY', '');
    await expect(suggestCompanyAbout('Acme', 'text')).rejects.toThrow('could not describe');
  });

  it('says so when AI is off', async () => {
    vi.stubEnv('AI_MODE', 'off');
    await expect(suggestCompanyAbout('Acme', 'text')).rejects.toThrow('not set up');
  });
});
