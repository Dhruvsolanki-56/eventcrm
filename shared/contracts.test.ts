import { describe, expect, it } from 'vitest';
import { CardReadOutputSchema, SaveLeadSchema, safeWebsiteHref, statusWords, WebsiteSchema } from './contracts.js';

describe('capture data contracts', () => {
  it('fills optional card fields with explicit empty values and marks only known uncertainty', () => {
    expect(CardReadOutputSchema.parse({ name: 'Ari Patel', uncertain: ['company'] })).toEqual({
      name: 'Ari Patel', title: '', company: '', email: '', phone: '', website: '', products: [], topics: [], uncertain: ['company'],
    });
    expect(CardReadOutputSchema.safeParse({ name: 'Ari', uncertain: ['address'] }).success).toBe(false);
  });

  it('accepts only the user-confirmed contact fields and optional next step', () => {
    const parsed = SaveLeadSchema.parse({ name: '  Ari Patel ', company: 'Sora Supply', email: '', phone: '+1 415 555 0125', note: 'Asked about recyclable cartons.', followUpDate: null, productIds: ['carton'] });
    expect(parsed.name).toBe('Ari Patel');
    expect(parsed.followUpDate).toBeNull();
    expect(parsed.productIds).toEqual(['carton']);
    expect(SaveLeadSchema.safeParse({ name: 'Ari', autoSendEmail: true }).success).toBe(false);
  });

  it('uses wording that does not imply mail delivery or successful OCR', () => {
    expect(statusWords.email.sent).toMatch(/mail server/i);
    expect(statusWords.email.sent).toMatch(/delivery is not confirmed/i);
    expect(statusWords.scan.failed).toMatch(/couldn't read/i);
    expect(statusWords.scan.queued).toMatch(/reading/i);
  });

  it('accepts only safe external website protocols for contact data and links', () => {
    expect(WebsiteSchema.safeParse('acme.example/path').success).toBe(true);
    expect(CardReadOutputSchema.safeParse({ website: 'javascript:alert(1)' }).success).toBe(false);
    expect(SaveLeadSchema.safeParse({ name: 'Ari Patel', website: 'data:text/html,unsafe' }).success).toBe(false);
    expect(WebsiteSchema.safeParse('https://user:secret@acme.example').success).toBe(false);
    expect(safeWebsiteHref('acme.example/path')).toBe('https://acme.example/path');
    expect(safeWebsiteHref('javascript:alert(1)')).toBeNull();
    expect(safeWebsiteHref('data:text/html,unsafe')).toBeNull();
  });
});
