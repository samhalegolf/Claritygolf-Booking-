/**
 * The architectural rule, enforced.
 *
 *     THE 3D SPACE NEVER CONSUMES GOOGLE / MEDIAPIPE DATA DIRECTLY.
 *
 * A rule that lives only in a document is a rule that gets broken during a
 * late-night debugging session, because reaching into the raw landmarks is
 * always the quickest way to answer "but what did the detector actually
 * say?". This test makes that shortcut fail loudly instead of quietly
 * dissolving the boundary the whole build rests on.
 *
 * If you are here because this test failed: the answer is almost never to
 * relax the allow-list. It is to add what you need to ClarityFrame, so the
 * Motion Layer states it explicitly and every consumer sees the same thing.
 */

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const LAB_SRC = fileURLToPath(new URL("..", import.meta.url));

const sourceFilesUnder = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
};

/**
 * Import specifiers, from static imports, `export ... from`, and dynamic
 * `import(...)`. Type-only imports are included deliberately: importing a
 * detector type into the renderer is the first step of importing its data.
 */
const importSpecifiers = (source: string): string[] => {
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?[^;'"]*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s+(?:type\s+)?[^;'"]*?from\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
};

/**
 * Resolve an import to the layer it actually lands in.
 *
 * The first version of this matched string prefixes, which quietly failed to
 * recognise `../../contracts` from a nested file and reported it as a
 * violation. Prefix matching cannot see depth. Resolving the path can, and it
 * also means a relative import that climbs out of its own layer by a
 * roundabout route is caught rather than waved through.
 *
 * Returns the top-level lab directory ("contracts", "observe", ...) for a
 * relative import, or the bare package name for anything else.
 */
const resolveLayer = (fromFile: string, specifier: string): string => {
  if (!specifier.startsWith(".")) return specifier;
  const resolved = resolve(dirname(fromFile), specifier);
  const fromLabRoot = relative(LAB_SRC, resolved);
  if (fromLabRoot.startsWith("..")) return `OUTSIDE:${fromLabRoot}`;
  return fromLabRoot.split(sep)[0];
};

/**
 * What a layer is allowed to reach for. Anything not matched is a failure,
 * so a new dependency is a deliberate act rather than an accident.
 */
const assertLayerImportsOnly = (
  layer: string,
  allowedLayers: readonly string[],
  explanation: string
) => {
  const dir = join(LAB_SRC, layer);

  // A moved or renamed directory must break this test rather than silently
  // disable it -- a guard that passes because it found nothing to check is
  // worse than no guard, because it reads as green.
  const files = sourceFilesUnder(dir);
  assert.ok(
    files.length > 0,
    `Expected source files under ${layer}/. If that directory moved, move this guard with it.`
  );

  const allowed = new Set([...allowedLayers, layer]);
  const violations: string[] = [];

  for (const file of files) {
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      if (specifier.endsWith(".css")) continue;
      if (specifier.startsWith("node:")) continue;
      const target = resolveLayer(file, specifier);
      if (!allowed.has(target)) {
        violations.push(
          `  ${relative(LAB_SRC, file)} imports "${specifier}"  ->  ${target}`
        );
      }
    }
  }

  assert.equal(
    violations.length,
    0,
    `${explanation}\n\nAllowed: ${[...allowed].sort().join(", ")}\n\nViolations:\n${violations.join("\n")}\n`
  );
};

/** Packages any layer may use. React is UI-agnostic; three is the renderer's. */
const BASE_PACKAGES = ["react", "react-dom", "react/jsx-runtime"];

test("the 3D Space consumes ClarityFrame and nothing else", () => {
  assertLayerImportsOnly(
    "space3d",
    ["contracts", "three", "three/webgpu", "three/tsl", ...BASE_PACKAGES],
    "space3d/ may import three, react, its own files, and contracts/ -- nothing else.\n" +
      "In particular it may not import observe/: the renderer must not know what a\n" +
      "MediaPipe landmark index is. If the renderer needs a fact the detector knows,\n" +
      "add that fact to ClarityFrame so the Motion Layer has to state it."
  );
});

test("synthetic data is built against the contract, not against a detector", () => {
  assertLayerImportsOnly(
    "synthetic",
    ["contracts", "motion"],
    "synthetic/ exists to prove the ClarityFrame contract without a detector, so it\n" +
      "must not import observe/ -- the moment it does, it is no longer proving the\n" +
      "contract in isolation.\n\n" +
      "It MAY import motion/. The mass model and the confidence roll-up are pure\n" +
      "functions of a body pose, and having the fixture reuse them is the difference\n" +
      "between testing the real definitions and testing a second copy of them that\n" +
      "is free to drift."
  );
});

test("the Motion Layer does not reach into the renderer", () => {
  assertLayerImportsOnly(
    "motion",
    ["contracts", "observe"],
    "motion/ turns observations into ClarityFrames. It reads observe/ and writes\n" +
      "contracts/. It must not depend on space3d/ -- reconstruction decisions must\n" +
      "never be shaped by what is convenient to draw."
  );
});
