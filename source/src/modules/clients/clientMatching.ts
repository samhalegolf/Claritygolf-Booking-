import { dialCodeFor, canonicalPhoneKey as sharedCanonicalPhoneKey } from "../../lib/activeCountry";
import { t } from "../../lib/i18n";
import { browserBase64, safeText } from "../../lib/text";
import type { BillingCoupon, BillingInvoiceRecord, PosTransaction } from "../billing/types";
import { CalendarItem, itemWeek } from "../calendar/calendarModel";
import { NotificationRecord } from "../notifications/notificationModel";
import { CADDY_APP_URL, defaultWorkspaceAccountFromCoachAccount } from "../workspace/workspaceModel";
import {
  cleanPeople as cleanPeopleWith,
  type PeopleImportDiagnostic,
  type Person,
} from "./clientsModel";

/**
 * Finding a client: matching a booking's name, email and phone to someone
 * already on the list, client search, and reading a spreadsheet import.
 */

export type ClientSummary = Person & {
  count: number;
  next: CalendarItem | null;
  last: CalendarItem | null;
};

export type ClientMergeFieldKey = "name" | "email" | "phone" | "notes";

export type ClientMergeReview = {
  survivor: ClientSummary;
  loser: ClientSummary;
  fields: Record<ClientMergeFieldKey, string>;
};

export function cleanPeople(people: unknown[]): Person[] {
  return cleanPeopleWith(people, defaultWorkspaceAccountFromCoachAccount().id);
}

export type PeopleImportResult = {
  ok?: boolean;
  imported?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  failed?: number;
  errors?: Array<{ rowNumber?: string | number; name?: string; message?: string; reason?: string }>;
  people?: Person[];
};

export type PeopleUpdateResult = {
  person: Person;
  people: Person[];
};


export type ClientEditor = Pick<Person, "id" | "name" | "email" | "phone" | "notes" | "caddyProfileId" | "caddyProfileUrl">;

export type ClientProfileTab = "bookings" | "notes" | "notifications" | "transactions" | "passes";

// One row of a client's money history: a counter/Optix sale, or an invoice
// they were billed on (or included in, for a bulk invoice).
export type ClientTransactionRow =
  | { kind: "sale"; date: string; sale: PosTransaction }
  | { kind: "invoice"; date: string; invoice: BillingInvoiceRecord }
  // A gift voucher is on this list for a reason the other two are not: it is
  // usually bought by somebody who will never spend it, so the buyer's name is
  // the only thing anybody remembers when a card turns up without its code.
  | { kind: "coupon"; date: string; coupon: BillingCoupon };

type ClientMatchInput = {
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
};

type MatchableClient = Pick<Person, "name" | "email" | "phone">;

export function normalizeMatchText(value: unknown = "") {
  return safeText(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizePhoneDigits(value: unknown = "") {
  return safeText(value).replace(/\D/g, "");
}

// Identity. Must agree with the server exactly — when these two disagreed about
// whether "+64274637700" and "0274637700" were the same person, the server
// created a duplicate contact and the resulting unique-index collision failed
// the coach's whole calendar save. Both sides now call the same function.
// This was hardcoded to New Zealand ("64"); it is now country-aware.
function canonicalPhoneKey(value: unknown = "") {
  return sharedCanonicalPhoneKey(safeText(value));
}

// Fuzzy search, not identity. Deliberately generous: it powers type-ahead over
// the client list, where a coach may type any fragment of a number in any
// format. Seeded with the canonical key so the international and national
// spellings of a number always find each other.
function phoneVariants(value: unknown = "") {
  const digits = normalizePhoneDigits(value);
  const variants = new Set<string>();
  const canonical = normalizePhoneDigits(canonicalPhoneKey(value));
  if (canonical) variants.add(canonical);
  if (digits) variants.add(digits);
  const callingCode = normalizePhoneDigits(dialCodeFor());
  if (callingCode && digits.startsWith(callingCode) && digits.length > callingCode.length) {
    variants.add(`0${digits.slice(callingCode.length)}`);
    variants.add(digits.slice(callingCode.length));
  }
  if (digits.startsWith("0") && digits.length > 1) {
    if (callingCode) variants.add(`${callingCode}${digits.slice(1)}`);
    variants.add(digits.slice(1));
  }
  if (digits.length > 8) variants.add(digits.slice(-8));
  if (digits.length > 7) variants.add(digits.slice(-7));
  return Array.from(variants).filter(Boolean);
}

function matchesSequentialValue(source: string, query: string) {
  if (!source || !query) return false;
  if (source.includes(query) || query.includes(source)) return true;
  let queryIndex = 0;
  for (const char of source) {
    if (char === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return false;
}

export function phoneValuesMatch(source = "", query = "", exact = false) {
  const sourceVariants = phoneVariants(source);
  const queryVariants = phoneVariants(query);
  if (!sourceVariants.length || !queryVariants.length) return false;

  return sourceVariants.some((sourceValue) =>
    queryVariants.some((queryValue) => {
      if (!sourceValue || !queryValue) return false;
      if (exact) {
        if (sourceValue === queryValue) return true;
        const tailLength = Math.min(sourceValue.length, queryValue.length, 8);
        return tailLength >= 7 && sourceValue.slice(-tailLength) === queryValue.slice(-tailLength);
      }
      return queryValue.length >= 4 && matchesSequentialValue(sourceValue, queryValue);
    }),
  );
}

export function bookingInputName(input: ClientMatchInput) {
  return safeText(input.name ?? [input.firstName, input.lastName].filter(Boolean).join(" ")).trim();
}

export function splitClientName(name: string) {
  const parts = safeText(name).trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
}

export function hasClientMatchInput(input: ClientMatchInput) {
  return (
    normalizeMatchText(bookingInputName(input)).length >= 2 ||
    normalizeMatchText(input.email ?? "").length >= 3 ||
    normalizePhoneDigits(input.phone ?? "").length >= 4
  );
}

function clientMatchesInput(client: MatchableClient, input: ClientMatchInput, exact = false) {
  const clientName = normalizeMatchText(client.name);
  const clientEmail = normalizeMatchText(client.email);
  const inputName = normalizeMatchText(bookingInputName(input));
  const inputEmail = normalizeMatchText(input.email ?? "");

  if (exact) {
    return (
      (inputEmail.length > 0 && clientEmail === inputEmail) ||
      phoneValuesMatch(client.phone, input.phone ?? "", true) ||
      (inputName.length > 0 && clientName === inputName)
    );
  }

  return (
    (inputEmail.length >= 3 && matchesSequentialValue(clientEmail, inputEmail)) ||
    phoneValuesMatch(client.phone, input.phone ?? "") ||
    (inputName.length >= 2 && matchesSequentialValue(clientName, inputName))
  );
}

export function findClientMatch<T extends MatchableClient>(clients: T[], input: ClientMatchInput, exact = false) {
  if (!hasClientMatchInput(input)) return null;
  const exactMatch = clients.find((client) => clientMatchesInput(client, input, true));
  if (exact || exactMatch) return exactMatch ?? null;
  return clients.find((client) => clientMatchesInput(client, input)) ?? null;
}

export function clientMatchesSearchTerm(client: Pick<Person, "name" | "email" | "phone" | "notes" | "source">, term: string) {
  const rawTerm = safeText(term).trim().toLowerCase();
  if (!rawTerm) return true;
  return clientSearchText(client).includes(rawTerm) || clientMatchesInput(client, { name: term, email: term, phone: term });
}

export function clientKey(name = "", email = "", phone = "") {
  const normalizedEmail = normalizeMatchText(email);
  if (normalizedEmail) return `email:${normalizedEmail}`;
  return `name:${normalizeMatchText(name)}|phone:${canonicalPhoneKey(phone)}`;
}

function clientNotificationKeys(name = "", email = "", phone = "") {
  return new Set(
    [
      normalizeMatchText(email) ? `email:${normalizeMatchText(email)}` : "",
      canonicalPhoneKey(phone) ? `phone:${canonicalPhoneKey(phone)}` : "",
      normalizeMatchText(name) ? `name:${normalizeMatchText(name)}` : "",
    ].filter(Boolean),
  );
}

/* The two "everything belonging to this person" filters.
 *
 * They live out here, taking their inputs, because two screens need the same
 * answer: the client profile modal and the player profile's tab bar. Written
 * once so the modal and the profile can never disagree about which bookings
 * are whose.
 */
export function appointmentsForPerson(
  person: Pick<Person, "id" | "name" | "email" | "phone">,
  items: CalendarItem[],
  inCoachScope: (item: CalendarItem) => boolean,
) {
  const key = clientKey(person.name, person.email, person.phone);
  return items
    .filter((item) => item.kind === "appointment")
    .filter(inCoachScope)
    .filter((item) =>
      item.personId
        ? item.personId === person.id
        : clientKey(item.client || item.title, item.email ?? "", item.phone ?? "") === key,
    )
    .sort((a, b) => itemWeek(a) - itemWeek(b) || a.day - b.day || a.start - b.start);
}

export function notificationsForPerson(
  person: Pick<Person, "name" | "email" | "phone">,
  notifications: NotificationRecord[],
  personAppointments: CalendarItem[],
) {
  const keys = clientNotificationKeys(person.name, person.email, person.phone);
  const appointmentIds = new Set(personAppointments.map((appointment) => appointment.id));
  const personEmail = safeText(person.email).trim().toLowerCase();
  return notifications
    .filter((notification) => {
      const isClientFacing =
        notification.kind.includes("client") ||
        Boolean(personEmail && safeText(notification.recipient).toLowerCase() === personEmail);
      if (!isClientFacing || notification.kind.includes("admin")) return false;
      return (
        keys.has(notification.personKey) ||
        appointmentIds.has(notification.calendarItemId) ||
        Boolean(personEmail && safeText(notification.recipient).toLowerCase() === personEmail)
      );
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function profileIdsForClient(client: Pick<Person, "id" | "email" | "phone">) {
  const ids = new Set<string>();
  const id = safeText(client.id).trim();
  const email = safeText(client.email).trim().toLowerCase();
  const phone = canonicalPhoneKey(client.phone);
  if (id) ids.add(id);
  if (email) {
    ids.add(email);
    const encodedEmail = browserBase64(email);
    if (encodedEmail) ids.add(`email-${encodedEmail}`);
  }
  if (phone) ids.add(`phone-${phone}`);
  return ids;
}

export function hasAnyProfileId(ids: Set<string>, client: Pick<Person, "id" | "email" | "phone">) {
  for (const id of profileIdsForClient(client)) {
    if (ids.has(id)) return true;
  }
  return false;
}

export function preferredVideoPlayerId(client: Pick<Person, "id" | "email" | "phone">, videoIds: Set<string>) {
  for (const id of profileIdsForClient(client)) {
    if (videoIds.has(id)) return id;
  }
  return safeText(client.id);
}

export function caddyProfileUrl(
  person: Pick<Person, "name" | "email" | "caddyProfileUrl" | "caddyProfileId">,
  workspaceUrl = CADDY_APP_URL,
) {
  const caddyProfileUrlValue = safeText(person.caddyProfileUrl).trim();
  const caddyProfileIdValue = safeText(person.caddyProfileId).trim();
  const emailValue = safeText(person.email).trim();
  const nameValue = safeText(person.name).trim();
  if (caddyProfileUrlValue) return caddyProfileUrlValue;
  const url = new URL(workspaceUrl || CADDY_APP_URL);
  if (caddyProfileIdValue) url.searchParams.set("profile", caddyProfileIdValue);
  if (emailValue) url.searchParams.set("email", emailValue);
  if (nameValue) url.searchParams.set("name", nameValue);
  return url.toString();
}

function isBookingGeneratedProfileNote(client: Pick<Person, "notes" | "source">) {
  const note = safeText(client.notes).trim().toLowerCase().replace(/\.+$/, "");
  const source = safeText(client.source).toLowerCase();
  return note === "booked from public booking page" && source.includes("appointment");
}

export function profileNotesText(client: Pick<Person, "notes" | "source">) {
  return isBookingGeneratedProfileNote(client) ? "" : safeText(client.notes);
}

function clientSearchText(client: Pick<Person, "name" | "email" | "phone" | "notes" | "source">) {
  return [client.name, client.email, client.phone, profileNotesText(client)]
    .map((value) => safeText(value))
    .join(" ")
    .toLowerCase();
}

export function editorFromClient(client: ClientSummary): ClientEditor {
  return {
    id: client.id,
    name: client.name,
    email: client.email,
    phone: client.phone,
    notes: profileNotesText(client),
    caddyProfileId: client.caddyProfileId,
    caddyProfileUrl: client.caddyProfileUrl,
  };
}

function parseDelimitedLine(line: string) {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  const delimiter = line.includes("\t") ? "\t" : ",";

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }

  cells.push(cell.trim());
  return cells;
}

function normalizeImportHeader(header: string) {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parsePeopleImport(text: string): Person[] {
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
        id: `import-${Date.now()}-${index}`,
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
}

export const PEOPLE_IMPORT_ENDPOINT = "/api/people/import-lite";

function importNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function importErrorMessages(result: PeopleImportResult) {
  return Array.isArray(result.errors)
    ? result.errors
        .map((error) =>
          [
            error.rowNumber !== undefined ? t("Row {rowNumber}", { rowNumber: error.rowNumber }) : error.name,
            error.message || error.reason,
          ].filter(Boolean).join(": "),
        )
        .filter(Boolean)
        .slice(0, 4)
    : [];
}

export function buildPeopleImportDiagnostic(
  endpoint: string,
  status: number,
  ok: boolean,
  result: PeopleImportResult,
  fallbackMessage: string,
): PeopleImportDiagnostic {
  const imported = importNumber(result.imported ?? result.created);
  const updated = importNumber(result.updated);
  const skipped = importNumber(result.skipped);
  const errors = importErrorMessages(result);
  const failed = importNumber(result.failed ?? errors.length);
  const summary = `${imported} imported, ${updated} updated, ${skipped} skipped${failed ? `, ${failed} failed` : ""}`;
  return {
    endpoint,
    status,
    ok,
    imported,
    updated,
    skipped,
    failed,
    errors,
    message: ok ? summary : errors[0] || fallbackMessage,
  };
}

export const emptyClientEditor: ClientEditor = {
  id: "",
  name: "",
  email: "",
  phone: "",
  notes: "",
  caddyProfileId: "",
  caddyProfileUrl: "",
};
