// Every English sentence the app passes to t(), read from the source.
//
//   node scripts/i18n-keys.mjs            how many keys, and what each language is missing
//   node scripts/i18n-keys.mjs --missing  the missing ones, as JSON per language, to translate
//   node scripts/i18n-keys.mjs --prune    remove translations nothing uses any more
//
// src/i18n.test.ts runs the same extraction, so a sentence added without its
// translations fails the tests rather than quietly shipping in English.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SRC = path.join(ROOT, "src");
export const LOCALES = path.join(SRC, "locales");

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "locales" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

/**
 * { keys, problems }: the keys, and every t() call whose first argument is not
 * a plain string -- a key the extraction cannot see is a sentence that can
 * never be translated.
 */
export function extractKeys() {
  const keys = new Set();
  const problems = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    if (!/\bt\(/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") {
        const first = node.arguments[0];
        if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) keys.add(first.text);
        else {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
          problems.push(`${path.relative(ROOT, file)}:${line + 1} ${node.getText().slice(0, 80)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { keys, problems };
}

export function localeFiles() {
  return readdirSync(LOCALES)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => ({ code: entry.replace(/\.json$/, ""), file: path.join(LOCALES, entry) }));
}

export function placeholders(text) {
  return [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { keys, problems } = extractKeys();
  const mode = process.argv[2];
  const missing = {};
  for (const { code, file } of localeFiles()) {
    const catalog = JSON.parse(readFileSync(file, "utf8"));
    if (mode === "--prune") {
      const kept = Object.fromEntries(Object.entries(catalog).filter(([key]) => keys.has(key)));
      writeFileSync(file, JSON.stringify(kept, null, 2) + "\n");
    }
    missing[code] = [...keys].filter((key) => !catalog[key]);
  }
  if (mode === "--missing") {
    process.stdout.write(JSON.stringify(missing, null, 2) + "\n");
  } else {
    console.log(`${keys.size} keys`);
    for (const [code, list] of Object.entries(missing)) console.log(`${code}: ${list.length} missing`);
    if (problems.length) console.log(`\nt() calls without a plain string key:\n${problems.join("\n")}`);
  }
}
