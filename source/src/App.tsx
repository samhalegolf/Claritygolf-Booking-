import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  CalendarDays,
  Check,
  Code2,
  Copy,
  Clock,
  Download,
  Eye,
  ExternalLink,
  FileText,
  GripVertical,
  ImagePlus,
  KeyRound,
  LayoutDashboard,
  Link2,
  LogOut,
  Mail,
  MapPin,
  Moon,
  Package,
  Palette,
  Phone,
  Plus,
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
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangeEvent,
  CSSProperties,
  FormEvent,
  MouseEvent as ReactMouseEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  TouchEvent as ReactTouchEvent,
} from "react";

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

type Service = {
  id: string;
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
  location: string;
  groupSchedule?: GroupServiceSchedule;
  packageAllowance?: number;
  packageCoverageMode?: PackageCoverageMode;
  packageCoversServiceId?: string;
  bookingScreenIds?: string[];
};

type CalendarItem = {
  id: string;
  kind: "appointment" | "block";
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
  note?: string;
  status?: BookingStatus;
};

type PendingBooking = {
  id: string;
  client: string;
  title: string;
  serviceId: string;
  duration: number;
  phone?: string;
  email?: string;
  note?: string;
  sourceItemId?: string;
};

type PlacementAnimation = {
  itemId: string;
  fromX: number;
  fromY: number;
};

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
  name: string;
  email: string;
  phone: string;
  notes: string;
  source: string;
  caddyProfileId: string;
  caddyProfileUrl: string;
  emailOptOut?: boolean;
  packageLessonsRemaining?: number;
  createdAt?: string;
  updatedAt?: string;
};

type ClientSummary = Person & {
  count: number;
  next: CalendarItem | null;
  last: CalendarItem | null;
};

type EmailRecipient = ClientSummary & {
  hasEmailAddress: boolean;
  isUnsubscribed: boolean;
  hasFutureBooking: boolean;
  lastBookingDateLabel: string;
  lastBookingDateMs: number | null;
  packageLessonsRemainingValue: number | null;
  serviceTypes: string[];
};

type EmailRecipientRow = EmailRecipient & {
  isSelected: boolean;
};


function safeText(value: unknown, fallback = "") {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}

function parseBooleanLikeValue(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 0 || value === 1) return value === 1;
    return undefined;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return undefined;
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off", "n"].includes(normalized)) return false;
  }
  return undefined;
}

function parseNumberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function findObjectField(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  return undefined;
}

function extractBooleanField(source: Record<string, unknown>, keys: string[]) {
  const value = findObjectField(source, keys);
  return parseBooleanLikeValue(value);
}

function extractNumberField(source: Record<string, unknown>, keys: string[]) {
  const value = findObjectField(source, keys);
  return parseNumberValue(value);
}

function cleanPerson(person: Partial<Person> & { id?: unknown } = {}) {
  const source = (person ?? {}) as Record<string, unknown>;
  const emailOptOut = extractBooleanField(source, [
    "emailOptOut",
    "doNotEmail",
    "do_not_email",
    "unsubscribed",
    "unsubscribe",
    "optOutEmail",
    "isUnsubscribed",
    "emailOptOutStatus",
  ]);
  const packageLessonsRemaining = extractNumberField(source, [
    "packageLessonsRemaining",
    "remainingPackageLessons",
    "remainingLessons",
    "lessonsRemaining",
    "packageBalance",
    "remainingPackageBalance",
  ]);
  return {
    id: safeText(person.id),
    name: safeText(person.name),
    email: safeText(person.email),
    phone: safeText(person.phone),
    notes: safeText(person.notes),
    source: safeText(person.source),
    caddyProfileId: safeText(person.caddyProfileId),
    caddyProfileUrl: safeText(person.caddyProfileUrl),
    emailOptOut,
    packageLessonsRemaining,
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

type PeopleImportResult = {
  imported: number;
  updated: number;
  skipped: number;
  people: Person[];
};

type PeopleUpdateResult = {
  person: Person;
  people: Person[];
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

type View = "calendar" | "clients" | "client-emails" | "services" | "availability" | "booking" | "billing" | "settings";
type EmailCampaignType = "review-request" | "haven-t-seen" | "custom";
type CampaignDateDirection = "before" | "after";
type CampaignFutureFilter = "all" | "has" | "none";
type BillingSection = "none" | "dashboard" | "new-invoice" | "reports";
type SettingsTab =
  | "none"
  | "services"
  | "availability"
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
};

type NotificationRecord = {
  id: string;
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
  notifications: EmailSendResult[];
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

type ClientProfileTab = "bookings" | "notifications";

type CalendarFeedStatus = "checking" | "connected" | "offline";
type CalendarSaveStatus = "idle" | "saving" | "saved" | "failed";
type GoogleCalendarSyncStatus = {
  configured: boolean;
  connected: boolean;
  calendarId: string;
  autoSync: boolean;
  accountEmail: string;
  lastSyncAt: string;
  lastSyncStatus: string;
  lastSyncError: string;
  connectedAt: string;
  redirectUri: string;
  scope: string;
};
type GoogleCalendarActionState = "idle" | "connecting" | "saving" | "syncing" | "disconnecting";
type AuthStatus = "checking" | "authenticated" | "guest";
type AuthMode = "login" | "forgot" | "reset";
type ThemeMode = "light" | "dark";

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

type InvoiceCustomFieldPlacement = "header" | "bill-to" | "payment" | "footer";

type InvoiceCustomField = {
  id: string;
  label: string;
  value: string;
  placement: InvoiceCustomFieldPlacement;
};

type InvoiceSettings = {
  enabled: boolean;
  showBillingWorkspace: boolean;
  prefix: string;
  nextNumber: number;
  currency: string;
  taxName: string;
  taxNumber: string;
  taxRate: number;
  bankAccount: string;
  paymentTermsDays: number;
  businessAddress: string;
  headerText: string;
  footerText: string;
  paymentInstructions: string;
  customFields: InvoiceCustomField[];
};

type CoachAccount = {
  id: string;
  coachName: string;
  businessName: string;
  venueName: string;
  venueShortName: string;
  timezone: string;
  contactEmail: string;
  bookingUrl: string;
  calendarSlug: string;
  caddyWorkspaceUrl: string;
  invoiceSettings: InvoiceSettings;
};

type BillingCatalogKind = "service" | "product" | "package" | "lesson-type";

type BillingCatalogItem = {
  id: string;
  kind: BillingCatalogKind;
  name: string;
  description: string;
  price: number;
  taxRate: number;
  sourceServiceId?: string;
};

type InvoiceLineSource = "manual" | "catalog" | "booking_snapshot" | "package_sale";

type InvoiceLine = {
  id: string;
  source: InvoiceLineSource;
  sourceId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
};

type InvoiceDraft = {
  payerName: string;
  payerEmail: string;
  payerPhone: string;
  invoiceDate: string;
  dueDate: string;
  reference: string;
  discountLabel: string;
  discountAmount: number;
  message: string;
  lineSearch: string;
  lines: InvoiceLine[];
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
};

type QuickCreateState = {
  week: number;
  day: number;
  start: number;
  x: number;
  y: number;
  serviceId: string;
  phone: string;
  email: string;
  note: string;
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

const START_HOUR = 7;
const END_HOUR = 20;
const HOUR_HEIGHT = 72;
const SNAP_MINUTES = 15;
const MAX_GROUP_OCCURRENCE_COUNT = 52;
const MOUSE_DRAG_THRESHOLD = 10;
const TOUCH_DRAG_THRESHOLD = 16;
const EDGE_NAV_ZONE = 26;
const DAY_COUNT = 7;
const MINUTES_PER_DAY = (END_HOUR - START_HOUR) * 60;
const GRID_HEIGHT = ((END_HOUR - START_HOUR) * HOUR_HEIGHT);
const BOOKING_EMBED_PARAM = "embed";
const BOOKING_EMBED_VALUE = "booking";
const BOOKING_LOGO_PARAM = "logo";
const PUBLIC_BOOKING_HOST = "book.claritygolf.app";
const CLARITY_BOOKING_HOSTS = new Set(["claritygolf.app", "booking.claritygolf.app", PUBLIC_BOOKING_HOST]);
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
const DEFAULT_TAX_RATE = 15;

const baseWeekDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const fullDayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const baseWeekStart = new Date(2026, 5, 1);

const defaultInvoiceSettings: InvoiceSettings = {
  enabled: true,
  showBillingWorkspace: true,
  prefix: "INV",
  nextNumber: 1001,
  currency: "NZD",
  taxName: "GST",
  taxNumber: "",
  taxRate: DEFAULT_TAX_RATE,
  bankAccount: "",
  paymentTermsDays: 7,
  businessAddress: "",
  headerText: "",
  footerText: "Thank you for training with Sam Hale Golf.",
  paymentInstructions: "Please pay by bank transfer and use the invoice number as reference.",
  customFields: [],
};

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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
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
  const hour24 = Math.floor(minutes / 60);
  const mins = minutes % 60;
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

function minutesToTop(minutes: number) {
  return ((minutes - START_HOUR * 60) / 60) * HOUR_HEIGHT;
}

function durationToHeight(minutes: number) {
  return (minutes / 60) * HOUR_HEIGHT;
}

function itemService(item: CalendarItem, serviceCatalog = defaultServices) {
  return serviceCatalog.find((service) => service.id === item.serviceId);
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
    const month = date.toLocaleString("en-NZ", { month: "short" });
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

function bookingStartDate(item: CalendarItem) {
  if (!Number.isFinite(item.start) || !Number.isInteger(item.day) || !Number.isFinite(itemWeek(item))) return null;
  const date = dateForSlot(itemWeek(item), item.day);
  const dateCopy = new Date(date);
  dateCopy.setMinutes(dateCopy.getMinutes() + item.start);
  return dateCopy;
}

function bookingDateMs(item: CalendarItem | null) {
  if (!item) return null;
  const date = bookingStartDate(item);
  if (!date) return null;
  return date.getTime();
}

function bookingDateLabel(item: CalendarItem | null) {
  if (!item) return "No bookings yet";
  const date = bookingStartDate(item);
  if (!date) return "No valid date";
  return `${date.toLocaleDateString("en-NZ", { weekday: "short", month: "short", day: "numeric" })}, ${formatTime(item.start)}`;
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
  const month = date.toLocaleString("en-NZ", { month: "long" });
  return `Week of ${month} ${date.getDate()}, ${date.getFullYear()}`;
}

function sectionTitle(view: View) {
  switch (view) {
    case "clients":
      return "Clients";
    case "client-emails":
      return "Client Emails";
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
    default:
      return "Calendar";
  }
}

function getInitialView(): View {
  if (typeof window === "undefined") return "calendar";
  const requestedView = new URLSearchParams(window.location.search).get("view");
  if (requestedView === "settings") return "settings";
  if (requestedView === "client-emails") return "client-emails";
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
  const source = Array.isArray(value) ? value : [];
  const filtered = source
    .map((candidate) => (typeof candidate === "string" ? candidate.trim() : ""))
    .filter((candidate) => candidate.length > 0)
    .filter((candidate) => BOOKING_SCREEN_IDS.has(candidate));
  const uniq = Array.from(new Set(filtered));
  return uniq.length ? uniq : ["main"];
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

function canonicalPhoneKey(value: unknown = "") {
  const digits = normalizePhoneDigits(value);
  if (digits.startsWith("64") && digits.length >= 9) return `0${digits.slice(2)}`;
  return digits;
}

function phoneVariants(value: unknown = "") {
  const digits = normalizePhoneDigits(value);
  const variants = new Set<string>();
  if (digits) variants.add(digits);
  if (digits.startsWith("64") && digits.length > 2) {
    variants.add(`0${digits.slice(2)}`);
    variants.add(digits.slice(2));
  }
  if (digits.startsWith("0") && digits.length > 1) {
    variants.add(`64${digits.slice(1)}`);
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

function clientMatchesSearchTerm(client: Pick<Person, "name" | "email" | "phone" | "notes">, term: string) {
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

function clientSearchText(client: Pick<Person, "name" | "email" | "phone" | "notes">) {
  return [client.name, client.email, client.phone, client.notes].map((value) => safeText(value)).join(" ").toLowerCase();
}

function editorFromClient(client: ClientSummary): ClientEditor {
  return {
    id: client.id,
    name: client.name,
    email: client.email,
    phone: client.phone,
    notes: client.notes,
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

function cleanInvoiceCustomField(field?: Partial<InvoiceCustomField>, index = 0): InvoiceCustomField | null {
  const label = typeof field?.label === "string" ? field.label.trim().slice(0, 80) : "";
  const value = typeof field?.value === "string" ? field.value.trim().slice(0, 180) : "";
  if (!label && !value) return null;
  const placement: InvoiceCustomFieldPlacement =
    field?.placement === "bill-to" || field?.placement === "payment" || field?.placement === "footer"
      ? field.placement
      : "header";
  return {
    id: typeof field?.id === "string" && field.id.trim() ? field.id.trim().slice(0, 80) : `field-${index + 1}`,
    label: label || "Custom field",
    value,
    placement,
  };
}

function cleanInvoiceSettings(settings?: Partial<InvoiceSettings>): InvoiceSettings {
  const taxRate = Number(settings?.taxRate ?? defaultInvoiceSettings.taxRate);
  const paymentTermsDays = Number(settings?.paymentTermsDays ?? defaultInvoiceSettings.paymentTermsDays);
  const nextNumber = Number(settings?.nextNumber ?? defaultInvoiceSettings.nextNumber);
  const customFields = Array.isArray(settings?.customFields)
    ? settings.customFields
        .map((field, index) => cleanInvoiceCustomField(field, index))
        .filter((field): field is InvoiceCustomField => Boolean(field))
        .slice(0, 12)
    : [];
  return {
    enabled: settings?.enabled !== false,
    showBillingWorkspace: settings?.showBillingWorkspace !== false,
    prefix:
      typeof settings?.prefix === "string" && settings.prefix.trim()
        ? settings.prefix.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12)
        : defaultInvoiceSettings.prefix,
    nextNumber: Number.isFinite(nextNumber) ? clamp(Math.round(nextNumber), 1, 999999) : defaultInvoiceSettings.nextNumber,
    currency:
      typeof settings?.currency === "string" && settings.currency.trim()
        ? settings.currency.trim().toUpperCase().slice(0, 8)
        : defaultInvoiceSettings.currency,
    taxName:
      typeof settings?.taxName === "string" && settings.taxName.trim()
        ? settings.taxName.trim().slice(0, 24)
        : defaultInvoiceSettings.taxName,
    taxNumber: typeof settings?.taxNumber === "string" ? settings.taxNumber.trim().slice(0, 80) : "",
    taxRate: Number.isFinite(taxRate) ? clamp(taxRate, 0, 30) : defaultInvoiceSettings.taxRate,
    bankAccount: typeof settings?.bankAccount === "string" ? settings.bankAccount.trim().slice(0, 120) : "",
    paymentTermsDays: Number.isFinite(paymentTermsDays)
      ? clamp(Math.round(paymentTermsDays), 0, 120)
      : defaultInvoiceSettings.paymentTermsDays,
    businessAddress: typeof settings?.businessAddress === "string" ? settings.businessAddress.trim().slice(0, 400) : "",
    headerText: typeof settings?.headerText === "string" ? settings.headerText.trim().slice(0, 280) : "",
    footerText:
      typeof settings?.footerText === "string" && settings.footerText.trim()
        ? settings.footerText.trim().slice(0, 400)
        : defaultInvoiceSettings.footerText,
    paymentInstructions:
      typeof settings?.paymentInstructions === "string" && settings.paymentInstructions.trim()
        ? settings.paymentInstructions.trim().slice(0, 400)
        : defaultInvoiceSettings.paymentInstructions,
    customFields,
  };
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
    contactEmail: cleanEmail(account?.contactEmail, defaultCoachAccount.contactEmail),
    bookingUrl: cleanUrl(account?.bookingUrl, defaultCoachAccount.bookingUrl),
    calendarSlug: cleanSlug(account?.calendarSlug, cleanSlug(businessName, defaultCoachAccount.calendarSlug)),
    caddyWorkspaceUrl: cleanUrl(account?.caddyWorkspaceUrl, defaultCoachAccount.caddyWorkspaceUrl),
    invoiceSettings: cleanInvoiceSettings(account?.invoiceSettings),
  };
}

function cleanService(service?: Partial<Service>, index = 0): Service {
  const fallback = defaultServices[index] ?? defaultServices[0];
  const name =
    typeof service?.name === "string" && service.name.trim()
      ? service.name.trim().slice(0, 120)
      : fallback.name;
  const duration = Number.isFinite(Number(service?.duration)) ? Number(service?.duration) : fallback.duration;
  const price = Number.isFinite(Number(service?.price)) ? Number(service?.price) : fallback.price;
  const capacity = Number.isFinite(Number(service?.capacity)) ? Number(service?.capacity) : fallback.capacity || 1;
  const looksLikePackage =
    service?.lessonFormat === "package" ||
    String(service?.id || fallback.id || "").startsWith("package-") ||
    /package/i.test(name);
  const lessonFormat: LessonFormat =
    looksLikePackage ? "package" : service?.lessonFormat === "group" ? "group" : "private";
  const cleanCapacity = clamp(Math.round(capacity), lessonFormat === "group" ? 2 : 1, 24);
  const rawMinParticipants = Number.isFinite(Number(service?.minParticipants))
    ? Number(service?.minParticipants)
    : lessonFormat === "group"
      ? Math.min(2, cleanCapacity)
      : 1;
  const minParticipants =
    lessonFormat === "group" ? clamp(Math.round(rawMinParticipants), 2, cleanCapacity) : 1;
  const priceMode: PriceMode =
    lessonFormat === "group" && service?.priceMode === "per-person" ? "per-person" : "session";
  const packageAllowance = Number.isFinite(Number(service?.packageAllowance))
    ? clamp(Math.round(Number(service?.packageAllowance)), 1, 100)
    : Math.max(1, fallback.packageAllowance ?? 5);
  const packageCoverageMode: PackageCoverageMode =
    service?.packageCoverageMode === "lesson-by-lesson" ? "lesson-by-lesson" : "upfront";
  const groupSchedule = lessonFormat === "group" ? cleanGroupSchedule(service?.groupSchedule, fallback.groupSchedule) : undefined;
  const bookingScreenIds = normalizeBookingScreenIds(service?.bookingScreenIds);
  return {
    id: cleanSlug(service?.id, cleanSlug(name, `service-${Date.now()}-${index}`)),
    name,
    duration: clamp(Math.round(duration), 15, 240),
    price: Math.max(0, Math.round(price)),
    description:
      typeof service?.description === "string"
        ? service.description.trim().slice(0, 240)
        : fallback.description,
    visibility: lessonFormat === "package" || service?.visibility === "private" ? "private" : "public",
    active: service?.active !== false,
    capacity: cleanCapacity,
    minParticipants,
    lessonFormat,
    priceMode,
    location: typeof service?.location === "string" ? service.location.trim().slice(0, 160) : fallback.location,
    packageAllowance: lessonFormat === "package" ? packageAllowance : undefined,
    packageCoverageMode: lessonFormat === "package" ? packageCoverageMode : undefined,
    packageCoversServiceId:
      lessonFormat === "package" && typeof service?.packageCoversServiceId === "string"
        ? service.packageCoversServiceId.trim().slice(0, 120)
        : undefined,
    groupSchedule,
    bookingScreenIds,
  };
}

function cleanServices(serviceList?: Partial<Service>[]): Service[] {
  const source = Array.isArray(serviceList) && serviceList.length ? serviceList : defaultServices;
  const seen = new Set<string>();
  return source.map((service, index) => {
    const clean = cleanService(service, index);
    let id = clean.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${clean.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return { ...clean, id };
  });
}

function calendarItemsFingerprint(itemList?: Partial<CalendarItem>[]) {
  if (!Array.isArray(itemList)) return "";
  return JSON.stringify(
    itemList
      .map((item) => ({
        id: item.id || "",
        kind: item.kind || "",
        week: Number(item.week ?? 0),
        day: Number(item.day ?? 0),
        start: Number(item.start ?? 0),
        duration: Number(item.duration ?? 0),
        serviceId: item.serviceId || "",
        client: item.client || "",
        title: item.title || "",
        phone: item.phone || "",
        email: (item.email || "").toLowerCase(),
        note: item.note || "",
        status: item.status || "booked",
      }))
      .sort((first, second) => first.id.localeCompare(second.id)),
  );
}

function calendarStateFingerprint(itemList: Partial<CalendarItem>[] | undefined, syncKey: string) {
  return JSON.stringify({ items: calendarItemsFingerprint(itemList), syncKey });
}

function servicePriceLabel(service?: { price: number; priceMode?: PriceMode } | null) {
  if (!service) return "No charge";
  return `NZ$${service.price}.00${service.priceMode === "per-person" ? " pp" : ""}`;
}

function serviceCapacityLabel(service: Pick<Service, "capacity" | "lessonFormat" | "minParticipants">) {
  if (service.lessonFormat === "package") return "Package";
  if (service.lessonFormat === "group") return `${service.minParticipants}-${service.capacity} clients`;
  return `${service.capacity} client${service.capacity === 1 ? "" : "s"}`;
}

function notificationKindLabel(kind = "") {
  if (kind.includes("coach")) return "Coach notification";
  if (kind.includes("admin")) return "Admin notification";
  if (kind.includes("client")) return "Client email";
  if (kind.includes("reschedule")) return "Reschedule email";
  if (kind.includes("test")) return "Test email";
  return "Email receipt";
}

function notificationStatusLabel(notification: Pick<NotificationRecord, "status" | "error">) {
  if (notification.status === "delivered") return "Delivered";
  if (notification.status === "opened") return "Opened";
  if (notification.status === "clicked") return "Clicked";
  if (notification.status === "sent") return "Sent to provider";
  if (notification.status === "delayed") return notification.error ? `Delayed · ${notification.error.replaceAll("_", " ")}` : "Delayed";
  if (notification.status === "bounced") return notification.error ? `Bounced · ${notification.error.replaceAll("_", " ")}` : "Bounced";
  if (notification.status === "suppressed") return notification.error ? `Suppressed · ${notification.error.replaceAll("_", " ")}` : "Suppressed";
  if (notification.status === "complained") return notification.error ? `Complained · ${notification.error.replaceAll("_", " ")}` : "Complained";
  if (notification.status === "skipped") return notification.error ? `Skipped · ${notification.error.replaceAll("_", " ")}` : "Skipped";
  if (notification.status === "failed") return notification.error ? `Failed · ${notification.error.replaceAll("_", " ")}` : "Failed";
  return notification.status || "Pending";
}

function notificationTone(status = "") {
  if (["delivered", "opened", "clicked"].includes(status)) return "delivered";
  if (status === "sent") return "sent";
  if (["bounced", "failed", "complained", "suppressed"].includes(status)) return "failed";
  if (status === "skipped") return "skipped";
  if (status === "delayed") return "delayed";
  return "pending";
}

function notificationTimeLabel(createdAt = "") {
  if (!createdAt) return "";
  const time = new Date(createdAt);
  return Number.isNaN(time.getTime()) ? "" : time.toLocaleString();
}

function googleSyncTimeLabel(createdAt = "") {
  if (!createdAt) return "Not synced yet";
  const time = new Date(createdAt);
  return Number.isNaN(time.getTime()) ? "Not synced yet" : time.toLocaleString();
}

function dateInputValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDaysInputValue(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return dateInputValue(date);
}

function formatMoney(amount: number, currency = "NZD") {
  return new Intl.NumberFormat("en-NZ", {
    style: "currency",
    currency: currency || "NZD",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
}

function parseMoneyInput(value: string) {
  const normalised = value.replace(/,/g, "").replace(/[^0-9.]/g, "");
  const firstDot = normalised.indexOf(".");
  const cleaned =
    firstDot === -1
      ? normalised
      : `${normalised.slice(0, firstDot + 1)}${normalised.slice(firstDot + 1).replace(/\./g, "")}`;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseQuantityInput(value: string) {
  return Math.max(0, Math.round(parseMoneyInput(value)));
}

function parseDraftNumber(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function generateServiceDraftId() {
  return `service-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function emptyInvoiceDraft(settings = defaultInvoiceSettings): InvoiceDraft {
  return {
    payerName: "",
    payerEmail: "",
    payerPhone: "",
    invoiceDate: dateInputValue(),
    dueDate: addDaysInputValue(settings.paymentTermsDays),
    reference: "",
    discountLabel: "",
    discountAmount: 0,
    message: "Thanks for your work on the lesson programme. Invoice attached below.",
    lineSearch: "",
    lines: [],
  };
}

function emailResultTone(result?: Pick<EmailSendResult, "sent" | "status" | "reason" | "error"> | null) {
  if (!result) return "pending";
  if (result.sent || result.status === "sent") return "sent";
  if (result.status === "skipped") return "skipped";
  if (result.status === "failed" || result.reason || result.error) return "failed";
  return "pending";
}

function emptyServiceEditor(): ServiceEditor {
  return {
    name: "",
    duration: 60,
    price: 0,
    description: "",
    visibility: "public",
    active: true,
    capacity: 1,
    minParticipants: 1,
    lessonFormat: "private",
    priceMode: "session",
    location: "",
    groupSchedule: defaultGroupSchedule(),
    packageAllowance: 5,
    packageCoverageMode: "upfront",
    packageCoversServiceId: "",
    bookingScreenIds: ["main"],
  };
}

function cleanAvailability(availability?: AvailabilityWindow[][]): AvailabilityWindow[][] {
  const source = Array.isArray(availability) ? availability : defaultAvailability;
  return Array.from({ length: DAY_COUNT }, (_, day) => {
    const windows = Array.isArray(source[day]) ? source[day] : [];
    return windows
      .map((window) => {
        const rawStart = Number.isFinite(Number(window?.start)) ? Number(window?.start) : START_HOUR * 60;
        const rawEnd = Number.isFinite(Number(window?.end)) ? Number(window?.end) : rawStart + 60;
        const start = snap(clamp(rawStart, START_HOUR * 60, END_HOUR * 60 - SNAP_MINUTES));
        const end = snap(clamp(rawEnd, start + SNAP_MINUTES, END_HOUR * 60));
        return end > start ? { start, end } : null;
      })
      .filter((window): window is AvailabilityWindow => Boolean(window))
      .sort((a, b) => a.start - b.start)
      .reduce<AvailabilityWindow[]>((merged, window) => {
        const previous = merged.at(-1);
        if (previous && window.start <= previous.end) {
          previous.end = Math.max(previous.end, window.end);
        } else {
          merged.push({ ...window });
        }
        return merged;
      }, []);
  });
}

function getStoredCoachAccount(): CoachAccount {
  if (typeof window === "undefined") return defaultCoachAccount;
  try {
    const stored = window.localStorage.getItem(COACH_ACCOUNT_STORAGE_KEY);
    return stored ? cleanCoachAccount(JSON.parse(stored) as Partial<CoachAccount>) : defaultCoachAccount;
  } catch {
    return defaultCoachAccount;
  }
}

function cleanBrandSettings(settings?: Partial<BrandSettings>): BrandSettings {
  return {
    coachName: typeof settings?.coachName === "string" && settings.coachName.trim()
      ? settings.coachName.trim().slice(0, 80)
      : defaultBrandSettings.coachName,
    logoName: typeof settings?.logoName === "string" ? settings.logoName.trim().slice(0, 120) : "",
    logoPreview:
      typeof settings?.logoPreview === "string" && settings.logoPreview.startsWith("data:image/")
        ? settings.logoPreview
        : "",
    showLogo: settings?.showLogo === true,
    neutral: cleanHexColor(settings?.neutral, defaultBrandSettings.neutral),
    primary: cleanHexColor(settings?.primary, defaultBrandSettings.primary),
    secondary: cleanHexColor(settings?.secondary, defaultBrandSettings.secondary),
    accent: cleanHexColor(settings?.accent, defaultBrandSettings.accent),
    bookingTheme: settings?.bookingTheme === "light" ? "light" : "dark",
  };
}

function getStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";
  return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
}

function getStoredBrandSettings(): BrandSettings {
  if (typeof window === "undefined") return defaultBrandSettings;
  try {
    const stored = window.localStorage.getItem(BRAND_STORAGE_KEY);
    return stored ? cleanBrandSettings(JSON.parse(stored) as Partial<BrandSettings>) : defaultBrandSettings;
  } catch {
    return defaultBrandSettings;
  }
}

function colorDistance(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

function rgbStats(r: number, g: number, b: number) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const lightness = (max + min) / 2;
  const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
  return { lightness, saturation };
}

function swatchStyle(hex: string): CSSProperties {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return { background: hex };
  const r = Number.parseInt(match[1], 16);
  const g = Number.parseInt(match[2], 16);
  const b = Number.parseInt(match[3], 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return {
    background: hex,
    color: luminance > 0.64 ? "#08100b" : "#ffffff",
    textShadow: luminance > 0.64 ? "none" : undefined,
  };
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read that logo image."));
    image.src = url;
  });
}

async function analyzeLogoFile(file: File): Promise<BrandSettings> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    const sampleCanvas = document.createElement("canvas");
    const sampleSize = 96;
    const scale = Math.min(sampleSize / image.naturalWidth, sampleSize / image.naturalHeight, 1);
    sampleCanvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    sampleCanvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (!sampleContext) throw new Error("Logo colour extraction is not available in this browser.");
    sampleContext.drawImage(image, 0, 0, sampleCanvas.width, sampleCanvas.height);

    const buckets = new Map<
      string,
      { r: number; g: number; b: number; count: number; lightness: number; saturation: number }
    >();
    const neutralBuckets = new Map<
      string,
      { r: number; g: number; b: number; count: number; lightness: number; saturation: number }
    >();
    const pixels = sampleContext.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;

    for (let index = 0; index < pixels.length; index += 4) {
      const alpha = pixels[index + 3];
      if (alpha < 120) continue;
      const rawR = pixels[index];
      const rawG = pixels[index + 1];
      const rawB = pixels[index + 2];
      const { lightness, saturation } = rgbStats(rawR, rawG, rawB);

      const r = clamp(Math.round(rawR / 24) * 24, 0, 255);
      const g = clamp(Math.round(rawG / 24) * 24, 0, 255);
      const b = clamp(Math.round(rawB / 24) * 24, 0, 255);
      const key = `${r},${g},${b}`;
      if (saturation < 0.14 && (lightness > 0.64 || lightness < 0.28)) {
        const existingNeutral = neutralBuckets.get(key);
        if (existingNeutral) {
          existingNeutral.count += 1;
        } else {
          neutralBuckets.set(key, { r, g, b, count: 1, ...rgbStats(r, g, b) });
        }
      }

      if (lightness > 0.96 && saturation < 0.08) continue;

      const existing = buckets.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        buckets.set(key, { r, g, b, count: 1, ...rgbStats(r, g, b) });
      }
    }

    const colours = Array.from(buckets.values()).sort((a, b) => {
      const aScore = a.count * (0.4 + a.saturation) * (a.lightness > 0.1 && a.lightness < 0.9 ? 1.15 : 0.75);
      const bScore = b.count * (0.4 + b.saturation) * (b.lightness > 0.1 && b.lightness < 0.9 ? 1.15 : 0.75);
      return bScore - aScore;
    });

    const primary =
      colours.find((colour) => colour.saturation > 0.18 && colour.lightness > 0.12 && colour.lightness < 0.88) ??
      colours[0];
    const secondary =
      colours.find((colour) => primary && colorDistance(colour, primary) > 72 && colour.lightness < 0.92) ??
      colours[1] ??
      primary;
    const accent =
      colours
        .slice()
      .sort((a, b) => b.count - a.count)
      .find((colour) => colour.lightness < 0.28 && colorDistance(colour, primary ?? colour) > 24) ??
      colours.find((colour) => colour.lightness < 0.4) ??
      null;
    const neutral =
      Array.from(neutralBuckets.values()).sort((a, b) => {
        const aScore = a.count * (a.lightness > 0.62 ? 1.35 : 1);
        const bScore = b.count * (b.lightness > 0.62 ? 1.35 : 1);
        return bScore - aScore;
      })[0] ?? null;

    const previewCanvas = document.createElement("canvas");
    const previewMax = 360;
    const previewScale = Math.min(previewMax / image.naturalWidth, previewMax / image.naturalHeight, 1);
    previewCanvas.width = Math.max(1, Math.round(image.naturalWidth * previewScale));
    previewCanvas.height = Math.max(1, Math.round(image.naturalHeight * previewScale));
    const previewContext = previewCanvas.getContext("2d");
    if (!previewContext) throw new Error("Logo preview is not available in this browser.");
    previewContext.drawImage(image, 0, 0, previewCanvas.width, previewCanvas.height);

    return cleanBrandSettings({
      ...defaultBrandSettings,
      logoName: file.name,
      logoPreview: previewCanvas.toDataURL("image/png"),
      showLogo: true,
      neutral: neutral ? rgbToHex(neutral.r, neutral.g, neutral.b) : defaultBrandSettings.neutral,
      primary: primary ? rgbToHex(primary.r, primary.g, primary.b) : defaultBrandSettings.primary,
      secondary: secondary ? rgbToHex(secondary.r, secondary.g, secondary.b) : defaultBrandSettings.secondary,
      accent: accent ? rgbToHex(accent.r, accent.g, accent.b) : defaultBrandSettings.accent,
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

const defaultNotificationSettings: NotificationSettings = {
  emailNotificationsEnabled: true,
  notificationEmail: "",
  notificationSubjectLine: "",
  notificationFromName: "",
  googleReviewUrl: "",
  configuredSenderEmailAddress: "",
  coachEmail: "",
  replyToEmail: "",
  notificationDelaySeconds: 30,
  sendClientEmail: true,
  sendCoachEmail: true,
  sendAdminEmail: true,
  clientEmailSubject: "Your {{service}} is confirmed",
  clientEmailIntro: "Thanks {{firstName}}, your booking with {{coach}} is confirmed.",
  clientEmailFooter: "We look forward to seeing you.",
  adminEmailSubject: "New booking: {{client}}",
  adminEmailIntro: "{{client}} booked {{service}} for {{date}} at {{time}}.",
  minBookingNoticeMinutes: DEFAULT_MIN_BOOKING_NOTICE_MINUTES,
  smsProviderName: "",
  smsWebhookUrl: "",
  smsFromNumber: "",
  sendClientSms: false,
  sendAdminSms: false,
};

const defaultGoogleCalendarStatus: GoogleCalendarSyncStatus = {
  configured: false,
  connected: false,
  calendarId: "primary",
  autoSync: true,
  accountEmail: "",
  lastSyncAt: "",
  lastSyncStatus: "",
  lastSyncError: "",
  connectedAt: "",
  redirectUri: "",
  scope: "",
};

const emptyClientEditor: ClientEditor = {
  id: "",
  name: "",
  email: "",
  phone: "",
  notes: "",
  caddyProfileId: "",
  caddyProfileUrl: "",
};

function App() {
  const isEmbedMode = isPublicBookingMode();
  const [themeMode, setThemeMode] = useState<ThemeMode>(getStoredTheme);
  const [coachAccount, setCoachAccount] = useState<CoachAccount>(getStoredCoachAccount);
  const [coachAccountSaveState, setCoachAccountSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [brandSettings, setBrandSettings] = useState<BrandSettings>(getStoredBrandSettings);
  const [brandSaveState, setBrandSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [authStatus, setAuthStatus] = useState<AuthStatus>(isEmbedMode ? "authenticated" : "checking");
  const [authMode, setAuthMode] = useState<AuthMode>(() => (getInitialResetToken() ? "reset" : "login"));
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const [authError, setAuthError] = useState("");
  const [loginState, setLoginState] = useState<"idle" | "signing-in">("idle");
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotState, setForgotState] = useState<"idle" | "sending" | "sent">("idle");
  const [forgotMessage, setForgotMessage] = useState("");
  const [resetToken] = useState(getInitialResetToken);
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirmPassword, setResetConfirmPassword] = useState("");
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [resetState, setResetState] = useState<"idle" | "saving">("idle");
  const [passwordChangeForm, setPasswordChangeForm] = useState<PasswordChangeForm>({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [passwordChangeState, setPasswordChangeState] = useState<"idle" | "saving" | "saved">("idle");
  const [passwordChangeMessage, setPasswordChangeMessage] = useState("");
  const [items, setItems] = useState<CalendarItem[]>(initialItems);
  const [services, setServices] = useState<Service[]>(defaultServices);
  const [serviceEditor, setServiceEditor] = useState<ServiceEditor>(emptyServiceEditor);
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null);
  const [showServiceEditor, setShowServiceEditor] = useState(false);
  const [serviceSaveState, setServiceSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [groupOccurrenceInput, setGroupOccurrenceInput] = useState("");
  const [groupMinimumInput, setGroupMinimumInput] = useState("");
  const [groupMaximumInput, setGroupMaximumInput] = useState("");
  const [availability, setAvailability] = useState<AvailabilityWindow[][]>(defaultAvailability);
  const [availabilitySaveState, setAvailabilitySaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [editingAvailabilityWindow, setEditingAvailabilityWindow] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [peopleImportText, setPeopleImportText] = useState("");
  const [peopleImportState, setPeopleImportState] = useState<"idle" | "importing" | "imported">("idle");
  const [clientSearch, setClientSearch] = useState("");
  const [showClientImport, setShowClientImport] = useState(false);
  const [emailCampaignType, setEmailCampaignType] = useState<EmailCampaignType>("review-request");
  const [emailDateDirection, setEmailDateDirection] = useState<CampaignDateDirection>("before");
  const [emailDateThreshold, setEmailDateThreshold] = useState("");
  const [emailTotalBookingsMin, setEmailTotalBookingsMin] = useState("");
  const [emailTotalBookingsMax, setEmailTotalBookingsMax] = useState("");
  const [emailPackageMin, setEmailPackageMin] = useState("");
  const [emailPackageMax, setEmailPackageMax] = useState("");
  const [emailHasFutureBooking, setEmailHasFutureBooking] = useState<CampaignFutureFilter>("all");
  const [emailServiceType, setEmailServiceType] = useState("");
  const [emailRecipientSelection, setEmailRecipientSelection] = useState<Record<string, boolean>>({});
  const [isAddingClient, setIsAddingClient] = useState(false);
  const [selectedClientId, setSelectedClientId] = useState("");
  const [clientEditMode, setClientEditMode] = useState(false);
  const [clientEditor, setClientEditor] = useState<ClientEditor>(emptyClientEditor);
  const [clientSaveState, setClientSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [clientProfileTab, setClientProfileTab] = useState<ClientProfileTab>("bookings");
  const [selectedId, setSelectedId] = useState("");
  const [selectedGroupSession, setSelectedGroupSession] = useState<GroupSession | null>(null);
  const [activeView, setActiveView] = useState<View>(getInitialView);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("none");
  const [billingSection, setBillingSection] = useState<BillingSection>("none");
  const [invoiceDraft, setInvoiceDraft] = useState<InvoiceDraft>(() =>
    emptyInvoiceDraft(getStoredCoachAccount().invoiceSettings),
  );
  const [invoiceCustomerSearch, setInvoiceCustomerSearch] = useState("");
  const [showInvoiceLinePicker, setShowInvoiceLinePicker] = useState(false);
  const [confirmedInvoiceNumber, setConfirmedInvoiceNumber] = useState("");
  const [sentInvoiceNumber, setSentInvoiceNumber] = useState("");
  const [voidedInvoiceNumbers, setVoidedInvoiceNumbers] = useState<string[]>([]);

  useEffect(() => {
    if (serviceEditor.lessonFormat !== "group") {
      setGroupOccurrenceInput("");
      setGroupMinimumInput("");
      setGroupMaximumInput("");
      return;
    }

    const baseSchedule = serviceEditor.groupSchedule ?? defaultGroupSchedule();
    const normalizedCapacity = clamp(Math.round(serviceEditor.capacity), 2, 24);
    const normalizedMinimum = clamp(Math.round(serviceEditor.minParticipants), 2, normalizedCapacity);

    setGroupOccurrenceInput(
      String(clamp(Math.round(baseSchedule.occurrenceCount), 1, MAX_GROUP_OCCURRENCE_COUNT)),
    );
    setGroupMaximumInput(String(normalizedCapacity));
    setGroupMinimumInput(String(normalizedMinimum));
  }, [serviceEditor.id, serviceEditor.lessonFormat]);

  const [catalogItems, setCatalogItems] = useState<BillingCatalogItem[]>([
    {
      id: "catalog-swing-review",
      kind: "service",
      name: "Remote Swing Review",
      description: "Video review and written practice notes",
      price: 75,
      taxRate: defaultInvoiceSettings.taxRate,
    },
    {
      id: "catalog-bay-hire",
      kind: "product",
      name: "Bay Hire",
      description: "Simulator bay hire add-on",
      price: 30,
      taxRate: defaultInvoiceSettings.taxRate,
    },
  ]);
  const [catalogEditor, setCatalogEditor] = useState<BillingCatalogItem>({
    id: "",
    kind: "service",
    name: "",
    description: "",
    price: 0,
    taxRate: defaultInvoiceSettings.taxRate,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pointerSession, setPointerSession] = useState<PointerSession>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [quickCreate, setQuickCreate] = useState<QuickCreateState | null>(null);
  const [quickClientSearch, setQuickClientSearch] = useState("");
  const [quickMatchField, setQuickMatchField] = useState<"name" | "phone" | "email" | "">("");
  const [dockBookings, setDockBookings] = useState<PendingBooking[]>([]);
  const [flyingBooking, setFlyingBooking] = useState<DockFlight | null>(null);
  const [activeDockBookingId, setActiveDockBookingId] = useState("");
  const [placementAnimation, setPlacementAnimation] = useState<PlacementAnimation | null>(null);
  const [floatingDrag, setFloatingDrag] = useState<FloatingDrag | null>(null);
  const [calendarHover, setCalendarHover] = useState<CalendarHoverPreview | null>(null);
  const [activeWeek, setActiveWeek] = useState(getCurrentWeekOffset);
  const [edgeCue, setEdgeCue] = useState<null | "prev" | "next">(null);
  const [bookingServiceId, setBookingServiceId] = useState("");
  const [bookingDay, setBookingDay] = useState(0);
  const [bookingDaySelected, setBookingDaySelected] = useState(false);
  const [bookingStart, setBookingStart] = useState<number | null>(null);
  const [openPublicBookingSection, setOpenPublicBookingSection] = useState<PublicBookingSection>("appointment");
  const [bookingForm, setBookingForm] = useState<BookingForm>(
    () => getInitialBookingLogin() ?? { firstName: "", lastName: "", phone: "", email: "" },
  );
  const [bookingMode, setBookingMode] = useState<BookingMode>("book");
  const [rescheduleForm, setRescheduleForm] = useState<RescheduleForm>({ email: "", phone: "" });
  const [rescheduleMatches, setRescheduleMatches] = useState<PublicRescheduleMatch[]>([]);
  const [selectedRescheduleId, setSelectedRescheduleId] = useState("");
  const [rescheduleState, setRescheduleState] = useState<"idle" | "checking" | "saving">("idle");
  const [forceRescheduleLogin, setForceRescheduleLogin] = useState(false);
  const [bookingSubmitState, setBookingSubmitState] = useState<"idle" | "saving">("idle");
  const [bookingConfirmation, setBookingConfirmation] = useState<BookingConfirmation | null>(null);
  const [copiedEmbed, setCopiedEmbed] = useState(false);
  const [selectedBookingScreenId, setSelectedBookingScreenId] = useState(BOOKING_SCREEN_PATHS[0]?.id || "main");
  const [bookingScreenNames, setBookingScreenNames] = useState<Record<string, string>>(
    () =>
      BOOKING_SCREEN_PATHS.reduce<Record<string, string>>((acc, screen) => {
        acc[screen.id] = screen.label;
        return acc;
      }, {}),
  );
  const [copiedBookingScreenLinkId, setCopiedBookingScreenLinkId] = useState<string | null>(null);
  const [copiedBookingScreenIframeId, setCopiedBookingScreenIframeId] = useState<string | null>(null);
  const [syncBaseUrl, setSyncBaseUrl] = useState(getDefaultSyncBaseUrl);
  const [calendarSyncKey, setCalendarSyncKey] = useState(generateSyncKey);
  const [copiedSync, setCopiedSync] = useState<"url" | "key" | null>(null);
  const [calendarFeedStatus, setCalendarFeedStatus] = useState<CalendarFeedStatus>("checking");
  const [calendarSaveStatus, setCalendarSaveStatus] = useState<CalendarSaveStatus>("idle");
  const [calendarSaveError, setCalendarSaveError] = useState("");
  const [calendarStateVersion, setCalendarStateVersion] = useState("");
  const [calendarDetailMode, setCalendarDetailMode] = useState(false);
  const [googleCalendar, setGoogleCalendar] = useState<GoogleCalendarSyncStatus>(defaultGoogleCalendarStatus);
  const [googleCalendarAction, setGoogleCalendarAction] = useState<GoogleCalendarActionState>("idle");
  const [notificationSettings, setNotificationSettings] =
    useState<NotificationSettings>(defaultNotificationSettings);
  const [settingsSaveState, setSettingsSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [testEmailAddress, setTestEmailAddress] = useState("");
  const [testEmailState, setTestEmailState] = useState<"idle" | "sending" | "sent">("idle");
  const [emailNoticeVisible, setEmailNoticeVisible] = useState(false);
  const [hasMoved, setHasMoved] = useState(false);
  const initialRescheduleLoginRef = useRef<SavedRescheduleLogin | null>(getInitialRescheduleLogin());
  const attemptedSavedRescheduleRef = useRef(false);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const pointerSessionRef = useRef<PointerSession>(null);
  const hasMovedRef = useRef(false);
  const suppressItemClickRef = useRef(false);
  const suppressItemClickUntilRef = useRef(0);
  const activeWeekRef = useRef(activeWeek);
  const hasLoadedCalendarApiRef = useRef(false);
  const clickPlaceRef = useRef<null | { bookingId: string; candidate: SlotCandidate }>(null);
  const pointerClientRef = useRef({ x: 0, y: 0 });
  const pointerStartRef = useRef({ x: 0, y: 0 });
  const pointerTrailRef = useRef<{ x: number; y: number; t: number }[]>([]);
  const pointerKindRef = useRef<globalThis.PointerEvent["pointerType"]>("mouse");
  const dragPreviewMetaRef = useRef<null | { width: number; height: number; offsetX: number; offsetY: number }>(null);
  const lastEdgeNavRef = useRef(0);
  const lastCalendarTapRef = useRef(0);
  const suppressBlankGestureUntilRef = useRef(0);
  const edgeCueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gestureCleanupRef = useRef<null | (() => void)>(null);
  const brandSaveVersionRef = useRef(0);
  const calendarSaveVersionRef = useRef(0);
  const lastPersistedCalendarFingerprintRef = useRef("");
  const publicNotificationTriggerRef = useRef<Set<string>>(new Set());
  const pendingQuickCreateRef = useRef<QuickCreateState | null>(null);

  const selected = selectedId ? items.find((item) => item.id === selectedId) : undefined;
  const selectedService = selected ? itemService(selected, services) : null;
  const selectedGroupSessionService = selectedGroupSession
    ? services.find((service) => service.id === selectedGroupSession.serviceId) ?? null
    : null;
  const selectedGroupSessionAttendees = useMemo(() => {
    if (!selectedGroupSession || !selectedGroupSessionService) return [];
    const candidate = {
      week: selectedGroupSession.week,
      day: selectedGroupSession.day,
      start: selectedGroupSession.start,
      duration: selectedGroupSession.duration,
    };
    return items
      .filter(
        (item) =>
          item.kind === "appointment" &&
          item.serviceId === selectedGroupSessionService.id &&
          overlaps(itemSlot(item), candidate),
      )
      .sort((a, b) => (a.client ?? "").localeCompare(b.client ?? ""));
  }, [items, selectedGroupSession, selectedGroupSessionService]);
  const selectedGroupSessionBookedCount = selectedGroupSessionAttendees.filter((appointment) =>
    isActiveGroupBooking(appointment.status),
  ).length;
  const selectedGroupSessionCapacity = selectedGroupSessionService?.capacity ?? 0;
  const selectedGroupSessionRemainingSlots = Math.max(0, selectedGroupSessionCapacity - selectedGroupSessionBookedCount);
  const selectedGroupSessionIsFull = selectedGroupSessionCapacity > 0 && selectedGroupSessionBookedCount >= selectedGroupSessionCapacity;
  const selectedGroupSessionDate = selectedGroupSession
    ? dateForSlot(selectedGroupSession.week, selectedGroupSession.day)
    : null;
  const selectedGroupSessionLabel = selectedGroupSessionDate
    ? selectedGroupSessionDate.toLocaleDateString("en-NZ", {
        weekday: "long",
        month: "long",
        day: "numeric",
      })
    : "";
  const weekDays = useMemo(() => buildWeekDays(activeWeek), [activeWeek]);
  const weekTitle = useMemo(() => formatWeekTitle(activeWeek), [activeWeek]);
  const weekItems = useMemo(() => items.filter((item) => itemWeek(item) === activeWeek), [activeWeek, items]);
  const appointments = weekItems.filter((item) => item.kind === "appointment").length;
  const blocks = weekItems.filter((item) => item.kind === "block").length;
  const activeDockBooking = dockBookings.find((booking) => booking.id === activeDockBookingId) ?? null;
  const dockFocus =
    !selected &&
    (dockBookings.length > 0 ||
      Boolean(flyingBooking) ||
      pointerSession?.mode === "place" ||
      (pointerSession?.mode === "move" && Boolean(floatingDrag)));
  const packageServices = services.filter((service) => service.active && service.lessonFormat === "package");
  const bookableServices = services.filter((service) => service.active && service.lessonFormat !== "package");
  const appointmentServices = bookableServices;
  const publicServices = bookableServices.filter((service) => service.visibility === "public");
  const currentBookingScreenId = getBookingScreenId(typeof window === "undefined" ? "/" : window.location.pathname);
  const currentScreenPublicServices = publicServices.filter((service) =>
    (service.bookingScreenIds ?? ["main"]).includes(currentBookingScreenId),
  );
  const quickCreateServices = publicServices.slice(0, 4);
  const quickCreateService = quickCreate?.serviceId
    ? appointmentServices.find((service) => service.id === quickCreate.serviceId) ?? null
    : null;
  const selectedRescheduleMatch =
    rescheduleMatches.find((match) => match.id === selectedRescheduleId) ?? null;
  const selectedRescheduleService = selectedRescheduleMatch
    ? services.find((service) => service.id === selectedRescheduleMatch.serviceId) ?? null
    : null;
  const selectedBookingService =
    bookingMode === "reschedule"
      ? selectedRescheduleService
      : currentScreenPublicServices.find((service) => service.id === bookingServiceId) ?? null;
  const visiblePublicServices = selectedBookingService ? [selectedBookingService] : currentScreenPublicServices;
  const bookingTargetService = bookingMode === "reschedule" ? selectedRescheduleService : selectedBookingService;
  const bookingScreenEmbeds = useMemo(
    () =>
      BOOKING_SCREEN_PATHS.map((screen) => ({
        ...screen,
        label: bookingScreenNames[screen.id] || screen.label,
        publicUrl: getBookingScreenPublicUrl(screen.path, brandSettings.showLogo),
        iframeCode: getBookingScreenIframeCode(
          screen.path,
          coachAccount.businessName,
          bookingScreenNames[screen.id] || screen.label,
          brandSettings.showLogo,
        ),
      })),
    [bookingScreenNames, brandSettings.showLogo, coachAccount.businessName],
  );
  const selectedBookingScreen = bookingScreenEmbeds.find((bookingScreen) => bookingScreen.id === selectedBookingScreenId) ?? bookingScreenEmbeds[0];
  const bookingWidgetUrl = useMemo(() => getBookingWidgetUrl(brandSettings.showLogo), [brandSettings.showLogo]);
  const iframeCode = `<iframe src="${bookingWidgetUrl}" title="${coachAccount.businessName} booking" width="100%" height="760" style="border:0;max-width:100%;border-radius:18px;overflow:hidden;background:transparent;" loading="lazy"></iframe>`;
  const calendarFeedUrl = `${syncBaseUrl.trim().replace(/\/+$/, "") || "https://booking.yourdomain.co.nz"}/calendar/${coachAccount.calendarSlug}.ics?key=${calendarSyncKey}`;
  const caddyWorkspaceUrl = coachAccount.caddyWorkspaceUrl || CADDY_APP_URL;
  const invoiceSettings = coachAccount.invoiceSettings;
  const invoiceNumber = `${invoiceSettings.prefix}-${String(invoiceSettings.nextNumber).padStart(4, "0")}`;
  const billingWorkspaceEnabled = invoiceSettings.enabled && invoiceSettings.showBillingWorkspace;
  const hasMissingInvoiceCoachSettings =
    !invoiceSettings.bankAccount.trim() || !invoiceSettings.taxNumber.trim() || !invoiceSettings.businessAddress.trim();
  const bookingBrandName = (brandSettings.coachName || coachAccount.businessName).trim();
  const bookingBrandWords = bookingBrandName.split(/\s+/);
  const bookingBrandPrimary = bookingBrandWords.slice(0, -1).join(" ") || bookingBrandName;
  const bookingBrandSecondary = bookingBrandWords.length > 1 ? bookingBrandWords.at(-1) : "";
  const showBookingBrandLogo = brandSettings.showLogo && !isBookingLogoHiddenByUrl();
  const locationLine = coachAccount.venueName;
  const settingsLocationLine = `${coachAccount.venueName} · ${coachAccount.timezone}`;
  const hasSavedRescheduleLogin = Boolean(rescheduleForm.email.trim() && rescheduleForm.phone.trim());
  const isEmailLinkReschedule = Boolean(
    bookingMode === "reschedule" &&
      initialRescheduleLoginRef.current?.appointmentId &&
      rescheduleForm.email.trim() &&
      rescheduleForm.phone.trim(),
  );
  const showRescheduleLoginPanel = bookingMode === "reschedule" && (forceRescheduleLogin || !isEmailLinkReschedule);
  const bookingLoginUrl = bookingConfirmation
    ? buildRescheduleLink(coachAccount.bookingUrl, {
        appointmentId: bookingConfirmation.appointmentId,
        email: bookingConfirmation.email,
        phone: bookingConfirmation.phone || "",
      })
    : "";
  const brandStyle = useMemo(
    () =>
      ({
        "--coach-neutral": brandSettings.neutral,
        "--coach-primary": brandSettings.primary,
        "--coach-secondary": brandSettings.secondary,
        "--coach-accent": brandSettings.accent,
      }) as CSSProperties,
    [brandSettings],
  );
  const emailTemplateService = publicServices[0] ?? appointmentServices[0] ?? null;
  const completedAppointments = useMemo(
    () =>
      items
        .filter((item) => item.kind === "appointment" && item.status === "completed")
        .sort((a, b) => itemWeek(a) - itemWeek(b) || a.day - b.day || a.start - b.start),
    [items],
  );
  const completedUninvoicedCount = completedAppointments.length;
  const invoiceLineSubtotal = invoiceDraft.lines.reduce(
    (total, line) => total + Math.max(0, Number(line.quantity) || 0) * Math.max(0, Number(line.unitPrice) || 0),
    0,
  );
  const invoiceDiscountTotal = Math.min(invoiceLineSubtotal, Math.max(0, Number(invoiceDraft.discountAmount) || 0));
  const invoiceTaxableSubtotal = Math.max(0, invoiceLineSubtotal - invoiceDiscountTotal);
  const invoiceTaxTotal = invoiceTaxableSubtotal * (Math.max(0, Number(invoiceSettings.taxRate) || 0) / 100);
  const invoiceTotal = invoiceTaxableSubtotal + invoiceTaxTotal;
  const activeInvoiceNumber = confirmedInvoiceNumber || invoiceNumber;
  const latestVoidedInvoiceNumber = voidedInvoiceNumbers[voidedInvoiceNumbers.length - 1] || "";
  const invoiceDiscountLabel = invoiceDraft.discountLabel.trim() || "Discount / coupon";
  const invoiceEmailSubject = `${activeInvoiceNumber} from ${coachAccount.businessName}`;
  const invoiceEmailBody = [
    invoiceDraft.message,
    "",
    `Invoice: ${activeInvoiceNumber}`,
    `Total: ${formatMoney(invoiceTotal, invoiceSettings.currency)}`,
    `Due: ${invoiceDraft.dueDate}`,
    invoiceSettings.paymentInstructions,
  ]
    .filter(Boolean)
    .join("\n");
  const gmailComposeUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(
    invoiceDraft.payerEmail,
  )}&su=${encodeURIComponent(invoiceEmailSubject)}&body=${encodeURIComponent(invoiceEmailBody)}`;
  const invoiceSearchTerm = invoiceDraft.lineSearch.trim().toLowerCase();
  const invoiceCatalogOptions = useMemo(() => {
    const lessonOptions: BillingCatalogItem[] = services
      .filter((service) => service.active)
      .map((service) => ({
        id: `service-${service.id}`,
        kind: service.lessonFormat === "package" ? "package" : "lesson-type",
        name: service.name,
        description: service.description || service.location,
        price: service.price,
        taxRate: invoiceSettings.taxRate,
        sourceServiceId: service.id,
      }));
    return [...lessonOptions, ...catalogItems];
  }, [catalogItems, invoiceSettings.taxRate, services]);
  const visibleInvoiceCatalogOptions = invoiceCatalogOptions
    .filter((item) => {
      if (!invoiceSearchTerm) return false;
      return [item.name, item.description, item.kind].join(" ").toLowerCase().includes(invoiceSearchTerm);
    })
    .slice(0, 8);
  const hasInvoiceCustomer = Boolean(invoiceDraft.payerName.trim() || invoiceDraft.payerEmail.trim());
  const invoiceCustomerSearchTerm = invoiceCustomerSearch.trim().toLowerCase();
  const invoiceCustomerMatches = invoiceCustomerSearchTerm
    ? people
        .filter((person) =>
          [person.name, person.email, person.phone].join(" ").toLowerCase().includes(invoiceCustomerSearchTerm),
        )
        .slice(0, 6)
    : [];
  const invoiceCustomerCreateLabel = invoiceCustomerSearch.trim();
  const emailTemplateVariables = {
    business: coachAccount.businessName,
    client: "Donna Steele",
    coach: coachAccount.coachName || coachAccount.businessName,
    date: "Thursday, Jun 4",
    duration: emailTemplateService ? `${emailTemplateService.duration} minutes` : "60 minutes",
    firstName: "Donna",
    price: servicePriceLabel(emailTemplateService),
    action: "booking",
    replyTo: notificationSettings.replyToEmail || coachAccount.contactEmail,
    service: emailTemplateService?.name ?? "1 Hour Golf Lesson",
    time: emailTemplateService ? formatRange(14 * 60, emailTemplateService.duration) : "2:00 PM-3:00 PM",
    venue: coachAccount.venueShortName || coachAccount.venueName,
  };
  const emailSubjectTemplatePreview = notificationSettings.notificationSubjectLine.trim()
    ? renderTemplate(notificationSettings.notificationSubjectLine, emailTemplateVariables)
    : "";
  const minBookingNoticeHours = Math.max(0, Math.round((notificationSettings.minBookingNoticeMinutes / 60) * 100) / 100);
  const minBookingNoticeSummary = formatBookingNoticeLabel(notificationSettings.minBookingNoticeMinutes);
  const emailTemplateExample = {
    adminIntro: renderTemplate(notificationSettings.adminEmailIntro, emailTemplateVariables),
    adminSubject: renderTemplate(notificationSettings.adminEmailSubject, emailTemplateVariables),
    clientFooter: renderTemplate(notificationSettings.clientEmailFooter, emailTemplateVariables),
    clientIntro: renderTemplate(notificationSettings.clientEmailIntro, emailTemplateVariables),
    clientSubject: renderTemplate(notificationSettings.clientEmailSubject, emailTemplateVariables),
  };

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    document.documentElement.style.colorScheme = themeMode;
  }, [themeMode]);

  useEffect(() => {
    if (!isEmbedMode) return;
    document.documentElement.classList.add("clarity-embed-mode");
    document.body.classList.add("clarity-embed-mode");
    return () => {
      document.documentElement.classList.remove("clarity-embed-mode");
      document.body.classList.remove("clarity-embed-mode");
    };
  }, [isEmbedMode]);

  useEffect(() => {
    window.localStorage.setItem(COACH_ACCOUNT_STORAGE_KEY, JSON.stringify(coachAccount));
  }, [coachAccount]);

  useEffect(() => {
    const defaultSync = getDefaultSyncBaseUrl();
    if (syncBaseUrl === defaultSync || syncBaseUrl === defaultCoachAccount.bookingUrl) {
      setSyncBaseUrl(coachAccount.bookingUrl);
    }
  }, [coachAccount.bookingUrl, syncBaseUrl]);

  useEffect(() => {
    window.localStorage.setItem(BRAND_STORAGE_KEY, JSON.stringify(brandSettings));
  }, [brandSettings]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const hasCredentials = Boolean(rescheduleForm.email.trim() && rescheduleForm.phone.trim());
    if (hasCredentials) {
      const nextSaved: SavedRescheduleLogin = {
        email: rescheduleForm.email.trim(),
        phone: rescheduleForm.phone.trim(),
        appointmentId: selectedRescheduleId || initialRescheduleLoginRef.current?.appointmentId,
      };
      window.localStorage.setItem(RESCHEDULE_LOGIN_STORAGE_KEY, JSON.stringify(nextSaved));
      return;
    }
    if (bookingMode === "book" && !selectedRescheduleId) {
      window.localStorage.removeItem(RESCHEDULE_LOGIN_STORAGE_KEY);
    }
  }, [bookingMode, rescheduleForm.email, rescheduleForm.phone, selectedRescheduleId]);

  useEffect(() => {
    if (typeof window === "undefined" || !isEmbedMode) return;
    const hasBookingDetails = Boolean(bookingForm.firstName.trim() && bookingForm.lastName.trim() && bookingForm.email.trim());
    if (!hasBookingDetails) return;
    window.localStorage.setItem(
      BOOKING_LOGIN_STORAGE_KEY,
      JSON.stringify({
        firstName: bookingForm.firstName.trim(),
        lastName: bookingForm.lastName.trim(),
        phone: bookingForm.phone.trim(),
        email: bookingForm.email.trim(),
      }),
    );
  }, [bookingForm.email, bookingForm.firstName, bookingForm.lastName, bookingForm.phone, isEmbedMode]);

  useEffect(() => {
    if (!isEmbedMode || !bookingConfirmation?.appointmentId) return;
    if (bookingConfirmation.notifications.some((result) => result.channel === "client" && result.sent)) {
      setEmailNoticeVisible(true);
      return;
    }
    // A cancelled booking has already been removed from the public calendar,
    // so it cannot be looked up again by the generic notification retry route.
    // Cancellation sends are completed synchronously by /api/public-cancel.
    if (bookingConfirmation.kind === "cancelled") return;

    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof window.setTimeout> | null = null;
    const triggerKey = `${bookingConfirmation.kind}:${bookingConfirmation.appointmentId}`;

    const mergeNotificationResults = (results: EmailSendResult[]) => {
      if (!results.length || cancelled) return;
      setBookingConfirmation((current) => {
        if (!current || current.appointmentId !== bookingConfirmation.appointmentId) return current;
        const seen = new Set(current.notifications.map((result) => `${result.kind || result.channel}:${result.recipient || ""}:${result.status || result.sent}`));
        const additions = results.filter((result) => {
          const key = `${result.kind || result.channel}:${result.recipient || ""}:${result.status || result.sent}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        return additions.length ? { ...current, notifications: [...additions, ...current.notifications] } : current;
      });
      if (results.some((result) => result.channel === "client" && result.sent)) setEmailNoticeVisible(true);
    };

    const triggerEmailSend = async () => {
      if (publicNotificationTriggerRef.current.has(triggerKey)) return;
      publicNotificationTriggerRef.current.add(triggerKey);
      try {
        const response = await fetch("/api/public-booking-notifications", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            appointmentId: bookingConfirmation.appointmentId,
            email: bookingConfirmation.email,
            phone: bookingConfirmation.phone || "",
            kind: bookingConfirmation.kind,
          }),
        });
        const data = (await response.json().catch(() => ({}))) as {
          results?: EmailSendResult[];
          notifications?: NotificationRecord[];
        };
        if (Array.isArray(data.notifications)) setNotifications(data.notifications);
        if (Array.isArray(data.results)) mergeNotificationResults(data.results);
      } catch {
        // The booking is confirmed already; polling below can still pick up a background receipt.
      }
    };

    const poll = async () => {
      attempts += 1;
      try {
        const params = new URLSearchParams({
          appointment: bookingConfirmation.appointmentId || "",
          email: bookingConfirmation.email,
          phone: bookingConfirmation.phone || "",
        });
        const response = await fetch(`/api/public-notification-status?${params.toString()}`, {
          headers: { Accept: "application/json" },
        });
        const data = (await response.json()) as { sent?: boolean; notification?: EmailSendResult | null };
        if (!cancelled && response.ok && data.notification) {
          mergeNotificationResults([data.notification]);
          if (data.sent) return;
        }
      } catch {
        // The booking is already confirmed; email status is a secondary receipt.
      }
      if (!cancelled && attempts < 36) timer = window.setTimeout(poll, 5000);
    };

    void triggerEmailSend().finally(() => {
      if (!cancelled) timer = window.setTimeout(poll, 1200);
    });

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [bookingConfirmation?.appointmentId, bookingConfirmation?.email, bookingConfirmation?.kind, bookingConfirmation?.phone, isEmbedMode]);

  useEffect(() => {
    if (activeDockBookingId && !dockBookings.some((booking) => booking.id === activeDockBookingId)) {
      setActiveDockBookingId("");
    }
  }, [activeDockBookingId, dockBookings]);

  useEffect(() => {
    if (pointerSession) setCalendarHover(null);
  }, [pointerSession]);

  useEffect(() => {
    if (bookingMode !== "reschedule" && bookingServiceId && !currentScreenPublicServices.some((service) => service.id === bookingServiceId)) {
      setBookingServiceId("");
      setBookingDaySelected(false);
      setBookingStart(null);
      setOpenPublicBookingSection("appointment");
    }
  }, [bookingMode, bookingServiceId, currentScreenPublicServices]);

  useEffect(() => {
    if (!quickCreate) setQuickClientSearch("");
  }, [quickCreate]);

  useEffect(() => {
    let cancelled = false;

    async function loadInitialState() {
      try {
        if (isEmbedMode) {
          await loadPublicBookingState();
          if (!cancelled) setCalendarFeedStatus("connected");
          return;
        }

        const sessionController = new AbortController();
        const sessionTimeout = window.setTimeout(() => sessionController.abort(), 8000);
        let sessionResponse: Response;
        try {
          sessionResponse = await fetch("/api/auth/session", {
            credentials: "same-origin",
            cache: "no-store",
            headers: { Accept: "application/json" },
            signal: sessionController.signal,
          });
        } finally {
          window.clearTimeout(sessionTimeout);
        }
        if (!sessionResponse.ok) throw new Error("Session API unavailable");
        const session = (await sessionResponse.json()) as { authenticated?: boolean; email?: string };
        if (cancelled) return;

        if (!session.authenticated) {
          setAuthStatus("guest");
          setCalendarFeedStatus("offline");
          return;
        }

        if (session.email) setAdminEmail(session.email);
        await loadAdminCalendarState();
        if (cancelled) return;
        setAuthStatus("authenticated");
        setCalendarFeedStatus("connected");
      } catch {
        if (!cancelled) {
          hasLoadedCalendarApiRef.current = false;
          setCalendarFeedStatus("offline");
          if (!isEmbedMode) setAuthStatus("guest");
        }
      }
    }

    void loadInitialState();
    return () => {
      cancelled = true;
    };
  }, [isEmbedMode]);

  async function refreshNotificationHistory() {
    if (isEmbedMode || authStatus !== "authenticated") return;
    try {
      const response = await fetch("/api/notification-history", { headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const data = (await response.json()) as { notifications?: NotificationRecord[] };
      if (Array.isArray(data.notifications)) setNotifications(data.notifications);
    } catch {
      // Email receipts are secondary; keep the calendar usable if polling fails.
    }
  }

  useEffect(() => {
    if (!isEmbedMode || attemptedSavedRescheduleRef.current) return;
    const saved = initialRescheduleLoginRef.current;
    if (!saved?.email || !saved?.phone) return;
    attemptedSavedRescheduleRef.current = true;
    setBookingMode("reschedule");
    setRescheduleForm({ email: saved.email, phone: saved.phone });
    setSelectedRescheduleId(saved.appointmentId || "");
    window.setTimeout(() => {
      void lookupPublicReschedule(true, saved);
    }, 0);
  }, [isEmbedMode]);

  useEffect(() => {
    if (isEmbedMode || authStatus !== "authenticated" || !hasLoadedCalendarApiRef.current) return;
    const requestedFingerprint = calendarStateFingerprint(items, calendarSyncKey);
    if (requestedFingerprint === lastPersistedCalendarFingerprintRef.current) return;
    const saveVersion = ++calendarSaveVersionRef.current;
    const payload = JSON.stringify({ items, replaceItems: true, syncKey: calendarSyncKey, updatedAt: calendarStateVersion });
    const payloadFingerprint = calendarItemsFingerprint(items);
    let saveReachedServer = false;
    let sessionExpired = false;
    setCalendarSaveStatus("saving");
    setCalendarSaveError("");

    const saveTimer = window.setTimeout(() => {
      const saveRequest = () =>
        fetch("/api/calendar-state", {
          method: "PUT",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: payload,
        });
      const readLiveState = () =>
        fetch("/api/calendar-state", {
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
      const retryDelay = (delay = 700) => new Promise((resolve) => window.setTimeout(resolve, delay));
      const saveWithRetries = async () => {
        let lastError: unknown;
        for (const delay of [0, 700, 1400, 2600]) {
          if (delay) await retryDelay(delay);
          try {
            return await saveRequest();
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError instanceof Error ? lastError : new Error("Calendar save failed.");
      };

      void (async () => {
        let response: Response;
        let recoveredData: {
          items?: CalendarItem[];
          notifications?: NotificationRecord[];
          updatedAt?: string;
          googleCalendar?: Partial<GoogleCalendarSyncStatus>;
        } | null = null;
        try {
          response = await saveWithRetries();
        } catch (networkError) {
          const liveResponse = await readLiveState().catch(() => null);
          if (!liveResponse?.ok) throw networkError;
          recoveredData = (await liveResponse.json().catch(() => ({}))) as {
            items?: CalendarItem[];
            notifications?: NotificationRecord[];
            updatedAt?: string;
            googleCalendar?: Partial<GoogleCalendarSyncStatus>;
          };
          if (calendarItemsFingerprint(recoveredData.items) === payloadFingerprint) {
            response = liveResponse;
          } else {
            recoveredData = null;
            response = await saveWithRetries();
          }
        }
        if (calendarSaveVersionRef.current !== saveVersion) return;
        let data = (recoveredData ?? (await response.json().catch(() => ({})))) as {
          message?: string;
          error?: string;
          notifications?: NotificationRecord[];
          notificationResults?: EmailSendResult[];
          updatedAt?: string;
          items?: CalendarItem[];
          googleCalendar?: Partial<GoogleCalendarSyncStatus>;
          googleCalendarSync?: Partial<GoogleCalendarSyncStatus> & { ok?: boolean; error?: string };
          syncKey?: string;
          warnings?: string[];
        };
        if (!response.ok && response.status >= 500) {
          await retryDelay(900);
          response = await saveWithRetries();
          if (calendarSaveVersionRef.current !== saveVersion) return;
          data = (await response.json().catch(() => ({}))) as typeof data;
        }
        if (response.status === 401) {
          sessionExpired = true;
          setAuthStatus("guest");
          throw new Error(data.message || "Admin login expired. Sign in again before editing the calendar.");
        }
        if (!response.ok) throw new Error(data.message || data.error || "Calendar save failed.");
        saveReachedServer = true;
        setCalendarFeedStatus("connected");
        setCalendarSaveStatus("saved");
        setCalendarSaveError("");
        if (typeof data.updatedAt === "string") setCalendarStateVersion(data.updatedAt);
        const persistedSyncKey = typeof data.syncKey === "string" ? data.syncKey : calendarSyncKey;
        lastPersistedCalendarFingerprintRef.current = calendarStateFingerprint(items, persistedSyncKey);
        if (typeof data.syncKey === "string" && data.syncKey !== calendarSyncKey) setCalendarSyncKey(data.syncKey);
        if (Array.isArray(data.notifications)) setNotifications(cleanNotificationRecords(data.notifications));
        const clientSyncWarning = Array.isArray(data.warnings)
          ? data.warnings.find((warning) => typeof warning === "string" && warning.trim())
          : "";
        if (clientSyncWarning) setToast({ message: clientSyncWarning });
        applyGoogleCalendarStatus(data.googleCalendarSync || data.googleCalendar);
        if (data.googleCalendarSync && data.googleCalendarSync.ok === false && data.googleCalendarSync.error) {
          setToast({ message: `Saved booking calendar, but Google Calendar did not sync: ${data.googleCalendarSync.error}` });
        }
        window.setTimeout(() => {
          if (calendarSaveVersionRef.current === saveVersion) setCalendarSaveStatus("idle");
        }, 1800);
        window.setTimeout(() => void refreshNotificationHistory(), 1500);
        window.setTimeout(() => void refreshNotificationHistory(), 8000);
        window.setTimeout(() => void refreshNotificationHistory(), 35000);
      })().catch((error) => {
        if (calendarSaveVersionRef.current === saveVersion) {
          const message = error instanceof Error ? error.message : "Calendar save failed.";
          if (saveReachedServer) {
            setCalendarFeedStatus("connected");
            setCalendarSaveStatus("saved");
            setCalendarSaveError("");
            setToast({ message: `Calendar saved, but the page could not refresh all save details: ${message}` });
            window.setTimeout(() => {
              if (calendarSaveVersionRef.current === saveVersion) setCalendarSaveStatus("idle");
            }, 1800);
            return;
          }
          const calmMessage = sessionExpired
            ? message || "Admin login expired. Sign in again before editing the calendar."
            : "Your latest calendar change was not saved. Please try again.";
          setCalendarFeedStatus(sessionExpired ? "offline" : "connected");
          setCalendarSaveStatus("failed");
          setCalendarSaveError(calmMessage);
          setToast({ message: calmMessage });
        }
      });

    }, 650);

    return () => window.clearTimeout(saveTimer);
  }, [authStatus, calendarSyncKey, isEmbedMode, items]);

  useEffect(() => {
    if (isEmbedMode || authStatus !== "authenticated" || activeView !== "calendar") return;
    const timer = window.setInterval(() => void refreshNotificationHistory(), 15000);
    return () => window.clearInterval(timer);
  }, [activeView, authStatus, isEmbedMode]);

  useEffect(() => {
    if (isEmbedMode || authStatus !== "authenticated" || activeView !== "settings") return;
    void refreshGoogleCalendarStatus();
  }, [activeView, authStatus, isEmbedMode]);

  function applyNotificationSettings(settings?: Partial<NotificationSettings>) {
    const delaySeconds = Number(settings?.notificationDelaySeconds ?? defaultNotificationSettings.notificationDelaySeconds);
    const minBookingNoticeMinutes = Number(settings?.minBookingNoticeMinutes ?? defaultNotificationSettings.minBookingNoticeMinutes);
    setNotificationSettings({
      ...defaultNotificationSettings,
      ...(settings ?? {}),
      notificationDelaySeconds: Number.isFinite(delaySeconds) ? clamp(delaySeconds, 30, 3600) : 30,
      minBookingNoticeMinutes: cleanMinBookingNoticeMinutes(minBookingNoticeMinutes),
      googleReviewUrl: cleanUrl(settings?.googleReviewUrl, ""),
    });
  }

  function applyCoachAccount(account?: Partial<CoachAccount>) {
    setCoachAccount(cleanCoachAccount(account));
  }

  function applyBrandSettings(settings?: Partial<BrandSettings>) {
    setBrandSettings(cleanBrandSettings(settings));
  }

  function applyGoogleCalendarStatus(status?: Partial<GoogleCalendarSyncStatus>) {
    setGoogleCalendar({
      ...defaultGoogleCalendarStatus,
      ...(status ?? {}),
      calendarId: typeof status?.calendarId === "string" && status.calendarId.trim() ? status.calendarId : "primary",
      autoSync: status?.autoSync !== false,
    });
  }


  async function readApiFailure(response: Response, fallback: string) {
    try {
      const contentType = response.headers.get("Content-Type") || "";
      if (contentType.includes("application/json")) {
        const data = (await response.json()) as { message?: string; error?: string; failed?: Array<{ name?: string; message?: string }> };
        const firstFailed = Array.isArray(data.failed) && data.failed[0] ? `${data.failed[0].name}: ${data.failed[0].message}` : "";
        return [data.message, firstFailed, data.error, `${response.status} ${response.statusText}`].filter(Boolean).join(" · ");
      }
      const text = await response.text();
      return text ? `${response.status} ${response.statusText}: ${text.slice(0, 280)}` : `${response.status} ${response.statusText}`;
    } catch {
      return fallback;
    }
  }

  async function fetchDatabaseHealthSummary() {
    try {
      const response = await fetch("/api/database-health", { headers: { Accept: "application/json" } });
      if (!response.ok) return "";
      const data = (await response.json()) as { ok?: boolean; failed?: Array<{ name?: string; message?: string }> };
      if (data.ok) return "Database health passed, but calendar state still failed.";
      const firstFailed = Array.isArray(data.failed) && data.failed[0] ? data.failed[0] : null;
      return firstFailed ? `Database health failed at ${firstFailed.name}: ${firstFailed.message}` : "Database health failed.";
    } catch {
      return "";
    }
  }

  async function loadAdminCalendarState() {
    hasLoadedCalendarApiRef.current = false;
    setCalendarFeedStatus("checking");
    setCalendarSaveStatus("idle");
    setCalendarSaveError("");
    const response = await fetch("/api/calendar-state", { headers: { Accept: "application/json" } });
    if (response.status === 401) {
      setAuthStatus("guest");
      throw new Error("Admin login required");
    }
    if (!response.ok) {
      const apiMessage = await readApiFailure(response, "Calendar API unavailable");
      const healthMessage = await fetchDatabaseHealthSummary();
      throw new Error([apiMessage, healthMessage].filter(Boolean).join(" · "));
    }
    const data = (await response.json()) as {
      syncKey?: string;
      items?: CalendarItem[];
      people?: Person[];
      notifications?: NotificationRecord[];
      services?: Service[];
      availability?: AvailabilityWindow[][];
      settings?: Partial<NotificationSettings>;
      brand?: Partial<BrandSettings>;
      account?: Partial<CoachAccount>;
      googleCalendar?: Partial<GoogleCalendarSyncStatus>;
      updatedAt?: string;
    };
    const loadedItems = Array.isArray(data.items) ? data.items : [];
    const loadedSyncKey =
      typeof data.syncKey === "string" && data.syncKey.startsWith("cg_") ? data.syncKey : calendarSyncKey;
    lastPersistedCalendarFingerprintRef.current = calendarStateFingerprint(loadedItems, loadedSyncKey);
    if (typeof data.updatedAt === "string") setCalendarStateVersion(data.updatedAt);
    if (Array.isArray(data.items)) setItems(data.items);
    if (Array.isArray(data.people)) setPeople(cleanPeople(data.people));
    if (Array.isArray(data.notifications)) setNotifications(cleanNotificationRecords(data.notifications));
    if (Array.isArray(data.services)) setServices(cleanServices(data.services));
    if (Array.isArray(data.availability)) setAvailability(cleanAvailability(data.availability));
    if (typeof data.syncKey === "string" && data.syncKey.startsWith("cg_")) {
      setCalendarSyncKey(data.syncKey);
    }
    applyNotificationSettings(data.settings);
    try {
      const adminSettingsResponse = await fetch("/api/admin-settings", { headers: { Accept: "application/json" } });
      if (adminSettingsResponse.ok) {
        const adminSettings = (await adminSettingsResponse.json()) as Partial<NotificationSettings>;
        applyNotificationSettings(adminSettings);
      }
    } catch {
      // Keep the notification settings from /api/calendar-state if admin settings read fails.
    }
    applyCoachAccount(data.account);
    applyBrandSettings(data.brand);
    applyGoogleCalendarStatus(data.googleCalendar);
    hasLoadedCalendarApiRef.current = true;
  }

  async function loadPublicBookingState() {
    const response = await fetch("/api/public-booking-state", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("Public booking API unavailable");
    const data = (await response.json()) as {
      items?: CalendarItem[];
      services?: Service[];
      availability?: AvailabilityWindow[][];
      notifications?: NotificationRecord[];
      brand?: Partial<BrandSettings>;
      account?: Partial<CoachAccount>;
      updatedAt?: string;
    };
    if (typeof data.updatedAt === "string") setCalendarStateVersion(data.updatedAt);
    if (Array.isArray(data.items)) setItems(data.items);
    if (Array.isArray(data.notifications)) setNotifications(data.notifications);
    if (Array.isArray(data.services)) setServices(cleanServices(data.services));
    if (Array.isArray(data.availability)) setAvailability(cleanAvailability(data.availability));
    applyCoachAccount(data.account);
    applyBrandSettings(data.brand);
    hasLoadedCalendarApiRef.current = true;
  }

  function requireLiveDatabase(action = "edit the calendar") {
    if (isEmbedMode) return true;
    if (authStatus !== "authenticated") {
      hasLoadedCalendarApiRef.current = false;
      setCalendarFeedStatus("offline");
      setAuthStatus("guest");
      setToast({ message: "Sign in again before editing. The calendar is not connected to the live database." });
      return false;
    }
    if (!hasLoadedCalendarApiRef.current) {
      setCalendarSaveStatus("failed");
      setCalendarSaveError("Calendar is not connected to the live database.");
      setToast({ message: `Cannot ${action}: the live database is not connected. Reload and sign in again.` });
      return false;
    }
    if (calendarFeedStatus !== "connected") {
      setCalendarFeedStatus("connected");
    }
    if (calendarSaveStatus === "failed" && calendarSaveError === "Calendar is not connected to the live database.") {
      setCalendarSaveStatus("idle");
      setCalendarSaveError("");
    }
    return true;
  }

  const scheduledGroupSlots = useMemo<CalendarItem[]>(() => {
    const firstWeek = getCurrentWeekOffset();
    return services
      .filter((service) => service.lessonFormat === "group" && service.groupSchedule && service.groupSchedule.active && service.active)
      .flatMap((service) => {
        const schedule = service.groupSchedule;
        if (!schedule) return [];
        const occurrenceCount = clamp(
          Math.round(schedule.occurrenceCount),
          1,
          MAX_GROUP_OCCURRENCE_COUNT,
        );
        if (activeWeek < firstWeek || activeWeek >= firstWeek + occurrenceCount) return [];
          return [
            {
              id: `group-slot-${service.id}-${activeWeek}`,
              kind: "block" as const,
              week: activeWeek,
              day: schedule.dayOfWeek,
              start: schedule.startMinutes,
              duration: service.duration,
              serviceId: service.id,
              syntheticGroupSlot: true,
              readOnly: true,
              title: `${service.name} (group)`,
              client: `${service.name} (${service.capacity} places)`,
            },
          ];
      });
  }, [activeWeek, services]);

  const displayItems = useMemo(() => {
    const floatingItemId = floatingDrag?.itemId ?? "";
    const baseWeekItems = floatingItemId ? weekItems.filter((item) => item.id !== floatingItemId) : weekItems;
    if (!draft || draft.mode === "block" || draft.mode === "place") {
      return [...baseWeekItems, ...scheduledGroupSlots];
    }
    const withoutMoving = baseWeekItems.filter((item) => item.id !== draft.itemId);
    const movingItem = items.find((item) => item.id === draft.itemId);
    if (!movingItem || draft.week !== activeWeek) return [...withoutMoving, ...scheduledGroupSlots];
    return [
      ...withoutMoving,
      ...scheduledGroupSlots,
      { ...movingItem, week: draft.week, day: draft.day, start: draft.start, duration: draft.duration },
    ];
  }, [activeWeek, draft, floatingDrag, items, weekItems, scheduledGroupSlots]);
  const floatingItem = floatingDrag ? items.find((item) => item.id === floatingDrag.itemId) : null;
  const floatingService = floatingItem ? itemService(floatingItem, services) : null;

  const clients = useMemo<ClientSummary[]>(() => {
    const byKey = new Map<string, ClientSummary>();

    people.forEach((person) => {
      byKey.set(clientKey(person.name, person.email, person.phone), {
        ...person,
        count: 0,
        next: null,
        last: null,
      });
    });

    items
      .filter((item) => item.kind === "appointment")
      .forEach((item) => {
        const name = item.client ?? item.title;
        const key = clientKey(name, item.email ?? "", item.phone ?? "");
        const existing =
          byKey.get(key) ??
          ({
            id: `appointment-${key}`,
            name,
            email: item.email ?? "",
            phone: item.phone ?? "",
            notes: item.note ?? "",
            source: "appointment",
            caddyProfileId: "",
            caddyProfileUrl: "",
            count: 0,
            next: null,
            last: null,
          } satisfies ClientSummary);
        const next = !existing.next || itemWeek(item) < itemWeek(existing.next) ? item : existing.next;
        byKey.set(key, {
          ...existing,
          name: existing.name || name,
          email: existing.email || item.email || "",
          phone: existing.phone || item.phone || "",
          notes: existing.notes || item.note || "",
          count: existing.count + 1,
          next,
          last: item,
        });
      });

    return Array.from(byKey.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [items, people]);

  const appointmentClients = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    items
      .filter((item) => item.kind === "appointment")
      .forEach((item) => {
        const key = clientKey(item.client || item.title, item.email ?? "", item.phone ?? "");
        const existing = map.get(key) ?? [];
        existing.push(item);
        map.set(key, existing);
      });
    return map;
  }, [items]);

  const emailCampaignRecipients = useMemo<EmailRecipient[]>(() => {
    const now = Date.now();
    return clients.map((client) => {
      const key = clientKey(client.name, client.email, client.phone);
      const appointments = appointmentClients.get(key) ?? [];
      const sortedAppointments = [...appointments].sort((a, b) => {
        const aDate = bookingDateMs(a) ?? 0;
        const bDate = bookingDateMs(b) ?? 0;
        return bDate - aDate;
      });
      const latestAppointment = sortedAppointments[0] ?? null;
      const lastBookingDate = bookingDateMs(latestAppointment);
      const serviceTypesSet = new Set<string>();
      let hasFutureBooking = false;

      appointments.forEach((appointment) => {
        const appointmentService = itemService(appointment, services);
        serviceTypesSet.add(appointmentService?.name || appointment.title || "Lesson");
        const appointmentStartMs = bookingDateMs(appointment);
        if (appointmentStartMs !== null && appointmentStartMs > now) hasFutureBooking = true;
      });

      return {
        ...client,
        hasEmailAddress: Boolean(client.email.trim()),
        isUnsubscribed: client.emailOptOut === true,
        hasFutureBooking,
        lastBookingDateLabel: bookingDateLabel(latestAppointment),
        lastBookingDateMs: lastBookingDate,
        packageLessonsRemainingValue:
          Number.isFinite(client.packageLessonsRemaining ?? NaN) && (client.packageLessonsRemaining as number) >= 0
            ? client.packageLessonsRemaining
            : null,
        serviceTypes: Array.from(serviceTypesSet).sort((a, b) => a.localeCompare(b)),
      };
    });
  }, [appointmentClients, clients, services]);

  const emailCampaignHasUnsubOption = useMemo(
    () => emailCampaignRecipients.some((recipient) => recipient.emailOptOut !== undefined),
    [emailCampaignRecipients],
  );
  const emailCampaignPackageAvailable = useMemo(
    () => emailCampaignRecipients.some((recipient) => recipient.packageLessonsRemainingValue !== null),
    [emailCampaignRecipients],
  );
  const emailCampaignAvailableServiceTypes = useMemo(() => {
    const serviceTypes = new Set<string>();
    emailCampaignRecipients.forEach((recipient) => {
      recipient.serviceTypes.forEach((serviceType) => {
        serviceTypes.add(serviceType);
      });
    });
    return Array.from(serviceTypes).sort((a, b) => a.localeCompare(b));
  }, [emailCampaignRecipients]);
  const emailCampaignDateThreshold = useMemo(() => {
    if (!emailDateThreshold.trim()) return null;
    const parsed = Date.parse(`${emailDateThreshold}T00:00:00`);
    return Number.isNaN(parsed) ? null : parsed;
  }, [emailDateThreshold]);
  const emailCampaignMinTotal = useMemo(() => parseNumberValue(emailTotalBookingsMin), [emailTotalBookingsMin]);
  const emailCampaignMaxTotal = useMemo(() => parseNumberValue(emailTotalBookingsMax), [emailTotalBookingsMax]);
  const emailCampaignMinPackage = useMemo(() => parseNumberValue(emailPackageMin), [emailPackageMin]);
  const emailCampaignMaxPackage = useMemo(() => parseNumberValue(emailPackageMax), [emailPackageMax]);

  const emailCampaignRecipientRows = useMemo<EmailRecipientRow[]>(() => {
    const recipientRows = emailCampaignRecipients.filter((recipient) => {
      if (!recipient.hasEmailAddress) return false;
      if (emailCampaignHasUnsubOption && recipient.isUnsubscribed) return false;
      if (emailCampaignDateThreshold !== null) {
        if (recipient.lastBookingDateMs === null) return false;
        if (emailDateDirection === "before" && recipient.lastBookingDateMs > emailCampaignDateThreshold) return false;
        if (emailDateDirection === "after" && recipient.lastBookingDateMs < emailCampaignDateThreshold) return false;
      }
      if (emailCampaignMinTotal !== undefined && recipient.count < emailCampaignMinTotal) return false;
      if (emailCampaignMaxTotal !== undefined && recipient.count > emailCampaignMaxTotal) return false;
      if (
        emailCampaignPackageAvailable &&
        (emailCampaignMinPackage !== undefined || emailCampaignMaxPackage !== undefined)
      ) {
        if (recipient.packageLessonsRemainingValue === null) return false;
        if (emailCampaignMinPackage !== undefined && recipient.packageLessonsRemainingValue < emailCampaignMinPackage) return false;
        if (emailCampaignMaxPackage !== undefined && recipient.packageLessonsRemainingValue > emailCampaignMaxPackage) return false;
      }
      if (emailHasFutureBooking === "has" && !recipient.hasFutureBooking) return false;
      if (emailHasFutureBooking === "none" && recipient.hasFutureBooking) return false;
      if (emailServiceType && !recipient.serviceTypes.includes(emailServiceType)) return false;
      return true;
    });

    return recipientRows.map((recipient) => ({
      ...recipient,
      isSelected: emailRecipientSelection[recipient.id] ?? true,
    }));
  }, [
    emailCampaignDateThreshold,
    emailCampaignHasUnsubOption,
    emailCampaignMaxPackage,
    emailCampaignMaxTotal,
    emailCampaignMinPackage,
    emailCampaignMinTotal,
    emailCampaignPackageAvailable,
    emailCampaignRecipients,
    emailDateDirection,
    emailHasFutureBooking,
    emailRecipientSelection,
    emailServiceType,
  ]);

  const emailCampaignVisibleCount = emailCampaignRecipientRows.length;
  const emailCampaignSelectedCount = useMemo(
    () => emailCampaignRecipientRows.filter((recipient) => recipient.isSelected).length,
    [emailCampaignRecipientRows],
  );

  useEffect(() => {
    if (!emailCampaignPackageAvailable) {
      setEmailPackageMin("");
      setEmailPackageMax("");
    }
  }, [emailCampaignPackageAvailable]);

  useEffect(() => {
    if (!emailCampaignAvailableServiceTypes.includes(emailServiceType)) {
      setEmailServiceType("");
    }
  }, [emailCampaignAvailableServiceTypes, emailServiceType]);

  const selectedPerson = useMemo(() => {
    if (!selected || selected.kind !== "appointment") return null;
    const key = clientKey(selected.client || selected.title, selected.email ?? "", selected.phone ?? "");
    return clients.find((client) => clientKey(client.name, client.email, client.phone) === key) ?? null;
  }, [clients, selected]);

  const clientSearchTerm = clientSearch.trim();
  const filteredClients = useMemo(() => {
    if (!clientSearchTerm) return clients;
    return clients.filter((client) => clientMatchesSearchTerm(client, clientSearchTerm));
  }, [clientSearchTerm, clients]);

  const quickClientInput = {
    name: quickClientSearch,
    email: quickCreate?.email ?? "",
    phone: quickCreate?.phone ?? "",
  };
  const quickClientHasInput = hasClientMatchInput(quickClientInput);
  const quickClientSuggestion = useMemo(() => {
    if (!quickClientHasInput) return null;
    return findClientMatch(clients, quickClientInput);
  }, [quickClientHasInput, clients, quickClientSearch, quickCreate?.email, quickCreate?.phone]);
  const quickClientSuggestionApplied = Boolean(
    quickClientSuggestion &&
      normalizeMatchText(quickClientSearch) === normalizeMatchText(quickClientSuggestion.name) &&
      (!quickClientSuggestion.phone || phoneValuesMatch(quickClientSuggestion.phone, quickCreate?.phone ?? "", true)) &&
      (!quickClientSuggestion.email ||
        normalizeMatchText(quickClientSuggestion.email) === normalizeMatchText(quickCreate?.email ?? "")),
  );
  const showQuickClientSuggestion = Boolean(
    quickClientSuggestion && quickClientHasInput && !quickClientSuggestionApplied,
  );
  const bookingClientInput = {
    firstName: bookingForm.firstName,
    lastName: bookingForm.lastName,
    email: bookingForm.email,
    phone: bookingForm.phone,
  };
  const bookingClientHasInput = hasClientMatchInput(bookingClientInput);
  const bookingClientSuggestion = useMemo(() => {
    if (isEmbedMode || !bookingClientHasInput) return null;
    return findClientMatch(clients, bookingClientInput);
  }, [
    isEmbedMode,
    bookingClientHasInput,
    clients,
    bookingForm.firstName,
    bookingForm.lastName,
    bookingForm.email,
    bookingForm.phone,
  ]);
  const bookingClientSuggestionApplied = Boolean(
    bookingClientSuggestion &&
      normalizeMatchText(bookingInputName(bookingClientInput)) ===
        normalizeMatchText(bookingClientSuggestion.name) &&
      (!bookingClientSuggestion.phone ||
        phoneValuesMatch(bookingClientSuggestion.phone, bookingForm.phone, true)) &&
      (!bookingClientSuggestion.email ||
        normalizeMatchText(bookingClientSuggestion.email) === normalizeMatchText(bookingForm.email)),
  );
  const showBookingClientSuggestion = Boolean(
    bookingClientSuggestion && bookingClientHasInput && !bookingClientSuggestionApplied,
  );

  const notificationsByAppointment = useMemo(() => {
    const byAppointment = new Map<string, NotificationRecord[]>();
    notifications.forEach((notification) => {
      if (!notification.calendarItemId) return;
      const current = byAppointment.get(notification.calendarItemId) ?? [];
      current.push(notification);
      byAppointment.set(notification.calendarItemId, current);
    });
    byAppointment.forEach((records) => {
      records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    });
    return byAppointment;
  }, [notifications]);

  const selectedClient =
    !isAddingClient && selectedClientId ? clients.find((client) => client.id === selectedClientId) ?? null : null;
  const selectedClientAppointments = useMemo(() => {
    if (!selectedClient) return [];
    const key = clientKey(selectedClient.name, selectedClient.email, selectedClient.phone);
    return items
      .filter((item) => item.kind === "appointment")
      .filter((item) => clientKey(item.client || item.title, item.email ?? "", item.phone ?? "") === key)
      .sort((a, b) => itemWeek(a) - itemWeek(b) || a.day - b.day || a.start - b.start);
  }, [items, selectedClient]);
  const selectedAppointmentNotifications = useMemo(() => {
    if (!selected || selected.kind !== "appointment") return [];
    return notificationsByAppointment.get(selected.id) ?? [];
  }, [notificationsByAppointment, selected]);

  function showCalendarItemHover(
    event: ReactPointerEvent<HTMLElement>,
    item: CalendarItem,
    service: Service | undefined | null,
    latestClientEmail?: NotificationRecord,
    latestCoachEmail?: NotificationRecord,
    latestAdminEmail?: NotificationRecord,
  ) {
    if (isEmbedMode || pointerSessionRef.current) return;
    if (event.pointerType === "touch") return;
    const groupSessionContext = getGroupSessionContext(item);
    if (!groupSessionContext && item.kind !== "appointment" && item.kind !== "block") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const cardWidth = 304;
    const gap = 14;
    const rightX = rect.right + gap;
    const leftX = rect.left - cardWidth - gap;
    const x = rightX + cardWidth < window.innerWidth - 16 ? rightX : Math.max(16, leftX);
    const y = clamp(rect.top - 12, 16, Math.max(16, window.innerHeight - 260));
    setCalendarHover({
      itemId: item.id,
      x,
      y,
      kind: groupSessionContext ? "group-session" : item.kind === "appointment" ? "appointment" : "blocked",
      client: groupSessionContext ? groupSessionContext.service.name : item.client || item.title,
      service: groupSessionContext
        ? `Group Session · ${groupSessionContext.bookedCount}/${groupSessionContext.capacity} booked`
        : service?.name ?? "Golf lesson",
      time: `${dateForSlot(itemWeek(item), item.day).toLocaleDateString("en-NZ", { weekday: "long", month: "short", day: "numeric" })}, ${formatRange(item.start, item.duration)}`,
      venue: service?.location || coachAccount.venueShortName || coachAccount.venueName,
      phone: groupSessionContext ? "" : item.phone || "",
      email: groupSessionContext ? "" : item.email || "",
      clientEmailStatus: latestClientEmail ? notificationStatusLabel(latestClientEmail) : "No client email receipt yet",
      coachEmailStatus: latestCoachEmail ? notificationStatusLabel(latestCoachEmail) : "No coach receipt yet",
      adminEmailStatus: latestAdminEmail ? notificationStatusLabel(latestAdminEmail) : "No admin receipt yet",
    });
  }

  function hideCalendarItemHover(itemId?: string) {
    setCalendarHover((current) => (!itemId || current?.itemId === itemId ? null : current));
  }

  const selectedClientNotifications = useMemo(() => {
    if (!selectedClient) return [];
    const keys = clientNotificationKeys(selectedClient.name, selectedClient.email, selectedClient.phone);
    const appointmentIds = new Set(selectedClientAppointments.map((appointment) => appointment.id));
    const clientEmail = safeText(selectedClient.email).trim().toLowerCase();
    return notifications
      .filter((notification) => {
        const isClientFacing = notification.kind.includes("client") || Boolean(clientEmail && safeText(notification.recipient).toLowerCase() === clientEmail);
        if (!isClientFacing || notification.kind.includes("admin")) return false;
        return (
          keys.has(notification.personKey) ||
          appointmentIds.has(notification.calendarItemId) ||
          Boolean(clientEmail && safeText(notification.recipient).toLowerCase() === clientEmail)
        );
      })
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }, [notifications, selectedClient, selectedClientAppointments]);
  const hasSelectedClientCaddyProfile = Boolean(
    safeText(selectedClient?.caddyProfileId).trim() || safeText(selectedClient?.caddyProfileUrl).trim(),
  );
  const hasSelectedPersonCaddyProfile = Boolean(
    safeText(selectedPerson?.caddyProfileId).trim() || safeText(selectedPerson?.caddyProfileUrl).trim(),
  );

  const peopleImportPreview = useMemo(() => parsePeopleImport(peopleImportText).length, [peopleImportText]);

  function closeCalendarDetails() {
    setSelectedId("");
    setSelectedGroupSession(null);
  }

  function isGroupServiceSlotMatch(service: Service | null, week: number, day: number, start: number) {
    if (!service || service.lessonFormat !== "group" || !service.groupSchedule?.active) return false;
    if (day !== service.groupSchedule.dayOfWeek) return false;
    if (start !== service.groupSchedule.startMinutes) return false;
    if (!Number.isInteger(week)) return false;
    const weekOffset = getCurrentWeekOffset();
    const occurrenceLimit = clamp(Math.round(service.groupSchedule.occurrenceCount), 1, MAX_GROUP_OCCURRENCE_COUNT);
    if (week < weekOffset || week >= weekOffset + occurrenceLimit) return false;
    return true;
  }

  function openQuickCreateForGroupSlot(item: CalendarItem, anchor: { x: number; y: number }) {
    const service = services.find((candidate) => candidate.id === item.serviceId);
    if (!service || service.lessonFormat !== "group") return;
    const slotWeek = itemWeek(item);
    if (!isGroupServiceSlotMatch(service, slotWeek, item.day, item.start)) return;
    const candidate = {
      week: slotWeek,
      day: item.day,
      start: item.start,
      duration: service.duration,
    };
    closeCalendarDetails();
    setQuickMatchField("name");
    setQuickClientSearch("");
    setQuickCreate({
      week: slotWeek,
      day: item.day,
      start: item.start,
      x: anchor.x,
      y: anchor.y,
      serviceId: service.id,
      phone: "",
      email: "",
      note: "",
      error: quickCreateAvailabilityError(candidate, service),
    });
  }

  function openGroupSessionFromSlot(item: CalendarItem): boolean {
    const failWith = (reason: string) => {
      setToast({ message: `Unable to open group session: ${reason}` });
      return false;
    };

    const serviceId = item.serviceId;
    if (!serviceId) return failWith("missing serviceId");

    const service = services.find((candidate) => candidate.id === serviceId);
    if (!service) return failWith("service not found");
    if (service.lessonFormat !== "group") return failWith("service is not group");

    const week = itemWeek(item);
    const slotWeek = Number.isInteger(week) ? week : NaN;
    const slotData = {
      day: item.day,
      start: item.start,
      duration: item.duration,
    };

    if (item.syntheticGroupSlot || item.groupSlot) {
      if (!service || !Number.isInteger(slotWeek) || !Number.isInteger(slotData.day) || !Number.isFinite(slotData.start) || !Number.isFinite(slotData.duration)) {
        return failWith("slot does not match schedule");
      }
    } else {
      if (!service.groupSchedule || !service.groupSchedule.active) return failWith("missing groupSchedule");
      if (!isGroupServiceSlotMatch(service, slotWeek, slotData.day, slotData.start)) return failWith("slot does not match schedule");
    }

    const candidateSession: GroupSession = {
      serviceId,
      week: slotWeek,
      day: slotData.day,
      start: slotData.start,
      duration: slotData.duration || service.duration,
    };
    const sessionService = services.find((candidate) => candidate.id === candidateSession.serviceId);
    if (!sessionService) return failWith("selectedGroupSessionDetails failed to resolve");

    setSelectedGroupSession(candidateSession);
    setSelectedId("");
    setQuickCreate(null);
    return true;
  }

  function openGroupSessionForItem(item: CalendarItem) {
    return openGroupSessionFromSlot(item);
  }

  function openQuickCreateForGroupSession(anchor: { x: number; y: number }) {
    if (!selectedGroupSession) return;
    const service = selectedGroupSessionService;
    if (!service || service.lessonFormat !== "group") return;
    const candidate = {
      week: selectedGroupSession.week,
      day: selectedGroupSession.day,
      start: selectedGroupSession.start,
      duration: selectedGroupSession.duration,
    };
    setQuickMatchField("name");
    setQuickClientSearch("");
    setQuickCreate({
      week: candidate.week,
      day: candidate.day,
      start: candidate.start,
      x: anchor.x,
      y: anchor.y,
      serviceId: service.id,
      phone: "",
      email: "",
      note: "",
      error: quickCreateAvailabilityError(candidate, service),
    });
  }

  function isScheduledGroupSessionSlot(item: CalendarItem) {
    if (item.syntheticGroupSlot || item.groupSlot) return true;
    const service = itemService(item, services);
    return (
      item.readOnly &&
      item.kind === "block" &&
      service?.lessonFormat === "group" &&
      isGroupServiceSlotMatch(service, itemWeek(item), item.day, item.start)
    );
  }

  function isGroupSessionAppointment(item: CalendarItem) {
    const service = itemService(item, services);
    return (
      item.kind === "appointment" &&
      service?.lessonFormat === "group" &&
      isGroupServiceSlotMatch(service, itemWeek(item), item.day, item.start)
    );
  }

  function isGroupSessionItem(item: CalendarItem) {
    return isScheduledGroupSessionSlot(item) || isGroupSessionAppointment(item);
  }

  function isActiveGroupBooking(status: BookingStatus | undefined) {
    if (!status) return true;
    return status === "booked" || status === "completed";
  }

  function getGroupSessionContext(item: CalendarItem) {
    if (!isGroupSessionItem(item)) return null;
    const service = itemService(item, services);
    if (!service || service.lessonFormat !== "group") return null;
    const week = itemWeek(item);
    if (!Number.isInteger(week) || !Number.isInteger(item.day) || !Number.isFinite(item.start)) return null;
    const duration = Number.isFinite(item.duration) && item.duration > 0 ? item.duration : service.duration;
    if (!isScheduledGroupSessionSlot(item) && !isGroupServiceSlotMatch(service, week, item.day, item.start)) return null;
    const session: GroupSession = {
      serviceId: service.id,
      week,
      day: item.day,
      start: item.start,
      duration,
    };
    const candidate = {
      week: session.week,
      day: session.day,
      start: session.start,
      duration: session.duration,
    };
    const attendees = items
      .filter(
        (candidateItem) =>
          candidateItem.kind === "appointment" &&
          candidateItem.serviceId === service.id &&
          overlaps(itemSlot(candidateItem), candidate),
      )
      .sort((a, b) => (a.client ?? "").localeCompare(b.client ?? ""));
    const bookedCount = attendees.filter((appointment) => isActiveGroupBooking(appointment.status)).length;
    return {
      service,
      session,
      attendees,
      capacity: service.capacity,
      bookedCount,
    };
  }

  function handleCalendarItemClick(
    event: ReactMouseEvent<HTMLElement> | ReactPointerEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>,
    item: CalendarItem,
  ) {
    if (!isGroupSessionItem(item)) return false;
    event.preventDefault();
    event.stopPropagation();
    hideCalendarItemHover();
    return openGroupSessionForItem(item);
  }

  const bookingSlots = useMemo<BookingSlot[]>(() => {
    if (!bookingTargetService) return [];

    const ignoreId = bookingMode === "reschedule" ? selectedRescheduleMatch?.id : undefined;

    if (bookingMode === "book" && bookingTargetService.lessonFormat === "group") {
      const schedule = bookingTargetService.groupSchedule;
      if (!schedule?.active) return [];
      const candidate = {
        week: activeWeek,
        day: schedule.dayOfWeek,
        start: schedule.startMinutes,
        duration: bookingTargetService.duration,
      };
      if (!isGroupServiceSlotMatch(bookingTargetService, activeWeek, schedule.dayOfWeek, schedule.startMinutes)) return [];
      if (hasCollision(candidate, ignoreId, bookingTargetService)) return [];
      const remainingSpots = getGroupSlotRemainingSpots(candidate, bookingTargetService);
      if (!remainingSpots) return [];
      return [
        {
          week: candidate.week,
          day: candidate.day,
          start: candidate.start,
          remainingSpots,
        },
      ];
    }

    if (!bookingDaySelected) return [];

    const windows = availability[bookingDay] ?? [];
    const slots: BookingSlot[] = [];
    windows.forEach((window) => {
      for (let start = window.start; start + bookingTargetService.duration <= window.end; start += 30) {
        const candidate = {
          week: activeWeek,
          day: bookingDay,
          start,
          duration: bookingTargetService.duration,
        };
        if (!hasCollision(candidate, ignoreId, bookingTargetService)) {
          slots.push({
            week: candidate.week,
            day: candidate.day,
            start: candidate.start,
            remainingSpots: 0,
          });
        }
      }
    });
    return slots;
  }, [activeWeek, bookingDay, bookingDaySelected, bookingMode, bookingTargetService, selectedRescheduleMatch, items, availability]);
  const visibleBookingSlots = bookingStart === null ? bookingSlots : bookingSlots.filter((slot) => slot.start === bookingStart);

  const isAppointmentStepComplete = Boolean(selectedBookingService);
  const isDateTimeStepComplete = bookingDaySelected && bookingStart !== null;
  const isInformationStepComplete =
    isDateTimeStepComplete &&
    bookingForm.firstName.trim() !== "" &&
    bookingForm.lastName.trim() !== "" &&
    bookingForm.email.trim() !== "";

  const isAppointmentSectionOpen = openPublicBookingSection === "appointment";
  const isDateTimeSectionOpen = openPublicBookingSection === "datetime";
  const isInformationSectionOpen = openPublicBookingSection === "information";

  const appointmentSummaryName = selectedBookingService
    ? selectedBookingService.name
    : "Choose an appointment type";
  const appointmentSummaryDescription = selectedBookingService?.description?.trim() || "";
  const appointmentSummaryDuration = selectedBookingService
    ? `${selectedBookingService.duration} min · ${servicePriceLabel(selectedBookingService)}`
    : "Select a lesson to continue";
  const dateTimeSummaryLocation = (selectedBookingService?.location?.trim() || locationLine || "").slice(0, 120);
  const bookingDaySummary = bookingDaySelected ? weekDays[bookingDay]?.label ?? "" : "No day selected";
  const dateTimeSummaryLine = isDateTimeStepComplete
    ? `${bookingDaySummary}, ${formatTime(bookingStart ?? 0)}`
    : bookingDaySelected
      ? bookingDaySummary
      : "Choose a day";

  function slotFromClient(clientX: number, clientY: number) {
    const grid = gridRef.current;
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    const x = clamp(clientX - rect.left, 0, rect.width - 1);
    const y = clamp(clientY - rect.top, 0, GRID_HEIGHT - 1);
    const day = clamp(Math.floor((x / rect.width) * DAY_COUNT), 0, DAY_COUNT - 1);
    const minutesFromStart = snap((y / HOUR_HEIGHT) * 60);
    const start = clamp(START_HOUR * 60 + minutesFromStart, START_HOUR * 60, END_HOUR * 60 - SNAP_MINUTES);
    return { day, start, x, y };
  }

  function isClientInsideGrid(clientX: number, clientY: number) {
    const grid = gridRef.current;
    if (!grid) return false;
    const rect = grid.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }

  function isClientInsideDock(clientX: number, clientY: number) {
    const dock = dockRef.current;
    if (!dock) return false;
    const rect = dock.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }

  function dockTileElement(bookingId: string) {
    const dock = dockRef.current;
    if (!dock) return null;
    return (
      Array.from(dock.querySelectorAll<HTMLElement>("[data-dock-booking-id]")).find(
        (tile) => tile.dataset.dockBookingId === bookingId,
      ) ?? null
    );
  }

  function buildDockPlacementAnimation(bookingId: string, itemId: string, candidate: SlotCandidate) {
    const grid = gridRef.current;
    if (!grid) return null;
    const tileRect = dockTileElement(bookingId)?.getBoundingClientRect() ?? dockRef.current?.getBoundingClientRect();
    if (!tileRect) return null;

    const gridRect = grid.getBoundingClientRect();
    const dayWidth = gridRect.width / DAY_COUNT;
    const finalWidth = dayWidth - 12;
    const finalHeight = Math.max(durationToHeight(candidate.duration), 34);
    const finalCenterX = candidate.day * dayWidth + 6 + finalWidth / 2;
    const finalCenterY = minutesToTop(candidate.start) + finalHeight / 2;
    const tileCenterX = tileRect.left + tileRect.width / 2 - gridRect.left;
    const tileCenterY = tileRect.top + tileRect.height / 2 - gridRect.top;

    return {
      itemId,
      fromX: tileCenterX - finalCenterX,
      fromY: tileCenterY - finalCenterY,
    };
  }

  function slotFromPointer(event: ReactPointerEvent<HTMLElement>) {
    return slotFromClient(event.clientX, event.clientY);
  }

  function setDraftState(nextDraft: Draft | null) {
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  }

  function setPointerSessionState(nextSession: PointerSession) {
    pointerSessionRef.current = nextSession;
    setPointerSession(nextSession);
  }

  function setMovedState(nextMoved: boolean) {
    hasMovedRef.current = nextMoved;
    setHasMoved(nextMoved);
  }

  function resetPointerTrail(clientX: number, clientY: number) {
    pointerTrailRef.current = [{ x: clientX, y: clientY, t: performance.now() }];
  }

  function recordPointerTrail(clientX: number, clientY: number) {
    const now = performance.now();
    pointerTrailRef.current = [
      ...pointerTrailRef.current.filter((sample) => now - sample.t <= 240),
      { x: clientX, y: clientY, t: now },
    ].slice(-8);
  }

  function isFlickTowardDock() {
    const samples = pointerTrailRef.current;
    if (samples.length < 2) return false;
    const latest = samples.at(-1);
    if (!latest) return false;
    const previous =
      samples
        .slice(0, -1)
        .reverse()
        .find((sample) => latest.t - sample.t >= 55) ?? samples[0];
    const elapsed = Math.max(latest.t - previous.t, 1);
    const recentDeltaY = latest.y - previous.y;
    const recentDeltaX = Math.abs(latest.x - previous.x);
    const totalDeltaY = latest.y - pointerStartRef.current.y;
    const velocityY = recentDeltaY / elapsed;
    const dockRect = dockRef.current?.getBoundingClientRect();
    const nearDock = dockRect ? latest.y <= dockRect.bottom + 180 : latest.y <= pointerStartRef.current.y - 80;
    return (
      recentDeltaY < -42 &&
      totalDeltaY < -76 &&
      Math.abs(recentDeltaY) > recentDeltaX * 0.72 &&
      velocityY < -0.42 &&
      nearDock
    );
  }

  function dockAppointmentItem(movedItem: CalendarItem, options: { fromFlick?: boolean } = {}) {
    if (!requireLiveDatabase("dock appointments")) return false;
    if (movedItem.kind !== "appointment") return false;
    const service = itemService(movedItem, services);
    if (!service) return false;

    const docked: PendingBooking = {
      id: `dock-${Date.now()}`,
      sourceItemId: movedItem.id,
      client: movedItem.client ?? movedItem.title,
      title: movedItem.title,
      serviceId: service.id,
      duration: movedItem.duration,
      phone: movedItem.phone,
      email: movedItem.email,
      note: movedItem.note,
    };
    const dockRect = dockRef.current?.getBoundingClientRect();
    const meta = dragPreviewMetaRef.current;
    const startX = pointerClientRef.current.x - (meta?.width ?? 180) / 2;
    const startY = pointerClientRef.current.y - (meta?.height ?? 42) / 2;
    const fromX = dockRect ? startX - dockRect.left : undefined;
    const fromY = dockRect ? startY - dockRect.top : undefined;

    setItems(items.filter((item) => item.id !== movedItem.id));
    setFloatingDrag(null);
    closeCalendarDetails();
    setFlyingBooking({ ...docked, fromX, fromY });
    window.setTimeout(() => {
      setDockBookings((current) => [...current, docked]);
      setActiveDockBookingId(docked.id);
      setFlyingBooking((current) => (current?.id === docked.id ? null : current));
      setToast({
        message: options.fromFlick
          ? `${docked.client} flew into the dock.`
          : `${docked.client} is parked on the shelf.`,
        undo: () => {
          setDockBookings((current) => current.filter((booking) => booking.id !== docked.id));
          setItems((current) => [...current, movedItem]);
          setActiveDockBookingId("");
        },
      });
    }, 680);
    return true;
  }

  function hasPointerMovedPastThreshold(clientX: number, clientY: number) {
    const deltaX = clientX - pointerStartRef.current.x;
    const deltaY = clientY - pointerStartRef.current.y;
    const threshold = pointerKindRef.current === "touch" ? TOUCH_DRAG_THRESHOLD : MOUSE_DRAG_THRESHOLD;
    return Math.hypot(deltaX, deltaY) >= threshold;
  }

  function setFloatingDragFromPointer(itemId: string, clientX: number, clientY: number) {
    const meta = dragPreviewMetaRef.current;
    if (!meta) return;
    setFloatingDrag({
      itemId,
      x: clientX - meta.offsetX,
      y: clientY - meta.offsetY,
      width: meta.width,
      height: meta.height,
    });
  }

  function setActiveWeekState(nextWeek: number) {
    activeWeekRef.current = nextWeek;
    setActiveWeek(nextWeek);
    closeCalendarDetails();
    setQuickCreate(null);
  }

  function toggleCalendarDetailMode() {
    suppressBlankGestureUntilRef.current = Date.now() + 360;
    setCalendarDetailMode((current) => !current);
  }

  function enableCalendarDetailMode() {
    suppressBlankGestureUntilRef.current = Date.now() + 360;
    setCalendarDetailMode(true);
  }

  function handleCalendarTouchStart(event: ReactTouchEvent<HTMLElement>) {
    const now = Date.now();
    if (event.touches.length > 1) {
      enableCalendarDetailMode();
      return;
    }
    if (now - lastCalendarTapRef.current < 320) {
      event.preventDefault();
      toggleCalendarDetailMode();
      lastCalendarTapRef.current = 0;
      return;
    }
    lastCalendarTapRef.current = now;
  }

  function flashEdgeCue(direction: "prev" | "next") {
    setEdgeCue(direction);
    if (edgeCueTimerRef.current) clearTimeout(edgeCueTimerRef.current);
    edgeCueTimerRef.current = setTimeout(() => setEdgeCue(null), 550);
  }

  function handleEdgeNavigation(clientX: number) {
    const session = pointerSessionRef.current;
    if (!session || (session.mode !== "move" && session.mode !== "place")) return;
    const now = Date.now();
    if (now - lastEdgeNavRef.current < 850) return;
    if (clientX <= EDGE_NAV_ZONE) {
      lastEdgeNavRef.current = now;
      setActiveWeekState(activeWeekRef.current - 1);
      flashEdgeCue("prev");
    } else if (clientX >= window.innerWidth - EDGE_NAV_ZONE) {
      lastEdgeNavRef.current = now;
      setActiveWeekState(activeWeekRef.current + 1);
      flashEdgeCue("next");
    }
  }

  function clearGesture(options: { preserveQuickCreate?: boolean } = {}) {
    gestureCleanupRef.current?.();
    gestureCleanupRef.current = null;
    clickPlaceRef.current = null;
    dragPreviewMetaRef.current = null;
    pendingQuickCreateRef.current = null;
    setFloatingDrag(null);
    setDraftState(null);
    setPointerSessionState(null);
    setMovedState(false);
    if (!options.preserveQuickCreate) setQuickCreate(null);
  }

  function isInsideAvailability(day: number, start: number, duration: number) {
    const end = start + duration;
    return availability[day].some((window) => start >= window.start && end <= window.end);
  }

  function hasCollision(candidate: SlotCandidate, ignoreId?: string, service?: Service) {
    const candidateEnd = candidate.start + candidate.duration;
    const overlappingItems = items.filter((item) => {
      if (item.id === ignoreId || itemWeek(item) !== candidate.week || item.day !== candidate.day) return false;
      const itemEnd = item.start + item.duration;
      return candidate.start < itemEnd && candidateEnd > item.start;
    });
    if (!service || service.lessonFormat !== "group") {
      return overlappingItems.length > 0;
    }
    const sameServiceCount = overlappingItems.filter(
      (item) => item.kind === "appointment" && item.serviceId === service.id && isActiveGroupBooking(item.status),
    ).length;
    const collidesWithOtherService = overlappingItems.some(
      (item) => item.kind !== "appointment" || item.serviceId !== service.id,
    );
    if (collidesWithOtherService) return true;
    return sameServiceCount >= service.capacity;
  }

  function getGroupSlotRemainingSpots(candidate: SlotCandidate, service?: Service) {
    if (!service || service.lessonFormat !== "group") return 0;
    const bookedCount = items.filter(
      (item) =>
        item.kind === "appointment" &&
        item.serviceId === service.id &&
        overlaps(itemSlot(item), candidate) &&
        isActiveGroupBooking(item.status),
    ).length;
    return Math.max(0, service.capacity - bookedCount);
  }

  function isGroupSlotFull(candidate: SlotCandidate, service?: Service) {
    if (!service || service.lessonFormat !== "group") return false;
    const sameServiceCount = items.filter(
      (item) =>
        item.kind === "appointment" &&
        item.serviceId === service.id &&
        overlaps(itemSlot(item), candidate) &&
        isActiveGroupBooking(item.status),
    ).length;
    return sameServiceCount >= service.capacity;
  }

  function quickCreateAvailabilityError(candidate: SlotCandidate, service?: Service) {
    if (!service) return "That service is no longer available.";
    if (isGroupSlotFull(candidate, service)) return "Group is full.";
    if (!isValidAppointmentSlot(candidate, undefined, service)) return "That time is already occupied.";
    return "";
  }

  function hasAppointmentCollision(candidate: SlotCandidate, ignoreId?: string) {
    const candidateEnd = candidate.start + candidate.duration;
    return items.some((item) => {
      if (
        item.id === ignoreId ||
        itemWeek(item) !== candidate.week ||
        item.day !== candidate.day ||
        item.kind !== "appointment"
      ) {
        return false;
      }
      const itemEnd = item.start + item.duration;
      return candidate.start < itemEnd && candidateEnd > item.start;
    });
  }

  function isValidAppointmentSlot(candidate: SlotCandidate, ignoreId?: string, service?: Service) {
    if (candidate.start < START_HOUR * 60 || candidate.start + candidate.duration > END_HOUR * 60) return false;
    if (service?.lessonFormat === "group") return !hasCollision(candidate, ignoreId, service);
    if (hasAppointmentCollision(candidate, ignoreId)) return false;
    return true;
  }

  function isValidBlockSlot(candidate: SlotCandidate, ignoreId?: string) {
    if (candidate.duration < SNAP_MINUTES) return false;
    if (candidate.start < START_HOUR * 60 || candidate.start + candidate.duration > END_HOUR * 60) return false;
    const candidateEnd = candidate.start + candidate.duration;
    return !items.some((item) => {
      if (
        item.id === ignoreId ||
        itemWeek(item) !== candidate.week ||
        item.day !== candidate.day ||
        item.kind === "block"
      ) {
        return false;
      }
      const itemEnd = item.start + item.duration;
      return candidate.start < itemEnd && candidateEnd > item.start;
    });
  }

  function carveBusyBlocksForAppointment(nextItems: CalendarItem[], appointment: SlotCandidate) {
    const appointmentEnd = appointment.start + appointment.duration;
    return nextItems.flatMap((item) => {
      if (item.kind !== "block" || !overlaps(itemSlot(item), appointment)) return [item];

      const blockEnd = item.start + item.duration;
      const fragments: CalendarItem[] = [];
      const beforeDuration = appointment.start - item.start;
      const afterDuration = blockEnd - appointmentEnd;

      if (beforeDuration >= SNAP_MINUTES) {
        fragments.push({
          ...item,
          id: `${item.id}-before-${Date.now()}`,
          duration: beforeDuration,
        });
      }

      if (afterDuration >= SNAP_MINUTES) {
        fragments.push({
          ...item,
          id: `${item.id}-after-${Date.now()}`,
          start: appointmentEnd,
          duration: afterDuration,
        });
      }

      return fragments;
    });
  }

  function isValidForItem(item: CalendarItem, candidate: SlotCandidate) {
    return item.kind === "block"
      ? isValidBlockSlot(candidate, item.id)
      : isValidAppointmentSlot(candidate, item.id);
  }

  function settleNearCollisionBoundary(item: CalendarItem, candidate: SlotCandidate) {
    if (isValidForItem(item, candidate)) return { candidate, valid: true };

    const nearbyStarts = items
      .filter((other) => other.id !== item.id && itemWeek(other) === candidate.week && other.day === candidate.day)
      .flatMap((other) => [other.start + other.duration, other.start - candidate.duration])
      .map((start) => snap(start))
      .filter((start) => Math.abs(start - candidate.start) <= SNAP_MINUTES * 2)
      .filter((start) => start >= START_HOUR * 60 && start + candidate.duration <= END_HOUR * 60)
      .sort((a, b) => Math.abs(a - candidate.start) - Math.abs(b - candidate.start));

    for (const start of nearbyStarts) {
      const adjusted = { ...candidate, start };
      if (isValidForItem(item, adjusted)) return { candidate: adjusted, valid: true };
    }

    return { candidate, valid: false };
  }

  function attachGestureListeners() {
    gestureCleanupRef.current?.();

    const movePointer = (event: globalThis.PointerEvent) => {
      updatePointerAt(event.clientX, event.clientY);
    };
    const moveMouse = (event: MouseEvent) => {
      updatePointerAt(event.clientX, event.clientY);
    };
    const finish = (event: globalThis.PointerEvent | MouseEvent) => {
      pointerClientRef.current = { x: event.clientX, y: event.clientY };
      gestureCleanupRef.current?.();
      gestureCleanupRef.current = null;
      endPointer();
    };

    window.addEventListener("pointermove", movePointer);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
    window.addEventListener("mousemove", moveMouse);
    window.addEventListener("mouseup", finish, { once: true });

    gestureCleanupRef.current = () => {
      window.removeEventListener("pointermove", movePointer);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("mousemove", moveMouse);
      window.removeEventListener("mouseup", finish);
    };
  }

  function beginMove(event: ReactPointerEvent<HTMLElement>, item: CalendarItem) {
    event.preventDefault();
    event.stopPropagation();
    if (!requireLiveDatabase("move appointments")) return;
    const slot = slotFromPointer(event);
    if (!slot) return;
    const rect = event.currentTarget.getBoundingClientRect();
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    pointerClientRef.current = { x: event.clientX, y: event.clientY };
    resetPointerTrail(event.clientX, event.clientY);
    pointerKindRef.current = event.pointerType || "mouse";
    dragPreviewMetaRef.current = {
      width: rect.width,
      height: rect.height,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    setFloatingDrag(null);
    setMovedState(false);
    setQuickCreate(null);
    setPointerSessionState({
      mode: "move",
      itemId: item.id,
      offsetMinutes: slot.start - item.start,
      origin: item,
    });
    event.currentTarget.setPointerCapture(event.pointerId);
    attachGestureListeners();
  }

  function beginResize(event: ReactPointerEvent<HTMLElement>, item: CalendarItem) {
    event.preventDefault();
    event.stopPropagation();
    if (!requireLiveDatabase("resize appointments")) return;
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    pointerClientRef.current = { x: event.clientX, y: event.clientY };
    resetPointerTrail(event.clientX, event.clientY);
    pointerKindRef.current = event.pointerType || "mouse";
    dragPreviewMetaRef.current = null;
    setFloatingDrag(null);
    setMovedState(false);
    setQuickCreate(null);
    setPointerSessionState({ mode: "resize", itemId: item.id, origin: item });
    event.currentTarget.setPointerCapture(event.pointerId);
    attachGestureListeners();
  }

  function beginBlankGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    if (Date.now() < suppressBlankGestureUntilRef.current) return;
    if ((event.target as HTMLElement).closest("[data-calendar-item]")) return;
    const slot = slotFromPointer(event);
    if (!slot) return;
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    pointerClientRef.current = { x: event.clientX, y: event.clientY };
    resetPointerTrail(event.clientX, event.clientY);
    pointerKindRef.current = event.pointerType || "mouse";
    dragPreviewMetaRef.current = null;
    setFloatingDrag(null);
    pendingQuickCreateRef.current = {
      week: activeWeek,
      day: slot.day,
      start: slot.start,
      x: event.clientX,
      y: event.clientY,
      serviceId: "",
      phone: "",
      email: "",
      note: "",
      error: "",
    };
    clickPlaceRef.current = activeDockBooking
      ? {
          bookingId: activeDockBooking.id,
          candidate: {
            week: activeWeekRef.current,
            day: slot.day,
            start: slot.start,
            duration: activeDockBooking.duration,
          },
        }
      : null;
    setMovedState(false);
    setPointerSessionState(event.pointerType === "touch" ? null : { mode: "block", day: slot.day, start: slot.start });
    event.currentTarget.setPointerCapture(event.pointerId);
    attachGestureListeners();
  }

  function updatePointer(event: ReactPointerEvent<HTMLElement>) {
    updatePointerAt(event.clientX, event.clientY);
  }

  function updatePointerAt(clientX: number, clientY: number) {
    pointerClientRef.current = { x: clientX, y: clientY };
    recordPointerTrail(clientX, clientY);
    const session = pointerSessionRef.current;
    const movedPastThreshold = hasPointerMovedPastThreshold(clientX, clientY);
    if (!session) {
      if (pendingQuickCreateRef.current && movedPastThreshold) setMovedState(true);
      return;
    }
    if (!movedPastThreshold) return;
    pendingQuickCreateRef.current = null;
    handleEdgeNavigation(clientX);
    const insideGrid = isClientInsideGrid(clientX, clientY);
    const slot = insideGrid ? slotFromClient(clientX, clientY) : null;
    setMovedState(true);

    if (session.mode === "move") {
      if (!slot) {
        setDraftState(null);
        if (session.origin.kind === "appointment") {
          setFloatingDragFromPointer(session.itemId, clientX, clientY);
        } else {
          setFloatingDrag(null);
        }
        return;
      }
      setFloatingDrag(null);
      const origin = session.origin;
      const start = clamp(
        snap(slot.start - session.offsetMinutes),
        START_HOUR * 60,
        END_HOUR * 60 - origin.duration,
      );
      const rawCandidate = { week: activeWeekRef.current, day: slot.day, start, duration: origin.duration };
      const { candidate, valid } = settleNearCollisionBoundary(origin, rawCandidate);
      setDraftState({
        mode: "move",
        itemId: session.itemId,
        ...candidate,
        valid,
      });
      return;
    }

    if (session.mode === "resize") {
      if (!slot) return;
      const origin = session.origin;
      const end = clamp(snap(slot.start + SNAP_MINUTES), origin.start + SNAP_MINUTES, END_HOUR * 60);
      const candidate = {
        week: itemWeek(origin),
        day: origin.day,
        start: origin.start,
        duration: end - origin.start,
      };
      setDraftState({
        mode: "resize",
        itemId: session.itemId,
        ...candidate,
        valid: isValidForItem(origin, candidate),
      });
      return;
    }

    if (session.mode === "place") {
      if (!slot) {
        setDraftState(null);
        return;
      }
      const bookingService = services.find((candidate) => candidate.id === session.booking.serviceId);
      const candidate = {
        week: activeWeekRef.current,
        day: slot.day,
        start: slot.start,
        duration: session.booking.duration,
      };
      setDraftState({
        mode: "place",
        ...candidate,
        valid: isValidAppointmentSlot(candidate, undefined, bookingService),
      });
      return;
    }

    setQuickCreate(null);
    if (!slot) return;
    const start = Math.min(session.start, slot.start);
    const end = Math.max(session.start + SNAP_MINUTES, slot.start + SNAP_MINUTES);
    const candidate = { week: activeWeekRef.current, day: session.day, start, duration: end - start };
    setDraftState({ mode: "block", ...candidate, valid: isValidBlockSlot(candidate) });
  }

  function endPointer() {
    const session = pointerSessionRef.current;
    const activeDraft = draftRef.current;
    const pendingQuickCreate = pendingQuickCreateRef.current;
    const didMove = hasMovedRef.current || hasPointerMovedPastThreshold(pointerClientRef.current.x, pointerClientRef.current.y);

    if (pendingQuickCreate && (!session || session.mode === "block")) {
      if (!didMove) {
        const clickPlace = clickPlaceRef.current;
        if (clickPlace) {
          const booking = dockBookings.find((candidate) => candidate.id === clickPlace.bookingId);
          if (booking) placeDockBookingAtCandidate(booking, clickPlace.candidate, { animateFromDock: true });
          clearGesture();
          return;
        }
        if (requireLiveDatabase("create calendar items")) {
          closeCalendarDetails();
          setQuickCreate(pendingQuickCreate);
          clearGesture({ preserveQuickCreate: true });
        } else {
          clearGesture();
        }
        return;
      }
      pendingQuickCreateRef.current = null;
      if (!session) {
        clearGesture();
        return;
      }
    }

    if (!session) return;
    if (didMove) {
      suppressItemClickRef.current = true;
      suppressItemClickUntilRef.current = Date.now() + 450;
      window.setTimeout(() => {
        suppressItemClickRef.current = false;
      }, 450);
    }

    if (!didMove) {
      const clickPlace = clickPlaceRef.current;
      clickPlaceRef.current = null;
      if (clickPlace) {
        const booking = dockBookings.find((candidate) => candidate.id === clickPlace.bookingId);
        if (booking) placeDockBookingAtCandidate(booking, clickPlace.candidate, { animateFromDock: true });
      }
      clearGesture();
      return;
    }
    clickPlaceRef.current = null;

    if (session.mode === "move") {
      const movedItem = items.find((item) => item.id === session.itemId);
      const dockByDrop = isClientInsideDock(pointerClientRef.current.x, pointerClientRef.current.y);
      const dockByFlick = isFlickTowardDock();
      if (movedItem?.kind === "appointment" && (dockByDrop || dockByFlick)) {
        dockAppointmentItem(movedItem, { fromFlick: dockByFlick && !dockByDrop });
        clearGesture();
        return;
      }
    }

    if (!activeDraft || !activeDraft.valid) {
      setToast({ message: "That spot is not available. The calendar stayed unchanged." });
      clearGesture();
      return;
    }

    if (activeDraft.mode === "block") {
      if (!requireLiveDatabase("create blocks")) {
        clearGesture();
        return;
      }
      const previous = items;
      const newBlock: CalendarItem = {
        id: `block-${Date.now()}`,
        kind: "block",
        week: activeDraft.week,
        day: activeDraft.day,
        start: activeDraft.start,
        duration: activeDraft.duration,
        title: "Busy",
        note: "Blocked from calendar drag",
      };
      setItems([...items, newBlock]);
      closeCalendarDetails();
      setToast({
        message: `Blocked ${weekDays[activeDraft.day].short}, ${formatRange(activeDraft.start, activeDraft.duration)}.`,
        undo: () => {
          setItems(previous);
          closeCalendarDetails();
        },
      });
      clearGesture();
      return;
    }

    if (activeDraft.mode === "place" && session.mode === "place") {
      const service = services.find((candidate) => candidate.id === session.booking.serviceId);
      if (!service) {
        clearGesture();
        return;
      }
      const item: CalendarItem = {
        id: `appt-${Date.now()}`,
        kind: "appointment",
        week: activeDraft.week,
        day: activeDraft.day,
        start: activeDraft.start,
        duration: activeDraft.duration,
        title: session.booking.title,
        client: session.booking.client,
        serviceId: session.booking.serviceId,
        phone: session.booking.phone,
        email: session.booking.email,
        note: session.booking.note ?? "Placed from dock.",
      };
      setItems(carveBusyBlocksForAppointment([...items, item], itemSlot(item)));
      setDockBookings(dockBookings.filter((booking) => booking.id !== session.booking.id));
      setActiveDockBookingId((current) => (current === session.booking.id ? "" : current));
      closeCalendarDetails();
      setToast({ message: `Placed ${session.booking.client} on ${weekDays[item.day].short} at ${formatTime(item.start)}.` });
      clearGesture();
      return;
    }

    if (activeDraft.mode !== "move" && activeDraft.mode !== "resize") {
      clearGesture();
      return;
    }

    const movedItem = items.find((item) => item.id === activeDraft.itemId);
    if (!movedItem) return;

    if (sameSlot(movedItem, activeDraft)) {
      clearGesture();
      return;
    }

    const nextItems = items.map((item) =>
        item.id === activeDraft.itemId
          ? {
              ...item,
              week: activeDraft.week,
              day: activeDraft.day,
              start: activeDraft.start,
              duration: activeDraft.duration,
            }
          : item,
    );
    setItems(movedItem.kind === "appointment" ? carveBusyBlocksForAppointment(nextItems, activeDraft) : nextItems);
    closeCalendarDetails();
    clearGesture();
  }

  function applyQuickClient(client: ClientSummary) {
    setQuickClientSearch(client.name);
    setQuickCreate((current) =>
      current
        ? {
            ...current,
            phone: client.phone || current.phone,
            email: client.email || current.email,
            error: "",
          }
        : current,
    );
    setQuickMatchField("");
  }

  function quickClientMatchButton(field: "name" | "phone" | "email") {
    if (!quickClientSuggestion || !showQuickClientSuggestion || quickMatchField !== field) return null;
    return (
      <button
        className="client-match-prompt quick-field-match"
        onMouseDown={(event) => event.preventDefault()}
        onTouchStart={(event) => event.preventDefault()}
        onClick={() => applyQuickClient(quickClientSuggestion)}
        type="button"
      >
        <User size={15} />
        <span>
          <strong>{quickClientSuggestion.name}</strong>
          <em>{[quickClientSuggestion.phone, quickClientSuggestion.email].filter(Boolean).join(" · ")}</em>
        </span>
      </button>
    );
  }

  function applyBookingClient(client: ClientSummary) {
    const { firstName, lastName } = splitClientName(client.name);
    setBookingForm({
      firstName,
      lastName,
      phone: client.phone,
      email: client.email,
    });
  }

  function updateQuickCreateField(field: "phone" | "email" | "note", value: string) {
    setQuickCreate((current) => (current ? { ...current, [field]: value, error: "" } : current));
  }

  function selectQuickService(serviceId: string) {
    if (!quickCreate) return;
    const service = appointmentServices.find((candidate) => candidate.id === serviceId);
    if (!service) return;
    const candidate = {
      week: quickCreate.week,
      day: quickCreate.day,
      start: quickCreate.start,
      duration: service.duration,
    };
    setQuickCreate((current) =>
      current
        ? {
            ...current,
            serviceId,
            error: quickCreateAvailabilityError(candidate, service),
          }
        : current,
    );
    setQuickMatchField("name");
  }

  function backToQuickServiceChoice() {
    setQuickCreate((current) =>
      current ? { ...current, serviceId: "", phone: "", email: "", note: "", error: "" } : current,
    );
  }

  function confirmQuickAppointment() {
    if (!quickCreate || !quickCreateService) return;
    if (!requireLiveDatabase("create appointments")) return;
    const typedClientName = quickClientSearch.trim();
    const clientName = typedClientName;
    if (!clientName) {
      setQuickCreate((current) => (current ? { ...current, error: "Add a client name." } : current));
      return;
    }
    const candidate = {
      week: quickCreate.week,
      day: quickCreate.day,
      start: quickCreate.start,
      duration: quickCreateService.duration,
    };
    if (!isValidAppointmentSlot(candidate, undefined, quickCreateService)) {
      setQuickCreate((current) =>
        current ? { ...current, error: quickCreateAvailabilityError(candidate, quickCreateService) } : current,
      );
      return;
    }
    const item: CalendarItem = {
      id: `appt-${Date.now()}`,
      kind: "appointment",
      title: clientName,
      client: clientName,
      serviceId: quickCreateService.id,
      ...candidate,
      phone: quickCreate.phone.trim(),
      email: quickCreate.email.trim(),
      note: quickCreate.note.trim(),
    };
    setItems(carveBusyBlocksForAppointment([...items, item], itemSlot(item)));
    if (
      !selectedGroupSession ||
      selectedGroupSession.serviceId !== quickCreateService.id ||
      selectedGroupSession.week !== quickCreate.week ||
      selectedGroupSession.day !== quickCreate.day ||
      selectedGroupSession.start !== quickCreate.start
    ) {
      setSelectedId("");
    }
    setQuickCreate(null);
    setQuickClientSearch("");
  }

  function createBlockFromQuick() {
    if (!quickCreate) return;
    if (!requireLiveDatabase("create blocks")) return;
    const candidate = { week: activeWeek, day: quickCreate.day, start: quickCreate.start, duration: 30 };
    if (!isValidBlockSlot(candidate)) {
      setToast({ message: "That block would overlap with another calendar item." });
      return;
    }
    const previous = items;
    const item: CalendarItem = {
      id: `block-${Date.now()}`,
      kind: "block",
      title: "Busy",
      ...candidate,
      note: "Quick block",
    };
    setItems([...items, item]);
    closeCalendarDetails();
    setQuickCreate(null);
    setToast({
      message: `Blocked ${weekDays[item.day].short}, ${formatRange(item.start, item.duration)}.`,
      undo: () => setItems(previous),
    });
  }

  function createAppointmentInsideSelectedBlock(serviceId: string) {
    if (!selected || selected.kind !== "block") return;
    const service = appointmentServices.find((candidate) => candidate.id === serviceId);
    if (!service) return;
    const candidate = { week: itemWeek(selected), day: selected.day, start: selected.start, duration: service.duration };
    if (!isValidAppointmentSlot(candidate, undefined, service)) {
      setToast({ message: "That lesson would overlap another appointment." });
      return;
    }
    const previous = items;
    const item: CalendarItem = {
      id: `appt-${Date.now()}`,
      kind: "appointment",
      title: "New client",
      client: "New client",
      serviceId,
      ...candidate,
      phone: "",
      email: "",
      note: "Admin-created inside blocked time.",
    };
    setItems(carveBusyBlocksForAppointment([...items, item], itemSlot(item)));
    closeCalendarDetails();
    setToast({
      message: `Added ${service.name} inside blocked time at ${formatTime(item.start)}.`,
      undo: () => setItems(previous),
    });
  }

  function bookNextFromSelected() {
    if (!selected || selected.kind !== "appointment" || !selected.serviceId) return;
    const service = selectedService;
    if (!service) return;
    const booking: PendingBooking = {
      id: `dock-${Date.now()}`,
      client: selected.client ?? selected.title,
      title: selected.title,
      serviceId: service.id,
      duration: service.duration,
      phone: selected.phone,
      email: selected.email,
      note: `Follow-up ${service.name}`,
    };
    closeCalendarDetails();
    setQuickCreate(null);
    setFlyingBooking(booking);
    window.setTimeout(() => {
      setDockBookings((current) => [...current, booking]);
      setActiveDockBookingId(booking.id);
      setFlyingBooking(null);
      setToast({ message: `${booking.client}'s next ${service.name} is waiting on the dock.` });
    }, 620);
  }

  function beginDockPlacement(event: ReactPointerEvent<HTMLElement>, booking: PendingBooking) {
    event.preventDefault();
    event.stopPropagation();
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    pointerClientRef.current = { x: event.clientX, y: event.clientY };
    resetPointerTrail(event.clientX, event.clientY);
    pointerKindRef.current = event.pointerType || "mouse";
    dragPreviewMetaRef.current = null;
    setFloatingDrag(null);
    setActiveDockBookingId(booking.id);
    setMovedState(false);
    closeCalendarDetails();
    setQuickCreate(null);
    setPointerSessionState({ mode: "place", booking });
    event.currentTarget.setPointerCapture(event.pointerId);
    attachGestureListeners();
  }

  function placeDockBookingAtCandidate(
    booking: PendingBooking,
    candidate: SlotCandidate,
    options: { animateFromDock?: boolean } = {},
  ) {
    setQuickCreate(null);
    const service = services.find((serviceCandidate) => serviceCandidate.id === booking.serviceId);
    if (!service) {
      setToast({ message: "That parked lesson type is no longer available." });
      return false;
    }
    if (!isValidAppointmentSlot(candidate, undefined, service)) {
      setToast({ message: "That spot is not available. The lesson is still on the shelf." });
      return false;
    }

    const item: CalendarItem = {
      id: `appt-${Date.now()}`,
      kind: "appointment",
      week: candidate.week,
      day: candidate.day,
      start: candidate.start,
      duration: candidate.duration,
      title: booking.title,
      client: booking.client,
      serviceId: booking.serviceId,
      phone: booking.phone,
      email: booking.email,
      note: booking.note ?? "Placed from dock.",
    };
    const animation = options.animateFromDock ? buildDockPlacementAnimation(booking.id, item.id, candidate) : null;

    setItems(carveBusyBlocksForAppointment([...items, item], itemSlot(item)));
    setDockBookings(dockBookings.filter((dockBooking) => dockBooking.id !== booking.id));
    setActiveDockBookingId("");
    closeCalendarDetails();
    setQuickCreate(null);
    if (animation) {
      setPlacementAnimation(animation);
      window.setTimeout(() => {
        setPlacementAnimation((current) => (current?.itemId === item.id ? null : current));
      }, 620);
    }
    setToast({ message: `Placed ${booking.client} on ${weekDays[item.day].short} at ${formatTime(item.start)}.` });
    return true;
  }

  function removeDockBooking(bookingId: string) {
    const booking = dockBookings.find((candidate) => candidate.id === bookingId);
    setDockBookings((current) => current.filter((candidate) => candidate.id !== bookingId));
    setActiveDockBookingId((current) => (current === bookingId ? "" : current));
    if (booking) setToast({ message: `${booking.client}'s parked lesson was removed.` });
  }

  function quickCreatePopoverStyle(): CSSProperties {
    if (!quickCreate) return {};
    const viewport = window.visualViewport;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const margin = 12;
    const compact = viewportWidth <= 680;
    const availableWidth = Math.max(280, viewportWidth - margin * 2);
    const availableHeight = Math.max(280, viewportHeight - margin * 2);
    const popoverWidth = Math.min(compact ? availableWidth : 340, availableWidth);
    const estimatedHeight = quickCreateService ? (compact ? 620 : 560) : 360;
    const usableHeight = Math.min(estimatedHeight, availableHeight);
    const left = compact
      ? margin
      : clamp(quickCreate.x + 10, margin, Math.max(margin, viewportWidth - popoverWidth - margin));
    const top = clamp(quickCreate.y + 10, margin, Math.max(margin, viewportHeight - usableHeight - margin));

    return {
      left,
      top,
      width: popoverWidth,
      maxHeight: availableHeight,
      zIndex: selectedGroupSession ? 120 : undefined,
    };
  }

  function moveWeek(delta: number) {
    setActiveWeekState(activeWeekRef.current + delta);
  }

  function switchView(view: View) {
    if (isEmbedMode && view !== "booking") return;
    setActiveView(view);
    setQuickCreate(null);
    if (view === "settings") setSettingsTab("none");
    if (view === "billing") setBillingSection("none");
    if (view !== "calendar") closeCalendarDetails();
  }

  function openInvoiceCoachSettings() {
    setActiveView("settings");
    setSettingsTab("account");
    setBillingSection("none");
    closeCalendarDetails();
    setQuickCreate(null);
  }

  function updateBookingForm(field: keyof BookingForm, value: string) {
    setBookingConfirmation(null);
    setBookingForm((current) => ({ ...current, [field]: value }));
  }

  function updateRescheduleForm(field: keyof RescheduleForm, value: string) {
    setBookingConfirmation(null);
    setRescheduleForm((current) => ({ ...current, [field]: value }));
  }

  function changeBookingMode(nextMode: BookingMode, showLogin = false) {
    setBookingMode(nextMode);
    setBookingConfirmation(null);
    setBookingStart(null);
    setBookingDaySelected(nextMode === "book" ? false : bookingDaySelected);
    setOpenPublicBookingSection("appointment");
    setForceRescheduleLogin(nextMode === "reschedule" && showLogin);
    if (nextMode === "book") {
      setSelectedRescheduleId("");
    } else if (!rescheduleMatches.length && rescheduleForm.email.trim() && rescheduleForm.phone.trim()) {
      window.setTimeout(() => {
        void lookupPublicReschedule(true);
      }, 0);
    }
  }

  function selectRescheduleMatch(match: PublicRescheduleMatch) {
    setSelectedRescheduleId(match.id);
    setBookingServiceId(match.serviceId);
    setActiveWeekState(match.week);
    setBookingDay(match.day);
    setBookingDaySelected(true);
    setOpenPublicBookingSection("datetime");
    setBookingStart(null);
  }

  function setPublicBookingSection(section: PublicBookingSection) {
    setOpenPublicBookingSection(section);
  }

  function handlePublicBookingServiceSelect(serviceId: string) {
    const isCurrent = serviceId === bookingServiceId;
    setBookingServiceId(isCurrent ? "" : serviceId);
    setBookingDaySelected(false);
    setBookingStart(null);
    setOpenPublicBookingSection(isCurrent ? "appointment" : "datetime");
  }

  const isGroupBookingTimeSelection = bookingMode === "book" && bookingTargetService?.lessonFormat === "group";

  function handlePublicBookingDaySelect(dayIndex: number) {
    setBookingDay(dayIndex);
    setBookingDaySelected(true);
    setBookingStart(null);
    setOpenPublicBookingSection("datetime");
  }

  function handlePublicBookingTimeSelect(slot: BookingSlot) {
    const next = bookingStart === slot.start ? null : slot.start;
    if (bookingTargetService?.lessonFormat === "group") {
      setBookingDay(slot.day);
      setBookingDaySelected(next !== null);
    }
    setBookingStart(next);
    setOpenPublicBookingSection(next === null ? "datetime" : "information");
  }

  function describeRescheduleMatch(match: PublicRescheduleMatch) {
    const days = buildWeekDays(match.week);
    return `${days[match.day]?.label ?? fullDayNames[match.day]}, ${formatTime(match.start)}`;
  }

  function googleCalendarUrl(confirmation: BookingConfirmation) {
    const date = dateForSlot(confirmation.week, confirmation.day);
    const start = compactDateTime(date, confirmation.start);
    const end = compactDateTime(date, confirmation.start + confirmation.duration);
    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: `${confirmation.service} with ${coachAccount.businessName}`,
      dates: `${start}/${end}`,
      location: coachAccount.venueName,
      details: `${confirmation.service} for ${confirmation.client}.`,
      ctz: coachAccount.timezone,
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  function downloadAppleCalendarInvite(confirmation: BookingConfirmation) {
    const date = dateForSlot(confirmation.week, confirmation.day);
    const start = compactDateTime(date, confirmation.start);
    const end = compactDateTime(date, confirmation.start + confirmation.duration);
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Clarity Golf//Booking Confirmation//EN",
      "BEGIN:VEVENT",
      `UID:${Date.now()}@clarity-golf-booking`,
      `DTSTAMP:${compactDateTime(new Date(), new Date().getHours() * 60 + new Date().getMinutes())}`,
      `DTSTART;TZID=${coachAccount.timezone}:${start}`,
      `DTEND;TZID=${coachAccount.timezone}:${end}`,
      `SUMMARY:${escapeIcsText(`${confirmation.service} with ${coachAccount.businessName}`)}`,
      `LOCATION:${escapeIcsText(coachAccount.venueName)}`,
      `DESCRIPTION:${escapeIcsText(`${confirmation.service} for ${confirmation.client}.`)}`,
      "STATUS:CONFIRMED",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const blob = new Blob([`${ics}\r\n`], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "clarity-golf-booking.ics";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function lookupPublicReschedule(silent = false, credentials: RescheduleLookupCredentials = rescheduleForm) {
    const lookupCredentials = {
      email: credentials.email.trim(),
      phone: credentials.phone.trim(),
      appointmentId: credentials.appointmentId,
    };
    if (!lookupCredentials.email || !lookupCredentials.phone) {
      if (!silent) setToast({ message: "Enter the email and phone number used on the booking." });
      return;
    }
    setRescheduleState("checking");
    setSelectedRescheduleId("");
    setBookingStart(null);
    try {
      const response = await fetch("/api/public-reschedule-lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: lookupCredentials.email, phone: lookupCredentials.phone }),
      });
      const data = (await response.json()) as { matches?: PublicRescheduleMatch[]; message?: string };
      if (!response.ok) {
        if (!silent) setToast({ message: data.message || "Could not find that booking." });
        setRescheduleMatches([]);
        return;
      }
      const matches = Array.isArray(data.matches) ? data.matches : [];
      setRescheduleMatches(matches);
      const preferredId = lookupCredentials.appointmentId || initialRescheduleLoginRef.current?.appointmentId || selectedRescheduleId;
      const preferredMatch = preferredId ? matches.find((match) => match.id === preferredId) : null;
      if (preferredMatch) {
        selectRescheduleMatch(preferredMatch);
      } else if (matches.length === 1) {
        selectRescheduleMatch(matches[0]);
      }
      if (!matches.length && !silent) setToast({ message: "No booking matched those details." });
      if (matches.length) {
        const nextSaved: SavedRescheduleLogin = {
          email: lookupCredentials.email,
          phone: lookupCredentials.phone,
          appointmentId: preferredMatch?.id || matches[0]?.id,
        };
        window.localStorage.setItem(RESCHEDULE_LOGIN_STORAGE_KEY, JSON.stringify(nextSaved));
      }
    } catch {
      if (!silent) setToast({ message: "Could not reach the booking server." });
    } finally {
      setRescheduleState("idle");
    }
  }

  async function confirmPublicReschedule() {
    if (!selectedRescheduleMatch || !bookingTargetService || bookingStart === null) {
      setToast({ message: "Choose the booking and the new time." });
      return;
    }

    setRescheduleState("saving");
    try {
      const response = await fetch("/api/public-reschedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appointmentId: selectedRescheduleMatch.id,
          email: rescheduleForm.email,
          phone: rescheduleForm.phone,
          week: activeWeek,
          day: bookingDay,
          start: bookingStart,
        }),
      });
      const data = (await response.json()) as {
        state?: { items?: CalendarItem[] };
        message?: string;
        notifications?: EmailSendResult[];
      };
      if (!response.ok) {
        setToast({ message: data.message || "That time is no longer available." });
        if (data.state?.items) setItems(data.state.items);
        setBookingStart(null);
        return;
      }

      if (data.state?.items) setItems(data.state.items);
      setBookingConfirmation({
        kind: "reschedule",
        appointmentId: selectedRescheduleMatch.id,
        client: selectedRescheduleMatch.client,
        service: selectedRescheduleMatch.serviceName,
        week: activeWeek,
        day: bookingDay,
        start: bookingStart,
        duration: selectedRescheduleMatch.duration,
        dayLabel: weekDays[bookingDay].label,
        timeLabel: formatTime(bookingStart),
        email: rescheduleForm.email,
        phone: rescheduleForm.phone,
        notifications: data.notifications ?? [],
      });
      setRescheduleMatches([]);
      setSelectedRescheduleId("");
      setBookingStart(null);
    } catch {
      setToast({ message: "Could not complete the reschedule. Please try again." });
    } finally {
      setRescheduleState("idle");
    }
  }

  async function confirmPublicCancellation() {
    if (!selectedRescheduleMatch) {
      setToast({ message: "Choose the booking to cancel." });
      return;
    }
    const confirmed = window.confirm(
      `Cancel ${selectedRescheduleMatch.serviceName} for ${selectedRescheduleMatch.client}?`,
    );
    if (!confirmed) return;

    setRescheduleState("saving");
    try {
      const response = await fetch("/api/public-cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appointmentId: selectedRescheduleMatch.id,
          email: rescheduleForm.email,
          phone: rescheduleForm.phone,
        }),
      });
      const data = (await response.json()) as {
        state?: { items?: CalendarItem[] };
        message?: string;
        notifications?: EmailSendResult[];
      };
      if (!response.ok) {
        setToast({ message: data.message || "Could not cancel that booking." });
        return;
      }

      const original = selectedRescheduleMatch;
      if (data.state?.items) {
        setItems(data.state.items);
      } else {
        setItems((current) => current.filter((item) => item.id !== original.id));
      }
      const confirmationNotifications = data.notifications ?? [];
      const originalWeekDays = buildWeekDays(original.week);
      setBookingConfirmation({
        kind: "cancelled",
        appointmentId: original.id,
        client: original.client,
        service: original.serviceName,
        week: original.week,
        day: original.day,
        start: original.start,
        duration: original.duration,
        dayLabel: originalWeekDays[original.day]?.label ?? fullDayNames[original.day],
        timeLabel: formatTime(original.start),
        email: rescheduleForm.email,
        phone: rescheduleForm.phone,
        notifications: confirmationNotifications,
      });
      setEmailNoticeVisible(
        confirmationNotifications.some((result) => result.channel === "client" && result.sent),
      );
      setRescheduleMatches([]);
      setSelectedRescheduleId("");
      setBookingStart(null);
    } catch {
      setToast({ message: "Could not cancel that booking. Please try again." });
    } finally {
      setRescheduleState("idle");
    }
  }

  function handleBookingMatchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") event.currentTarget.blur();
  }

  function insertNotificationSubjectToken(token: string) {
    const next = `${notificationSettings.notificationSubjectLine ?? ""} ${token}`.trim().slice(0, 180);
    updateNotificationSetting("notificationSubjectLine", next);
  }

  function updateBookingNoticeHours(hours: number) {
    updateNotificationSetting("minBookingNoticeMinutes", cleanMinBookingNoticeMinutes(hours * 60));
  }

  function updateNotificationSetting<K extends keyof NotificationSettings>(field: K, value: NotificationSettings[K]) {
    setSettingsSaveState("idle");
    setNotificationSettings((current) => ({ ...current, [field]: value }));
  }

  function updateBrandSetting<K extends keyof BrandSettings>(field: K, value: BrandSettings[K]) {
    setBrandSaveState("idle");
    setBrandSettings((current) => cleanBrandSettings({ ...current, [field]: value }));
  }

  function updateCoachAccount<K extends keyof CoachAccount>(field: K, value: CoachAccount[K]) {
    setCoachAccountSaveState("idle");
    setCoachAccount((current) => cleanCoachAccount({ ...current, [field]: value }));
  }

  function updateInvoiceSettings<K extends keyof InvoiceSettings>(field: K, value: InvoiceSettings[K]) {
    setCoachAccountSaveState("idle");
    setCoachAccount((current) =>
      cleanCoachAccount({
        ...current,
        invoiceSettings: {
          ...current.invoiceSettings,
          [field]: value,
        },
      }),
    );
  }

  function updateInvoiceCustomField<K extends keyof InvoiceCustomField>(id: string, field: K, value: InvoiceCustomField[K]) {
    setCoachAccountSaveState("idle");
    setCoachAccount((current) =>
      cleanCoachAccount({
        ...current,
        invoiceSettings: {
          ...current.invoiceSettings,
          customFields: current.invoiceSettings.customFields.map((customField) =>
            customField.id === id ? { ...customField, [field]: value } : customField,
          ),
        },
      }),
    );
  }

  function addInvoiceCustomField() {
    setCoachAccountSaveState("idle");
    setCoachAccount((current) =>
      cleanCoachAccount({
        ...current,
        invoiceSettings: {
          ...current.invoiceSettings,
          customFields: [
            ...current.invoiceSettings.customFields,
            { id: `field-${Date.now()}`, label: "Reference", value: "", placement: "header" },
          ],
        },
      }),
    );
  }

  function removeInvoiceCustomField(id: string) {
    setCoachAccountSaveState("idle");
    setCoachAccount((current) =>
      cleanCoachAccount({
        ...current,
        invoiceSettings: {
          ...current.invoiceSettings,
          customFields: current.invoiceSettings.customFields.filter((field) => field.id !== id),
        },
      }),
    );
  }

  function updateServiceEditor<K extends keyof ServiceEditor>(field: K, value: ServiceEditor[K]) {
    setServiceSaveState("idle");
    setServiceEditor((current) => {
      const next = { ...current, [field]: value };
      if (next.lessonFormat === "package") {
        return {
          ...next,
          visibility: "private",
          groupSchedule: undefined,
          capacity: 1,
          minParticipants: 1,
          priceMode: "session",
          packageAllowance: clamp(Math.round(Number(next.packageAllowance) || 5), 1, 100),
          packageCoverageMode: next.packageCoverageMode === "lesson-by-lesson" ? "lesson-by-lesson" : "upfront",
        };
      }
      if (next.lessonFormat === "group") {
        const capacity = clamp(Math.round(Number(next.capacity) || 2), 2, 24);
        return {
          ...next,
          groupSchedule: cleanGroupSchedule(next.groupSchedule, defaultGroupSchedule()),
          capacity,
          minParticipants: clamp(Math.round(Number(next.minParticipants) || 2), 2, capacity),
        };
      }
      return {
        ...next,
        groupSchedule: undefined,
        capacity: clamp(Math.round(Number(next.capacity) || 1), 1, 24),
        minParticipants: 1,
        priceMode: "session",
      };
    });
  }

  function updateBookingScreens(screenId: string, checked: boolean) {
    setServiceSaveState("idle");
    setServiceEditor((current) => {
      const currentScreens = Array.isArray(current.bookingScreenIds) ? current.bookingScreenIds : ["main"];
      const nextScreens = checked
        ? Array.from(new Set([...currentScreens, screenId]))
        : currentScreens.filter((candidate) => candidate !== screenId);
      if (current.visibility === "public" && nextScreens.length === 0) {
        setToast({ message: "Public lesson types need at least one booking screen." });
        return current;
      }
      return { ...current, bookingScreenIds: nextScreens };
    });
  }

  function normalizeGroupDraftInputs(editor: ServiceEditor) {
    if (editor.lessonFormat !== "group") {
      return editor;
    }

    const schedule = editor.groupSchedule ?? defaultGroupSchedule();
    const occurrenceCount = clamp(
      Math.round(parseDraftNumber(groupOccurrenceInput) ?? schedule.occurrenceCount),
      1,
      MAX_GROUP_OCCURRENCE_COUNT,
    );
    const capacity = clamp(Math.round(parseDraftNumber(groupMaximumInput) ?? editor.capacity), 2, 24);
    const minParticipants = clamp(Math.round(parseDraftNumber(groupMinimumInput) ?? editor.minParticipants), 2, capacity);

    return {
      ...editor,
      capacity,
      minParticipants,
      groupSchedule: cleanGroupSchedule({ ...schedule, occurrenceCount }, defaultGroupSchedule()),
    };
  }

  function applyGroupDraftInputs() {
    if (serviceEditor.lessonFormat !== "group") return serviceEditor;
    const next = normalizeGroupDraftInputs(serviceEditor);
    setServiceEditor(next);
    const nextSchedule = next.groupSchedule ?? defaultGroupSchedule();
    setGroupOccurrenceInput(String(nextSchedule.occurrenceCount));
    setGroupMaximumInput(String(next.capacity));
    setGroupMinimumInput(String(next.minParticipants));
    return next;
  }

  function updateGroupSchedule<K extends keyof GroupServiceSchedule>(field: K, value: GroupServiceSchedule[K]) {
    setServiceSaveState("idle");
    setServiceEditor((current) => ({
      ...current,
      groupSchedule: cleanGroupSchedule(
        {
          ...(current.groupSchedule ?? {}),
          [field]: value,
        },
        defaultGroupSchedule(),
      ),
    }));
  }

  function editService(service: Service) {
    setEditingServiceId(service.id);
    setServiceEditor({
      ...service,
      bookingScreenIds: service.bookingScreenIds ?? ["main"],
    });
    setShowServiceEditor(true);
    setServiceSaveState("idle");
  }

  function startNewService() {
    setEditingServiceId(null);
    setServiceEditor({
      ...emptyServiceEditor(),
      id: generateServiceDraftId(),
      location: coachAccount.venueShortName,
    });
    setShowServiceEditor(true);
    setServiceSaveState("idle");
  }

  function updateAppointmentStatus(itemId: string, status: BookingStatus) {
    const previous = items;
    setItems((current) =>
      current.map((item) => (item.id === itemId && item.kind === "appointment" ? { ...item, status } : item)),
    );
    setToast({
      message: `Lesson marked ${status.replace("_", "-")}.`,
      undo: () => setItems(previous),
    });
  }

  function cancelGroupSessionAttendee(itemId: string) {
    if (!window.confirm("Cancel this attendee from the group session?")) return;
    const appointment = items.find((item) => item.id === itemId && item.kind === "appointment");
    if (!appointment) {
      setToast({ message: "Could not find that attendee." });
      return;
    }
    updateAppointmentStatus(appointment.id, "cancelled");
  }

  function markInvoiceDraftDirty() {
    if (confirmedInvoiceNumber && sentInvoiceNumber === confirmedInvoiceNumber) {
      const voidedNumber = confirmedInvoiceNumber;
      setVoidedInvoiceNumbers((current) => (current.includes(voidedNumber) ? current : [...current, voidedNumber]));
      setSentInvoiceNumber("");
      setConfirmedInvoiceNumber("");
      setToast({ message: `${voidedNumber} voided. Edits will use ${invoiceNumber}.` });
    }
  }

  function updateInvoiceDraft<K extends keyof InvoiceDraft>(field: K, value: InvoiceDraft[K]) {
    if (field !== "lineSearch") markInvoiceDraftDirty();
    setInvoiceDraft((current) => ({ ...current, [field]: value }));
  }

  function selectInvoiceCustomer(customer: Pick<Person, "name" | "email" | "phone">) {
    markInvoiceDraftDirty();
    setInvoiceDraft((current) => ({
      ...current,
      payerName: customer.name,
      payerEmail: customer.email,
      payerPhone: customer.phone || "",
    }));
    setInvoiceCustomerSearch("");
  }

  function createInvoiceCustomerFromSearch() {
    const value = invoiceCustomerSearch.trim();
    if (!value) {
      setToast({ message: "Search or type a customer name first." });
      return;
    }
    const isEmail = value.includes("@");
    selectInvoiceCustomer({
      name: isEmail ? value.split("@")[0] : value,
      email: isEmail ? value : "",
      phone: "",
    });
  }

  function clearInvoiceCustomer() {
    markInvoiceDraftDirty();
    setInvoiceCustomerSearch(invoiceDraft.payerName || invoiceDraft.payerEmail);
    setInvoiceDraft((current) => ({
      ...current,
      payerName: "",
      payerEmail: "",
      payerPhone: "",
    }));
  }

  function updateInvoiceLine(id: string, field: keyof InvoiceLine, value: string | number) {
    markInvoiceDraftDirty();
    setInvoiceDraft((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.id === id ? { ...line, [field]: value } : line)),
    }));
  }

  function addManualInvoiceLine() {
    markInvoiceDraftDirty();
    setInvoiceDraft((current) => ({
      ...current,
      lines: [
        ...current.lines,
        {
          id: `line-${Date.now()}`,
          source: "manual",
          description: current.lineSearch.trim(),
          quantity: 1,
          unitPrice: 0,
          taxRate: invoiceSettings.taxRate,
        },
      ],
      lineSearch: "",
    }));
    setShowInvoiceLinePicker(false);
  }

  function removeInvoiceLine(id: string) {
    markInvoiceDraftDirty();
    setInvoiceDraft((current) => ({
      ...current,
      lines: current.lines.filter((line) => line.id !== id),
    }));
  }

  function addCatalogInvoiceLine(item: BillingCatalogItem) {
    markInvoiceDraftDirty();
    setInvoiceDraft((current) => ({
      ...current,
      lineSearch: "",
      lines: [
        ...current.lines.filter((line) => line.description.trim() || line.unitPrice > 0),
        {
          id: `line-${Date.now()}`,
          source: item.kind === "package" ? "package_sale" : "catalog",
          sourceId: item.sourceServiceId || item.id,
          description: item.name,
          quantity: 1,
          unitPrice: item.price,
          taxRate: item.taxRate,
        },
      ],
    }));
    setShowInvoiceLinePicker(false);
  }

  function addCompletedBookingLine(item: CalendarItem) {
    const service = itemService(item, services);
    markInvoiceDraftDirty();
    setInvoiceCustomerSearch("");
    setInvoiceDraft((current) => ({
      ...current,
      payerName: current.payerName || item.client || item.title,
      payerEmail: current.payerEmail || item.email || "",
      payerPhone: current.payerPhone || item.phone || "",
      lines: [
        ...current.lines.filter((line) => line.description.trim() || line.unitPrice > 0),
        {
          id: `line-${Date.now()}`,
          source: "booking_snapshot",
          sourceId: item.id,
          description: `${service?.name ?? item.title} - ${item.client || item.title}`,
          quantity: 1,
          unitPrice: service?.price ?? 0,
          taxRate: invoiceSettings.taxRate,
        },
      ],
    }));
    setShowInvoiceLinePicker(false);
    setBillingSection("new-invoice");
  }

  function addCatalogItem() {
    const name = catalogEditor.name.trim();
    if (!name) {
      setToast({ message: "Name the product or service before adding it." });
      return;
    }
    const item: BillingCatalogItem = {
      ...catalogEditor,
      id: catalogEditor.id || `catalog-${Date.now()}`,
      name,
      description: catalogEditor.description.trim(),
      price: Math.max(0, Math.round(Number(catalogEditor.price) || 0)),
      taxRate: clamp(Number(catalogEditor.taxRate) || 0, 0, 30),
    };
    setCatalogItems((current) =>
      current.some((candidate) => candidate.id === item.id)
        ? current.map((candidate) => (candidate.id === item.id ? item : candidate))
        : [...current, item],
    );
    setCatalogEditor({ id: "", kind: "service", name: "", description: "", price: 0, taxRate: invoiceSettings.taxRate });
    setToast({ message: `${item.name} added to invoice products and services.` });
  }

  function resetInvoiceDraft() {
    setInvoiceDraft(emptyInvoiceDraft(invoiceSettings));
    setInvoiceCustomerSearch("");
    setShowInvoiceLinePicker(false);
    setConfirmedInvoiceNumber("");
    setSentInvoiceNumber("");
  }

  function issueInvoiceDraft() {
    if (!invoiceDraft.payerName.trim()) {
      setToast({ message: "Choose or enter a payer before issuing." });
      return;
    }
    if (!invoiceDraft.lines.some((line) => line.description.trim() && Number(line.unitPrice) > 0)) {
      setToast({ message: "Add at least one invoice line before issuing." });
      return;
    }
    const issuedNumber = invoiceNumber;
    setConfirmedInvoiceNumber(issuedNumber);
    setSentInvoiceNumber("");
    updateInvoiceSettings("nextNumber", invoiceSettings.nextNumber + 1);
    setToast({ message: `${issuedNumber} confirmed. Delivery actions are ready.` });
  }

  function markConfirmedInvoiceSent() {
    if (!confirmedInvoiceNumber) return;
    setSentInvoiceNumber(confirmedInvoiceNumber);
    setToast({ message: `${confirmedInvoiceNumber} marked sent.` });
  }

  async function persistServices(
    nextServices: Service[],
    message = "Lesson types saved.",
    requiredServiceId?: string,
  ) {
    const payloadServices = nextServices.map((service) => ({ ...service }));
    const snapshot = services;
    setServiceSaveState("saving");
    try {
      const response = await fetch("/api/calendar-state", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          items: items,
          services: payloadServices,
          syncKey: calendarSyncKey,
          updatedAt: calendarStateVersion,
        }),
      });
      if (response.status === 401) {
        setAuthStatus("guest");
        throw new Error("Admin login required");
      }
      const data = (await response.json().catch(() => null)) as {
        services?: Service[];
        message?: string;
        error?: string;
        notifications?: NotificationRecord[];
        warnings?: string[];
        updatedAt?: string;
      };
      if (!response.ok) {
        const detail = data?.message || data?.error;
        throw new Error(detail || `Services save failed (${response.status} ${response.statusText})`);
      }
      if (!Array.isArray(data?.services)) {
        throw new Error("Services save response did not return services.");
      }
      const persistedServices = cleanServices(data.services);
      const expectedServiceId = requiredServiceId || payloadServices.at(-1)?.id;
      const persistedServiceIds = new Set(persistedServices.map((service) => service.id));
      if (expectedServiceId && !persistedServiceIds.has(expectedServiceId)) {
        throw new Error("Service did not persist. Reload and try again.");
      }
      setServices(persistedServices);
      if (typeof data.updatedAt === "string") setCalendarStateVersion(data.updatedAt);
      if (Array.isArray(data.notifications)) setNotifications(cleanNotificationRecords(data.notifications));
      if (Array.isArray(data.warnings) && data.warnings.length) {
        const warning = data.warnings.find((candidate) => typeof candidate === "string" && candidate.trim()) ?? "";
        if (warning) setToast({ message: warning });
      }
      setServiceSaveState("saved");
      setToast({ message });
      window.setTimeout(() => setServiceSaveState("idle"), 1600);
    } catch (error) {
      setServiceSaveState("error");
      const reason = error instanceof Error ? error.message : "Could not save lesson types.";
      setToast({ message: reason });
      setServices(snapshot);
    }
  }

  function saveEditedService() {
    if (!serviceEditor.name.trim()) {
      setToast({ message: "Give the lesson type a name before saving." });
      return;
    }
    const normalizedEditor = serviceEditor.lessonFormat === "group" ? applyGroupDraftInputs() : serviceEditor;
    const hasPublicScreen = (normalizedEditor.bookingScreenIds ?? []).length > 0;
    if (normalizedEditor.visibility === "public" && !hasPublicScreen) {
      setToast({ message: "Public lesson types must be assigned to at least one booking screen." });
      return;
    }
    const stableServiceId = editingServiceId || normalizedEditor.id || generateServiceDraftId();
    const clean = cleanService(
      {
        ...normalizedEditor,
        id: stableServiceId,
      },
      services.length,
    );
    const exists = services.some((service) => service.id === clean.id);
    const nextServices = exists
      ? services.map((service) => (service.id === clean.id ? clean : service))
      : [...services, clean];
    setEditingServiceId(clean.id);
    setServiceEditor(clean);
    setShowServiceEditor(false);
    void persistServices(
      nextServices,
      exists ? `${clean.name} updated.` : `${clean.name} added.`,
      clean.id,
    );
  }

  function deleteService(service: Service) {
    const hasBookings = items.some((item) => item.serviceId === service.id);
    if (hasBookings) {
      setToast({ message: "This lesson type has existing bookings. Remove or reassign those bookings before deleting it." });
      return;
    }
    if (!window.confirm(`Delete ${service.name}? This cannot be undone.`)) return;

    const packageReferenceCount = services.filter(
      (candidate) => candidate.lessonFormat === "package" && candidate.packageCoversServiceId === service.id,
    ).length;
    const nextServices = services
      .filter((candidate) => candidate.id !== service.id)
      .map((candidate) =>
        candidate.lessonFormat === "package" && candidate.packageCoversServiceId === service.id
          ? { ...candidate, packageCoversServiceId: undefined }
          : candidate,
      );
    if (editingServiceId === service.id) {
      setEditingServiceId(null);
      setShowServiceEditor(false);
      setServiceEditor(emptyServiceEditor());
    }
    if (bookingServiceId === service.id) {
      setBookingServiceId("");
      setBookingDaySelected(false);
      setBookingStart(null);
      setOpenPublicBookingSection("appointment");
    }
    if (selectedRescheduleMatch?.serviceId === service.id) {
      setSelectedRescheduleId("");
    }
    const packageSuffix =
      packageReferenceCount > 0
        ? ` ${packageReferenceCount} package ${packageReferenceCount === 1 ? "reference was" : "references were"} cleared.`
        : "";
    void persistServices(
      nextServices,
      `${service.name} deleted.${packageSuffix}`,
      undefined,
    );
  }

  function updateAvailabilityWindow(day: number, index: number, field: keyof AvailabilityWindow, value: number) {
    setAvailabilitySaveState("idle");
    setAvailability((current) =>
      cleanAvailability(
        current.map((windows, dayIndex) =>
          dayIndex === day
            ? windows.map((window, windowIndex) =>
                windowIndex === index ? { ...window, [field]: value } : window,
              )
            : windows,
        ),
      ),
    );
  }

  function removeAvailabilityWindow(day: number, index: number) {
    setAvailabilitySaveState("idle");
    setEditingAvailabilityWindow((current) => (current === `${day}-${index}` ? "" : current));
    setAvailability((current) =>
      cleanAvailability(
        current.map((windows, dayIndex) =>
          dayIndex === day ? windows.filter((_, windowIndex) => windowIndex !== index) : windows,
        ),
      ),
    );
  }

  function addAvailabilityWindow(day: number) {
    setAvailabilitySaveState("idle");
    const existingWindows = availability[day] ?? [];
    const lastWindow = existingWindows.at(-1);
    const start = lastWindow
      ? Math.min(Math.max(lastWindow.end, timeToMinutes(9, 0)), timeToMinutes(18, 0))
      : timeToMinutes(9, 0);
    const end = Math.min(Math.max(start + 120, start + SNAP_MINUTES), END_HOUR * 60);
    setEditingAvailabilityWindow(`${day}-${existingWindows.length}`);
    setAvailability((current) =>
      cleanAvailability(
        current.map((windows, dayIndex) => (dayIndex === day ? [...windows, { start, end }] : windows)),
      ),
    );
  }

  function toggleAvailabilityDay(day: number) {
    setAvailabilitySaveState("idle");
    setEditingAvailabilityWindow("");
    setAvailability((current) =>
      cleanAvailability(
        current.map((windows, dayIndex) =>
          dayIndex === day
            ? windows.length
              ? []
              : [{ start: timeToMinutes(9, 0), end: timeToMinutes(17, 0) }]
            : windows,
        ),
      ),
    );
  }

  async function saveAvailability() {
    const clean = cleanAvailability(availability);
    setEditingAvailabilityWindow("");
    setAvailability(clean);
    setAvailabilitySaveState("saving");
    try {
      const response = await fetch("/api/availability", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ availability: clean }),
      });
      if (response.status === 401) {
        setAuthStatus("guest");
        throw new Error("Admin login required");
      }
      if (!response.ok) throw new Error("Availability save failed");
      const data = (await response.json()) as { availability?: AvailabilityWindow[][] };
      if (Array.isArray(data.availability)) setAvailability(cleanAvailability(data.availability));
      setAvailabilitySaveState("saved");
      setToast({ message: "Availability saved." });
      window.setTimeout(() => setAvailabilitySaveState("idle"), 1600);
    } catch {
      setAvailabilitySaveState("idle");
      setToast({ message: "Could not save availability." });
    }
  }

  async function saveCoachAccount() {
    const clean = cleanCoachAccount(coachAccount);
    setCoachAccount(clean);
    setCoachAccountSaveState("saving");
    try {
      const response = await fetch("/api/coach-account", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(clean),
      });
      if (response.status === 401) {
        setAuthStatus("guest");
        throw new Error("Admin login required");
      }
      if (!response.ok) throw new Error("Coach account save failed");
      const saved = (await response.json()) as Partial<CoachAccount>;
      applyCoachAccount(saved);
      setCoachAccountSaveState("saved");
      setToast({ message: "Coach account saved." });
      window.setTimeout(() => setCoachAccountSaveState("idle"), 1600);
    } catch {
      setCoachAccountSaveState("idle");
      setToast({ message: "Could not save coach account." });
    }
  }

  async function handleAdminLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError("");
    setLoginState("signing-in");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: adminEmail, password: adminPassword }),
      });
      const data = (await response.json()) as { authenticated?: boolean; message?: string; email?: string };
      if (!response.ok || !data.authenticated) {
        setAuthError(data.message || "Login failed.");
        return;
      }
      if (data.email) setAdminEmail(data.email);
      try {
        await loadAdminCalendarState();
      } catch (error) {
        hasLoadedCalendarApiRef.current = false;
        setAuthStatus("guest");
        setCalendarFeedStatus("offline");
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
        const detail = error instanceof Error && error.message ? ` Details: ${error.message}` : "";
        setAuthError(`Login worked, but the live database is not connected. Nothing will be editable until the database connection is fixed.${detail}`);
        return;
      }
      setAuthStatus("authenticated");
      setAdminPassword("");
      setCalendarFeedStatus("connected");
      setAuthError("");
    } catch {
      hasLoadedCalendarApiRef.current = false;
      setAuthStatus("guest");
      setAuthError("Could not reach the booking server.");
      setCalendarFeedStatus("offline");
    } finally {
      setLoginState("idle");
    }
  }

  async function handleForgotPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError("");
    setForgotMessage("");
    setForgotState("sending");
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotEmail }),
      });
      const data = (await response.json()) as { ok?: boolean; message?: string };
      if (!response.ok || !data.ok) {
        setAuthError(data.message || "Could not send the reset email.");
        setForgotState("idle");
        return;
      }
      setForgotState("sent");
      setForgotMessage(data.message || "If that email matches an admin account, a reset link has been sent.");
    } catch {
      setForgotState("idle");
      setAuthError("Could not reach the booking server.");
    }
  }

  async function handleResetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError("");
    if (!resetToken) {
      setAuthError("This reset link is missing its token.");
      return;
    }
    if (resetPassword.length < 8) {
      setAuthError("Use at least 8 characters.");
      return;
    }
    if (resetPassword !== resetConfirmPassword) {
      setAuthError("Those passwords do not match.");
      return;
    }

    setResetState("saving");
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: resetToken, password: resetPassword }),
      });
      const data = (await response.json()) as { authenticated?: boolean; message?: string; email?: string };
      if (!response.ok || !data.authenticated) {
        setAuthError(data.message || "Could not reset password.");
        setResetState("idle");
        return;
      }
      setAuthStatus("authenticated");
      setResetPassword("");
      setResetConfirmPassword("");
      setResetState("idle");
      if (data.email) setAdminEmail(data.email);
      if (typeof window !== "undefined") window.history.replaceState(null, "", window.location.pathname);
      await loadAdminCalendarState();
      setCalendarFeedStatus("connected");
    } catch {
      setResetState("idle");
      setAuthError("Could not reach the booking server.");
      setCalendarFeedStatus("offline");
    }
  }

  function updatePasswordChangeForm<K extends keyof PasswordChangeForm>(field: K, value: PasswordChangeForm[K]) {
    setPasswordChangeState("idle");
    setPasswordChangeMessage("");
    setPasswordChangeForm((current) => ({ ...current, [field]: value }));
  }

  async function handleChangePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordChangeMessage("");
    if (passwordChangeForm.newPassword.length < 8) {
      setPasswordChangeMessage("Use at least 8 characters.");
      return;
    }
    if (passwordChangeForm.newPassword !== passwordChangeForm.confirmPassword) {
      setPasswordChangeMessage("Those passwords do not match.");
      return;
    }

    setPasswordChangeState("saving");
    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: passwordChangeForm.currentPassword,
          newPassword: passwordChangeForm.newPassword,
        }),
      });
      const data = (await response.json()) as { authenticated?: boolean; message?: string; email?: string };
      if (response.status === 401) {
        setAuthStatus("guest");
        throw new Error(data.message || "Admin login required.");
      }
      if (!response.ok || !data.authenticated) {
        setPasswordChangeState("idle");
        setPasswordChangeMessage(data.message || "Could not change password.");
        return;
      }
      if (data.email) setAdminEmail(data.email);
      setPasswordChangeForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      setPasswordChangeState("saved");
      setPasswordChangeMessage("Password changed.");
    } catch (error) {
      setPasswordChangeState("idle");
      setPasswordChangeMessage(error instanceof Error ? error.message : "Could not reach the booking server.");
    }
  }

  async function handleAdminLogout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    hasLoadedCalendarApiRef.current = false;
    setAuthStatus("guest");
    closeCalendarDetails();
    setCalendarFeedStatus("offline");
    setCalendarSaveStatus("idle");
    setCalendarSaveError("");
  }

  async function saveNotificationSettings() {
    setSettingsSaveState("saving");
    try {
      const response = await fetch("/api/admin-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(notificationSettings),
      });
      if (response.status === 401) {
        setAuthStatus("guest");
        throw new Error("Admin login required");
      }
      if (!response.ok) throw new Error("Settings save failed");
      const settings = (await response.json()) as NotificationSettings;
      applyNotificationSettings(settings);
      setSettingsSaveState("saved");
      setToast({ message: "Notification and text settings saved." });
      window.setTimeout(() => setSettingsSaveState("idle"), 1600);
    } catch {
      setSettingsSaveState("idle");
      setToast({ message: "Could not save notification settings." });
    }
  }

  async function refreshGoogleCalendarStatus() {
    try {
      const response = await fetch("/api/google-calendar/status", { headers: { Accept: "application/json" } });
      if (response.status === 401) {
        setAuthStatus("guest");
        return;
      }
      if (!response.ok) return;
      applyGoogleCalendarStatus((await response.json()) as Partial<GoogleCalendarSyncStatus>);
    } catch {
      // Google Calendar sync is optional; keep the booking calendar usable.
    }
  }

  async function connectGoogleCalendar() {
    setGoogleCalendarAction("connecting");
    try {
      const response = await fetch("/api/google-calendar/connect", {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const data = (await response.json()) as { authUrl?: string; message?: string };
      if (response.status === 401) {
        setAuthStatus("guest");
        throw new Error("Admin login required");
      }
      if (!response.ok || !data.authUrl) throw new Error(data.message || "Google Calendar connection is not ready.");
      window.location.assign(data.authUrl);
    } catch (error) {
      setGoogleCalendarAction("idle");
      setToast({ message: error instanceof Error ? error.message : "Could not start Google Calendar connection." });
    }
  }

  async function saveGoogleCalendarSettings(next?: Partial<GoogleCalendarSyncStatus>) {
    const nextStatus = { ...googleCalendar, ...(next ?? {}) };
    setGoogleCalendar(nextStatus);
    setGoogleCalendarAction("saving");
    try {
      const response = await fetch("/api/google-calendar/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ calendarId: nextStatus.calendarId, autoSync: nextStatus.autoSync }),
      });
      const data = (await response.json()) as Partial<GoogleCalendarSyncStatus> & { message?: string };
      if (response.status === 401) {
        setAuthStatus("guest");
        throw new Error("Admin login required");
      }
      if (!response.ok) throw new Error(data.message || "Google Calendar settings did not save.");
      applyGoogleCalendarStatus(data);
      setToast({ message: "Google Calendar sync settings saved." });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "Could not save Google Calendar settings." });
      void refreshGoogleCalendarStatus();
    } finally {
      setGoogleCalendarAction("idle");
    }
  }

  async function syncGoogleCalendarNow() {
    setGoogleCalendarAction("syncing");
    try {
      const response = await fetch("/api/google-calendar/sync", {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const data = (await response.json()) as Partial<GoogleCalendarSyncStatus> & {
        ok?: boolean;
        upserted?: number;
        deleted?: number;
        message?: string;
      };
      if (response.status === 401) {
        setAuthStatus("guest");
        throw new Error("Admin login required");
      }
      if (!response.ok || data.ok === false) throw new Error(data.message || data.lastSyncError || "Google Calendar sync failed.");
      applyGoogleCalendarStatus(data);
      setToast({ message: `Google Calendar synced${typeof data.upserted === "number" ? ` (${data.upserted} upserted, ${data.deleted ?? 0} deleted)` : ""}.` });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "Google Calendar sync failed." });
      void refreshGoogleCalendarStatus();
    } finally {
      setGoogleCalendarAction("idle");
    }
  }

  async function disconnectGoogleCalendar() {
    setGoogleCalendarAction("disconnecting");
    try {
      const response = await fetch("/api/google-calendar/disconnect", {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const data = (await response.json()) as Partial<GoogleCalendarSyncStatus> & { message?: string };
      if (response.status === 401) {
        setAuthStatus("guest");
        throw new Error("Admin login required");
      }
      if (!response.ok) throw new Error(data.message || "Google Calendar did not disconnect.");
      applyGoogleCalendarStatus(data);
      setToast({ message: "Google Calendar disconnected." });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "Could not disconnect Google Calendar." });
    } finally {
      setGoogleCalendarAction("idle");
    }
  }

  async function saveBrandSettings(nextBrand = brandSettings, options: { silent?: boolean } = {}) {
    const cleanBrand = cleanBrandSettings(nextBrand);
    const saveVersion = ++brandSaveVersionRef.current;
    setBrandSaveState("saving");
    setBrandSettings(cleanBrand);
    try {
      const response = await fetch("/api/brand-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cleanBrand),
      });
      if (!response.ok) throw new Error("Brand save failed");
      const saved = (await response.json()) as Partial<BrandSettings>;
      if (brandSaveVersionRef.current !== saveVersion) return;
      applyBrandSettings(saved);
      setBrandSaveState("saved");
      if (!options.silent) setToast({ message: "Coach logo colours applied to the booking UI." });
      window.setTimeout(() => {
        if (brandSaveVersionRef.current === saveVersion) setBrandSaveState("idle");
      }, 1600);
    } catch {
      if (brandSaveVersionRef.current !== saveVersion) return;
      setBrandSaveState("idle");
      if (!options.silent) setToast({ message: "Brand colours applied locally. The backend did not save them yet." });
    }
  }

  function setBookingCardTheme(nextTheme: ThemeMode) {
    const nextBrand = cleanBrandSettings({ ...brandSettings, bookingTheme: nextTheme });
    setBrandSaveState("idle");
    setBrandSettings(nextBrand);
    if (!isEmbedMode && authStatus === "authenticated") {
      void saveBrandSettings(nextBrand, { silent: true });
    }
  }

  function setBookingLogoVisible(showLogo: boolean) {
    const nextBrand = cleanBrandSettings({ ...brandSettings, showLogo });
    setBrandSaveState("idle");
    setBrandSettings(nextBrand);
    if (!isEmbedMode && authStatus === "authenticated") {
      void saveBrandSettings(nextBrand, { silent: true });
    }
  }

  async function handleLogoUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setToast({ message: "Choose an image file for the coach logo." });
      return;
    }
    try {
      const nextBrand = await analyzeLogoFile(file);
      await saveBrandSettings({ ...brandSettings, ...nextBrand, bookingTheme: brandSettings.bookingTheme });
    } catch {
      setToast({ message: "Could not read that logo. Try a PNG, JPG, or SVG export." });
    }
  }

  function resetBrandSettings() {
    void saveBrandSettings(defaultBrandSettings);
  }

  async function importPeopleFromText() {
    const parsedPeople = parsePeopleImport(peopleImportText);
    if (!parsedPeople.length) {
      setToast({ message: "Paste at least one person with a name or email." });
      return;
    }

    setPeopleImportState("importing");
    try {
      const response = await fetch("/api/people/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ people: parsedPeople }),
      });
      if (response.status === 401) {
        setAuthStatus("guest");
        throw new Error("Admin login required");
      }
      if (!response.ok) throw new Error("People import failed");
      const result = (await response.json()) as PeopleImportResult;
      if (Array.isArray(result.people)) setPeople(cleanPeople(result.people));
      setPeopleImportText("");
      setShowClientImport(false);
      setPeopleImportState("imported");
      setToast({
        message: `${result.imported} added, ${result.updated} updated${result.skipped ? `, ${result.skipped} skipped` : ""}.`,
      });
      window.setTimeout(() => setPeopleImportState("idle"), 1600);
    } catch {
      setPeopleImportState("idle");
      setToast({ message: "Could not import people." });
    }
  }

  function openClientProfile(client: ClientSummary) {
    setIsAddingClient(false);
    setSelectedClientId(client.id);
    setClientEditor(editorFromClient(client));
    setClientEditMode(false);
    setClientSaveState("idle");
  }

  function openNewClient() {
    setIsAddingClient(true);
    setSelectedClientId("");
    setClientEditor(emptyClientEditor);
    setClientEditMode(true);
    setClientSaveState("idle");
  }

  function closeClientModal() {
    setIsAddingClient(false);
    setSelectedClientId("");
    setClientEditMode(false);
    setClientEditor(emptyClientEditor);
    setClientSaveState("idle");
  }

  function startClientEdit() {
    if (selectedClient) setClientEditor(editorFromClient(selectedClient));
    setClientEditMode(true);
    setClientSaveState("idle");
  }

  async function sendTestEmail() {
    const email = testEmailAddress.trim() || notificationSettings.notificationEmail || coachAccount.contactEmail;
    if (!email) {
      setToast({ message: "Enter an email address for the test." });
      return;
    }
    setTestEmailState("sending");
    try {
      const response = await fetch("/api/test-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await response.json()) as { message?: string };
      if (!response.ok) {
        setToast({ message: data.message || "Could not send test email." });
        setTestEmailState("idle");
        return;
      }
      setTestEmailState("sent");
      setToast({ message: data.message || "Test email sent." });
      void loadAdminCalendarState().catch(() => undefined);
      window.setTimeout(() => setTestEmailState("idle"), 1600);
    } catch {
      setToast({ message: "Could not reach the email sender." });
      setTestEmailState("idle");
    }
  }

  async function saveClientProfile() {
    if (!clientEditor.name.trim() && !clientEditor.email.trim()) {
      setToast({ message: "A client needs a name or email." });
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
        throw new Error("Admin login required");
      }
      if (!response.ok) throw new Error("Client save failed");
      const result = (await response.json()) as PeopleUpdateResult;
      if (Array.isArray(result.people)) setPeople(cleanPeople(result.people));
      if (result.person?.id) setSelectedClientId(result.person.id);
      setIsAddingClient(false);
      setClientEditMode(false);
      setClientSaveState("saved");
      setToast({ message: "Client profile saved." });
      window.setTimeout(() => setClientSaveState("idle"), 1400);
    } catch {
      setClientSaveState("idle");
      setToast({ message: "Could not save client profile." });
    }
  }

  async function confirmPublicBooking() {
    if (bookingSubmitState === "saving") return;
    if (!bookingTargetService || bookingStart === null) {
      setToast({ message: "Choose a lesson time before confirming." });
      return;
    }
    // Typed values are authoritative. A saved-client suggestion only changes
    // the booking after the user explicitly clicks it and fills these fields.
    const firstName = bookingForm.firstName.trim();
    const lastName = bookingForm.lastName.trim();
    const phone = bookingForm.phone.trim();
    const email = bookingForm.email.trim();
    const client = [firstName, lastName].filter(Boolean).join(" ").trim();

    if (!firstName || !lastName || !email) {
      setToast({ message: "First name, last name, and email are required." });
      return;
    }

    const candidate = {
      week: activeWeek,
      day: bookingDay,
      start: bookingStart,
      duration: bookingTargetService.duration,
    };
    if (hasCollision(candidate, undefined, bookingTargetService)) {
      setToast({ message: "That time has just been taken. Pick another slot." });
      setBookingStart(null);
      return;
    }

    if (isEmbedMode) {
      setBookingSubmitState("saving");
      setEmailNoticeVisible(false);
      try {
        const response = await fetch("/api/public-booking", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serviceId: bookingTargetService.id,
            week: activeWeek,
            day: bookingDay,
            start: bookingStart,
            firstName,
            lastName,
            phone,
            email,
          }),
        });
        const data = (await response.json()) as {
          message?: string;
          state?: { items?: CalendarItem[] };
          appointment?: { id?: string };
          notifications?: EmailSendResult[];
        };
        if (!response.ok) {
          setToast({ message: data.message || "That time is no longer available." });
          setBookingStart(null);
          if (data.state?.items) setItems(data.state.items);
          return;
        }
        if (data.state?.items) setItems(data.state.items);
        const confirmationNotifications = data.notifications ?? [];
        setBookingConfirmation({
          kind: "booking",
          appointmentId: data.appointment?.id,
          client,
          service: bookingTargetService.name,
          week: activeWeek,
          day: bookingDay,
          start: bookingStart,
          duration: bookingTargetService.duration,
          dayLabel: weekDays[bookingDay].label,
          timeLabel: formatTime(bookingStart),
          email,
          phone,
          notifications: confirmationNotifications,
        });
        setEmailNoticeVisible(confirmationNotifications.some((result) => result.channel === "client" && result.sent));
        setBookingStart(null);
      } catch {
        setToast({ message: "Could not complete the booking. Please try again." });
      } finally {
        setBookingSubmitState("idle");
      }
      return;
    }

    const item: CalendarItem = {
      id: `appt-${Date.now()}`,
      kind: "appointment",
      ...candidate,
      serviceId: bookingTargetService.id,
      client,
      title: client,
      phone,
      email,
      note: "Booked from public booking page.",
    };
    setItems(carveBusyBlocksForAppointment([...items, item], itemSlot(item)));
    if (isEmbedMode) {
      closeCalendarDetails();
    } else {
      closeCalendarDetails();
      setActiveView("calendar");
    }
    setBookingStart(null);
    setBookingForm({ firstName: "", lastName: "", phone: "", email: "" });
    setToast({
      message: `${client} booked ${bookingTargetService.name} on ${weekDays[item.day].short} at ${formatTime(item.start)}.`,
    });
  }

  function copyEmbedCode() {
    if (!navigator.clipboard) {
      setToast({ message: "Copy is not available in this browser. Select the iframe code manually." });
      return;
    }
    void navigator.clipboard.writeText(iframeCode).then(() => {
      setCopiedEmbed(true);
      setToast({ message: "Squarespace iframe code copied." });
      window.setTimeout(() => setCopiedEmbed(false), 1600);
    }, () => {
      setToast({ message: "Copy was blocked by the browser. Select the iframe code manually." });
    });
  }

  function copyBookingScreenValue(value: string, kind: "url" | "iframe", screenId: string) {
    if (!navigator.clipboard) {
      setToast({ message: "Copy is not available in this browser. Select the value manually." });
      return;
    }
    const key = `${screenId}-${kind}`;
    void navigator.clipboard.writeText(value).then(() => {
      const message = kind === "url" ? "Booking page link copied." : "Squarespace iframe code copied.";
      setToast({ message });
      if (kind === "url") {
        setCopiedBookingScreenLinkId(key);
        window.setTimeout(() => {
          setCopiedBookingScreenLinkId((current) => (current === key ? null : current));
        }, 1600);
      } else {
        setCopiedBookingScreenIframeId(key);
        window.setTimeout(() => {
          setCopiedBookingScreenIframeId((current) => (current === key ? null : current));
        }, 1600);
      }
    }, () => {
      setToast({ message: "Copy was blocked by the browser. Select the value manually." });
    });
  }

  function copySyncText(kind: "url" | "key") {
    if (!navigator.clipboard) {
      setToast({ message: "Copy is not available in this browser. Select the sync value manually." });
      return;
    }
    const text = kind === "url" ? calendarFeedUrl : calendarSyncKey;
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedSync(kind);
      setToast({ message: kind === "url" ? "Google calendar sync URL copied." : "Private sync key copied." });
      window.setTimeout(() => setCopiedSync(null), 1600);
    }, () => {
      setToast({ message: "Copy was blocked by the browser. Select the sync value manually." });
    });
  }

  function updateBookingScreenName(screenId: string, nextValue: string) {
    setBookingScreenNames((previous) => ({ ...previous, [screenId]: nextValue }));
  }

  function regenerateSyncKey() {
    setCalendarSyncKey(generateSyncKey());
    setCopiedSync(null);
    setToast({ message: "Calendar sync key regenerated. Update Google Calendar with the new URL." });
  }

  function removeSelected() {
    if (!selected) return;
    if (!requireLiveDatabase("remove calendar items")) return;
    const previous = items;
    setItems(items.filter((item) => item.id !== selected.id));
    closeCalendarDetails();
    setToast({
      message: `${selected.kind === "block" ? "Block" : "Appointment"} removed.`,
      undo: () => setItems(previous),
    });
  }

  const servicesSettingsPanel = (
    <div className="settings-section settings-services">
      <div className="service-layout">
        <div className="services-topline">
          <div>
            <span>Lesson options</span>
            <h2>Lesson types</h2>
          </div>
          <button className="outline-button" onClick={startNewService}>
            <Plus size={16} />
            New
          </button>
        </div>

        {showServiceEditor && (
          <article className="data-card service-editor">
            <div className="data-card-header">
              <div>
                <span>{editingServiceId ? "Edit Lesson Type" : "New Lesson Type"}</span>
                <h2>{editingServiceId ? serviceEditor.name || "Lesson details" : "Add service"}</h2>
              </div>
              <button
                className="outline-button"
                onClick={() => {
                  setShowServiceEditor(false);
                  setEditingServiceId(null);
                  setServiceEditor(emptyServiceEditor());
                }}
              >
                <X size={16} />
                Close
              </button>
            </div>

            <div className="service-form">
              <div className="service-form-row">
                <label className="settings-field">
                  <span>Lesson format</span>
                  <select
                    value={serviceEditor.lessonFormat}
                    onChange={(event) =>
                      updateServiceEditor(
                        "lessonFormat",
                        event.target.value === "package"
                          ? "package"
                          : event.target.value === "group"
                            ? "group"
                            : "private",
                      )
                    }
                  >
                    <option value="private">Private lesson</option>
                    <option value="group">Group lesson</option>
                    <option value="package">Package</option>
                  </select>
                </label>
                <label className="settings-field">
                  <span>Visibility</span>
                  <select
                    value={serviceEditor.visibility}
                    onChange={(event) =>
                      updateServiceEditor("visibility", event.target.value === "private" ? "private" : "public")
                    }
                  >
                    <option value="public">Public booking page</option>
                    <option value="private">Admin only</option>
                  </select>
                </label>
                <label className="settings-field">
                  <span>Show on booking screens</span>
                  <div className="service-screen-checkboxes">
                    {BOOKING_SCREENS.map((screen) => (
                      <label className="settings-toggle" key={screen.id}>
                        <input
                          checked={Boolean((serviceEditor.bookingScreenIds ?? ["main"]).includes(screen.id))}
                          onChange={(event) => updateBookingScreens(screen.id, event.target.checked)}
                          type="checkbox"
                        />
                        <span>{screen.label}</span>
                      </label>
                    ))}
                  </div>
                  {serviceEditor.visibility === "private" && (
                    <p className="field-help">Admin-only lesson types will not appear publicly until visibility is set to Public.</p>
                  )}
                </label>
              </div>
              <label className="settings-field">
                <span>Name</span>
                <input
                  value={serviceEditor.name}
                  onChange={(event) => updateServiceEditor("name", event.target.value)}
                  placeholder="Lesson name"
                />
              </label>
              <label className="settings-field">
                <span>Optional description</span>
                <input
                  value={serviceEditor.description}
                  onChange={(event) => updateServiceEditor("description", event.target.value)}
                  placeholder="Short booking note"
                />
              </label>
              <div className="service-form-row">
                <label className="settings-field">
                  <span>Duration</span>
                  <input
                    value={serviceEditor.duration}
                    min={15}
                    max={240}
                    step={15}
                    inputMode="numeric"
                    onChange={(event) => updateServiceEditor("duration", Number(event.target.value))}
                    type="text"
                  />
                </label>
                <label className="settings-field">
                  <span>Price NZD</span>
                  <input
                    value={serviceEditor.price}
                    min={0}
                    step={1}
                    inputMode="decimal"
                    onChange={(event) => updateServiceEditor("price", Number(event.target.value))}
                    type="text"
                  />
                </label>
                <label className="settings-field">
                  <span>Pricing</span>
                  <select
                    disabled={serviceEditor.lessonFormat !== "group"}
                    value={serviceEditor.priceMode}
                    onChange={(event) =>
                      updateServiceEditor("priceMode", event.target.value === "per-person" ? "per-person" : "session")
                    }
                  >
                    <option value="session">Per session</option>
                    <option value="per-person">Per person</option>
                  </select>
                </label>
              </div>
              <div className="service-form-row">
                {serviceEditor.lessonFormat === "group" && (
                  <label className="settings-field">
                    <span>Day of week</span>
                    <select
                      value={serviceEditor.groupSchedule?.dayOfWeek ?? 2}
                      onChange={(event) => updateGroupSchedule("dayOfWeek", Number(event.target.value))}
                    >
                      {fullDayNames.map((dayName, index) => (
                        <option key={dayName} value={index}>
                          {dayName}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {serviceEditor.lessonFormat === "group" && (
                  <label className="settings-field">
                    <span>Start time</span>
                    <input
                      value={minutesToInputTime(serviceEditor.groupSchedule?.startMinutes ?? timeToMinutes(18, 0))}
                      inputMode="numeric"
                      onChange={(event) =>
                        updateGroupSchedule(
                          "startMinutes",
                          inputTimeToMinutes(
                            event.target.value,
                            serviceEditor.groupSchedule?.startMinutes ?? timeToMinutes(18, 0),
                          ),
                        )
                      }
                      type="time"
                      step={SNAP_MINUTES * 60}
                    />
                  </label>
                )}
                {serviceEditor.lessonFormat === "group" && (
                  <label className="settings-field">
                    <span>Generate next</span>
                    <input
                      value={groupOccurrenceInput}
                      min={1}
                      max={MAX_GROUP_OCCURRENCE_COUNT}
                      step={1}
                      inputMode="numeric"
                      onChange={(event) => setGroupOccurrenceInput(event.target.value)}
                      onBlur={() => void applyGroupDraftInputs()}
                      type="text"
                    />
                  </label>
                )}
                {serviceEditor.lessonFormat === "group" && (
                  <label className="settings-field">
                    <span>Minimum group</span>
                    <input
                      value={groupMinimumInput}
                      min={2}
                      max={Number(groupMaximumInput) || 24}
                      step={1}
                      inputMode="numeric"
                      onChange={(event) => setGroupMinimumInput(event.target.value)}
                      onBlur={() => void applyGroupDraftInputs()}
                      type="text"
                    />
                  </label>
                )}
                {serviceEditor.lessonFormat === "group" && (
                  <label className="settings-toggle">
                    <input
                      checked={serviceEditor.groupSchedule?.active !== false}
                      onChange={(event) => updateGroupSchedule("active", event.target.checked)}
                      type="checkbox"
                    />
                    <span>Enable recurring schedule</span>
                  </label>
                )}
                {serviceEditor.lessonFormat !== "package" && (
                  <label className="settings-field">
                    <span>{serviceEditor.lessonFormat === "group" ? "Maximum group" : "Capacity"}</span>
                    <input
                      value={groupMaximumInput}
                      min={serviceEditor.lessonFormat === "group" ? 2 : 1}
                      max={24}
                      step={1}
                      inputMode="numeric"
                      onChange={(event) => setGroupMaximumInput(event.target.value)}
                      onBlur={() => void applyGroupDraftInputs()}
                      type="text"
                    />
                  </label>
                )}
                <label className="settings-field">
                  <span>Location note</span>
                  <input
                    value={serviceEditor.location}
                    onChange={(event) => updateServiceEditor("location", event.target.value)}
                    placeholder={coachAccount.venueShortName}
                  />
                </label>
              </div>
              {serviceEditor.lessonFormat === "package" && (
                <div className="service-form-row">
                  <label className="settings-field">
                    <span>Allowance</span>
                    <input
                      value={serviceEditor.packageAllowance ?? 5}
                      min={1}
                      max={100}
                      step={1}
                      inputMode="numeric"
                      onChange={(event) => updateServiceEditor("packageAllowance", Number(event.target.value))}
                      type="text"
                    />
                  </label>
                  <label className="settings-field">
                    <span>Coverage style</span>
                    <select
                      value={serviceEditor.packageCoverageMode ?? "upfront"}
                      onChange={(event) =>
                        updateServiceEditor(
                          "packageCoverageMode",
                          event.target.value === "lesson-by-lesson" ? "lesson-by-lesson" : "upfront",
                        )
                      }
                    >
                      <option value="upfront">Paid upfront</option>
                      <option value="lesson-by-lesson">Lesson-by-lesson</option>
                    </select>
                  </label>
                  <label className="settings-field">
                    <span>Covers lesson type</span>
                    <select
                      value={serviceEditor.packageCoversServiceId ?? ""}
                      onChange={(event) => updateServiceEditor("packageCoversServiceId", event.target.value)}
                    >
                      <option value="">Any matching lesson</option>
                      {services
                        .filter((service) => service.lessonFormat !== "package")
                        .map((service) => (
                          <option key={service.id} value={service.id}>
                            {service.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
              )}
              <label className="settings-toggle">
                <input
                  checked={serviceEditor.active}
                  onChange={(event) => updateServiceEditor("active", event.target.checked)}
                  type="checkbox"
                />
                <span>Active and bookable</span>
              </label>
            </div>

            <button className="primary-button settings-save" onClick={saveEditedService}>
              {serviceSaveState === "saving"
                ? "Saving"
                : serviceSaveState === "saved"
                  ? "Saved"
                  : serviceSaveState === "error"
                    ? "Not saved"
                    : "Save Lesson Type"}
            </button>
          </article>
        )}

        <details className="settings-subsection service-list-section">
          <summary className="settings-subsection-title">
            <ScissorsLineDashed size={18} />
            <div>
              <span>Lesson types</span>
              <strong>{services.filter((service) => service.active).length} active</strong>
            </div>
          </summary>
          <div className="service-list" aria-label="Lesson types">
            {services.map((service) => (
              <article className={`service-row ${service.active ? "" : "is-archived"}`} key={service.id}>
                <button className="service-row-main" onClick={() => editService(service)} type="button">
                  <span>
                    {service.active ? "Active" : "Archived"} · {service.visibility === "public" ? "Public" : "Admin only"} ·{" "}
                    {service.lessonFormat === "package" ? "Package" : service.lessonFormat === "group" ? "Group" : "Private"} ·{" "}
                    {formatBookingScreenLabels(service.bookingScreenIds ?? ["main"]).join(", ")}
                  </span>
                  <strong>{service.name}</strong>
                  {service.description && <em>{service.description}</em>}
                  {service.lessonFormat === "package" && (
                    <em>
                      {service.packageAllowance ?? 5} slots ·{" "}
                      {service.packageCoverageMode === "lesson-by-lesson" ? "lesson-by-lesson" : "paid upfront"}
                    </em>
                  )}
                </button>
                <div className="service-row-meta">
                  <strong>{servicePriceLabel(service)}</strong>
                  <span>{service.duration} min</span>
                </div>
                <div className="service-row-actions">
                  <button className="outline-button" onClick={() => editService(service)}>
                    Edit
                  </button>
                  <button className="outline-button" onClick={() => deleteService(service)}>
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        </details>
      </div>
    </div>
  );

  const availabilitySettingsPanel = (
    <div className="settings-section settings-availability">
      <div className="availability-layout">
        <div className="data-card wide">
          <div className="data-card-header">
            <div>
              <span>Availability</span>
              <h2>{coachAccount.venueName}</h2>
            </div>
            <button className="primary-button" onClick={saveAvailability}>
              {availabilitySaveState === "saving"
                ? "Saving"
                : availabilitySaveState === "saved"
                ? "Saved"
                : "Save Availability"}
            </button>
          </div>
          <div className="availability-editor">
            {fullDayNames.map((dayName, dayIndex) => (
              <details className="settings-subsection availability-edit-row" key={dayName}>
                <summary className="settings-subsection-title availability-day-title">
                  <Clock size={18} />
                  <div>
                    <span>{dayName}</span>
                    <strong>
                      {availability[dayIndex].length
                        ? availability[dayIndex].map((window) => `${formatTime(window.start)} - ${formatTime(window.end)}`).join(", ")
                        : "Closed"}
                    </strong>
                  </div>
                </summary>
                <div className="availability-day-controls">
                  <button className="outline-button compact-button" onClick={() => toggleAvailabilityDay(dayIndex)}>
                    {availability[dayIndex].length ? "Closed" : "Open"}
                  </button>
                </div>
                <div className="availability-windows">
                  {availability[dayIndex].map((window, windowIndex) => {
                    const windowKey = `${dayIndex}-${windowIndex}`;
                    const isEditingWindow = editingAvailabilityWindow === windowKey;
                    return (
                      <div
                        className={`availability-window ${isEditingWindow ? "is-editing" : ""}`}
                        key={`${dayName}-${windowIndex}`}
                      >
                        {isEditingWindow ? (
                          <>
                            <label>
                              <span>From</span>
                              <input
                                value={minutesToInputTime(window.start)}
                                onChange={(event) =>
                                  updateAvailabilityWindow(
                                    dayIndex,
                                    windowIndex,
                                    "start",
                                    inputTimeToMinutes(event.target.value, window.start),
                                  )
                                }
                                type="time"
                                step={SNAP_MINUTES * 60}
                              />
                            </label>
                            <label>
                              <span>To</span>
                              <input
                                value={minutesToInputTime(window.end)}
                                onChange={(event) =>
                                  updateAvailabilityWindow(
                                    dayIndex,
                                    windowIndex,
                                    "end",
                                    inputTimeToMinutes(event.target.value, window.end),
                                  )
                                }
                                type="time"
                                step={SNAP_MINUTES * 60}
                              />
                            </label>
                            <button
                              className="icon-button small"
                              aria-label={`Done editing ${dayName} window`}
                              onClick={() => setEditingAvailabilityWindow("")}
                            >
                              <Check size={15} />
                            </button>
                          </>
                        ) : (
                          <button
                            className="availability-range-button"
                            onClick={() => setEditingAvailabilityWindow(windowKey)}
                            type="button"
                          >
                            <Clock size={15} />
                            {formatTime(window.start)} - {formatTime(window.end)}
                          </button>
                        )}
                        <button
                          className="icon-button small"
                          aria-label={`Remove ${dayName} window`}
                          onClick={() => removeAvailabilityWindow(dayIndex, windowIndex)}
                        >
                          <X size={15} />
                        </button>
                      </div>
                    );
                  })}
                  <button className="outline-button compact-button add-time-button" onClick={() => addAvailabilityWindow(dayIndex)}>
                    <Plus size={15} />
                    Add time
                  </button>
                </div>
              </details>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  const bookingSettingsPanel = (
    <article className="data-card settings-section settings-experience settings-branding booking-page-settings">
      <div className="data-card-header">
        <div>
          <span>Booking Page</span>
          <h2>Public booking surface</h2>
        </div>
        <Eye size={24} />
      </div>
      <details className="settings-subsection">
        <summary className="settings-subsection-title">
          <Eye size={18} />
          <div>
            <span>Preview</span>
            <strong>{brandSettings.bookingTheme === "dark" ? "Dark branded cards" : "Light branded cards"}</strong>
          </div>
        </summary>
        <div className={`public-booking booking-theme-${brandSettings.bookingTheme}`}>
      <div className={`booking-brand ${showBookingBrandLogo ? "" : "booking-brand-subtle"}`}>
        {showBookingBrandLogo && brandSettings.logoPreview ? (
          <img src={brandSettings.logoPreview} alt={`${bookingBrandName} logo`} />
        ) : showBookingBrandLogo ? (
          <>
            <strong>{bookingBrandPrimary.toUpperCase()}</strong>
            {bookingBrandSecondary && <span>{bookingBrandSecondary.toUpperCase()}</span>}
          </>
        ) : (
          <strong>{bookingBrandName}</strong>
        )}
        <em>{coachAccount.venueShortName}</em>
      </div>

      <div className="booking-columns booking-progressive-flow">
        <section className={`booking-progressive-section ${isAppointmentSectionOpen ? "is-open" : ""} ${
          isAppointmentStepComplete ? "is-complete" : ""
        }`}>
          <button
            className="booking-progressive-title"
            onClick={() => setPublicBookingSection("appointment")}
            type="button"
          >
            <span className="booking-progressive-title-label">1. Appointment</span>
            <span className="booking-progressive-title-state">{isAppointmentStepComplete ? "Done" : "In progress"}</span>
          </button>
          {isAppointmentSectionOpen ? (
            <div className="booking-progressive-body">
              <div className="service-picker">
                {visiblePublicServices.length ? (
                  visiblePublicServices.map((service) => (
                    <button
                      className={service.id === bookingServiceId ? "selected-service" : ""}
                      key={service.id}
                      onClick={() => handlePublicBookingServiceSelect(service.id)}
                      type="button"
                    >
                      <strong>{service.name}</strong>
                      <em>
                        {service.duration} minutes @ {servicePriceLabel(service)}
                      </em>
                      {service.description && <small>{service.description}</small>}
                    </button>
                  ))
                ) : (
                  <p>No public lesson types are active.</p>
                )}
              </div>
            </div>
          ) : isAppointmentStepComplete ? (
                    <button
                      className="booking-summary booking-progressive-summary"
                      onClick={() => setPublicBookingSection("appointment")}
                      type="button"
                    >
                      <strong>{appointmentSummaryName}</strong>
                      <span>{appointmentSummaryDuration}</span>
                      {appointmentSummaryDescription ? <small>{appointmentSummaryDescription}</small> : null}
                    </button>
                  ) : (
            <button
              className="booking-progressive-summary booking-progressive-summary-empty"
              onClick={() => setPublicBookingSection("appointment")}
              type="button"
            >
              <strong>Appointment not selected</strong>
              <span>Pick a lesson to continue</span>
            </button>
          )}
        </section>

        <section className={`booking-progressive-section ${isDateTimeSectionOpen ? "is-open" : ""} ${
          isDateTimeStepComplete ? "is-complete" : ""
        }`}>
          <button
            className="booking-progressive-title"
            onClick={() => setPublicBookingSection("datetime")}
            type="button"
            disabled={!isAppointmentStepComplete}
          >
            <span className="booking-progressive-title-label">2. Date & Time</span>
            <span className="booking-progressive-title-state">{isDateTimeStepComplete ? "Done" : isAppointmentStepComplete ? "In progress" : "Locked"}</span>
          </button>
          {isDateTimeSectionOpen ? (
            <div className="booking-progressive-body">
              <div className="booking-week-controls">
                <button onClick={() => moveWeek(-1)} type="button">
                  <ArrowLeft size={15} />
                  <span>Previous week</span>
                </button>
                <strong>{weekTitle}</strong>
                <button onClick={() => moveWeek(1)} type="button">
                  <span>Next week</span>
                  <ArrowRight size={15} />
                </button>
              </div>
              {!isGroupBookingTimeSelection ? (
                <div className="booking-days-wrap">
                  <div className="booking-days">
                    {weekDays.map((day, index) => (
                      <button
                        className={bookingDaySelected && bookingDay === index ? "selected-day" : ""}
                        key={day.label}
                        onClick={() => handlePublicBookingDaySelect(index)}
                        type="button"
                      >
                        <strong>{day.short}</strong>
                        <em>{day.date}</em>
                        {day.isToday ? <small className="booking-day-marker">Today</small> : null}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="time-slots">
                {selectedBookingService ? (
                  bookingSlots.length ? (
                    visibleBookingSlots.map((slot) => {
                      const slotLabel = isGroupBookingTimeSelection
                        ? `${dateForSlot(slot.week, slot.day).toLocaleDateString("en-NZ", { weekday: "short", month: "short", day: "numeric" })} · ${formatTime(slot.start)} · ${slot.remainingSpots} spot${slot.remainingSpots === 1 ? "" : "s"} left`
                        : formatTime(slot.start);
                      return (
                        <button
                          className={bookingStart === slot.start ? "selected-time" : ""}
                          key={`${slot.week}-${slot.day}-${slot.start}`}
                          onClick={() => handlePublicBookingTimeSelect(slot)}
                          type="button"
                        >
                          {slotLabel}
                        </button>
                      );
                    })
                  ) : (
                    <p>
                      {isGroupBookingTimeSelection
                        ? "No upcoming group lesson times are available yet."
                        : bookingDaySelected
                          ? "No public times available for this day."
                          : "Choose a day first."}
                    </p>
                  )
                ) : (
                  <p>Choose an appointment type first.</p>
                )}
              </div>
            </div>
          ) : isDateTimeStepComplete ? (
            <button
                      className="booking-summary booking-progressive-summary"
                      onClick={() => setPublicBookingSection("datetime")}
                      type="button"
                    >
                      <span>{dateTimeSummaryLine}</span>
                      {dateTimeSummaryLocation ? <small>{dateTimeSummaryLocation}</small> : null}
                    </button>
                  ) : (
            <button
              className="booking-progressive-summary booking-progressive-summary-empty"
              onClick={() => setPublicBookingSection("datetime")}
              type="button"
              disabled={!isAppointmentStepComplete}
            >
              <strong>{isAppointmentStepComplete ? "Date not selected" : "Select appointment first"}</strong>
              <span>{isAppointmentStepComplete ? "Choose day and time" : "Complete appointment step"}</span>
            </button>
          )}
        </section>

        <section className={`booking-progressive-section ${isInformationSectionOpen ? "is-open" : ""} ${
          isInformationStepComplete ? "is-complete" : ""
        }`}>
          <button
            className="booking-progressive-title"
            onClick={() => setPublicBookingSection("information")}
            type="button"
            disabled={!isDateTimeStepComplete}
          >
            <span className="booking-progressive-title-label">3. Your Information</span>
            <span className="booking-progressive-title-state">
              {isInformationStepComplete ? "Done" : isDateTimeStepComplete ? "In progress" : "Locked"}
            </span>
          </button>
          {isInformationSectionOpen ? (
            <div className="booking-progressive-body">
              <div className="booking-form">
                <input
                  value={bookingForm.firstName}
                  autoComplete="given-name"
                  onChange={(event) => updateBookingForm("firstName", event.target.value)}
                  onKeyDown={handleBookingMatchKeyDown}
                  placeholder="First name"
                />
                <input
                  value={bookingForm.lastName}
                  autoComplete="family-name"
                  onChange={(event) => updateBookingForm("lastName", event.target.value)}
                  onKeyDown={handleBookingMatchKeyDown}
                  placeholder="Last name"
                />
                <input
                  value={bookingForm.phone}
                  autoComplete="tel"
                  inputMode="tel"
                  onChange={(event) => updateBookingForm("phone", event.target.value)}
                  onKeyDown={handleBookingMatchKeyDown}
                  placeholder="Phone"
                  type="tel"
                />
                <input
                  value={bookingForm.email}
                  autoComplete="email"
                  inputMode="email"
                  onChange={(event) => updateBookingForm("email", event.target.value)}
                  onKeyDown={handleBookingMatchKeyDown}
                  placeholder="Email"
                  type="email"
                />
              </div>
              {bookingClientSuggestion && showBookingClientSuggestion && (
                <button
                  className="client-match-prompt booking-client-match"
                  onClick={() => applyBookingClient(bookingClientSuggestion)}
                  type="button"
                >
                  <User size={15} />
                  <span>
                    <strong>{bookingClientSuggestion.name}</strong>
                    <em>{[bookingClientSuggestion.phone, bookingClientSuggestion.email].filter(Boolean).join(" · ")}</em>
                  </span>
                </button>
              )}
              <div className="booking-summary">
                <strong>{selectedBookingService?.name ?? "Choose appointment type"}</strong>
                <span>
                  {!selectedBookingService
                    ? "Select a lesson to see available times"
                    : bookingStart === null
                    ? "Choose a time"
                    : `${weekDays[bookingDay].label}, ${formatTime(bookingStart)}`}
                </span>
              </div>
              {bookingSubmitState === "saving" && <div className="booking-save-progress" aria-label="Saving booking" />}
              <button
                className="primary-button confirm-booking"
                disabled={!selectedBookingService || bookingStart === null || bookingSubmitState === "saving"}
                onClick={confirmPublicBooking}
                type="button"
              >
                {bookingSubmitState === "saving" ? "Confirming..." : "Confirm Appointment"}
              </button>
            </div>
          ) : isInformationStepComplete ? (
                    <button
                      className="booking-summary booking-progressive-summary"
                      onClick={() => setPublicBookingSection("information")}
                      type="button"
                    >
                      <strong>Information complete</strong>
                      <span>Customer details captured</span>
                    </button>
                  ) : (
            <button
              className="booking-progressive-summary booking-progressive-summary-empty"
              onClick={() => setPublicBookingSection("information")}
              type="button"
              disabled={!isDateTimeStepComplete}
            >
              <strong>{isDateTimeStepComplete ? "Customer details missing" : "Complete time step first"}</strong>
              <span>{isDateTimeStepComplete ? "Enter your details to confirm" : "Lock a time first"}</span>
            </button>
          )}
        </section>
      </div>

        </div>
      </details>
      <details className="settings-subsection">
        <summary className="settings-subsection-title">
          <Clock size={18} />
          <div>
            <span>Minimum notice before a public booking</span>
            <strong>{minBookingNoticeSummary}</strong>
          </div>
        </summary>
        <label className="settings-field">
          <span>Minimum notice in hours</span>
          <input
            type="number"
            min={0}
            max={168}
            step={0.25}
            value={minBookingNoticeHours}
            onChange={(event) => updateBookingNoticeHours(Math.max(0, Number(event.target.value || 0)))}
          />
        </label>
        <p className="field-help">Clients can only book or reschedule after that buffer.</p>
        <div className="minimum-notice-presets" aria-label="Quick notice presets">
          {MIN_BOOKING_NOTICE_PRESETS_HOURS.map((hours) => (
            <button
              className="outline-button"
              key={hours}
              onClick={() => updateBookingNoticeHours(hours)}
              type="button"
            >
              {hours === 0 ? "No buffer" : `${hours} hour${hours === 1 ? "" : "s"}`}
            </button>
          ))}
        </div>
        <button className="outline-button" onClick={() => updateBookingNoticeHours(0)} type="button">
          Clear buffer
        </button>
        <button className="primary-button settings-save" onClick={saveNotificationSettings}>
          {settingsSaveState === "saving"
            ? "Saving"
            : settingsSaveState === "saved"
              ? "Saved"
              : "Save minimum notice"}
        </button>
      </details>
              <details className="settings-subsection">
                <summary className="settings-subsection-title">
                  <Code2 size={18} />
                  <div>
                    <span>Booking screen embeds</span>
                    <strong>Squarespace iframe</strong>
                  </div>
                </summary>
              <div className="embed-panel">
                <div className="booking-screen-tabs" role="tablist" aria-label="Booking screen embeds">
                  {bookingScreenEmbeds.map((bookingScreen) => (
                    <button
                      className={`booking-screen-tab ${selectedBookingScreenId === bookingScreen.id ? "active" : ""}`}
                      key={bookingScreen.id}
                      onClick={() => setSelectedBookingScreenId(bookingScreen.id)}
                      type="button"
                    >
                      {bookingScreen.label}
                    </button>
                  ))}
                </div>
                {selectedBookingScreen && (
                  <div className="booking-screen-embed-card">
                    <label className="settings-field">
                      <span>Screen name</span>
                      <input
                        value={selectedBookingScreen.label}
                        onChange={(event) => updateBookingScreenName(selectedBookingScreen.id, event.target.value)}
                        type="text"
                      />
                    </label>
                    <div className="settings-field">
                      <span>Slug</span>
                      <code className="booking-screen-slug">{selectedBookingScreen.path}</code>
                    </div>
                    <div className="settings-field">
                      <span>Public link</span>
                      <code className="booking-screen-link">{selectedBookingScreen.publicUrl}</code>
                    </div>
                    <div className="embed-actions">
                      <button
                        className="outline-button"
                        onClick={() => copyBookingScreenValue(selectedBookingScreen.publicUrl, "url", selectedBookingScreen.id)}
                        type="button"
                      >
                        {copiedBookingScreenLinkId === `${selectedBookingScreen.id}-url` ? <Check size={16} /> : <Copy size={16} />}
                        {copiedBookingScreenLinkId === `${selectedBookingScreen.id}-url` ? "Copied link" : "Copy public link"}
                      </button>
                      <a className="outline-button" href={selectedBookingScreen.publicUrl} target="_blank" rel="noreferrer">
                        <ExternalLink size={16} />
                        Open widget
                      </a>
                    </div>
                    <div className="settings-field">
                      <span>Iframe embed</span>
                      <div className="embed-code booking-screen-iframe">
                        <Code2 size={18} />
                        <code>{selectedBookingScreen.iframeCode}</code>
                      </div>
                    </div>
                    <div className="embed-actions">
                      <button
                        className="outline-button"
                        onClick={() => copyBookingScreenValue(selectedBookingScreen.iframeCode, "iframe", selectedBookingScreen.id)}
                        type="button"
                      >
                        {copiedBookingScreenIframeId === `${selectedBookingScreen.id}-iframe` ? (
                          <Check size={16} />
                        ) : (
                          <Copy size={16} />
                        )}
                        {copiedBookingScreenIframeId === `${selectedBookingScreen.id}-iframe` ? "Copied iframe" : "Copy iframe"}
                      </button>
                    </div>
                    <div className="booking-screen-preview">
                      <div className="settings-field">
                        <span>Preview iframe</span>
                        <iframe
                          src={selectedBookingScreen.publicUrl}
                          title={`${coachAccount.businessName} ${selectedBookingScreen.label} preview`}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
      </details>
    </article>
  );

  const selectedAppointmentDetails = selected ? (
    <>
      <div className="panel-header">
        <span>{selected.kind === "block" ? "Blocked Time" : "Appointment"}</span>
        <button className="icon-button small" onClick={closeCalendarDetails} aria-label="Close details">
          <X size={17} />
        </button>
      </div>
      <h2 id="appointment-details-title">{selected.kind === "block" ? selected.title : selected.client}</h2>
      <p className="muted">{selectedService?.name ?? selected.note}</p>

      <div className="info-stack">
        <div>
          <Clock size={16} />
          <span>{`${weekDays[selected.day].label}, ${formatRange(selected.start, selected.duration)}`}</span>
        </div>
        <div>
          <MapPin size={16} />
          <span>{coachAccount.venueName}</span>
        </div>
        {selected.phone && (
          <div>
            <Phone size={16} />
            <span>{selected.phone}</span>
          </div>
        )}
        {selected.email && (
          <div>
            <Mail size={16} />
            <span>{selected.email}</span>
          </div>
        )}
      </div>

      <div className="service-summary">
        <span>Price</span>
        <strong>{servicePriceLabel(selectedService)}</strong>
        <p>{selectedService?.description ?? selected.note}</p>
      </div>

      {selected.kind === "appointment" && (
        <div className="lesson-status-panel">
          <span>Status</span>
          <div className="lesson-status-options" role="group" aria-label="Lesson status">
            {(["booked", "completed", "cancelled", "no_show"] as BookingStatus[]).map((status) => (
              <button
                className={(selected.status ?? "booked") === status ? "active" : ""}
                key={status}
                onClick={() => updateAppointmentStatus(selected.id, status)}
                type="button"
              >
                {status === "no_show" ? "No-show" : status[0].toUpperCase() + status.slice(1)}
              </button>
            ))}
          </div>
        </div>
      )}

      {selected.kind === "appointment" && selectedPerson && hasSelectedPersonCaddyProfile && (
        <div className="linked-profile">
          <div>
            <span>Shared profile</span>
            <strong>{selectedPerson.caddyProfileId || "Clarity Caddy"}</strong>
          </div>
          <a
            className="outline-button"
            href={caddyProfileUrl(selectedPerson, caddyWorkspaceUrl)}
            target="_blank"
            rel="noreferrer"
          >
            <Link2 size={16} />
            Caddy
          </a>
        </div>
      )}

      {selected.kind === "appointment" && selectedPerson && !hasSelectedPersonCaddyProfile && (
        <div className="linked-profile">
          <div>
            <span>Shared profile</span>
            <strong>Not connected</strong>
          </div>
          <button className="outline-button" type="button">
            <Link2 size={16} />
            Add Clarity Caddy
          </button>
        </div>
      )}

      {selected.kind === "appointment" && (
        <div className="lesson-receipts-panel">
          <div className="receipt-panel-title">
            <Mail size={16} />
            <span>Email receipts</span>
          </div>
          {selectedAppointmentNotifications.length ? (
            selectedAppointmentNotifications.map((notification) => (
              <div className="email-receipt-row" key={notification.id}>
                <span className={`email-status-dot ${notificationTone(notification.status)}`} aria-hidden="true" />
                <div>
                  <strong>{notificationKindLabel(notification.kind)}</strong>
                  <span>{notification.recipient || "No recipient"}</span>
                </div>
                <em>
                  {notificationStatusLabel(notification)}
                  {notification.createdAt ? ` · ${notificationTimeLabel(notification.createdAt)}` : ""}
                </em>
              </div>
            ))
          ) : (
            <p>No email receipts recorded for this lesson yet.</p>
          )}
        </div>
      )}

      {selected.kind === "block" && (
        <div className="admin-override">
          <span>Admin override</span>
          <strong>Add appointment in this blocked time</strong>
          {quickCreateServices.map((service) => (
            <button key={service.id} onClick={() => createAppointmentInsideSelectedBlock(service.id)}>
              <Plus size={16} />
              {service.name}
            </button>
          ))}
        </div>
      )}

      <div className="panel-actions">
        {selected.kind === "appointment" && (
          <button className="primary-button" onClick={bookNextFromSelected}>
            <Plus size={16} />
            Book Next
          </button>
        )}
        <button className="danger-button" onClick={removeSelected}>
          {selected.kind === "appointment" ? "Cancel Lesson" : "Remove Block"}
        </button>
      </div>
    </>
  ) : null;

  const selectedGroupSessionDetails = selectedGroupSession && selectedGroupSessionService ? (
    <>
      <div className="panel-header">
        <span>Group Session</span>
        <button className="icon-button small" onClick={closeCalendarDetails} aria-label="Close details">
          <X size={17} />
        </button>
      </div>
      <h2 id="appointment-details-title">{selectedGroupSessionService.name}</h2>
      <p className="muted">{selectedGroupSessionLabel}</p>

      <div className="info-stack">
        <div>
          <Clock size={16} />
          <span>{`${selectedGroupSessionLabel}, ${formatRange(
            selectedGroupSession.start,
            selectedGroupSession.duration,
          )}`}</span>
        </div>
        <div>
          <MapPin size={16} />
          <span>{selectedGroupSessionService.location || coachAccount.venueName}</span>
        </div>
        <div>
          <User size={16} />
          <span>{`${selectedGroupSessionBookedCount} / ${selectedGroupSessionCapacity} booked`}</span>
        </div>
        <div>
          <span>{`Spaces remaining: ${selectedGroupSessionRemainingSlots}`}</span>
        </div>
      </div>

      <div className="service-summary">
        <span>Booked people</span>
        {selectedGroupSessionAttendees.length === 0 ? (
          <p>No one is booked yet.</p>
        ) : (
          <div className="group-attendee-cards">
            {selectedGroupSessionAttendees.map((appointment) => (
              <article
                key={appointment.id}
                className="group-attendee-card"
                style={{
                  border: "1px solid color-mix(in srgb, var(--muted) 36%, transparent)",
                  borderRadius: 10,
                  padding: "8px 10px",
                  display: "grid",
                  gap: 6,
                  background: "color-mix(in srgb, var(--booking-card) 66%, transparent)",
                  opacity: isActiveGroupBooking(appointment.status) ? 1 : 0.65,
                }}
              >
                <div className="attendee-card-header" style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
                    <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {appointment.client || appointment.title}
                    </strong>
                    <span style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
                      {[
                        appointment.phone,
                        appointment.email,
                        appointment.status ? (appointment.status === "no_show" ? "No-show" : appointment.status) : "booked",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    {appointment.note ? (
                      <span style={{ color: "var(--muted)", fontSize: "0.84rem" }}>Note: {appointment.note}</span>
                    ) : null}
                  </div>
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: 999,
                      fontSize: "0.76rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.02em",
                      border: "1px solid color-mix(in srgb, var(--muted) 36%, transparent)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {appointment.status ? (appointment.status === "no_show" ? "No-show" : appointment.status) : "booked"}
                  </span>
                </div>
                {isActiveGroupBooking(appointment.status) ? (
                  <div style={{ justifySelf: "end" }}>
                    <button
                      type="button"
                      className="small-button"
                      onClick={() => cancelGroupSessionAttendee(appointment.id)}
                    >
                      Cancel attendee
                    </button>
                  </div>
                ) : (
                  <span className="muted" style={{ fontSize: "0.82rem" }}>
                    Cancelled attendee retained for history.
                  </span>
                )}
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="panel-actions">
        <button
          className="primary-button"
          disabled={selectedGroupSessionIsFull}
          onClick={(event) =>
            openQuickCreateForGroupSession({
              x: event.clientX,
              y: event.clientY,
            })
          }
          type="button"
        >
          <Plus size={16} />
          Add person
        </button>
        {selectedGroupSessionIsFull ? <p className="muted">Group is full.</p> : null}
      </div>
    </>
  ) : null;

  const selectedDetails = selectedGroupSessionDetails
    ? selectedGroupSessionDetails
    : selectedAppointmentDetails;

  if (!isEmbedMode && authStatus !== "authenticated") {
    return (
      <main className={`login-shell theme-${themeMode}`} style={brandStyle}>
        <form
          className="login-card"
          onSubmit={
            authMode === "forgot"
              ? handleForgotPassword
              : authMode === "reset"
                ? handleResetPassword
                : handleAdminLogin
          }
        >
          <div className="brand">
            <div className="brand-mark">
              <img src="/assets/clarity-golf-logo.png" alt="Clarity Golf" />
            </div>
            <div>
              <strong>Clarity Golf</strong>
              <span>Booking System</span>
            </div>
          </div>
          <div>
            <p className="eyebrow">
              {authMode === "forgot" ? "Password Reset" : authMode === "reset" ? "New Password" : "Admin Login"}
            </p>
            <h1>
              {authStatus === "checking"
                ? "Checking session"
                : authMode === "forgot"
                  ? "Forgot password"
                  : authMode === "reset"
                    ? "Reset password"
                    : "Welcome back"}
            </h1>
            <p>
              {authMode === "forgot"
                ? "Enter your admin email and we will send a reset link."
                : authMode === "reset"
                  ? "Choose a new admin password for Clarity Golf Booking."
                  : "Sign in to manage bookings, Google Calendar sync, notifications, and text hooks."}
            </p>
          </div>

          {authMode === "login" && (
            <>
              <label>
                <span>Email</span>
                <input value={adminEmail} onChange={(event) => setAdminEmail(event.target.value)} type="email" />
              </label>
              <label>
                <span>Password</span>
                <input
                  value={adminPassword}
                  onChange={(event) => setAdminPassword(event.target.value)}
                  type={showAdminPassword ? "text" : "password"}
                  autoComplete="current-password"
                />
              </label>
              <label className="show-password-toggle">
                <input
                  checked={showAdminPassword}
                  onChange={(event) => setShowAdminPassword(event.target.checked)}
                  type="checkbox"
                />
                <span>Show password</span>
              </label>
            </>
          )}

          {authMode === "forgot" && (
            <label>
              <span>Email</span>
              <input
                value={forgotEmail}
                onChange={(event) => {
                  setForgotEmail(event.target.value);
                  setForgotState("idle");
                  setForgotMessage("");
                  setAuthError("");
                }}
                type="email"
                autoComplete="email"
              />
            </label>
          )}

          {authMode === "reset" && (
            <>
              <label>
                <span>New password</span>
                <input
                  value={resetPassword}
                  onChange={(event) => setResetPassword(event.target.value)}
                  type={showResetPassword ? "text" : "password"}
                  autoComplete="new-password"
                />
              </label>
              <label>
                <span>Confirm password</span>
                <input
                  value={resetConfirmPassword}
                  onChange={(event) => setResetConfirmPassword(event.target.value)}
                  type={showResetPassword ? "text" : "password"}
                  autoComplete="new-password"
                />
              </label>
              <label className="show-password-toggle">
                <input
                  checked={showResetPassword}
                  onChange={(event) => setShowResetPassword(event.target.checked)}
                  type="checkbox"
                />
                <span>Show password</span>
              </label>
            </>
          )}

          {authError && <div className="auth-error">{authError}</div>}
          {forgotMessage && <div className="auth-success">{forgotMessage}</div>}
          <button
            className="primary-button"
            type="submit"
            disabled={
              authStatus === "checking" ||
              loginState === "signing-in" ||
              forgotState === "sending" ||
              resetState === "saving"
            }
          >
            {authStatus === "checking"
              ? "Checking"
              : authMode === "forgot"
                ? forgotState === "sending"
                  ? "Sending"
                  : forgotState === "sent"
                    ? "Sent"
                    : "Send Reset Link"
                : authMode === "reset"
                  ? resetState === "saving"
                    ? "Saving"
                    : "Save New Password"
                  : loginState === "signing-in"
                    ? "Signing In"
                    : "Sign In"}
          </button>
          {authMode === "login" ? (
            <button
              className="text-button"
              type="button"
              onClick={() => {
                setAuthMode("forgot");
                setForgotEmail(adminEmail);
                setAuthError("");
              }}
            >
              Forgot password?
            </button>
          ) : (
            <button
              className="text-button"
              type="button"
              onClick={() => {
                setAuthMode("login");
                setAuthError("");
                setForgotMessage("");
              }}
            >
              Back to sign in
            </button>
          )}
        </form>
      </main>
    );
  }

  return (
    <div className={`app-shell theme-${themeMode} ${isEmbedMode ? "embed-mode" : ""}`} style={brandStyle}>
      {!isEmbedMode && (
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <img src="/assets/clarity-golf-logo.png" alt="Clarity Golf" />
          </div>
          <div>
            <strong>Clarity Golf</strong>
            <span>Booking System</span>
          </div>
        </div>

        <nav className="side-nav" aria-label="Admin sections">
          <button className={activeView === "calendar" ? "active" : ""} onClick={() => switchView("calendar")}>
            <CalendarDays size={18} />
            Calendar
          </button>
          <button className={activeView === "clients" ? "active" : ""} onClick={() => switchView("clients")}>
            <User size={18} />
            Clients
          </button>
          <button
            className={activeView === "client-emails" ? "active" : ""}
            onClick={() => switchView("client-emails")}
          >
            <Mail size={18} />
            Client Emails
          </button>
          {billingWorkspaceEnabled && (
            <button className={activeView === "billing" ? "active" : ""} onClick={() => switchView("billing")}>
              <FileText size={18} />
              Billing
            </button>
          )}
          <button className={activeView === "settings" ? "active" : ""} onClick={() => switchView("settings")}>
            <Settings size={18} />
            Settings
          </button>
          <button className="nav-logout" onClick={handleAdminLogout}>
            <LogOut size={18} />
            Logout
          </button>
        </nav>
      </aside>
      )}

      <main className="main-panel">
        {!isEmbedMode && (
        <header className="topbar">
          <div>
            <p className="eyebrow">
              {activeView === "booking" ? "Public Booking" : activeView === "client-emails" ? "Client Emails" : activeView}
            </p>
            <h1>{activeView === "calendar" ? locationLine : sectionTitle(activeView)}</h1>
            {activeView === "calendar" ? (
              <span>
                {appointments} appointments · {blocks} blocked {blocks === 1 ? "time" : "times"}
              </span>
            ) : (
              <span>{settingsLocationLine}</span>
            )}
          </div>
          {activeView === "calendar" && (
            <div className="top-actions">
              <button className="outline-button" onClick={() => moveWeek(-1)}>
                <ArrowLeft size={16} />
                Prev
              </button>
              <button className="outline-button" onClick={() => setActiveWeekState(getCurrentWeekOffset())}>
                Today
              </button>
              <button className="outline-button" onClick={() => moveWeek(1)}>
                Next
                <ArrowRight size={16} />
              </button>
            </div>
          )}
        </header>
        )}

        {!isEmbedMode && activeView === "calendar" && (
        <div
          ref={dockRef}
          className={`appointment-dock ${dockBookings.length || flyingBooking ? "has-tiles" : ""} ${
            dockFocus ? "is-focus" : ""
          }`}
        >
          <div className="dock-label" aria-hidden="true" />
          <div
            className="dock-shelf"
            aria-label={
              activeDockBooking
                ? `${activeDockBooking.client} is armed on the shelf`
                : "Appointment shelf"
            }
          >
            {flyingBooking && (
              <div
                className="dock-tile flying-to-dock"
                style={
                  {
                    "--dock-fly-x": `${flyingBooking.fromX ?? 240}px`,
                    "--dock-fly-y": `${flyingBooking.fromY ?? 120}px`,
                  } as CSSProperties
                }
              >
                <GripVertical size={14} />
                <span>
                  <strong>{flyingBooking.client}</strong>
                  <em>{services.find((candidate) => candidate.id === flyingBooking.serviceId)?.name ?? "Lesson"}</em>
                </span>
              </div>
            )}
            {dockBookings.length === 0 && !flyingBooking ? (
              <span className="dock-empty" aria-hidden="true" />
            ) : (
              dockBookings.map((booking) => {
                const service = services.find((candidate) => candidate.id === booking.serviceId);
                return (
                  <div
                    className={`dock-tile ${activeDockBookingId === booking.id ? "is-armed" : ""}`}
                    key={booking.id}
                    data-dock-booking-id={booking.id}
                    role="button"
                    tabIndex={0}
                    onPointerDown={(event) => beginDockPlacement(event, booking)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setActiveDockBookingId(booking.id);
                      }
                    }}
                  >
                    <GripVertical size={14} />
                    <span>
                      <strong>{booking.client}</strong>
                      <em>{service?.name ?? "Lesson"}</em>
                    </span>
                    <button
                      className="dock-remove"
                      aria-label={`Remove ${booking.client} from dock`}
                      onClick={(event) => {
                        event.stopPropagation();
                        removeDockBooking(booking.id);
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <X size={14} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
        )}

        {!isEmbedMode && activeView === "calendar" && (
        <section
          className={`workspace ${pointerSession?.mode === "place" || activeDockBooking ? "placing-from-dock" : ""}`}
        >
          <div
            className={`calendar-card ${calendarDetailMode ? "calendar-detail-mode" : ""}`}
            onDoubleClick={toggleCalendarDetailMode}
            onTouchStart={handleCalendarTouchStart}
          >
            <div className="calendar-toolbar">
              <h2>{weekTitle}</h2>
              <div className={`calendar-save-pill ${calendarSaveStatus}`}>
                <strong>
                  {calendarSaveStatus === "saving"
                    ? "Saving"
                    : calendarSaveStatus === "saved"
                      ? "Saved"
                      : calendarSaveStatus === "failed"
                        ? "Not saved"
                        : calendarFeedStatus === "connected"
                          ? "Live database"
                          : "Not connected"}
                </strong>
                {calendarSaveStatus === "failed" && calendarSaveError ? <span>{calendarSaveError}</span> : null}
              </div>
            </div>
            {calendarSaveStatus === "failed" && (
              <div className="calendar-save-warning">
                Your latest change was not saved. Please try again; the app will retry when you make another change.
              </div>
            )}

            <div className="calendar-header-row">
              <div className="time-gutter" />
              {weekDays.map((day) => (
                <div className={`day-heading ${day.isToday ? "today" : ""}`} key={day.label}>
                  <span>{day.short}</span>
                  <strong>{day.date}</strong>
                </div>
              ))}
            </div>

            <div className="calendar-scroll">
              <div className="time-column" style={{ height: GRID_HEIGHT }}>
                {Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, index) => {
                  const hour = START_HOUR + index;
                  return (
                    <div className="time-label" key={hour} style={{ top: index * HOUR_HEIGHT }}>
                      {hour === 12 ? "Noon" : formatTime(hour * 60).replace(":00 ", "")}
                    </div>
                  );
                })}
              </div>

              <div
                ref={gridRef}
                className={`week-grid ${pointerSession ? "is-grabbing" : ""}`}
                style={{ height: GRID_HEIGHT }}
                onPointerDown={beginBlankGesture}
                onPointerMove={updatePointer}
                onPointerUp={(event) => {
                  pointerClientRef.current = { x: event.clientX, y: event.clientY };
                  endPointer();
                }}
                onPointerCancel={(event) => {
                  pointerClientRef.current = { x: event.clientX, y: event.clientY };
                  endPointer();
                }}
                onPointerLeave={(event) => {
                  if (pointerSession) updatePointer(event);
                }}
              >
                {weekDays.map((day, dayIndex) => (
                  <div className="day-lane" key={day.label} style={{ left: `${(dayIndex / DAY_COUNT) * 100}%` }}>
                    {availability[dayIndex].map((window, index) => (
                      <div
                        className="available-band"
                        key={`${day.label}-${index}`}
                        style={{
                          top: minutesToTop(window.start),
                          height: durationToHeight(window.end - window.start),
                        }}
                      />
                    ))}
                  </div>
                ))}

                {Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, index) => (
                  <div className="hour-line" key={index} style={{ top: index * HOUR_HEIGHT }} />
                ))}

                {displayItems.map((item) => {
                  const service = itemService(item, services);
                  const activeDraft =
                    draft && (draft.mode === "move" || draft.mode === "resize") && draft.itemId === item.id
                      ? draft
                      : null;
                  const invalid = activeDraft ? !activeDraft.valid : false;
                  const top = minutesToTop(item.start);
                  const height = durationToHeight(item.duration);
                  const width = 100 / DAY_COUNT;
                  const left = item.day * width;
                  const flyAnimation = placementAnimation?.itemId === item.id ? placementAnimation : null;
                  const itemNotifications = notificationsByAppointment.get(item.id) ?? [];
                  const latestClientEmail = itemNotifications.find((notification) => notification.kind.includes("client"));
                  const latestCoachEmail = itemNotifications.find((notification) => notification.kind.includes("coach"));
                  const latestAdminEmail = itemNotifications.find((notification) => notification.kind.includes("admin"));
                  const scheduledGroupSession = isScheduledGroupSessionSlot(item);
                  const groupSessionItem = isGroupSessionItem(item);
                  const groupSessionContext = getGroupSessionContext(item);
                  const tooltipRows = [
                    groupSessionContext ? "Group Session" : item.client || item.title,
                    groupSessionContext
                      ? `Booked: ${groupSessionContext.bookedCount}/${groupSessionContext.capacity}`
                      : service?.name ?? (item.kind === "block" ? "Blocked time" : "Lesson"),
                    formatRange(item.start, item.duration),
                    latestClientEmail ? `Client email: ${notificationStatusLabel(latestClientEmail)}` : "",
                    latestCoachEmail ? `Coach email: ${notificationStatusLabel(latestCoachEmail)}` : "",
                    latestAdminEmail ? `Admin email: ${notificationStatusLabel(latestAdminEmail)}` : "",
                  ].filter(Boolean);
                  return (
                    <article
                      data-calendar-item
                      key={item.id}
                      className={`calendar-item ${item.kind} ${selectedId === item.id ? "selected" : ""} ${
                        invalid ? "invalid" : ""
	                      } ${flyAnimation ? "just-placed-from-dock" : ""} ${
	                        pointerSession?.mode === "move" && pointerSession.itemId === item.id ? "is-lifted" : ""
	                      } ${item.kind === "appointment" && item.status ? `status-${item.status}` : ""}`}
                      aria-label={tooltipRows.join(", ")}
                      onPointerEnter={(event) =>
                        showCalendarItemHover(event, item, service, latestClientEmail, latestCoachEmail, latestAdminEmail)
                      }
                      onPointerLeave={() => hideCalendarItemHover(item.id)}
                      style={{
                        top,
                        height: Math.max(height, 34),
                        left: `calc(${left}% + 6px)`,
                        width: `calc(${width}% - 12px)`,
                        ...(scheduledGroupSession ? ({ cursor: "pointer" } as CSSProperties) : {}),
                        ...(flyAnimation
                          ? ({
                              "--dock-fly-x": `${flyAnimation.fromX}px`,
                              "--dock-fly-y": `${flyAnimation.fromY}px`,
                            } as CSSProperties)
                          : {}),
                      }}
                      onPointerDown={(event) => {
                        if (scheduledGroupSession) {
                          event.stopPropagation();
                          hideCalendarItemHover();
                          return;
                        }
                        if (item.readOnly || groupSessionItem) return;
                        hideCalendarItemHover();
                        beginMove(event, item);
                      }}
                      onPointerUp={(event) => {
                        if (groupSessionItem && !scheduledGroupSession) {
                          event.preventDefault();
                          handleCalendarItemClick(event, item);
                        }
                      }}
                      onClick={(event) => {
                        if (suppressItemClickRef.current || Date.now() < suppressItemClickUntilRef.current) return;
                        if (groupSessionItem && !scheduledGroupSession) {
                          event.preventDefault();
                          event.stopPropagation();
                          handleCalendarItemClick(event, item);
                          return;
                        }
                        event.stopPropagation();
                        setSelectedGroupSession(null);
                        setSelectedId(item.id);
                        setQuickCreate(null);
                      }}
                      onKeyDown={(event) => {
                        if ((event.key === "Enter" || event.key === " ") && groupSessionItem && !scheduledGroupSession) {
                          handleCalendarItemClick(event, item);
                        }
                      }}
                    >
                      {item.readOnly ? null : (
                        <div className="item-grip" aria-hidden="true">
                          <GripVertical size={14} />
                        </div>
                        )}
                        {scheduledGroupSession ? (
                          <button
                            type="button"
                            className="outline-button"
                            onPointerDown={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                            }}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              openGroupSessionFromSlot(item);
                            }}
                          >
                            Open session
                          </button>
                        ) : null}
                        <div className="item-content">
                        <strong>{groupSessionContext ? groupSessionContext.service.name : item.kind === "appointment" ? item.client || item.title : item.title}</strong>
                        <span>{groupSessionContext ? "Group Session" : service?.name ?? "Busy"}</span>
                        <em>
                          {groupSessionContext
                            ? `${formatRange(item.start, item.duration)} · ${groupSessionContext.bookedCount}/${groupSessionContext.capacity} booked`
                            : formatRange(item.start, item.duration)}
                        </em>
                      </div>
                      {item.kind === "appointment" && (latestClientEmail || latestCoachEmail || latestAdminEmail) && (
                        <div className="item-email-indicators" aria-label="Email receipt status">
                          {latestClientEmail && (
                            <span
                              className={`email-status-dot ${notificationTone(latestClientEmail.status)}`}
                              title={`Client: ${notificationStatusLabel(latestClientEmail)}`}
                            >
                              C
                            </span>
                          )}
                          {latestCoachEmail && (
                            <span
                              className={`email-status-dot ${notificationTone(latestCoachEmail.status)}`}
                              title={`Coach: ${notificationStatusLabel(latestCoachEmail)}`}
                            >
                              O
                            </span>
                          )}
                          {latestAdminEmail && (
                            <span
                              className={`email-status-dot ${notificationTone(latestAdminEmail.status)}`}
                              title={`Admin: ${notificationStatusLabel(latestAdminEmail)}`}
                            >
                              A
                            </span>
                          )}
                        </div>
                      )}
                      {item.readOnly ? null : (
                        <button
                          className="resize-handle"
                          aria-label="Resize calendar item"
                          onPointerDown={(event) => beginResize(event, item)}
                        />
                      )}
                    </article>
                  );
                })}

                {draft?.mode === "block" && (
                  <div
                    className={`calendar-item block draft-block ${draft.valid ? "" : "invalid"}`}
                    style={{
                      top: minutesToTop(draft.start),
                      height: Math.max(durationToHeight(draft.duration), 24),
                      left: `calc(${draft.day * (100 / DAY_COUNT)}% + 6px)`,
                      width: `calc(${100 / DAY_COUNT}% - 12px)`,
                    }}
                  >
                    <div className="item-content">
                      <strong>Busy</strong>
                      <span>New blocked time</span>
                      <em>{formatRange(draft.start, draft.duration)}</em>
                    </div>
                  </div>
                )}

                {draft?.mode === "place" && pointerSession?.mode === "place" && (
                  <div
                    className={`calendar-item appointment draft-place ${draft.valid ? "" : "invalid"}`}
                    style={{
                      top: minutesToTop(draft.start),
                      height: Math.max(durationToHeight(draft.duration), 34),
                      left: `calc(${draft.day * (100 / DAY_COUNT)}% + 6px)`,
                      width: `calc(${100 / DAY_COUNT}% - 12px)`,
                    }}
                  >
                    <div className="item-grip" aria-hidden="true">
                      <GripVertical size={14} />
                    </div>
                    <div className="item-content">
                      <strong>{pointerSession.booking.client}</strong>
                      <span>
                        {services.find((service) => service.id === pointerSession.booking.serviceId)?.name ?? "Lesson"}
                      </span>
                      <em>{formatRange(draft.start, draft.duration)}</em>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {quickCreate && !hasMoved && (
              <div
                className="quick-create"
                style={quickCreatePopoverStyle()}
              >
                <button className="popover-close" aria-label="Close quick create" onClick={() => setQuickCreate(null)}>
                  <X size={15} />
                </button>
                <span>{`${weekDays[quickCreate.day].short}, ${formatTime(quickCreate.start)}`}</span>
                <strong>Quick create</strong>
                {!quickCreateService ? (
                  <>
                    {quickCreateServices.map((service) => (
                      <button key={service.id} onClick={() => selectQuickService(service.id)}>
                        <Plus size={16} />
                        <span>
                          <strong>{service.name}</strong>
                          <em>{`${service.duration} min · NZ$${service.price.toFixed(2)}`}</em>
                        </span>
                      </button>
                    ))}
                    <button onClick={createBlockFromQuick}>
                      <Clock size={16} />
                      Block 30 minutes
                    </button>
                  </>
                ) : (
                  <div className="quick-create-form">
                    <button className="quick-service-summary" onClick={backToQuickServiceChoice} type="button">
                      <span>
                        <strong>{quickCreateService.name}</strong>
                        <em>{`${quickCreateService.duration} min · NZ$${quickCreateService.price.toFixed(2)}`}</em>
                      </span>
                      <ArrowLeft size={14} />
                    </button>
                    <label>
                      <span>Name</span>
                      <div className="quick-match-anchor">
                        <div className="quick-client-search">
                          <Search size={15} />
                          <input
                            value={quickClientSearch}
                            autoComplete="name"
                            onBlur={() => setQuickMatchField("")}
                            onFocus={() => setQuickMatchField("name")}
                            onChange={(event) => {
                              setQuickMatchField("name");
                              setQuickClientSearch(event.target.value);
                              setQuickCreate((current) => (current ? { ...current, error: "" } : current));
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                confirmQuickAppointment();
                              }
                            }}
                            placeholder="Client name"
                          />
                        </div>
                        {quickClientMatchButton("name")}
                      </div>
                    </label>
                    <label>
                      <span>Phone</span>
                      <div className="quick-match-anchor">
                          <input
                            value={quickCreate.phone}
                            autoComplete="tel"
                            inputMode="tel"
                            type="tel"
                            onBlur={() => setQuickMatchField("")}
                            onFocus={() => setQuickMatchField("phone")}
                            onChange={(event) => {
                            setQuickMatchField("phone");
                            updateQuickCreateField("phone", event.target.value);
                          }}
                          placeholder="+64"
                        />
                        {quickClientMatchButton("phone")}
                      </div>
                    </label>
                    <label>
                      <span>Email</span>
                      <div className="quick-match-anchor">
                          <input
                            value={quickCreate.email}
                            autoComplete="email"
                            inputMode="email"
                            onFocus={() => setQuickMatchField("email")}
                            onBlur={() => setQuickMatchField("")}
                            onChange={(event) => {
                            setQuickMatchField("email");
                            updateQuickCreateField("email", event.target.value);
                          }}
                          placeholder="client@email.co.nz"
                          type="email"
                        />
                        {quickClientMatchButton("email")}
                      </div>
                    </label>
                    <label>
                      <span>Lesson note</span>
                      <textarea
                        value={quickCreate.note}
                        onChange={(event) => updateQuickCreateField("note", event.target.value)}
                        placeholder="Optional"
                      />
                    </label>
                    {quickCreate.error && <p className="quick-create-error">{quickCreate.error}</p>}
                    <div className="quick-create-actions">
                      <button className="outline-button" onClick={backToQuickServiceChoice} type="button">
                        <ArrowLeft size={15} />
                        Back
                      </button>
                      <button
                        className="primary-button"
                        onClick={confirmQuickAppointment}
                        disabled={!quickClientSearch.trim() || Boolean(quickCreate.error)}
                        type="button"
                      >
                        <Check size={15} />
                        Create
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

        </section>
        )}

        {!isEmbedMode && activeView === "calendar" && floatingDrag && floatingItem?.kind === "appointment" && (
          <article
            className="calendar-item appointment floating-drag-tile"
            aria-hidden="true"
            style={{
              left: floatingDrag.x,
              top: floatingDrag.y,
              width: floatingDrag.width,
              height: Math.max(floatingDrag.height, 34),
            }}
          >
            <div className="item-grip" aria-hidden="true">
              <GripVertical size={14} />
            </div>
            <div className="item-content">
              <strong>{floatingItem.title}</strong>
              <span>{floatingService?.name ?? "Lesson"}</span>
              <em>{formatRange(floatingItem.start, floatingItem.duration)}</em>
            </div>
          </article>
        )}

        {!isEmbedMode && activeView === "calendar" && calendarHover && !pointerSession && (
          <aside
            className="calendar-hover-card"
            style={{ left: calendarHover.x, top: calendarHover.y }}
            aria-hidden="true"
          >
            <span className="hover-card-kicker">
              {calendarHover.kind === "group-session" ? "Group Session" : "Appointment"}
            </span>
            <strong>{calendarHover.client}</strong>
            <em>{calendarHover.service}</em>
            <div className="hover-card-line">
              <Clock size={14} />
              <span>{calendarHover.time}</span>
            </div>
            <div className="hover-card-line">
              <MapPin size={14} />
              <span>{calendarHover.venue}</span>
            </div>
            {calendarHover.phone && (
              <div className="hover-card-line">
                <Phone size={14} />
                <span>{calendarHover.phone}</span>
              </div>
            )}
            {calendarHover.email && (
              <div className="hover-card-line">
                <Mail size={14} />
                <span>{calendarHover.email}</span>
              </div>
            )}
            <div className="hover-card-receipts">
              <span>{calendarHover.clientEmailStatus}</span>
              <span>{calendarHover.coachEmailStatus}</span>
              <span>{calendarHover.adminEmailStatus}</span>
            </div>
          </aside>
        )}

        {!isEmbedMode && activeView === "client-emails" && (
          <section className="module-page client-emails-page">
            <div className="client-email-header">
              <div>
                <span>Campaign</span>
                <h2>Client Emails / Bulk Email Lite</h2>
              </div>
              <div className="client-email-type-selector">
                {[
                  { value: "review-request", label: "Review request" },
                  { value: "haven-t-seen", label: "Haven’t seen you in a while" },
                  { value: "custom", label: "Custom" },
                ].map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={emailCampaignType === option.value ? "active" : ""}
                    onClick={() => setEmailCampaignType(option.value as EmailCampaignType)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            {!emailCampaignHasUnsubOption ? (
              <p className="client-email-warning">
                Send is currently blocked because unsubscribe / do-not-email fields are not available in the loaded client
                records.
              </p>
            ) : null}

            <div className="client-email-filters">
              <label>
                <span>Email safety filters</span>
                <p>Has email address</p>
                <div className="client-email-fixed-filter">
                  <input type="checkbox" checked readOnly disabled />
                  <em>Only clients with email</em>
                </div>
              </label>
              <label>
                <span>Do not email</span>
                <div className="client-email-fixed-filter">
                  <input type="checkbox" checked={emailCampaignHasUnsubOption} readOnly disabled />
                  <em>Exclude unsubscribed / do-not-email clients</em>
                </div>
              </label>
              <label>
                <span>Last booking</span>
                <div className="client-email-filter-inline">
                  <select
                    value={emailDateDirection}
                    onChange={(event) => setEmailDateDirection(event.target.value as CampaignDateDirection)}
                  >
                    <option value="before">Before</option>
                    <option value="after">After</option>
                  </select>
                  <input
                    type="date"
                    value={emailDateThreshold}
                    onChange={(event) => setEmailDateThreshold(event.target.value)}
                  />
                </div>
              </label>
              <label>
                <span>Total bookings</span>
                <div className="client-email-filter-inline">
                  <input
                    min="0"
                    step="1"
                    value={emailTotalBookingsMin}
                    onChange={(event) => setEmailTotalBookingsMin(event.target.value)}
                    placeholder="Min"
                    type="number"
                  />
                  <input
                    min="0"
                    step="1"
                    value={emailTotalBookingsMax}
                    onChange={(event) => setEmailTotalBookingsMax(event.target.value)}
                    placeholder="Max"
                    type="number"
                  />
                </div>
              </label>
              <label>
                <span>Remaining package lessons</span>
                {emailCampaignPackageAvailable ? (
                  <div className="client-email-filter-inline">
                    <input
                      min="0"
                      step="1"
                      value={emailPackageMin}
                      onChange={(event) => setEmailPackageMin(event.target.value)}
                      placeholder="Min"
                      type="number"
                    />
                    <input
                      min="0"
                      step="1"
                      value={emailPackageMax}
                      onChange={(event) => setEmailPackageMax(event.target.value)}
                      placeholder="Max"
                      type="number"
                    />
                  </div>
                ) : (
                  <span className="client-email-state-note">Package lesson balance is not available yet.</span>
                )}
              </label>
              <label>
                <span>Future booking</span>
                <select
                  value={emailHasFutureBooking}
                  onChange={(event) => setEmailHasFutureBooking(event.target.value as CampaignFutureFilter)}
                >
                  <option value="all">All</option>
                  <option value="has">Has future booking</option>
                  <option value="none">No future booking</option>
                </select>
              </label>
              <label>
                <span>Service type</span>
                <select
                  value={emailServiceType}
                  onChange={(event) => setEmailServiceType(event.target.value)}
                  disabled={emailCampaignAvailableServiceTypes.length === 0}
                >
                  <option value="">Any</option>
                  {emailCampaignAvailableServiceTypes.map((serviceType) => (
                    <option key={serviceType} value={serviceType}>
                      {serviceType}
                    </option>
                  ))}
                </select>
                {!emailCampaignAvailableServiceTypes.length ? (
                  <span className="client-email-state-note">Service type filter is not available yet.</span>
                ) : null}
              </label>
            </div>

            <div className="client-email-actions">
              <span>
                {emailCampaignVisibleCount} visible recipients, {emailCampaignSelectedCount} selected
              </span>
              <div className="client-email-actions-row">
                <button className="outline-button" disabled type="button">
                  Send test
                </button>
                <button className="primary-button" disabled type="button">
                  Send to selected clients
                </button>
                <button className="outline-button" disabled type="button">
                  Save draft
                </button>
              </div>
            </div>

            <div className="client-email-recipient-table-wrap">
              <table className="client-email-recipient-table">
                <thead>
                  <tr>
                    <th>Selected</th>
                    <th>Client</th>
                    <th>Email</th>
                    <th>Last booking</th>
                    <th>Total bookings</th>
                    <th>Remaining package lessons</th>
                    <th>Future booking</th>
                  </tr>
                </thead>
                <tbody>
                  {emailCampaignRecipientRows.length === 0 ? (
                    <tr>
                      <td className="client-email-empty" colSpan={7}>
                        No recipients match the current filters.
                      </td>
                    </tr>
                  ) : (
                    emailCampaignRecipientRows.map((recipient) => (
                      <tr key={recipient.id}>
                        <td>
                          <input
                            type="checkbox"
                            checked={recipient.isSelected}
                            onChange={(event) =>
                              setEmailRecipientSelection((current) => {
                                if (event.target.checked) {
                                  const next = { ...current };
                                  delete next[recipient.id];
                                  return next;
                                }
                                return { ...current, [recipient.id]: false };
                              })
                            }
                          />
                        </td>
                        <td>{recipient.name || "Unnamed client"}</td>
                        <td>{recipient.email}</td>
                        <td>{recipient.lastBookingDateLabel}</td>
                        <td>{recipient.count}</td>
                        <td>
                          {recipient.packageLessonsRemainingValue === null
                            ? "Not available yet"
                            : recipient.packageLessonsRemainingValue}
                        </td>
                        <td>{recipient.hasFutureBooking ? "Yes" : "No"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {!isEmbedMode && activeView === "clients" && (
          <section className="module-page clients-page">
            <div className="client-toolbar">
              <div className="client-search">
                <Search size={18} />
                <input
                  value={clientSearch}
                  onChange={(event) => setClientSearch(event.target.value)}
                  placeholder="Search clients"
                />
              </div>
              <button
                className={`outline-button import-client-button${showClientImport ? " active" : ""}`}
                onClick={() => setShowClientImport((current) => !current)}
                aria-label={showClientImport ? "Hide import clients" : "Import clients"}
                type="button"
              >
                <Upload size={16} />
                Import
              </button>
              <button
                className="icon-button add-client-button"
                onClick={openNewClient}
                aria-label="Add client"
                title="Add client"
              >
                <Plus size={18} />
              </button>
            </div>

            {showClientImport && (
              <article className="data-card import-card">
                <div className="data-card-header">
                  <div>
                    <span>Import</span>
                    <h2>Import clients</h2>
                  </div>
                  <Upload size={24} />
                </div>
                <textarea
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
                </div>
              </article>
            )}

            <div className="client-table">
              {filteredClients.length ? (
                filteredClients.map((client) => (
                  <button className="client-row" key={client.id} onClick={() => openClientProfile(client)}>
                    <div className="client-main">
                    <strong>{client.name}</strong>
                    <span>{client.email || "No email yet"}</span>
                  </div>
                    <span className="client-phone">{client.phone || "No phone"}</span>
                    <span className="client-booking-count">
                    {client.count} booking{client.count === 1 ? "" : "s"}
                    {(client.caddyProfileId || client.caddyProfileUrl) && <em>Linked to Caddy</em>}
                  </span>
                    <span className="client-row-arrow">
                      <ArrowRight size={17} />
                    </span>
                  </button>
                ))
              ) : (
                <div className="empty-panel compact">
                  <h2>No clients found</h2>
                  <p>Try a different name, email, or phone number.</p>
                </div>
              )}
            </div>
          </section>
        )}

        {!isEmbedMode && activeView === "billing" && (
          <section className="module-page billing-page">
            <div className="settings-tabs billing-tabs" role="tablist" aria-label="Billing sections">
              <button
                className={billingSection === "dashboard" ? "active" : ""}
                onClick={() => setBillingSection("dashboard")}
                role="tab"
                aria-selected={billingSection === "dashboard"}
                type="button"
              >
                <LayoutDashboard size={16} />
                Dashboard
              </button>
              <button
                className={billingSection === "new-invoice" ? "active" : ""}
                onClick={() => setBillingSection("new-invoice")}
                role="tab"
                aria-selected={billingSection === "new-invoice"}
                type="button"
              >
                <FileText size={16} />
                New Invoice
              </button>
              <button
                className={billingSection === "reports" ? "active" : ""}
                onClick={() => setBillingSection("reports")}
                role="tab"
                aria-selected={billingSection === "reports"}
                type="button"
              >
                <BarChart3 size={16} />
                Reports
              </button>
            </div>

            {billingSection === "dashboard" && (
              <div className="billing-dashboard">
                <div className="billing-dashboard-grid">
                  <article className="data-card">
                    <div className="data-card-header">
                      <div>
                        <span>Invoices</span>
                        <h2>Draft workspace</h2>
                      </div>
                      <FileText size={24} />
                    </div>
                    <p>Manual invoice entry is ready, with lesson type, package, product, and completed-booking line sources.</p>
                    <button className="primary-button" onClick={() => setBillingSection("new-invoice")} type="button">
                      <Plus size={16} />
                      New Invoice
                    </button>
                  </article>
                  <article className="data-card">
                    <div className="data-card-header">
                      <div>
                        <span>Completed Bookings</span>
                        <h2>Ready to pull</h2>
                      </div>
                      <CalendarDays size={24} />
                    </div>
                    <div className="completed-booking-list compact">
                      {completedAppointments.length ? (
                        completedAppointments.slice(0, 4).map((item) => {
                          const service = itemService(item, services);
                          const days = buildWeekDays(itemWeek(item));
                          return (
                            <button key={item.id} onClick={() => addCompletedBookingLine(item)} type="button">
                              <span>
                                <strong>{item.client || item.title}</strong>
                                <em>
                                  {service?.name ?? "Lesson"} - {days[item.day].label}, {formatTime(item.start)}
                                </em>
                              </span>
                              <Plus size={16} />
                            </button>
                          );
                        })
                      ) : (
                        <p>No completed bookings yet. Mark a lesson completed from the appointment details panel.</p>
                      )}
                    </div>
                  </article>
                  <article className="data-card">
                    <div className="data-card-header">
                      <div>
                        <span>Products & Services</span>
                        <h2>{catalogItems.length} invoice-only items</h2>
                      </div>
                      <Package size={24} />
                    </div>
                    <p>These live in Billing and do not affect the public booking calendar.</p>
                    <button className="outline-button" onClick={() => setBillingSection("new-invoice")} type="button">
                      Manage in New Invoice
                    </button>
                  </article>
                </div>
              </div>
            )}

            {billingSection === "new-invoice" && (
              <div className="billing-builder invoice-builder-layout">
                <article className="invoice-document-card" aria-label="Invoice editor">
                  <div className="invoice-document-header">
                    <div className="invoice-brand-block">
                      <div className="invoice-logo-mark">
                        {brandSettings.logoPreview ? (
                          <img src={brandSettings.logoPreview} alt={`${bookingBrandName} logo`} />
                        ) : (
                          <strong>{bookingBrandWords.map((word) => word[0]).join("").slice(0, 3).toUpperCase()}</strong>
                        )}
                      </div>
                      <div>
                        <strong>{coachAccount.businessName}</strong>
                        <span>{coachAccount.contactEmail}</span>
                        {invoiceSettings.businessAddress && <span>{invoiceSettings.businessAddress}</span>}
                      </div>
                    </div>
                    <div className="invoice-title-block">
                      <span>Invoice</span>
                      <h2>{activeInvoiceNumber}</h2>
                      {sentInvoiceNumber === confirmedInvoiceNumber && confirmedInvoiceNumber ? (
                        <em>Sent</em>
                      ) : confirmedInvoiceNumber ? (
                        <em>Confirmed</em>
                      ) : (
                        <em>Draft</em>
                      )}
                    </div>
                  </div>

                  {(hasMissingInvoiceCoachSettings || latestVoidedInvoiceNumber) && (
                    <div className="invoice-document-alerts">
                      {latestVoidedInvoiceNumber && <span>{latestVoidedInvoiceNumber} voided</span>}
                      {hasMissingInvoiceCoachSettings && (
                        <button className="outline-button small-action" onClick={openInvoiceCoachSettings} type="button">
                          <Settings size={15} />
                          Coach Account
                        </button>
                      )}
                    </div>
                  )}

                  {invoiceSettings.headerText && <p className="invoice-template-note">{invoiceSettings.headerText}</p>}

                  <section className="invoice-section">
                    <div className="invoice-section-heading">
                      <span>Customer</span>
                    </div>
                    {hasInvoiceCustomer ? (
                      <div className="invoice-customer-settled">
                        <div>
                          <span>Bill to</span>
                          <strong>{invoiceDraft.payerName || invoiceDraft.payerEmail}</strong>
                          {invoiceDraft.payerEmail && <em>{invoiceDraft.payerEmail}</em>}
                          {invoiceDraft.payerPhone && <em>{invoiceDraft.payerPhone}</em>}
                        </div>
                        <button className="outline-button small-action" onClick={clearInvoiceCustomer} type="button">
                          Change
                        </button>
                      </div>
                    ) : (
                      <div className="invoice-customer-search">
                        <label className="settings-field">
                          <span>Find or create customer</span>
                          <input
                            value={invoiceCustomerSearch}
                            onChange={(event) => setInvoiceCustomerSearch(event.target.value)}
                            placeholder="Search name, email, or phone"
                          />
                        </label>
                        {(invoiceCustomerMatches.length > 0 || invoiceCustomerCreateLabel) && (
                          <div className="invoice-customer-results">
                            {invoiceCustomerMatches.map((person) => (
                              <button key={person.id} onClick={() => selectInvoiceCustomer(person)} type="button">
                                <span>
                                  <strong>{person.name}</strong>
                                  <em>{person.email || person.phone || "No contact saved"}</em>
                                </span>
                                <Plus size={16} />
                              </button>
                            ))}
                            {invoiceCustomerCreateLabel && (
                              <button onClick={createInvoiceCustomerFromSearch} type="button">
                                <span>
                                  <strong>Create new customer</strong>
                                  <em>{invoiceCustomerCreateLabel}</em>
                                </span>
                                <Plus size={16} />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </section>

                  <section className="invoice-section">
                    <div className="invoice-section-heading">
                      <span>Invoice details</span>
                    </div>
                    <div className="invoice-form-grid invoice-detail-grid">
                      <label className="settings-field">
                        <span>Invoice date</span>
                        <input
                          value={invoiceDraft.invoiceDate}
                          onChange={(event) => updateInvoiceDraft("invoiceDate", event.target.value)}
                          type="date"
                        />
                      </label>
                      <label className="settings-field">
                        <span>Due date</span>
                        <input
                          value={invoiceDraft.dueDate}
                          onChange={(event) => updateInvoiceDraft("dueDate", event.target.value)}
                          type="date"
                        />
                      </label>
                      <label className="settings-field">
                        <span>Currency</span>
                        <input value={invoiceSettings.currency} readOnly />
                      </label>
                      <label className="settings-field">
                        <span>Reference</span>
                        <input
                          value={invoiceDraft.reference}
                          onChange={(event) => updateInvoiceDraft("reference", event.target.value)}
                          placeholder="Optional"
                        />
                      </label>
                    </div>
                  </section>

                  <div className="invoice-custom-fields">
                    {invoiceSettings.customFields
                      .filter((field) => field.placement === "header" || field.placement === "bill-to")
                      .map((field) => (
                        <span key={field.id}>
                          <strong>{field.label}</strong>
                          {field.value || "Not set"}
                        </span>
                      ))}
                  </div>

                  <section className="invoice-section invoice-items-section">
                    <div className="invoice-section-heading invoice-items-heading">
                      <div>
                        <span>Items</span>
                        <strong>
                          {invoiceDraft.lines.length
                            ? `${invoiceDraft.lines.length} line item${invoiceDraft.lines.length === 1 ? "" : "s"}`
                            : "No items yet"}
                        </strong>
                      </div>
                      <button
                        className="outline-button"
                        onClick={() => {
                          updateInvoiceDraft("lineSearch", "");
                          setShowInvoiceLinePicker((current) => !current);
                        }}
                        type="button"
                      >
                        <Plus size={16} />
                        Add line item
                      </button>
                    </div>

                    {showInvoiceLinePicker && (
                      <div className="invoice-line-picker">
                        <div className="invoice-line-search">
                          <label className="settings-field">
                            <span>Find or add item</span>
                            <input
                              value={invoiceDraft.lineSearch}
                              onChange={(event) => updateInvoiceDraft("lineSearch", event.target.value)}
                              placeholder="Search lesson types, packages, products, services..."
                              autoFocus
                            />
                          </label>
                          <button className="outline-button" onClick={addManualInvoiceLine} type="button">
                            <Plus size={16} />
                            Add Custom
                          </button>
                          <button
                            className="icon-button"
                            onClick={() => {
                              updateInvoiceDraft("lineSearch", "");
                              setShowInvoiceLinePicker(false);
                            }}
                            aria-label="Close line item search"
                            type="button"
                          >
                            <X size={16} />
                          </button>
                        </div>

                        {visibleInvoiceCatalogOptions.length > 0 && (
                          <div className="invoice-option-list">
                            {visibleInvoiceCatalogOptions.map((item) => (
                              <button key={item.id} onClick={() => addCatalogInvoiceLine(item)} type="button">
                                <span>
                                  <strong>{item.name}</strong>
                                  <em>
                                    {item.kind.replace("-", " ")} - {formatMoney(item.price, invoiceSettings.currency)}
                                  </em>
                                </span>
                                <Plus size={16} />
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="invoice-document-lines" aria-label="Invoice lines">
                      <div className="invoice-document-line-head">
                        <span>Item</span>
                        <span>Qty</span>
                        <span>Unit price</span>
                        <span>Amount</span>
                        <span />
                      </div>
                      {invoiceDraft.lines.map((line) => (
                        <div className="invoice-document-line-row" key={line.id}>
                          <label className="settings-field">
                            <span>Line item</span>
                            <input
                              value={line.description}
                              onChange={(event) => updateInvoiceLine(line.id, "description", event.target.value)}
                              placeholder="Lesson, package, product, or service"
                            />
                          </label>
                          <label className="settings-field">
                            <span>Qty</span>
                            <input
                              value={line.quantity}
                              inputMode="numeric"
                              onChange={(event) => updateInvoiceLine(line.id, "quantity", parseQuantityInput(event.target.value))}
                              type="text"
                            />
                          </label>
                          <label className="settings-field">
                            <span>Unit price</span>
                            <input
                              value={line.unitPrice}
                              inputMode="decimal"
                              onChange={(event) => updateInvoiceLine(line.id, "unitPrice", parseMoneyInput(event.target.value))}
                              type="text"
                            />
                          </label>
                          <strong>{formatMoney(line.quantity * line.unitPrice, invoiceSettings.currency)}</strong>
                          <button
                            className="invoice-line-delete-tab"
                            onClick={() => removeInvoiceLine(line.id)}
                            aria-label="Delete line item"
                            title="Delete line item"
                            type="button"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      ))}
                      {!invoiceDraft.lines.length && (
                        <div className="invoice-empty-line">
                          <span>Use Add line item or pull a completed booking.</span>
                        </div>
                      )}
                    </div>
                  </section>

                  <section className="invoice-section invoice-settlement-section">
                    <div className="invoice-note-block">
                      <label className="settings-field">
                        <span>Customer note</span>
                        <textarea
                          value={invoiceDraft.message}
                          onChange={(event) => updateInvoiceDraft("message", event.target.value)}
                          rows={3}
                        />
                      </label>
                      <div className="invoice-payment-block">
                        <span>Payment</span>
                        <p>{invoiceSettings.paymentInstructions}</p>
                        {invoiceSettings.bankAccount && <strong>{invoiceSettings.bankAccount}</strong>}
                        {invoiceSettings.taxNumber && <em>{invoiceSettings.taxName} No. {invoiceSettings.taxNumber}</em>}
                        {invoiceSettings.customFields
                          .filter((field) => field.placement === "payment")
                          .map((field) => (
                            <em key={field.id}>
                              {field.label}: {field.value || "Not set"}
                            </em>
                          ))}
                      </div>
                    </div>

                    <div className="invoice-total-box">
                      <div className="invoice-discount-controls">
                        <label className="settings-field">
                          <span>Discount / coupon</span>
                          <input
                            value={invoiceDraft.discountLabel}
                            onChange={(event) => updateInvoiceDraft("discountLabel", event.target.value)}
                            placeholder="Optional"
                          />
                        </label>
                        <label className="settings-field">
                          <span>Amount</span>
                          <input
                            value={invoiceDraft.discountAmount}
                            inputMode="decimal"
                            onChange={(event) => updateInvoiceDraft("discountAmount", parseMoneyInput(event.target.value))}
                            type="text"
                          />
                        </label>
                      </div>
                      <div className="invoice-total-lines">
                        <span>
                          <em>Subtotal</em>
                          <strong>{formatMoney(invoiceLineSubtotal, invoiceSettings.currency)}</strong>
                        </span>
                        {(invoiceDiscountTotal > 0 || invoiceDraft.discountLabel.trim()) && (
                          <span>
                            <em>{invoiceDiscountLabel}</em>
                            <strong>-{formatMoney(invoiceDiscountTotal, invoiceSettings.currency)}</strong>
                          </span>
                        )}
                        <span>
                          <em>
                            {invoiceSettings.taxName} ({invoiceSettings.taxRate}%)
                          </em>
                          <strong>{formatMoney(invoiceTaxTotal, invoiceSettings.currency)}</strong>
                        </span>
                        <span className="invoice-grand-total">
                          <em>Total</em>
                          <strong>{formatMoney(invoiceTotal, invoiceSettings.currency)}</strong>
                        </span>
                      </div>
                    </div>
                  </section>

                  <div className="invoice-custom-fields invoice-footer-fields">
                    {invoiceSettings.customFields
                      .filter((field) => field.placement === "footer")
                      .map((field) => (
                        <span key={field.id}>
                          <strong>{field.label}</strong>
                          {field.value || "Not set"}
                        </span>
                      ))}
                  </div>
                  <p className="invoice-footer">{invoiceSettings.footerText}</p>

                  <div className="invoice-actions invoice-bottom-actions">
                    <button className="outline-button" onClick={resetInvoiceDraft} type="button">
                      Reset Draft
                    </button>
                    {confirmedInvoiceNumber && (
                      <>
                        <button
                          className="outline-button"
                          onClick={() => setToast({ message: "PDF download hooks into this invoice preview next." })}
                          type="button"
                        >
                          <Download size={16} />
                          Download PDF
                        </button>
                        <button
                          className="outline-button"
                          disabled={sentInvoiceNumber === confirmedInvoiceNumber}
                          onClick={markConfirmedInvoiceSent}
                          type="button"
                        >
                          <Send size={16} />
                          {sentInvoiceNumber === confirmedInvoiceNumber ? "Sent" : "Send Email"}
                        </button>
                        <a className="outline-button" href={gmailComposeUrl} target="_blank" rel="noreferrer">
                          <Mail size={16} />
                          Gmail Draft
                        </a>
                      </>
                    )}
                    <button className="primary-button" disabled={Boolean(confirmedInvoiceNumber)} onClick={issueInvoiceDraft} type="button">
                      {confirmedInvoiceNumber ? "Invoice Confirmed" : "Confirm Invoice"}
                    </button>
                  </div>
                </article>

                <aside className="invoice-side-panel">
                  <section className="data-card completed-bookings-card">
                    <div className="data-card-header">
                      <div>
                        <span>Calendar Pull</span>
                        <h2>Completed bookings</h2>
                      </div>
                      <CalendarDays size={24} />
                    </div>
                    <div className="completed-booking-list">
                      {completedAppointments.length ? (
                        completedAppointments.map((item) => {
                          const service = itemService(item, services);
                          const days = buildWeekDays(itemWeek(item));
                          return (
                            <button key={item.id} onClick={() => addCompletedBookingLine(item)} type="button">
                              <span>
                                <strong>{item.client || item.title}</strong>
                                <em>
                                  {service?.name ?? "Lesson"} - {days[item.day].label}, {formatRange(item.start, item.duration)}
                                </em>
                              </span>
                              <Plus size={16} />
                            </button>
                          );
                        })
                      ) : (
                        <p>Mark bookings completed from the calendar to pull them into invoices.</p>
                      )}
                    </div>
                  </section>

                  <section className="data-card completed-bookings-card">
                    <div className="data-card-header">
                      <div>
                        <span>Catalog</span>
                        <h2>Products & Services</h2>
                      </div>
                      <Package size={24} />
                    </div>
                    <div className="billing-catalog-editor">
                      <label className="settings-field">
                        <span>Name</span>
                        <input
                          value={catalogEditor.name}
                          onChange={(event) => setCatalogEditor((current) => ({ ...current, name: event.target.value }))}
                          placeholder="Product or service"
                        />
                      </label>
                      <div className="service-form-row">
                        <label className="settings-field">
                          <span>Kind</span>
                          <select
                            value={catalogEditor.kind}
                            onChange={(event) =>
                              setCatalogEditor((current) => ({
                                ...current,
                                kind: event.target.value === "product" ? "product" : "service",
                              }))
                            }
                          >
                            <option value="service">Service</option>
                            <option value="product">Product</option>
                          </select>
                        </label>
                        <label className="settings-field">
                          <span>Price</span>
                          <input
                            value={catalogEditor.price}
                            inputMode="decimal"
                            onChange={(event) =>
                              setCatalogEditor((current) => ({ ...current, price: parseMoneyInput(event.target.value) }))
                            }
                            type="text"
                          />
                        </label>
                      </div>
                      <button className="outline-button" onClick={addCatalogItem} type="button">
                        <Plus size={16} />
                        Add Product/Service
                      </button>
                    </div>
                  </section>
                </aside>
              </div>
            )}

            {billingSection === "reports" && (
              <div className="billing-reports">
                <article className="data-card">
                  <span>Revenue</span>
                  <h2>By item source</h2>
                  <div className="settings-summary-grid">
                    <span>
                      <strong>{services.filter((service) => service.lessonFormat !== "package").length}</strong>
                      lesson types
                    </span>
                    <span>
                      <strong>{packageServices.length}</strong>
                      package types
                    </span>
                    <span>
                      <strong>{catalogItems.length}</strong>
                      products/services
                    </span>
                  </div>
                </article>
                <article className="data-card">
                  <span>Reconciliation</span>
                  <h2>Package dots coming next</h2>
                  <p>
                    Reports will read completed bookings, invoice-linked coverage, and manual coverage to classify green,
                    blue, orange, grey, and red package slots.
                  </p>
                </article>
                <article className="data-card">
                  <span>Uninvoiced</span>
                  <h2>{completedUninvoicedCount} completed lessons</h2>
                  <p>These are ready to pull into a manual invoice without making calendar pull the only workflow.</p>
                </article>
              </div>
            )}
          </section>
        )}

        {isEmbedMode && activeView === "booking" && (
          <section className={`public-booking booking-theme-${brandSettings.bookingTheme} module-page`}>
            <div className={`booking-brand ${showBookingBrandLogo ? "" : "booking-brand-subtle"}`}>
              {showBookingBrandLogo && brandSettings.logoPreview ? (
                <img src={brandSettings.logoPreview} alt={`${bookingBrandName} logo`} />
              ) : showBookingBrandLogo ? (
                <>
                  <strong>{bookingBrandPrimary.toUpperCase()}</strong>
                  {bookingBrandSecondary && <span>{bookingBrandSecondary.toUpperCase()}</span>}
                </>
              ) : (
                <strong>{bookingBrandName}</strong>
              )}
              <em>{coachAccount.venueShortName}</em>
            </div>

            <div className="booking-toolbar" role="tablist" aria-label="Booking action">
              <button
                className={`booking-hero-action ${bookingMode === "book" ? "active" : ""}`}
                onClick={() => changeBookingMode("book")}
                type="button"
              >
                <CalendarDays size={16} />
                <span>Book a lesson</span>
              </button>
              <button
                className={`booking-login-trigger ${bookingMode === "reschedule" ? "active" : ""}`}
                onClick={() => changeBookingMode("reschedule", true)}
                type="button"
              >
                <KeyRound size={14} />
                <span>Sign in</span>
              </button>
            </div>

            {bookingConfirmation ? (
              <div className="booking-confirmed">
                <span>
                  {bookingConfirmation.kind === "booking"
                    ? "Appointment Confirmed"
                    : bookingConfirmation.kind === "cancelled"
                      ? "Booking Cancelled"
                      : "Appointment Updated"}
                </span>
                <h2>
                  {bookingConfirmation.kind === "booking"
                    ? "Booking confirmed"
                    : bookingConfirmation.kind === "cancelled"
                      ? "Cancellation confirmed"
                      : "Reschedule confirmed"}
                </h2>
                <div className="booking-confirmed-summary">
                  <strong>{bookingConfirmation.service}</strong>
                  <em>
                    {bookingConfirmation.dayLabel}, {bookingConfirmation.timeLabel}
                  </em>
                  <p>{coachAccount.venueName}</p>
                </div>
                {bookingConfirmation.notifications.some((result) => result.channel === "client") && (
                  <div className="email-status-list">
                    {bookingConfirmation.notifications
                      .filter((result) => result.channel === "client")
                      .map((result, index) => {
                        const tone = emailResultTone(result);
                        return (
                          <div className={`email-status ${tone}`} key={`client-${index}`}>
                            {tone === "sent" ? <Check size={17} /> : tone === "failed" ? <X size={17} /> : <Mail size={17} />}
                            <span>
                              Client email: {tone === "sent" ? "sent" : tone}
                              {result.recipient ? ` to ${result.recipient}` : ""}
                              {result.reason || result.error ? ` · ${(result.reason || result.error || "").replaceAll("_", " ")}` : ""}
                            </span>
                          </div>
                        );
                      })}
                  </div>
                )}
                {bookingConfirmation.kind !== "cancelled" && (
                  <div className="calendar-add-actions">
                    <a className="outline-button" href={googleCalendarUrl(bookingConfirmation)} target="_blank" rel="noreferrer">
                      <CalendarDays size={16} />
                      Google Calendar
                    </a>
                    <button className="outline-button" onClick={() => downloadAppleCalendarInvite(bookingConfirmation)} type="button">
                      <Download size={16} />
                      Apple Calendar
                    </button>
                    {bookingLoginUrl && (
                      <a className="outline-button" href={bookingLoginUrl}>
                        <KeyRound size={16} />
                        Manage / Reschedule
                      </a>
                    )}
                  </div>
                )}
                <button
                  className="primary-button confirm-booking"
	                  onClick={() => {
	                    setBookingConfirmation(null);
	                    setBookingMode("book");
	                    setEmailNoticeVisible(false);
	                  }}
                  type="button"
                >
                  {bookingConfirmation.kind === "cancelled" ? "Back to booking" : "Book another lesson"}
                </button>
              </div>
            ) : (
            <div className="booking-columns booking-progressive-flow">
              {bookingMode === "book" ? (
                <>
                  <section className={`booking-progressive-section ${isAppointmentSectionOpen ? "is-open" : ""} ${
                    isAppointmentStepComplete ? "is-complete" : ""
                  }`}>
                    <button
                      className="booking-progressive-title"
                      onClick={() => setPublicBookingSection("appointment")}
                      type="button"
                    >
                      <span className="booking-progressive-title-label">1. Appointment</span>
                      <span className="booking-progressive-title-state">{isAppointmentStepComplete ? "Done" : "In progress"}</span>
                    </button>
                    {isAppointmentSectionOpen ? (
                      <div className="booking-progressive-body">
                        <div className="service-picker">
                          {visiblePublicServices.length ? (
                            visiblePublicServices.map((service) => (
                              <button
                                className={service.id === bookingServiceId ? "selected-service" : ""}
                                key={service.id}
                                onClick={() => handlePublicBookingServiceSelect(service.id)}
                                type="button"
                              >
                                <strong>{service.name}</strong>
                                <em>
                                  {service.duration} minutes @ {servicePriceLabel(service)}
                                </em>
                                {service.description && <small>{service.description}</small>}
                              </button>
                            ))
                          ) : (
                            <p>No public lesson types are active.</p>
                          )}
                        </div>
                      </div>
                    ) : isAppointmentStepComplete ? (
                      <button
                      className="booking-summary booking-progressive-summary"
                      onClick={() => setPublicBookingSection("appointment")}
                      type="button"
                    >
                      <strong>{appointmentSummaryName}</strong>
                      <span>{appointmentSummaryDuration}</span>
                      {appointmentSummaryDescription ? <small>{appointmentSummaryDescription}</small> : null}
                    </button>
                  ) : (
                      <button
                        className="booking-progressive-summary booking-progressive-summary-empty"
                        onClick={() => setPublicBookingSection("appointment")}
                        type="button"
                      >
                        <strong>Appointment not selected</strong>
                        <span>Pick a lesson to continue</span>
                      </button>
                    )}
                  </section>

                  <section className={`booking-progressive-section ${isDateTimeSectionOpen ? "is-open" : ""} ${
                    isDateTimeStepComplete ? "is-complete" : ""
                  }`}>
                    <button
                      className="booking-progressive-title"
                      onClick={() => setPublicBookingSection("datetime")}
                      type="button"
                      disabled={!isAppointmentStepComplete}
                    >
                      <span className="booking-progressive-title-label">2. Date & Time</span>
                      <span className="booking-progressive-title-state">
                        {isDateTimeStepComplete ? "Done" : isAppointmentStepComplete ? "In progress" : "Locked"}
                      </span>
                    </button>
                    {isDateTimeSectionOpen ? (
                      <div className="booking-progressive-body">
                        <div className="booking-week-controls">
                          <button onClick={() => moveWeek(-1)} type="button">
                            <ArrowLeft size={15} />
                            <span>Previous week</span>
                          </button>
                          <strong>{weekTitle}</strong>
                          <button onClick={() => moveWeek(1)} type="button">
                            <span>Next week</span>
                            <ArrowRight size={15} />
                          </button>
                        </div>
                        {!isGroupBookingTimeSelection ? (
                          <div className="booking-days-wrap">
                            <div className="booking-days">
                              {weekDays.map((day, index) => (
                                <button
                                  className={bookingDaySelected && bookingDay === index ? "selected-day" : ""}
                                  key={day.label}
                                  onClick={() => handlePublicBookingDaySelect(index)}
                                  type="button"
                                >
                                  <strong>{day.short}</strong>
                                  <em>{day.date}</em>
                                  {day.isToday ? <small className="booking-day-marker">Today</small> : null}
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        <div className="time-slots">
                          {selectedBookingService ? (
                            bookingSlots.length ? (
                              visibleBookingSlots.map((slot) => {
                                const slotLabel = isGroupBookingTimeSelection
                                  ? `${dateForSlot(slot.week, slot.day).toLocaleDateString("en-NZ", { weekday: "short", month: "short", day: "numeric" })} · ${formatTime(slot.start)} · ${slot.remainingSpots} spot${slot.remainingSpots === 1 ? "" : "s"} left`
                                  : formatTime(slot.start);
                                return (
                                  <button
                                    className={bookingStart === slot.start ? "selected-time" : ""}
                                    key={`${slot.week}-${slot.day}-${slot.start}`}
                                    onClick={() => handlePublicBookingTimeSelect(slot)}
                                    type="button"
                                  >
                                    {slotLabel}
                                  </button>
                                );
                              })
                            ) : (
                              <p>
                                {isGroupBookingTimeSelection
                                  ? "No upcoming group lesson times are available yet."
                                  : bookingDaySelected
                                    ? "No public times available for this day."
                                    : "Choose a day first."}
                              </p>
                            )
                          ) : (
                            <p>Choose an appointment type first.</p>
                          )}
                        </div>
                      </div>
                    ) : isDateTimeStepComplete ? (
                      <button
                      className="booking-summary booking-progressive-summary"
                      onClick={() => setPublicBookingSection("datetime")}
                      type="button"
                    >
                      <span>{dateTimeSummaryLine}</span>
                      {dateTimeSummaryLocation ? <small>{dateTimeSummaryLocation}</small> : null}
                    </button>
                  ) : (
                      <button
                        className="booking-progressive-summary booking-progressive-summary-empty"
                        onClick={() => setPublicBookingSection("datetime")}
                        type="button"
                        disabled={!isAppointmentStepComplete}
                      >
                        <strong>{isAppointmentStepComplete ? "Date not selected" : "Select appointment first"}</strong>
                        <span>{isAppointmentStepComplete ? "Choose day and time" : "Complete appointment step"}</span>
                      </button>
                    )}
                  </section>

                  <section className={`booking-progressive-section ${isInformationSectionOpen ? "is-open" : ""} ${
                    isInformationStepComplete ? "is-complete" : ""
                  }`}>
                    <button
                      className="booking-progressive-title"
                      onClick={() => setPublicBookingSection("information")}
                      type="button"
                      disabled={!isDateTimeStepComplete}
                    >
                      <span className="booking-progressive-title-label">3. Your Information</span>
                      <span className="booking-progressive-title-state">
              {isInformationStepComplete ? "Done" : isDateTimeStepComplete ? "In progress" : "Locked"}
            </span>
                    </button>
                    {isInformationSectionOpen ? (
                      <div className="booking-progressive-body">
                        <div className="booking-form">
                          <input
                            value={bookingForm.firstName}
                            autoComplete="given-name"
                            onChange={(event) => updateBookingForm("firstName", event.target.value)}
                            onKeyDown={handleBookingMatchKeyDown}
                            placeholder="First name"
                          />
                          <input
                            value={bookingForm.lastName}
                            autoComplete="family-name"
                            onChange={(event) => updateBookingForm("lastName", event.target.value)}
                            onKeyDown={handleBookingMatchKeyDown}
                            placeholder="Last name"
                          />
                          <input
                            value={bookingForm.phone}
                            autoComplete="tel"
                            inputMode="tel"
                            onChange={(event) => updateBookingForm("phone", event.target.value)}
                            onKeyDown={handleBookingMatchKeyDown}
                            placeholder="Phone"
                            type="tel"
                          />
                          <input
                            value={bookingForm.email}
                            autoComplete="email"
                            inputMode="email"
                            onChange={(event) => updateBookingForm("email", event.target.value)}
                            onKeyDown={handleBookingMatchKeyDown}
                            placeholder="Email"
                            type="email"
                          />
                        </div>
                        {bookingClientSuggestion && showBookingClientSuggestion && (
                          <button
                            className="client-match-prompt booking-client-match"
                            onClick={() => applyBookingClient(bookingClientSuggestion)}
                            type="button"
                          >
                            <User size={15} />
                            <span>
                              <strong>{bookingClientSuggestion.name}</strong>
                              <em>{[bookingClientSuggestion.phone, bookingClientSuggestion.email].filter(Boolean).join(" · ")}</em>
                            </span>
                          </button>
                        )}
                        <div className="booking-summary">
                          <strong>{selectedBookingService?.name ?? "Choose appointment type"}</strong>
                          <span>
                            {!selectedBookingService
                              ? "Select a lesson to see available times"
                              : bookingStart === null
                              ? "Choose a time"
                              : `${weekDays[bookingDay].label}, ${formatTime(bookingStart)}`}
                          </span>
                        </div>
                        {bookingSubmitState === "saving" && <div className="booking-save-progress" aria-label="Saving booking" />}
                        <button
                          className="primary-button confirm-booking"
                          disabled={!selectedBookingService || bookingStart === null || bookingSubmitState === "saving"}
                          onClick={confirmPublicBooking}
                          type="button"
                        >
                          {bookingSubmitState === "saving" ? "Confirming..." : "Confirm Appointment"}
                        </button>
                      </div>
                    ) : isInformationStepComplete ? (
                      <button
                      className="booking-summary booking-progressive-summary"
                      onClick={() => setPublicBookingSection("information")}
                      type="button"
                    >
                      <strong>Information complete</strong>
                      <span>Customer details captured</span>
                    </button>
                  ) : (
                      <button
                        className="booking-progressive-summary booking-progressive-summary-empty"
                        onClick={() => setPublicBookingSection("information")}
                        type="button"
                        disabled={!isDateTimeStepComplete}
                      >
                        <strong>{isDateTimeStepComplete ? "Customer details missing" : "Complete time step first"}</strong>
                        <span>{isDateTimeStepComplete ? "Enter your details to confirm" : "Lock a time first"}</span>
                      </button>
                    )}
                  </section>
                </>
              ) : (
                <>
                  {showRescheduleLoginPanel ? (
                  <div className="booking-card">
                    <span>Booking Login</span>
                    <div className="booking-login-copy">
                      <strong>Use the link from your email, or enter the original details once.</strong>
                      <em>Your browser can keep this saved for next time.</em>
                    </div>
                    <div className="booking-form">
                      <input
                        value={rescheduleForm.email}
                        autoComplete="email"
                        inputMode="email"
                        onChange={(event) => updateRescheduleForm("email", event.target.value)}
                        placeholder="Email"
                        type="email"
                      />
                      <input
                        value={rescheduleForm.phone}
                        autoComplete="tel"
                        inputMode="tel"
                        onChange={(event) => updateRescheduleForm("phone", event.target.value)}
                        placeholder="Phone"
                        type="tel"
                      />
                    </div>
                    {hasSavedRescheduleLogin && (
                      <button
                        className="outline-button booking-login-clear"
                        onClick={() => {
                          window.localStorage.removeItem(RESCHEDULE_LOGIN_STORAGE_KEY);
                          initialRescheduleLoginRef.current = null;
                          setForceRescheduleLogin(true);
                          setRescheduleForm({ email: "", phone: "" });
                          setRescheduleMatches([]);
                          setSelectedRescheduleId("");
                          setBookingStart(null);
                        }}
                        type="button"
                      >
                        Forget saved login
                      </button>
                    )}
                    <button
                      className="primary-button confirm-booking"
                      disabled={rescheduleState === "checking"}
                      onClick={() => {
                        void lookupPublicReschedule();
                      }}
                      type="button"
                    >
                      {rescheduleState === "checking" ? "Checking..." : "Find Booking"}
                    </button>
                    {rescheduleMatches.length > 0 && (
                      <div className="service-picker reschedule-list">
                        {rescheduleMatches.map((match) => (
                          <button
                            className={selectedRescheduleId === match.id ? "selected-service" : ""}
                            key={match.id}
                            onClick={() => selectRescheduleMatch(match)}
                            type="button"
                          >
                            <strong>{match.serviceName}</strong>
                            <em>{describeRescheduleMatch(match)}</em>
                            <small>{match.client}</small>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  ) : (
                    <div className="booking-card reschedule-link-state">
                      <span>Manage Booking</span>
                      <div className="booking-login-copy">
                        <strong>
                          {selectedRescheduleMatch
                            ? selectedRescheduleMatch.client
                            : rescheduleState === "checking"
                            ? "Opening your booking..."
                            : "Booking link opened"}
                        </strong>
                        <em>
                          {selectedRescheduleMatch
                            ? describeRescheduleMatch(selectedRescheduleMatch)
                            : "Choose a new time below."}
                        </em>
                      </div>
                    </div>
                  )}

                  <div className="booking-card">
                    <span>New Date & Time</span>
                    <div className="booking-week-controls">
                      <button onClick={() => moveWeek(-1)} type="button">
                        <ArrowLeft size={15} />
                        <span>Previous week</span>
                      </button>
                      <strong>{weekTitle}</strong>
                      <button onClick={() => moveWeek(1)} type="button">
                        <span>Next week</span>
                        <ArrowRight size={15} />
                      </button>
                    </div>
                    <div className="booking-days">
                      {weekDays.map((day, index) => (
                        <button
                          className={bookingDay === index ? "selected-day" : ""}
                          disabled={!selectedRescheduleMatch}
                          key={day.label}
                          onClick={() => {
                            setBookingDay(index);
                            setBookingStart(null);
                          }}
                        >
                          <strong>{day.short}</strong>
                          <em>{day.date}</em>
                        </button>
                      ))}
                    </div>
                    <div className="time-slots">
                      {selectedRescheduleMatch ? (
                        bookingSlots.length ? (
                          bookingSlots.map((slot) => (
                            <button
                              className={bookingStart === slot.start ? "selected-time" : ""}
                              key={`${slot.week}-${slot.day}-${slot.start}`}
                              onClick={() => setBookingStart(slot.start)}
                            >
                              {formatTime(slot.start)}
                            </button>
                          ))
                        ) : (
                          <p>No public times available for this day.</p>
                        )
                      ) : (
                        <p>Find your booking first, then choose a new time.</p>
                      )}
                    </div>
                  </div>

                  <div className="booking-card">
                    <span>Confirm Change</span>
                    <div className="booking-summary">
                      <strong>{selectedRescheduleMatch?.serviceName ?? "No booking selected"}</strong>
                      <span>
                        {selectedRescheduleMatch
                          ? `Current: ${describeRescheduleMatch(selectedRescheduleMatch)}`
                          : "Use your original email and phone to find the booking."}
                      </span>
                      <span>
                        {bookingStart === null
                          ? "Choose a new time"
                          : `New: ${weekDays[bookingDay].label}, ${formatTime(bookingStart)}`}
                      </span>
                    </div>
                    <button
                      className="primary-button confirm-booking"
                      disabled={!selectedRescheduleMatch || bookingStart === null || rescheduleState === "saving"}
                      onClick={confirmPublicReschedule}
                      type="button"
                    >
                      {rescheduleState === "saving" ? "Moving..." : "Confirm Reschedule"}
                    </button>
                    <button
                      className="danger-button public-cancel-booking"
                      disabled={!selectedRescheduleMatch || rescheduleState === "saving"}
                      onClick={confirmPublicCancellation}
                      type="button"
                    >
                      {rescheduleState === "saving" ? "Working..." : "Cancel Booking"}
                    </button>
                  </div>
                </>
              )}
            </div>
            )}

            {!isEmbedMode && (
              <div className="embed-panel">
                <div className="embed-copy">
                  <div>
                    <span>Squarespace Embed</span>
                    <h2>Booking widget iframe</h2>
                  </div>
                  <div className="embed-actions">
                    <button className="outline-button" onClick={copyEmbedCode}>
                      {copiedEmbed ? <Check size={16} /> : <Copy size={16} />}
                      {copiedEmbed ? "Copied" : "Copy iframe"}
                    </button>
                    <a className="outline-button" href={bookingWidgetUrl} target="_blank" rel="noreferrer">
                      <ExternalLink size={16} />
                      Open widget
                    </a>
                  </div>
                </div>

                <div className="embed-code">
                  <Code2 size={18} />
                  <code>{iframeCode}</code>
                </div>

                <div className="widget-preview">
                  <div className="preview-bar">
                    <strong>Widget preview</strong>
                    <span>Same booking page, iframe mode</span>
                  </div>
                  <iframe src={bookingWidgetUrl} title={`${coachAccount.businessName} booking widget preview`} />
                </div>
              </div>
            )}
          </section>
        )}

        {!isEmbedMode && activeView === "settings" && (
          <section className="module-page settings-page">
            <div className="settings-tabs" role="tablist" aria-label="Settings sections">
              <button
                className={settingsTab === "services" ? "active" : ""}
                onClick={() => setSettingsTab("services")}
                role="tab"
                aria-selected={settingsTab === "services"}
                type="button"
              >
                <ScissorsLineDashed size={16} />
                Lesson Setup
              </button>
              <button
                className={settingsTab === "availability" ? "active" : ""}
                onClick={() => setSettingsTab("availability")}
                role="tab"
                aria-selected={settingsTab === "availability"}
                type="button"
              >
                <Clock size={16} />
                Schedule
              </button>
              <button
                className={settingsTab === "experience" ? "active" : ""}
                onClick={() => setSettingsTab("experience")}
                role="tab"
                aria-selected={settingsTab === "experience"}
                type="button"
              >
                <Eye size={16} />
                Customer Experience
              </button>
              <button
                className={settingsTab === "account" ? "active" : ""}
                onClick={() => setSettingsTab("account")}
                role="tab"
                aria-selected={settingsTab === "account"}
                type="button"
              >
                <User size={16} />
                Coach Account
              </button>
              <button
                className={settingsTab === "branding" ? "active" : ""}
                onClick={() => setSettingsTab("branding")}
                role="tab"
                aria-selected={settingsTab === "branding"}
                type="button"
              >
                <Palette size={16} />
                Coach Branding
              </button>
              <button
                className={settingsTab === "integrations" ? "active" : ""}
                onClick={() => setSettingsTab("integrations")}
                role="tab"
                aria-selected={settingsTab === "integrations"}
                type="button"
              >
                <KeyRound size={16} />
                Integrations
              </button>
              <button
                className={settingsTab === "data" ? "active" : ""}
                onClick={() => setSettingsTab("data")}
                role="tab"
                aria-selected={settingsTab === "data"}
                type="button"
              >
                <Upload size={16} />
                Data
              </button>
            </div>

            <div className={`settings-grid settings-tab-${settingsTab}`}>
              {servicesSettingsPanel}
              {availabilitySettingsPanel}
              {bookingSettingsPanel}
              <article className="data-card notification-card account-card settings-section settings-account settings-branding">
                <div className="data-card-header">
                  <div>
                    <span>Coach Account</span>
                    <h2>{coachAccount.businessName}</h2>
                  </div>
                  <User size={24} />
                </div>
                <div className="account-settings-groups">
                  <details className="settings-subsection">
                    <summary className="settings-subsection-title">
                      <User size={18} />
                      <div>
                        <span>Coach</span>
                        <strong>Profile</strong>
                      </div>
                    </summary>
                    <div className="service-form-row">
                      <label className="settings-field">
                        <span>Coach name</span>
                        <input
                          value={coachAccount.coachName}
                          onChange={(event) => updateCoachAccount("coachName", event.target.value)}
                        />
                      </label>
                      <label className="settings-field">
                        <span>Business name</span>
                        <input
                          value={coachAccount.businessName}
                          onChange={(event) => updateCoachAccount("businessName", event.target.value)}
                        />
                      </label>
                    </div>
                    <label className="settings-field">
                      <span>Contact email</span>
                      <input
                        value={coachAccount.contactEmail}
                        onChange={(event) => updateCoachAccount("contactEmail", event.target.value)}
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
                        value={coachAccount.venueName}
                        onChange={(event) => updateCoachAccount("venueName", event.target.value)}
                      />
                    </label>
                    <div className="service-form-row">
                      <label className="settings-field">
                        <span>Short label</span>
                        <input
                          value={coachAccount.venueShortName}
                          onChange={(event) => updateCoachAccount("venueShortName", event.target.value)}
                        />
                      </label>
                      <label className="settings-field">
                        <span>Timezone</span>
                        <input
                          value={coachAccount.timezone}
                          onChange={(event) => updateCoachAccount("timezone", event.target.value)}
                        />
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
                        value={coachAccount.bookingUrl}
                        onChange={(event) => {
                          updateCoachAccount("bookingUrl", event.target.value);
                          setSyncBaseUrl(event.target.value);
                        }}
                      />
                    </label>
                    <div className="service-form-row">
                      <label className="settings-field">
                        <span>Calendar slug</span>
                        <input
                          value={coachAccount.calendarSlug}
                          onChange={(event) => updateCoachAccount("calendarSlug", event.target.value)}
                        />
                      </label>
                      <label className="settings-field">
                        <span>Caddy workspace</span>
                        <input
                          value={coachAccount.caddyWorkspaceUrl}
                          onChange={(event) => updateCoachAccount("caddyWorkspaceUrl", event.target.value)}
                        />
                      </label>
	                    </div>
	                  </details>

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
                          checked={invoiceSettings.enabled}
                          onChange={(event) => updateInvoiceSettings("enabled", event.target.checked)}
                          type="checkbox"
                        />
                        <span>Enable invoicing</span>
                      </label>
                      <label className="settings-toggle">
                        <input
                          checked={invoiceSettings.showBillingWorkspace}
                          onChange={(event) => updateInvoiceSettings("showBillingWorkspace", event.target.checked)}
                          type="checkbox"
                        />
                        <span>Show Billing workspace</span>
                      </label>
                    </div>
                    <div className="service-form-row">
                      <label className="settings-field">
                        <span>Invoice prefix</span>
                        <input
                          value={invoiceSettings.prefix}
                          onChange={(event) => updateInvoiceSettings("prefix", event.target.value)}
                        />
                      </label>
                      <label className="settings-field">
                        <span>Start / next number</span>
                        <input
                          value={invoiceSettings.nextNumber}
                          inputMode="numeric"
                          onChange={(event) => updateInvoiceSettings("nextNumber", parseQuantityInput(event.target.value))}
                          type="text"
                        />
                      </label>
                      <label className="settings-field">
                        <span>Currency</span>
                        <input
                          value={invoiceSettings.currency}
                          onChange={(event) => updateInvoiceSettings("currency", event.target.value)}
                        />
                      </label>
                    </div>
                    <div className="service-form-row">
                      <label className="settings-field">
                        <span>Tax label</span>
                        <input
                          value={invoiceSettings.taxName}
                          onChange={(event) => updateInvoiceSettings("taxName", event.target.value)}
                        />
                      </label>
                      <label className="settings-field">
                        <span>Tax number</span>
                        <input
                          value={invoiceSettings.taxNumber}
                          onChange={(event) => updateInvoiceSettings("taxNumber", event.target.value)}
                          placeholder="GST / tax number"
                        />
                      </label>
                      <label className="settings-field">
                        <span>Tax rate</span>
                        <input
                          value={invoiceSettings.taxRate}
                          inputMode="decimal"
                          onChange={(event) => updateInvoiceSettings("taxRate", parseMoneyInput(event.target.value))}
                          type="text"
                        />
                      </label>
                    </div>
                    <div className="service-form-row">
                      <label className="settings-field">
                        <span>Bank account</span>
                        <input
                          value={invoiceSettings.bankAccount}
                          onChange={(event) => updateInvoiceSettings("bankAccount", event.target.value)}
                        />
                      </label>
                      <label className="settings-field">
                        <span>Payment terms days</span>
                        <input
                          value={invoiceSettings.paymentTermsDays}
                          inputMode="numeric"
                          onChange={(event) => updateInvoiceSettings("paymentTermsDays", parseQuantityInput(event.target.value))}
                          type="text"
                        />
                      </label>
                    </div>
                    <label className="settings-field">
                      <span>Business address</span>
                      <textarea
                        value={invoiceSettings.businessAddress}
                        onChange={(event) => updateInvoiceSettings("businessAddress", event.target.value)}
                        rows={2}
                      />
                    </label>
                    <div className="service-form-row">
                      <label className="settings-field">
                        <span>Header text</span>
                        <textarea
                          value={invoiceSettings.headerText}
                          onChange={(event) => updateInvoiceSettings("headerText", event.target.value)}
                          rows={2}
                        />
                      </label>
                      <label className="settings-field">
                        <span>Footer text</span>
                        <textarea
                          value={invoiceSettings.footerText}
                          onChange={(event) => updateInvoiceSettings("footerText", event.target.value)}
                          rows={2}
                        />
                      </label>
                    </div>
                    <label className="settings-field">
                      <span>Payment instructions</span>
                      <textarea
                        value={invoiceSettings.paymentInstructions}
                        onChange={(event) => updateInvoiceSettings("paymentInstructions", event.target.value)}
                        rows={2}
                      />
                    </label>
                    <div className="custom-field-list">
                      <div className="services-topline">
                        <div>
                          <span>Custom fields</span>
                          <h2>Invoice fields</h2>
                        </div>
                        <button className="outline-button" onClick={addInvoiceCustomField} type="button">
                          <Plus size={16} />
                          Add Field
                        </button>
                      </div>
                      {invoiceSettings.customFields.map((field) => (
                        <div className="custom-field-row" key={field.id}>
                          <label className="settings-field">
                            <span>Label</span>
                            <input
                              value={field.label}
                              onChange={(event) => updateInvoiceCustomField(field.id, "label", event.target.value)}
                            />
                          </label>
                          <label className="settings-field">
                            <span>Value</span>
                            <input
                              value={field.value}
                              onChange={(event) => updateInvoiceCustomField(field.id, "value", event.target.value)}
                            />
                          </label>
                          <label className="settings-field">
                            <span>Placement</span>
                            <select
                              value={field.placement}
                              onChange={(event) =>
                                updateInvoiceCustomField(field.id, "placement", event.target.value as InvoiceCustomFieldPlacement)
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
                            onClick={() => removeInvoiceCustomField(field.id)}
                            type="button"
                            aria-label="Remove custom field"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
                <button className="primary-button settings-save" onClick={saveCoachAccount}>
                  {coachAccountSaveState === "saving"
                    ? "Saving"
                    : coachAccountSaveState === "saved"
                    ? "Saved"
                    : "Save Coach Account"}
                </button>
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
                    {!googleCalendar.configured
                      ? "Needs OAuth credentials"
                      : googleCalendar.connected
                        ? googleCalendar.lastSyncStatus === "failed"
                          ? "Connected, sync failed"
                          : "Connected"
                        : "Ready to connect"}
                  </strong>
                  <em>
                    {googleCalendar.lastSyncError ||
                      (googleCalendar.connected
                        ? `${googleCalendar.accountEmail || "Google account"} · ${googleSyncTimeLabel(googleCalendar.lastSyncAt)}`
                        : googleCalendar.redirectUri || "Add Google OAuth credentials in Netlify.")}
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
                      onChange={(event) => setGoogleCalendar((current) => ({ ...current, calendarId: event.target.value }))}
                      placeholder="primary or calendar email"
                    />
                  </label>
                  <label className="settings-toggle">
                    <input
                      checked={googleCalendar.autoSync}
                      onChange={(event) => void saveGoogleCalendarSettings({ autoSync: event.target.checked })}
                      type="checkbox"
                    />
                    <span>Auto-sync bookings and busy blocks after every save</span>
                  </label>
                  <div className="sync-meta">
                    <span>Redirect URI</span>
                    <code>{googleCalendar.redirectUri || "Set GOOGLE_CALENDAR_REDIRECT_URI or use /api/google-calendar/callback"}</code>
                  </div>
                  <div className="sync-actions">
                    {!googleCalendar.connected ? (
                      <button
                        className="primary-button"
                        disabled={!googleCalendar.configured || googleCalendarAction !== "idle"}
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
                          disabled={googleCalendarAction !== "idle"}
                          onClick={syncGoogleCalendarNow}
                          type="button"
                        >
                          <RefreshCw size={16} />
                          {googleCalendarAction === "syncing" ? "Syncing" : "Sync now"}
                        </button>
                        <button
                          className="outline-button"
                          disabled={googleCalendarAction !== "idle"}
                          onClick={() => void saveGoogleCalendarSettings()}
                          type="button"
                        >
                          <Check size={16} />
                          {googleCalendarAction === "saving" ? "Saving" : "Save settings"}
                        </button>
                        <button
                          className="danger-button"
                          disabled={googleCalendarAction !== "idle"}
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

              <article className="data-card notification-card settings-section settings-experience settings-integrations">
                <span>Email Notifications</span>
                <h2>Confirmation emails</h2>
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
                      value={notificationSettings.notificationEmail}
                      onChange={(event) => updateNotificationSetting("notificationEmail", event.target.value)}
                      placeholder={coachAccount.contactEmail}
                    />
                  </label>
                  <label className="settings-field">
                    <span>Coach email</span>
                    <input
                      value={notificationSettings.coachEmail}
                      onChange={(event) => updateNotificationSetting("coachEmail", event.target.value)}
                      placeholder="coach@email.co.nz"
                      type="email"
                    />
                  </label>
                  <label className="settings-field">
                    <span>Notification delay seconds</span>
                    <input
                      value={notificationSettings.notificationDelaySeconds}
                      min={30}
                      step={5}
                      inputMode="numeric"
                      onChange={(event) =>
                        updateNotificationSetting(
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
                      checked={notificationSettings.sendClientEmail}
                      onChange={(event) => updateNotificationSetting("sendClientEmail", event.target.checked)}
                      type="checkbox"
                    />
                    <span>Send client confirmation email</span>
                  </label>
                  <label className="settings-toggle">
                    <input
                      checked={notificationSettings.sendCoachEmail}
                      onChange={(event) => updateNotificationSetting("sendCoachEmail", event.target.checked)}
                      type="checkbox"
                    />
                    <span>Send coach booking alert</span>
                  </label>
                  <label className="settings-toggle">
                    <input
                      checked={notificationSettings.sendAdminEmail}
                      onChange={(event) => updateNotificationSetting("sendAdminEmail", event.target.checked)}
                      type="checkbox"
                    />
                    <span>Send admin booking alert</span>
                  </label>
                </details>
                <button className="primary-button settings-save" onClick={saveNotificationSettings}>
                  {settingsSaveState === "saving"
                    ? "Saving"
                    : settingsSaveState === "saved"
                      ? "Saved"
                      : "Save Email Settings"}
                </button>
              </article>

              <article className="data-card notification-card settings-section settings-experience settings-integrations">
                <span>Text Machine</span>
                <h2>SMS/webhook hook</h2>
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
                      value={notificationSettings.smsProviderName}
                      onChange={(event) => updateNotificationSetting("smsProviderName", event.target.value)}
                      placeholder="Twilio, MessageMedia, Zapier..."
                    />
                  </label>
                  <label className="settings-field">
                    <span>Webhook or API URL</span>
                    <input
                      value={notificationSettings.smsWebhookUrl}
                      onChange={(event) => updateNotificationSetting("smsWebhookUrl", event.target.value)}
                      placeholder="https://..."
                    />
                  </label>
                  <label className="settings-field">
                    <span>Sender or text number</span>
                    <input
                      value={notificationSettings.smsFromNumber}
                      onChange={(event) => updateNotificationSetting("smsFromNumber", event.target.value)}
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
                      checked={notificationSettings.sendClientSms}
                      onChange={(event) => updateNotificationSetting("sendClientSms", event.target.checked)}
                      type="checkbox"
                    />
                    <span>Send client text confirmation</span>
                  </label>
                  <label className="settings-toggle">
                    <input
                      checked={notificationSettings.sendAdminSms}
                      onChange={(event) => updateNotificationSetting("sendAdminSms", event.target.checked)}
                      type="checkbox"
                    />
                    <span>Send admin text alert</span>
                  </label>
                </details>
                <button className="primary-button settings-save" onClick={saveNotificationSettings}>
                  {settingsSaveState === "saving"
                    ? "Saving"
                    : settingsSaveState === "saved"
                      ? "Saved"
                      : "Save Text Settings"}
                </button>
              </article>

              <article className="data-card notification-card email-template-card settings-section settings-experience settings-branding">
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
                      value={notificationSettings.notificationFromName}
                      maxLength={120}
                      onChange={(event) =>
                        updateNotificationSetting("notificationFromName", event.target.value.slice(0, 120))}
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
                      value={notificationSettings.replyToEmail}
                      onChange={(event) => updateNotificationSetting("replyToEmail", event.target.value)}
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
                      value={notificationSettings.googleReviewUrl}
                      maxLength={700}
                      onChange={(event) => updateNotificationSetting("googleReviewUrl", event.target.value.slice(0, 700))}
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
                      value={notificationSettings.clientEmailSubject}
                      onChange={(event) => updateNotificationSetting("clientEmailSubject", event.target.value)}
                    />
                  </label>
                  <label className="settings-field">
                    <span>Customer opening</span>
                    <textarea
                      rows={3}
                      value={notificationSettings.clientEmailIntro}
                      onChange={(event) => updateNotificationSetting("clientEmailIntro", event.target.value)}
                    />
                  </label>
                  <label className="settings-field">
                    <span>Footer / reschedule note</span>
                    <textarea
                      rows={3}
                      value={notificationSettings.clientEmailFooter}
                      onChange={(event) => updateNotificationSetting("clientEmailFooter", event.target.value)}
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
                      value={notificationSettings.notificationSubjectLine}
                      onChange={(event) =>
                        updateNotificationSetting("notificationSubjectLine", event.target.value.slice(0, 180))}
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
                      onClick={() => updateNotificationSetting("notificationSubjectLine", "")}
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
                      value={notificationSettings.adminEmailSubject}
                      onChange={(event) => updateNotificationSetting("adminEmailSubject", event.target.value)}
                    />
                  </label>
                  <label className="settings-field">
                    <span>Admin summary</span>
                    <textarea
                      rows={3}
                      value={notificationSettings.adminEmailIntro}
                      onChange={(event) => updateNotificationSetting("adminEmailIntro", event.target.value)}
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
                <button className="primary-button settings-save" onClick={saveNotificationSettings}>
                  {settingsSaveState === "saving"
                    ? "Saving"
                    : settingsSaveState === "saved"
                      ? "Saved"
                      : "Save Template"}
                </button>
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
                  </div>
                </details>
              </article>
            </div>
          </section>
        )}
      </main>

      {!isEmbedMode && activeView === "calendar" && selectedDetails && (
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
                  <span>Notes</span>
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
                {selectedClient?.notes && <p>{selectedClient.notes}</p>}
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
                            </div>
                            <em>{`${appointmentDays[appointment.day].label}, ${formatRange(appointment.start, appointment.duration)}`}</em>
                          </div>
                        );
                      })
                    ) : (
                      <p>No appointments yet.</p>
                    )
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
