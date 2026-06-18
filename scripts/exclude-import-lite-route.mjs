import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../netlify/functions/booking-api.mts", import.meta.url);
let source = readFileSync(path, "utf8");

if (!source.includes('"/api/people/import-lite"')) {
  source = source.replace('    "/api/people/migrate",', '    "/api/people/import-lite",\n    "/api/people/migrate",');
  writeFileSync(path, source);
}
