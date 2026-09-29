// Every English sentence Clarity puts in a client email or text, read from the
// source: each mt("...") call under netlify/functions and src, plus the default message
// templates and map-link label in _shared/notification-templates.mts.
//
//   node scripts/message-keys.mjs            how many, and what each language is missing
//   node scripts/message-keys.mjs --missing  the missing ones, as JSON per language
//   node scripts/message-keys.mjs --prune    drop translations nothing uses any more
//   node scripts/message-keys.mjs --merge <lang> <file.json>
//                                            add translations from a JSON file
//
// netlify/functions/_shared/message-language.test.mts runs the same checks.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FUNCTIONS = path.join(ROOT, "netlify", "functions");
const SRC = path.join(ROOT, "src");
const TEMPLATES = path.join(FUNCTIONS, "_shared", "notification-templates.mts");
export const MESSAGE_LOCALES = path.join(FUNCTIONS, "_shared", "message-locales");

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return ["node_modules", "message-locales", "local-db", "locales"].includes(entry) ? [] : sourceFiles(full);
    return /\.m?tsx?$/.test(entry) && !/\.test\.m?tsx?$/.test(entry) ? [full] : [];
  });
}

const isText = (node) => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

export function extractMessageKeys() {
  const keys = new Set();
  const problems = [];
  for (const file of [...sourceFiles(FUNCTIONS), ...sourceFiles(SRC)]) {
    const text = readFileSync(file, "utf8");
    const isTemplates = file === TEMPLATES;
    if (!isTemplates && !/\bmt\(/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "mt") {
        const first = node.arguments[0];
        if (first && isText(first)) keys.add(first.text);
        else {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
          problems.push(`${path.relative(ROOT, file)}:${line + 1} ${node.getText().slice(0, 80)}`);
        }
      }
      // The default templates and map-link label are translated as a whole.
      if (isTemplates && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
          ["DEFAULT_NOTIFICATION_TEMPLATES", "DEFAULT_MAP_LINK_LABEL"].includes(node.name.text) && node.initializer) {
        const collect = (inner) => {
          if (isText(inner) && inner.text.trim()) keys.add(inner.text);
          ts.forEachChild(inner, collect);
        };
        collect(node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { keys, problems };
}

// Each catalog is a .mts module holding one JSON object, so the functions
// bundle, the browser and the tests all load it the same way.
const HEADER = "// Generated from the translations; English is the key. See ../message-language.mts.\n";

export function readCatalog(file) {
  const text = readFileSync(file, "utf8");
  const match = text.match(/=\s*(\{[\s\S]*\});\s*\n\s*export default/);
  return match ? JSON.parse(match[1]) : {};
}

export function writeCatalog(file, catalog) {
  const sorted = Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(file, `${HEADER}const catalog: Record<string, string> = ${JSON.stringify(sorted, null, 2)};\n\nexport default catalog;\n`);
}

export function messageLocaleFiles() {
  return readdirSync(MESSAGE_LOCALES)
    .filter((entry) => entry.endsWith(".mts"))
    .map((entry) => ({ code: entry.replace(/\.mts$/, ""), file: path.join(MESSAGE_LOCALES, entry) }));
}

export function placeholders(text) {
  return [...String(text).matchAll(/\{+(\w+)\}+/g)].map((match) => match[0]).sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { keys, problems } = extractMessageKeys();
  const [mode, lang, source] = process.argv.slice(2);
  if (mode === "--merge") {
    const file = path.join(MESSAGE_LOCALES, `${lang}.mts`);
    writeCatalog(file, { ...readCatalog(file), ...JSON.parse(readFileSync(source, "utf8")) });
  }
  const missing = {};
  for (const { code, file } of messageLocaleFiles()) {
    const catalog = readCatalog(file);
    if (mode === "--prune") writeCatalog(file, Object.fromEntries(Object.entries(catalog).filter(([key]) => keys.has(key))));
    missing[code] = [...keys].filter((key) => !catalog[key]);
  }
  if (mode === "--missing") process.stdout.write(JSON.stringify(missing, null, 2) + "\n");
  else {
    console.log(`${keys.size} keys`);
    for (const [code, list] of Object.entries(missing)) console.log(`${code}: ${list.length} missing`);
    if (problems.length) console.log(`\nmt() calls without a plain string key:\n${problems.join("\n")}`);
  }
}
