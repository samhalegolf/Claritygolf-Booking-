/**
 * Finding a thing you know you have.
 *
 * Written from a real one: a coach added a five-lesson package, went to the
 * till, typed its name and got an empty shelf -- because the search only looked
 * inside the Products tab, which is the one the till opens on.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { catalogTiles, offTabMatchCount } from "./catalogSearch";

const CATALOG = [
  { id: "glove", name: "Golf Glove", kind: "product", sku: "GLV-1" },
  { id: "lesson:package-5", name: "5 Lesson Package", kind: "package" },
  { id: "lesson:lesson-60", name: "60 Minute Lesson", kind: "service" },
  { id: "old", name: "Retired Cap", kind: "product", active: false },
];

test("searching from the Products tab still finds a package", () => {
  const tiles = catalogTiles(CATALOG, "product", "5 lesson");
  assert.deepEqual(tiles.map((tile) => tile.id), ["lesson:package-5"]);
});

test("a search finds a lesson type from the Products tab too", () => {
  const tiles = catalogTiles(CATALOG, "product", "60 minute");
  assert.deepEqual(tiles.map((tile) => tile.id), ["lesson:lesson-60"]);
});

test("with nothing typed, the tab is still the shelf", () => {
  const tiles = catalogTiles(CATALOG, "product", "");
  assert.deepEqual(tiles.map((tile) => tile.id), ["glove"], "packages are not on the Products shelf");
});

test("the All tab shows everything active", () => {
  const tiles = catalogTiles(CATALOG, "all", "");
  assert.deepEqual(tiles.map((tile) => tile.id), ["glove", "lesson:package-5", "lesson:lesson-60"]);
});

test("an inactive item stays off the shelf however it is searched for", () => {
  assert.deepEqual(catalogTiles(CATALOG, "all", "retired"), []);
  assert.deepEqual(catalogTiles(CATALOG, "product", "retired"), []);
});

test("sku and supplier are still searchable", () => {
  assert.deepEqual(catalogTiles(CATALOG, "all", "glv-1").map((tile) => tile.id), ["glove"]);
});

test("the coach is told when a search reached past the tab they are on", () => {
  const tiles = catalogTiles(CATALOG, "product", "5 lesson");
  assert.equal(offTabMatchCount(tiles, "product", "5 lesson"), 1);
});

test("nothing to announce when the matches are all on this tab", () => {
  const tiles = catalogTiles(CATALOG, "product", "glove");
  assert.equal(offTabMatchCount(tiles, "product", "glove"), 0);
});

test("nothing to announce on the All tab, where nothing is hidden", () => {
  const tiles = catalogTiles(CATALOG, "all", "5 lesson");
  assert.equal(offTabMatchCount(tiles, "all", "5 lesson"), 0);
});
