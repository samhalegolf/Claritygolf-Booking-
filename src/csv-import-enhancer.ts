type CsvField = "" | "name" | "firstName" | "lastName" | "email" | "phone" | "notes" | "caddyProfileUrl" | "caddyProfileId";

type CsvAnalysis = {
  headers: string[];
  rows: string[][];
  mapping: Record<number, CsvField>;
  people: Array<{ name: string; email: string; phone: string; notes: string; caddyProfileUrl: string; caddyProfileId: string }>;
  warnings: string[];
  hasHeader: boolean;
};

const fieldOptions: Array<{ value: CsvField; label: string }> = [
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

function normaliseHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function guessDelimiter(text: string) {
  const sample = text.split(/\r?\n/).slice(0, 8).join("\n");
  return [",", "\t", ";"]
    .map((delimiter) => ({ delimiter, count: [...sample].filter((char) => char === delimiter).length }))
    .sort((a, b) => b.count - a.count)[0]?.delimiter || ",";
}

function parseCsv(text: string) {
  const delimiter = guessDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const input = text.replace(/^\uFEFF/, "");

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
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
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function inferField(header: string, index: number, samples: string[]): CsvField {
  const key = normaliseHeader(header);
  const direct = new Map<string, CsvField>([
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
    ["caddyprofileurl", "caddyProfileUrl"],
    ["caddyurl", "caddyProfileUrl"],
    ["caddyprofileid", "caddyProfileId"],
    ["caddyid", "caddyProfileId"],
  ]);
  if (direct.has(key)) return direct.get(key) || "";
  if (key.includes("email")) return "email";
  if (key.includes("phone") || key.includes("mobile") || key.includes("cell")) return "phone";
  if (key.includes("first")) return "firstName";
  if (key.includes("last") || key.includes("surname")) return "lastName";
  if (key.includes("name")) return "name";
  if (key.includes("note") || key.includes("comment")) return "notes";
  if (key.includes("url")) return "caddyProfileUrl";

  const sampleValues = samples.map((value) => value.trim()).filter(Boolean);
  if (sampleValues.some((value) => /@/.test(value))) return "email";
  if (sampleValues.some((value) => /(?:\+?\d[\d\s().-]{6,})/.test(value))) return "phone";
  if (index === 0) return "name";
  if (index === 1) return "email";
  if (index === 2) return "phone";
  if (index === 3) return "notes";
  return "";
}

function analyse(text: string, manualMapping: Record<number, CsvField> = {}): CsvAnalysis {
  const rawRows = parseCsv(text);
  if (!rawRows.length) return { headers: [], rows: [], mapping: {}, people: [], warnings: [], hasHeader: false };
  const firstRowGuesses = rawRows[0].map((cell, index) => inferField(cell, index, rawRows.slice(1, 6).map((row) => row[index] || "")));
  const hasHeader = firstRowGuesses.some(Boolean) && rawRows.length > 1;
  const headers = hasHeader ? rawRows[0] : rawRows[0].map((_, index) => `Column ${index + 1}`);
  const rows = hasHeader ? rawRows.slice(1) : rawRows;
  const mapping = Object.fromEntries(
    headers.map((header, index) => [
      index,
      manualMapping[index] !== undefined
        ? manualMapping[index]
        : inferField(header, index, rows.slice(0, 5).map((row) => row[index] || "")),
    ]),
  ) as Record<number, CsvField>;

  const people = rows
    .map((row) => {
      const record: Record<string, string> = {};
      row.forEach((value, index) => {
        const field = mapping[index];
        if (!field) return;
        record[field] = [record[field], value].filter(Boolean).join(field === "notes" ? " | " : " ").trim();
      });
      const joinedName = [record.firstName, record.lastName].filter(Boolean).join(" ").trim();
      const name = (record.name || joinedName).trim();
      const email = (record.email || "").trim().toLowerCase();
      if (!name && !email) return null;
      return {
        name: name || email,
        email,
        phone: (record.phone || "").trim(),
        notes: (record.notes || "").trim(),
        caddyProfileUrl: (record.caddyProfileUrl || "").trim(),
        caddyProfileId: (record.caddyProfileId || "").trim(),
      };
    })
    .filter(Boolean) as CsvAnalysis["people"];

  const warnings: string[] = [];
  if (!Object.values(mapping).some((field) => field === "name" || field === "firstName" || field === "lastName")) {
    warnings.push("No name column detected. Email will be used as name where possible.");
  }
  if (!Object.values(mapping).includes("email")) warnings.push("No email column detected.");
  if (people.some((person) => !person.email)) warnings.push("Some clients do not have an email address.");
  if (!people.length) warnings.push("No importable clients found yet.");
  return { headers, rows, mapping, people, warnings, hasHeader };
}

function csvCell(value: string) {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function toCanonicalCsv(people: CsvAnalysis["people"]) {
  return [
    "name,email,phone,notes,caddyProfileUrl,caddyProfileId",
    ...people.map((person) =>
      [person.name, person.email, person.phone, person.notes, person.caddyProfileUrl, person.caddyProfileId]
        .map(csvCell)
        .join(","),
    ),
  ].join("\n");
}

function textareaValueSet(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function enhanceCard(card: HTMLElement) {
  if (card.dataset.csvEnhanced === "true") return;
  const textarea = card.querySelector("textarea") as HTMLTextAreaElement | null;
  if (!textarea) return;
  card.dataset.csvEnhanced = "true";

  let currentText = "";
  let currentMapping: Record<number, CsvField> = {};

  const panel = document.createElement("div");
  panel.className = "csv-enhancer";
  panel.innerHTML = `
    <div class="csv-enhancer-uploader">
      <label class="outline-button csv-enhancer-upload">
        Upload CSV
        <input type="file" accept=".csv,text/csv,text/plain" />
      </label>
      <span>No CSV chosen</span>
    </div>
    <div class="csv-enhancer-checkpoint" hidden></div>
  `;
  textarea.insertAdjacentElement("beforebegin", panel);

  const fileInput = panel.querySelector("input") as HTMLInputElement;
  const fileName = panel.querySelector(".csv-enhancer-uploader span") as HTMLElement;
  const checkpoint = panel.querySelector(".csv-enhancer-checkpoint") as HTMLElement;

  function render() {
    const analysis = analyse(currentText, currentMapping);
    checkpoint.hidden = !currentText;
    if (!currentText) return;
    checkpoint.innerHTML = `
      <div class="csv-enhancer-summary">
        <strong>${analysis.people.length} clients ready</strong>
        <span>${analysis.hasHeader ? "Header row detected" : "No header row detected"}</span>
      </div>
      ${analysis.warnings.length ? `<div class="csv-enhancer-warnings">${analysis.warnings.map((warning) => `<span>${warning}</span>`).join("")}</div>` : ""}
      <div class="csv-enhancer-grid">
        ${analysis.headers
          .map(
            (header, index) => `
              <label>
                <span>${header || `Column ${index + 1}`}</span>
                <select data-csv-column="${index}">
                  ${fieldOptions.map((option) => `<option value="${option.value}"${analysis.mapping[index] === option.value ? " selected" : ""}>${option.label}</option>`).join("")}
                </select>
                <em>${analysis.rows.slice(0, 2).map((row) => row[index]).filter(Boolean).join(" / ") || "No sample"}</em>
              </label>
            `,
          )
          .join("")}
      </div>
      <div class="csv-enhancer-preview">
        ${analysis.people
          .slice(0, 5)
          .map((person) => `<div><strong>${person.name}</strong><span>${[person.email, person.phone].filter(Boolean).join(" · ") || "No email or phone"}</span></div>`)
          .join("")}
      </div>
      <button class="primary-button csv-enhancer-confirm" type="button"${analysis.people.length ? "" : " disabled"}>Use this checked CSV</button>
    `;
  }

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    currentText = await file.text();
    currentMapping = analyse(currentText).mapping;
    fileName.textContent = file.name;
    textareaValueSet(textarea, currentText);
    render();
  });

  textarea.addEventListener("input", () => {
    currentText = textarea.value;
    currentMapping = analyse(currentText).mapping;
    fileName.textContent = currentText ? "Pasted CSV" : "No CSV chosen";
    render();
  });

  checkpoint.addEventListener("change", (event) => {
    const select = event.target as HTMLSelectElement;
    const column = select.dataset.csvColumn;
    if (column === undefined) return;
    currentMapping = { ...currentMapping, [Number(column)]: select.value as CsvField };
    render();
  });

  checkpoint.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest(".csv-enhancer-confirm");
    if (!button) return;
    const canonical = toCanonicalCsv(analyse(currentText, currentMapping).people);
    textareaValueSet(textarea, canonical);
    currentText = canonical;
    currentMapping = analyse(canonical).mapping;
    render();
  });
}

function scan() {
  document.querySelectorAll<HTMLElement>(".import-card").forEach(enhanceCard);
}

window.addEventListener("load", scan);
const observer = new MutationObserver(scan);
observer.observe(document.documentElement, { childList: true, subtree: true });
scan();
