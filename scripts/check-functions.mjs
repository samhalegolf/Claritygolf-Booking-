import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const functionsDir = resolve("netlify/functions");
const candidates = (await readdir(functionsDir))
  .filter((name) => name.endsWith(".mts"))
  .sort();
const entries = [];
for (const name of candidates) {
  const source = await readFile(join(functionsDir, name), "utf8");
  if (source.includes("export default") && source.includes("export const config")) {
    entries.push(join(functionsDir, name));
  }
}
if (!entries.length) throw new Error("No Netlify function entry files were found.");

const outdir = await mkdtemp(join(tmpdir(), "clarity-functions-"));
try {
  await build({
    entryPoints: entries,
    outdir,
    entryNames: "[name]",
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    packages: "bundle",
    logLevel: "warning",
  });

  for (const entry of entries) {
    const output = join(outdir, `${basename(entry, ".mts")}.cjs`);
    const module = require(output);
    const handler = module.default ?? module;
    if (typeof handler !== "function") {
      throw new Error(`${basename(entry)} does not export a default Netlify handler.`);
    }
    if (!module.config || (!module.config.path && !module.config.schedule)) {
      throw new Error(`${basename(entry)} does not export a usable Netlify config.`);
    }
  }
  console.log(`Bundled and imported ${entries.length} Netlify functions successfully.`);
} finally {
  await rm(outdir, { recursive: true, force: true });
}
