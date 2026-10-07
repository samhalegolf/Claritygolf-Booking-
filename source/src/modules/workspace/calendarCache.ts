/**
 * The coach calendar as it last arrived, kept on this device so the workspace
 * can draw at once on the next visit while the live read is still on its way.
 *
 * What is stored is the GET /api/calendar-state answer (with the items as last
 * saved), one entry per business, keyed by the session's account id. It is a
 * picture, never a source of truth: useWorkspaceSync shows it without marking
 * anything as persisted, keeps autosave off, and folds any edits made in the
 * meantime onto the live calendar when it lands.
 *
 * It holds client names and contact details, so logout deletes it, and an
 * entry older than MAX_AGE_MS is treated as absent. Every call fails quietly:
 * a private window, a full disk or a browser without IndexedDB simply means
 * the page waits for the network as it always did.
 */

const DB_NAME = "clarity-calendar-cache";
const STORE = "calendar";
// Bumped when the stored shape changes; older entries are ignored.
const VERSION = 1;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type CachedCalendar = {
  version: number;
  accountId: string;
  savedAt: number;
  data: Record<string, unknown>;
};

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const request = body(db.transaction(STORE, mode).objectStore(STORE));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export async function readCachedCalendar(accountId: string): Promise<Record<string, unknown> | null> {
  if (!accountId) return null;
  const entry = (await run("readonly", (store) => store.get(accountId))) as CachedCalendar | null;
  if (
    !entry ||
    entry.version !== VERSION ||
    entry.accountId !== accountId ||
    Date.now() - entry.savedAt > MAX_AGE_MS ||
    !entry.data ||
    !Array.isArray(entry.data.items)
  ) {
    return null;
  }
  return entry.data;
}

export function writeCachedCalendar(accountId: string, data: Record<string, unknown>) {
  if (!accountId || !Array.isArray(data?.items)) return;
  const entry: CachedCalendar = { version: VERSION, accountId, savedAt: Date.now(), data };
  void run("readwrite", (store) => store.put(entry, accountId));
}

/** Logout: the next person at this device may run a different business. */
export function clearCalendarCache() {
  void run("readwrite", (store) => store.clear());
}
