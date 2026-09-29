import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// @ts-expect-error -- a plain .mjs script, shared with the command line.
import { extractKeys, localeFiles, placeholders } from "../scripts/i18n-keys.mjs";
import { LANGUAGES } from "./lib/i18n";

/**
 * Every language is complete, and every translation fills in the same blanks
 * as its English.
 *
 * A missing sentence would not break anything -- it shows in English -- which
 * is exactly why it needs a test: nothing else would ever notice. To fill the
 * gaps, `node scripts/i18n-keys.mjs --missing` lists them per language.
 */

const { keys, problems } = extractKeys() as { keys: Set<string>; problems: string[] };

test("every t() call has a plain string key", () => {
  assert.deepEqual(problems, [], "t() must be given the English sentence itself, not a variable");
});

test("every language on offer has a catalog, and every catalog is on offer", () => {
  const files = (localeFiles() as { code: string }[]).map((entry) => entry.code).sort();
  const offered = LANGUAGES.map((option) => option.code).filter((code) => code !== "en").sort();
  assert.deepEqual(files, offered);
});

for (const { code, file } of localeFiles() as { code: string; file: string }[]) {
  const catalog = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;

  test(`${code}: every sentence is translated`, () => {
    const missing = [...keys].filter((key) => !catalog[key]);
    assert.equal(missing.length, 0, `${missing.length} missing, e.g. ${JSON.stringify(missing.slice(0, 5))}`);
  });

  test(`${code}: no translations for sentences the app no longer uses`, () => {
    const stale = Object.keys(catalog).filter((key) => !keys.has(key));
    assert.equal(stale.length, 0, `${stale.length} stale (node scripts/i18n-keys.mjs --prune), e.g. ${JSON.stringify(stale.slice(0, 5))}`);
  });

  test(`${code}: every translation keeps its {placeholders}`, () => {
    const broken = Object.entries(catalog)
      .filter(([key, value]) => keys.has(key) && placeholders(key).join() !== placeholders(value).join())
      .map(([key, value]) => `${key} -> ${value}`);
    assert.deepEqual(broken, []);
  });
}
