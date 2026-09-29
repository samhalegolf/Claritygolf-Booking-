import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- a plain .mjs script, shared with the command line.
import { extractMessageKeys, messageLocaleFiles, placeholders, readCatalog } from "../../../scripts/message-keys.mjs";
import { MESSAGE_LANGUAGES, cleanMessageLanguage, translateMessage } from "./message-language.mts";
import { notificationTemplateText } from "./notification-templates.mts";

/**
 * Every language a business can send in is complete, and keeps every blank.
 *
 * A missing sentence would still send -- in English, in the middle of a
 * Spanish email -- which is exactly why it needs a test. To fill the gaps,
 * `node scripts/message-keys.mjs --missing` lists them per language.
 */

const { keys, problems } = extractMessageKeys() as { keys: Set<string>; problems: string[] };
const locales = messageLocaleFiles() as { code: string; file: string }[];

test("every mt() call has a plain string key", () => {
  assert.deepEqual(problems, []);
});

test("every language on offer has a catalog, and every catalog is on offer", () => {
  assert.deepEqual(
    locales.map((entry) => entry.code).sort(),
    MESSAGE_LANGUAGES.map((option) => option.code).filter((code) => code !== "en").sort(),
  );
});

for (const { code, file } of locales) {
  const catalog = readCatalog(file) as Record<string, string>;

  test(`${code}: every sentence is translated`, () => {
    const missing = [...keys].filter((key) => !catalog[key]);
    assert.equal(missing.length, 0, `${missing.length} missing, e.g. ${JSON.stringify(missing.slice(0, 5))}`);
  });

  test(`${code}: no translations for sentences no message uses any more`, () => {
    const stale = Object.keys(catalog).filter((key) => !keys.has(key));
    assert.equal(stale.length, 0, `${stale.length} stale (node scripts/message-keys.mjs --prune), e.g. ${JSON.stringify(stale.slice(0, 5))}`);
  });

  test(`${code}: every translation keeps its {placeholders} and {{merge fields}}`, () => {
    const broken = Object.entries(catalog)
      .filter(([key, value]) => keys.has(key) && placeholders(key).join() !== placeholders(value).join())
      .map(([key, value]) => `${key} -> ${value}`);
    assert.deepEqual(broken, []);
  });
}

test("an unknown language sends English", () => {
  assert.equal(cleanMessageLanguage("xx"), "en");
  assert.equal(translateMessage("xx", "Booking details"), "Booking details");
});

test("a {placeholder} is filled but a {{merge field}} is left for the template renderer", () => {
  assert.equal(translateMessage("en", "Hi {name}, see {{date}}", { name: "Ana", date: "never" }), "Hi Ana, see {{date}}");
});

test("the coach's own wording is sent as written, whatever the language", () => {
  const templates = { booked: { subject: "Tu clase", heading: "", body: "", cta: "", signoff: "", smsText: "" } };
  assert.equal(notificationTemplateText(templates as never, "booked", "subject", "de"), "Tu clase");
});
