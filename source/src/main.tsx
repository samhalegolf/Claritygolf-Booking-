// The web entry. The language is loaded before any screen is imported, so every
// label -- including the ones modules build once when they load -- is in the
// reader's language from the first paint. The page itself is src/boot.tsx.
import { initI18n } from "./lib/i18n";

void initI18n().then(() => import("./boot"));
