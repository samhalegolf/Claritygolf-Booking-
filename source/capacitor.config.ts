import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.claritygolf.player",
  appName: "Clarity Player",
  // Written by `npm run build:app`. Never dist/ -- that is the coach web build.
  webDir: "dist-app",
  ios: {
    // The nav and the login card handle their own safe-area padding in
    // src/nativeApp.css, so the webview should span the whole screen.
    contentInset: "never",
  },
  android: {
    // No cleartext anywhere: the API is https and so is the local scheme.
    allowMixedContent: false,
  },
  server: {
    androidScheme: "https",
  },
};

export default config;
