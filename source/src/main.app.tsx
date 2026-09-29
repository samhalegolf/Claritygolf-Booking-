// The Capacitor entry. Same reason as src/main.tsx: the language first, then
// the portal, which is src/boot.app.tsx.
import { initI18n } from "./lib/i18n";

void initI18n().then(() => import("./boot.app"));
