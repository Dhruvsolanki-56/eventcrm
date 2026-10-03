import { describe, expect, it } from 'vitest';
import { needsCardAiFallback } from './card-ocr.js';

describe('card AI fallback', () => {
  it('does not wait for a remote read just because locally extracted details need review', () => {
    expect(needsCardAiFallback({ name: 'Olivia Anderson', email: 'olivia@example.com', phone: '' })).toBe(false);
    expect(needsCardAiFallback({ name: 'Olivia Anderson', email: '', phone: '+1 234 567 8900' })).toBe(false);
  });

  it('asks for help only when the name or both contact methods are missing', () => {
    expect(needsCardAiFallback(null)).toBe(true);
    expect(needsCardAiFallback({ name: '', email: 'olivia@example.com', phone: '' })).toBe(true);
    expect(needsCardAiFallback({ name: 'Olivia Anderson', email: '', phone: '' })).toBe(true);
  });
});
