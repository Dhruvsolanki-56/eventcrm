import { afterEach, describe, expect, it, vi } from 'vitest';
import { draftEmailWithGemini, isGeminiEmailEnabled } from './gemini-email.js';
import type { EmailDraftContext } from './ai.js';
import { emailWritingInstruction } from './email-writing.js';

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
});
