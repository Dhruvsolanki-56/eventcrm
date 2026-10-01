import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { EmailDraftOutputSchema, FollowUpSuggestionOutputSchema, isAIProviderEnabled, parseModelJson } from './ai.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('provider output checks', () => {
  it('requires explicit provider mode and a key before enabling AI', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubEnv('AI_MODE', 'off');
    expect(isAIProviderEnabled()).toBe(false);
    vi.stubEnv('AI_MODE', 'provider');
    expect(isAIProviderEnabled()).toBe(true);
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(isAIProviderEnabled()).toBe(false);
  });
  it('accepts a bounded JSON email draft, including a JSON code fence', () => {
    expect(parseModelJson('```json\n{"subject":"Following up","body":"Hello there."}\n```', EmailDraftOutputSchema))
      .toEqual({ subject: 'Following up', body: 'Hello there.' });
  });

  it('rejects extra email fields and overlong or empty values', () => {
    expect(() => parseModelJson('{"subject":"Hi","body":"Hello","send":true}', EmailDraftOutputSchema)).toThrow();
    expect(() => parseModelJson('{"subject":"","body":"Hello"}', EmailDraftOutputSchema)).toThrow();
    expect(() => parseModelJson(JSON.stringify({ subject: 'Hi', body: 'x'.repeat(8001) }), EmailDraftOutputSchema)).toThrow();
  });

  it('rejects unsafe follow-up offsets and extra fields rather than accepting actions', () => {
    expect(FollowUpSuggestionOutputSchema.safeParse({ daysFromNow: 31, note: 'Send a price quote', reason: 'Asked', action: 'send_email' }).success).toBe(false);
    expect(parseModelJson('{"daysFromNow":2,"note":"Share the sample details","reason":"They asked about samples."}', FollowUpSuggestionOutputSchema))
      .toEqual({ daysFromNow: 2, note: 'Share the sample details', reason: 'They asked about samples.' });
  });

  it('turns a provider request timeout into a bounded read failure without exposing the provider message', async () => {
    vi.stubEnv('AI_MODE', 'provider');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-provider-key');
    const fetch = vi.fn(async () => {
      const error = new Error('timeout for private.lead@example.com');
      error.name = 'AbortError';
      throw error;
    });
    vi.stubGlobal('fetch', fetch);
    vi.resetModules();

    const { readCard } = await import('./ai.js');
    await expect(readCard(resolve('public/demo/sample-card.png'), 'image/png')).rejects.toThrow('Request timed out.');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
