// The client record as the workspace understands it, and the one normaliser
// that turns whatever the server answered into that shape. This used to live
// in App.tsx next to everything else; it moved so the store below and the
// Clients screen can exist without importing the whole workspace.

export type Person = {
  id: string;
  accountId?: string;
  name: string;
  email: string;
  phone: string;
  notes: string;
  source: string;
  caddyProfileId: string;
  caddyProfileUrl: string;
  // TRUE for a person an inbound external booking (Optix) created. They show
  // in the external booking clients list until merged or moved into the main
  // client list. Backend-owned: set on import, changed via /api/people/set-external.
  external?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

/** What the import card shows after a run, success or not. */
export type PeopleImportDiagnostic = {
  endpoint: string;
  status: number;
  ok: boolean;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
  message: string;
};

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}

/**
 * One person, cleaned. `fallbackAccountId` is what a record with no account of
 * its own is filed under; the server sends one on every row now, so this is a
 * safety net rather than a path anything relies on.
 */
export function cleanPerson(person: Partial<Person> & { id?: unknown } = {}, fallbackAccountId = ""): Person {
  return {
    id: text(person.id),
    accountId: text(person.accountId) || fallbackAccountId,
    name: text(person.name),
    email: text(person.email),
    phone: text(person.phone),
    notes: text(person.notes),
    source: text(person.source),
    caddyProfileId: text(person.caddyProfileId),
    caddyProfileUrl: text(person.caddyProfileUrl),
    // Backend-owned flag that decides which client list a person appears in.
    // Dropping it here used to send every person to the main list, so the
    // External bookings tab always read zero no matter what the API returned.
    external: person.external === true,
    createdAt: typeof person.createdAt === "string" ? person.createdAt : undefined,
    updatedAt: typeof person.updatedAt === "string" ? person.updatedAt : undefined,
  };
}

export function cleanPeople(people: unknown[], fallbackAccountId = ""): Person[] {
  return people.map((person) => cleanPerson((person ?? {}) as Partial<Person>, fallbackAccountId));
}
