import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { json } from "./http.mts";

const functionsDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test("json answers uncached UTF-8 JSON, with repeated headers kept apart", async () => {
  const response = json({ ok: true }, 201, { "Set-Cookie": ["a=1", "b=2"] });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(response.headers.getSetCookie(), ["a=1", "b=2"]);
  assert.deepEqual(await response.json(), { ok: true });
});

test("no function file keeps its own json response helper", () => {
  const copies: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "node_modules" && name !== "local-db") walk(path);
      } else if (name.endsWith(".mts") && !name.endsWith(".test.mts") && path !== join(functionsDir, "_shared/http.mts")) {
        if (/^(?:export\s+)?function json\(/m.test(readFileSync(path, "utf8"))) copies.push(relative(functionsDir, path));
      }
    }
  };
  walk(functionsDir);
  assert.deepEqual(copies, [], "import json from _shared/http.mts instead");
});
