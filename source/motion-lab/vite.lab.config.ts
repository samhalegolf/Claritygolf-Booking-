import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { motionLabPlugins } from "./vite.plugins";

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
 *   - The wall is one-way. The booking app's vite.config.ts imports the lab's
 *     plugins (vite.plugins.ts) and its video workspace lazy-loads
 *     src/embed/MotionLabView, so `three` DOES appear in dist/ -- in the
 *     lab's own chunk, loaded when a coach opens 3D motion. The lab itself
 *     still imports nothing from ../src; contracts/boundary.test.ts checks.
 *   - Output is dist-lab/, which is nobody's webDir and is not deployed.
 *
 * The lab is NOT in the root tsconfig's `include`. `npm run typecheck` still
 * reaches whatever embed/MotionLabView imports, because tsc follows imports,
 * but the tests, the synthetic source and the standalone shell it does not.
 * `npm run typecheck:lab` covers all of it.
 */
export default defineConfig({
  plugins: [react(), ...motionLabPlugins()],
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
