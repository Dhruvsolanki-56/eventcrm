/**
 * Photos taken without a connection are kept on this device (IndexedDB) and uploaded later.
 * Each item keeps the same client scan id the normal upload uses, so retrying can never create a duplicate.
 */

export type QueuedPhoto = {
  clientScanId: string;
  workspaceId: string;
  file: Blob;
  fileName: string;
  fileType: string;
  source: 'camera' | 'gallery';
  /** The event chosen when the photo was taken: an event id, '' for "no event", or null when none was chosen. */
  eventId: string | null;
  clientOrder: number;
  createdAt: number;
};

const DB_NAME = 'gather-offline';
const STORE = 'photos';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Offline storage is not available here.')); return; }
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => { open.result.createObjectStore(STORE, { keyPath: 'clientScanId' }); };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('Offline storage could not be opened.'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Offline storage failed.'));
    });
  } finally { db.close(); }
}

/** Lets the rest of the app (the top-bar offline chip) know the waiting count changed. */
export const queueChangedEvent = 'gather:offline-queue-changed';
function announce() { window.dispatchEvent(new Event(queueChangedEvent)); }

/** Returns false when the photo could not be kept, so the caller can show an honest error instead. */
export async function saveQueuedPhoto(item: QueuedPhoto): Promise<boolean> {
  try { await withStore('readwrite', (store) => store.put(item)); announce(); return true; } catch { return false; }
}

export async function listQueuedPhotos(workspaceId: string): Promise<QueuedPhoto[]> {
  try {
    const all = await withStore<QueuedPhoto[]>('readonly', (store) => store.getAll());
    return all.filter((item) => item.workspaceId === workspaceId).sort((a, b) => a.clientOrder - b.clientOrder);
  } catch { return []; }
}

export async function removeQueuedPhoto(clientScanId: string): Promise<void> {
  try { await withStore('readwrite', (store) => store.delete(clientScanId)); announce(); } catch { /* Nothing more to clean up. */ }
}

/** True for a request that never reached the server (no connection, DNS, timeout), not for a server answer. */
export function isOfflineError(error: unknown): boolean {
  const issue = error as { status?: number; name?: string; message?: string } | null;
  if (issue && typeof issue.status === 'number') return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return issue?.name === 'TypeError' || /failed to fetch|networkerror|load failed|network request failed/i.test(issue?.message ?? '');
}
