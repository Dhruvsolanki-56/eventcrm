import { describe, expect, it } from 'vitest';
import { composeTemplateEmail, type TemplateEmailInput } from './email-template.js';

const base: TemplateEmailInput = {
  firstName: 'Tessa', tone: 'Friendly', variant: 'first', eventName: 'Pacific Packaging Expo', topic: '',
  productsOfInterest: [], requestedWrittenFollowUp: false, signature: 'Maya',
};

describe('template email fallback', () => {
  it('uses the event, products and topic the team saved', () => {
    const email = composeTemplateEmail({ ...base, topic: 'short-run sample boxes.', productsOfInterest: ['Mailer boxes', 'Tape'] });
    expect(email.subject).toBe('Great to meet you at Pacific Packaging Expo');
    expect(email.body).toContain('Hi Tessa,');
    expect(email.body).toContain('It was great meeting you at Pacific Packaging Expo. I wanted to pick up on short-run sample boxes.');
    expect(email.body).toMatch(/Best,\nMaya$/);
  });

  it('mentions products when there is no topic, and drops missing pieces cleanly', () => {
    const withProducts = composeTemplateEmail({ ...base, eventName: null, productsOfInterest: ['Mailer boxes', 'Tape', 'Labels', 'Extra'] });
    expect(withProducts.subject).toBe('Following up on Mailer boxes');
    expect(withProducts.body).toContain('I noted your interest in Mailer boxes, Tape and Labels.');
    const bare = composeTemplateEmail({ ...base, eventName: null });
    expect(bare.subject).toBe('Following up on our conversation');
    expect(bare.body).not.toMatch(/undefined|null|\{|\}/);
    expect(bare.body).toContain('It was great talking with you.');
  });

  it.each(['Friendly', 'Professional', 'Short'] as const)('writes a distinct %s version for each variant', (tone) => {
    const first = composeTemplateEmail({ ...base, tone });
    const alternate = composeTemplateEmail({ ...base, tone, variant: 'alternate' });
    const written = composeTemplateEmail({ ...base, tone, requestedWrittenFollowUp: true });
    expect(new Set([first.body, alternate.body, written.body]).size).toBe(3);
    expect(written.subject).toBe('Following up on your project request');
    expect(first.body.startsWith(tone === 'Professional' ? 'Hello Tessa,' : 'Hi Tessa,')).toBe(true);
    expect(first.body).toContain({ Friendly: 'Best,', Professional: 'Kind regards,', Short: 'Thanks,' }[tone]);
  });

  it('never invents commitments, prices or offers', () => {
    for (const tone of ['Friendly', 'Professional', 'Short'] as const) {
      for (const variant of ['first', 'alternate'] as const) {
        const { body } = composeTemplateEmail({ ...base, tone, variant, topic: 'custom boxes' });
        expect(body).not.toMatch(/\b(?:price|quote|discount|promise|guarantee|attached|enclosed|offer)\b/i);
      }
    }
  });

  it('does not double a sign-off the saved signature already has', () => {
    const email = composeTemplateEmail({ ...base, signature: 'Kind regards,\nMaya Chen\nNorthstar Packaging' });
    expect(email.body.match(/regards/gi)).toHaveLength(1);
    expect(email.body.endsWith('Kind regards,\nMaya Chen\nNorthstar Packaging')).toBe(true);
  });
});
