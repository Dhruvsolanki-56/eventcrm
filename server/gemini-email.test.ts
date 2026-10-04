import { afterEach, describe, expect, it, vi } from 'vitest';
import { draftEmailWithGemini, isGeminiEmailEnabled } from './gemini-email.js';
import type { EmailDraftContext } from './ai.js';
import { emailWritingInstruction, tidyEmailBody } from './email-writing.js';

const context: EmailDraftContext = {
  firstName: 'Olivia', companyName: 'Acme Packaging', eventName: 'Packaging Expo',
  senderOrganization: 'Gather Packaging', senderRole: 'Packaging supplier', senderOfferings: 'Recycled packaging', senderGoal: 'Help customers choose packaging',
  productsOfInterest: ['Recycled mailers'], companyProducts: ['Recycled mailers'],
  recentConversations: [
    { date: '2026-10-02', eventName: 'Packaging Expo', rawNote: 'Olivia asked us for sample sizes for the next shipment.', checkedSummary: '', openQuestion: '', promisedNextStep: '', changedSinceLast: '' },
    { date: '2026-09-20', eventName: null, rawNote: 'Earlier interest in recycled materials.', checkedSummary: '', openQuestion: '', promisedNextStep: '', changedSinceLast: '' },
  ],
  tone: 'Professional', signature: 'Maya', neverPromise: 'No delivery guarantee',
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
    expect(payload.contents[0].parts[0].text).toContain('Olivia asked us for sample sizes');
  });

  it('does not call a provider when disabled', async () => {
    vi.stubEnv('AI_MODE', 'off'); vi.stubEnv('AI_PROVIDER', 'gemini'); vi.stubEnv('GEMINI_API_KEY', 'test-only-key');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(isGeminiEmailEnabled()).toBe(false);
    expect(await draftEmailWithGemini(context)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sets sender and recipient roles before composing from rough conversation notes', () => {
    const prompt = emailWritingInstruction();
    expect(prompt).toContain('senderOrganization, senderRole and senderOfferings describe OUR side');
    expect(prompt).toContain('"we/us/our/I" in rawNote normally means the sender');
    expect(prompt).toContain('Never reverse who made or received an offer');
    expect(prompt).toContain('newest rawNote is the primary conversation evidence');
    expect(prompt).toContain('Do not invent scope, terms, an approved price, acceptance, or an onboarding date');
    expect(prompt).toContain('do not upgrade it to a proposal, quotation, or contract');
  });

  it('rejects an unsafe or malformed model response instead of saving it', async () => {
    vi.stubEnv('AI_MODE', 'provider'); vi.stubEnv('AI_PROVIDER', 'gemini'); vi.stubEnv('GEMINI_API_KEY', 'test-only-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"subject":"Hello","body":"Hi","send":true}' }] } }] }), { status: 200 })));
    await expect(draftEmailWithGemini(context)).rejects.toThrow();
  });

  it('rejects model output that pastes an internal summary into the client email', async () => {
    vi.stubEnv('AI_MODE', 'provider'); vi.stubEnv('AI_PROVIDER', 'gemini'); vi.stubEnv('GEMINI_API_KEY', 'test-only-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ subject: 'Following up', body: "Hi Olivia,\n\nThe customer's stated need was an offer.\n\nMaya" }) }] } }] }), { status: 200 })));
    await expect(draftEmailWithGemini(context)).rejects.toThrow('repeated internal note language');
  });

  it('does not show an AI draft that assigns our ambiguous offer to the recipient', async () => {
    vi.stubEnv('AI_MODE', 'provider'); vi.stubEnv('AI_PROVIDER', 'gemini'); vi.stubEnv('GEMINI_API_KEY', 'test-only-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ subject: 'Following up', body: 'Hi Olivia, could you clarify the offer you mentioned? Maya' }) }] } }] }), { status: 200 })));
    await expect(draftEmailWithGemini({ ...context, recentConversations: [{ ...context.recentConversations[0], rawNote: 'We have got the offer for both projects.' }] })).rejects.toThrow('unclear offer');
  });

  const reply = (body: string) => vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ subject: 'Hello', body }) }] } }] }), { status: 200 }));
  const enable = () => { vi.stubEnv('AI_MODE', 'provider'); vi.stubEnv('AI_PROVIDER', 'gemini'); vi.stubEnv('GEMINI_API_KEY', 'test-only-key'); };

  it('turns a one-block reply into a greeting, paragraphs and a sign-off', async () => {
    enable(); vi.stubGlobal('fetch', reply('Hi Olivia, Thanks for asking about sample sizes. Best regards, Maya'));
    const draft = await draftEmailWithGemini({ ...context, signature: 'Maya' });
    expect(draft?.body).toBe('Hi Olivia,\n\nThanks for asking about sample sizes.\n\nBest regards,\nMaya');
  });

  it('keeps a multi-line signature on separate lines and leaves well-formed bodies alone', () => {
    expect(tidyEmailBody('Hi Tessa, Thanks. Best, Maya Chen Northstar Packaging', 'Maya Chen\nNorthstar Packaging')).toBe('Hi Tessa,\n\nThanks.\n\nBest,\nMaya Chen\nNorthstar Packaging');
    const good = 'Hi Tessa,\n\nThanks.\n\nBest,\nMaya';
    expect(tidyEmailBody(good, 'Maya')).toBe(good);
    expect(tidyEmailBody('Hi Tessa,\n\nit was great.\n\nBest,\nMaya', 'Maya')).toBe('Hi Tessa,\n\nIt was great.\n\nBest,\nMaya');
  });

  it('turns thinking down and allows a long enough answer', async () => {
    enable(); const fetch = reply('Hi Olivia,\n\nThanks.\n\nMaya'); vi.stubGlobal('fetch', fetch);
    await draftEmailWithGemini(context);
    const payload = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as { generationConfig: { maxOutputTokens: number; thinkingConfig: unknown } };
    expect(payload.generationConfig.maxOutputTokens).toBe(2048);
    expect(payload.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
  });

  it('tries once more after a timeout, then gives up', async () => {
    enable();
    const slow = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const once = vi.fn().mockRejectedValueOnce(slow).mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ subject: 'Hello', body: 'Hi Olivia,\n\nThanks.\n\nMaya' }) }] } }] }), { status: 200 }));
    vi.stubGlobal('fetch', once);
    expect((await draftEmailWithGemini(context))?.subject).toBe('Hello');
    expect(once).toHaveBeenCalledTimes(2);
    const never = vi.fn().mockRejectedValue(slow); vi.stubGlobal('fetch', never);
    await expect(draftEmailWithGemini(context)).rejects.toThrow();
    expect(never).toHaveBeenCalledTimes(2);
  });

  it('does not retry a quota error', async () => {
    enable(); const limited = vi.fn(async () => new Response('{}', { status: 429 })); vi.stubGlobal('fetch', limited);
    await expect(draftEmailWithGemini(context)).rejects.toThrow();
    expect(limited).toHaveBeenCalledOnce();
  });

  it('rejects an attachment claim that nothing supports', async () => {
    enable(); vi.stubGlobal('fetch', reply('Hi Olivia,\n\nAs requested, I have attached our price list.\n\nMaya'));
    await expect(draftEmailWithGemini(context)).rejects.toThrow('attachment');
  });

  it('rejects prices or discounts when the sender never promises them', async () => {
    enable(); vi.stubGlobal('fetch', reply('Hi Olivia,\n\nWe can offer 10% off if you order soon.\n\nMaya'));
    await expect(draftEmailWithGemini({ ...context, neverPromise: 'prices, discounts, delivery dates' })).rejects.toThrow('prices or discounts');
  });

  it('tells the model that a request is not a promise and nothing is attached', () => {
    const prompt = emailWritingInstruction();
    expect(prompt).toContain('A request from the contact is not a promise from us');
    expect(prompt).toContain('never write that anything is attached');
  });
});
