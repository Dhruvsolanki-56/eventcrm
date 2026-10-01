import { describe, expect, it } from 'vitest';
import { extractCardFields } from '../client/card-ocr.js';

describe('card text extraction', () => {
  it('extracts clear contact fields without claiming certainty', () => {
    const result = extractCardFields('ACME PACKAGING\nDemo Contact\nPackaging Buyer\ndemo.contact@sample.invalid\n+1 415 555 0199\nhttps://acme.co');
    expect(result).toMatchObject({
      name: 'Demo Contact', title: 'Packaging Buyer', company: 'ACME PACKAGING',
      email: 'demo.contact@sample.invalid', phone: '+1 415 555 0199', website: 'acme.co',
    });
    expect(result.uncertain).toEqual(['name', 'title', 'company', 'email', 'phone', 'website']);
  });

  it('does not invent a name or company from ambiguous text', () => {
    const result = extractCardFields('Customer success\ncontact@example.com\n555 987 6543');
    expect(result.name).toBe('');
    expect(result.company).toBe('');
    expect(result.email).toBe('contact@example.com');
  });
});
