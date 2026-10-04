import { afterEach, describe, expect, it, vi } from 'vitest';
import { draftEmailWithGroq, isGroqEmailEnabled } from './groq-email.js';
import { draftEmail } from './ai.js';
import type { EmailDraftContext } from './ai.js';

const context: EmailDraftContext = {
  firstName: 'Olivia', companyName: 'Acme Packaging', eventName: 'Packaging Expo',
  senderOrganization: 'Gather Packaging', senderRole: 'Packaging supplier', senderOfferings: 'Recycled packaging', senderGoal: '',
  productsOfInterest: ['Recycled mailers'], companyProducts: ['Recycled mailers'],
  recentConversations: [{ date: '2026-10-02', eventName: 'Packaging Expo', rawNote: 'Olivia asked for sample sizes.', checkedSummary: '', openQuestion: '', promisedNextStep: '' , changedSinceLast: '' }],
  tone: 'Friendly', signature: 'Maya', neverPromise: 'prices',
};

const groqReply = (body: string) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ subject: 'Sample sizes', body }) } }] }), { status: 200 });
const geminiReply = (body: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ subject: 'From Gemini', body }) }] } }] }), { status: 200 });
const enable = (groq = true) => {
  vi.stubEnv('AI_MODE', 'provider'); vi.stubEnv('AI_PROVIDER', 'gemini'); vi.stubEnv('GEMINI_API_KEY', 'gemini-test-key');
  vi.stubEnv('GROQ_API_KEY', groq ? 'groq-test-key' : '');
};

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Groq email drafts', () => {
  it('is off without its own key, and never calls out', async () => {
    enable(false);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(isGroqEmailEnabled()).toBe(false);
    expect(await draftEmailWithGroq(context)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends the scoped context to Groq with the key in a header, then tidies the reply', async () => {
    enable();
    const fetch = vi.fn(async () => groqReply('Hi Olivia, Thanks for asking about sizes. Best, Maya'));
    vi.stubGlobal('fetch', fetch);
    const draft = await draftEmailWithGroq(context);
    expect(draft?.body).toBe('Hi Olivia,\n\nThanks for asking about sizes.\n\nBest,\nMaya');
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((options.headers as Record<string, string>).Authorization).toBe('Bearer groq-test-key');
    const payload = JSON.parse(options.body as string) as { model: string; messages: Array<{ role: string; content: string }> };
    expect(payload.model).toBe('openai/gpt-oss-120b');
    expect(payload.messages[1].content).toContain('Olivia asked for sample sizes');
  });

  it('replaces non-breaking hyphens and spaces with plain ones', async () => {
    enable();
    vi.stubGlobal('fetch', vi.fn(async () => groqReply('Hi Olivia,\n\nA follow\u2011up\u00a0note.\n\nMaya')));
    const draft = await draftEmailWithGroq(context);
    expect(draft?.body).toContain('A follow-up note.');
  });

  it('applies the same safety checks as the Gemini writer', async () => {
    enable();
    vi.stubGlobal('fetch', vi.fn(async () => groqReply('Hi Olivia,\n\nI have attached our price list.\n\nMaya')));
    await expect(draftEmailWithGroq(context)).rejects.toThrow('attachment');
  });

  it('does not retry a quota error', async () => {
    enable();
    const limited = vi.fn(async () => new Response('{}', { status: 429 })); vi.stubGlobal('fetch', limited);
    await expect(draftEmailWithGroq(context)).rejects.toThrow();
    expect(limited).toHaveBeenCalledOnce();
  });
});

describe('email writer order', () => {
  it('uses Groq first and does not call Gemini when Groq answers', async () => {
    enable();
    const fetch = vi.fn(async (url: string) => url.includes('groq.com') ? groqReply('Hi Olivia,\n\nThanks.\n\nMaya') : geminiReply('Hi Olivia,\n\nFrom Gemini.\n\nMaya'));
    vi.stubGlobal('fetch', fetch);
    expect((await draftEmail(context))?.subject).toBe('Sample sizes');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('falls back to Gemini when Groq is out of quota', async () => {
    enable();
    const fetch = vi.fn(async (url: string) => url.includes('groq.com') ? new Response('{}', { status: 429 }) : geminiReply('Hi Olivia,\n\nFrom Gemini.\n\nMaya'));
    vi.stubGlobal('fetch', fetch);
    expect((await draftEmail(context))?.subject).toBe('From Gemini');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('falls back to Gemini when Groq writes something the checks reject', async () => {
    enable();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('groq.com') ? groqReply('Hi Olivia,\n\nWe attached the quote.\n\nMaya') : geminiReply('Hi Olivia,\n\nFrom Gemini.\n\nMaya')));
    expect((await draftEmail(context))?.subject).toBe('From Gemini');
  });

  it('gives up cleanly (so the template is used) when both fail', async () => {
    enable();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })));
    await expect(draftEmail(context)).rejects.toThrow();
  });

  it('works with Groq alone', async () => {
    vi.stubEnv('AI_MODE', 'provider'); vi.stubEnv('AI_PROVIDER', 'anthropic'); vi.stubEnv('GEMINI_API_KEY', ''); vi.stubEnv('GROQ_API_KEY', 'groq-test-key');
    vi.stubGlobal('fetch', vi.fn(async () => groqReply('Hi Olivia,\n\nThanks.\n\nMaya')));
    expect((await draftEmail(context))?.subject).toBe('Sample sizes');
  });
});
