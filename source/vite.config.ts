import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

import { motionLabPlugins } from "./motion-lab/vite.plugins";

/**
 * Preload the page's real entry from the HTML.
 *
 * src/main.tsx loads the language first and only then imports src/boot.tsx, so
 * the built index.html names a 4 KB script and nothing else. The browser cannot
 * see boot's chunk or its stylesheet until that script has run -- and on a
 * non-English browser, not until the language file has arrived as well. Every
 * page waited through that chain before its first paint.
 *
 * This finds boot's chunk in the bundle and writes <link rel="stylesheet"> for
 * its CSS and <link rel="modulepreload"> for it and the chunks it imports into
 * the HTML head. Those downloads now start with the HTML, alongside the entry
 * script and the language, and the later import() finds them already in the
 * module map. Vite's own import helper skips a link that is already in the
 * document, so nothing is fetched twice. boot still runs only after the
 * language is loaded; it is the download that moves earlier, not the run.
 */
const preloadBoot = (): Plugin => ({
  name: "clarity-preload-boot",
  transformIndexHtml: {
    order: "post",
    handler(_html, { bundle }) {
      if (!bundle) return [];
      // By the modules it holds, not facadeModuleId: React and the shared
      // helpers are merged into this chunk, and Rollup leaves the facade id
      // null on a chunk whose exports are more than its entry's.
      const boot = Object.values(bundle).find(
        (output) => output.type === "chunk" && output.moduleIds.some((id) => id.endsWith("/src/boot.tsx")),
      );
      if (!boot || boot.type !== "chunk") return [];

      const scripts: string[] = [];
      const styles: string[] = [];
      const seen = new Set<string>();
      // Same order as Vite's own preload list: a chunk's imports and their
      // CSS first, then its own CSS, so the cascade is what the import gives.
      const walk = (fileName: string) => {
        if (seen.has(fileName)) return;
        seen.add(fileName);
        const chunk = bundle[fileName];
        if (!chunk || chunk.type !== "chunk") return;
        // The entry is already the page's <script>.
        if (!chunk.isEntry) scripts.push(fileName);
        chunk.imports.forEach(walk);
        chunk.viteMetadata?.importedCss.forEach((css) => {
          if (!styles.includes(css)) styles.push(css);
        });
      };
      walk(boot.fileName);

      return [
        ...styles.map((href) => ({
          tag: "link",
          attrs: { rel: "stylesheet", href: `/${href}` },
          injectTo: "head" as const,
        })),
        ...scripts.map((href) => ({
          tag: "link",
          attrs: { rel: "modulepreload", crossorigin: true, href: `/${href}` },
          injectTo: "head" as const,
        })),
      ];
    },
  },
});

export default defineConfig({
  // The motion lab's plugins serve the pose worker and MediaPipe's WASM at
  // fixed paths (/pose-worker.js, /mediapipe-wasm/) in dev and emit them into
  // dist/ on build. The video workspace's "3D motion" view needs both. See
  // motion-lab/vite.plugins.ts for why the worker is bundled by hand.
  plugins: [react(), ...motionLabPlugins(), preloadBoot()],
  define: {
    // The web build is not the app. Stated as a literal so the bundler can
    // fold `if (NATIVE)` away rather than shipping the bearer-token and
    // Capacitor paths to browsers as unreachable code. See
    // src/modules/auth/apiFetch.ts.
    __CLARITY_NATIVE__: "false",
  },
});
