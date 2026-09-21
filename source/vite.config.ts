import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { motionLabPlugins } from "./motion-lab/vite.plugins";

export default defineConfig({
  // The motion lab's plugins serve the pose worker and MediaPipe's WASM at
  // fixed paths (/pose-worker.js, /mediapipe-wasm/) in dev and emit them into
  // dist/ on build. The video workspace's "3D motion" view needs both. See
  // motion-lab/vite.plugins.ts for why the worker is bundled by hand.
  plugins: [react(), ...motionLabPlugins()],
  define: {
    // The web build is not the app. Stated as a literal so the bundler can
    // fold `if (NATIVE)` away rather than shipping the bearer-token and
    // Capacitor paths to browsers as unreachable code. See
    // src/modules/auth/apiFetch.ts.
    __CLARITY_NATIVE__: "false",
  },
});
