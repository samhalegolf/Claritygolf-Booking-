import { readFile, writeFile } from "node:fs/promises";
const file = "src/App.tsx";
let text = await readFile(file, "utf8");
const start = text.indexOf("      if (data.email) setAdminEmail(data.email);");
const end = text.indexOf("      setAdminPassword(\"\");", start);
if (start < 0 || end < 0) throw new Error("patch target missing");
const next = [
  "      if (data.email) setAdminEmail(data.email);",
  "      setAuthStatus(\"authenticated\");",
  "      setAuthError(\"\");",
  "      setCalendarFeedStatus(\"checking\");",
  "      void loadAdminCalendarState()",
  "        .then(() => setCalendarFeedStatus(\"connected\"))",
  "        .catch(() => {",
  "          hasLoadedCalendarApiRef.current = false;",
  "          setCalendarFeedStatus(\"offline\");",
  "        });",
  ""
].join("\n");
text = text.slice(0, start) + next + text.slice(end);
await writeFile(file, text);
console.log("patched login gate");
