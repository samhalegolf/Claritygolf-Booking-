import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const functionsDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The old `@netlify/database` package was a one-line re-export of
 * database.mts. Netlify ships that kind of package unbundled, and once
 * database.mts imported another .mts file the bundler wrote the database
 * helper over the functions themselves, so login and every scheduled job
 * stopped working. Functions import database.mts directly.
 */
test("no function imports the database through @netlify/database", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "node_modules") walk(path);
      } else if (/\.m?[jt]s$/.test(name) && !name.endsWith(".test.mts") && readFileSync(path, "utf8").includes('"@netlify/database"')) {
        offenders.push(relative(functionsDir, path));
      }
    }
  };
  walk(functionsDir);
  assert.deepEqual(offenders, [], "import getDatabase from _shared/database.mts instead");
});
