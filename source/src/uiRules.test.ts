import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * The UI rules that can be checked without a browser.
 *
 * These live as tests rather than as a script because a script has to be
 * remembered. Two of the four are absolute; two are ratchets — a count that is
 * allowed to fall and not to rise. The ratchets matter more than they look:
 * the alternative to a ratchet is a big-bang cleanup nobody has time for, and
 * a rule with no enforcement, which is where the four token systems came from.
 *
 * When a number below goes down, lower it here in the same commit. That is the
 * whole ceremony.
 *
 * What is NOT here: the nesting law. "A bordered box inside a bordered box" is
 * a property of the rendered page, not of the stylesheet — a class is only
 * nested when the JSX puts it there, and the CSS cannot know. That one is
 * checked at runtime by src/lib/boxAudit.ts.
 */

const SRC = path.resolve(import.meta.dirname ?? __dirname);
const TOKENS = path.join(SRC, "tokens.css");

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (entry === "node_modules") return [];
    if (statSync(full).isDirectory()) return cssFiles(full);
    return full.endsWith(".css") ? [full] : [];
  });
}

const files = cssFiles(SRC);
const read = (file: string) => readFileSync(file, "utf8");
const rel = (file: string) => path.relative(SRC, file);

test("tokens.css is the only place a --c-* value is decided", () => {
  const offenders: string[] = [];
  for (const file of files) {
    if (file === TOKENS) continue;
    for (const match of read(file).matchAll(/^\s*(--c-[a-z0-9-]+)\s*:/gm)) {
      offenders.push(`${rel(file)} declares ${match[1]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "A --c-* declared outside tokens.css is a second source of truth, which is " +
      "how four palettes happened. Alias onto the token instead:\n  " +
      offenders.join("\n  "),
  );
});

test("every token referenced is a token that exists", () => {
  const defined = new Set(
    [...read(TOKENS).matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]),
  );
  const dangling: string[] = [];
  for (const file of files) {
    for (const match of read(file).matchAll(/var\(\s*(--(?:c|dark)-[a-z0-9-]+)/g)) {
      if (!defined.has(match[1])) dangling.push(`${rel(file)} → ${match[1]}`);
    }
  }
  // A typo in a var() name fails silently in CSS: the property is dropped and
  // the element inherits, which usually looks *almost* right. Worth a test.
  assert.deepEqual(dangling, [], `Undefined tokens:\n  ${dangling.join("\n  ")}`);
});

test("nothing transitions transform on a button", () => {
  const offenders: string[] = [];
  for (const file of files) {
    const text = read(file);
    // Walk back from the declaration to its own rule's "{", then take the
    // selector in front of that. Parsing whole blocks with one regex breaks on
    // @media, which swallows the rules inside it and reports a selector that
    // was never there — the first version of this test did exactly that.
    for (const match of text.matchAll(/transition:[^;{}]*transform[^;{}]*;/g)) {
      const brace = text.lastIndexOf("{", match.index);
      if (brace < 0) continue;
      const start = Math.max(
        text.lastIndexOf("}", brace),
        text.lastIndexOf("{", brace - 1),
        text.lastIndexOf("*/", brace),
      );
      const selector = text.slice(start + 1, brace);
      // Draggable things are allowed — a drag that does not follow the pointer
      // smoothly is worse than one that does, and Rule 11's objection is to
      // hover and press, not to drag.
      if (/\[draggable\]|\.calendar-item|\.dock-tile|\.drag/.test(selector)) continue;
      if (/button|\.pill|\.tab|a:hover|:active/.test(selector)) {
        offenders.push(`${rel(file)}: ${selector.trim().replace(/\s+/g, " ").slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "Rule 11: no transform on hover or press — it makes the control twitch " +
      `under the pointer.\n  ${offenders.join("\n  ")}`,
  );
});

/* --- Ratchets ------------------------------------------------------------ */

/**
 * A field is as wide as its content (Rule 05).
 *
 * `width: 100%` on a field is the regression that keeps coming back, so it is
 * counted rather than banned: notes and search legitimately fill their row,
 * and --c-w-prose exists to say so out loud. Everything else should be a
 * min(Nch, 100%).
 */
test("bare width:100% is not spreading", () => {
  const BASELINE = 60;
  let count = 0;
  for (const file of files) {
    count += [...read(file).matchAll(/^\s*width:\s*100%\s*;/gm)].length;
  }
  assert.ok(
    count <= BASELINE,
    `width:100% went from ${BASELINE} to ${count}. Use a --c-w-* width, or ` +
      "--c-w-prose if this really is notes or search — then lower the baseline.",
  );
  if (count < BASELINE) {
    console.log(`  ↓ width:100% is down to ${count} (baseline ${BASELINE}) — lower it.`);
  }
});

/**
 * Literal colours outside the token layer.
 *
 * 800-odd today, so this is a direction of travel rather than a gate. Every
 * one of them is a colour that cannot follow the theme, which is why dark mode
 * has always had rough edges.
 */
test("literal hex colours are not spreading", () => {
  const BASELINE = 895;
  let count = 0;
  for (const file of files) {
    if (file === TOKENS) continue;
    count += [...read(file).matchAll(/#[0-9a-fA-F]{3,8}\b/g)].length;
  }
  assert.ok(
    count <= BASELINE,
    `Literal hex colours went from ${BASELINE} to ${count}. Reach for a --c-* ` +
      "token; if none fits, that is a gap in tokens.css worth filling.",
  );
  if (count < BASELINE) {
    console.log(`  ↓ literal hexes down to ${count} (baseline ${BASELINE}) — lower it.`);
  }
});
