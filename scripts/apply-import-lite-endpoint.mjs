import { readFileSync, writeFileSync } from "node:fs";

const sourcePath = new URL("../src/csv-import-enhancer.ts", import.meta.url);
let source = readFileSync(sourcePath, "utf8");
const before = `async function importCheckedPeople(people: CsvPerson[]) {
  const response = await fetch("/api/people/import", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ people: peoplePayload(people) }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || \`${response.status} ${response.statusText}\`);
  }
  return response.json().catch(() => ({}));
}`;

const after = `async function importCheckedPeople(people: CsvPerson[]) {
  const response = await fetch("/api/people/import-lite", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ people: peoplePayload(people) }),
  });
  const text = await response.text().catch(() => "");
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!response.ok) {
    throw new Error(data?.message || data?.error || text || \`${response.status} ${response.statusText}\`);
  }
  return data;
}`;

if (source.includes(after)) {
  process.exit(0);
}
if (!source.includes(before)) {
  console.warn("import-lite patch target not found");
  process.exit(0);
}
source = source.replace(before, after);
writeFileSync(sourcePath, source);
