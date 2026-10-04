import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { cleanString, cleanText, safeJsonStringify, trimmedEnv } from "./values.mts";

const functionsDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test("cleanString keeps a cleared value blank; cleanText falls back", () => {
  assert.equal(cleanString("   ", "Busy"), "");
  assert.equal(cleanText("   ", "Busy"), "Busy");
  assert.equal(cleanString(42, "Busy"), "Busy");
  assert.equal(cleanText(42, "Busy"), "Busy");
  assert.equal(cleanString("  abcdef  ", "", 3), "abc");
  assert.equal(cleanText("  abcdef  ", "", 3), "abc");
});

test("safeJsonStringify writes a shared object every time it appears", () => {
  // It used to mark the second appearance "[Circular]", which is how the
  // public slots answer once had to copy every slot to stay readable.
  const slots = [{ start: 540 }];
  assert.equal(safeJsonStringify({ slots, services: { a: { slots } } }), '{"slots":[{"start":540}],"services":{"a":{"slots":[{"start":540}]}}}');
});

test("safeJsonStringify still survives a real cycle and a bigint", () => {
  const node: Record<string, unknown> = { name: "a" };
  node.self = node;
  assert.equal(safeJsonStringify({ node, count: 12n }), '{"node":{"name":"a","self":"[Circular]"},"count":12}');
});

test("trimmedEnv drops whitespace pasted around a value", () => {
  process.env.VALUES_TEST_KEY = "  sk_test_123 \n";
  try {
    assert.equal(trimmedEnv("VALUES_TEST_KEY"), "sk_test_123");
    assert.equal(trimmedEnv("VALUES_TEST_MISSING", " fallback "), "fallback");
  } finally {
    delete process.env.VALUES_TEST_KEY;
  }
});

/**
 * These helpers were copied into some forty files, and the copies had drifted:
 * different default lengths, and some treating a blank string as "not given"
 * while others kept it. One copy each lives in values.mts now.
 */
test("no function file keeps its own copy of the value helpers", () => {
  // account.mts sits underneath values.mts, and clarity-cloud-google-config's
  // env takes an injectable reader for its tests; both are deliberate.
  const allowed = new Set(["_shared/values.mts", "_shared/account.mts:env", "_shared/clarity-cloud-google-config.mts:env"]);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "node_modules" && name !== "local-db") walk(path);
      } else if (name.endsWith(".mts") && !name.endsWith(".test.mts")) {
        files.push(path);
      }
    }
  };
  walk(functionsDir);
  const copies: string[] = [];
  for (const path of files) {
    const file = relative(functionsDir, path);
    if (allowed.has(file)) continue;
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/^(?:export\s+)?function (env|nowIso|hasOwn|cleanString|cleanText|cleanSlug)\(/gm)) {
      if (!allowed.has(`${file}:${match[1]}`)) copies.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(copies, [], "import these from _shared/values.mts instead");
});
