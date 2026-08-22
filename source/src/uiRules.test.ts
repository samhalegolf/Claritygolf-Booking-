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

/**
 * An archetype earns its name when a second integration needs it.
 *
 * Naming five shapes risks the usual failure: an abstraction fitted to what
 * exists, which then fights the seventh integration. This is the check that
 * keeps it honest — a kind with one member is either a genuinely different
 * mechanism or a premature abstraction, and it has to be named here as one.
 *
 * When a single-member kind gets a second member, delete it from SOLO. When it
 * never does, that is the argument for collapsing it into its neighbour.
 */
test("every connection archetype has two integrations, or a stated reason", () => {
  const SOLO: Record<string, string> = {
    // A handshake rather than a set of fields. Nothing else about it resembles
    // pasting a token, so sharing a kind with one would help nobody.
    oauth2: "Google — the only OAuth integration, and a different mechanism rather than a variation",
    // On probation. The secret is shared rather than issued, which is a
    // different failure mode from a revocable token — but if nothing else ever
    // links to a peer service this should collapse into api-token.
    "service-link": "Caddy — on probation; collapse into api-token if nothing joins it",
  };
  const dir = path.join(SRC, "..", "netlify", "functions", "_shared", "integrations");
  const sources = [
    readFileSync(path.join(dir, "catalogue.mts"), "utf8"),
    readFileSync(path.join(dir, "providers", "optix.mts"), "utf8"),
  ].join("\n");

  const counts = new Map<string, number>();
  for (const match of sources.matchAll(/kind: "([a-z0-9-]+)"/g)) {
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  assert.ok(counts.size >= 4, `only found ${counts.size} archetypes — has the catalogue moved?`);

  const unjustified = [...counts].filter(([kind, n]) => n < 2 && !SOLO[kind]).map(([kind]) => kind);
  assert.deepEqual(
    unjustified,
    [],
    `Archetype(s) with a single member and no stated reason: ${unjustified.join(", ")}. ` +
      "Either a second integration needs it, or it should collapse into its neighbour — " +
      "or say why in SOLO above.",
  );

  const outgrown = Object.keys(SOLO).filter((kind) => (counts.get(kind) ?? 0) >= 2);
  assert.deepEqual(outgrown, [], `No longer solo, remove from SOLO: ${outgrown.join(", ")}`);
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
  const BASELINE = 880;
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

/**
 * Nothing arrives already open.
 *
 * A screen that unfolds one of its sections on arrival reads as though that
 * section is the screen; the others become things you might not notice are
 * there. So every disclosure — Settings accordion, subsection, product group,
 * event row — starts shut and opens because somebody asked for it.
 *
 * Two forms are caught here: a `<details>` carrying a bare `open`, and a state
 * flag named for a disclosure that starts true. A `<details open={someState}>`
 * is fine and common — that is a controlled disclosure, and its default is the
 * useState below, which this test also reads.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (entry === "node_modules") return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(full) && !full.endsWith(".test.ts") ? [full] : [];
  });
}

/**
 * The two that are meant to start open, and why.
 *
 * playerToolExpanded — the panel it controls only exists once a player has been
 * clicked, so the click IS the request to open it. False would mean clicking a
 * player and getting a shut box.
 *
 * openPublicBookingSection — the customer's booking flow, not an admin screen.
 * It opens on "Appointment" because a booking page showing three shut bars
 * looks like a page with nothing on it.
 */
const MEANT_TO_START_OPEN = new Set(["playerToolExpanded", "openPublicBookingSection"]);

test("expandable sections arrive closed", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const source = read(file);
    // <details ... open> or <details ... open ...> — a bare attribute, which in
    // JSX means true. `open={...}` is a controlled disclosure and is allowed.
    for (const match of source.matchAll(/<details\b[^>]*?\bopen\s*(?![=\w])[^>]*>/g)) {
      offenders.push(`${rel(file)}: ${match[0].slice(0, 60).replace(/\s+/g, " ")}`);
    }
    // A disclosure flag that starts open. Two shapes: a boolean that starts
    // true, and the "which one is open" id that starts naming one.
    const CLOSED = ["", "false", '""', "''", "null", "undefined", "{}", "[]", "new Set()"];
    // The type argument is matched up to the paren rather than to the first `>`,
    // or a nested generic like Partial<Record<K, boolean>> slips through.
    const disclosure = /\[\s*(\w*(?:[Oo]pen|[Ee]xpand\w*|[Ss]how\w*|[Cc]ollaps\w*|[Dd]rawer|[Aa]ccordion)\w*)\s*,\s*set\w+\s*\]\s*=\s*useState\s*(?:<[^(]*>)?\s*\(([^)]*)\)/g;
    for (const match of source.matchAll(disclosure)) {
      const initial = match[2].trim();
      if (CLOSED.includes(initial)) continue;
      if (MEANT_TO_START_OPEN.has(match[1])) continue;
      offenders.push(`${rel(file)}: ${match[1]} starts as ${initial || "open"}`);
    }
    // A header that claims to be expanded before anything has been clicked.
    for (const match of source.matchAll(/aria-expanded=\{?\s*true/g)) {
      offenders.push(`${rel(file)}: ${match[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `These arrive already open:\n  ${offenders.join("\n  ")}\n` +
      "Open on click, not on arrival.",
  );
});

/**
 * One speed for opening and closing.
 *
 * There were four: the Settings accordion at 200ms, its opacity at 160ms, the
 * details panel popping at 160ms and collapsing at 260ms, and a native
 * <details> at no speed at all. Same gesture, four answers. Everything that
 * opens or closes now reads --c-t-expand, so changing the feel of the whole app
 * is one line in tokens.css.
 *
 * A rule counts as a disclosure if it animates the row track (the 0fr → 1fr
 * trick), if it dresses ::details-content, or if it is one of the two panel
 * keyframes. Hover, drag and flight animations are a different question and are
 * left alone.
 */
test("everything opens and closes at the same speed", () => {
  const offenders: string[] = [];
  for (const file of files) {
    if (file === TOKENS) continue;
    for (const match of read(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1].split("*/").pop()!.trim().replace(/\s+/g, " ");
      const body = match[2];
      const motion = [...body.matchAll(/(?:transition|animation)\s*:\s*([^;]+);/g)].map((entry) => entry[1]);
      if (!motion.length) continue;
      const isDisclosure =
        /details-content|disclosure/.test(selector) ||
        motion.some((value) => /grid-template-rows|detailsPop|panelCollapse/.test(value));
      if (!isDisclosure) continue;
      // Per property, not per declaration: a transition list can hold one
      // stray literal beside three correct tokens, and reading the whole
      // declaration would call that fine.
      for (const value of motion) {
        for (const part of value.split(",")) {
          if (!/\d+\s*m?s\b/.test(part)) continue;
          offenders.push(`${rel(file)}: ${selector.slice(0, 40)} — ${part.replace(/\s+/g, " ").trim()}`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `These open or close at their own speed:\n  ${offenders.join("\n  ")}\n` +
      "Use var(--c-t-expand), and change tokens.css if the speed is wrong.",
  );
});
