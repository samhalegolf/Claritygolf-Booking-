import { build } from "esbuild";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    packages: "bundle",
    // Keep pg external for this import smoke-check. Bundling pg into ESM
    // rewrites its CommonJS require('events') calls and fails before the
    // function can be inspected. Netlify still bundles/deploys the function
    // normally; this script only verifies handler/config exports.
    external: ["pg"],
    logLevel: "warning",
  });

  for (const entry of entries) {
    const output = join(outdir, `${basename(entry, ".mts")}.js`);
    const module = await import(`${pathToFileURL(output).href}?check=${Date.now()}`);
    if (typeof module.default !== "function") {
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
