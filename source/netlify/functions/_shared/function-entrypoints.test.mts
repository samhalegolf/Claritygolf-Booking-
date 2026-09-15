import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Netlify Functions v2 -- which is what `export const config = { path }` opts a
// file into -- invokes the module's DEFAULT export with a Request and expects a
// Response back. A file that declares a path but exports only a named
// `handler(event)` in the old Lambda shape deploys without complaint and then
// has no entry point: the path is never claimed, so a POST to it falls through
// the SPA catch-all as a 404, and hitting the function URL directly is a 502.
//
// Five files were in exactly that state (the whole of /api/auth/forgot-password,
// reset-password, change-password, logout, and the calendar feed), which is why
// no password reset had left this app since June -- the route the form posts to
// did not exist. Nothing in typecheck or the test suite noticed, because each
// file is individually valid TypeScript. This test is the thing that notices.

const functionsDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Comments are prose, not code. booking-api.mts carries a warning that spells
 * out `export function handler(event)` as the thing not to do, and a scan of
 * the raw text reads that warning as the offence it warns about.
 */
function withoutComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

function routedFunctionFiles() {
  return readdirSync(functionsDir)
    .filter((name) => name.endsWith(".mts") && !name.endsWith(".test.mts"))
    .map((name) => ({
      name,
      source: withoutComments(readFileSync(join(functionsDir, name), "utf8")),
    }))
    .filter((file) => file.source.includes("export const config"));
}

test("every function that claims a path has a default export to serve it", () => {
  const missing = routedFunctionFiles()
    .filter((file) => !/export\s+default/.test(file.source))
    .map((file) => file.name);

  assert.deepEqual(
    missing,
    [],
    `these declare a config.path but export no default handler, so the path is dead: ${missing.join(", ")}`,
  );
});

test("no routed function is still written against the old Lambda event shape", () => {
  // The giveaway is a handler taking `event` rather than a Request. Such a file
  // also carries its own requestFromEvent/lambdaResponse adapters, so this
  // catches a half-converted file that kept the scaffolding.
  const legacy = routedFunctionFiles()
    .filter(
      (file) =>
        /function\s+handler\s*\(\s*event/.test(file.source) ||
        file.source.includes("requestFromEvent") ||
        file.source.includes("statusCode:"),
    )
    .map((file) => file.name);

  assert.deepEqual(
    legacy,
    [],
    `these still speak the Lambda event/statusCode dialect v2 does not call: ${legacy.join(", ")}`,
  );
});

test("the routed functions this test is guarding are actually present", () => {
  // Without this, a rename or a move would turn both checks above into a pair
  // of assertions over an empty list that pass while guarding nothing.
  const names = routedFunctionFiles().map((file) => file.name);

  assert.ok(names.length >= 10, `expected the functions directory, found ${names.length} routed files`);
  for (const required of [
    "auth-forgot-password.mts",
    "auth-reset-password.mts",
    "auth-login.mts",
    "calendar-feed.mts",
  ]) {
    assert.ok(names.includes(required), `${required} is no longer a routed function`);
  }
});
