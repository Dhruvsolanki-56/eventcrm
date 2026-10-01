import type { SessionData } from '../shared/contracts.js';

export type ApiError = Error & { status?: number; code?: string; fields?: Array<{ path: string; message: string }> };

export async function request<T>(path: string, init: RequestInit = {}, options: { csrfToken?: string; workspaceId?: string } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes((init.method ?? 'GET').toUpperCase()) && options.csrfToken) {
    headers.set('X-CSRF-Token', options.csrfToken);
  }
  if (options.workspaceId) headers.set('X-Workspace-Id', options.workspaceId);
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = new Error(typeof payload.message === 'string' ? payload.message : 'That did not work. Try again.') as ApiError;
    error.status = response.status;
    error.code = typeof payload.code === 'string' ? payload.code : undefined;
    error.fields = Array.isArray(payload.fields) ? payload.fields as ApiError['fields'] : undefined;
    throw error;
  }
  return payload as T;
}

export async function requestDownload(path: string, workspaceId: string) {
  const response = await fetch(path, {
    headers: { 'X-Workspace-Id': workspaceId },
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const error = new Error(typeof payload.message === 'string' ? payload.message : 'The file could not be downloaded.') as ApiError;
    error.status = response.status;
    error.code = typeof payload.code === 'string' ? payload.code : undefined;
    throw error;
  }
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const fileName = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? 'gather-export';
  return { blob: await response.blob(), fileName };
}

export function saveDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let csrfTokenRequest: Promise<string> | undefined;
export function getCsrfToken() {
  if (!csrfTokenRequest) {
    csrfTokenRequest = request<{ csrfToken: string }>('/api/auth/csrf')
      .then((response) => response.csrfToken)
      .finally(() => { csrfTokenRequest = undefined; });
  }
  return csrfTokenRequest;
}

export async function getSession(workspaceId?: string) {
  const result = await request<SessionData | { authenticated: false }>('/api/auth/me', {}, { workspaceId });
  return 'authenticated' in result ? null : result;
}
