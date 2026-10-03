import { describe, expect, it } from 'vitest';
import { safeFailureCode, safeJobFailureMessage, serverCardReaderUnavailableMessage } from './safe-failure.js';

describe('safe background failure details', () => {
  it('keeps provider messages, recipients, and credentials out of stored and logged errors', () => {
    const providerError = Object.assign(new Error('550 rejected private.lead@example.com with password secret-value'), { code: 'EENVELOPE' });
    expect(safeJobFailureMessage('email_send')).toBe('The mail server could not accept this message.');
    expect(safeFailureCode(providerError)).toBe('EENVELOPE');
    expect(JSON.stringify({ error: safeJobFailureMessage('email_send'), code: safeFailureCode(providerError) })).not.toMatch(/private\.lead|secret-value|550 rejected/);
  });

  it('logs only allow-listed provider codes and gives each job a safe explanation', () => {
    expect(safeFailureCode(Object.assign(new Error('internal detail'), { code: 'SENSITIVE:person@example.com' }))).toBe('PROVIDER_ERROR');
    expect(safeFailureCode(new Error('contact data in provider response'))).toBe('PROVIDER_ERROR');
    expect(safeJobFailureMessage('card_read')).toMatch(/on-device reading/);
    expect(safeJobFailureMessage('email_draft')).toMatch(/saved and unsent/);
    expect(safeJobFailureMessage('unexpected')).toMatch(/contact your admin/);
  });

  it('explains that browser reading is still available when no server reader is configured', () => {
    expect(serverCardReaderUnavailableMessage).toMatch(/on-device reading/);
    expect(serverCardReaderUnavailableMessage).not.toMatch(/automatic reading is not set up/i);
    expect(safeJobFailureMessage('card_read')).toMatch(/on-device reading/);
  });
});
