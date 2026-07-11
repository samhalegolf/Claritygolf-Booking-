import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VideoAnalysis } from "../models/Analysis";
import type { PlayerVideo } from "../models/Video";
import type { ComparisonWorkspaceState } from "./localPersistence";
import {
  createIndexedDbSavedVideoLibrary,
  saveSavedVideoToCloud,
  type SavedVideoItem,
} from "./savedVideoLibrary";
import { buildVideoSlotKey, createIndexedDbVideoStore } from "./videoBlobStore";
import {
  VIDEO_ANALYSIS_DB_NAME,
  VIDEO_ANALYSIS_DB_STORES,
  VIDEO_ANALYSIS_DB_VERSION,
  VideoAnalysisIndexedDbError,
  getVideoAnalysisDatabaseStoreNames,
  openIndexedDbDatabase,
  openVideoAnalysisDatabase,
} from "./videoAnalysisDatabase";

type StoreSeed = {
  keyPath?: string;
  records?: Array<[IDBValidKey, unknown]>;
};

type DatabaseState = {
  name: string;
  version: number;
  stores: Map<string, { keyPath?: string; records: Map<IDBValidKey, unknown> }>;
};

class FakeRequest<T = unknown> {
  result!: T;
  error: unknown = null;
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
}

class FakeOpenRequest<T = unknown> extends FakeRequest<T> {
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null = null;
  onblocked: ((event: Event) => void) | null = null;
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: unknown = null;
  private pending = 0;
  private failed = false;

  constructor(private readonly state: DatabaseState) {}

  objectStore(name: string) {
    const store = this.state.stores.get(name);
    if (!store) {
      throw new DOMException(`Object store ${name} was not found.`, "NotFoundError");
    }
    return new FakeObjectStore(store, this);
  }

  trackRequest() {
    this.pending += 1;
  }

  finishRequest() {
    this.pending -= 1;
    if (this.pending === 0 && !this.failed) {
      queueMicrotask(() => this.oncomplete?.());
    }
  }

  fail(error: unknown) {
    this.failed = true;
    this.error = error;
    queueMicrotask(() => this.onerror?.());
  }
}

class FakeObjectStore {
  constructor(
    private readonly state: { keyPath?: string; records: Map<IDBValidKey, unknown> },
    private readonly transaction: FakeTransaction
  ) {}

  get(key: IDBValidKey) {
    return this.schedule(() => this.state.records.get(key));
  }

  getAll() {
    return this.schedule(() => Array.from(this.state.records.values()));
  }

  put(value: any, key?: IDBValidKey) {
    return this.schedule(() => {
      const recordKey = key ?? (this.state.keyPath ? value?.[this.state.keyPath] : undefined);
      if (recordKey === undefined || recordKey === null) {
        throw new DOMException("IndexedDB record key was missing.", "DataError");
      }
      this.state.records.set(recordKey, value);
      return recordKey;
    });
  }

  delete(key: IDBValidKey) {
    return this.schedule(() => {
      this.state.records.delete(key);
      return undefined;
    });
  }

  openCursor() {
    const request = new FakeRequest<any>();
    const entries = Array.from(this.state.records.entries());
    let index = 0;
    this.transaction.trackRequest();

    const emit = () => {
      queueMicrotask(() => {
        if (index >= entries.length) {
          request.result = null;
          request.onsuccess?.({} as Event);
          this.transaction.finishRequest();
          return;
        }
        const [key, value] = entries[index];
        request.result = {
          key,
          value,
          continue: () => {
            index += 1;
            emit();
          },
        };
        request.onsuccess?.({} as Event);
      });
    };

    emit();
    return request as IDBRequest;
  }

  private schedule<T>(callback: () => T) {
    const request = new FakeRequest<T>();
    this.transaction.trackRequest();
    queueMicrotask(() => {
      try {
        request.result = callback();
        request.onsuccess?.({} as Event);
        this.transaction.finishRequest();
      } catch (error) {
        request.error = error;
        request.onerror?.({} as Event);
        this.transaction.fail(error);
      }
    });
    return request as IDBRequest<T>;
  }
}

class FakeDatabase {
  constructor(private readonly state: DatabaseState) {}

  get name() {
    return this.state.name;
  }

  get version() {
    return this.state.version;
  }

  get objectStoreNames() {
    const state = this.state;
    return {
      contains: (name: string) => state.stores.has(name),
      item: (index: number) => Array.from(state.stores.keys())[index] || null,
      get length() {
        return state.stores.size;
      },
    } as DOMStringList;
  }

  createObjectStore(name: string, options: IDBObjectStoreParameters = {}) {
    if (!this.state.stores.has(name)) {
      this.state.stores.set(name, {
        keyPath: typeof options.keyPath === "string" ? options.keyPath : undefined,
        records: new Map(),
      });
    }
    return new FakeObjectStore(
      this.state.stores.get(name)!,
      new FakeTransaction(this.state)
    ) as unknown as IDBObjectStore;
  }

  transaction(storeName: string, _mode?: IDBTransactionMode) {
    return new FakeTransaction(this.state) as unknown as IDBTransaction;
  }

  close() {}
}

class FakeIndexedDbFactory {
  readonly openCalls: Array<{ databaseName: string; requestedVersion?: number }> = [];
  private readonly states = new Map<string, DatabaseState>();

  seed(databaseName: string, version: number, stores: Record<string, StoreSeed>) {
    this.states.set(databaseName, {
      name: databaseName,
      version,
      stores: new Map(
        Object.entries(stores).map(([name, seed]) => [
          name,
          {
            keyPath: seed.keyPath,
            records: new Map(seed.records || []),
          },
        ])
      ),
    });
  }

  state(databaseName = VIDEO_ANALYSIS_DB_NAME) {
    const state = this.states.get(databaseName);
    assert.ok(state, `Expected fake database ${databaseName} to exist.`);
    return state;
  }

  open(databaseName: string, requestedVersion?: number) {
    const request = new FakeOpenRequest<FakeDatabase>();
    this.openCalls.push({ databaseName, requestedVersion });

    queueMicrotask(() => {
      let state = this.states.get(databaseName);
      const version = requestedVersion ?? state?.version ?? 1;

      if (state && version < state.version) {
        request.error = new DOMException(
          `The requested version (${version}) is less than the existing version (${state.version}).`,
          "VersionError"
        );
        request.onerror?.({} as Event);
        return;
      }

      const oldVersion = state?.version ?? 0;
      const needsUpgrade = !state || version > state.version;
      if (!state) {
        state = {
          name: databaseName,
          version,
          stores: new Map(),
        };
        this.states.set(databaseName, state);
      }

      const database = new FakeDatabase(state);
      request.result = database;
      if (needsUpgrade) {
        state.version = version;
        request.onupgradeneeded?.({
          oldVersion,
          newVersion: version,
          target: request,
        } as unknown as IDBVersionChangeEvent);
      }
      request.onsuccess?.({} as Event);
    });

    return request as unknown as IDBOpenDBRequest;
  }

  async databases() {
    return Array.from(this.states.values()).map((state) => ({
      name: state.name,
      version: state.version,
    }));
  }
}

const restoreProperty = (
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined
) => {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    Reflect.deleteProperty(target, key);
  }
};

const installFakeIndexedDb = (factory = new FakeIndexedDbFactory()) => {
  const indexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const localStorageMap = new Map<string, string>([["clarityDeviceId", "device-1"]]);

  Object.defineProperty(globalThis, "indexedDB", {
    value: factory,
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: {
      indexedDB: factory,
      localStorage: {
        getItem: (key: string) => localStorageMap.get(key) || null,
        setItem: (key: string, value: string) => localStorageMap.set(key, value),
      },
      navigator: { userAgent: "node-test", platform: "test-platform" },
    },
    configurable: true,
  });

  return {
    factory,
    restore: () => {
      restoreProperty(globalThis, "indexedDB", indexedDbDescriptor);
      restoreProperty(globalThis, "window", windowDescriptor);
    },
  };
};

const workspaceSnapshot: ComparisonWorkspaceState = {
  version: 1,
  mode: "single",
  activeSide: "left",
  savedVideoIds: {},
  linkedPlayback: false,
  focusWindowOpen: false,
  focusWindowMode: "area",
  focusWindowSide: "left",
  focusAreaRect: null,
};

const video: PlayerVideo = {
  id: "transient-left",
  playerId: "player-1",
  lessonId: "lesson-1",
  sourceUrl: "blob:transient",
  title: "swing.mp4",
  createdAt: "2026-07-10T00:00:00.000Z",
  duration: 12,
  width: 1280,
  height: 720,
};

const analysisSnapshot: VideoAnalysis = {
  id: "analysis-1",
  playerId: "player-1",
  lessonId: "lesson-1",
  videoId: "transient-left",
  videoMeta: {
    title: "swing.mp4",
    duration: 12,
    width: 1280,
    height: 720,
  },
  drawings: [],
  markers: [],
  notes: [],
  focusViews: [],
  focusSnapshots: [],
  narrationRefs: [],
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
};

const sourceBlob = () => new Blob(["video-bytes"], { type: "video/mp4" });

const savedItem = (savedVideoId: string): SavedVideoItem => ({
  version: 1,
  savedVideoId,
  playerId: "player-1",
  lessonId: "lesson-1",
  analysisId: "analysis-1",
  title: "Existing swing",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
  sourceSide: "left",
  source: {
    originalFileName: "existing.mp4",
    mimeType: "video/mp4",
    sizeBytes: sourceBlob().size,
  },
  local: {
    status: "available",
    blobRecordId: savedVideoId,
  },
  cloud: { status: "not-uploaded" },
  analysisSnapshot,
  workspaceSnapshot: {
    ...workspaceSnapshot,
    savedVideoIds: { left: savedVideoId },
  },
});

const expectedStoreNames = () => getVideoAnalysisDatabaseStoreNames().sort();

const seedCurrentStores = (item?: SavedVideoItem): Record<string, StoreSeed> => ({
  [VIDEO_ANALYSIS_DB_STORES.transientVideos]: {
    records: [[buildVideoSlotKey("player-1", "left", "lesson-1"), { video, blob: sourceBlob() }]],
  },
  [VIDEO_ANALYSIS_DB_STORES.savedVideoItems]: {
    keyPath: "savedVideoId",
    records: item ? [[item.savedVideoId, item]] : [],
  },
  [VIDEO_ANALYSIS_DB_STORES.savedVideoBlobs]: {
    keyPath: "savedVideoId",
    records: item
      ? [[item.savedVideoId, {
          savedVideoId: item.savedVideoId,
          blob: sourceBlob(),
          sizeBytes: sourceBlob().size,
          mimeType: "video/mp4",
          updatedAt: "2026-07-10T00:00:00.000Z",
        }]]
      : [],
  },
  [VIDEO_ANALYSIS_DB_STORES.managedLocalLibrary]: {},
});

describe("video analysis IndexedDB schema", () => {
  it("creates the current schema in a fresh browser database", async () => {
    const { factory, restore } = installFakeIndexedDb();
    try {
      const db = await openVideoAnalysisDatabase("test.fresh-schema");
      db.close();

      const state = factory.state();
      assert.equal(state.version, VIDEO_ANALYSIS_DB_VERSION);
      assert.deepEqual(Array.from(state.stores.keys()).sort(), expectedStoreNames());
      assert.equal(factory.openCalls.every((call) => call.requestedVersion === VIDEO_ANALYSIS_DB_VERSION), true);
    } finally {
      restore();
    }
  });

  for (const version of [1, 2]) {
    it(`upgrades an existing version ${version} database forward without losing records`, async () => {
      const { factory, restore } = installFakeIndexedDb();
      const slotKey = buildVideoSlotKey("player-1", "left", "lesson-1");
      factory.seed(VIDEO_ANALYSIS_DB_NAME, version, {
        [VIDEO_ANALYSIS_DB_STORES.transientVideos]: {
          records: [[slotKey, { video, blob: sourceBlob() }]],
        },
      });

      try {
        const db = await openVideoAnalysisDatabase(`test.upgrade-v${version}`);
        db.close();

        const state = factory.state();
        assert.equal(state.version, VIDEO_ANALYSIS_DB_VERSION);
        assert.deepEqual(Array.from(state.stores.keys()).sort(), expectedStoreNames());
        assert.equal(
          (state.stores.get(VIDEO_ANALYSIS_DB_STORES.transientVideos)?.records.get(slotKey) as any)?.video.id,
          video.id
        );
      } finally {
        restore();
      }
    });
  }

  it("opens an existing version 3 database and saves without VersionError", async () => {
    const { factory, restore } = installFakeIndexedDb();
    const existing = savedItem("saved-video-existing");
    factory.seed(VIDEO_ANALYSIS_DB_NAME, VIDEO_ANALYSIS_DB_VERSION, seedCurrentStores(existing));

    try {
      const transientStore = createIndexedDbVideoStore();
      const savedStore = createIndexedDbSavedVideoLibrary();
      assert.ok(transientStore);
      assert.ok(savedStore);

      await transientStore.putVideo(buildVideoSlotKey("player-1", "left", "lesson-1"), video, sourceBlob());
      const item = await savedStore.saveItem({
        playerId: "player-1",
        lessonId: "lesson-1",
        sourceSide: "left",
        sourceVideo: video,
        sourceBlob: sourceBlob(),
        analysisSnapshot,
        workspaceSnapshot,
      });
      const items = await savedStore.listItems();

      assert.equal(factory.state().version, VIDEO_ANALYSIS_DB_VERSION);
      assert.equal(factory.openCalls.every((call) => call.requestedVersion === VIDEO_ANALYSIS_DB_VERSION), true);
      assert.equal(item.local.status, "available");
      assert.equal((await savedStore.getBlob(item.savedVideoId))?.size, sourceBlob().size);
      assert.equal(items.some((entry) => entry.savedVideoId === existing.savedVideoId), true);
    } finally {
      restore();
    }
  });

  it("keeps a successful Local Storage save intact when Clarity Cloud fails later", async () => {
    const { restore } = installFakeIndexedDb();
    const originalFetch = globalThis.fetch;
    try {
      const savedStore = createIndexedDbSavedVideoLibrary();
      assert.ok(savedStore);
      const item = await savedStore.saveItem({
        playerId: "player-1",
        lessonId: "lesson-1",
        sourceSide: "left",
        sourceVideo: video,
        sourceBlob: sourceBlob(),
        analysisSnapshot,
        workspaceSnapshot,
      });
      assert.equal(item.local.status, "available");
      assert.equal((await savedStore.getBlob(item.savedVideoId))?.size, sourceBlob().size);

      globalThis.fetch = async () =>
        Response.json(
          {
            ok: false,
            error: "DRIVE_UPLOAD_SESSION_FAILED",
            message: "Clarity Cloud is unavailable.",
          },
          { status: 503 }
        );

      await assert.rejects(() => saveSavedVideoToCloud(item.savedVideoId, savedStore));

      const afterCloudFailure = await savedStore.getItem(item.savedVideoId);
      assert.equal(afterCloudFailure?.local.status, "available");
      assert.equal(afterCloudFailure?.cloud?.status, "failed");
      assert.equal((await savedStore.getBlob(item.savedVideoId))?.size, sourceBlob().size);
    } finally {
      globalThis.fetch = originalFetch;
      restore();
    }
  });

  it("reports safe diagnostics for a lower requested IndexedDB version", async () => {
    const { factory, restore } = installFakeIndexedDb();
    const originalWarn = console.warn;
    console.warn = () => {};
    factory.seed(VIDEO_ANALYSIS_DB_NAME, VIDEO_ANALYSIS_DB_VERSION, seedCurrentStores());

    try {
      await assert.rejects(
        () =>
          openIndexedDbDatabase({
            databaseName: VIDEO_ANALYSIS_DB_NAME,
            version: 2,
            operation: "test.version-regression",
            onUpgradeNeeded: () => {
              assert.fail("A lower-version open must not run upgrades.");
            },
          }),
        (error) => {
          assert.ok(error instanceof VideoAnalysisIndexedDbError);
          assert.equal(error.diagnostics.databaseName, VIDEO_ANALYSIS_DB_NAME);
          assert.equal(error.diagnostics.requestedVersion, 2);
          assert.equal(error.diagnostics.detectedCurrentVersion, VIDEO_ANALYSIS_DB_VERSION);
          assert.equal(error.diagnostics.operation, "test.version-regression");
          assert.equal(error.diagnostics.safeErrorCode, "INDEXEDDB_VERSION_REGRESSION");
          assert.equal(JSON.stringify(error.diagnostics).includes("video-bytes"), false);
          return true;
        }
      );
    } finally {
      console.warn = originalWarn;
      restore();
    }
  });
});
