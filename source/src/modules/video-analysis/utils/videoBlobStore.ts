import { PlayerVideo } from "../models/Video";

// On-device video persistence.
//
// Video files are far too large for localStorage (~5MB, string-only), so the
// raw bytes live in IndexedDB, which stores Blobs natively and scales to the
// browser's disk quota. This keeps videos fully on the machine — nothing is
// uploaded to a backend. The interface is intentionally async and minimal so a
// future cloud-backed implementation (e.g. Google Drive) can satisfy the same
// contract without changing the workspace internals.

const DB_NAME = "clarity-video-analysis";
const DB_VERSION = 1;
const STORE_NAME = "videos";

export interface StoredVideo {
  video: PlayerVideo;
  blob: Blob;
}

export interface VideoBlobStore {
  putVideo(slotKey: string, video: PlayerVideo, blob: Blob): Promise<void>;
  getVideo(slotKey: string): Promise<StoredVideo | null>;
  removeVideo(slotKey: string): Promise<void>;
}

export const buildVideoSlotKey = (
  playerId: string,
  side: string,
  lessonId?: string
) => `${playerId}.${lessonId ?? "default"}.${side}`;

const isIndexedDbAvailable = () =>
  typeof indexedDB !== "undefined" && indexedDB !== null;

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const runRequest = <T>(
  mode: IDBTransactionMode,
  operate: (store: IDBObjectStore) => IDBRequest
): Promise<T> =>
  openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        const request = operate(store);
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error);
        tx.onerror = () => reject(tx.error);
        tx.oncomplete = () => db.close();
      })
  );

/**
 * Creates the IndexedDB-backed video store, or returns null when IndexedDB is
 * unavailable (e.g. private-mode restrictions or non-browser environments). A
 * null store degrades gracefully: videos simply won't persist across reloads.
 */
export const createIndexedDbVideoStore = (): VideoBlobStore | null => {
  if (!isIndexedDbAvailable()) return null;

  return {
    async putVideo(slotKey, video, blob) {
      await runRequest("readwrite", (store) =>
        store.put({ video, blob }, slotKey)
      );
    },
    async getVideo(slotKey) {
      const result = await runRequest<StoredVideo | undefined>(
        "readonly",
        (store) => store.get(slotKey)
      );
      if (!result || !(result.blob instanceof Blob) || !result.video) {
        return null;
      }
      return result;
    },
    async removeVideo(slotKey) {
      await runRequest("readwrite", (store) => store.delete(slotKey));
    },
  };
};

/**
 * Asks the browser to keep on-device storage durable so it is not evicted
 * automatically when disk space runs low. Best-effort; resolves false when the
 * API is unavailable or the request is declined.
 */
export const requestPersistentStorage = async (): Promise<boolean> => {
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.storage &&
      typeof navigator.storage.persist === "function"
    ) {
      return await navigator.storage.persist();
    }
  } catch {
    // Ignore; persistence is a best-effort optimization.
  }
  return false;
};
