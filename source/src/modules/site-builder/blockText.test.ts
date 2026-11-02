import assert from "node:assert/strict";
import test from "node:test";

import { BUSINESS_ONLY_BLOCKS, SITE_BLOCK_TYPES, cleanSitePageContent, newSiteBlock, type SiteBlock } from "../../../netlify/functions/_shared/site/document.mts";
import { setBlockField } from "./blockText";
import { SECTION_CATEGORIES, SECTION_LIBRARY, blockForChoice } from "./sectionLibrary";

test("words typed on the page land in the section's own field", () => {
  const hero = newSiteBlock("hero");
  const next = setBlockField(hero, "heading", "Play better golf") as Extract<SiteBlock, { type: "hero" }>;
  assert.equal(next.heading, "Play better golf");
  assert.notEqual(next, hero, "a new block, so the draft sees the change");
  assert.equal((hero as Extract<SiteBlock, { type: "hero" }>).heading, "A heading that says what you do", "the old block is left alone");
});

test("words typed into one item of a list land in that item only", () => {
  const features = newSiteBlock("features") as Extract<SiteBlock, { type: "features" }>;
  const [first, second] = features.items;
  const next = setBlockField(features, `items.${second.id}.title`, "Short game") as typeof features;
  assert.equal(next.items[1].title, "Short game");
  assert.equal(next.items[0].title, first.title);
});

test("a path can only write words: never a list, a setting, a picture, or an item that is not there", () => {
  const hero = newSiteBlock("hero");
  assert.equal(setBlockField(hero, "buttons", "x"), hero);
  assert.equal(setBlockField(hero, "image", "x"), hero);
  assert.equal(setBlockField(hero, "nonsense", "x"), hero);
  const features = newSiteBlock("features");
  assert.equal(setBlockField(features, "items.no-such-item.title", "x"), features);
  assert.equal(setBlockField(features, `items.${(features as Extract<SiteBlock, { type: "features" }>).items[0].id}.icon`, "x").type, "features");
  assert.equal(setBlockField(features, "items.a.b.c", "x"), features);
});

test("every layout in the section gallery makes a section the cleaner keeps as it is", () => {
  for (const choice of SECTION_LIBRARY) {
    assert.ok(SITE_BLOCK_TYPES.includes(choice.type), choice.id);
    assert.ok((SECTION_CATEGORIES as readonly string[]).includes(choice.category), `${choice.id} is in a listed category`);
    const block = blockForChoice(choice);
    const { style, ...fields } = block;
    const cleaned = cleanSitePageContent({ blocks: [fields] }).blocks[0] as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(choice.patch || {})) {
      assert.deepEqual(cleaned[key], value, `${choice.id}: ${key} survives the cleaner`);
    }
    assert.ok(style, "a fresh section carries a plain style");
  }
});

test("the gallery has an id per layout, and every block a site can have is in it", () => {
  const ids = SECTION_LIBRARY.map((choice) => choice.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const type of SITE_BLOCK_TYPES) assert.ok(SECTION_LIBRARY.some((choice) => choice.type === type), `${type} can be added`);
  // A house site, with no booking page, still has something in every other category.
  const house = SECTION_LIBRARY.filter((choice) => !BUSINESS_ONLY_BLOCKS.includes(choice.type));
  for (const category of SECTION_CATEGORIES) {
    if (SECTION_LIBRARY.filter((choice) => choice.category === category).every((choice) => BUSINESS_ONLY_BLOCKS.includes(choice.type))) continue;
    assert.ok(house.some((choice) => choice.category === category), category);
  }
});
