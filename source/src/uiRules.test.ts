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

test("both dark triggers map the same set of tokens", () => {
  // There are two, deliberately: the coach's saved toggle and the player's OS
  // preference. Two blocks means they can drift, and a token missing from one
  // of them keeps its light value on that surface — invisible until somebody
  // opens the portal at night. Written once, so check it once.
  const tokens = readFileSync(TOKENS, "utf8");
  const mapped = [...tokens.matchAll(/\{([^}]*--c-[a-z0-9-]+:\s*var\(--dark-[^}]*)\}/g)].map(
    (block) => new Set([...block[1].matchAll(/(--c-[a-z0-9-]+):\s*var\(/g)].map((m) => m[1])),
  );
  assert.equal(mapped.length, 2, "expected exactly two dark trigger blocks");
  const [first, second] = mapped;
  const missing = [
    ...[...first].filter((name) => !second.has(name)).map((name) => `${name} missing from the media-query block`),
    ...[...second].filter((name) => !first.has(name)).map((name) => `${name} missing from the .theme-dark block`),
  ];
  assert.deepEqual(missing, [], missing.join("\n  "));
});

/**
 * Every dedicated API function is excluded from the /api/* wildcard.
 *
 * booking-api.mts owns /api/* and lists the routes it must not swallow. A
 * function added without its exclusion still deploys, still typechecks, and
 * still 404s at runtime with "Route not found" from a completely different
 * file — which is exactly what happened to /api/integration-setup.
 */
test("every dedicated /api route is excluded from the wildcard", () => {
  const fnDir = path.join(SRC, "..", "netlify", "functions");
  const wildcard = readFileSync(path.join(fnDir, "booking-api.mts"), "utf8");
  // Only what is inside excludedPath[]. Reading every "/api/..." string in the
  // file also picks up the wildcard's own path: "/api/*", which collapses to
  // "/api" and then makes every route look covered by the prefix check below.
  // The first version of this test did that and passed while the bug was live.
  const block = wildcard.slice(wildcard.indexOf("excludedPath"), wildcard.indexOf("],", wildcard.indexOf("excludedPath")));
  const excluded = new Set(
    [...block.matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1].replace(/\/\*$/, "")),
  );
  assert.ok(excluded.size > 20, "excludedPath list not found — has booking-api.mts been restructured?");
  const missing: string[] = [];
  for (const entry of readdirSync(fnDir)) {
    if (!entry.endsWith(".mts") || entry === "booking-api.mts" || entry.endsWith(".test.mts")) continue;
    const text = readFileSync(path.join(fnDir, entry), "utf8");
    for (const match of text.matchAll(/path:\s*"(\/api\/[^"]+)"/g)) {
      const route = match[1].replace(/\/\*$/, "");
      if (route === "/api" || excluded.has(route)) continue;
      if ([...excluded].some((e) => route.startsWith(`${e}/`))) continue;
      missing.push(`${entry} owns ${match[1]} but booking-api.mts does not exclude it`);
    }
  }
  assert.deepEqual(missing, [], missing.join("\n  "));
});

/* --- Ratchets ------------------------------------------------------------ */

/**
 * A field is as wide as its content (Rule 05).
 *
 * Only fields are counted. The first version of this counted every
 * `width: 100%` in the stylesheet and immediately flagged a full-width button
 * header, which is not what the rule is about — and a check that cries wolf
 * gets its baseline bumped instead of its finding fixed, which is worse than
 * not having it.
 *
 * Notes and search legitimately fill their row; --c-w-prose exists so that
 * exception is written down rather than remembered.
 */
test("bare width:100% is not spreading on fields", () => {
  const BASELINE = 10;
  const offenders: string[] = [];
  for (const file of files) {
    const text = read(file);
    for (const match of text.matchAll(/^\s*width:\s*100%\s*;/gm)) {
      const brace = text.lastIndexOf("{", match.index);
      if (brace < 0) continue;
      const start = Math.max(text.lastIndexOf("}", brace), text.lastIndexOf("{", brace - 1), text.lastIndexOf("*/", brace));
      const selector = text.slice(start + 1, brace);
      if (!/input|select|textarea|\bfield\b|\.w-/.test(selector)) continue;
      offenders.push(`${rel(file)}: ${selector.trim().replace(/\s+/g, " ").slice(0, 70)}`);
    }
  }
  assert.ok(
    offenders.length <= BASELINE,
    `Fields at width:100% went from ${BASELINE} to ${offenders.length}. Use a ` +
      `--c-w-* width, or --c-w-prose if this really is notes or search.\n  ${offenders.join("\n  ")}`,
  );
  if (offenders.length < BASELINE) {
    console.log(`  ↓ fields at width:100% down to ${offenders.length} (baseline ${BASELINE}) — lower it.`);
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
