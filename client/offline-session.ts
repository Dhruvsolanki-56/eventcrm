import type { SessionData } from '../shared/contracts.js';

/**
 * A copy of who is signed in, kept on this device only so the installed app can open without a signal
 * and show the capture screen. It holds no password and no security token (the token field is blanked).
 * It is cleared on sign-out and whenever the server says the session has ended.
 */
const KEY = 'gather-session-cache';

export function cacheSession(session: SessionData) {
  try { window.localStorage.setItem(KEY, JSON.stringify({ ...session, csrfToken: '' })); } catch { /* Offline opening is only a convenience. */ }
}

export function clearCachedSession() {
  try { window.localStorage.removeItem(KEY); } catch { /* Nothing to clear. */ }
}

export function readCachedSession(): SessionData | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<SessionData>;
    if (typeof value?.user?.id !== 'string' || typeof value.workspace?.id !== 'string' || !Array.isArray(value.availableWorkspaces)) return null;
    return { ...(value as SessionData), csrfToken: '' };
  } catch { return null; }
}
