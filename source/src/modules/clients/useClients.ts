import { type ChangeEvent, type Dispatch, type SetStateAction, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import type { AuthStatus } from "../auth/authStatus";
import { type CalendarItem, itemWeek } from "../calendar/calendarModel";
import type { Toast } from "../shared/toast";
import type { WorkspaceData } from "../workspace/useWorkspaceData";
import { filterRecordsForAccount } from "../workspace/workspaceModel";
import {
  buildPeopleImportDiagnostic,
  cleanPeople,
  clientKey,
  ClientMergeFieldKey,
  ClientMergeReview,
  ClientSummary,
  parsePeopleImport,
  PEOPLE_IMPORT_ENDPOINT,
  PeopleImportResult,
} from "./clientMatching";
import type { PeopleImportDiagnostic, Person } from "./clientsModel";

/**
 * The Clients screen's list and the two bulk jobs it runs: importing people
 * from pasted text or a file, and merging duplicate clients (or moving one in
 * from another business). The people themselves live in clientsStore; this is
 * what the coach app derives from them and the state those jobs need.
 */
export function useClients({
  workspace,
  people,
  accountItems,
  itemInCoachScope,
  serviceScopeCoachId,
  setAuthStatus,
  setPeople,
  setToast,
}: {
  workspace: WorkspaceData;
  people: Person[];
  accountItems: CalendarItem[];
  itemInCoachScope: (item: CalendarItem) => boolean;
  serviceScopeCoachId: string;
  setAuthStatus: (next: AuthStatus) => void;
  setPeople: (items: Person[]) => void;
  setToast: Dispatch<SetStateAction<Toast | null>>;
}) {
  const { activeAccountId, coachAccount, coachProfiles, isAdminUser, services, setItems } = workspace;
  const [peopleImportText, setPeopleImportText] = useState("");
  const [peopleImportState, setPeopleImportState] = useState<"idle" | "importing" | "imported">("idle");
  const [peopleImportDiagnostic, setPeopleImportDiagnostic] = useState<PeopleImportDiagnostic | null>(null);
  const [showClientImport, setShowClientImport] = useState(false);
  const [clientMergeMode, setClientMergeMode] = useState(false);
  const [clientMergeSelection, setClientMergeSelection] = useState<string[]>([]);
  const [clientMergeReview, setClientMergeReview] = useState<ClientMergeReview | null>(null);
  const [clientMergeSaving, setClientMergeSaving] = useState(false);
  const [clientMergeError, setClientMergeError] = useState("");
  const [clientMoveSavingId, setClientMoveSavingId] = useState("");

  const clients = useMemo<ClientSummary[]>(() => {
    // Grouping keys off personId first — the stable backend link — and only
    // falls back to the name/email/phone heuristic (clientKey) for legacy
    // bookings saved before that link existed. Grouping by clientKey alone
    // used to split one real client across multiple cards whenever a booking
    // had a different email/phone on file (see clientKey: it keys on email
    // alone when present, ignoring phone, so a second address for the same
    // person never lined up with their existing card).
    const byId = new Map<string, ClientSummary>();
    const legacyIdByKey = new Map<string, string>();

    filterRecordsForAccount(people, activeAccountId).forEach((person) => {
      byId.set(person.id, { ...person, count: 0, next: null, last: null });
      legacyIdByKey.set(clientKey(person.name, person.email, person.phone), person.id);
    });

    accountItems
      .filter((item) => item.kind === "appointment")
      .filter(itemInCoachScope)
      .forEach((item) => {
        const name = item.client ?? item.title;
        const key = clientKey(name, item.email ?? "", item.phone ?? "");
        const id = (item.personId && byId.has(item.personId) ? item.personId : "") || legacyIdByKey.get(key) || `appointment-${key}`;
        const existing =
          byId.get(id) ??
          ({
            id,
            name,
            email: item.email ?? "",
            phone: item.phone ?? "",
            notes: "",
            source: "appointment",
            caddyProfileId: "",
            caddyProfileUrl: "",
            count: 0,
            next: null,
            last: null,
          } satisfies ClientSummary);
        const next = !existing.next || itemWeek(item) < itemWeek(existing.next) ? item : existing.next;
        byId.set(id, {
          ...existing,
          name: existing.name || name,
          email: existing.email || item.email || "",
          phone: existing.phone || item.phone || "",
          notes: existing.notes || "",
          count: existing.count + 1,
          next,
          last: item,
        });
      });

    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [accountItems, activeAccountId, coachAccount, coachProfiles, isAdminUser, people, services, serviceScopeCoachId]);

  // For the checkout's coupon search: a voucher filed under a client is found
  // by that client's name.
  const clientNamesById = useMemo(() => new Map(clients.map((client) => [client.id, client.name])), [clients]);

  const peopleImportPreview = useMemo(() => parsePeopleImport(peopleImportText).length, [peopleImportText]);

  function toggleClientMergeMode() {
    setClientMergeMode((current) => !current);
    setClientMergeSelection([]);
    setClientMergeReview(null);
    setClientMergeError("");
  }

  function toggleClientMergeSelection(client: ClientSummary) {
    if (client.id.startsWith("appointment-")) return;
    setClientMergeSelection((current) => {
      if (current.includes(client.id)) return current.filter((id) => id !== client.id);
      if (current.length >= 2) return current;
      return [...current, client.id];
    });
  }

  function openClientMergeReview() {
    if (clientMergeSelection.length !== 2) return;
    let [survivor, loser] = clientMergeSelection
      .map((id) => clients.find((client) => client.id === id))
      .filter((client): client is ClientSummary => Boolean(client));
    if (!survivor || !loser) return;
    // Merging an external booking client into a main client keeps the main
    // record, whichever was selected first: the external one is the duplicate.
    if (survivor.external === true && loser.external !== true) {
      [survivor, loser] = [loser, survivor];
    }
    setClientMergeError("");
    setClientMergeReview({
      survivor,
      loser,
      fields: {
        name: survivor.name || loser.name,
        email: survivor.email || loser.email,
        phone: survivor.phone || loser.phone,
        notes: survivor.notes || loser.notes,
      },
    });
  }

  function setClientMergeFieldChoice(field: ClientMergeFieldKey, value: string) {
    setClientMergeReview((current) => (current ? { ...current, fields: { ...current.fields, [field]: value } } : current));
  }

  function closeClientMergeReview() {
    setClientMergeReview(null);
    setClientMergeError("");
  }

  async function confirmClientMerge() {
    if (!clientMergeReview || clientMergeSaving) return;
    const { survivor, loser, fields } = clientMergeReview;
    setClientMergeSaving(true);
    setClientMergeError("");
    try {
      const response = await fetch("/api/people/merge", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ survivorId: survivor.id, loserId: loser.id, fields }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        setAuthStatus("guest");
        throw new Error(data?.message || t("Admin login expired. Sign in again before merging clients."));
      }
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.message || t("Clients could not be merged."));
      }
      if (Array.isArray(data.people)) setPeople(data.people);
      const mergedItemIds: string[] = Array.isArray(data.mergedItemIds) ? data.mergedItemIds : [];
      if (mergedItemIds.length) {
        setItems((current) =>
          current.map((item) => (mergedItemIds.includes(item.id) ? { ...item, personId: survivor.id } : item)),
        );
      }
      setToast({ message: `Merged ${loser.name || loser.email || "that client"} into ${data.person?.name || survivor.name}.` });
      setClientMergeReview(null);
      setClientMergeSelection([]);
      setClientMergeMode(false);
    } catch (error) {
      setClientMergeError(error instanceof Error ? error.message : t("Clients could not be merged."));
    } finally {
      setClientMergeSaving(false);
    }
  }

  // Moves an external booking client into the main client list. Same person id,
  // same bookings and notes — only the list they appear in changes.
  async function moveExternalClientToMain(client: ClientSummary) {
    if (clientMoveSavingId) return;
    setClientMoveSavingId(client.id);
    try {
      const response = await fetch("/api/people/set-external", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ personId: client.id, external: false }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        setAuthStatus("guest");
        throw new Error(data?.message || t("Admin login expired. Sign in again before moving clients."));
      }
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.message || t("The client could not be moved."));
      }
      if (Array.isArray(data.people)) setPeople(data.people);
      setToast({ message: t("Moved {client} to your clients.", { client: client.name || client.email || t("that client") }) });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : t("The client could not be moved.") });
    } finally {
      setClientMoveSavingId("");
    }
  }

  async function handlePeopleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const text = await file.text();
    setPeopleImportState("idle");
    setPeopleImportDiagnostic(null);
    setPeopleImportText(text);
    setShowClientImport(true);
  }

  async function importPeopleFromText() {
    const parsedPeople = parsePeopleImport(peopleImportText);
    if (!parsedPeople.length) {
      setToast({ message: t("Paste at least one person with a name or email.") });
      return;
    }

    setPeopleImportState("importing");
    setPeopleImportDiagnostic(null);
    try {
      const response = await fetch(PEOPLE_IMPORT_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ people: parsedPeople }),
      });
      const text = await response.text().catch(() => "");
      let result: PeopleImportResult = {};
      try {
        result = text ? JSON.parse(text) as PeopleImportResult : {};
      } catch {
        result = { errors: [{ message: text.slice(0, 280) || response.statusText }] };
      }
      const diagnostic = buildPeopleImportDiagnostic(
        PEOPLE_IMPORT_ENDPOINT,
        response.status,
        response.ok && result.ok !== false,
        result,
        "People import failed",
      );
      setPeopleImportDiagnostic(diagnostic);
      if (response.status === 401) {
        setAuthStatus("guest");
        throw new Error(t("Admin login required"));
      }
      if (!response.ok || result.ok === false) throw new Error(diagnostic.message);
      if (Array.isArray(result.people)) setPeople(cleanPeople(result.people));
      setPeopleImportText("");
      setShowClientImport(false);
      setPeopleImportState("imported");
      setToast({
        message: diagnostic.message,
      });
      window.setTimeout(() => setPeopleImportState("idle"), 1600);
    } catch (error) {
      setPeopleImportState("idle");
      setToast({ message: error instanceof Error ? error.message : t("Could not import people.") });
    }
  }

  return {
    peopleImportText,
    setPeopleImportText,
    peopleImportState,
    setPeopleImportState,
    peopleImportDiagnostic,
    setPeopleImportDiagnostic,
    showClientImport,
    setShowClientImport,
    clientMergeMode,
    clientMergeSelection,
    clientMergeReview,
    clientMergeSaving,
    clientMergeError,
    clientMoveSavingId,
    clients,
    clientNamesById,
    peopleImportPreview,
    toggleClientMergeMode,
    toggleClientMergeSelection,
    openClientMergeReview,
    setClientMergeFieldChoice,
    closeClientMergeReview,
    confirmClientMerge,
    moveExternalClientToMain,
    handlePeopleImportFile,
    importPeopleFromText,
  };
}

export type ClientsData = ReturnType<typeof useClients>;
