/**
 * The portal's light/dark switch.
 *
 * Two things are easy to get wrong here and both look like a broken switch:
 * a tap that does not change what is on screen, and a choice the operating
 * system overrules. The second is the reason "system" has to be the absence of
 * an attribute rather than a value of its own -- the media query in tokens.css
 * is written to apply unless something overrules it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  effectiveTheme,
  portalThemeAttribute,
  togglePortalTheme,
} from "./portalTheme";

test("following the device means showing what the device asked for", () => {
  assert.equal(effectiveTheme("system", true), "dark");
  assert.equal(effectiveTheme("system", false), "light");
});

test("a choice beats the device in both directions", () => {
  // The direction that is easy to miss: light chosen on a phone set to dark.
  assert.equal(effectiveTheme("light", true), "light");
  assert.equal(effectiveTheme("dark", false), "dark");
});

test("one tap always changes what is on screen", () => {
  // The failure this prevents: a three-way cycle where the first tap out of
  // "system" lands on the value the device already had, and nothing moves.
  assert.equal(togglePortalTheme("system", true), "light");
  assert.equal(togglePortalTheme("system", false), "dark");
  assert.equal(togglePortalTheme("dark", false), "light");
  assert.equal(togglePortalTheme("light", true), "dark");
});

test("tapping twice returns to where it started", () => {
  for (const prefersDark of [true, false]) {
    const once = togglePortalTheme("system", prefersDark);
    const twice = togglePortalTheme(once, prefersDark);
    assert.equal(
      twice,
      effectiveTheme("system", prefersDark),
      "a tap and a tap back must undo each other",
    );
  }
});

test("following the device leaves no attribute for the media query to lose to", () => {
  assert.equal(portalThemeAttribute("system"), undefined);
  assert.equal(portalThemeAttribute("dark"), "dark");
  assert.equal(portalThemeAttribute("light"), "light");
});
