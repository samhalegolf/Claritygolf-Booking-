import { strict as assert } from "node:assert";
import { test } from "node:test";

import { TimelineEngine } from "../engines/TimelineEngine";
import { markersAreUntouched, placeMarkersAtPhases } from "./motionLabMarkers";

const engine = new TimelineEngine();

test("each marker moves to its phase and keeps its id", () => {
  const defaults = engine.getDefaultMarkers(8);
  const { markers, placed } = placeMarkersAtPhases(
    defaults,
    {
      failure: null,
      phases: {
        setup: { timeMs: 1000, confidence: 1 },
        takeaway: { timeMs: 1400, confidence: 1 },
        top: { timeMs: 2800, confidence: 1 },
        delivery: { timeMs: 3100, confidence: 1 },
        impact: { timeMs: 3250, confidence: 1 },
        finish: { timeMs: 4400, confidence: 1 },
      },
    },
    8
  );
  assert.deepEqual(
    markers.map((m) => [m.id, m.label, m.time]),
    [
      ["marker-1", "Setup", 1],
      ["marker-2", "Takeaway", 1.4],
      ["marker-3", "Top", 2.8],
      ["marker-4", "Delivery", 3.1],
      ["marker-5", "Impact", 3.25],
      ["marker-6", "Finish", 4.4],
    ]
  );
  assert.equal(placed.length, 6);
});

test("a missing or weak phase leaves its marker where it was", () => {
  const defaults = engine.getDefaultMarkers(8);
  const { markers, placed } = placeMarkersAtPhases(
    defaults,
    { failure: null, phases: { top: { timeMs: 2800, confidence: 0.1 }, impact: { timeMs: 3250, confidence: 0.9 } } },
    8
  );
  assert.deepEqual(placed, ["Impact"]);
  assert.equal(markers[2].time, defaults[2].time);
  assert.equal(markers[4].time, 3.25);
});

test("a moved marker drops the thumbnail cut at its old time", () => {
  const [setup] = engine.getDefaultMarkers(8);
  const { markers } = placeMarkersAtPhases(
    [{ ...setup, thumbnail: "data:old" }],
    { failure: null, phases: { setup: { timeMs: 500, confidence: 1 } } },
    8
  );
  assert.equal(markers[0].thumbnail, undefined);
});

test("times are clamped into the clip", () => {
  const [setup] = engine.getDefaultMarkers(2);
  const { markers } = placeMarkersAtPhases(
    [setup],
    { failure: null, phases: { setup: { timeMs: 9000, confidence: 1 } } },
    2
  );
  assert.equal(markers[0].time, 2);
});

test("only default markers count as untouched", () => {
  const defaults = engine.getDefaultMarkers(8);
  assert.ok(markersAreUntouched(defaults, engine.getDefaultMarkers(8)));
  const dragged = defaults.map((m, i) => (i === 3 ? { ...m, time: m.time + 0.2 } : m));
  assert.ok(!markersAreUntouched(dragged, defaults));
});
