import { createReadStream, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build as esbuild } from "esbuild";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const POSE_WORKER_ROUTE = "/pose-worker.js";
const POSE_WORKER_ENTRY = fileURLToPath(
  new URL("./src/observe/mediapipe/poseWorker.ts", import.meta.url)
);

/**
 * Bundle the pose worker ourselves, as a classic script.
 *
 * `@mediapipe/tasks-vision` loads its WASM with `importScripts`, which exists
 * only in CLASSIC workers -- in a module worker the library falls through to a
 * branch wanting a `document` and dies with "ModuleFactory not set".
 *
 * Vite cannot give us a classic worker in dev. `worker.format: "iife"` applies
 * to BUILD only; the dev server rewrites every `?worker` import to
 * `new Worker(url, { type: "module" })` unconditionally. So a lab that worked
 * when built would fail every time in dev, which is where all the work
 * happens.
 *
 * Bundling it here with esbuild -- which Vite already depends on -- gives the
 * same classic IIFE in both, and removes the divergence rather than
 * documenting it.
 */
const poseWorker = (): Plugin => {
  const bundle = async () => {
    const result = await esbuild({
      entryPoints: [POSE_WORKER_ENTRY],
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      write: false,
      logLevel: "silent",
    });
    return result.outputFiles[0].text;
  };

  return {
    name: "clarity-pose-worker",

    configureServer(server) {
      server.middlewares.use(POSE_WORKER_ROUTE, async (_request, response, next) => {
        try {
          // Rebuilt per request. esbuild takes tens of milliseconds and the
          // worker is constructed once per analysis run, so caching this would
          // buy nothing and cost a stale-bundle bug.
          const code = await bundle();
          response.setHeader("Content-Type", "text/javascript");
          response.end(code);
        } catch (error) {
          server.config.logger.error(
            `[clarity-pose-worker] ${error instanceof Error ? error.message : String(error)}`
          );
          next();
        }
      });
    },

    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: POSE_WORKER_ROUTE.slice(1),
        source: await bundle(),
      });
    },
  };
};

const MEDIAPIPE_WASM_DIR = fileURLToPath(
  new URL("../node_modules/@mediapipe/tasks-vision/wasm/", import.meta.url)
);

const WASM_ROUTE = "/mediapipe-wasm";

const CONTENT_TYPES: Record<string, string> = {
  ".wasm": "application/wasm",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
};

/**
 * Serve MediaPipe's WASM from node_modules, at a stable path.
 *
 * `FilesetResolver.forVisionTasks(root)` wants a DIRECTORY containing both the
 * .wasm binaries and their .js loaders, fetched by name at runtime. That rules
 * out Vite's `?url` asset handling, which hashes each file individually and
 * would leave the loader unable to find its own binary.
 *
 * Pointing it at a CDN would also work, and would also mean the lab stops
 * working on a train. These files are already on disk, pinned by
 * package.json -- so they are served verbatim from there in dev, and copied
 * into the bundle on build.
 */
const mediapipeWasm = (): Plugin => ({
  name: "clarity-mediapipe-wasm",

  configureServer(server) {
    server.middlewares.use(WASM_ROUTE, (request, response, next) => {
      // Strip any query, and refuse anything trying to climb out of the
      // directory -- this middleware is reading from node_modules.
      const name = decodeURIComponent((request.url ?? "/").split("?")[0]).replace(/^\//, "");
      if (!name || name.includes("/") || name.includes("..")) return next();

      const file = join(MEDIAPIPE_WASM_DIR, name);
      response.setHeader(
        "Content-Type",
        CONTENT_TYPES[extname(name)] ?? "application/octet-stream"
      );
      createReadStream(file)
        .on("error", () => next())
        .pipe(response);
    });
  },

  generateBundle() {
    for (const name of readdirSync(MEDIAPIPE_WASM_DIR)) {
      this.emitFile({
        type: "asset",
        fileName: `${WASM_ROUTE.slice(1)}/${name}`,
        source: readFileSync(join(MEDIAPIPE_WASM_DIR, name)),
      });
    }
  },
});

/**
 * The motion lab.
 *
 * A separate door with a separate room behind it. Unlike vite.app.config.ts,
 * which is a second entry into the SAME source tree, this config's root
 * contains its own `src/` and reaches into nothing else:
 *
 *   - `root: motion-lab/` picks up motion-lab/index.html, whose only script
 *     is motion-lab/src/app/main.tsx. Rollup follows that graph and it never
 *     touches ../src, so nothing the booking app does can break a lab build
 *     and nothing the lab does can end up in a booking bundle.
 *   - `three` is a devDependency for the same reason. If it ever appears in
 *     dist/ or dist-app/, something has imported across the wall.
 *   - Output is dist-lab/, which is nobody's webDir and is not deployed.
 *
 * The lab is NOT in the root tsconfig's `include`, so `npm run typecheck` and
 * `npm run build` do not compile it. Use `npm run typecheck:lab`.
 */
export default defineConfig({
  plugins: [react(), mediapipeWasm(), poseWorker()],
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL("./dist-lab", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5180,
    // The lab is self-contained; refuse to serve anything above its own root
    // so an accidental import across the wall fails loudly in dev too.
    fs: { strict: true },
  },
});
