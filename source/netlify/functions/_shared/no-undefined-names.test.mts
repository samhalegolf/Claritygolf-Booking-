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
 * But the one class of error that is always a real bug, TS2304 "Cannot find
 * name", is already at zero, so it can be held there while the rest waits.
 *
 * Deliberately narrow. If this starts failing on something that is not an
 * undefined identifier, the filter below is wrong, not the code.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const functionsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = join(functionsDir, "..", "..");

/** The route owners nothing else typechecks. */
const UNCHECKED_ROUTE_FILES = [
  "netlify/functions/booking-core.mts",
  "netlify/functions/billing-api.mts",
];

test("no route file calls a name that is not defined or imported", () => {
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

  const undefinedNames = output
    .split("\n")
    .filter((line) => line.includes("error TS2304"))
    .map((line) => line.trim());

  assert.deepEqual(
    undefinedNames,
    [],
    "These call something that does not exist. In a file nothing typechecks, " +
      `that is a ReferenceError on a live route, not a build error:\n  ${undefinedNames.join("\n  ")}`,
  );
});
