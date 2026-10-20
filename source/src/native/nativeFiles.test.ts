import assert from "node:assert/strict";
import { test } from "node:test";
import { canShareFile, chooseVideoExportDestination, exportFile, shareFile, writeVideoExport } from "./nativeFiles";

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


test("Export opens Save As immediately and writes the chosen file only after preparation", async () => {
  const host = globalThis as typeof globalThis & { showSaveFilePicker?: unknown };
  const originalPicker = host.showSaveFilePicker;
  const events: string[] = [];
  const writable = {
    write: async (blob: Blob) => { events.push("write:" + await blob.text()); },
    close: async () => { events.push("close"); },
    abort: async () => { events.push("abort"); },
  };
  const handle = { name: "chosen.mp4", createWritable: async () => { events.push("open"); return writable; } };
  try {
    host.showSaveFilePicker = (options: { suggestedName: string }) => {
      events.push("picker:" + options.suggestedName);
      return Promise.resolve(handle);
    };
    const destination = chooseVideoExportDestination("swing.mp4");
    assert.deepEqual(events, ["picker:swing.mp4"], "picker opens inside the original click");
    const chosen = await destination;
    assert.equal(chosen, handle);
    events.push("prepare");
    await writeVideoExport(chosen!, new Blob(["video"]));
    assert.deepEqual(events, ["picker:swing.mp4", "prepare", "open", "write:video", "close"]);

    host.showSaveFilePicker = () => Promise.reject(new DOMException("Cancelled", "AbortError"));
    await assert.rejects(chooseVideoExportDestination("swing.mp4"), { name: "AbortError" });
    assert.equal(events.filter((entry) => entry === "open").length, 1, "cancelling the picker never opens a writable file");

    host.showSaveFilePicker = undefined;
    assert.equal(await chooseVideoExportDestination("swing.mp4"), null);
    const broken = { name: "broken.mp4", createWritable: async () => ({
      write: async () => { throw new Error("Disk full"); },
      close: async () => { throw new Error("Must not close a failed write"); },
      abort: async () => { events.push("abort"); },
    }) };
    await assert.rejects(writeVideoExport(broken, new Blob(["video"])), /Disk full/);
    assert.equal(events.at(-1), "abort");
  } finally { host.showSaveFilePicker = originalPicker; }
});
