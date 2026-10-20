import assert from "node:assert/strict";
import { test } from "node:test";
import { canShareFile, exportFile, shareFile } from "./nativeFiles";

test("video files use browser sharing directly, preserve cancellation, and report native failures", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const global = globalThis as typeof globalThis & { Capacitor?: unknown };
  const originalCapacitor = global.Capacitor;
  const blob = new Blob(["video"], { type: "video/mp4" });
  try {
    let shared: ShareData | undefined;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
      canShare: () => true,
      share: (data: ShareData) => { shared = data; return Promise.resolve(); },
    } });
    const pending = shareFile(blob, "swing.mp4");
    assert.equal(shared?.files?.[0].name, "swing.mp4", "share starts synchronously within the tap");
    assert.equal(await pending, true);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
      canShare: () => true,
      share: () => Promise.reject(new DOMException("Cancelled", "AbortError")),
    } });
    assert.equal(await shareFile(blob, "swing.mp4"), false);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    assert.equal(canShareFile(blob, "swing.mp4"), false);
    await assert.rejects(shareFile(blob, "swing.mp4"), /unavailable/);

    const writes: string[] = [];
    global.Capacitor = {
      isNativePlatform: () => true,
      isPluginAvailable: () => true,
      Plugins: {
        Filesystem: {
          writeFile: async () => ({ uri: "file://cache/swing.mp4" }),
          appendFile: async ({ data }: { data: string }) => { writes.push(data); },
          getUri: async () => ({ uri: "file://cache/swing.mp4" }),
        },
        Share: { share: async () => { throw new Error("Unable to read file"); } },
      },
    };
    await assert.rejects(exportFile(blob, "swing.mp4"), /Unable to read file/);
    assert.equal(Buffer.from(writes.join(""), "base64").toString(), "video");
    (global.Capacitor as { Plugins: { Share: { share: () => Promise<void> } } }).Plugins.Share.share =
      async () => { throw new Error("User cancelled"); };
    await assert.doesNotReject(exportFile(blob, "swing.mp4"));
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    global.Capacitor = originalCapacitor;
  }
});
