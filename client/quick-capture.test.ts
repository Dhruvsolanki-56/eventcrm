import { describe, expect, it } from 'vitest';
import { appendText, applyIdea, fieldsNeedingLook, productChips, toggleSentence } from './quick-capture.js';

describe('tap-to-capture note helpers', () => {
  it('adds a tapped sentence after existing text and removes it on a second tap', () => {
    const once = toggleSentence('Met at the booth', 'Asked for samples.');
    expect(once).toBe('Met at the booth. Asked for samples.');
    expect(toggleSentence(once, 'Asked for samples.')).toBe('Met at the booth.');
    expect(toggleSentence('', 'Asked for a quote.')).toBe('Asked for a quote.');
    expect(toggleSentence(toggleSentence('', 'Asked for a quote.'), 'Asked for a quote.')).toBe('');
  });

  it('never grows a note past the limit', () => {
    const long = 'x'.repeat(3995);
    expect(toggleSentence(long, 'Asked for samples.')).toBe(long);
    expect(appendText(long, 'a longer spoken sentence').length).toBe(4000);
  });

  it('appends spoken text on a new line and ignores empty speech', () => {
    expect(appendText('Asked for samples.', ' Wants them by May. ')).toBe('Asked for samples.\nWants them by May.');
    expect(appendText('Keep this', '   ')).toBe('Keep this');
  });

  it('builds product chips without duplicates or blanks', () => {
    expect(productChips(['Mailer boxes', ' ', 'Mailer boxes', 'Tape'])).toEqual([
      { label: 'Mailer boxes', sentence: 'Asked about Mailer boxes.' },
      { label: 'Tape', sentence: 'Asked about Tape.' },
    ]);
  });

  it('tapped note ideas replace an earlier idea but keep typed words', () => {
    const ideas = ['Check in', 'Share samples'];
    expect(applyIdea('', 'Check in', ideas)).toBe('Check in');
    expect(applyIdea('Check in', 'Share samples', ideas)).toBe('Share samples');
    expect(applyIdea('Ask about lead times', 'Check in', ideas)).toBe('Ask about lead times; Check in');
    expect(applyIdea('Check in with Tessa', 'Check in', ideas)).toBe('Check in with Tessa');
  });

  it('lists review fields that are flagged or empty', () => {
    const keys = ['name', 'title', 'email'] as const;
    expect(fieldsNeedingLook(keys, { name: 'Ava', title: '', email: 'a@b.co' }, ['email'])).toEqual(['title', 'email']);
    expect(fieldsNeedingLook(keys, { name: 'Ava', title: 'CEO', email: 'a@b.co' }, [])).toEqual([]);
  });
});
