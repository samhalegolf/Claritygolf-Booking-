import { type Dispatch, type SetStateAction, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { safeText } from "../../lib/text";
import type { AuthStatus } from "../auth/authStatus";
import type { BillingInvoiceRecord, PosBookingPayment } from "../billing/types";
import type { CalendarItem, QuickCreateState } from "../calendar/calendarModel";
import type { NotificationRecord } from "../notifications/notificationModel";
import type { CoverableService, InvoicedLesson, Pass, PassGrant, PassTemplate } from "../passes/PassesPanel";
import { type PlayerProfilesLocalState, stampNotesUpdate } from "../player-profiles/playerProfilesStore";
import type { PlayerProfileTool } from "../player-profiles/playerTools";
import type { Service } from "../services/serviceModel";
import type { View } from "../shared/appView";
import type { Toast } from "../shared/toast";
import type { CoachAccount, CoachProfile } from "../workspace/workspaceModel";
import {
  appointmentsForPerson,
  cleanPeople,
  type ClientEditor,
  type ClientProfileTab,
  type ClientSummary,
  type ClientTransactionRow,
  editorFromClient,
  notificationsForPerson,
  PeopleUpdateResult,
} from "./clientMatching";
import type { InvoicedBookingLink } from "./clientProfileModel";
import type { Person } from "./clientsModel";

export type ClientProfileControllerInputs = {
  selectedClient: ClientSummary | null;
  items: CalendarItem[];
  itemInCoachScope: (item: CalendarItem) => boolean;
  coachAccount: CoachAccount;
  coachProfiles: CoachProfile[];
  isAdminUser: boolean;
  services: Service[];
  serviceScopeCoachId: string;
  notifications: NotificationRecord[];
  selectPlayerProfileTool: (client: Pick<Person, "id" | "name">, tool?: PlayerProfileTool) => void;
  setActiveView: Dispatch<SetStateAction<View>>;
  closeClientModal: () => void;
  setQuickCreate: Dispatch<SetStateAction<QuickCreateState | null>>;
  closeCalendarDetails: () => void;
  posPaidBookings: Record<string, PosBookingPayment>;
  invoicedBookingIds: Record<string, InvoicedBookingLink>;
  selectedClientId: string;
  readApiFailure: (response: Response, fallback: string) => Promise<string>;
  setClientPasses: Dispatch<SetStateAction<Pass[]>>;
  setClientPassesLoadState: Dispatch<SetStateAction<"idle" | "loading" | "loaded" | "error">>;
  setToast: Dispatch<SetStateAction<Toast | null>>;
  setClientEditor: Dispatch<SetStateAction<ClientEditor>>;
  setClientEditMode: Dispatch<SetStateAction<boolean>>;
  setClientSaveState: Dispatch<SetStateAction<"idle" | "saving" | "saved">>;
  clientEditor: ClientEditor;
  setAuthStatus: (next: AuthStatus) => void;
  setPeople: (items: Person[]) => void;
  setSelectedClientId: Dispatch<SetStateAction<string>>;
  setPlayerProfilesLocal: Dispatch<SetStateAction<PlayerProfilesLocalState>>;
  setIsAddingClient: Dispatch<SetStateAction<boolean>>;
  isAddingClient: boolean;
  clientEditMode: boolean;
  clientMoveSavingId: string;
  moveExternalClientToMain: (client: ClientSummary) => Promise<void>;
  openVideoAnalysisForClient: (client: { id: string; name: string; savedVideoId?: string; pairedSavedVideoId?: string; startRecording?: boolean; lessonId?: string; lessonTitle?: string; initialVideoFile?: File; }) => void;
  videoPlayerIds: Set<string>;
  clientProfileTab: ClientProfileTab;
  setClientProfileTab: Dispatch<SetStateAction<ClientProfileTab>>;
  fetchClientPasses: (personId: string) => Promise<void>;
  clientPasses: Pass[];
  clientInvoicedLines: InvoicedLesson[];
  clientUnmatchedInvoicedLines: InvoicedLesson[];
  passTemplates: PassTemplate[];
  passCoverableServices: CoverableService[];
  clientPassesLoadState: "idle" | "loading" | "loaded" | "error";
  clientTransactionsLoadState: "idle" | "loading" | "loaded" | "error";
  fetchClientTransactions: (personId: string) => Promise<void>;
  clientTransactions: ClientTransactionRow[];
  transactionDateLabel: (value: string) => string;
  switchView: (view: View) => void;
  openInvoiceForEdit: (record: BillingInvoiceRecord) => Promise<void>;
  clientSaveState: "idle" | "saving" | "saved";
  billingWorkspaceEnabled: boolean;
  openPosCheckoutForClient: (client: ClientSummary) => void;
  caddyWorkspaceUrl: string;
  personDeleteBusyId: string;
  hardDeletePerson: (person: Pick<Person, "id" | "name" | "email">) => Promise<void>;
};

/**
 * The client profile's own logic: the client's bookings and notifications,
 * passes (grant, redeem, return, void), the edit form and its save, and the
 * Caddy link.
 *
 * Called from App because the profile opens from the Clients screen, the
 * calendar and Player Profiles. What it shares with the rest of the
 * workspace comes in through `app`.
 */
export function useClientProfileController(app: ClientProfileControllerInputs) {
  const {
    selectedClient,
    items,
    itemInCoachScope,
    coachAccount,
    coachProfiles,
    isAdminUser,
    services,
    serviceScopeCoachId,
    notifications,
    selectPlayerProfileTool,
    setActiveView,
    closeClientModal,
    setQuickCreate,
    closeCalendarDetails,
    posPaidBookings,
    invoicedBookingIds,
    selectedClientId,
    readApiFailure,
    setClientPasses,
    setClientPassesLoadState,
    setToast,
    setClientEditor,
    setClientEditMode,
    setClientSaveState,
    clientEditor,
    setAuthStatus,
    setPeople,
    setSelectedClientId,
    setPlayerProfilesLocal,
    setIsAddingClient,
  } = app;

  const [passGranting, setPassGranting] = useState(false);
  const selectedClientAppointments = useMemo(() => {
    if (!selectedClient) return [];
    return appointmentsForPerson(selectedClient, items, itemInCoachScope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coachAccount, coachProfiles, isAdminUser, items, selectedClient, services, serviceScopeCoachId]);

  const selectedClientNotifications = useMemo(() => {
    if (!selectedClient) return [];
    return notificationsForPerson(selectedClient, notifications, selectedClientAppointments);
  }, [notifications, selectedClient, selectedClientAppointments]);
  const hasSelectedClientCaddyProfile = Boolean(
    safeText(selectedClient?.caddyProfileId).trim() || safeText(selectedClient?.caddyProfileUrl).trim(),
  );

  function openNotesForClient(client: Pick<Person, "id" | "name">) {
    selectPlayerProfileTool(client, "notes");
    setActiveView("players");
    closeClientModal();
    setQuickCreate(null);
    closeCalendarDetails();
  }

  /* How a lesson was paid for, in one word, or nothing at all.
   *
   * Four answers off two maps the billing screens already maintain, in the
   * order that decides which is the truest: a pass credit settles through a $0
   * till sale, so it has to be read before "paid at the till" or every
   * pass-paid lesson would report as a sale of nothing. An invoice is checked
   * last because a lesson can be both invoiced and then paid, and what a coach
   * wants to see is that the money arrived.
   *
   * Silence is deliberate when nothing is known. A lesson with no record is not
   * the same as an unpaid one -- it may predate any of this, or have been
   * settled in a way the app never saw -- and stamping "Unpaid" on a client's
   * history on that basis would be an accusation the data cannot support.
   */
  function bookingPaymentBadge(bookingId: string) {
    const paid = posPaidBookings[bookingId];
    if (paid?.paymentMethodKind === "pass") return { tone: "pass", label: t("Paid with a pass") };
    if (paid) {
      return {
        tone: "money",
        label: paid.paymentMethodName ? t("Paid · {paymentMethodName}", { paymentMethodName: paid.paymentMethodName }) : t("Paid at the till"),
      };
    }
    if (invoicedBookingIds[bookingId]) return { tone: "invoiced", label: t("On an invoice") };
    return null;
  }

  async function grantClientPass(grant: PassGrant) {
    if (!selectedClientId) return;
    setPassGranting(true);
    try {
      const response = await fetch("/api/passes", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...grant, personId: selectedClientId }),
      });
      if (!response.ok) throw new Error(await readApiFailure(response, t("Could not give that pass.")));
      const data = (await response.json()) as { passes?: Pass[]; merged?: boolean };
      setClientPasses(Array.isArray(data.passes) ? data.passes : []);
      setClientPassesLoadState("loaded");
      setToast({
        message: data.merged
          ? t("Added {credits} to their existing pass.", { credits: grant.credits })
          : t("{name} given.", { name: grant.name || t("Pass") }),
      });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : t("Could not give that pass.") });
    } finally {
      setPassGranting(false);
    }
  }

  /* Spending a credit on a lesson that was never booked, and putting one back.
   *
   * Both re-read the passes from the response rather than patching state: the
   * balance is derived server-side from the allocation ledger, and a browser
   * that decremented a number locally would be inventing the one figure this
   * whole system exists to not have to trust.
   *
   * The invoiced lines are deliberately left alone. They are a record of what
   * was billed, and spending a credit does not change what was billed.
   */
  async function redeemClientPassCredit(passId: string, credits: number, note: string) {
    if (!selectedClientId) return;
    try {
      const response = await fetch("/api/passes/redeem", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personId: selectedClientId, passId, credits, note }),
      });
      if (!response.ok) throw new Error(await readApiFailure(response, t("Could not use that credit.")));
      const data = (await response.json()) as { passes?: Pass[] };
      setClientPasses(Array.isArray(data.passes) ? data.passes : []);
      setToast({ message: credits === 1 ? t("Credit used.") : t("{credits} credits used.", { credits }) });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : t("Could not use that credit.") });
    }
  }

  async function returnClientPassCredit(redemptionId: string) {
    if (!selectedClientId) return;
    try {
      const response = await fetch("/api/passes/redeem/reverse", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personId: selectedClientId, redemptionId }),
      });
      if (!response.ok) throw new Error(await readApiFailure(response, t("Could not put that credit back.")));
      const data = (await response.json()) as { passes?: Pass[] };
      setClientPasses(Array.isArray(data.passes) ? data.passes : []);
      setToast({ message: t("Credit put back.") });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : t("Could not put that credit back.") });
    }
  }

  async function voidClientPass(pass: Pass) {
    if (!window.confirm(t("Void {name}? Credits already used stay on the record.", { name: pass.name }))) return;
    try {
      const response = await fetch(`/api/passes?id=${encodeURIComponent(pass.id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(await readApiFailure(response, t("Could not void that pass.")));
      const data = (await response.json()) as { passes?: Pass[] };
      setClientPasses(Array.isArray(data.passes) ? data.passes : []);
      setToast({ message: `${pass.name} voided.` });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : t("Could not void that pass.") });
    }
  }

  function startClientEdit() {
    if (selectedClient) setClientEditor(editorFromClient(selectedClient));
    setClientEditMode(true);
    setClientSaveState("idle");
  }

  async function saveClientProfile() {
    if (!clientEditor.name.trim() && !clientEditor.email.trim()) {
      setToast({ message: t("A client needs a name or email.") });
      return;
    }
    setClientSaveState("saving");
    try {
      const response = await fetch("/api/people", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ person: clientEditor }),
      });
      if (response.status === 401) {
        setAuthStatus("guest");
        throw new Error(t("Admin login required"));
      }
      if (!response.ok) throw new Error(await readApiFailure(response, t("Client save failed")));
      const result = (await response.json()) as PeopleUpdateResult;
      if (Array.isArray(result.people)) setPeople(cleanPeople(result.people));
      if (result.person?.id) setSelectedClientId(result.person.id);
      // Stamp a device-local timestamp so notes changes surface in the Player
      // Profiles activity feed (person records carry no notes-updated time).
      if (result.person?.id && clientEditor.notes.trim().length > 0) {
        const savedId = result.person.id;
        setPlayerProfilesLocal((current) => stampNotesUpdate(current, savedId));
      }
      setIsAddingClient(false);
      setClientEditMode(false);
      setClientSaveState("saved");
      setToast({ message: t("Client profile saved.") });
      window.setTimeout(() => setClientSaveState("idle"), 1400);
    } catch (error) {
      setClientSaveState("idle");
      setToast({ message: error instanceof Error ? error.message : t("Could not save client profile.") });
    }
  }

  return {
    ...app,
    selectedClientAppointments,
    bookingPaymentBadge,
    openNotesForClient,
    passGranting,
    grantClientPass,
    voidClientPass,
    redeemClientPassCredit,
    returnClientPassCredit,
    selectedClientNotifications,
    saveClientProfile,
    startClientEdit,
    hasSelectedClientCaddyProfile,
  };
}

export type ClientProfileController = ReturnType<typeof useClientProfileController>;
