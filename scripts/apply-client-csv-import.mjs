import { readFileSync, writeFileSync } from "node:fs";

const appPath = new URL("../src/App.tsx", import.meta.url);
let source = readFileSync(appPath, "utf8");
let changed = false;

function replaceOnce(label, before, after) {
  if (source.includes(after)) return;
  if (!source.includes(before)) {
    console.warn(`[client-csv-import] skipped ${label}: target not found`);
    return;
  }
  source = source.replace(before, after);
  changed = true;
  console.log(`[client-csv-import] applied ${label}`);
}

replaceOnce(
  "import field types",
  `function parseDelimitedLine(line: string) {`,
  `type ImportField = "" | "name" | "firstName" | "lastName" | "email" | "phone" | "notes" | "caddyProfileId" | "caddyProfileUrl";

type PeopleImportAnalysis = {
  hasHeader: boolean;
  headers: string[];
  rows: string[][];
  mapping: Record<number, ImportField>;
  people: Person[];
  warnings: string[];
};

const importFieldOptions: Array<{ value: ImportField; label: string }> = [
  { value: "", label: "Ignore" },
  { value: "name", label: "Full name" },
  { value: "firstName", label: "First name" },
  { value: "lastName", label: "Last name" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "notes", label: "Notes" },
  { value: "caddyProfileUrl", label: "Caddy profile URL" },
  { value: "caddyProfileId", label: "Caddy profile ID" },
];

function parseDelimitedLine(line: string) {`,
);

replaceOnce(
  "robust CSV import analysis",
  `function parsePeopleImport(text: string): Person[] {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseDelimitedLine);
  if (!rows.length) return [];

  const headerKeys = new Map([
    ["name", "name"],
    ["fullname", "name"],
    ["client", "name"],
    ["firstname", "firstName"],
    ["first", "firstName"],
    ["lastname", "lastName"],
    ["last", "lastName"],
    ["email", "email"],
    ["emailaddress", "email"],
    ["phone", "phone"],
    ["mobile", "phone"],
    ["notes", "notes"],
    ["note", "notes"],
    ["caddyprofileid", "caddyProfileId"],
    ["caddyid", "caddyProfileId"],
    ["caddyprofileurl", "caddyProfileUrl"],
    ["caddyurl", "caddyProfileUrl"],
  ]);
  const firstRowKeys = rows[0].map((cell) => headerKeys.get(normalizeImportHeader(cell)) || "");
  const hasHeader = firstRowKeys.some(Boolean);
  const headings = hasHeader ? firstRowKeys : ["name", "email", "phone", "notes", "caddyProfileUrl", "caddyProfileId"];
  const bodyRows = hasHeader ? rows.slice(1) : rows;

  return bodyRows
    .map((row, index) => {
      const record = Object.fromEntries(headings.map((heading, cellIndex) => [heading, row[cellIndex] || ""]));
      const joinedName = [record.firstName, record.lastName].filter(Boolean).join(" ");
      const name = String(record.name || joinedName).trim();
      const email = String(record.email || "").trim().toLowerCase();
      if (!name && !email) return null;
      return {
        id: \`import-\${Date.now()}-\${index}\`,
        name: name || email,
        email,
        phone: String(record.phone || "").trim(),
        notes: String(record.notes || "").trim(),
        source: "manual_import",
        caddyProfileId: String(record.caddyProfileId || "").trim(),
        caddyProfileUrl: String(record.caddyProfileUrl || "").trim(),
      };
    })
    .filter(Boolean) as Person[];
}`,
  `function guessCsvDelimiter(text: string) {
  const sample = text.split(/\r?\n/).slice(0, 8).join("\n");
  const delimiters = [",", "\t", ";"];
  return delimiters
    .map((delimiter) => ({ delimiter, count: [...sample].filter((char) => char === delimiter).length }))
    .sort((a, b) => b.count - a.count)[0]?.delimiter || ",";
}

function parseCsvRows(text: string) {
  const delimiter = guessCsvDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const normalised = text.replace(/^\\uFEFF/, "");

  for (let index = 0; index < normalised.length; index += 1) {
    const char = normalised[index];
    const next = normalised[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell.trim());
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell.trim());
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function inferImportField(header: string, index: number, sampleValues: string[]): ImportField {
  const key = normalizeImportHeader(header);
  const direct = new Map<string, ImportField>([
    ["name", "name"],
    ["fullname", "name"],
    ["client", "name"],
    ["customer", "name"],
    ["customername", "name"],
    ["firstname", "firstName"],
    ["first", "firstName"],
    ["givenname", "firstName"],
    ["lastname", "lastName"],
    ["surname", "lastName"],
    ["last", "lastName"],
    ["familyname", "lastName"],
    ["email", "email"],
    ["emailaddress", "email"],
    ["mail", "email"],
    ["phone", "phone"],
    ["mobile", "phone"],
    ["cell", "phone"],
    ["telephone", "phone"],
    ["notes", "notes"],
    ["note", "notes"],
    ["comment", "notes"],
    ["comments", "notes"],
    ["caddyprofileid", "caddyProfileId"],
    ["caddyid", "caddyProfileId"],
    ["caddyprofileurl", "caddyProfileUrl"],
    ["caddyurl", "caddyProfileUrl"],
  ]);
  if (direct.has(key)) return direct.get(key) ?? "";
  if (key.includes("email")) return "email";
  if (key.includes("phone") || key.includes("mobile") || key.includes("cell")) return "phone";
  if (key.includes("first")) return "firstName";
  if (key.includes("last") || key.includes("surname")) return "lastName";
  if (key.includes("name")) return "name";
  if (key.includes("note") || key.includes("comment")) return "notes";
  if (key.includes("url")) return "caddyProfileUrl";

  const samples = sampleValues.map((value) => value.trim()).filter(Boolean);
  if (samples.some((value) => /@/.test(value))) return "email";
  if (samples.some((value) => /(?:\\+?\\d[\\d\\s().-]{6,})/.test(value))) return "phone";
  if (index === 0) return "name";
  if (index === 1) return "email";
  if (index === 2) return "phone";
  if (index === 3) return "notes";
  return "";
}

function analysePeopleImport(text: string, manualMapping: Record<number, ImportField> = {}): PeopleImportAnalysis {
  const rows = parseCsvRows(text);
  if (!rows.length) return { hasHeader: false, headers: [], rows: [], mapping: {}, people: [], warnings: [] };

  const firstRowGuesses = rows[0].map((cell, index) => inferImportField(cell, index, rows.slice(1, 6).map((row) => row[index] || "")));
  const hasHeader = firstRowGuesses.some((field) => field !== "") && rows.length > 1;
  const headers = hasHeader ? rows[0] : rows[0].map((_, index) => \`Column \${index + 1}\`);
  const bodyRows = hasHeader ? rows.slice(1) : rows;
  const mapping = Object.fromEntries(
    headers.map((header, index) => [
      index,
      manualMapping[index] !== undefined
        ? manualMapping[index]
        : hasHeader
          ? inferImportField(header, index, bodyRows.slice(0, 5).map((row) => row[index] || ""))
          : inferImportField(header, index, bodyRows.slice(0, 5).map((row) => row[index] || "")),
    ]),
  ) as Record<number, ImportField>;

  const people = bodyRows
    .map((row, index) => {
      const record: Record<string, string> = {};
      row.forEach((value, cellIndex) => {
        const field = mapping[cellIndex];
        if (!field) return;
        record[field] = [record[field], value].filter(Boolean).join(field === "notes" ? " | " : " ").trim();
      });
      const joinedName = [record.firstName, record.lastName].filter(Boolean).join(" ");
      const name = String(record.name || joinedName).trim();
      const email = String(record.email || "").trim().toLowerCase();
      if (!name && !email) return null;
      return {
        id: \`import-\${Date.now()}-\${index}\`,
        name: name || email,
        email,
        phone: String(record.phone || "").trim(),
        notes: String(record.notes || "").trim(),
        source: "csv_import",
        caddyProfileId: String(record.caddyProfileId || "").trim(),
        caddyProfileUrl: String(record.caddyProfileUrl || "").trim(),
      } satisfies Person;
    })
    .filter(Boolean) as Person[];

  const warnings: string[] = [];
  if (!Object.values(mapping).some((field) => field === "name" || field === "firstName" || field === "lastName")) {
    warnings.push("No name column was detected. Email will be used as the name where possible.");
  }
  if (!Object.values(mapping).includes("email")) warnings.push("No email column was detected.");
  if (!people.length) warnings.push("No importable clients found yet.");
  if (people.some((person) => !person.email)) warnings.push("Some clients have no email address.");

  return { hasHeader, headers, rows: bodyRows, mapping, people, warnings };
}

function parsePeopleImport(text: string): Person[] {
  return analysePeopleImport(text).people;
}`,
);

replaceOnce(
  "client import states",
  '  const [peopleImportText, setPeopleImportText] = useState("");\n  const [peopleImportState, setPeopleImportState] = useState<"idle" | "importing" | "imported">("idle");',
  '  const [peopleImportText, setPeopleImportText] = useState("");\n  const [peopleImportFileName, setPeopleImportFileName] = useState("");\n  const [peopleImportMapping, setPeopleImportMapping] = useState<Record<number, ImportField>>({});\n  const [peopleImportState, setPeopleImportState] = useState<"idle" | "importing" | "imported">("idle");',
);

replaceOnce(
  "client import analysis memo",
  '  const peopleImportPreview = useMemo(() => parsePeopleImport(peopleImportText).length, [peopleImportText]);',
  '  const peopleImportAnalysis = useMemo(\n    () => analysePeopleImport(peopleImportText, peopleImportMapping),\n    [peopleImportMapping, peopleImportText],\n  );\n  const peopleImportPreview = peopleImportAnalysis.people.length;',
);

replaceOnce(
  "csv upload handler",
  `  async function importPeopleFromText() {`,
  `  async function handlePeopleCsvUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv") && !file.type.includes("csv") && !file.type.includes("text")) {
      setToast({ message: "Choose a CSV file exported from your contacts or spreadsheet." });
      return;
    }
    try {
      const text = await file.text();
      const analysis = analysePeopleImport(text);
      setPeopleImportFileName(file.name);
      setPeopleImportText(text);
      setPeopleImportMapping(analysis.mapping);
      setPeopleImportState("idle");
      setShowClientImport(true);
      setToast({ message: \`${analysis.people.length} possible clients found. Check the field mapping before importing.\` });
    } catch {
      setToast({ message: "Could not read that CSV file." });
    }
  }

  function updatePeopleImportText(value: string) {
    const analysis = analysePeopleImport(value);
    setPeopleImportState("idle");
    setPeopleImportFileName(value ? "Pasted CSV" : "");
    setPeopleImportText(value);
    setPeopleImportMapping(analysis.mapping);
  }

  async function importPeopleFromText() {`,
);

replaceOnce(
  "import uses checked analysis",
  '    const parsedPeople = parsePeopleImport(peopleImportText);\n    if (!parsedPeople.length) {\n      setToast({ message: "Paste at least one person with a name or email." });',
  '    const parsedPeople = peopleImportAnalysis.people;\n    if (!parsedPeople.length) {\n      setToast({ message: "Upload a CSV or map at least one name or email field first." });',
);

replaceOnce(
  "reset import state after import",
  '      setPeopleImportText("");\n      setShowClientImport(false);',
  '      setPeopleImportText("");\n      setPeopleImportFileName("");\n      setPeopleImportMapping({});\n      setShowClientImport(false);',
);

const oldClientImport = `                <textarea
                  value={peopleImportText}
                  onChange={(event) => {
                    setPeopleImportState("idle");
                    setPeopleImportText(event.target.value);
                  }}
                  placeholder="name,email,phone,notes,caddyProfileUrl"
                />
                <div className="import-actions">
                  <span>{peopleImportPreview} ready</span>
                  <button
                    className="primary-button"
                    onClick={importPeopleFromText}
                    disabled={peopleImportState === "importing" || peopleImportPreview === 0}
                  >
                    {peopleImportState === "importing" ? "Importing" : peopleImportState === "imported" ? "Imported" : "Import"}
                  </button>
                </div>`;

const newClientImport = `                <div className="csv-import-uploader">
                  <label className="outline-button logo-upload">
                    <Upload size={16} />
                    Upload CSV
                    <input accept=".csv,text/csv,text/plain" onChange={handlePeopleCsvUpload} type="file" />
                  </label>
                  <span>{peopleImportFileName || "No CSV chosen"}</span>
                </div>
                <textarea
                  value={peopleImportText}
                  onChange={(event) => updatePeopleImportText(event.target.value)}
                  placeholder="Or paste CSV here: name,email,phone,notes,caddyProfileUrl"
                />
                {peopleImportText && (
                  <div className="csv-import-checkpoint">
                    <div className="csv-import-summary">
                      <strong>{peopleImportPreview} clients ready</strong>
                      <span>{peopleImportAnalysis.hasHeader ? "Header row detected" : "No header row detected"}</span>
                    </div>
                    {peopleImportAnalysis.warnings.length > 0 && (
                      <div className="csv-import-warnings">
                        {peopleImportAnalysis.warnings.map((warning) => <span key={warning}>{warning}</span>)}
                      </div>
                    )}
                    <div className="csv-mapping-grid">
                      {peopleImportAnalysis.headers.map((header, index) => (
                        <label key={\`field-\${index}-\${header}\`}>
                          <span>{header || \`Column \${index + 1}\`}</span>
                          <select
                            value={peopleImportAnalysis.mapping[index] || ""}
                            onChange={(event) =>
                              setPeopleImportMapping((current) => ({ ...current, [index]: event.target.value as ImportField }))
                            }
                          >
                            {importFieldOptions.map((option) => (
                              <option key={option.value || "ignore"} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                          <em>{peopleImportAnalysis.rows.slice(0, 2).map((row) => row[index]).filter(Boolean).join(" / ") || "No sample"}</em>
                        </label>
                      ))}
                    </div>
                    {peopleImportAnalysis.people.length > 0 && (
                      <div className="csv-preview-table">
                        {peopleImportAnalysis.people.slice(0, 5).map((person) => (
                          <div key={person.id}>
                            <strong>{person.name}</strong>
                            <span>{[person.email, person.phone].filter(Boolean).join(" · ") || "No email or phone"}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div className="import-actions">
                  <span>{peopleImportPreview} ready after mapping check</span>
                  <button
                    className="primary-button"
                    onClick={importPeopleFromText}
                    disabled={peopleImportState === "importing" || peopleImportPreview === 0}
                  >
                    {peopleImportState === "importing" ? "Importing" : peopleImportState === "imported" ? "Imported" : "Confirm Import"}
                  </button>
                </div>`;

source = source.split(oldClientImport).join(newClientImport);
if (source.includes(newClientImport)) {
  changed = true;
  console.log("[client-csv-import] replaced import panels");
}

const oldSettingsSummary = `<span>CSV paste</span>
                      <strong>{peopleImportPreview} ready</strong>`;
const newSettingsSummary = `<span>CSV upload</span>
                      <strong>{peopleImportFileName ? peopleImportPreview + " ready from " + peopleImportFileName : peopleImportPreview + " ready"}</strong>`;
replaceOnce("settings import summary", oldSettingsSummary, newSettingsSummary);

if (changed) writeFileSync(appPath, source);
