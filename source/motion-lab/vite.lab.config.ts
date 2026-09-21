import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
  plugins: [react()],
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
