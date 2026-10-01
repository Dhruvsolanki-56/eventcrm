import { describe, expect, it, vi } from 'vitest';
import { verifyLoginPassword } from './auth.js';

describe('login password verification', () => {
  it('performs password-hash work for an unknown account', async () => {
    const verify = vi.fn(async () => false);
    expect(await verifyLoginPassword(undefined, 'candidate-password', verify, 'dummy-hash')).toBe(false);
    expect(verify).toHaveBeenCalledWith('dummy-hash', 'candidate-password');
  });

  it('performs password-hash work for a disabled account but never authenticates it', async () => {
    const verify = vi.fn(async () => true);
    expect(await verifyLoginPassword({ password_hash: 'stored-hash', disabled_at: 'disabled' }, 'password', verify, 'dummy-hash')).toBe(false);
    expect(verify).toHaveBeenCalledWith('stored-hash', 'password');
  });

  it('accepts only an enabled account with a matching password', async () => {
    const verify = vi.fn(async () => true);
    expect(await verifyLoginPassword({ password_hash: 'stored-hash', disabled_at: null }, 'password', verify, 'dummy-hash')).toBe(true);
    expect(verify).toHaveBeenCalledWith('stored-hash', 'password');
  });
});
