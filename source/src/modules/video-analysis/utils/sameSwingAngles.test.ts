import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VideoAnalysis } from "../models/Analysis";
import type { PlayerVideo } from "../models/Video";
import {
  groupSameSwingAngles,
  pairSameSwingAngles,
  type SwingAngleCandidate,
} from "./sameSwingAngles";
import {
  createMemorySavedVideoLibraryStore,
  linkSavedVideoAngles,
  pairSavedVideoAngles,
  refuseSavedVideoAngles,
} from "./savedVideoLibrary";

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 30, 10, 0, seconds)).toISOString();

const clip = (id: string, overrides: Partial<SwingAngleCandidate> = {}): SwingAngleCandidate => ({
  id,
  playerId: "player-1",
  recordedAt: at(0),
  durationS: 6,
  ...overrides,
});

describe("same swing, two cameras", () => {
  it("pairs two clips recorded at the same moment", () => {
    const pairs = pairSameSwingAngles([clip("face-on"), clip("dtl", { recordedAt: at(1) })]);
    assert.equal(pairs.get("face-on"), "dtl");
    assert.equal(pairs.get("dtl"), "face-on");
  });

  it("pairs by the finish when one camera started late but stopped together", () => {
    const pairs = pairSameSwingAngles([
      clip("a", { durationS: 16 }),
      clip("b", { recordedAt: at(4), durationS: 12 }),
    ]);
    assert.equal(pairs.get("a"), "b");
  });

  it("does not pair clips filmed apart, of different lengths, or of different players", () => {
    assert.equal(pairSameSwingAngles([clip("a"), clip("b", { recordedAt: at(10) })]).size, 0);
    assert.equal(pairSameSwingAngles([clip("a"), clip("b", { durationS: 20 })]).size, 0);
    assert.equal(pairSameSwingAngles([clip("a"), clip("b", { playerId: "player-2" })]).size, 0);
  });

  it("never pairs on a recording time nobody knows", () => {
    assert.equal(
      pairSameSwingAngles([clip("a", { recordedAt: undefined }), clip("b", { recordedAt: undefined })]).size,
      0
    );
  });

  it("gives each clip its closest partner, and leaves a third camera alone", () => {
    const pairs = pairSameSwingAngles([
      clip("a"),
      clip("b", { recordedAt: at(2) }),
      clip("c", { recordedAt: new Date(Date.parse(at(0)) + 200).toISOString() }),
    ]);
    assert.equal(pairs.get("a"), "c");
    assert.equal(pairs.has("b"), false);
  });

  it("lets a link win over timing, and a refusal stop timing", () => {
    const linked = pairSameSwingAngles([
      clip("a", { linkedTo: "far" }),
      clip("near"),
      clip("far", { recordedAt: undefined, linkedTo: "a" }),
    ]);
    assert.equal(linked.get("a"), "far");
    assert.equal(linked.has("near"), false);

    assert.equal(pairSameSwingAngles([clip("a", { refused: ["b"] }), clip("b")]).size, 0);
  });

  it("groups a list so each pair sits where its first member was", () => {
    const groups = groupSameSwingAngles(
      ["x", "a", "y", "b"],
      (id) => id,
      new Map([
        ["a", "b"],
        ["b", "a"],
      ])
    );
    assert.deepEqual(groups, [["x"], ["a", "b"], ["y"]]);
  });
});

describe("linking saved videos", () => {
  const analysis = (id: string): VideoAnalysis => ({
    id: `analysis-${id}`,
    playerId: "player-1",
    videoId: id,
    videoMeta: { title: id },
    drawings: [],
    markers: [],
    notes: [],
    focusViews: [],
    focusSnapshots: [],
    narrationRefs: [],
    createdAt: at(0),
    updatedAt: at(0),
  });

  const save = async (store: ReturnType<typeof createMemorySavedVideoLibraryStore>, id: string, recordedAt?: string) => {
    const sourceVideo: PlayerVideo = {
      id,
      playerId: "player-1",
      sourceUrl: "blob:x",
      title: `${id}.mp4`,
      createdAt: at(30),
      recordedAt,
      duration: 6,
    };
    return store.saveItem({
      savedVideoId: id,
      playerId: "player-1",
      sourceSide: "left",
      sourceVideo,
      sourceBlob: new Blob([id], { type: "video/mp4" }),
      analysisSnapshot: analysis(id),
      workspaceSnapshot: {
        version: 1,
        mode: "single",
        activeSide: "left",
        savedVideoIds: {},
        linkedPlayback: false,
        focusWindowOpen: false,
        focusWindowMode: "area",
        focusWindowSide: "left",
        focusAreaRect: null,
      },
    });
  };

  it("pairs by a known recording time, and not by the time a file was loaded", async () => {
    const store = createMemorySavedVideoLibraryStore();
    await save(store, "known-a", at(0));
    await save(store, "known-b", at(1));
    await save(store, "loaded-a");
    await save(store, "loaded-b");
    const pairs = pairSavedVideoAngles(await store.listItems());
    assert.equal(pairs.get("known-a"), "known-b");
    assert.equal(pairs.has("loaded-a"), false);
  });

  it("keeps a link and a refusal through a re-save, and a new link lets the old partner go", async () => {
    const store = createMemorySavedVideoLibraryStore();
    await save(store, "a");
    await save(store, "b");
    await save(store, "c");

    await linkSavedVideoAngles(store, "a", "b");
    await save(store, "a");
    assert.equal(pairSavedVideoAngles(await store.listItems()).get("a"), "b");

    await linkSavedVideoAngles(store, "a", "c");
    assert.equal((await store.getItem("b"))?.swingAngles?.linkedTo, undefined);
    assert.equal(pairSavedVideoAngles(await store.listItems()).get("c"), "a");

    await refuseSavedVideoAngles(store, "a", "c");
    const pairs = pairSavedVideoAngles(await store.listItems());
    assert.equal(pairs.has("a"), false);
    assert.deepEqual((await store.getItem("c"))?.swingAngles?.refused, ["a"]);
  });
});
