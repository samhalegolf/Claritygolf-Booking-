/**
 * No route calls something that does not exist.
 *
 * booking-core.mts and billing-api.mts are not typechecked by anything.
 * tsconfig.json includes only `src`, and the `typecheck:functions` script names
 * six other files. Between them these two own most of the API, so a call to a
 * function nobody imported is not a build failure -- it is a ReferenceError on
 * a live route, thrown the first time a real person uses the feature.
 *
 * This nearly shipped: a player-facing route was written calling
 * reservePassCredit() without importing it, and `npm run typecheck` was green
 * because the file it was in is not in the project.
 *
 * Full typechecking is not possible yet -- booking-core carries 217 type-shape
 * errors from a decade of untyped parameters, which is a cleanup of its own.
 * But the handful of codes that are never a style question and always a crash
 * are already at zero, so they can be held there while the rest waits.
 *
 * The second one on the list was added the hard way. A refactor moved a const
 * below the code that read it, which is a temporal dead zone error -- and the
 * player portal answered every profile load with "Cannot access \'heldPasses\'
 * before initialization" until somebody opened it. tsc knows this as TS2448
 * and would have said so on the spot.
 *
 * Deliberately narrow. If this starts failing on something that is not one of
 * the codes below, the filter is wrong, not the code.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const functionsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = join(functionsDir, "..", "..");

/**
 * Errors that are never a matter of taste.
 *
 * Each of these means the code cannot run, not that its types are loose --
 * which is why they can be held at zero in files carrying hundreds of
 * type-shape complaints.
 */
const ALWAYS_A_CRASH: Array<{ code: string; meaning: string }> = [
  { code: "TS2304", meaning: "Cannot find name -- a ReferenceError on a live route" },
  { code: "TS2448", meaning: "Used before its declaration -- a temporal dead zone crash" },
  { code: "TS2454", meaning: "Used before being assigned" },
  { code: "TS2552", meaning: "Cannot find name (did you mean...) -- a typo" },
  { code: "TS2349", meaning: "This expression is not callable" },
];

/** The route owners nothing else typechecks. */
const UNCHECKED_ROUTE_FILES = [
  "netlify/functions/booking-core.mts",
  "netlify/functions/billing-api.mts",
];

test("no route file contains an error that is always a crash", () => {
  let output = "";
  try {
    execFileSync(
      "npx",
      [
        "tsc",
        "--noEmit",
        "--module", "NodeNext",
        "--moduleResolution", "NodeNext",
        "--target", "ES2022",
        "--lib", "ES2022,DOM",
        "--skipLibCheck",
        "--allowImportingTsExtensions",
        ...UNCHECKED_ROUTE_FILES,
      ],
      { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    // A non-zero exit is expected: these files carry many type-shape errors.
    // Only the output matters.
    output = String((error as { stdout?: string }).stdout || "");
  }

  const crashes = output
    .split("\n")
    .filter((line) => ALWAYS_A_CRASH.some((entry) => line.includes(`error ${entry.code}`)))
    .map((line) => line.trim());

  assert.deepEqual(
    crashes,
    [],
    "These cannot run. In files nothing typechecks, that is a crash on a live " +
      `route rather than a build error:\n  ${crashes.join("\n  ")}\n\n` +
      `Watched codes:\n  ${ALWAYS_A_CRASH.map((entry) => `${entry.code} — ${entry.meaning}`).join("\n  ")}`,
  );
});
