Warning: truncated output (original token count: 269834)
... 30757 bytes omitted ...

import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  CalendarDays,
  Check,
  Cloud,
  CloudOff,
  CloudUpload,
  Code2,
  CreditCard,
  Copy,
  Clock,
  Download,
  Eye,
  ExternalLink,
  FileText,
  Files,
  FolderOpen,
  GitMerge,
  GripVertical,
  ImagePlus,
  KeyRound,
  LayoutDashboard,
  Link2,
  LogOut,
  Mail,
  MapPin,
  Moon,
  MoreHorizontal,
  Package,
  Palette,
  Pause,
  Percent,
  Phone,
  Play,
  Plus,
  Pencil,
  Receipt,
  RefreshCw,
  ScissorsLineDashed,
  Search,
  Send,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  User,
  Users,
  Video,
  X,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  canonicalPhoneKey as sharedCanonicalPhoneKey,
  cleanPhoneCountry,
  dialCodeFor,
  formatPhoneForDisplay,
  getActivePhoneCountry,
  isValidPhone,
  phoneCountryOptions,
  setActivePhoneCountry,
} from "../netlify/functions/_shared/phone.mts";
import { activeCurrency, activeLocale } from "../netlify/functions/_shared/locale.mts";
import OptixIntegrationPanel from "./modules/optix/OptixIntegrationPanel";
import type {
  VideoWorkspaceNavigationContext,
  VideoWorkspaceSaveResult,
} from "./modules/video-analysis";
import {
  createIndexedDbVideoStore,
  type StoredVideoRecord,
  type VideoBlobStore,
} from "./modules/video-analysis/utils/videoBlobStore";
import type { PlayerVideo } from "./modules/video-analysis/models/Video";
import type { VideoAnalysis } from "./modules/video-analysis/models/Analysis";
import type { ComparisonSide, ComparisonWorkspaceState } from "./modules/video-analysis/utils/localPersistence";
import {
  createIndexedDbSavedVideoLibrary,
  chooseManagedLocalVideoLibrary,
  getManagedLocalVideoLibraryStatus,
  migrateSavedVideosToManagedLocalLibrary,
  moveManagedLocalVideoLibrary,
  cancelSavedVideoCloudUpload,
  importSavedVideoFromClarityCloud,
  listClarityCloudImportTransfers,
  pauseSavedVideoCloudUpload,
  reconnectManagedLocalVideoLibrary,
  removeSavedVideoCloudTransfer,
  rescanManagedLocalVideoLibrary,
  saveSavedVideoToCloud,
  verifyManagedLocalVideoLibrary,
  type ManagedLocalVideoLibraryStatus,
  type ClarityCloudImportTransfer,
  type SavedVideoItem,
  type SavedVideoLibraryStore,
} from "./modules/video-analysis/utils/savedVideoLibrary";
import {
  getClarityCloudActionLabel,
  getClarityCloudHealth,
  getLocalStorageActionLabel,
  getLocalStorageHealth,
  getSavedVideoCloudStatusLabel,
  type ClarityCloudHealth,
  type ClarityCloudAction,
  type GoogleDriveTransferStatus,
  type LocalStorageAction,
} from "./storageHealth";
import {
  loadPlayerProfilesState,
  addManualPlayer,
  stampNotesUpdate,
  type PlayerProfilesLocalState,
} from "./modules/player-profiles/playerProfilesStore";
import "./modules/player-profiles/playerProfiles.css";
import type {
  InvoiceCustomFieldPlacement,
  InvoiceCustomField,
  InvoiceSettings,
  BillingCatalogKind,
  BillingCatalogItem,
  InvoiceLineSource,
  InvoiceLine,
  InvoiceDraft,
  BillingInvoiceStatus,
  BillingInvoiceRecord,
  BillingRevenueBucket,
  BillingRevenueReport,
  BillingReportSummary,
  BillingDiscountType,
  BillingDiscount,
  BillingExpenseCategory,
  BillingExpense,
} from "./modules/billing/types";
import {
  defaultInvoiceSettings,
  cleanInvoiceSettings,
} from "./modules/billing/invoiceSettings";
import { computeInvoiceTotals, invoiceLineNet, invoiceLineGross, lineDiscountAmount } from "./modules/billing/invoiceMath";
import { BillingReportsPanel } from "./modules/billing/BillingReportsPanel";
import {
  presetRange,
  buildReportCsv,
  ALL_REPORT_SECTIONS,
  type ReportRangePreset,
  type ReportSectionKey,
} from "./modules/billing/reportsMath";
import {
  parseExpenseCsv,
  inferExpenseCsvField,
  expenseMappingByField,
  buildExpenseCandidates,
  type ExpenseCsvField,
} from "./modules/billing/expenseCsv";
import { clamp } from "./lib/number";
import { dateInputValue } from "./lib/date";
import type {
  ChangeEvent,
  CSSProperties,
  FormEvent,
  MouseEvent as ReactMouseEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  TouchEvent as ReactTouchEvent,
} from "react";

// Video analysis and voice notes are heavy, coach-only features (together well
// over a third of the client bundle). They never render on the public booking
// embed and only mount when a signed-in coach opens them, so they are split
// into their own chunks and loaded on demand — this keeps the public
// /book-a-lesson page and the initial admin paint from downloading them.
const VideoAnalysisPage = lazy(() =>
  import("./modules/video-analysis/VideoAnalysisPage").then((module) => ({ default: module.VideoAnalysisPage })),
);
const ClarityVoiceTextPanel = lazy(() =>
  import("./modules/clarity-voice/ClarityVoiceTextPanel").then((module) => ({ default: module.ClarityVoiceTextPanel })),
);

type EditableBlockStatus = "idle" | "editing" | "saving" | "saved" | "error";
type EditableBlockState = {
  status: EditableBlockStatus;
  dirty: boolean;
  errorMessage: string | null;
};

const editableBlockSavedDelayMs = 1600;

function cloneEditableValue<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultEditableEqual<T>(a: T, b: T) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function useEditableBlock<T>({
  value,
  onSave,
  isEqual = defaultEditableEqual,
}: {
  value: T;
  onSave: (draft: T) => Promise<T>;
  isEqual?: (a: T, b: T) => boolean;
}) {
  const [savedValue, setSavedValue] = useState<T>(() => cloneEditableValue(value));
  const [draftValue, setDraftValueState] = useState<T>(() => cloneEditableValue(value));
  const [state, setState] = useState<EditableBlockState>({
    status: "idle",
    dirty: false,
    errorMessage: null,
  });
  const savedTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    setSavedValue(cloneEditableValue(value));
    setState((current) => {
      if (current.dirty || current.status === "editing" || current.status === "saving" || current.status === "error") {
        return current;
      }
      setDraftValueState(cloneEditableValue(value));
      return { ...current, status: current.status === "saved" ? "saved" : "idle", errorMessage: null };
    });
  }, [value]);

  useEffect(
    () => () => {
      if (savedTimeoutRef.current !== null) window.clearTimeout(savedTimeoutRef.current);
    },
    [],
  );

  function edit() {
    if (savedTimeoutRef.current !== null) window.clearTimeout(savedTimeoutRef.current);
    setDraftValueState(cloneEditableValue(savedValue));
    setState({ status: "editing", dirty: false, errorMessage: null });
  }

  function cancel() {
    if (savedTimeoutRef.current !== null) window.clearTimeout(savedTimeoutRef.current);
    setDraftValueState(cloneEditableValue(savedValue));
    setState({ status: "idle", dirty: false, errorMessage: null });
  }

  function setDraftValue(next: T | ((current: T) => T)) {
    setDraftValueState((current) => {
      const nextValue = typeof next === "function" ? (next as (current: T) => T)(current) : next;
      setState((currentState) => ({
        status: currentState.status === "error" ? "editing" : currentState.status,
        dirty: !isEqual(nextValue, savedValue),
        errorMessage: currentState.status === "error" ? null : currentState.errorMessage,
      }));
      return nextValue;
    });
  }

  async function save() {
    if (state.status === "saving" || !state.dirty) return false;
    if (savedTimeoutRef.current !== null) window.clearTimeout(savedTimeoutRef.current);
    setState((current) => ({ ...current, status: "saving", errorMessage: null }));
    try {
      const saved = await onSave(cloneEditableValue(draftValue));
      const cleanSaved = cloneEditableValue(saved);
      setSavedValue(cleanSaved);
      setDraftValueState(cleanSaved);
      setState({ status: "saved", dirty: false, errorMessage: null });
      savedTimeoutRef.current = window.setTimeout(() => {
        setState((current) => (current.status === "saved" ? { ...current, status: "idle" } : current));
      }, editableBlockSavedDelayMs);
      return true;
    } catch (error) {
      setState({
        status: "error",
        dirty: true,
        errorMessage: error instanceof Error ? error.message : "Could not save these settings.",
      });
      return false;
    }
  }

  return {
    savedValue,
    draftValue,
    status: state.status,
    dirty: state.dirty,
    errorMessage: state.errorMessage,
    edit,
    cancel,
    setDraftValue,
    save,
  };
}

function EditableSettingsBlock({
  id,
  title,
  status,
  dirty,
  errorMessage,
  onEdit,
  onCancel,
  onSave,
  children,
}: {
  id: string;
  title: string;
  status: EditableBlockStatus;
  dirty: boolean;
  errorMessage: string | null;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  children: ReactNode;
}) {
  const isEditing = status === "editing" || status === "error";
  const isSaving = status === "saving";
  const isError = status === "error";
  return (
    <section
      className={`editable-settings-block is-${status}${isEditing ? " is-editing" : ""}${isSaving ? " is-saving" : ""}${isError ? " is-error" : ""}`}
      id={id}
    >
      <div className="editable-settings-block-header">
        <div>
          <span>{title}</span>
          {dirty ? <em>Unsaved changes</em> : status === "saved" ? <em aria-live="polite">Saved</em> : null}
        </div>
        <div className="editable-settings-block-actions">
          {status === "idle" || status === "saved" ? (
            <button className="outline-button" onClick={onEdit} type="button">
              <Pencil size={15} />
              Edit
            </button>
          ) : (
            <>
              <button className="outline-button" disabled={isSaving} onClick={onCancel} type="button">
                Cancel
              </button>
              <button className="primary-button" disabled={!dirty || isSaving} onClick={onSave} type="button">
                {isSaving ? "Saving..." : isError ? "Try Again" : "Save"}
              </button>
            </>
          )}
          {status === "saved" ? (
            <span className="editable-settings-saved" aria-live="polite">
              <Check size={15} />
              Saved
            </span>
          ) : null}
        </div>
      </div>
      <div className="editable-settings-block-body">{children}</div>
      {errorMessage ? (
        <p className="workspace-save-error" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </section>
  );
}

type LessonFormat = "private" | "group" | "package";
type GroupServiceSchedule = {
  dayOfWeek: number;
  startMinutes: number;
  occurrenceCount: number;
  active: boolean;
};
type PriceMode = "session" | "per-person";
type PackageCoverageMode = "upfront" | "lesson-by-lesson";
type BookingStatus = "booked" | "completed" | "cancelled" | "no_show";
type ServiceEditorFormat = "private" | "group" | "custom-group" | "package";

type Service = {
  id: string;
  accountId?: string;
  coachId?: string;
  name: string;
  duration: number;
  price: number;
  description: string;
  visibility: "public" | "private";
  active: boolean;
  capacity: number;
  minParticipants: number;
  lessonFormat: LessonFormat;
  priceMode: PriceMode;
  locationId?: string;
  lessonNote?: string;
  location: string;
  groupSchedule?: GroupServiceSchedule;
  packageAllowance?: number;
  packageCoverageMode?: PackageCoverageMode;
  packageCoversServiceId?: string;
  bookingScreenIds?: string[];
  customGroup?: boolean;
  customGroupEnabled?: boolean;
  baseParticipants?: number;
  basePrice?: number;
  extraPersonPrice?: number;
  archived?: boolean;
};

type CustomGroupAttendeeStatus = "booker" | "manual" | "invited" | "confirmed";

type CustomGroupAttendee = {
  id: string;
  name: string;
  email?: string;
  status: CustomGroupAttendeeStatus;
  token?: string;
};

type ServiceListTab = "active" | "archived";
type PendingServiceAction =
  | { serviceId: string; mode: "archive" }
  | { serviceId: string; mode: "delete" }
  | null;

type CalendarItem = {
  id: string;
  kind: "appointment" | "block";
  accountId?: string;
  coachId?: string;
  locationId?: string;
  week?: number;
  day: number;
  start: number;
  duration: number;
  groupSlot?: boolean;
  syntheticGroupSlot?: boolean;
  serviceId?: string;
  readOnly?: boolean;
  client?: string;
  title: string;
  phone?: string;
  email?: string;
  // Stable link to a people/client row, set by the backend once a booking is
  // matched or created. Carry it through on every edit (it just needs to
  // survive object-spread updates) so a later correction to name/email/phone
  // never loses the connection to the client's real profile.
  personId?: string;
  note?: string;
  location?: BookingLocationSnapshot;
  coach?: BookingCoachSnapshot;
  status?: BookingStatus;
  updatedAt?: string;
  completedAt?: string;
  customGroup?: true;
  attendees?: CustomGroupAttendee[];
  calculatedPrice?: number;
};

type Location = {
  id: string;
  accountId?: string;
  name: string;
  shortName: string;
  address: string;
  mapUrl?: string;
  arrivalInstructions?: string;
  publicNotes?: string;
  timezone: string;
  active: boolean;
  archived?: boolean;
  isDefault?: boolean;
  sortOrder?: number;
};

type BookingLocationSnapshot = {
  locationId?: string;
  name: string;
  shortName?: string;
  address?: string;
  mapUrl?: string;
  arrivalInstructions?: string;
  publicNotes?: string;
  timezone?: string;
};

type BookingCoachSnapshot = {
  coachId?: string;
  name: string;
  displayName?: string;
  email?: string;
  phone?: string;
};

type PendingBooking = {
  id: string;
  accountId?: string;
  client: string;
  title: string;
  serviceId: string;
  coachId?: string;
  duration: number;
  phone?: string;
  email?: string;
  note?: string;
  sourceItemId?: string;
  customGroup?: true;
  attendees?: CustomGroupAttendee[];
  calculatedPrice?: number;
};

type PlacementAnimation = {
  itemId: string;
  fromX: number;
  fromY: number;
};

type CalendarViewMode = "full" | "am" | "pm";
type CalendarPerspective = "all" | "coach" | "location";

type DockFlight = PendingBooking & {
  fromX?: number;
  fromY?: number;
};

type FloatingDrag = {
  itemId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type CalendarHoverPreview = {
  itemId: string;
  x: number;
  y: number;
  kind: "group-session" | "appointment" | "blocked";
  client: string;
  service: string;
  time: string;
  venue: string;
  phone: string;
  email: string;
  clientEmailStatus: string;
  coachEmailStatus: string;
  adminEmailStatus: string;
};

type Person = {
  id: string;
  accountId?: string;
  name: string;
  email: string;
  phone: string;
  notes: string;
  source: string;
  caddyProfileId: string;
  caddyProfileUrl: string;
  createdAt?: string;
  updatedAt?: string;
};

type ClientSummary = Person & {
  count: number;
  next: CalendarItem | null;
  last: CalendarItem | null;
};

type ClientMergeFieldKey = "name" | "email" | "phone" | "notes";

type ClientMergeReview = {
  survivor: ClientSummary;
  loser: ClientSummary;
  fields: Record<ClientMergeFieldKey, string>;
};


function safeText(value: unknown, fallback = "") {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}

function hasCustomGroupFlag(service?: Partial<Service> | null) {
  return service?.customGroup === true || service?.customGroupEnabled === true;
}

function isCustomGroupService(service?: Partial<Service> | null) {
  return Boolean(hasCustomGroupFlag(service));
}

function isScheduledGroupService(service?: Partial<Service> | null) {
  return Boolean(service?.lessonFormat === "group" && !isCustomGroupService(service));
}

function isAppointmentStyleService(service?: Partial<Service> | null) {
  return Boolean(service && service.lessonFormat !== "package" && !isScheduledGroupService(service));
}

function serviceEditorFormat(service?: Partial<Service> | null): ServiceEditorFormat {
  if (service?.lessonFormat === "package") return "package";
  if (isCustomGroupService(service)) return "custom-group";
  if (service?.lessonFormat === "group") return "group";
  return "private";
}

function serviceFormatLabel(service?: Partial<Service> | null) {
  const format = serviceEditorFormat(service);
  if (format === "package") return "Package";
  if (format === "custom-group") return "Custom group";
  if (format === "group") return "Group";
  return "Private";
}

function customGroupBaseParticipants(service?: Partial<Service> | null) {
  const raw = Number(service?.baseParticipants ?? DEFAULT_CUSTOM_GROUP_BASE_PARTICIPANTS);
  return Number.isFinite(raw)
    ? clamp(Math.round(raw), customGroupMinParticipants(service), customGroupMaxParticipants(service))
    : DEFAULT_CUSTOM_GROUP_BASE_PARTICIPANTS;
}

function customGroupBasePrice(service?: Partial<Service> | null) {
  const raw = Number(service?.basePrice ?? service?.price ?? DEFAULT_CUSTOM_GROUP_BASE_PRICE);
  return Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : DEFAULT_CUSTOM_GROUP_BASE_PRICE;
}

function customGroupExtraPersonPrice(service?: Partial<Service> | null) {
  const raw = Number(service?.extraPersonPrice ?? DEFAULT_CUSTOM_GROUP_EXTRA_PERSON_PRICE);
  return Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : DEFAULT_CUSTOM_GROUP_EXTRA_PERSON_PRICE;
}

function customGroupMinParticipants(service?: Partial<Service> | null) {
  const raw = Number(service?.minParticipants ?? DEFAULT_CUSTOM_GROUP_MIN_PARTICIPANTS);
  return Number.isFinite(raw) ? clamp(Math.round(raw), 2, DEFAULT_CUSTOM_GROUP_MAX_PARTICIPANTS) : DEFAULT_CUSTOM_GROUP_MIN_PARTICIPANTS;
}

function customGroupMaxParticipants(service?: Partial<Service> | null) {
  const raw = Number(service?.capacity ?? DEFAULT_CUSTOM_GROUP_MAX_PARTICIPANTS);
  return Number.isFinite(raw) ? clamp(Math.round(raw), customGroupMinParticipants(service), DEFAULT_CUSTOM_GROUP_MAX_PARTICIPANTS) : DEFAULT_CUSTOM_GROUP_MAX_PARTICIPANTS;
}

function calculateCustomGroupPrice(service: Partial<Service> | null | undefined, participantCount: number) {
  const baseParticipants = customGroupBaseParticipants(service);
  const basePrice = customGroupBasePrice(service);
  const extraPersonPrice = customGroupExtraPersonPrice(service);
  const extraPeople = Math.max(0, Math.round(participantCount) - baseParticipants);
  return basePrice + extraPeople * extraPersonPrice;
}

function customGroupStatusLabel(status: CustomGroupAttendeeStatus) {
  if (status === "booker") return "Booked";
  if (status === "manual") return "Manual";
  if (status === "confirmed") return "Confirmed";
  return "Invited";
}

// Calendar item ids must be globally unique: two items created in the same millisecond used
// to share an id, and a retried save could not tell its own landed write from someone else's row.
function newCalendarItemId(prefix: "appt" | "block") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function newCustomGroupAttendeeId(prefix = "attendee") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function customGroupAttendeeToken() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function customGroupBookerAttendee(name: string, email = ""): CustomGroupAttendee {
  return {
    id: "booker",
    name: name.trim() || "Booker",
    email: email.trim() || undefined,
    status: "booker",
  };
}

function adminCustomGroupAttendee(name: string, email = ""): CustomGroupAttendee | null {
  const cleanName = name.trim();
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanName) return null;
  return {
    id: newCustomGroupAttendeeId(),
    name: cleanName,
    email: cleanEmail || undefined,
    status: cleanEmail ? "invited" : "manual",
    token: cleanEmail ? customGroupAttendeeToken() : undefined,
  };
}

function cleanPerson(person: Partial<Person> & { id?: unknown } = {}): Person {
  return {
    id: safeText(person.id),
    accountId: safeText(person.accountId) || defaultWorkspaceAccountFromCoachAccount().id,
    name: safeText(person.name),
    email: safeText(person.email),
    phone: safeText(person.phone),
    notes: safeText(person.notes),
    source: safeText(person.source),
    caddyProfileId: safeText(person.caddyProfileId),
    caddyProfileUrl: safeText(person.caddyProfileUrl),
    createdAt: typeof person.createdAt === "string" ? person.createdAt : undefined,
    updatedAt: typeof person.updatedAt === "string" ? person.updatedAt : undefined,
  };
}

function cleanPeople(people: unknown[]): Person[] {
  return people.map((person) => cleanPerson((person ?? {}) as Partial<Person>));
}

function cleanNotificationRecord(notification: Partial<NotificationRecord> & { id?: unknown } = {}): NotificationRecord {
  return {
    id: safeText(notification.id),
    accountId: safeText(notification.accountId) || defaultWorkspaceAccountFromCoachAccount().id,
    personKey: safeText(notification.personKey),
    calendarItemId: safeText(notification.calendarItemId),
    recipient: safeText(notification.recipient),
    subject: safeText(notification.subject),
    kind: safeText(notification.kind),
    status: safeText(notification.status),
    provider: safeText(notification.provider),
    providerId: safeText(notification.providerId),
    error: safeText(notification.error),
    createdAt: safeText(notification.createdAt),
  };
}

function cleanNotificationRecords(notifications: unknown[]): NotificationRecord[] {
  return notifications.map((notification) => cleanNotificationRecord((notification ?? {}) as Partial<NotificationRecord>));
}

function cleanLessonNote(note: Partial<LessonNote> & { id?: unknown } = {}): LessonNote {
  const createdAt = safeText(note.createdAt) || new Date().toISOString();
  return {
    id: safeText(note.id),
    accountId: safeText(note.accountId) || defaultWorkspaceAccountFromCoachAccount().id,
    playerId: safeText(note.playerId),
    playerName: safeText(note.playerName),
    lessonId: safeText(note.lessonId),
    calendarItemId: safeText(note.calendarItemId),
    title: safeText(note.title) || "Lesson note",
    body: safeText(note.body),
    source: note.source === "voice" ? "voice" : "typed",
    createdAt,
    updatedAt: safeText(note.updatedAt) || createdAt,
  };
}

function cleanLessonNotes(notes: unknown[]): LessonNote[] {
  return notes
    .map((note) => cleanLessonNote((note ?? {}) as Partial<LessonNote>))
    .filter((note) => note.playerId && note.body)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

type PeopleImportResult = {
  ok?: boolean;
  imported?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  failed?: number;
  errors?: Array<{ rowNumber?: string | number; name?: string; message?: string; reason?: string }>;
  people?: Person[];
};

type PeopleImportDiagnostic = {
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

type PeopleUpdateResult = {
  person: Person;
  people: Person[];
};

type LessonNoteSource = "typed" | "voice";

type LessonNote = {
  id: string;
  accountId: string;
  playerId: string;
  playerName: string;
  lessonId: string;
  calendarItemId: string;
  title: string;
  body: string;
  source: LessonNoteSource;
  createdAt: string;
  updatedAt: string;
};

type NotesResult = {
  note?: LessonNote;
  notes?: LessonNote[];
};

type ClientEditor = Pick<Person, "id" | "name" | "email" | "phone" | "notes" | "caddyProfileId" | "caddyProfileUrl">;

type Draft =
  | {
      mode: "move";
      itemId: string;
      week: number;
      day: number;
      start: number;
      duration: number;
      valid: boolean;
    }
  | {
      mode: "resize";
      itemId: string;
      week: number;
      day: number;
      start: number;
      duration: number;
      valid: boolean;
    }
  | {
      mode: "block";
      week: number;
      day: number;
      start: number;
      duration: number;
      valid: boolean;
    }
  | {
      mode: "place";
      week: number;
      day: number;
      start: number;
      duration: number;
      valid: boolean;
    };

type PointerSession =
  | {
      mode: "move";
      itemId: string;
      offsetMinutes: number;
      origin: CalendarItem;
    }
  | {
      mode: "resize";
      itemId: string;
      origin: CalendarItem;
    }
  | {
      mode: "block";
      day: number;
      start: number;
    }
  | {
      mode: "place";
      booking: PendingBooking;
    }
  | null;

type Toast = {
  message: string;
  undo?: () => void;
};

type View = "calendar" | "clients" | "services" | "availability" | "booking" | "billing" | "settings" | "video" | "players";
type BillingSection = "none" | "dashboard" | "new-invoice" | "invoices" | "expenses" | "reports" | "settings";
// A money-out bank transaction (Akahu) awaiting review as an expense.
type BankExpenseCandidate = {
  id: string;
  date: string;
  amount: number;
  description: string | null;
  merchant: string | null;
  type: string | null;
  suggestedCategory: string | null;
  accountId: string | null;
  account: string | null;
};
type BankExpenseSortKey = "date" | "account" | "description" | "amount";
type BankExpenseSortDirection = "asc" | "desc";
type BankExpenseSort = { key: BankExpenseSortKey; direction: BankExpenseSortDirection };
// A money-in bank transaction awaiting reconciliation against an invoice.
type ReconcileSuggestion = {
  invoiceId: string;
  invoiceNumber: string;
  customer: string | null;
  total: number;
  outstanding: number;
  refMatch: boolean;
  amountMatch: boolean;
};
type ReconcileCandidate = {
  id: string;
  date: string;
  amount: number;
  description: string | null;
  account: string | null;
  reference: string | null;
  // Akahu enrichment used for filtering (same smart allocation the expense
  // review uses): the transaction type (e.g. "TRANSFER") and category.
  type: string | null;
  category: string | null;
  autoInvoiceId: string | null;
  suggestions: ReconcileSuggestion[];
};
// Normalise an Akahu transaction type into a short filter label. Internal
// transfers are the main thing to keep out of the reconcile list (they aren't
// customer payments), so they collapse to a single "Transfer" bucket.
function reconcileTypeLabel(type: string | null | undefined): string {
  const raw = (type || "").trim().toUpperCase();
  if (!raw) return "Other";
  if (raw.includes("TRANSFER")) return "Transfer";
  return raw
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// Normalise a suggested expense classification (Akahu category enrichment) into
// a filter label. Transactions with no enrichment collapse to "Uncategorised".
function expenseCategoryLabel(category: string | null | undefined): string {
  return (category || "").trim() || "Uncategorised";
}

function bankCandidateSearchText(candidate: BankExpenseCandidate) {
  return [
    candidate.date,
    candidate.account,
    candidate.description,
    candidate.merchant,
    candidate.suggestedCategory,
    candidate.type,
    String(candidate.amount || ""),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function bankCandidateSortText(value: string | null | undefined) {
  return (value || "").trim().toLowerCase();
}

type SettingsTab =
  | "none"
  | "services"
  | "coaches"
  | "locations"
  | "availability"
  | "email"
  | "experience"
  | "account"
  | "branding"
  | "integrations"
  | "data";

type BookingForm = {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
};

type BookingMode = "book" | "reschedule";

type PublicBookingSection = "appointment" | "datetime" | "information";

type RescheduleForm = {
  email: string;
  phone: string;
};

type PublicRescheduleMatch = {
  id: string;
  serviceId: string;
  serviceName: string;
  duration: number;
  week: number;
  day: number;
  start: number;
  client: string;
  location?: BookingLocationSnapshot;
};

type NotificationRecord = {
  id: string;
  accountId?: string;
  personKey: string;
  calendarItemId: string;
  recipient: string;
  subject: string;
  kind: string;
  status: string;
  provider: string;
  providerId: string;
  error: string;
  createdAt: string;
};

type EmailSendResult = {
  channel: string;
  sent?: boolean;
  id?: string;
  reason?: string;
  error?: string;
  recipient?: string;
  subject?: string;
  kind?: string;
  status?: string;
};

type BookingConfirmation = {
  kind: "booking" | "reschedule" | "cancelled";
  appointmentId?: string;
  client: string;
  service: string;
  week: number;
  day: number;
  start: number;
  duration: number;
  dayLabel: string;
  timeLabel: string;
  email: string;
  phone?: string;
  location?: BookingLocationSnapshot;
  notifications: EmailSendResult[];
  notice?: string;
};

type SavedRescheduleLogin = {
  email: string;
  phone: string;
  appointmentId?: string;
};

type RescheduleLookupCredentials = RescheduleForm & {
  appointmentId?: string;
};

type SavedBookingLogin = BookingForm;

type ClientProfileTab = "bookings" | "notes" | "notifications";
type PlayerProfileTool = "recent" | "notes" | "videos";
type PlayerToolRecord = {
  id: string;
  kind: "note" | "video";
  title: string;
  subtitle: string;
  body?: string;
  timestamp: string;
  lessonId?: string;
  sourceId: string;
};

type CalendarFeedStatus = "checking" | "connected" | "offline";
type CalendarSaveStatus = "idle" | "saving" | "saved" | "failed";
type AdminWorkspaceLoadStatus = "idle" | "loading" | "loaded" | "error";
type PublicBookingStateStatus = "loading" | "loaded" | "error";
type PublicBookingSlotStatus = "idle" | "loading" | "loaded" | "error";
type AdminSaveOwner = "lesson_complete" | "upsert_item" | "calendar_delete" | "locations" | "coaches" | "settings";
type DiagnosticStatus = "started" | "success" | "failed" | "warning" | "skipped" | "verified";
type DiagnosticSystem =
  | "supabase"
  | "auth"
  | "calendar"
  | "booking"
  | "publicBooking"
  | "save"
  | "email"
  | "notification"
  | "admin"
  | "ui"
  | "cache"
  | "reload";
type DiagnosticTab = "overview" | "database" | "calendar" | "cache" | "errors" | "raw";
type DiagnosticEvent = {
  id: string;
  timestamp: string;
  system: DiagnosticSystem;
  action: string;
  phase: string;
  status: DiagnosticStatus;
  durationMs?: number;
  route?: string;
  functionName?: string;
  errorCode?: string;
  humanMessage?: string;
  httpStatus?: number;
  expectedAccountId?: string;
  returnedAccountId?: string;
  objectType?: string;
  objectId?: string;
  details?: Record<string, string | number | boolean>;
};
type DiagnosticEventInput = Omit<DiagnosticEvent, "id" | "timestamp" | "details"> & {
  id?: string;
  timestamp?: string;
  details?: Record<string, unknown>;
};
type DiagnosticTimerInput = {
  system: DiagnosticSystem;
  action: string;
  phase?: string;
  route?: string;
  functionName?: string;
  expectedAccountId?: string;
  objectType?: string;
  objectId?: string;
  details?: Record<string, unknown>;
};
type DiagnosticTimer = DiagnosticTimerInput & { id: string; startedAt: number };
type LessonCompleteDiagnostic = {
  action: "lesson_complete";
  itemId: string;
  expectedStatus: "completed";
  serverStatus: number;
  message: string;
  backendMessage?: string;
  backendError?: string;
  backendDetails?: string;
  conflictSource?: string;
  expectedRevision?: string;
  backendRevision?: string;
  durationMs?: number;
  stageTimings?: Record<string, number>;
};
type LessonCompleteErrorMap = Record<string, LessonCompleteDiagnostic>;
type BookingDeleteDiagnostics = {
  code?: string;
  operationOwner?: string;
  route?: string;
  httpStatus?: number;
  bookingId?: string;
  calendarItemId?: string;
  personId?: string;
  email?: string;
  backendMessage?: string;
  verificationResult?: string;
  [key: string]: unknown;
};
type CalendarStateSaveResponse = {
  message?: string;
  error?: string;
  detail?: string;
  details?: unknown;
  diagnostics?: BookingDeleteDiagnostics;
  expectedUpdatedAt?: string;
  backendUpdatedAt?: string;
  conflictSource?: string;
  notifications?: NotificationRecord[];
  notificationResults?: EmailSendResult[];
  updatedAt?: string;
  items?: CalendarItem[];
  googleCalendar?: Partial<GoogleCalendarSyncStatus>;
  googleCalendarSync?: Partial<GoogleCalendarSyncStatus> & { ok?: boolean; error?: string };
  syncKey?: string;
  warnings?: string[];
};

type LessonCompleteResponse = {
  ok?: boolean;
  message?: string;
  error?: string;
  detail?: string;
  durationMs?: number;
  action?: "lesson_complete";
  itemId?: string;
  item?: CalendarItem;
  status?: "completed";
  updatedAt?: string;
  stageTimings?: Record<string, number>;
  calendarId?: string;
  backendMessage?: string;
  backendError?: string;
  backendDetails?: string;
  stage?: string;
  idempotent?: boolean;
} & CalendarStateSaveResponse;
type BookingConfirmationResendResponse = {
  message?: string;
  error?: string;
  ok?: boolean;
  results?: EmailSendResult[];
  notifications?: NotificationRecord[];
};
type GoogleCalendarSyncStatus = {
  configured: boolean;
  connected: boolean;
  accountId?: string;
  calendarId: string;
  autoSync: boolean;
  accountEmail: string;
  lastSyncAt: string;
  lastSyncStatus: string;
  lastSyncError: string;
  manualOnly?: boolean;
  connectedAt: string;
  redirectUri: string;
  scope: string;
  grantedScopes?: string[];
  missingScopes?: string[];
  connectionStatus?: string;
  legacyMigrationRequired?: boolean;
  ok?: boolean;
  skipped?: boolean;
};
type GoogleCalendarActionState = "idle" | "connecting" | "saving" | "syncing" | "disconnecting" | "migrating";
type GoogleDriveActionState = "idle" | "connecting" | "testing" | "disconnecting";
type AuthStatus = "checking" | "authenticated" | "guest";
type AuthMode = "login" | "forgot" | "reset";
type ThemeMode = "light" | "dark";
type PermissionScope = "own" | "assigned" | "all";
type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "paused"
  | "cancelled"
  | "comped"
  | "internal";
type AccountPlanKey = "solo" | "studio" | "academy" | "enterprise" | "founder";
type AccountFeatureKey =
  | "publicBooking"
  | "coachCalendar"
  | "locationCalendar"
  | "multiCoach"
  | "multiLocation"
  | "services"
  | "groupLessons"
  | "packages"
  | "clients"
  | "notifications"
  | "googleCalendarSync"
  | "invoicing"
  | "checkout"
  | "customBranding"
  | "customDomains"
  | "staffUsers"
  | "advancedPermissions";
type AccountLimits = {
  maxCoaches: number;
  maxLocations: number;
  maxUsers: number;
  maxServices: number;
  maxBookingScreens: number;
};
type AccountEntitlements = {
  features: Record<AccountFeatureKey, boolean>;
  limits: AccountLimits;
};
type AccountEntitlementsOverride = {
  features?: Partial<Record<AccountFeatureKey, boolean>>;
  limits?: Partial<AccountLimits>;
};
type WorkspaceAccount = {
  id: string;
  name: string;
  slug: string;
  planKey: AccountPlanKey;
  subscriptionStatus: SubscriptionStatus;
  ownerUserId?: string;
  billingProvider?: "stripe" | "manual" | "none";
  billingCustomerId?: string;
  billingSubscriptionId?: string;
  trialEndsAt?: string;
  currentPeriodEndsAt?: string;
  entitlementsOverride?: AccountEntitlementsOverride;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
};

type AppUser = {
  id: string;
  accountId?: string;
  email: string;
  name: string;
  role: "admin" | "account_admin" | "coach" | "staff" | "platform_admin";
  coachId?: string;
  permissions: {
    bookings: PermissionScope;
    services: PermissionScope;
    availability: PermissionScope;
    locations: PermissionScope;
    clients: PermissionScope;
    settings: PermissionScope;
  };
};

type PasswordChangeForm = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

type NotificationSettings = {
  emailNotificationsEnabled: boolean;
  notificationEmail: string;
  notificationSubjectLine: string;
  notificationFromName: string;
  googleReviewUrl: string;
  configuredSenderEmailAddress: string;
  coachEmail: string;
  replyToEmail: string;
  notificationDelaySeconds: number;
  sendClientEmail: boolean;
  sendCoachEmail: boolean;
  sendAdminEmail: boolean;
  clientEmailSubject: string;
  clientEmailIntro: string;
  clientEmailFooter: string;
  adminEmailSubject: string;
  adminEmailIntro: string;
  minBookingNoticeMinutes: number;
  smsProviderName: string;
  smsWebhookUrl: string;
  smsFromNumber: string;
  sendClientSms: boolean;
  sendAdminSms: boolean;
};

type ServiceEditor = Omit<Service, "id"> & {
  id?: string;
};

type AvailabilityWindow = {
  accountId?: string;
  coachId?: string;
  start: number;
  end: number;
};

type BrandSettings = {
  coachName: string;
  logoName: string;
  logoPreview: string;
  showLogo: boolean;
  neutral: string;
  primary: string;
  secondary: string;
  accent: string;
  bookingTheme: ThemeMode;
};

type CoachAccount = {
  id: string;
  coachName: string;
  businessName: string;
  venueName: string;
  venueShortName: string;
  timezone: string;
  /** ISO 3166-1 alpha-2. The workspace's home country. */
  country: string;
  contactEmail: string;
  bookingUrl: string;
  calendarSlug: string;
  caddyWorkspaceUrl: string;
  invoiceSettings: InvoiceSettings;
};

type CoachProfile = {
  id: string;
  accountId?: string;
  name: string;
  displayName: string;
  shortName?: string;
  email: string;
  phone?: string;
  bio?: string;
  photoUrl?: string;
  active: boolean;
  archived?: boolean;
  isDefault?: boolean;
  bookable: boolean;
  assignedLocationIds?: string[];
  defaultLocationId?: string;
  sortOrder?: number;
};

type WorkspaceConfigRecord = {
  id?: string;
  accountId?: string;
  name?: string;
  displayName?: string;
};

type WorkspaceConfigDiagnostic = {
  activeAccountId: string;
  expected: Array<{ id: string; name: string }>;
  putStatus?: number;
  putRecords?: WorkspaceConfigRecord[];
  getStatus?: number;
  getRecords?: WorkspaceConfigRecord[];
  calendarStatus?: number;
  calendarRecords?: WorkspaceConfigRecord[];
};

type WorkspaceApiFailureDetail = {
  error?: string;
  message?: string;
  details?: string;
  failed?: string;
  text?: string;
  statusText?: string;
};

type SlotCandidate = {
  week: number;
  day: number;
  start: number;
  duration: number;
};

type BookingSlot = {
  week: number;
  day: number;
  start: number;
  remainingSpots: number;
  coachId?: string;
  locationId?: string;
};

type QuickCreateState = {
  week: number;
  day: number;
  start: number;
  x: number;
  y: number;
  coachId?: string;
  locationId?: string;
  serviceId: string;
  phone: string;
  email: string;
  note: string;
  attendees: CustomGroupAttendee[];
  attendeeName: string;
  attendeeEmail: string;
  error: string;
};

type GroupSession = {
  serviceId: string;
  week: number;
  day: number;
  start: number;
  duration: number;
};

type WeekDay = {
  short: string;
  label: string;
  date: number;
  isToday: boolean;
};

const DAY_START_MINUTES = 0;
const DAY_END_MINUTES = 24 * 60;
const DEFAULT_CALENDAR_START_HOUR = 7;
const DEFAULT_CALENDAR_END_HOUR = 20;
const DEFAULT_CALENDAR_START_MINUTES = DEFAULT_CALENDAR_START_HOUR * 60;
const DEFAULT_CALENDAR_END_MINUTES = DEFAULT_CALENDAR_END_HOUR * 60;
const HOUR_HEIGHT = 72;
const SNAP_MINUTES = 15;
const LAST_TIME_SLOT_MINUTES = DAY_END_MINUTES - SNAP_MINUTES;
const MAX_GROUP_OCCURRENCE_COUNT = 52;
const MOUSE_DRAG_THRESHOLD = 10;
const TOUCH_DRAG_THRESHOLD = 16;
const EDGE_NAV_ZONE = 26;
const DAY_COUNT = 7;
const BOOKING_EMBED_PARAM = "embed";
const BOOKING_EMBED_VALUE = "booking";
const BOOKING_LOGO_PARAM = "logo";
const PUBLIC_BOOKING_HOST = "book.claritygolf.app";
const CLARITY_BOOKING_HOSTS = new Set(["claritygolf.app", "booking.claritygolf.app", PUBLIC_BOOKING_HOST]);
const CANCELLED_GROUP_SESSION_TITLE = "Cancelled group session";
const CANCELLED_GROUP_SESSION_NOTE = "__cancelled_group_session__";
type BookingScreenDefinition = {
  id: string;
  label: string;
  path: string;
};
const BOOKING_SCREENS = [
  { id: "main", label: "Main booking screen", slugs: ["/", "/sam-hale-golf"] },
  { id: "range-three-kings", label: "Range Three Kings", slugs: ["/range-three-kings"] },
  { id: "group-lessons", label: "Group Lessons", slugs: ["/group-lessons"] },
  { id: "private-lessons", label: "Private Lessons", slugs: ["/private-lessons"] },
] as const;
const BOOKING_SCREEN_PATHS: BookingScreenDefinition[] = [
  { id: "main", label: "Main booking screen", path: "/sam-hale-golf" },
  { id: "range-three-kings", label: "Range Three Kings", path: "/range-three-kings" },
  { id: "group-lessons", label: "Group Lessons", path: "/group-lessons" },
  { id: "private-lessons", label: "Private Lessons", path: "/private-lessons" },
];
const BOOKING_SCREEN_IDS: Set<string> = new Set(BOOKING_SCREENS.map((screen) => screen.id));
const CADDY_APP_URL = "https://caddy.claritygolf.app";
const THEME_STORAGE_KEY = "clarity-booking-theme";
const BRAND_STORAGE_KEY = "clarity-booking-brand";
const COACH_ACCOUNT_STORAGE_KEY = "clarity-booking-coach-account";
const RESCHEDULE_LOGIN_STORAGE_KEY = "clarity-booking-reschedule-login";
const BOOKING_LOGIN_STORAGE_KEY = "clarity-booking-login";
const PAST_ADMIN_LESSON_WARNING =
  "This lesson is in the past. It will be saved for records only and no emails will be sent.";

const baseWeekDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const fullDayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const baseWeekStart = new Date(2026, 5, 1);

const defaultServices: Service[] = [
  {
    id: "lesson-30",
    name: "30min Lesson",
    duration: 30,
    price: 100,
    description: "Price Includes Bay Hire",
    visibility: "public",
    active: true,
    capacity: 1,
    minParticipants: 1,
    lessonFormat: "private",
    priceMode: "session",
    lessonNote: "Bay hire included",
    location: "Bay hire included",
  },
  {
    id: "lesson-60",
    name: "1 Hour Golf Lesson",
    duration: 60,
    price: 180,
    description: "Price Includes Bay Hire",
    visibility: "public",
    active: true,
    capacity: 1,
    minParticipants: 1,
    lessonFormat: "private",
    priceMode: "session",
    lessonNote: "Bay hire included",
    location: "Bay hire included",
  },
  {
    id: "lesson-pair",
    name: "2 Person Golf Lesson",
    duration: 60,
    price: 200,
    description: "Two-player coaching session",
    visibility: "public",
    active: true,
    capacity: 2,
    minParticipants: 1,
    lessonFormat: "private",
    priceMode: "session",
    lessonNote: "Bay hire included",
    location: "Bay hire included",
  },
  {
    id: "group-clinic",
    name: "Group Golf Clinic",
    duration: 90,
    price: 55,
    description: "Small-group coaching session with shared practice goals",
    visibility: "public",
    active: true,
    capacity: 6,
    minParticipants: 3,
    lessonFormat: "group",
    priceMode: "per-person",
    groupSchedule: {
      dayOfWeek: 2,
      startMinutes: timeToMinutes(18, 0),
      occurrenceCount: 8,
      active: true,
    },
    lessonNote: "Group coaching bay",
    location: "Group coaching bay",
  },
  {
    id: "member-30",
    name: "30min Golf Lesson (Range 24/7 Member)",
    duration: 30,
    price: 90,
    description: "Bay hire is deducted from membership account",
    visibility: "public",
    active: true,
    capacity: 1,
    minParticipants: 1,
    lessonFormat: "private",
    priceMode: "session",
    lessonNote: "Bay hire deducted from membership account",
    location: "Range 24/7 member bay",
  },
  {
    id: "member-60",
    name: "1 Hour Golf Lesson (Range 24/7 Member)",
    duration: 60,
    price: 160,
    description: "Bay hire is deducted from membership account",
    visibility: "public",
    active: true,
    capacity: 1,
    minParticipants: 1,
    lessonFormat: "private",
    priceMode: "session",
    lessonNote: "Bay hire deducted from membership account",
    location: "Range 24/7 member bay",
  },
  {
    id: "package-60",
    name: "1 hour Lesson - 5 Lesson Package",
    duration: 60,
    price: 650,
    description: "Five one-hour lessons tracked as a package.",
    visibility: "private",
    active: true,
    capacity: 1,
    minParticipants: 1,
    lessonFormat: "package",
    priceMode: "session",
    lessonNote: "Package allowance",
    location: "Package allowance",
    packageAllowance: 5,
    packageCoverageMode: "upfront",
    packageCoversServiceId: "lesson-60",
  },
];

const initialItems: CalendarItem[] = [];

const DEFAULT_MIN_BOOKING_NOTICE_MINUTES = 240;
const MAX_MIN_BOOKING_NOTICE_MINUTES = 7 * 24 * 60;
const MIN_BOOKING_NOTICE_PRESETS_HOURS = [0, 1, 2, 4, 24] as const;
const DEFAULT_CUSTOM_GROUP_BASE_PARTICIPANTS = 3;
const DEFAULT_CUSTOM_GROUP_BASE_PRICE = 200;
const DEFAULT_CUSTOM_GROUP_EXTRA_PERSON_PRICE = 20;
const DEFAULT_CUSTOM_GROUP_MIN_PARTICIPANTS = 2;
const DEFAULT_CUSTOM_GROUP_MAX_PARTICIPANTS = 5;
const NOTIFICATION_SUBJECT_TOKENS = [
  "{{service}}",
  "{{coach}}",
  "{{client}}",
  "{{date}}",
  "{{time}}",
  "{{action}}",
] as const;

const defaultAvailability: AvailabilityWindow[][] = [
  [{ start: timeToMinutes(16, 30), end: timeToMinutes(20, 0) }],
  [],
  [{ start: timeToMinutes(14, 0), end: timeToMinutes(20, 0) }],
  [
    { start: timeToMinutes(7, 0), end: timeToMinutes(11, 0) },
    { start: timeToMinutes(14, 0), end: timeToMinutes(16, 30) },
  ],
  [{ start: timeToMinutes(14, 0), end: timeToMinutes(16, 0) }],
  [],
  [{ start: timeToMinutes(15, 0), end: timeToMinutes(18, 0) }],
];

function timeToMinutes(hour: number, minute: number) {
  return hour * 60 + minute;
}

function snap(value: number) {
  return Math.round(value / SNAP_MINUTES) * SNAP_MINUTES;
}

function cleanMinBookingNoticeMinutes(value: number) {
  return Number.isFinite(value) ? clamp(Math.round(value), 0, MAX_MIN_BOOKING_NOTICE_MINUTES) : DEFAULT_MIN_BOOKING_NOTICE_MINUTES;
}

function formatBookingNoticeLabel(minutes: number) {
  const normalized = cleanMinBookingNoticeMinutes(minutes);
  if (normalized <= 0) return "No buffer";
  if (normalized % 60 === 0) {
    const hours = normalized / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${normalized} minutes`;
}

function formatTime(minutes: number) {
  const normalized = ((Math.round(minutes) % DAY_END_MINUTES) + DAY_END_MINUTES) % DAY_END_MINUTES;
  const hour24 = Math.floor(normalized / 60);
  const mins = normalized % 60;
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour = hour24 % 12 || 12;
  return `${hour}:${String(mins).padStart(2, "0")} ${period}`;
}

function minutesToInputTime(minutes: number) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function inputTimeToMinutes(value: string, fallback: number) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return fallback;
  }
  return hour * 60 + minute;
}

function formatRange(start: number, duration: number) {
  return `${formatTime(start)}-${formatTime(start + duration)}`;
}

function renderTemplate(template: string, variables: Record<string, string>) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => variables[key] ?? "");
}

function minutesToTop(minutes: number, gridStartMinutes = DEFAULT_CALENDAR_START_MINUTES) {
  return ((minutes - gridStartMinutes) / 60) * HOUR_HEIGHT;
}

function durationToHeight(minutes: number) {
  return (minutes / 60) * HOUR_HEIGHT;
}

function itemService(item: CalendarItem, serviceCatalog = defaultServices): Service | undefined {
  const service = serviceCatalog.find((candidate) => candidate.id === item.serviceId);
  if (service) return service;
  if (!item.serviceId) return undefined;
  const fallbackService: Service = {
    ...defaultServices[0],
    id: item.serviceId,
    name: item.title?.trim() || "Deleted lesson type",
    description: "",
    visibility: "private",
    active: false,
    archived: true,
    lessonFormat: "private",
    packageAllowance: undefined,
    packageCoverageMode: undefined,
    packageCoversServiceId: undefined,
    groupSchedule: undefined,
    bookingScreenIds: ["main"],
  };
  return fallbackService;
}

function itemWeek(item: CalendarItem) {
  return item.week ?? 0;
}

function sameSlot(a: CalendarItem, b: SlotCandidate) {
  return itemWeek(a) === b.week && a.day === b.day && a.start === b.start && a.duration === b.duration;
}

function overlaps(a: SlotCandidate, b: SlotCandidate) {
  return a.week === b.week && a.day === b.day && a.start < b.start + b.duration && a.start + a.duration > b.start;
}

function itemSlot(item: CalendarItem): SlotCandidate {
  return { week: itemWeek(item), day: item.day, start: item.start, duration: item.duration };
}

function defaultGroupSchedule(): GroupServiceSchedule {
  return {
    dayOfWeek: 2,
    startMinutes: timeToMinutes(18, 0),
    occurrenceCount: 8,
    active: true,
  };
}

function cleanGroupSchedule(
  value: unknown,
  fallback: GroupServiceSchedule = defaultGroupSchedule(),
): GroupServiceSchedule {
  const source = typeof value === "object" && value !== null ? value : {};
  const rawDay = Number.isFinite(Number((source as Partial<GroupServiceSchedule>).dayOfWeek))
    ? Number((source as Partial<GroupServiceSchedule>).dayOfWeek)
    : fallback.dayOfWeek;
  const rawStart = Number.isFinite(Number((source as Partial<GroupServiceSchedule>).startMinutes))
    ? Number((source as Partial<GroupServiceSchedule>).startMinutes)
    : fallback.startMinutes;
  const rawOccurrence = Number.isFinite(Number((source as Partial<GroupServiceSchedule>).occurrenceCount))
    ? Number((source as Partial<GroupServiceSchedule>).occurrenceCount)
    : fallback.occurrenceCount;
  return {
    dayOfWeek: clamp(Math.round(rawDay), 0, 6),
    startMinutes: Math.round(rawStart),
    occurrenceCount: clamp(Math.round(rawOccurrence), 1, MAX_GROUP_OCCURRENCE_COUNT),
    active: (source as Partial<GroupServiceSchedule>).active !== false,
  };
}

function startOfCalendarWeek(value = new Date()) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + mondayOffset);
  return date;
}

function calendarDateUtcTime(date: Date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function isSameCalendarDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function getCurrentWeekOffset() {
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const currentWeekStart = startOfCalendarWeek(new Date());
  return Math.round((calendarDateUtcTime(currentWeekStart) - calendarDateUtcTime(baseWeekStart)) / weekMs);
}

function buildWeekDays(week: number): WeekDay[] {
  const today = new Date();
  return baseWeekDays.map((short, index) => {
    const date = new Date(baseWeekStart);
    date.setDate(baseWeekStart.getDate() + week * 7 + index);
    const month = date.toLocaleString(activeLocale(), { month: "short" });
    return {
      short,
      label: `${fullDayNames[index]}, ${month} ${date.getDate()}`,
      date: date.getDate(),
      isToday: isSameCalendarDay(date, today),
    };
  });
}

function dateForSlot(week: number, day: number) {
  const date = new Date(baseWeekStart);
  date.setDate(baseWeekStart.getDate() + week * 7 + day);
  return date;
}

function isSlotInPast(slot: Pick<SlotCandidate, "week" | "day" | "start">) {
  const slotDate = dateForSlot(slot.week, slot.day);
  slotDate.setHours(Math.floor(slot.start / 60), slot.start % 60, 0, 0);
  return slotDate.getTime() < Date.now();
}

function compactDateTime(date: Date, minutes: number) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
  const minute = String(minutes % 60).padStart(2, "0");
  return `${year}${month}${day}T${hour}${minute}00`;
}

function escapeIcsText(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll(";", "\\;").replaceAll(",", "\\,");
}

function formatWeekTitle(week: number) {
  const date = new Date(baseWeekStart);
  date.setDate(baseWeekStart.getDate() + week * 7);
  const month = date.toLocaleString(activeLocale(), { month: "long" });
  return `Week of ${month} ${date.getDate()}, ${date.getFullYear()}`;
}

function sectionTitle(view: View) {
  switch (view) {
    case "clients":
      return "Clients";
    case "services":
      return "Services";
    case "availability":
      return "Availability";
    case "booking":
      return "Booking Page";
    case "billing":
      return "Billing";
    case "settings":
      return "Settings";
    case "video":
      return "Video Analysis";
    case "players":
      return "Player Profiles";
    default:
      return "Calendar";
  }
}

function getInitialView(): View {
  if (typeof window === "undefined") return "calendar";
  const requestedView = new URLSearchParams(window.location.search).get("view");
  if (requestedView === "settings") return "settings";
  if (requestedView === "billing") return "billing";
  if (requestedView === "notes") return "players";
  if (requestedView === "players") return "players";
  if (requestedView === "video") return "video";
  return isPublicBookingMode() ? "booking" : "calendar";
}

function getInitialResetToken() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("reset") ?? "";
}

function getInitialRescheduleLogin(): SavedRescheduleLogin | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const email = params.get("email") ?? "";
  const phone = params.get("phone") ?? "";
  const appointmentId = params.get("booking") ?? "";
  if (email && phone) {
    return {
      email,
      phone,
      appointmentId: appointmentId || undefined,
    };
  }
  try {
    const stored = window.localStorage.getItem(RESCHEDULE_LOGIN_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as SavedRescheduleLogin;
    if (!parsed?.email || !parsed?.phone) return null;
    return parsed;
  } catch {
    return null;
  }
}

function getInitialBookingLogin(): SavedBookingLogin | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(BOOKING_LOGIN_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as SavedBookingLogin;
    if (!parsed?.firstName || !parsed?.lastName || !parsed?.email) return null;
    return {
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      phone: parsed.phone || "",
      email: parsed.email,
    };
  } catch {
    return null;
  }
}

function buildRescheduleLink(
  bookingUrl: string,
  auth: {
    appointmentId?: string;
    email: string;
    phone: string;
  },
) {
  if (!auth.email || !auth.phone) return "";
  const url = new URL(bookingUrl || defaultCoachAccount.bookingUrl);
  url.searchParams.set(BOOKING_EMBED_PARAM, BOOKING_EMBED_VALUE);
  url.searchParams.set("mode", "reschedule");
  url.searchParams.set("email", auth.email);
  url.searchParams.set("phone", auth.phone);
  if (auth.appointmentId) url.searchParams.set("booking", auth.appointmentId);
  return url.toString();
}

function getBookingScreenPublicUrl(path: string, showLogo: boolean) {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  if (CLARITY_BOOKING_HOSTS.has(url.hostname)) {
    url.protocol = "https:";
    url.hostname = PUBLIC_BOOKING_HOST;
    url.pathname = normalizeBookingPath(path);
  } else {
    url.pathname = normalizeBookingPath(path);
  }
  url.searchParams.set(BOOKING_EMBED_PARAM, BOOKING_EMBED_VALUE);
  if (showLogo) {
    url.searchParams.delete(BOOKING_LOGO_PARAM);
  } else {
    url.searchParams.set(BOOKING_LOGO_PARAM, "0");
  }
  return url.toString();
}

function getBookingScreenIframeCode(path: string, businessName: string, screenName: string, showLogo: boolean) {
  const bookingScreenUrl = getBookingScreenPublicUrl(path, showLogo);
  return `<iframe src="${bookingScreenUrl}" title="${businessName} ${screenName} booking" width="100%" height="760" style="border:0;max-width:100%;border-radius:18px;overflow:hidden;background:transparent;" loading="lazy"></iframe>`;
}

function getBookingWidgetUrl(showLogo: boolean) {
  return getBookingScreenPublicUrl("/sam-hale-golf", showLogo);
}

function isBookingLogoHiddenByUrl() {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get(BOOKING_LOGO_PARAM) === "0";
}

function isPublicBookingMode() {
  if (typeof window === "undefined") return false;
  return (
    window.location.hostname === PUBLIC_BOOKING_HOST ||
    new URLSearchParams(window.location.search).get(BOOKING_EMBED_PARAM) === BOOKING_EMBED_VALUE
  );
}

function normalizeBookingPath(pathname = "") {
  const cleaned = pathname.trim().toLowerCase();
  if (!cleaned || cleaned === "/") return "/";
  return `/${cleaned.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/+/g, "/")}`;
}

function getBookingScreenId(pathname = "") {
  const normalizedPath = normalizeBookingPath(pathname);
  for (const screen of BOOKING_SCREENS) {
    if (screen.slugs.includes(normalizedPath)) return screen.id;
  }
  return "main";
}

function normalizeBookingScreenIds(value: unknown): string[] {
  // A missing field means legacy data, which defaults to the main screen.
  // An explicit empty list means "show on no booking screens" and is preserved.
  if (!Array.isArray(value)) return ["main"];
  const filtered = value
    .map((candidate) => (typeof candidate === "string" ? candidate.trim() : ""))
    .filter((candidate) => candidate.length > 0)
    .filter((candidate) => BOOKING_SCREEN_IDS.has(candidate));
  return Array.from(new Set(filtered));
}

function formatBookingScreenLabels(screenIds: string[] = []) {
  return screenIds
    .map((screenId) => BOOKING_SCREENS.find((screen) => screen.id === screenId)?.label || screenId)
    .filter(Boolean);
}

function getDefaultSyncBaseUrl() {
  if (typeof window === "undefined") return "https://booking.yourdomain.co.nz";
  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    return "https://booking.yourdomain.co.nz";
  }
  return window.location.origin;
}

type ClientMatchInput = {
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
};

type MatchableClient = Pick<Person, "name" | "email" | "phone">;

function normalizeMatchText(value: unknown = "") {
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

function phoneValuesMatch(source = "", query = "", exact = false) {
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

function bookingInputName(input: ClientMatchInput) {
  return safeText(input.name ?? [input.firstName, input.lastName].filter(Boolean).join(" ")).trim();
}

function splitClientName(name: string) {
  const parts = safeText(name).trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
}

function hasClientMatchInput(input: ClientMatchInput) {
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

function findClientMatch<T extends MatchableClient>(clients: T[], input: ClientMatchInput, exact = false) {
  if (!hasClientMatchInput(input)) return null;
  const exactMatch = clients.find((client) => clientMatchesInput(client, input, true));
  if (exact || exactMatch) return exactMatch ?? null;
  return clients.find((client) => clientMatchesInput(client, input)) ?? null;
}

function clientMatchesSearchTerm(client: Pick<Person, "name" | "email" | "phone" | "notes" | "source">, term: string) {
  const rawTerm = safeText(term).trim().toLowerCase();
  if (!rawTerm) return true;
  return clientSearchText(client).includes(rawTerm) || clientMatchesInput(client, { name: term, email: term, phone: term });
}

function clientKey(name = "", email = "", phone = "") {
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

function browserBase64(value: string) {
  try {
    return window.btoa(value);
  } catch {
    return "";
  }
}

function profileIdsForClient(client: Pick<Person, "id" | "email" | "phone">) {
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

function hasAnyProfileId(ids: Set<string>, client: Pick<Person, "id" | "email" | "phone">) {
  for (const id of profileIdsForClient(client)) {
    if (ids.has(id)) return true;
  }
  return false;
}

function preferredVideoPlayerId(client: Pick<Person, "id" | "email" | "phone">, videoIds: Set<string>) {
  for (const id of profileIdsForClient(client)) {
    if (videoIds.has(id)) return id;
  }
  return safeText(client.id);
}

function caddyProfileUrl(
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

function profileNotesText(client: Pick<Person, "notes" | "source">) {
  return isBookingGeneratedProfileNote(client) ? "" : safeText(client.notes);
}

function clientSearchText(client: Pick<Person, "name" | "email" | "phone" | "notes" | "source">) {
  return [client.name, client.email, client.phone, profileNotesText(client)]
    .map((value) => safeText(value))
    .join(" ")
    .toLowerCase();
}

function editorFromClient(client: ClientSummary): ClientEditor {
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

function parsePeopleImport(text: string): Person[] {
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

const PEOPLE_IMPORT_ENDPOINT = "/api/people/import-lite";

function importNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function importErrorMessages(result: PeopleImportResult) {
  return Array.isArray(result.errors)
    ? result.errors
        .map((error) =>
          [
            error.rowNumber !== undefined ? `Row ${error.rowNumber}` : error.name,
            error.message || error.reason,
          ].filter(Boolean).join(": "),
        )
        .filter(Boolean)
        .slice(0, 4)
    : [];
}

function buildPeopleImportDiagnostic(
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

function generateSyncKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `cg_${crypto.randomUUID().replaceAll("-", "")}`;
  }
  return `cg_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

const defaultBrandSettings: BrandSettings = {
  coachName: "Sam Hale Golf",
  logoName: "",
  logoPreview: "",
  showLogo: false,
  neutral: "#ffffff",
  primary: "#1fd36d",
  secondary: "#d7b06b",
  accent: "#07100a",
  bookingTheme: "dark",
};

const defaultCoachAccount: CoachAccount = {
  id: "sam-hale-golf",
  coachName: "Sam Hale",
  businessName: "Sam Hale Golf",
  venueName: "The Range 24/7 - Three Kings",
  venueShortName: "The Range 24/7",
  timezone: "Pacific/Auckland",
  country: "NZ",
  contactEmail: "",
  bookingUrl: "https://book.claritygolf.app",
  calendarSlug: "sam-hale-golf",
  caddyWorkspaceUrl: CADDY_APP_URL,
  invoiceSettings: defaultInvoiceSettings,
};

function cleanHexColor(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : fallback;
}

function cleanSlug(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

function cleanUrl(value: unknown, fallback: string) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
    return url.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

function cleanEmail(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const email = value.trim().toLowerCase().slice(0, 180);
  return email.includes("@") ? email : fallback;
}

function cleanCoachAccount(account?: Partial<CoachAccount>): CoachAccount {
  const businessName =
    typeof account?.businessName === "string" && account.businessName.trim()
      ? account.businessName.trim().slice(0, 100)
      : defaultCoachAccount.businessName;
  const coachName =
    typeof account?.coachName === "string" && account.coachName.trim()
      ? account.coachName.trim().slice(0, 100)
      : defaultCoachAccount.coachName;
  const venueName =
    typeof account?.venueName === "string" && account.venueName.trim()
      ? account.venueName.trim().slice(0, 140)
      : defaultCoachAccount.venueName;
  const venueShortName =
    typeof account?.venueShortName === "string" && account.venueShortName.trim()
      ? account.venueShortName.trim().slice(0, 80)
      : venueName;
  return {
    id: cleanSlug(account?.id, defaultCoachAccount.id),
    coachName,
    businessName,
    venueName,
    venueShortName,
    timezone:
      typeof account?.timezone === "string" && account.timezone.trim()
        ? account.timezone.trim().slice(0, 80)
        : defaultCoachAccount.timezone,
    country: cleanPhoneCountry(account?.country, defaultCoachAccount.country),
    contactEmail: cleanEmail(account?.contactEmail, defaultCoachAccount.contactEmail),
    bookingUrl: cleanUrl(account?.bookingUrl, defaultCoachAccount.bookingUrl),
    calendarSlug: cleanSlug(account?.calendarSlug, cleanSlug(businessName, defaultCoachAccount.calendarSlug)),
    caddyWorkspaceUrl: cleanUrl(account?.caddyWorkspaceUrl, defaultCoachAccount.caddyWorkspaceUrl),
    invoiceSettings: cleanInvoiceSettings(account?.invoiceSettings),
  };
}

const accountFeatureKeys: AccountFeatureKey[] = [
  "publicBooking",
  "coachCalendar",
  "locationCalendar",
  "multiCoach",
  "multiLocation",
  "services",
  "groupLessons",
  "packages",
  "clients",
  "notifications",
  "googleCalendarSync",
  "invoicing",
  "checkout",
  "customBranding",
  "customDomains",
  "staffUsers",
  "advancedPermissions",
];

function accountFeatures(enabled: AccountFeatureKey[]): Record<AccountFeatureKey, boolean> {
  return accountFeatureKeys.reduce(
    (features, feature) => ({ ...features, [feature]: enabled.includes(feature) }),
    {} as Record<AccountFeatureKey, boolean>,
  );
}

const allAccountFeatures = accountFeatures(accountFeatureKeys);

const accountPlanCatalog: Record<AccountPlanKey, AccountEntitlements> = {
  solo: {
    features: accountFeatures([
      "publicBooking",
      "coachCalendar",
      "services",
      "groupLessons",
      "packages",
      "clients",
      "notifications",
      "googleCalendarSync",
    ]),
    limits: { maxCoaches: 1, maxLocations: 1, maxUsers: 1, maxServices: 10, maxBookingScreens: 1 },
  },
  studio: {
    features: accountFeatures([
      "publicBooking",
      "coachCalendar",
      "locationCalendar",
      "multiCoach",
      "multiLocation",
      "services",
      "groupLessons",
      "packages",
      "clients",
      "notifications",
      "googleCalendarSync",
      "invoicing",
      "customBranding",
      "staffUsers",
    ]),
    limits: { maxCoaches: 5, maxLocations: 3, maxUsers: 8, maxServices: 40, maxBookingScreens: 4 },
  },
  academy: {
    features: allAccountFeatures,
    limits: { maxCoaches: 20, maxLocations: 10, maxUsers: 30, maxServices: 120, maxBookingScreens: 12 },
  },
  enterprise: {
    features: allAccountFeatures,
    limits: { maxCoaches: 999, maxLocations: 999, maxUsers: 999, maxServices: 999, maxBookingScreens: 999 },
  },
  founder: {
    features: allAccountFeatures,
    limits: { maxCoaches: 999, maxLocations: 999, maxUsers: 999, maxServices: 999, maxBookingScreens: 999 },
  },
};

function mergeEntitlementOverrides(
  base: AccountEntitlements,
  override?: AccountEntitlementsOverride,
): AccountEntitlements {
  return {
    features: { ...base.features, ...(override?.features ?? {}) },
    limits: { ...base.limits, ...(override?.limits ?? {}) },
  };
}

function accountEntitlements(account: WorkspaceAccount): AccountEntitlements {
  return mergeEntitlementOverrides(accountPlanCatalog[account.planKey] ?? accountPlanCatalog.solo, account.entitlementsOverride);
}

function accountHasFeature(account: WorkspaceAccount, feature: AccountFeatureKey) {
  return accountEntitlements(account).features[feature] === true;
}

function accountLimit(account: WorkspaceAccount, limit: keyof AccountLimits) {
  return accountEntitlements(account).limits[limit];
}

function isAccountActive(account: WorkspaceAccount) {
  return account.active && ["trialing", "active", "comped", "internal"].includes(account.subscriptionStatus);
}

function defaultWorkspaceAccountFromCoachAccount(account: Partial<CoachAccount> = defaultCoachAccount): WorkspaceAccount {
  const cleanAccount = cleanCoachAccount(account);
  const slug = cleanSlug(cleanAccount.calendarSlug || cleanAccount.businessName, "sam-hale-golf");
  return {
    id: slug,
    name: cleanAccount.businessName || "Sam Hale Golf",
    slug,
    planKey: "founder",
    subscriptionStatus: "comped",
    billingProvider: "none",
    active: true,
  };
}

function cleanWorkspaceAccount(
  raw?: Partial<WorkspaceAccount>,
  fallback: WorkspaceAccount = defaultWorkspaceAccountFromCoachAccount(),
): WorkspaceAccount {
  const name =
    typeof raw?.name === "string" && raw.name.trim()
      ? raw.name.trim().slice(0, 120)
      : fallback.name;
  const slug = cleanSlug(raw?.slug || raw?.id || name, fallback.slug);
  const planKey: AccountPlanKey =
    raw?.planKey && raw.planKey in accountPlanCatalog ? raw.planKey : fallback.planKey;
  const subscriptionStatus: SubscriptionStatus =
    raw?.subscriptionStatus && ["trialing", "active", "past_due", "paused", "cancelled", "comped", "internal"].includes(raw.subscriptionStatus)
      ? raw.subscriptionStatus
      : fallback.subscriptionStatus;
  return {
    id: cleanSlug(raw?.id, slug),
    name,
    slug,
    planKey,
    subscriptionStatus,
    ownerUserId: typeof raw?.ownerUserId === "string" && raw.ownerUserId.trim() ? raw.ownerUserId.trim().slice(0, 120) : fallback.ownerUserId,
    billingProvider: raw?.billingProvider === "stripe" || raw?.billingProvider === "manual" || raw?.billingProvider === "none" ? raw.billingProvider : fallback.billingProvider,
    billingCustomerId: typeof raw?.billingCustomerId === "string" && raw.billingCustomerId.trim() ? raw.billingCustomerId.trim().slice(0, 160) : undefined,
    billingSubscriptionId: typeof raw?.billingSubscriptionId === "string" && raw.billingSubscriptionId.trim() ? raw.billingSubscriptionId.trim().slice(0, 160) : undefined,
    trialEndsAt: typeof raw?.trialEndsAt === "string" && raw.trialEndsAt.trim() ? raw.trialEndsAt.trim() : undefined,
    currentPeriodEndsAt: typeof raw?.currentPeriodEndsAt === "string" && raw.currentPeriodEndsAt.trim() ? raw.currentPeriodEndsAt.trim() : undefined,
    entitlementsOverride:
      raw?.entitlementsOverride && typeof raw.entitlementsOverride === "object"
        ? {
            features: raw.entitlementsOverride.features,
            limits: raw.entitlementsOverride.limits,
          }
        : undefined,
    active: raw?.active !== false,
    createdAt: typeof raw?.createdAt === "string" ? raw.createdAt : fallback.createdAt,
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : fallback.updatedAt,
  };
}

function cleanWorkspaceAccounts(rawAccounts?: Partial<WorkspaceAccount>[], account?: Partial<CoachAccount>): WorkspaceAccount[] {
  const fallback = defaultWorkspaceAccountFromCoachAccount(account ?? defaultCoachAccount);
  const source = Array.isArray(rawAccounts) && rawAccounts.length ? rawAccounts : [fallback];
  const seen = new Set<string>();
  return source.map((raw, index) => {
    const clean = cleanWorkspaceAccount(raw, index === 0 ? fallback : defaultWorkspaceAccountFromCoachAccount(account ?? defaultCoachAccount));
    let id = clean.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${clean.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return { ...clean, id, active: clean.active || index === 0 };
  });
}

function activeWorkspaceAccounts(accounts: WorkspaceAccount[]) {
  return accounts.filter((account) => account.active);
}

function defaultAccountId(accounts: WorkspaceAccount[]) {
  return activeWorkspaceAccounts(accounts)[0]?.id || accounts[0]?.id || defaultWorkspaceAccountFromCoachAccount().id;
}

function accountById(accounts: WorkspaceAccount[], id?: string) {
  if (!id) return undefined;
  return accounts.find((account) => account.id === id);
}

function resolvedRecordAccountId(record: { accountId?: string } | undefined, fallbackAccountId = defaultWorkspaceAccountFromCoachAccount().id) {
  return record?.accountId || fallbackAccountId;
}

function recordBelongsToAccount(record: { accountId?: string } | undefined, accountId: string) {
  return resolvedRecordAccountId(record, accountId) === accountId;
}

function filterRecordsForAccount<T extends { accountId?: string }>(records: T[], accountId: string) {
  return records.filter((record) => recordBelongsToAccount(record, accountId));
}

function serviceBelongsToAccount(service: Partial<Service> | undefined, accountId: string) {
  return recordBelongsToAccount(service, accountId);
}

function coachBelongsToAccount(coach: Partial<CoachProfile> | undefined, accountId: string) {
  return recordBelongsToAccount(coach, accountId);
}

function locationBelongsToAccount(location: Partial<Location> | undefined, accountId: string) {
  return recordBelongsToAccount(location, accountId);
}

function calendarItemBelongsToAccount(item: Partial<CalendarItem> | undefined, accountId: string) {
  return recordBelongsToAccount(item, accountId);
}

function userBelongsToAccount(user: Partial<AppUser> | undefined, accountId: string) {
  return recordBelongsToAccount(user, accountId);
}

function canUseFeature(account: WorkspaceAccount, feature: AccountFeatureKey) {
  return isAccountActive(account) && accountHasFeature(account, feature);
}

function canCreateWithinLimit(account: WorkspaceAccount, currentUsage: number, limitName: keyof AccountLimits) {
  return currentUsage < accountLimit(account, limitName);
}

function featureUnavailableMessage(feature: AccountFeatureKey) {
  return `${feature} is not included in this workspace plan.`;
}

function limitReachedMessage(limitName: keyof AccountLimits, limit: number) {
  return `This workspace plan allows ${limit} ${limitName.replace(/^max/, "").toLowerCase()}.`;
}

function defaultLocationFromCoachAccount(account: Partial<CoachAccount> = defaultCoachAccount): Location {
  const cleanAccount = cleanCoachAccount(account);
  const workspaceAccount = defaultWorkspaceAccountFromCoachAccount(cleanAccount);
  return {
    id: "default-location",
    accountId: workspaceAccount.id,
    name: cleanAccount.venueName,
    shortName: cleanAccount.venueShortName || cleanAccount.venueName,
    address: "",
    timezone: cleanAccount.timezone,
    active: true,
    archived: false,
    isDefault: true,
    sortOrder: 0,
  };
}

function defaultCoachProfileFromAccount(account: Partial<CoachAccount> = defaultCoachAccount): CoachProfile {
  const cleanAccount = cleanCoachAccount(account);
  const workspaceAccount = defaultWorkspaceAccountFromCoachAccount(cleanAccount);
  return {
    id: cleanAccount.id || "sam-hale",
    accountId: workspaceAccount.id,
    name: cleanAccount.coachName,
    displayName: cleanAccount.coachName || cleanAccount.businessName,
    shortName: "Sam",
    email: cleanAccount.contactEmail,
    active: true,
    archived: false,
    isDefault: true,
    bookable: true,
    assignedLocationIds: ["default-location"],
    defaultLocationId: "default-location",
    sortOrder: 0,
  };
}

function defaultAppUserFromCoachAccount(account: Partial<CoachAccount> = defaultCoachAccount): AppUser {
  const coach = defaultCoachProfileFromAccount(account);
  const workspaceAccount = defaultWorkspaceAccountFromCoachAccount(account);
  return {
    id: `${coach.id}-admin`,
    accountId: workspaceAccount.id,
    email: coach.email,
    name: coach.displayName,
    role: "admin",
    coachId: coach.id,
    permissions: {
      bookings: "all",
      services: "all",
      availability: "all",
      locations: "all",
      clients: "all",
      settings: "all",
    },
  };
}

function cleanAppUser(raw?: Partial<AppUser>, fallback = defaultAppUserFromCoachAccount(), accountId = fallback.accountId): AppUser {
  const role =
    raw?.role === "account_admin" || raw?.role === "coach" || raw?.role === "staff" || raw?.role === "platform_admin"
      ? raw.role
      : raw?.role === "admin"
        ? "admin"
        : fallback.role;
  const permissions = typeof raw?.permissions === "object" && raw.permissions ? raw.permissions : fallback.permissions;
  return {
    id: cleanSlug(raw?.id, fallback.id),
    accountId: cleanSlug(raw?.accountId, accountId || defaultWorkspaceAccountFromCoachAccount().id),
    email: cleanEmail(raw?.email, fallback.email),
    name: typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 120) : fallback.name,
    role,
    coachId: cleanSlug(raw?.coachId, fallback.coachId || "") || undefined,
    permissions: {
      bookings: permissions.bookings === "own" || permissions.bookings === "assigned" ? permissions.bookings : "all",
      services: permissions.services === "own" || permissions.services === "assigned" ? permissions.services : "all",
      availability: permissions.availability === "own" || permissions.availability === "assigned" ? permissions.availability : "all",
      locations: permissions.locations === "own" || permissions.locations === "assigned" ? permissions.locations : "all",
      clients: permissions.clients === "own" || permissions.clients === "assigned" ? permissions.clients : "all",
      settings: permissions.settings === "own" || permissions.settings === "assigned" ? permissions.settings : "all",
    },
  };
}

function cleanCoachProfile(raw?: Partial<CoachProfile>, fallback?: CoachProfile, index = 0): CoachProfile {
  const base = fallback ?? defaultCoachProfileFromAccount();
  const name =
    typeof raw?.name === "string" && raw.name.trim()
      ? raw.name.trim().slice(0, 120)
      : base.name;
  return {
    id: cleanSlug(raw?.id, cleanSlug(name, `coach-${index + 1}`)),
    accountId: cleanSlug(raw?.accountId, base.accountId || defaultWorkspaceAccountFromCoachAccount().id),
    name,
    displayName:
      typeof raw?.displayName === "string" && raw.displayName.trim()
        ? raw.displayName.trim().slice(0, 120)
        : name,
    shortName:
      typeof raw?.shortName === "string" && raw.shortName.trim()
        ? raw.shortName.trim().slice(0, 60)
        : name.split(/\s+/).map((part) => part[0]).join("").slice(0, 4).toUpperCase(),
    email: cleanEmail(raw?.email, base.email),
    phone: typeof raw?.phone === "string" && raw.phone.trim() ? raw.phone.trim().slice(0, 80) : undefined,
    bio: typeof raw?.bio === "string" && raw.bio.trim() ? raw.bio.trim().slice(0, 600) : undefined,
    photoUrl: cleanUrl(raw?.photoUrl, "") || undefined,
    active: raw?.active !== false,
    archived: raw?.archived === true,
    isDefault: raw?.isDefault === true || base.isDefault === true,
    bookable: raw?.bookable !== false,
    assignedLocationIds: Array.isArray(raw?.assignedLocationIds)
      ? raw.assignedLocationIds.map((id) => cleanSlug(id, "")).filter(Boolean)
      : base.assignedLocationIds,
    defaultLocationId: cleanSlug(raw?.defaultLocationId, raw?.assignedLocationIds?.[0] || base.assignedLocationIds?.[0] || "") || undefined,
    sortOrder: Number.isFinite(Number(raw?.sortOrder)) ? Math.round(Number(raw?.sortOrder)) : index,
  };
}

function cleanCoachProfiles(rawProfiles?: Partial<CoachProfile>[], account?: Partial<CoachAccount>): CoachProfile[] {
  const fallback = defaultCoachProfileFromAccount(account ?? defaultCoachAccount);
  const source = Array.isArray(rawProfiles) && rawProfiles.length ? rawProfiles : [fallback];
  const seen = new Set<string>();
  const cleaned = source.map((raw, index) => {
    const profile = cleanCoachProfile(raw, index === 0 ? fallback : undefined, index);
    let id = profile.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${profile.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return { ...profile, id };
  });
  if (!cleaned.some((coach) => coach.active && !coach.archived && coach.bookable)) {
    cleaned[0] = { ...cleaned[0], active: true, archived: false, bookable: true };
  }
  const defaultIndex = cleaned.findIndex((coach) => coach.isDefault && coach.active && !coach.archived);
  const nextDefaultIndex = defaultIndex >= 0 ? defaultIndex : cleaned.findIndex((coach) => coach.active && !coach.archived);
  return cleaned
    .map((coach, index) => ({ ...coach, isDefault: index === nextDefaultIndex }))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.displayName.localeCompare(b.displayName));
}

function defaultCoachId(coaches: CoachProfile[]) {
  return coaches.find((coach) => coach.isDefault && coach.active && !coach.archived)?.id || coaches[0]?.id || "";
}

function coachById(coaches: CoachProfile[], id?: string) {
  if (!id) return undefined;
  return coaches.find((coach) => coach.id === id);
}

function coachSnapshot(profile: CoachProfile): BookingCoachSnapshot {
  return {
    coachId: profile.id,
    name: profile.name,
    displayName: profile.displayName,
    email: profile.email,
    phone: profile.phone,
  };
}

function bookingCoachSnapshotFor(
  coachId: string | undefined,
  coaches: CoachProfile[],
  account: Partial<CoachAccount>,
): BookingCoachSnapshot {
  const profile =
    coachById(coaches, coachId) ??
    coachById(coaches, defaultCoachId(coaches)) ??
    defaultCoachProfileFromAccount(account);
  return coachSnapshot(profile);
}

function cleanBookingCoachSnapshot(
  raw?: Partial<BookingCoachSnapshot>,
  fallback?: BookingCoachSnapshot,
): BookingCoachSnapshot | undefined {
  const source = raw?.name ? raw : fallback;
  if (!source?.name) return undefined;
  return {
    coachId: typeof source.coachId === "string" ? cleanSlug(source.coachId, "") || undefined : undefined,
    name: String(source.name).trim().slice(0, 120),
    displayName:
      typeof source.displayName === "string" && source.displayName.trim()
        ? source.displayName.trim().slice(0, 120)
        : undefined,
    email: cleanEmail(source.email, "") || undefined,
    phone: typeof source.phone === "string" && source.phone.trim() ? source.phone.trim().slice(0, 80) : undefined,
  };
}

function calendarItemCoach(
  item: Partial<CalendarItem> | undefined,
  coaches: CoachProfile[],
  account: Partial<CoachAccount>,
): BookingCoachSnapshot {
  return (
    cleanBookingCoachSnapshot(item?.coach) ??
    bookingCoachSnapshotFor(item?.coachId, coaches, account)
  );
}

function resolvedCalendarItemCoachId(
  item: Partial<CalendarItem> | undefined,
  service: Partial<Service> | undefined,
  coaches: CoachProfile[],
  account: Partial<CoachAccount>,
) {
  return item?.coachId || item?.coach?.coachId || service?.coachId || calendarItemCoach(item, coaches, account).coachId || defaultCoachId(coaches);
}

function calendarItemBelongsToCoach(
  item: Partial<CalendarItem> | undefined,
  coachId: string | undefined,
  service: Partial<Service> | undefined,
  coaches: CoachProfile[],
  account: Partial<CoachAccount>,
) {
  if (!coachId) return false;
  return resolvedCalendarItemCoachId(item, service, coaches, account) === coachId;
}

function cleanLocation(raw?: Partial<Location>, fallback?: Location, index = 0): Location {
  const base = fallback ?? defaultLocationFromCoachAccount();
  const name =
    typeof raw?.name === "string" && raw.name.trim()
      ? raw.name.trim().slice(0, 140)
      : base.name;
  const shortName =
    typeof raw?.shortName === "string" && raw.shortName.trim()
      ? raw.shortName.trim().slice(0, 80)
      : name;
  const id = cleanSlug(raw?.id, cleanSlug(name, `location-${index + 1}`));
  return {
    id,
    accountId: cleanSlug(raw?.accountId, base.accountId || defaultWorkspaceAccountFromCoachAccount().id),
    name,
    shortName,
    address: typeof raw?.address === "string" ? raw.address.trim().slice(0, 240) : base.address,
    mapUrl: cleanUrl(raw?.mapUrl, "") || undefined,
    arrivalInstructions:
      typeof raw?.arrivalInstructions === "string" && raw.arrivalInstructions.trim()
        ? raw.arrivalInstructions.trim().slice(0, 500)
        : undefined,
    publicNotes:
      typeof raw?.publicNotes === "string" && raw.publicNotes.trim()
        ? raw.publicNotes.trim().slice(0, 500)
        : undefined,
    timezone:
      typeof raw?.timezone === "string" && raw.timezone.trim()
        ? raw.timezone.trim().slice(0, 80)
        : base.timezone,
    active: raw?.active !== false,
    archived: raw?.archived === true,
    isDefault: raw?.isDefault === true || base.isDefault === true,
    sortOrder: Number.isFinite(Number(raw?.sortOrder)) ? Math.round(Number(raw?.sortOrder)) : index,
  };
}

function cleanLocations(rawLocations?: Partial<Location>[], account?: Partial<CoachAccount>): Location[] {
  const fallback = defaultLocationFromCoachAccount(account ?? defaultCoachAccount);
  const source = Array.isArray(rawLocations) && rawLocations.length ? rawLocations : [fallback];
  const seen = new Set<string>();
  const cleaned = source.map((raw, index) => {
    const location = cleanLocation(raw, index === 0 ? fallback : undefined, index);
    let id = location.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${location.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return { ...location, id };
  });
  const active = cleaned.filter((location) => location.active && !location.archived);
  if (!active.length) {
    cleaned[0] = { ...cleaned[0], active: true, archived: false };
  }
  const defaultIndex = cleaned.findIndex((location) => location.isDefault && location.active && !location.archived);
  const nextDefaultIndex = defaultIndex >= 0 ? defaultIndex : cleaned.findIndex((location) => location.active && !location.archived);
  return cleaned
    .map((location, index) => ({ ...location, isDefault: index === nextDefaultIndex }))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
}

function activeLocations(locations: Location[]) {
  return locations.filter((location) => location.active && !location.archived);
}

function defaultLocationId(locations: Location[]) {
  return (
    activeLocations(locations).find((location) => location.isDefault)?.id ??
    activeLocations(locations)[0]?.id ??
    locations[0]?.id ??
    ""
  );
}

function locationById(locations: Location[], id?: string) {
  if (!id) return undefined;
  return locations.find((location) => location.id === id);
}

function locationSnapshot(location: Location): BookingLocationSnapshot {
  return {
    locationId: location.id,
    name: location.name,
    shortName: location.shortName,
    address: location.address || undefined,
    mapUrl: location.mapUrl,
    arrivalInstructions: location.arrivalInstructions,
    publicNotes: location.publicNotes,
    timezone: location.timezone,
  };
}

function serviceLocation(service: Partial<Service> | undefined, locations: Location[], account: Partial<CoachAccount>) {
  const cleanAccount = cleanCoachAccount(account);
  return (
    locationById(locations, service?.locationId) ??
    locationById(locations, defaultLocationId(locations)) ??
    defaultLocationFromCoachAccount(cleanAccount)
  );
}

function bookingLocationSnapshotFor(
  service: Partial<Service> | undefined,
  locations: Location[],
  account: Partial<CoachAccount>,
): BookingLocationSnapshot {
  return locationSnapshot(serviceLocation(service, locations, account));
}

function cleanBookingLocationSnapshot(
  raw?: Partial<BookingLocationSnapshot>,
  fallback?: BookingLocationSnapshot,
): BookingLocationSnapshot | undefined {
  const source = raw?.name ? raw : fallback;
  if (!source?.name) return undefined;
  return {
    locationId: typeof source.locationId === "string" ? source.locationId.trim().slice(0, 120) : undefined,
    name: String(source.name).trim().slice(0, 140),
    shortName: typeof source.shortName === "string" && source.shortName.trim() ? source.shortName.trim().slice(0, 80) : undefined,
    address: typeof source.address === "string" && source.address.trim() ? source.address.trim().slice(0, 240) : undefined,
    mapUrl: cleanUrl(source.mapUrl, "") || undefined,
    arrivalInstructions:
      typeof source.arrivalInstructions === "string" && source.arrivalInstructions.trim()
        ? source.arrivalInstructions.trim().slice(0, 500)
        : undefined,
    publicNotes:
      typeof source.publicNotes === "string" && source.publicNotes.trim()
        ? source.publicNotes.trim().slice(0, 500)
        : undefined,
    timezone: typeof source.timezone === "string" && source.timezone.trim() ? source.timezone.trim().slice(0, 80) : undefined,
  };
}

function calendarItemLocation(
  item: Partial<CalendarItem> | undefined,
  service: Partial<Service> | undefined,
  locations: Location[],
  account: Partial<CoachAccount>,
): BookingLocationSnapshot {
  return (
    cleanBookingLocationSnapshot(item?.location) ??
    cleanBookingLocationSnapshot(
      item?.locationId ? locationSnapshot(locationById(locations, item.locationId) ?? serviceLocation(service, locations, account)) : undefined,
    ) ??
    bookingLocationSnapshotFor(service, locations, account)
  );
}

function resolvedCalendarItemLocationId(
  item: Partial<CalendarItem> | undefined,
  service: Partial<Service> | undefined,
  locations: Location[],
  account: Partial<CoachAccount>,
) {
  return item?.locationId || item?.location?.locationId || service?.locationId || calendarItemLocation(item, servic…212152 tokens truncated…chName", event.target.value)}
                        />
                      </label>
                      <label className="settings-field">
                        <span>Business name</span>
                        <input
                          value={coachAccountDraft.businessName}
                          readOnly={coachAccountIsLocked}
                          onChange={(event) => updateCoachAccountBlockDraft("businessName", event.target.value)}
                        />
                      </label>
                    </div>
                    <label className="settings-field">
                      <span>Contact email</span>
                      <input
                        value={coachAccountDraft.contactEmail}
                        readOnly={coachAccountIsLocked}
                        onChange={(event) => updateCoachAccountBlockDraft("contactEmail", event.target.value)}
                        type="email"
                      />
                    </label>
                  </details>

                  <details className="settings-subsection">
                    <summary className="settings-subsection-title">
                      <MapPin size={18} />
                      <div>
                        <span>Venue</span>
                        <strong>{coachAccount.venueShortName}</strong>
                      </div>
                    </summary>
                    <label className="settings-field">
                      <span>Venue name</span>
                      <input
                        value={coachAccountDraft.venueName}
                        readOnly={coachAccountIsLocked}
                        onChange={(event) => updateCoachAccountBlockDraft("venueName", event.target.value)}
                      />
                    </label>
                    <div className="service-form-row">
                      <label className="settings-field">
                        <span>Short label</span>
                        <input
                          value={coachAccountDraft.venueShortName}
                          readOnly={coachAccountIsLocked}
                          onChange={(event) => updateCoachAccountBlockDraft("venueShortName", event.target.value)}
                        />
                      </label>
                      <label className="settings-field">
                        <span>Timezone</span>
                        <input
                          value={coachAccountDraft.timezone}
                          readOnly={coachAccountIsLocked}
                          onChange={(event) => updateCoachAccountBlockDraft("timezone", event.target.value)}
                        />
                      </label>
                      <label className="settings-field">
                        <span>Country</span>
                        <select
                          value={cleanPhoneCountry(coachAccountDraft.country)}
                          disabled={coachAccountIsLocked}
                          onChange={(event) => updateCoachAccountBlockDraft("country", event.target.value)}
                        >
                          {phoneCountryOptions().map((option) => (
                            <option key={option.code} value={option.code}>
                              {option.name} ({option.dialCode})
                            </option>
                          ))}
                        </select>
                        <small className="settings-field-hint">
                          Sets the dialling code for new phone numbers, and how a number typed
                          without a country code is understood.
                        </small>
                      </label>
                    </div>
                  </details>

	                  <details className="settings-subsection">
	                    <summary className="settings-subsection-title">
	                      <Link2 size={18} />
                      <div>
                        <span>Connected apps</span>
                        <strong>Booking and Caddy</strong>
                      </div>
                    </summary>
                    <label className="settings-field">
                      <span>Booking app URL</span>
                      <input
                        value={coachAccountDraft.bookingUrl}
                        readOnly={coachAccountIsLocked}
                        onChange={(event) => {
                          updateCoachAccountBlockDraft("bookingUrl", event.target.value);
                          setSyncBaseUrl(event.target.value);
                        }}
                      />
                    </label>
                    <div className="service-form-row">
                      <label className="settings-field">
                        <span>Calendar slug</span>
                        <input
                          value={coachAccountDraft.calendarSlug}
                          readOnly={coachAccountIsLocked}
                          onChange={(event) => updateCoachAccountBlockDraft("calendarSlug", event.target.value)}
                        />
                      </label>
                      <label className="settings-field">
                        <span>Caddy workspace</span>
                        <input
                          value={coachAccountDraft.caddyWorkspaceUrl}
                          readOnly={coachAccountIsLocked}
                          onChange={(event) => updateCoachAccountBlockDraft("caddyWorkspaceUrl", event.target.value)}
                        />
                      </label>
	                    </div>
	                  </details>
                  </EditableSettingsBlock>

                  <details className="settings-subsection">
                    <summary className="settings-subsection-title">
                      <KeyRound size={18} />
                      <div>
                        <span>Security</span>
                        <strong>Password</strong>
                      </div>
                    </summary>
                    <form className="security-settings-form" onSubmit={handleChangePassword}>
                      <label className="settings-field">
                        <span>Current password</span>
                        <input
                          value={passwordChangeForm.currentPassword}
                          onChange={(event) => updatePasswordChangeForm("currentPassword", event.target.value)}
                          type="password"
                          autoComplete="current-password"
                        />
                      </label>
                      <div className="service-form-row">
                        <label className="settings-field">
                          <span>New password</span>
                          <input
                            value={passwordChangeForm.newPassword}
                            onChange={(event) => updatePasswordChangeForm("newPassword", event.target.value)}
                            type="password"
                            autoComplete="new-password"
                          />
                        </label>
                        <label className="settings-field">
                          <span>Confirm new password</span>
                          <input
                            value={passwordChangeForm.confirmPassword}
                            onChange={(event) => updatePasswordChangeForm("confirmPassword", event.target.value)}
                            type="password"
                            autoComplete="new-password"
                          />
                        </label>
                      </div>
                      {passwordChangeMessage && (
                        <div className={passwordChangeState === "saved" ? "auth-success" : "auth-error"}>
                          {passwordChangeMessage}
                        </div>
                      )}
                      <button className="outline-button" disabled={passwordChangeState === "saving"} type="submit">
                        {passwordChangeState === "saving" ? "Changing" : "Change Password"}
                      </button>
                    </form>
                  </details>

                  <EditableSettingsBlock
                    id="billing-settings-account-block"
                    title="Billing Settings"
                    status={billingSettingsEditor.status}
                    dirty={billingSettingsEditor.dirty}
                    errorMessage={billingSettingsEditor.errorMessage}
                    onEdit={() => startEditableBlock("billing-settings")}
                    onCancel={() => cancelEditableBlock("billing-settings")}
                    onSave={() => void saveEditableBlock("billing-settings")}
                  >
                  <details className="settings-subsection">
                    <summary className="settings-subsection-title">
                      <FileText size={18} />
                      <div>
                        <span>Invoicing</span>
                        <strong>
                          {invoiceSettings.prefix}-{String(invoiceSettings.nextNumber).padStart(4, "0")} next
                        </strong>
                      </div>
                    </summary>
                    <div className="service-form-row">
                      <label className="settings-toggle">
                        <input
                          checked={invoiceSettingsDraft.enabled}
                          disabled={billingSettingsIsLocked || !canUseFeature(activeAccount, "invoicing")}
                          onChange={(event) => updateBillingAccountDraft("enabled", event.target.checked)}
                          type="checkbox"
                        />
                        <span>Enable invoicing</span>
                      </label>
                      <label className="settings-toggle">
                        <input
                          checked={invoiceSettingsDraft.showBillingWorkspace}
                          disabled={billingSettingsIsLocked || !canUseFeature(activeAccount, "invoicing")}
                          onChange={(event) => updateBillingAccountDraft("showBillingWorkspace", event.target.checked)}
                          type="checkbox"
                        />
                        <span>Show Billing workspace</span>
                      </label>
                    </div>
                    <div className="service-form-row">
                      <label className="settings-field">
                        <span>Invoice prefix</span>
                        <input
                          value={invoiceSettingsDraft.prefix}
                          readOnly={billingSettingsIsLocked}
                          onChange={(event) => updateBillingAccountDraft("prefix", event.target.value)}
                        />
                      </label>
                      <label className="settings-field">
                        <span>Start / next number</span>
                        <input
                          value={invoiceSettingsDraft.nextNumber}
                          inputMode="numeric"
                          readOnly={billingSettingsIsLocked}
                        onChange={(event) => updateBillingAccountDraft("nextNumber", parseQuantityInput(event.target.value))}
                          type="text"
                        />
                      </label>
                      <label className="settings-field">
                        <span>Currency</span>
                        <input
                          value={invoiceSettingsDraft.currency}
                        readOnly={billingSettingsIsLocked}
                        onChange={(event) => updateBillingAccountDraft("currency", event.target.value)}
                        />
                      </label>
                    </div>
                    <div className="service-form-row">
                      <label className="settings-field">
                        <span>Tax label</span>
                        <input
                          value={invoiceSettingsDraft.taxName}
                        readOnly={billingSettingsIsLocked}
                        onChange={(event) => updateBillingAccountDraft("taxName", event.target.value)}
                        />
                      </label>
                      <label className="settings-field">
                        <span>Tax number</span>
                        <input
                          value={invoiceSettingsDraft.taxNumber}
                        readOnly={billingSettingsIsLocked}
                        onChange={(event) => updateBillingAccountDraft("taxNumber", event.target.value)}
                          placeholder="GST / tax number"
                        />
                      </label>
                      <label className="settings-field">
                        <span>Tax rate</span>
                        <input
                          value={invoiceSettingsDraft.taxRate}
                          inputMode="decimal"
                          readOnly={billingSettingsIsLocked}
                        onChange={(event) => updateBillingAccountDraft("taxRate", parseMoneyInput(event.target.value))}
                          type="text"
                        />
                      </label>
                    </div>
                    <div className="service-form-row">
                      <label className="settings-field">
                        <span>Bank account</span>
                        <input
                          value={invoiceSettingsDraft.bankAccount}
                          readOnly={billingSettingsIsLocked}
                          onChange={(event) => updateBillingAccountDraft("bankAccount", event.target.value)}
                        />
                      </label>
                      <label className="settings-field">
                        <span>Payment terms days</span>
                        <input
                          value={invoiceSettingsDraft.paymentTermsDays}
                          inputMode="numeric"
                          readOnly={billingSettingsIsLocked}
                        onChange={(event) => updateBillingAccountDraft("paymentTermsDays", parseQuantityInput(event.target.value))}
                          type="text"
                        />
                      </label>
                    </div>
                    <label className="settings-field">
                      <span>Business address</span>
                      <textarea
                        value={invoiceSettingsDraft.businessAddress}
                        readOnly={billingSettingsIsLocked}
                        onChange={(event) => updateBillingAccountDraft("businessAddress", event.target.value)}
                        rows={2}
                      />
                    </label>
                    <div className="service-form-row">
                      <label className="settings-field">
                        <span>Header text</span>
                        <textarea
                          value={invoiceSettingsDraft.headerText}
                          readOnly={billingSettingsIsLocked}
                          onChange={(event) => updateBillingAccountDraft("headerText", event.target.value)}
                          rows={2}
                        />
                      </label>
                      <label className="settings-field">
                        <span>Footer text</span>
                        <textarea
                          value={invoiceSettingsDraft.footerText}
                          readOnly={billingSettingsIsLocked}
                          onChange={(event) => updateBillingAccountDraft("footerText", event.target.value)}
                          rows={2}
                        />
                      </label>
                    </div>
                    <label className="settings-field">
                      <span>Payment instructions</span>
                      <textarea
                        value={invoiceSettingsDraft.paymentInstructions}
                      readOnly={billingSettingsIsLocked}
                      onChange={(event) => updateBillingAccountDraft("paymentInstructions", event.target.value)}
                        rows={2}
                      />
                    </label>
                    <div className="custom-field-list">
                      <div className="services-topline">
                        <div>
                          <span>Custom fields</span>
                          <h2>Invoice fields</h2>
                        </div>
                        <button className="outline-button" disabled={billingSettingsIsLocked} onClick={addBillingCustomFieldDraft} type="button">
                          <Plus size={16} />
                          Add Field
                        </button>
                      </div>
                      {invoiceSettingsDraft.customFields.map((field) => (
                        <div className="custom-field-row" key={field.id}>
                          <label className="settings-field">
                            <span>Label</span>
                            <input
                              value={field.label}
                              readOnly={billingSettingsIsLocked}
                              onChange={(event) => updateBillingCustomFieldDraft(field.id, "label", event.target.value)}
                            />
                          </label>
                          <label className="settings-field">
                            <span>Value</span>
                            <input
                              value={field.value}
                              readOnly={billingSettingsIsLocked}
                              onChange={(event) => updateBillingCustomFieldDraft(field.id, "value", event.target.value)}
                            />
                          </label>
                          <label className="settings-field">
                            <span>Placement</span>
                            <select
                              value={field.placement}
                              disabled={billingSettingsIsLocked}
                              onChange={(event) =>
                                updateBillingCustomFieldDraft(field.id, "placement", event.target.value as InvoiceCustomFieldPlacement)
                              }
                            >
                              <option value="header">Header</option>
                              <option value="bill-to">Bill-to block</option>
                              <option value="payment">Payment block</option>
                              <option value="footer">Footer</option>
                            </select>
                          </label>
                          <button
                            className="icon-button"
                            disabled={billingSettingsIsLocked}
                            onClick={() => removeBillingCustomFieldDraft(field.id)}
                            type="button"
                            aria-label="Remove custom field"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </details>
                  </EditableSettingsBlock>
                </div>
              </article>

              <article className="data-card sync-card settings-section settings-integrations">
                <div className="data-card-header">
                  <div>
                    <span>Google Calendar Sync</span>
                    <h2>Direct API and iCal fallback</h2>
                  </div>
                  <KeyRound size={24} />
                </div>

                <div className={`sync-status ${googleCalendar.connected ? "connected" : googleCalendar.configured ? "checking" : "offline"}`}>
                  <span>Direct Google API</span>
                  <strong>
                    {!googleCalendarSyncEnabled
                      ? "Plan feature unavailable"
                      : !googleCalendar.configured
                      ? "Needs OAuth credentials"
                      : googleCalendar.connected
                        ? googleCalendar.manualOnly
                          ? "Manual sync only"
                          : googleCalendar.lastSyncStatus === "failed"
                          ? "Connected, sync failed"
                          : "Connected"
                        : "Ready to connect"}
                  </strong>
                  <em>
                    {!googleCalendarSyncEnabled
                      ? featureUnavailableMessage("googleCalendarSync")
                      : googleCalendar.lastSyncError
                      ? googleCalendar.manualOnly
                        ? `Last sync failed: ${googleCalendar.lastSyncError}`
                        : googleCalendar.lastSyncError
                      : googleCalendar.connected
                        ? `${googleCalendar.accountEmail || "Google account"} · ${googleSyncTimeLabel(googleCalendar.lastSyncAt)}`
                        : googleCalendar.legacyMigrationRequired
                          ? "Legacy plaintext token migration required."
                          : googleCalendar.redirectUri || "Add Google OAuth credentials in Netlify."}
                  </em>
                </div>

                <details className="settings-subsection" open>
                  <summary className="settings-subsection-title">
                    <Link2 size={18} />
                    <div>
                      <span>Direct API sync</span>
                      <strong>{googleCalendar.calendarId || "primary"}</strong>
                    </div>
                  </summary>
                  <label className="sync-field">
                    <span>Google calendar ID</span>
                    <input
                      value={googleCalendar.calendarId}
                      disabled={!googleCalendarSyncEnabled}
                      onChange={(event) => setGoogleCalendar((current) => ({ ...current, calendarId: event.target.value }))}
                      placeholder="primary or calendar email"
                    />
                  </label>
                  <div className="sync-meta">
                    <span>Sync mode</span>
                    <strong>{googleCalendar.manualOnly ? "Manual only" : "Automatic after every change"}</strong>
                  </div>
                  <div className="sync-meta">
                    <span>Redirect URI</span>
                    <code>{googleCalendar.redirectUri || "Set GOOGLE_CALENDAR_REDIRECT_URI or use /api/google-calendar/callback"}</code>
                  </div>
                  <div className="sync-actions">
                    {googleCalendar.legacyMigrationRequired ? (
                      <button
                        className="primary-button"
                        disabled={!googleCalendarSyncEnabled || googleCalendarAction !== "idle"}
                        onClick={migrateGoogleCalendarProviderToken}
                        type="button"
                      >
                        <KeyRound size={16} />
                        {googleCalendarAction === "migrating" ? "Migrating" : "Secure existing token"}
                      </button>
                    ) : !googleCalendar.connected ? (
                      <button
                        className="primary-button"
                        disabled={!googleCalendarSyncEnabled || !googleCalendar.configured || googleCalendarAction !== "idle"}
                        onClick={connectGoogleCalendar}
                        type="button"
                      >
                        <ExternalLink size={16} />
                        {googleCalendarAction === "connecting" ? "Opening Google" : "Connect Google"}
                      </button>
                    ) : (
                      <>
                        <button
                          className="primary-button"
                          disabled={!googleCalendarSyncEnabled || googleCalendarAction !== "idle"}
                          onClick={syncGoogleCalendarNow}
                          type="button"
                        >
                          <RefreshCw size={16} />
                          {googleCalendarAction === "syncing" ? "Syncing" : "Sync now"}
                        </button>
                        <button
                          className="outline-button"
                          disabled={!googleCalendarSyncEnabled || googleCalendarAction !== "idle"}
                          onClick={() => void saveGoogleCalendarSettings()}
                          type="button"
                        >
                          <Check size={16} />
                          {googleCalendarAction === "saving" ? "Saving" : "Save settings"}
                        </button>
                        <button
                          className="danger-button"
                          disabled={!googleCalendarSyncEnabled || googleCalendarAction !== "idle"}
                          onClick={disconnectGoogleCalendar}
                          type="button"
                        >
                          <X size={16} />
                          {googleCalendarAction === "disconnecting" ? "Disconnecting" : "Disconnect"}
                        </button>
                      </>
                    )}
                  </div>
                </details>

                <section className="settings-subsection video-storage-section" aria-labelledby="video-storage-heading">
                  <div className="video-storage-heading">
                    <div>
                      <span>VIDEO STORAGE</span>
                      <h3 id="video-storage-heading">My Library and Clarity Cloud</h3>
                    </div>
                    <Video size={20} />
                  </div>

                  <div className="video-storage-grid">
                    <article className={`storage-card is-${localStorageHealth.state}`}>
                      <div className="storage-card-header">
                        <FolderOpen size={18} />
                        <div>
                          <span>My Library</span>
                          <strong>{localStorageHealth.statusLabel}</strong>
                        </div>
                      </div>
                      <p>{localStorageHealth.message}</p>
                      <span className="storage-provider-line">{localStorageHealth.detail}</span>
                      {localStoragePrimaryAction ? (
                        <button
                          className="primary-button"
                          disabled={!managedLocalLibraryStatus.supported}
                          onClick={() => void runLocalStorageHealthAction(localStoragePrimaryAction)}
                          type="button"
                        >
                          <FolderOpen size={16} />
                          {getLocalStorageActionLabel(localStoragePrimaryAction)}
                        </button>
                      ) : null}
                    </article>

                    <article className={`storage-card is-${clarityCloudHealth.state}`}>
                      <div className="storage-card-header">
                        <Upload size={18} />
                        <div>
                          <span>Clarity Cloud</span>
                          <strong>{clarityCloudHealth.statusLabel}</strong>
                        </div>
                      </div>
                      <p>{clarityCloudHealth.message}</p>
                      <span className="storage-provider-line">Powered by {clarityCloudHealth.providerLabel}</span>
                      {clarityCloudPrimaryAction ? (
                        <button
                          className="primary-button"
                          disabled={googleDriveAction !== "idle"}
                          onClick={() => void runClarityCloudHealthAction(clarityCloudPrimaryAction)}
                          type="button"
                        >
                          <ExternalLink size={16} />
                          {googleDriveAction === "connecting"
                            ? "Opening provider"
                            : googleDriveAction === "testing"
                              ? "Checking"
                              : getClarityCloudActionLabel(clarityCloudPrimaryAction)}
                        </button>
                      ) : null}
                    </article>
                  </div>

                  <section className="storage-transfer-inbox" aria-label="Clarity Cloud catalogue">
                    <div className="storage-transfer-inbox-header">
                      <div>
                        <span>CLARITY CLOUD CATALOGUE</span>
                        <h4>Available in Clarity Cloud</h4>
                      </div>
                      <button
                        type="button"
                        className="outline-button"
                        disabled={!googleDriveTransfer.connected || !googleDriveTransfer.incomingImportReady}
                        onClick={() => void refreshClarityCloudImports()}
                      >
                        <RefreshCw size={16} />
                        Refresh
                      </button>
                    </div>
                    {clarityCloudImports.length ? (
                      <div className="storage-transfer-list">
                        {clarityCloudImports.map((transfer) => {
                          const savedVideoId = transfer.savedVideoId || transfer.savedVideo?.savedVideoId || transfer.transferId;
                          const statusLabel =
                            transfer.catalogueStatus === "complete"
                              ? "Available"
                              : transfer.catalogueStatus === "imported" || transfer.catalogueStatus === "cleanup_scheduled"
                                ? "Available on this device"
                                : transfer.catalogueStatus === "repair_required"
                                  ? "Needs repair"
                                  : "Available";
                          const canImport =
                            (transfer.catalogueStatus === "ready_to_import" ||
                              transfer.catalogueStatus === "complete" ||
                              transfer.catalogueStatus === "cleanup_scheduled") &&
                            !clarityCloudImportActionIds.has(savedVideoId);
                          return (
                            <article className="storage-transfer-row" key={savedVideoId}>
                              <div className="storage-transfer-icon">
                                <Download size={16} />
                              </div>
                              <div className="storage-transfer-copy">
                                <strong>{transfer.savedVideo?.title || "Saved video"}</strong>
                                <span>
                                  {statusLabel}
                                  {transfer.savedVideo?.createdAt ? ` · ${profileRecordDateLabel(transfer.savedVideo.createdAt)}` : ""}
                                  {transfer.video?.sizeBytes ? ` · ${Math.round(transfer.video.sizeBytes / 1024 / 1024)} MB` : ""}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="primary-button"
                                disabled={!canImport}
                                onClick={() => void importClarityCloudTransfer(transfer)}
                              >
                                <Download size={16} />
                                {clarityCloudImportActionIds.has(savedVideoId) ? "Downloading" : "Download to this device"}
                              </button>
                            </article>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="storage-transfer-empty">
                        {googleDriveTransfer.connected
                          ? "No Cloud videos are available yet."
                          : "Connect Clarity Cloud to see transfers from other devices."}
                      </p>
                    )}
                  </section>

                  <details
                    className="storage-diagnostics"
                    open={storageDiagnosticsOpen}
                    onToggle={(event) => setStorageDiagnosticsOpen(event.currentTarget.open)}
                  >
                    <summary className="settings-subsection-title">
                      <Code2 size={18} />
                      <div>
                        <span>Advanced storage diagnostics</span>
                        <strong>Local Storage and Clarity Cloud</strong>
                      </div>
                    </summary>
                    <div className="storage-diagnostics-grid">
                      <div className="storage-diagnostics-group">
                        <h4>Local Storage</h4>
                        <div className="sync-meta">
                          <span>Browser support</span>
                          <strong>{managedLocalLibraryStatus.supported ? "Supported" : "Browser-only"}</strong>
                        </div>
                        <div className="sync-meta">
                          <span>Directory handle</span>
                          <strong>{managedLocalLibraryStatus.configured ? "Available" : "Not selected"}</strong>
                        </div>
                        <div className="sync-meta">
                          <span>Verification</span>
                          <strong>{managedLocalLibraryStatus.health === "healthy" ? "Write/read passed" : managedLocalLibraryStatus.message}</strong>
                        </div>
                        <div className="sync-meta">
                          <span>Cache state</span>
                          <strong>IndexedDB recovery enabled</strong>
                        </div>
                        <div className="sync-meta">
                          <span>Safe error code</span>
                          <strong>{"safeErrorCode" in localStorageHealth && localStorageHealth.safeErrorCode ? localStorageHealth.safeErrorCode : "None"}</strong>
                        </div>
                        <div className="sync-actions">
                          <button
                            className="outline-button"
                            disabled={!managedLocalLibraryStatus.supported}
                            onClick={() => void runManagedLibraryAction("choose")}
                            type="button"
                          >
                            <FolderOpen size={16} />
                            Change folder
                          </button>
                          <button
                            className="outline-button"
                            disabled={!managedLocalLibraryStatus.supported}
                            onClick={() => void runManagedLibraryAction("move")}
                            type="button"
                          >
                            <ArrowRight size={16} />
                            Move library
                          </button>
                          <button
                            className="outline-button"
                            disabled={!managedLocalLibraryStatus.configured}
                            onClick={() => void runManagedLibraryAction("reconnect")}
                            type="button"
                          >
                            <RefreshCw size={16} />
                            Reconnect handle
                          </button>
                          <button
                            className="outline-button"
                            disabled={!managedLocalLibraryStatus.configured}
                            onClick={() => void runManagedLibraryAction("verify")}
                            type="button"
                          >
                            <Check size={16} />
                            Verify library
                          </button>
                          <button
                            className="outline-button"
                            disabled={!managedLocalLibraryStatus.configured}
                            onClick={() => void runManagedLibraryAction("rescan")}
                            type="button"
                          >
                            <RefreshCw size={16} />
                            Rescan library
                          </button>
                          <button
                            className="outline-button"
                            disabled={!managedLocalLibraryStatus.configured}
                            onClick={() => void runManagedLibraryAction("migrate")}
                            type="button"
                          >
                            <Archive size={16} />
                            Migrate cache
                          </button>
                        </div>
                      </div>

                      <div className="storage-diagnostics-group">
                        <h4>Clarity Cloud</h4>
                        <div className="sync-meta">
                          <span>Provider</span>
                          <strong>{clarityCloudHealth.providerLabel}</strong>
                        </div>
                        <div className="sync-meta">
                          <span>OAuth connection</span>
                          <strong>{googleDriveTransfer.connected ? googleDriveTransfer.accountEmail || "Connected" : "Not connected"}</strong>
                        </div>
                        <div className="sync-meta">
                          <span>Permission</span>
                          <strong>{googleDriveTransfer.driveScopeGranted ? "Granted" : "Required"}</strong>
                        </div>
                        <div className="sync-meta">
                          <span>Transfer folder</span>
                          <strong>{googleDriveTransfer.inboxFolderId ? "Ready" : "Not ready"}</strong>
                        </div>
                        <div className="sync-meta">
                          <span>Upload service</span>
                          <strong>{googleDriveTransfer.uploadRouteReady === false ? "Unavailable" : "Available"}</strong>
                        </div>
                        <div className="sync-meta">
                          <span>Chunked transport</span>
                          <strong>{googleDriveTransfer.chunkedTransportReady === false ? "Unavailable" : "Available"}</strong>
                        </div>
                        <div className="sync-meta">
                          <span>Incoming import</span>
                          <strong>{googleDriveTransfer.incomingImportReady ? "Ready" : "Next step"}</strong>
                        </div>
                        <div className="sync-meta">
                          <span>Safe error code</span>
                          <strong>{"safeErrorCode" in clarityCloudHealth && clarityCloudHealth.safeErrorCode ? clarityCloudHealth.safeErrorCode : "None"}</strong>
                        </div>
                        <div className="sync-meta">
                          <span>Missing configuration</span>
                          <strong>{googleDriveTransfer.missingConfiguration?.length ? googleDriveTransfer.missingConfiguration.join(", ") : "None"}</strong>
                        </div>
                        <div className="sync-actions">
                          <button
                            className="outline-button"
                            disabled={googleDriveAction !== "idle"}
                            onClick={connectGoogleDriveTransfer}
                            type="button"
                          >
                            <ExternalLink size={16} />
                            {googleDriveTransfer.connected ? "Reconnect provider" : "Connect provider"}
                          </button>
                          <button
                            className="outline-button"
                            disabled={googleDriveAction !== "idle"}
                            onClick={testGoogleDriveTransfer}
                            type="button"
                          >
                            <RefreshCw size={16} />
                            {googleDriveAction === "testing" ? "Testing" : "Test connection"}
                          </button>
                          <button
                            className="outline-button"
                            disabled={!googleDriveTransfer.inboxFolderId && !googleDriveTransfer.rootFolderId}
                            onClick={() => {
                              const folderId = googleDriveTransfer.inboxFolderId || googleDriveTransfer.rootFolderId;
                              if (folderId) {
                                window.open(`https://drive.google.com/drive/folders/${folderId}`, "_blank", "noopener,noreferrer");
                              }
                            }}
                            type="button"
                          >
                            <ExternalLink size={16} />
                            Open transfer inbox
                          </button>
                          <button
                            className="danger-button"
                            disabled={googleDriveAction !== "idle" || !googleDriveTransfer.connected}
                            onClick={disconnectGoogleDriveTransfer}
                            type="button"
                          >
                            <X size={16} />
                            {googleDriveAction === "disconnecting" ? "Disconnecting" : "Disconnect provider"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </details>
                </section>

                <div className={`sync-status ${calendarFeedStatus}`}>
                  <span>Feed endpoint</span>
                  <strong>
                    {calendarFeedStatus === "connected"
                      ? calendarSaveStatus === "failed"
                        ? "Connected — save needs retry"
                        : "Connected"
                      : calendarFeedStatus === "checking"
                        ? "Checking"
                        : "Offline"}
                  </strong>
                  <em>{calendarSaveError || calendarFeedUrl}</em>
                </div>
                <details className="settings-subsection">
                  <summary className="settings-subsection-title">
                    <KeyRound size={18} />
                    <div>
                      <span>Google Calendar</span>
                      <strong>
                        {items.filter((item) => item.kind === "appointment").length} appointments,{" "}
                        {items.filter((item) => item.kind === "block").length} busy blocks
                      </strong>
                    </div>
                  </summary>
                  <label className="sync-field">
                    <span>Live booking app URL</span>
                    <input
                      value={syncBaseUrl}
                      onChange={(event) => setSyncBaseUrl(event.target.value)}
                      placeholder={coachAccount.bookingUrl}
                    />
                  </label>

                  <div className="sync-output">
                    <span>Subscription URL</span>
                    <code>{calendarFeedUrl}</code>
                  </div>

                  <div className="sync-actions">
                    <button className="outline-button" onClick={() => copySyncText("url")}>
                      {copiedSync === "url" ? <Check size={16} /> : <Copy size={16} />}
                      {copiedSync === "url" ? "Copied URL" : "Copy URL"}
                    </button>
                    <button className="outline-button" onClick={() => copySyncText("key")}>
                      {copiedSync === "key" ? <Check size={16} /> : <KeyRound size={16} />}
                      {copiedSync === "key" ? "Copied key" : "Copy key"}
                    </button>
                    <button className="outline-button" onClick={regenerateSyncKey}>
                      <RefreshCw size={16} />
                      Regenerate
                    </button>
                    <a
                      className="outline-button"
                      href="https://calendar.google.com/calendar/u/0/r/settings/addbyurl"
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink size={16} />
                      Google
                    </a>
                  </div>
                </details>
              </article>

              <article className="data-card notification-card settings-section settings-email">
                <span>Email Notifications</span>
                <h2>Confirmation emails</h2>
                <EditableSettingsBlock
                  id="email-notifications-block"
                  title="Email Notifications"
                  status={emailNotificationsEditor.status}
                  dirty={emailNotificationsEditor.dirty}
                  errorMessage={emailNotificationsEditor.errorMessage}
                  onEdit={() => startEditableBlock("email-notifications")}
                  onCancel={() => cancelEditableBlock("email-notifications")}
                  onSave={() => void saveEditableBlock("email-notifications")}
                >
                <div className="settings-summary-grid">
                  <span>
                    <strong>{notificationSettings.notificationDelaySeconds}s</strong>
                    delay
                  </span>
                  <span>
                    <strong>{notificationSettings.sendClientEmail ? "On" : "Off"}</strong>
                    customer
                  </span>
                  <span>
                    <strong>{notificationSettings.sendCoachEmail ? "On" : "Off"}</strong>
                    coach
                  </span>
                  <span>
                    <strong>{notificationSettings.sendAdminEmail ? "On" : "Off"}</strong>
                    admin
                  </span>
                </div>
                <details className="settings-subsection">
                  <summary className="settings-subsection-title">
                    <Mail size={18} />
                    <div>
                      <span>Delivery</span>
                      <strong>{notificationSettings.notificationEmail || coachAccount.contactEmail}</strong>
                    </div>
                  </summary>
                  <label className="settings-field">
                    <span>Admin notification email</span>
                    <input
                      value={emailNotificationsDraft.notificationEmail}
                      readOnly={emailNotificationsIsLocked}
                      onChange={(event) => updateNotificationBlockDraft(emailNotificationsEditor, "notificationEmail", event.target.value)}
                      placeholder={coachAccount.contactEmail}
                    />
                  </label>
                  <label className="settings-field">
                    <span>Coach email (fallback)</span>
                    <input
                      value={emailNotificationsDraft.coachEmail}
                      readOnly={emailNotificationsIsLocked}
                      onChange={(event) => updateNotificationBlockDraft(emailNotificationsEditor, "coachEmail", event.target.value)}
                      placeholder="coach@email.co.nz"
                      type="email"
                    />
                  </label>
                  <p className="field-help">
                    Coach booking alerts go to the email on the coach profile of whoever is taking the lesson
                    (Settings → Coaches). This address is only used if that profile has no email.
                  </p>
                  <label className="settings-field">
                    <span>Notification delay seconds</span>
                    <input
                      value={emailNotificationsDraft.notificationDelaySeconds}
                      readOnly={emailNotificationsIsLocked}
                      min={30}
                      step={5}
                      inputMode="numeric"
                      onChange={(event) =>
                        updateNotificationBlockDraft(
                          emailNotificationsEditor,
                          "notificationDelaySeconds",
                          clamp(Number(event.target.value || 30), 30, 3600),
                        )
                      }
                      type="text"
                    />
                  </label>
                </details>
                <details className="settings-subsection">
                  <summary className="settings-subsection-title">
                    <Check size={18} />
                    <div>
                      <span>Send rules</span>
                      <strong>
                        {[
                          notificationSettings.sendClientEmail && "Customer",
                          notificationSettings.sendCoachEmail && "Coach",
                          notificationSettings.sendAdminEmail && "Admin",
                        ]
                          .filter(Boolean)
                          .join(" and ") || "Off"}
                      </strong>
                    </div>
                  </summary>
                  <label className="settings-toggle">
                    <input
                      checked={emailNotificationsDraft.sendClientEmail}
                      disabled={emailNotificationsIsLocked}
                      onChange={(event) => updateNotificationBlockDraft(emailNotificationsEditor, "sendClientEmail", event.target.checked)}
                      type="checkbox"
                    />
                    <span>Send client confirmation email</span>
                  </label>
                  <label className="settings-toggle">
                    <input
                      checked={emailNotificationsDraft.sendCoachEmail}
                      disabled={emailNotificationsIsLocked}
                      onChange={(event) => updateNotificationBlockDraft(emailNotificationsEditor, "sendCoachEmail", event.target.checked)}
                      type="checkbox"
                    />
                    <span>Send coach booking alert</span>
                  </label>
                  <label className="settings-toggle">
                    <input
                      checked={emailNotificationsDraft.sendAdminEmail}
                      disabled={emailNotificationsIsLocked}
                      onChange={(event) => updateNotificationBlockDraft(emailNotificationsEditor, "sendAdminEmail", event.target.checked)}
                      type="checkbox"
                    />
                    <span>Send admin booking alert</span>
                  </label>
                </details>
                </EditableSettingsBlock>
              </article>

              <article className="data-card notification-card settings-section settings-experience settings-integrations">
                <span>Text Machine</span>
                <h2>SMS/webhook hook</h2>
                <EditableSettingsBlock
                  id="text-machine-block"
                  title="Text Machine"
                  status={textMachineEditor.status}
                  dirty={textMachineEditor.dirty}
                  errorMessage={textMachineEditor.errorMessage}
                  onEdit={() => startEditableBlock("text-machine")}
                  onCancel={() => cancelEditableBlock("text-machine")}
                  onSave={() => void saveEditableBlock("text-machine")}
                >
                <div className="settings-summary-grid">
                  <span>
                    <strong>{notificationSettings.smsProviderName || "Not set"}</strong>
                    provider
                  </span>
                  <span>
                    <strong>{notificationSettings.sendClientSms ? "On" : "Off"}</strong>
                    customer
                  </span>
                  <span>
                    <strong>{notificationSettings.sendAdminSms ? "On" : "Off"}</strong>
                    admin
                  </span>
                </div>
                <details className="settings-subsection">
                  <summary className="settings-subsection-title">
                    <Phone size={18} />
                    <div>
                      <span>Provider</span>
                      <strong>{notificationSettings.smsProviderName || "Connect later"}</strong>
                    </div>
                  </summary>
                  <label className="settings-field">
                    <span>Provider name</span>
                    <input
                      value={textMachineDraft.smsProviderName}
                      readOnly={textMachineIsLocked}
                      onChange={(event) => updateNotificationBlockDraft(textMachineEditor, "smsProviderName", event.target.value)}
                      placeholder="Twilio, MessageMedia, Zapier..."
                    />
                  </label>
                  <label className="settings-field">
                    <span>Webhook or API URL</span>
                    <input
                      value={textMachineDraft.smsWebhookUrl}
                      readOnly={textMachineIsLocked}
                      onChange={(event) => updateNotificationBlockDraft(textMachineEditor, "smsWebhookUrl", event.target.value)}
                      placeholder="https://..."
                    />
                  </label>
                  <label className="settings-field">
                    <span>Sender or text number</span>
                    <input
                      value={textMachineDraft.smsFromNumber}
                      readOnly={textMachineIsLocked}
                      onChange={(event) => updateNotificationBlockDraft(textMachineEditor, "smsFromNumber", event.target.value)}
                      placeholder="+64..."
                    />
                  </label>
                </details>
                <details className="settings-subsection">
                  <summary className="settings-subsection-title">
                    <Check size={18} />
                    <div>
                      <span>Send rules</span>
                      <strong>
                        {[notificationSettings.sendClientSms && "Customer", notificationSettings.sendAdminSms && "Admin"]
                          .filter(Boolean)
                          .join(" and ") || "Off"}
                      </strong>
                    </div>
                  </summary>
                  <label className="settings-toggle">
                    <input
                      checked={textMachineDraft.sendClientSms}
                      disabled={textMachineIsLocked}
                      onChange={(event) => updateNotificationBlockDraft(textMachineEditor, "sendClientSms", event.target.checked)}
                      type="checkbox"
                    />
                    <span>Send client text confirmation</span>
                  </label>
                  <label className="settings-toggle">
                    <input
                      checked={textMachineDraft.sendAdminSms}
                      disabled={textMachineIsLocked}
                      onChange={(event) => updateNotificationBlockDraft(textMachineEditor, "sendAdminSms", event.target.checked)}
                      type="checkbox"
                    />
                    <span>Send admin text alert</span>
                  </label>
                </details>
                </EditableSettingsBlock>
              </article>

              <article className="data-card notification-card email-template-card settings-section settings-email">
                <span>Email Template</span>
                <h2>Customer experience</h2>
                <div className="email-preview">
                  <span>Example</span>
                  <strong>{emailTemplateExample.clientSubject}</strong>
                  <p>{emailTemplateExample.clientIntro}</p>
                  <dl>
                    <div>
                      <dt>Lesson</dt>
                      <dd>{emailTemplateVariables.service}</dd>
                    </div>
                    <div>
                      <dt>When</dt>
                      <dd>
                        {emailTemplateVariables.date}, {emailTemplateVariables.time}
                      </dd>
                    </div>
                    <div>
                      <dt>Where</dt>
                      <dd>{emailTemplateVariables.venue}</dd>
                    </div>
                    <div>
                      <dt>Price</dt>
                      <dd>{emailTemplateVariables.price}</dd>
                    </div>
                  </dl>
                  <p>{emailTemplateExample.clientFooter}</p>
                  <em>
                    Admin alert: {emailTemplateExample.adminSubject} - {emailTemplateExample.adminIntro}
                  </em>
                </div>
                <EditableSettingsBlock
                  id="email-template-block"
                  title="Email Template"
                  status={emailTemplateEditor.status}
                  dirty={emailTemplateEditor.dirty}
                  errorMessage={emailTemplateEditor.errorMessage}
                  onEdit={() => startEditableBlock("email-template")}
                  onCancel={() => cancelEditableBlock("email-template")}
                  onSave={() => void saveEditableBlock("email-template")}
                >
                <details className="settings-subsection">
                  <summary className="settings-subsection-title">
                    <Mail size={18} />
                    <div>
                      <span>Email delivery identity</span>
                      <strong>{notificationSettings.configuredSenderEmailAddress || "Provider-controlled"}</strong>
                    </div>
                  </summary>
                  <label className="settings-field">
                    <span>Email sender name</span>
                    <input
                      placeholder="Sam Hale Golf"
                      value={emailTemplateDraft.notificationFromName}
                      readOnly={emailTemplateIsLocked}
                      maxLength={120}
                      onChange={(event) =>
                        updateNotificationBlockDraft(emailTemplateEditor, "notificationFromName", event.target.value.slice(0, 120))}
                    />
                  </label>
                  <p className="field-help">This is the display name clients see in their inbox.</p>
                  <label className="settings-field">
                    <span>Sender email address</span>
                    <input
                      value={notificationSettings.configuredSenderEmailAddress}
                      type="email"
                      readOnly
                      disabled
                      placeholder="Sender address controlled by provider"
                    />
                  </label>
                  <p className="field-help">The sender email address is controlled by your configured email provider/domain.</p>
                  <label className="settings-field">
                    <span>Reply-to email</span>
                    <input
                      value={emailTemplateDraft.replyToEmail}
                      readOnly={emailTemplateIsLocked}
                      onChange={(event) => updateNotificationBlockDraft(emailTemplateEditor, "replyToEmail", event.target.value)}
                      placeholder={coachAccount.contactEmail}
                    />
                  </label>
                </details>
                <details className="settings-subsection">
                  <summary className="settings-subsection-title">
                    <ExternalLink size={18} />
                    <div>
                      <span>Google review link</span>
                      <strong>{notificationSettings.googleReviewUrl ? "Configured" : "Not set"}</strong>
                    </div>
                  </summary>
                  <label className="settings-field">
                    <span>Google review URL</span>
                    <input
                      type="url"
                      value={emailTemplateDraft.googleReviewUrl}
                      readOnly={emailTemplateIsLocked}
                      maxLength={700}
                      onChange={(event) => updateNotificationBlockDraft(emailTemplateEditor, "googleReviewUrl", event.target.value.slice(0, 700))}
                      placeholder="direct Google review link"
                    />
                  </label>
                  <p className="field-help">Used for optional review buttons in client emails. Leave blank to hide review links.</p>
                </details>
                <details className="settings-subsection">
                  <summary className="settings-subsection-title">
                    <Mail size={18} />
                    <div>
                      <span>Test send</span>
                      <strong>{testEmailAddress || notificationSettings.notificationEmail || coachAccount.contactEmail}</strong>
                    </div>
                  </summary>
                  <label className="settings-field">
                    <span>Send test to</span>
                    <input
                      value={testEmailAddress}
                      onChange={(event) => setTestEmailAddress(event.target.value)}
                      placeholder={notificationSettings.notificationEmail || coachAccount.contactEmail}
                      type="email"
                    />
                  </label>
                  <button className="outline-button" onClick={sendTestEmail} disabled={testEmailState === "sending"} type="button">
                    <Mail size={16} />
                    {testEmailState === "sending" ? "Sending..." : testEmailState === "sent" ? "Sent" : "Send Test Email"}
                  </button>
                </details>
                <details className="settings-subsection">
                  <summary className="settings-subsection-title">
                    <Mail size={18} />
                    <div>
                      <span>Customer email</span>
                      <strong>{notificationSettings.clientEmailSubject}</strong>
                    </div>
                  </summary>
                  <label className="settings-field">
                    <span>Customer subject</span>
                    <input
                      value={emailTemplateDraft.clientEmailSubject}
                      readOnly={emailTemplateIsLocked}
                      onChange={(event) => updateNotificationBlockDraft(emailTemplateEditor, "clientEmailSubject", event.target.value)}
                    />
                  </label>
                  <label className="settings-field">
                    <span>Customer opening</span>
                    <textarea
                      rows={3}
                      value={emailTemplateDraft.clientEmailIntro}
                      readOnly={emailTemplateIsLocked}
                      onChange={(event) => updateNotificationBlockDraft(emailTemplateEditor, "clientEmailIntro", event.target.value)}
                    />
                  </label>
                  <label className="settings-field">
                    <span>Footer / reschedule note</span>
                    <textarea
                      rows={3}
                      value={emailTemplateDraft.clientEmailFooter}
                      readOnly={emailTemplateIsLocked}
                      onChange={(event) => updateNotificationBlockDraft(emailTemplateEditor, "clientEmailFooter", event.target.value)}
                    />
                  </label>
                </details>
                <details className="settings-subsection">
                  <summary className="settings-subsection-title">
                    <Mail size={18} />
                    <div>
                      <span>Email subject override</span>
                      <strong>
                        {notificationSettings.notificationSubjectLine.trim() ? renderTemplate(notificationSettings.notificationSubjectLine, emailTemplateVariables) : "Per-notification defaults"}
                      </strong>
                    </div>
                  </summary>
                  <label className="settings-field">
                    <span>Subject template</span>
                    <input
                      maxLength={180}
                      placeholder="Use {{client}}, {{service}}, {{date}}, {{time}}, {{action}}"
                      value={emailTemplateDraft.notificationSubjectLine}
                      readOnly={emailTemplateIsLocked}
                      onChange={(event) =>
                        updateNotificationBlockDraft(emailTemplateEditor, "notificationSubjectLine", event.target.value.slice(0, 180))}
                    />
                  </label>
                  <p className="field-help">Blank keeps existing per-notification defaults.</p>
                  <div className="template-token-controls" aria-label="Subject tokens">
                    {NOTIFICATION_SUBJECT_TOKENS.map((token) => (
                      <button className="template-token-button" key={token} onClick={() => insertNotificationSubjectToken(token)} type="button">
                        {token}
                      </button>
                    ))}
                  </div>
                  <p className="field-help">
                    Preview:{" "}
                    <strong>
                      {emailSubjectTemplatePreview || "Blank uses existing per-notification defaults."}
                    </strong>
                  </p>
                  <div className="settings-actions">
                    <button
                      className="outline-button"
                      type="button"
                      onClick={() => updateNotificationBlockDraft(emailTemplateEditor, "notificationSubjectLine", "")}
                    >
                      Clear override
                    </button>
                  </div>
                </details>
                <details className="settings-subsection">
                  <summary className="settings-subsection-title">
                    <User size={18} />
                    <div>
                      <span>Admin alert</span>
                      <strong>{notificationSettings.adminEmailSubject}</strong>
                    </div>
                  </summary>
                  <label className="settings-field">
                    <span>Admin subject</span>
                    <input
                      value={emailTemplateDraft.adminEmailSubject}
                      readOnly={emailTemplateIsLocked}
                      onChange={(event) => updateNotificationBlockDraft(emailTemplateEditor, "adminEmailSubject", event.target.value)}
                    />
                  </label>
                  <label className="settings-field">
                    <span>Admin summary</span>
                    <textarea
                      rows={3}
                      value={emailTemplateDraft.adminEmailIntro}
                      readOnly={emailTemplateIsLocked}
                      onChange={(event) => updateNotificationBlockDraft(emailTemplateEditor, "adminEmailIntro", event.target.value)}
                    />
                  </label>
                </details>
                <details className="settings-subsection token-subsection">
                  <summary className="settings-subsection-title">
                    <Code2 size={18} />
                    <div>
                      <span>Tokens</span>
                      <strong>Template placeholders</strong>
                    </div>
                  </summary>
                  <div className="template-token-list" aria-label="Email template tokens">
                    <code>{"{{client}}"}</code>
                    <code>{"{{firstName}}"}</code>
                    <code>{"{{service}}"}</code>
                    <code>{"{{date}}"}</code>
                    <code>{"{{time}}"}</code>
                    <code>{"{{venue}}"}</code>
                    <code>{"{{price}}"}</code>
                  </div>
                </details>
                </EditableSettingsBlock>
              </article>

              <article className="data-card notification-card settings-section settings-experience settings-branding">
                <span>Theme</span>
                <h2>Light and dark surfaces</h2>
                <details className="settings-subsection">
                  <summary className="settings-subsection-title">
                    <Settings size={18} />
                    <div>
                      <span>Admin workspace</span>
                      <strong>{themeMode === "dark" ? "Dark workspace" : "Light workspace"}</strong>
                    </div>
                  </summary>
                  <div className="booking-surface-setting">
                    <div>
                      <span>Admin theme</span>
                      <strong>{themeMode === "dark" ? "Dark workspace" : "Light workspace"}</strong>
                    </div>
                    <button
                      aria-label={`Switch admin theme to ${themeMode === "dark" ? "light" : "dark"}`}
                      aria-pressed={themeMode === "dark"}
                      className={`theme-switch theme-toggle ${themeMode === "dark" ? "is-dark" : "is-light"}`}
                      data-testid="admin-theme-switch"
                      onClick={() => setThemeMode((current) => (current === "dark" ? "light" : "dark"))}
                      type="button"
                    >
                      <span className={themeMode === "light" ? "active" : ""} aria-hidden="true">
                        <Sun size={15} />
                      </span>
                      <span className={themeMode === "dark" ? "active" : ""} aria-hidden="true">
                        <Moon size={15} />
                      </span>
                    </button>
                  </div>
                </details>
                <details className="settings-subsection">
                  <summary className="settings-subsection-title">
                    <Eye size={18} />
                    <div>
                      <span>Booking surface</span>
                      <strong>{brandSettings.bookingTheme === "dark" ? "Dark branded cards" : "Light branded cards"}</strong>
                    </div>
                  </summary>
                  <div className="booking-surface-setting">
                    <div>
                      <span>Booking surface</span>
                      <strong>{brandSettings.bookingTheme === "dark" ? "Dark branded cards" : "Light branded cards"}</strong>
                    </div>
                    <button
                      aria-label={`Switch booking cards to ${brandSettings.bookingTheme === "dark" ? "light" : "dark"}`}
                      aria-pressed={brandSettings.bookingTheme === "dark"}
                      className={`theme-switch theme-toggle ${brandSettings.bookingTheme === "dark" ? "is-dark" : "is-light"}`}
                      data-testid="booking-theme-switch"
                      onClick={() => setBookingCardTheme(brandSettings.bookingTheme === "dark" ? "light" : "dark")}
                      type="button"
                    >
                      <span className={brandSettings.bookingTheme === "light" ? "active" : ""} aria-hidden="true">
                        <Sun size={15} />
                      </span>
                      <span className={brandSettings.bookingTheme === "dark" ? "active" : ""} aria-hidden="true">
                        <Moon size={15} />
                      </span>
                    </button>
                  </div>
                  <div className="booking-surface-setting">
                    <div>
                      <span>Booking logo</span>
                      <strong>{brandSettings.showLogo ? "Logo shown" : "No logo"}</strong>
                    </div>
                    <button
                      aria-label={`${brandSettings.showLogo ? "Hide" : "Show"} booking logo`}
                      aria-pressed={brandSettings.showLogo}
                      className={`theme-switch logo-toggle ${brandSettings.showLogo ? "is-dark" : "is-light"}`}
                      onClick={() => setBookingLogoVisible(!brandSettings.showLogo)}
                      type="button"
                    >
                      <span className={!brandSettings.showLogo ? "active" : ""} aria-hidden="true">
                        Off
                      </span>
                      <span className={brandSettings.showLogo ? "active" : ""} aria-hidden="true">
                        On
                      </span>
                    </button>
                  </div>
                </details>
              </article>

              <article className="data-card brand-vein-card settings-section settings-branding settings-experience">
                <div className="data-card-header">
                  <div>
                    <span>Coach Branding</span>
                    <h2>Coach branding</h2>
                  </div>
                  <Palette size={24} />
                </div>

                <div className="brand-vein-preview">
                  <div className="brand-vein-logo">
                    {brandSettings.logoPreview ? (
                      <img src={brandSettings.logoPreview} alt={`${bookingBrandName} logo preview`} />
                    ) : (
                      <strong>{bookingBrandWords.map((word) => word[0]).join("").slice(0, 3).toUpperCase()}</strong>
                    )}
                  </div>
                  <div>
                    <span>Current coach brand</span>
                    <strong>{brandSettings.coachName}</strong>
                    <em>{brandSettings.logoName || "No logo uploaded yet"}</em>
                  </div>
                </div>

                <details className="settings-subsection">
                  <summary className="settings-subsection-title">
                    <ImagePlus size={18} />
                    <div>
                      <span>Logo and colours</span>
                      <strong>{brandSettings.logoName || "Upload coach logo"}</strong>
                    </div>
                  </summary>
                  <label className="settings-field">
                    <span>Coach brand name</span>
                    <input
                      value={brandSettings.coachName}
                      onChange={(event) => updateBrandSetting("coachName", event.target.value)}
                      onBlur={() => void saveBrandSettings()}
                      placeholder={coachAccount.businessName}
                    />
                  </label>
                  <div className="brand-swatches" aria-label="Extracted logo colours">
                    <span style={swatchStyle(brandSettings.neutral)}>
                      <em>Neutral</em>
                      {brandSettings.neutral}
                    </span>
                    <span style={swatchStyle(brandSettings.primary)}>
                      <em>Primary</em>
                      {brandSettings.primary}
                    </span>
                    <span style={swatchStyle(brandSettings.secondary)}>
                      <em>Secondary</em>
                      {brandSettings.secondary}
                    </span>
                    <span style={swatchStyle(brandSettings.accent)}>
                      <em>Ink</em>
                      {brandSettings.accent}
                    </span>
                  </div>
                  <div className="brand-vein-actions">
                    <label className="outline-button logo-upload">
                      <ImagePlus size={16} />
                      Upload logo
                      <input accept="image/*" onChange={handleLogoUpload} type="file" />
                    </label>
                    <button className="outline-button" onClick={() => void saveBrandSettings()}>
                      {brandSaveState === "saved" ? <Check size={16} /> : <Sparkles size={16} />}
                      {brandSaveState === "saving" ? "Saving" : brandSaveState === "saved" ? "Saved" : "Apply"}
                    </button>
                    <button className="outline-button" onClick={resetBrandSettings}>
                      Reset
                    </button>
                  </div>
                </details>
              </article>

              <article className="data-card import-card settings-section settings-data">
                <div className="data-card-header">
                  <div>
                    <span>Clients</span>
                    <h2>Import clients</h2>
                  </div>
                  <Upload size={24} />
                </div>
                <details className="settings-subsection">
                  <summary className="settings-subsection-title">
                    <Upload size={18} />
                    <div>
                      <span>CSV paste</span>
                      <strong>{peopleImportPreview} ready</strong>
                    </div>
                  </summary>
	                  <textarea
	                    value={peopleImportText}
	                    onChange={(event) => {
	                      setPeopleImportState("idle");
                        setPeopleImportDiagnostic(null);
	                      setPeopleImportText(event.target.value);
	                    }}
	                    placeholder="name,email,phone,notes,caddyProfileUrl"
	                  />
	                  <div className="import-actions">
                      <div className="import-action-tools">
                        <label className="outline-button import-file-button">
                          <Upload size={16} />
                          CSV file
                          <input accept=".csv,text/csv,text/plain" onChange={handlePeopleImportFile} type="file" />
                        </label>
	                      <span>{peopleImportPreview} ready</span>
                      </div>
	                    <button
	                      className="primary-button"
	                      onClick={importPeopleFromText}
	                      disabled={peopleImportState === "importing" || peopleImportPreview === 0}
	                    >
	                      {peopleImportState === "importing" ? "Importing" : peopleImportState === "imported" ? "Imported" : "Import"}
	                    </button>
	                  </div>
                    {peopleImportDiagnostic && (
                      <div className={`import-diagnostics${peopleImportDiagnostic.ok ? "" : " error"}`} role={peopleImportDiagnostic.ok ? "status" : "alert"}>
                        <strong>{peopleImportDiagnostic.message}</strong>
                        <span>Endpoint: {peopleImportDiagnostic.endpoint}</span>
                        <span>HTTP: {peopleImportDiagnostic.status}</span>
                        <span>
                          Imported {peopleImportDiagnostic.imported} · Updated {peopleImportDiagnostic.updated} · Skipped {peopleImportDiagnostic.skipped}
                          {peopleImportDiagnostic.failed ? ` · Failed ${peopleImportDiagnostic.failed}` : ""}
                        </span>
                        {peopleImportDiagnostic.errors.map((message) => (
                          <em key={message}>{message}</em>
                        ))}
                      </div>
                    )}
	                </details>
              </article>
            </div>
          </section>
        )}
      </main>

      {!isEmbedMode && adminWorkspaceReady && activeView === "calendar" && selectedDetails && (
        <div className="details-overlay" role="presentation" onPointerDown={closeCalendarDetails}>
          <aside
            className="details-panel details-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="appointment-details-title"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {selectedDetails}
          </aside>
        </div>
      )}

      {!isEmbedMode && pendingService && pendingServiceAction && (
        <div className="details-overlay" role="presentation" onPointerDown={closeServiceActionModal}>
          <aside
            className="details-panel details-modal service-delete-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="service-action-title"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="panel-header">
              <span>{pendingServiceAction.mode === "archive" ? "Archive Lesson Type" : "Permanent Delete"}</span>
              <button className="icon-button small" onClick={closeServiceActionModal} aria-label="Close lesson type action" type="button">
                <X size={17} />
              </button>
            </div>
            <h2 id="service-action-title">
              {pendingServiceAction.mode === "archive"
                ? `Archive ${pendingService.name}?`
                : `Permanently delete ${pendingService.name}?`}
            </h2>
            <p>
              {pendingServiceAction.mode === "archive"
                ? "This will hide the lesson type from active settings and public booking screens, but existing client records and old bookings will keep their lesson name."
                : "This removes the lesson type completely. Only use this for test or unused lesson types with no client records."}
            </p>
            <div className="service-delete-actions">
              <button className="outline-button" onClick={closeServiceActionModal} type="button">
                Cancel
              </button>
              <button
                className={pendingServiceAction.mode === "archive" ? "primary-button" : "danger-button"}
                onClick={confirmServiceAction}
                type="button"
              >
                {pendingServiceAction.mode === "archive" ? <Archive size={16} /> : <Trash2 size={16} />}
                {pendingServiceAction.mode === "archive" ? "Archive lesson type" : "Permanently delete"}
              </button>
            </div>
          </aside>
        </div>
      )}

      {!isEmbedMode && clientMergeReview && (
        <div className="details-overlay" role="presentation" onPointerDown={closeClientMergeReview}>
          <aside
            className="details-panel details-modal client-merge-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="client-merge-title"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="panel-header">
              <span id="client-merge-title">Merge clients</span>
              <button className="icon-button small" onClick={closeClientMergeReview} aria-label="Close merge review" type="button">
                <X size={17} />
              </button>
            </div>
            <p className="muted">
              {clientMergeReview.loser.name || clientMergeReview.loser.email || "This client"} will be merged into{" "}
              {clientMergeReview.survivor.name || clientMergeReview.survivor.email || "this client"} and removed.
              {clientMergeReview.loser.count > 0 &&
                ` ${clientMergeReview.loser.count} booking${clientMergeReview.loser.count === 1 ? "" : "s"} will move over.`}
            </p>
            <div className="client-merge-fields">
              {(
                [
                  ["name", "Name"],
                  ["email", "Email"],
                  ["phone", "Phone"],
                  ["notes", "Notes"],
                ] as [ClientMergeFieldKey, string][]
              ).map(([field, label]) => {
                const survivorValue = clientMergeReview.survivor[field] || "";
                const loserValue = clientMergeReview.loser[field] || "";
                if (survivorValue === loserValue) {
                  return (
                    <div className="settings-field client-merge-field" key={field}>
                      <span>{label}</span>
                      <p className="client-merge-field-value">{survivorValue || "—"}</p>
                    </div>
                  );
                }
                const options = Array.from(new Set([survivorValue, loserValue].filter(Boolean)));
                return (
                  <div className="settings-field client-merge-field" key={field}>
                    <span>{label}</span>
                    <div className="client-merge-field-options">
                      {options.map((value) => (
                        <label
                          className={`client-merge-option${clientMergeReview.fields[field] === value ? " selected" : ""}`}
                          key={value}
                        >
                          <input
                            type="radio"
                            name={`client-merge-${field}`}
                            checked={clientMergeReview.fields[field] === value}
                            onChange={() => setClientMergeFieldChoice(field, value)}
                          />
                          <span>{value}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            {clientMergeError && <p className="client-merge-error">{clientMergeError}</p>}
            <div className="client-merge-actions">
              <button className="outline-button" onClick={closeClientMergeReview} type="button" disabled={clientMergeSaving}>
                Cancel
              </button>
              <button className="primary-button" onClick={confirmClientMerge} type="button" disabled={clientMergeSaving}>
                {clientMergeSaving ? "Merging…" : "Merge clients"}
              </button>
            </div>
          </aside>
        </div>
      )}

      {!isEmbedMode && (selectedClient || isAddingClient) && (
        <div className="details-overlay" role="presentation" onPointerDown={closeClientModal}>
          <aside
            className="details-panel details-modal client-profile-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="client-profile-title"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="panel-header">
              <span>{isAddingClient ? "Add Client" : "Client Profile"}</span>
              <button className="icon-button small" onClick={closeClientModal} aria-label="Close client profile">
                <X size={17} />
              </button>
            </div>

            {clientEditMode ? (
              <div className="client-editor">
                <label className="settings-field">
                  <span>Name</span>
                  <input
                    value={clientEditor.name}
                    autoComplete="name"
                    onChange={(event) => setClientEditor((current) => ({ ...current, name: event.target.value }))}
                  />
                </label>
                <label className="settings-field">
                  <span>Email</span>
                  <input
                    value={clientEditor.email}
                    autoComplete="email"
                    inputMode="email"
                    onChange={(event) => setClientEditor((current) => ({ ...current, email: event.target.value }))}
                    type="email"
                  />
                </label>
                <label className="settings-field">
                  <span>Phone</span>
                  <input
                    value={clientEditor.phone}
                    autoComplete="tel"
                    inputMode="tel"
                    onChange={(event) => setClientEditor((current) => ({ ...current, phone: event.target.value }))}
                    type="tel"
                  />
                </label>
                <label className="settings-field">
                  <span>Caddy profile URL</span>
                  <input
                    value={clientEditor.caddyProfileUrl}
                    onChange={(event) =>
                      setClientEditor((current) => ({ ...current, caddyProfileUrl: event.target.value }))
                    }
                  />
                </label>
                <label className="settings-field">
                  <span>Profile notes</span>
                  <textarea
                    value={clientEditor.notes}
                    onChange={(event) => setClientEditor((current) => ({ ...current, notes: event.target.value }))}
                  />
                </label>
              </div>
            ) : (
              <>
                <h2 id="client-profile-title">{selectedClient?.name}</h2>
                <div className="info-stack client-profile-info">
                  <div>
                    <Mail size={16} />
                    <span>{selectedClient?.email || "No email yet"}</span>
                  </div>
                  <div>
                    <Phone size={16} />
                    <span>{selectedClient?.phone || "No phone yet"}</span>
                  </div>
                  <div>
                    <CalendarDays size={16} />
                    <span>
                      {selectedClient?.count ?? 0} booking{selectedClient?.count === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
                {selectedClient && profileNotesText(selectedClient) && (
                  <div className="client-profile-note-block">
                    <strong>Profile notes</strong>
                    <p>{profileNotesText(selectedClient)}</p>
                  </div>
                )}
                {selectedClient && (
                  <button
                    type="button"
                    className="outline-button client-video-button"
                    onClick={() =>
                      openVideoAnalysisForClient({
                        id: preferredVideoPlayerId(selectedClient, videoPlayerIds),
                        name: selectedClient.name,
                      })
                    }
                  >
                    <Video size={16} />
                    Open Video Analysis
                  </button>
                )}
              </>
            )}

            {!isAddingClient && (
              <div className="client-profile-tabs">
                <div className="profile-tab-list" role="tablist" aria-label="Client profile sections">
                  <button
                    className={clientProfileTab === "bookings" ? "active" : ""}
                    onClick={() => setClientProfileTab("bookings")}
                    role="tab"
                    type="button"
                    aria-selected={clientProfileTab === "bookings"}
                  >
                    <CalendarDays size={16} />
                    Booking history
                  </button>
                  <button
                    className={clientProfileTab === "notes" ? "active" : ""}
                    onClick={() => setClientProfileTab("notes")}
                    role="tab"
                    type="button"
                    aria-selected={clientProfileTab === "notes"}
                  >
                    <FileText size={16} />
                    Lesson notes
                  </button>
                  <button
                    className={clientProfileTab === "notifications" ? "active" : ""}
                    onClick={() => setClientProfileTab("notifications")}
                    role="tab"
                    type="button"
                    aria-selected={clientProfileTab === "notifications"}
                  >
                    <Mail size={16} />
                    Emails sent
                  </button>
                </div>

                <div className="profile-history-panel">
                  {clientProfileTab === "bookings" ? (
                    selectedClientAppointments.length ? (
                      selectedClientAppointments.map((appointment) => {
                        const appointmentDays = buildWeekDays(itemWeek(appointment));
                        const service = itemService(appointment, services);
                        return (
                          <div className="profile-history-row" key={appointment.id}>
                            <div>
                              <strong>{service?.name ?? appointment.title}</strong>
                              <span>{appointment.kind === "appointment" ? "Booked lesson" : "Blocked time"}</span>
                              {appointment.note ? (
                                <span className="booking-note-line">Booking notes: {appointment.note}</span>
                              ) : null}
                            </div>
                            <em>{`${appointmentDays[appointment.day].label}, ${formatRange(appointment.start, appointment.duration)}`}</em>
                          </div>
                        );
                      })
                    ) : (
                      <p>No appointments yet.</p>
                    )
                  ) : clientProfileTab === "notes" ? (
                    <div className="lesson-notes-panel">
                      {selectedClient && (
                        <div className="lesson-notes-window">
                          <div>
                            <strong>Lesson Notes</strong>
                            <span>Start something fresh, or open the player profile for older records.</span>
                          </div>
                          <div className="lesson-quick-actions">
                            <button
                              type="button"
                              className="icon-button"
                              onClick={() => openNotesForClient(selectedClient)}
                              title="Add lesson note"
                              aria-label="Add lesson note"
                            >
                              <Plus size={16} />
                              <FileText size={15} />
                            </button>
                            <button
                              type="button"
                              className="icon-button"
                              onClick={() =>
                                openVideoAnalysisForClient({
                                  id: preferredVideoPlayerId(selectedClient, videoPlayerIds),
                                  name: selectedClient.name,
                                })
                              }
                              title="Add video"
                              aria-label="Add video"
                            >
                              <Plus size={16} />
                              <Video size={15} />
                            </button>
                            <button
                              type="button"
                              className="outline-button"
                              onClick={() => openNotesForClient(selectedClient)}
                            >
                              <User size={15} />
                              Player profile
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : selectedClientNotifications.length ? (
                    selectedClientNotifications.map((notification) => (
                      <div className="profile-history-row notification-history-row" key={notification.id}>
                        <div>
                          <strong>{notification.subject || notificationKindLabel(notification.kind)}</strong>
                          <span>
                            {notificationKindLabel(notification.kind)} to {notification.recipient}
                          </span>
                        </div>
                        <em>
                          {notificationStatusLabel(notification)}
                          {notification.createdAt ? ` · ${notificationTimeLabel(notification.createdAt)}` : ""}
                        </em>
                      </div>
                    ))
                  ) : (
                    <p>No email receipts recorded yet.</p>
                  )}
                </div>
              </div>
            )}

            <div className="panel-actions">
              {clientEditMode ? (
                <>
                  <button className="primary-button" onClick={saveClientProfile} disabled={clientSaveState === "saving"}>
                    <Check size={16} />
                    {clientSaveState === "saving" ? "Saving" : "Save"}
                  </button>
                  <button
                    className="outline-button"
                    onClick={() => {
                      if (isAddingClient) {
                        closeClientModal();
                        return;
                      }
                      setClientEditMode(false);
                      if (selectedClient) setClientEditor(editorFromClient(selectedClient));
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button className="primary-button" onClick={startClientEdit}>
                    <User size={16} />
                    Edit
                  </button>
                  {selectedClient && hasSelectedClientCaddyProfile ? (
                    <a
                      className="outline-button"
                      href={caddyProfileUrl(selectedClient, caddyWorkspaceUrl)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink size={16} />
                      Caddy
                    </a>
                  ) : (
                    <button className="outline-button" type="button">
                      <Link2 size={16} />
                      Add Clarity Caddy
                    </button>
                  )}
                </>
              )}
            </div>
          </aside>
        </div>
      )}

      {edgeCue && <div className={`edge-cue ${edgeCue}`}>{edgeCue === "next" ? "Next week" : "Previous week"}</div>}
    </div>
  );
}

export default App;
