import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../netlify/functions/people-import-lite.mts", import.meta.url);
let source = readFileSync(path, "utf8");
const indexBlock = `  await db().sql\`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_people_email_unique
    ON people (LOWER(email))
    WHERE email IS NOT NULL AND email <> ''
  \`;
`;
if (source.includes(indexBlock)) {
  source = source.replace(indexBlock, "");
  writeFileSync(path, source);
}
