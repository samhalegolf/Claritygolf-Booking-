import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The native build.
 *
 * Same source tree as vite.config.ts -- this is not a second app, it is a
 * second door into the same one. The differences are all here rather than in
 * the code:
 *
 *   - `root: app/` picks up app/index.html, whose only script is
 *     src/main.app.tsx. Rollup follows that graph, so the coach workspace is
 *     never the entry; it comes along only as the lazy chunk the portal's
 *     booking panel loads.
 *   - `base: "./"` because the webview serves from capacitor://localhost,
 *     where a root-absolute asset path is a gamble.
 *   - __CLARITY_NATIVE__ tells apiFetch.ts to carry a bearer token instead of
 *     a cookie, and VITE_API_BASE tells it where to send it. Override the
 *     origin with VITE_API_BASE=... npm run build:app to point a build at a
 *     Netlify deploy preview.
 *
 *     It is a bare define rather than a VITE_ env var so that it substitutes
 *     as a literal at each use site. Vite hoists import.meta.env into one
 *     runtime object, which would leave every `if (NATIVE)` in the web build
 *     as a live branch shipping code no browser can reach. vite.config.ts
 *     defines the same name as false.
 *
 * The output is dist-app/, which is Capacitor's webDir. The web build still
 * writes dist/ and is untouched by any of this.
 */
export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL("./app", import.meta.url)),
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  base: "./",
  define: {
    __CLARITY_NATIVE__: "true",
    "import.meta.env.VITE_API_BASE": JSON.stringify(
      process.env.VITE_API_BASE || "https://claritygolf.app",
    ),
  },
  build: {
    outDir: fileURLToPath(new URL("./dist-app", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    // The entry lives in ../src, outside this root.
    fs: { allow: [fileURLToPath(new URL(".", import.meta.url))] },
  },
});
