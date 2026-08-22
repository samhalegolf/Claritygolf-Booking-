import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    // The web build is not the app. Stated as a literal so the bundler can
    // fold `if (NATIVE)` away rather than shipping the bearer-token and
    // Capacitor paths to browsers as unreachable code. See
    // src/modules/auth/apiFetch.ts.
    __CLARITY_NATIVE__: "false",
  },
});
