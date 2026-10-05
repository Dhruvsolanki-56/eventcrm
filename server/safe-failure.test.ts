import { describe, expect, it } from 'vitest';
import { safeFailureCode, safeJobFailureMessage, serverCardReaderUnavailableMessage, userMessage } from './safe-failure.js';

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

describe('messages shown to people', () => {
  const fallback = 'That did not work.';
  it('shows our own rule messages', () => {
    expect(userMessage(new Error('Choose an event you can access.'), fallback)).toBe('Choose an event you can access.');
    const denied = Object.assign(new Error('You do not have access to this person.'), { name: 'AccessDeniedError' });
    expect(userMessage(denied, fallback)).toBe('You do not have access to this person.');
  });
  it('never shows database, file-system or library details', () => {
    const database = Object.assign(new Error('UNIQUE constraint failed: emails.unsubscribe_token_hash'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
    const file = Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\srv\\uploads\\w1\\voice\\a.webm'"), { code: 'ENOENT', syscall: 'open', errno: -2 });
    expect(userMessage(database, fallback)).toBe(fallback);
    expect(userMessage(file, fallback)).toBe(fallback);
    expect(userMessage(new TypeError("Cannot read properties of undefined (reading 'id')"), fallback)).toBe(fallback);
    expect(userMessage(new RangeError('Invalid time value'), fallback)).toBe(fallback);
    expect(userMessage('plain string', fallback)).toBe(fallback);
    expect(userMessage(new Error('   '), fallback)).toBe(fallback);
  });
});
