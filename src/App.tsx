import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  Code2,
  Copy,
  Clock,
  Download,
  Eye,
  ExternalLink,
  GripVertical,
  ImagePlus,
  KeyRound,
  Link2,
  LogOut,
  Mail,
  MapPin,
  Moon,
  Palette,
  Phone,
  Plus,
  RefreshCw,
  ScissorsLineDashed,
  Search,
  Settings,
  Sparkles,
  Sun,
  Upload,
  User,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangeEvent,
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

type LessonFormat = "private" | "group";
type PriceMode = "session" | "per-person";

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
};

type CalendarItem = {
  id: string;
  kind: "appointment" | "block";
  week?: number;
  day: number;
  start: number;
  duration: number;
  serviceId?: string;
  client?: string;
  title: string;
  phone?: string;
  email?: string;
  note?: string;
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

type FloatingDrag = {
  itemId: string;
  x: number;
  y: number;
  width: number;
  height: number;
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
  createdAt?: string;
  updatedAt?: string;
};

type ClientSummary = Person & {
  count: number;
  next: CalendarItem | null;
  last: CalendarItem | null;
};

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

type View = "calendar" | "clients" | "services" | "availability" | "booking" | "settings";
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
};

type BookingConfirmation = {
  kind: "booking" | "reschedule";
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
type AuthStatus = "checking" | "authenticated" | "guest";
type AuthMode = "login" | "forgot" | "reset";
type ThemeMode = "light" | "dark";

type NotificationSettings = {
  notificationEmail: string;
  replyToEmail: string;
  notificationDelaySeconds: number;
  sendClientEmail: boolean;
  sendAdminEmail: boolean;
  clientEmailSubject: string;
  clientEmailIntro: string;
  clientEmailFooter: string;
  adminEmailSubject: string;
  adminEmailIntro: string;
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
  contactEmail: string;
  bookingUrl: string;
  calendarSlug: string;
  caddyWorkspaceUrl: string;
};

type SlotCandidate = {
  week: number;
  day: number;
  start: number;
  duration: number;
};

type QuickCreateState = {
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

type WeekDay = {
  short: string;
  label: string;
  date: number;
};

const START_HOUR = 7;
const END_HOUR = 20;
const HOUR_HEIGHT = 72;
const SNAP_MINUTES = 15;
const MOUSE_DRAG_THRESHOLD = 10;
const TOUCH_DRAG_THRESHOLD = 16;
const EDGE_NAV_ZONE = 26;
const DAY_COUNT = 7;
const MINUTES_PER_DAY = (END_HOUR - START_HOUR) * 60;
const GRID_HEIGHT = ((END_HOUR - START_HOUR) * HOUR_HEIGHT);
const BOOKING_EMBED_PARAM = "embed";
const BOOKING_EMBED_VALUE = "booking";
const PUBLIC_BOOKING_HOST = "book.claritygolf.app";
const CLARITY_BOOKING_HOSTS = new Set(["claritygolf.app", "booking.claritygolf.app", PUBLIC_BOOKING_HOST]);
const CADDY_APP_URL = "https://caddy.claritygolf.app";
const THEME_STORAGE_KEY = "clarity-booking-theme";
const BRAND_STORAGE_KEY = "clarity-booking-brand";
const COACH_ACCOUNT_STORAGE_KEY = "clarity-booking-coach-account";
const RESCHEDULE_LOGIN_STORAGE_KEY = "clarity-booking-reschedule-login";
const BOOKING_LOGIN_STORAGE_KEY = "clarity-booking-login";

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
    price: 130,
    description: "Private package redemption rate",
    visibility: "private",
    active: true,
    capacity: 1,
    minParticipants: 1,
    lessonFormat: "private",
    priceMode: "session",
    location: "Package redemption",
  },
];

const initialItems: CalendarItem[] = [];

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

function buildWeekDays(week: number): WeekDay[] {
  return baseWeekDays.map((short, index) => {
    const date = new Date(baseWeekStart);
    date.setDate(baseWeekStart.getDate() + week * 7 + index);
    const month = date.toLocaleString("en-NZ", { month: "short" });
    return {
      short,
      label: `${fullDayNames[index]}, ${month} ${date.getDate()}`,
      date: date.getDate(),
    };
  });
}

function dateForSlot(week: number, day: number) {
  const date = new Date(baseWeekStart);
  date.setDate(baseWeekStart.getDate() + week * 7 + day);
  return date;
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
    case "services":
      return "Services";
    case "availability":
      return "Availability";
    case "booking":
      return "Booking Page";
    case "settings":
      return "Settings";
    default:
      return "Calendar";
  }
}

function getInitialView(): View {
  if (typeof window === "undefined") return "calendar";
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

function getBookingWidgetUrl() {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  if (CLARITY_BOOKING_HOSTS.has(url.hostname)) {
    url.protocol = "https:";
    url.hostname = PUBLIC_BOOKING_HOST;
    url.pathname = "/";
  }
  url.searchParams.set(BOOKING_EMBED_PARAM, BOOKING_EMBED_VALUE);
  return url.toString();
}

function isPublicBookingMode() {
  if (typeof window === "undefined") return false;
  return (
    window.location.hostname === PUBLIC_BOOKING_HOST ||
    new URLSearchParams(window.location.search).get(BOOKING_EMBED_PARAM) === BOOKING_EMBED_VALUE
  );
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

function normalizeMatchText(value = "") {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizePhoneDigits(value = "") {
  return value.replace(/\D/g, "");
}

function canonicalPhoneKey(value = "") {
  const digits = normalizePhoneDigits(value);
  if (digits.startsWith("64") && digits.length >= 9) return `0${digits.slice(2)}`;
  return digits;
}

function phoneVariants(value = "") {
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
  return (input.name ?? [input.firstName, input.lastName].filter(Boolean).join(" ")).trim();
}

function splitClientName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
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
  const rawTerm = term.trim().toLowerCase();
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
  if (person.caddyProfileUrl.trim()) return person.caddyProfileUrl.trim();
  const url = new URL(workspaceUrl || CADDY_APP_URL);
  if (person.caddyProfileId.trim()) url.searchParams.set("profile", person.caddyProfileId.trim());
  if (person.email.trim()) url.searchParams.set("email", person.email.trim());
  if (person.name.trim()) url.searchParams.set("name", person.name.trim());
  return url.toString();
}

function clientSearchText(client: Pick<Person, "name" | "email" | "phone" | "notes">) {
  return [client.name, client.email, client.phone, client.notes].join(" ").toLowerCase();
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
  contactEmail: "sam@samhalegolf.co.nz",
  bookingUrl: "https://book.claritygolf.app",
  calendarSlug: "sam-hale-golf",
  caddyWorkspaceUrl: CADDY_APP_URL,
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
    contactEmail: cleanEmail(account?.contactEmail, defaultCoachAccount.contactEmail),
    bookingUrl: cleanUrl(account?.bookingUrl, defaultCoachAccount.bookingUrl),
    calendarSlug: cleanSlug(account?.calendarSlug, cleanSlug(businessName, defaultCoachAccount.calendarSlug)),
    caddyWorkspaceUrl: cleanUrl(account?.caddyWorkspaceUrl, defaultCoachAccount.caddyWorkspaceUrl),
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
  const lessonFormat: LessonFormat = service?.lessonFormat === "group" ? "group" : "private";
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
  return {
    id: cleanSlug(service?.id, cleanSlug(name, `service-${Date.now()}-${index}`)),
    name,
    duration: clamp(Math.round(duration), 15, 240),
    price: Math.max(0, Math.round(price)),
    description:
      typeof service?.description === "string"
        ? service.description.trim().slice(0, 240)
        : fallback.description,
    visibility: service?.visibility === "private" ? "private" : "public",
    active: service?.active !== false,
    capacity: cleanCapacity,
    minParticipants,
    lessonFormat,
    priceMode,
    location: typeof service?.location === "string" ? service.location.trim().slice(0, 160) : fallback.location,
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

function servicePriceLabel(service?: { price: number; priceMode?: PriceMode } | null) {
  if (!service) return "No charge";
  return `NZ$${service.price}.00${service.priceMode === "per-person" ? " pp" : ""}`;
}

function serviceCapacityLabel(service: Pick<Service, "capacity" | "lessonFormat" | "minParticipants">) {
  if (service.lessonFormat === "group") return `${service.minParticipants}-${service.capacity} clients`;
  return `${service.capacity} client${service.capacity === 1 ? "" : "s"}`;
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
  notificationEmail: "sam@samhalegolf.co.nz",
  replyToEmail: "sam@samhalegolf.co.nz",
  notificationDelaySeconds: 30,
  sendClientEmail: true,
  sendAdminEmail: true,
  clientEmailSubject: "Your {{service}} is confirmed",
  clientEmailIntro: "Thanks {{firstName}}, your booking with {{coach}} is confirmed.",
  clientEmailFooter: "Need to move your booking? Reply to this email and we will help.",
  adminEmailSubject: "New booking: {{client}}",
  adminEmailIntro: "{{client}} booked {{service}} for {{date}} at {{time}}.",
  smsProviderName: "",
  smsWebhookUrl: "",
  smsFromNumber: "",
  sendClientSms: false,
  sendAdminSms: false,
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
  const [adminEmail, setAdminEmail] = useState("sam@clarity.golf");
  const [adminPassword, setAdminPassword] = useState("");
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const [authError, setAuthError] = useState("");
  const [forgotEmail, setForgotEmail] = useState("sam@clarity.golf");
  const [forgotState, setForgotState] = useState<"idle" | "sending" | "sent">("idle");
  const [forgotMessage, setForgotMessage] = useState("");
  const [resetToken] = useState(getInitialResetToken);
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirmPassword, setResetConfirmPassword] = useState("");
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [resetState, setResetState] = useState<"idle" | "saving">("idle");
  const [items, setItems] = useState<CalendarItem[]>(initialItems);
  const [services, setServices] = useState<Service[]>(defaultServices);
  const [serviceEditor, setServiceEditor] = useState<ServiceEditor>(emptyServiceEditor);
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null);
  const [showServiceEditor, setShowServiceEditor] = useState(false);
  const [serviceSaveState, setServiceSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [availability, setAvailability] = useState<AvailabilityWindow[][]>(defaultAvailability);
  const [availabilitySaveState, setAvailabilitySaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [editingAvailabilityWindow, setEditingAvailabilityWindow] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [peopleImportText, setPeopleImportText] = useState("");
  const [peopleImportState, setPeopleImportState] = useState<"idle" | "importing" | "imported">("idle");
  const [clientSearch, setClientSearch] = useState("");
  const [showClientImport, setShowClientImport] = useState(false);
  const [isAddingClient, setIsAddingClient] = useState(false);
  const [selectedClientId, setSelectedClientId] = useState("");
  const [clientEditMode, setClientEditMode] = useState(false);
  const [clientEditor, setClientEditor] = useState<ClientEditor>(emptyClientEditor);
  const [clientSaveState, setClientSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [clientProfileTab, setClientProfileTab] = useState<ClientProfileTab>("bookings");
  const [selectedId, setSelectedId] = useState("");
  const [activeView, setActiveView] = useState<View>(getInitialView);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("none");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pointerSession, setPointerSession] = useState<PointerSession>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [quickCreate, setQuickCreate] = useState<QuickCreateState | null>(null);
  const [quickClientSearch, setQuickClientSearch] = useState("");
  const [quickMatchField, setQuickMatchField] = useState<"name" | "phone" | "email">("name");
  const [dockBookings, setDockBookings] = useState<PendingBooking[]>([]);
  const [flyingBooking, setFlyingBooking] = useState<PendingBooking | null>(null);
  const [activeDockBookingId, setActiveDockBookingId] = useState("");
  const [placementAnimation, setPlacementAnimation] = useState<PlacementAnimation | null>(null);
  const [floatingDrag, setFloatingDrag] = useState<FloatingDrag | null>(null);
  const [activeWeek, setActiveWeek] = useState(0);
  const [edgeCue, setEdgeCue] = useState<null | "prev" | "next">(null);
  const [bookingServiceId, setBookingServiceId] = useState("");
  const [bookingDay, setBookingDay] = useState(0);
  const [bookingStart, setBookingStart] = useState<number | null>(null);
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
  const [syncBaseUrl, setSyncBaseUrl] = useState(getDefaultSyncBaseUrl);
  const [calendarSyncKey, setCalendarSyncKey] = useState(generateSyncKey);
  const [copiedSync, setCopiedSync] = useState<"url" | "key" | null>(null);
  const [calendarFeedStatus, setCalendarFeedStatus] = useState<CalendarFeedStatus>("checking");
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
  const pointerKindRef = useRef<globalThis.PointerEvent["pointerType"]>("mouse");
  const dragPreviewMetaRef = useRef<null | { width: number; height: number; offsetX: number; offsetY: number }>(null);
  const lastEdgeNavRef = useRef(0);
  const edgeCueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gestureCleanupRef = useRef<null | (() => void)>(null);
  const brandSaveVersionRef = useRef(0);

  const selected = selectedId ? items.find((item) => item.id === selectedId) : undefined;
  const selectedService = selected ? itemService(selected, services) : null;
  const weekDays = useMemo(() => buildWeekDays(activeWeek), [activeWeek]);
  const weekTitle = useMemo(() => formatWeekTitle(activeWeek), [activeWeek]);
  const weekItems = useMemo(() => items.filter((item) => itemWeek(item) === activeWeek), [activeWeek, items]);
  const appointments = weekItems.filter((item) => item.kind === "appointment").length;
  const blocks = weekItems.filter((item) => item.kind === "block").length;
  const activeDockBooking = dockBookings.find((booking) => booking.id === activeDockBookingId) ?? null;
  const dockFocus =
    !selected && (dockBookings.length > 0 || Boolean(flyingBooking) || pointerSession?.mode === "place");
  const appointmentServices = services.filter((service) => service.active);
  const publicServices = services.filter((service) => service.active && service.visibility === "public");
  const quickCreateServices = publicServices.slice(0, 4);
  const quickCreateService = quickCreate?.serviceId
    ? appointmentServices.find((service) => service.id === quickCreate.serviceId) ?? null
    : null;
  const selectedBookingService = publicServices.find((service) => service.id === bookingServiceId) ?? null;
  const visiblePublicServices = selectedBookingService ? [selectedBookingService] : publicServices;
  const selectedRescheduleMatch =
    rescheduleMatches.find((match) => match.id === selectedRescheduleId) ?? null;
  const bookingWidgetUrl = useMemo(getBookingWidgetUrl, []);
  const iframeCode = `<iframe src="${bookingWidgetUrl}" title="${coachAccount.businessName} booking" width="100%" height="760" style="border:0;max-width:100%;" loading="lazy"></iframe>`;
  const calendarFeedUrl = `${syncBaseUrl.trim().replace(/\/+$/, "") || "https://booking.yourdomain.co.nz"}/calendar/${coachAccount.calendarSlug}.ics?key=${calendarSyncKey}`;
  const caddyWorkspaceUrl = coachAccount.caddyWorkspaceUrl || CADDY_APP_URL;
  const bookingBrandName = (brandSettings.coachName || coachAccount.businessName).trim();
  const bookingBrandWords = bookingBrandName.split(/\s+/);
  const bookingBrandPrimary = bookingBrandWords.slice(0, -1).join(" ") || bookingBrandName;
  const bookingBrandSecondary = bookingBrandWords.length > 1 ? bookingBrandWords.at(-1) : "";
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
  const emailTemplateVariables = {
    business: coachAccount.businessName,
    client: "Donna Steele",
    coach: coachAccount.coachName || coachAccount.businessName,
    date: "Thursday, Jun 4",
    duration: emailTemplateService ? `${emailTemplateService.duration} minutes` : "60 minutes",
    firstName: "Donna",
    price: servicePriceLabel(emailTemplateService),
    replyTo: notificationSettings.replyToEmail || coachAccount.contactEmail,
    service: emailTemplateService?.name ?? "1 Hour Golf Lesson",
    time: emailTemplateService ? formatRange(14 * 60, emailTemplateService.duration) : "2:00 PM-3:00 PM",
    venue: coachAccount.venueShortName || coachAccount.venueName,
  };
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

    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof window.setTimeout> | null = null;
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
        if (!cancelled && response.ok && data.sent && data.notification) {
          setBookingConfirmation((current) =>
            current && current.appointmentId === bookingConfirmation.appointmentId
              ? { ...current, notifications: [data.notification as EmailSendResult, ...current.notifications] }
              : current,
          );
          setEmailNoticeVisible(true);
          return;
        }
      } catch {
        // The booking is already confirmed; email status is a secondary receipt.
      }
      if (!cancelled && attempts < 8) timer = window.setTimeout(poll, 1250);
    };

    timer = window.setTimeout(poll, 900);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [bookingConfirmation?.appointmentId, bookingConfirmation?.email, bookingConfirmation?.phone, isEmbedMode]);

  useEffect(() => {
    if (activeDockBookingId && !dockBookings.some((booking) => booking.id === activeDockBookingId)) {
      setActiveDockBookingId("");
    }
  }, [activeDockBookingId, dockBookings]);

  useEffect(() => {
    if (bookingServiceId && !publicServices.some((service) => service.id === bookingServiceId)) {
      setBookingServiceId("");
      setBookingStart(null);
    }
  }, [bookingServiceId, publicServices]);

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

        const sessionResponse = await fetch("/api/auth/session", { headers: { Accept: "application/json" } });
        if (!sessionResponse.ok) throw new Error("Session API unavailable");
        const session = (await sessionResponse.json()) as { authenticated?: boolean; email?: string };
        if (cancelled) return;

        if (!session.authenticated) {
          setAuthStatus("guest");
          setCalendarFeedStatus("offline");
          return;
        }

        setAuthStatus("authenticated");
        if (session.email) setAdminEmail(session.email);
        await loadAdminCalendarState();
        setCalendarFeedStatus("connected");
      } catch {
        if (!cancelled) {
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
    const controller = new AbortController();
    void fetch("/api/calendar-state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, syncKey: calendarSyncKey }),
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Calendar feed save failed");
        setCalendarFeedStatus("connected");
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setCalendarFeedStatus("offline");
        }
      });

    return () => controller.abort();
  }, [authStatus, calendarSyncKey, isEmbedMode, items]);

  function applyNotificationSettings(settings?: Partial<NotificationSettings>) {
    const delaySeconds = Number(settings?.notificationDelaySeconds ?? defaultNotificationSettings.notificationDelaySeconds);
    setNotificationSettings({
      ...defaultNotificationSettings,
      ...(settings ?? {}),
      notificationDelaySeconds: Number.isFinite(delaySeconds) ? clamp(delaySeconds, 30, 3600) : 30,
    });
  }

  function applyCoachAccount(account?: Partial<CoachAccount>) {
    setCoachAccount(cleanCoachAccount(account));
  }

  function applyBrandSettings(settings?: Partial<BrandSettings>) {
    setBrandSettings(cleanBrandSettings(settings));
  }

  async function loadAdminCalendarState() {
    const response = await fetch("/api/calendar-state", { headers: { Accept: "application/json" } });
    if (response.status === 401) {
      setAuthStatus("guest");
      throw new Error("Admin login required");
    }
    if (!response.ok) throw new Error("Calendar API unavailable");
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
    };
    if (Array.isArray(data.items)) setItems(data.items);
    if (Array.isArray(data.people)) setPeople(data.people);
    if (Array.isArray(data.notifications)) setNotifications(data.notifications);
    if (Array.isArray(data.services)) setServices(cleanServices(data.services));
    if (Array.isArray(data.availability)) setAvailability(cleanAvailability(data.availability));
    if (typeof data.syncKey === "string" && data.syncKey.startsWith("cg_")) {
      setCalendarSyncKey(data.syncKey);
    }
    applyNotificationSettings(data.settings);
    applyCoachAccount(data.account);
    applyBrandSettings(data.brand);
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
    };
    if (Array.isArray(data.items)) setItems(data.items);
    if (Array.isArray(data.notifications)) setNotifications(data.notifications);
    if (Array.isArray(data.services)) setServices(cleanServices(data.services));
    if (Array.isArray(data.availability)) setAvailability(cleanAvailability(data.availability));
    applyCoachAccount(data.account);
    applyBrandSettings(data.brand);
    hasLoadedCalendarApiRef.current = true;
  }

  const displayItems = useMemo(() => {
    const floatingItemId = floatingDrag?.itemId ?? "";
    const baseWeekItems = floatingItemId ? weekItems.filter((item) => item.id !== floatingItemId) : weekItems;
    if (!draft || draft.mode === "block" || draft.mode === "place") return baseWeekItems;
    const withoutMoving = baseWeekItems.filter((item) => item.id !== draft.itemId);
    const movingItem = items.find((item) => item.id === draft.itemId);
    if (!movingItem || draft.week !== activeWeek) return withoutMoving;
    return [
      ...withoutMoving,
      { ...movingItem, week: draft.week, day: draft.day, start: draft.start, duration: draft.duration },
    ];
  }, [activeWeek, draft, floatingDrag, items, weekItems]);
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

  const clientGhostSuggestion = useMemo(() => {
    if (!clientSearchTerm) return null;
    return findClientMatch(clients, { name: clientSearchTerm, email: clientSearchTerm, phone: clientSearchTerm });
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
  const selectedClientNotifications = useMemo(() => {
    if (!selectedClient) return [];
    const keys = clientNotificationKeys(selectedClient.name, selectedClient.email, selectedClient.phone);
    const appointmentIds = new Set(selectedClientAppointments.map((appointment) => appointment.id));
    return notifications
      .filter((notification) => keys.has(notification.personKey) || appointmentIds.has(notification.calendarItemId))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }, [notifications, selectedClient, selectedClientAppointments]);
  const hasSelectedClientCaddyProfile = Boolean(
    selectedClient?.caddyProfileId.trim() || selectedClient?.caddyProfileUrl.trim(),
  );
  const hasSelectedPersonCaddyProfile = Boolean(
    selectedPerson?.caddyProfileId.trim() || selectedPerson?.caddyProfileUrl.trim(),
  );

  const peopleImportPreview = useMemo(() => parsePeopleImport(peopleImportText).length, [peopleImportText]);

  const bookingSlots = useMemo(() => {
    if (!selectedBookingService) return [];
    const windows = availability[bookingDay] ?? [];
    const slots: number[] = [];
    const ignoreId = bookingMode === "reschedule" ? selectedRescheduleMatch?.id : undefined;
    windows.forEach((window) => {
      for (let start = window.start; start + selectedBookingService.duration <= window.end; start += 30) {
        const candidate = {
          week: activeWeek,
          day: bookingDay,
          start,
          duration: selectedBookingService.duration,
        };
        if (!hasCollision(candidate, ignoreId)) slots.push(start);
      }
    });
    return slots;
  }, [activeWeek, bookingDay, bookingMode, selectedBookingService, selectedRescheduleMatch, items]);
  const visibleBookingSlots = bookingStart === null ? bookingSlots : bookingSlots.filter((slot) => slot === bookingStart);

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
    setSelectedId("");
    setQuickCreate(null);
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

  function clearGesture() {
    gestureCleanupRef.current?.();
    gestureCleanupRef.current = null;
    clickPlaceRef.current = null;
    dragPreviewMetaRef.current = null;
    setFloatingDrag(null);
    setDraftState(null);
    setPointerSessionState(null);
    setMovedState(false);
  }

  function isInsideAvailability(day: number, start: number, duration: number) {
    const end = start + duration;
    return availability[day].some((window) => start >= window.start && end <= window.end);
  }

  function hasCollision(candidate: SlotCandidate, ignoreId?: string) {
    const candidateEnd = candidate.start + candidate.duration;
    return items.some((item) => {
      if (item.id === ignoreId || itemWeek(item) !== candidate.week || item.day !== candidate.day) return false;
      const itemEnd = item.start + item.duration;
      return candidate.start < itemEnd && candidateEnd > item.start;
    });
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

  function isValidAppointmentSlot(candidate: SlotCandidate, ignoreId?: string) {
    if (candidate.start < START_HOUR * 60 || candidate.start + candidate.duration > END_HOUR * 60) return false;
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
    const slot = slotFromPointer(event);
    if (!slot) return;
    const rect = event.currentTarget.getBoundingClientRect();
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    pointerClientRef.current = { x: event.clientX, y: event.clientY };
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
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    pointerClientRef.current = { x: event.clientX, y: event.clientY };
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
    if ((event.target as HTMLElement).closest("[data-calendar-item]")) return;
    const slot = slotFromPointer(event);
    if (!slot) return;
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    pointerClientRef.current = { x: event.clientX, y: event.clientY };
    pointerKindRef.current = event.pointerType || "mouse";
    dragPreviewMetaRef.current = null;
    setFloatingDrag(null);
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
    setSelectedId("");
    setQuickCreate({
      day: slot.day,
      start: slot.start,
      x: event.clientX,
      y: event.clientY,
      serviceId: "",
      phone: "",
      email: "",
      note: "",
      error: "",
    });
    setPointerSessionState({ mode: "block", day: slot.day, start: slot.start });
    event.currentTarget.setPointerCapture(event.pointerId);
    attachGestureListeners();
  }

  function updatePointer(event: ReactPointerEvent<HTMLElement>) {
    updatePointerAt(event.clientX, event.clientY);
  }

  function updatePointerAt(clientX: number, clientY: number) {
    pointerClientRef.current = { x: clientX, y: clientY };
    const session = pointerSessionRef.current;
    if (!session) return;
    if (!hasPointerMovedPastThreshold(clientX, clientY)) return;
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
      const candidate = {
        week: activeWeekRef.current,
        day: slot.day,
        start: slot.start,
        duration: session.booking.duration,
      };
      setDraftState({
        mode: "place",
        ...candidate,
        valid: isValidAppointmentSlot(candidate),
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
    if (!session) return;
    if (hasMovedRef.current) {
      suppressItemClickRef.current = true;
      suppressItemClickUntilRef.current = Date.now() + 450;
      window.setTimeout(() => {
        suppressItemClickRef.current = false;
      }, 450);
    }

    if (!hasMovedRef.current) {
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

    if (session.mode === "move" && isClientInsideDock(pointerClientRef.current.x, pointerClientRef.current.y)) {
      const movedItem = items.find((item) => item.id === session.itemId);
      if (!movedItem || movedItem.kind !== "appointment") {
        clearGesture();
        return;
      }
      const service = itemService(movedItem, services);
      if (!service) {
        clearGesture();
        return;
      }
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
      setItems(items.filter((item) => item.id !== movedItem.id));
      setDockBookings([...dockBookings, docked]);
      setActiveDockBookingId(docked.id);
      setSelectedId("");
      setToast({ message: `${docked.client} is parked on the shelf.` });
      clearGesture();
      return;
    }

    if (!activeDraft || !activeDraft.valid) {
      setToast({ message: "That spot is not available. The calendar stayed unchanged." });
      clearGesture();
      return;
    }

    if (activeDraft.mode === "block") {
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
      setSelectedId("");
      setToast({
        message: `Blocked ${weekDays[activeDraft.day].short}, ${formatRange(activeDraft.start, activeDraft.duration)}.`,
        undo: () => {
          setItems(previous);
          setSelectedId("");
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
      setSelectedId("");
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
    setSelectedId("");
    clearGesture();
  }

  function resolveQuickClient() {
    return findClientMatch(clients, quickClientInput, true) ?? quickClientSuggestion ?? null;
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
  }

  function quickClientMatchButton(field: "name" | "phone" | "email") {
    if (!quickClientSuggestion || !showQuickClientSuggestion || quickMatchField !== field) return null;
    return (
      <button className="client-match-prompt quick-field-match" onClick={() => applyQuickClient(quickClientSuggestion)} type="button">
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
    const matchedClient = resolveQuickClient();
    const candidate = { week: activeWeek, day: quickCreate.day, start: quickCreate.start, duration: service.duration };
    setQuickCreate((current) =>
      current
        ? {
            ...current,
            serviceId,
            phone: current.phone || matchedClient?.phone || "",
            email: current.email || matchedClient?.email || "",
            error: isValidAppointmentSlot(candidate) ? "" : "That time is already occupied.",
          }
        : current,
    );
    if (matchedClient) setQuickClientSearch(matchedClient.name);
    setQuickMatchField("name");
  }

  function backToQuickServiceChoice() {
    setQuickCreate((current) =>
      current ? { ...current, serviceId: "", phone: "", email: "", note: "", error: "" } : current,
    );
  }

  function confirmQuickAppointment() {
    if (!quickCreate || !quickCreateService) return;
    const matchedClient = resolveQuickClient();
    const typedClientName = quickClientSearch.trim();
    const clientName = matchedClient?.name || typedClientName;
    if (!clientName) {
      setQuickCreate((current) => (current ? { ...current, error: "Add a client name." } : current));
      return;
    }
    const candidate = {
      week: activeWeek,
      day: quickCreate.day,
      start: quickCreate.start,
      duration: quickCreateService.duration,
    };
    if (!isValidAppointmentSlot(candidate)) {
      setQuickCreate((current) => (current ? { ...current, error: "That time is already occupied." } : current));
      return;
    }
    const item: CalendarItem = {
      id: `appt-${Date.now()}`,
      kind: "appointment",
      title: clientName,
      client: clientName,
      serviceId: quickCreateService.id,
      ...candidate,
      phone: quickCreate.phone.trim() || matchedClient?.phone || "",
      email: quickCreate.email.trim() || matchedClient?.email || "",
      note: quickCreate.note.trim(),
    };
    setItems(carveBusyBlocksForAppointment([...items, item], itemSlot(item)));
    setSelectedId("");
    setQuickCreate(null);
    setQuickClientSearch("");
  }

  function createBlockFromQuick() {
    if (!quickCreate) return;
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
    setSelectedId("");
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
    if (!isValidAppointmentSlot(candidate)) {
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
    setSelectedId("");
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
    setSelectedId("");
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
    pointerKindRef.current = event.pointerType || "mouse";
    dragPreviewMetaRef.current = null;
    setFloatingDrag(null);
    setActiveDockBookingId(booking.id);
    setMovedState(false);
    setSelectedId("");
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
    if (!isValidAppointmentSlot(candidate)) {
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
    setSelectedId("");
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
    if (view !== "calendar") setSelectedId("");
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
    setBookingStart(null);
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
    if (!selectedRescheduleMatch || !selectedBookingService || bookingStart === null) {
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

  function handleBookingMatchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if ((event.key === "Tab" || event.key === "ArrowRight") && bookingClientSuggestion) {
      event.preventDefault();
      applyBookingClient(bookingClientSuggestion);
    }
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

  function updateServiceEditor<K extends keyof ServiceEditor>(field: K, value: ServiceEditor[K]) {
    setServiceSaveState("idle");
    setServiceEditor((current) => {
      const next = { ...current, [field]: value };
      if (next.lessonFormat === "group") {
        const capacity = clamp(Math.round(Number(next.capacity) || 2), 2, 24);
        return {
          ...next,
          capacity,
          minParticipants: clamp(Math.round(Number(next.minParticipants) || 2), 2, capacity),
        };
      }
      return {
        ...next,
        capacity: clamp(Math.round(Number(next.capacity) || 1), 1, 24),
        minParticipants: 1,
        priceMode: "session",
      };
    });
  }

  function editService(service: Service) {
    setEditingServiceId(service.id);
    setServiceEditor({ ...service });
    setShowServiceEditor(true);
    setServiceSaveState("idle");
  }

  function startNewService() {
    setEditingServiceId(null);
    setServiceEditor({
      ...emptyServiceEditor(),
      location: coachAccount.venueShortName,
    });
    setShowServiceEditor(true);
    setServiceSaveState("idle");
  }

  async function persistServices(nextServices: Service[], message = "Lesson types saved.") {
    const cleaned = cleanServices(nextServices);
    setServices(cleaned);
    setServiceSaveState("saving");
    try {
      const response = await fetch("/api/services", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ services: cleaned }),
      });
      if (response.status === 401) {
        setAuthStatus("guest");
        throw new Error("Admin login required");
      }
      if (!response.ok) throw new Error("Services save failed");
      const data = (await response.json()) as { services?: Service[] };
      if (Array.isArray(data.services)) setServices(cleanServices(data.services));
      setServiceSaveState("saved");
      setToast({ message });
      window.setTimeout(() => setServiceSaveState("idle"), 1600);
    } catch {
      setServiceSaveState("idle");
      setToast({ message: "Could not save lesson types." });
    }
  }

  function saveEditedService() {
    if (!serviceEditor.name.trim()) {
      setToast({ message: "Give the lesson type a name before saving." });
      return;
    }
    const clean = cleanService(
      {
        ...serviceEditor,
        id: editingServiceId ?? serviceEditor.id ?? cleanSlug(serviceEditor.name, `service-${Date.now()}`),
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
    void persistServices(nextServices, exists ? `${clean.name} updated.` : `${clean.name} added.`);
  }

  function toggleServiceActive(service: Service) {
    void persistServices(
      services.map((candidate) =>
        candidate.id === service.id ? { ...candidate, active: !candidate.active } : candidate,
      ),
      service.active ? `${service.name} archived.` : `${service.name} restored.`,
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
      setAuthStatus("authenticated");
      setAdminPassword("");
      if (data.email) setAdminEmail(data.email);
      await loadAdminCalendarState();
      setCalendarFeedStatus("connected");
    } catch {
      setAuthError("Could not reach the booking server.");
      setCalendarFeedStatus("offline");
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

  async function handleAdminLogout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    hasLoadedCalendarApiRef.current = false;
    setAuthStatus("guest");
    setSelectedId("");
    setCalendarFeedStatus("offline");
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
      if (Array.isArray(result.people)) setPeople(result.people);
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
      if (Array.isArray(result.people)) setPeople(result.people);
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

  function completeClientSearchSuggestion() {
    if (!clientGhostSuggestion) return;
    setClientSearch(clientGhostSuggestion.name);
    openClientProfile(clientGhostSuggestion);
  }

  async function confirmPublicBooking() {
    if (bookingSubmitState === "saving") return;
    if (!selectedBookingService || bookingStart === null) {
      setToast({ message: "Choose a lesson time before confirming." });
      return;
    }
    const matchedClient = isEmbedMode
      ? null
      : findClientMatch(clients, bookingClientInput, true) ?? bookingClientSuggestion;
    const matchedName = splitClientName(matchedClient?.name ?? "");
    const firstName = bookingForm.firstName.trim() || matchedName.firstName;
    const lastName = bookingForm.lastName.trim() || matchedName.lastName;
    const phone = bookingForm.phone.trim() || matchedClient?.phone || "";
    const email = bookingForm.email.trim() || matchedClient?.email || "";
    const client = [firstName, lastName].filter(Boolean).join(" ").trim();

    if (!firstName || !lastName || !email) {
      setToast({ message: "First name, last name, and email are required." });
      return;
    }

    const candidate = {
      week: activeWeek,
      day: bookingDay,
      start: bookingStart,
      duration: selectedBookingService.duration,
    };
    if (hasCollision(candidate)) {
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
            serviceId: selectedBookingService.id,
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
          service: selectedBookingService.name,
          week: activeWeek,
          day: bookingDay,
          start: bookingStart,
          duration: selectedBookingService.duration,
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
      serviceId: selectedBookingService.id,
      client,
      title: client,
      phone,
      email,
      note: "Booked from public booking page.",
    };
    setItems(carveBusyBlocksForAppointment([...items, item], itemSlot(item)));
    if (isEmbedMode) {
      setSelectedId("");
    } else {
      setSelectedId("");
      setActiveView("calendar");
    }
    setBookingStart(null);
    setBookingForm({ firstName: "", lastName: "", phone: "", email: "" });
    setToast({
      message: `${client} booked ${selectedBookingService.name} on ${weekDays[item.day].short} at ${formatTime(item.start)}.`,
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

  function regenerateSyncKey() {
    setCalendarSyncKey(generateSyncKey());
    setCopiedSync(null);
    setToast({ message: "Calendar sync key regenerated. Update Google Calendar with the new URL." });
  }

  function removeSelected() {
    if (!selected) return;
    const previous = items;
    setItems(items.filter((item) => item.id !== selected.id));
    setSelectedId("");
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
                      updateServiceEditor("lessonFormat", event.target.value === "group" ? "group" : "private")
                    }
                  >
                    <option value="private">Private lesson</option>
                    <option value="group">Group lesson</option>
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
                    onChange={(event) => updateServiceEditor("duration", Number(event.target.value))}
                    type="number"
                  />
                </label>
                <label className="settings-field">
                  <span>Price NZD</span>
                  <input
                    value={serviceEditor.price}
                    min={0}
                    step={1}
                    onChange={(event) => updateServiceEditor("price", Number(event.target.value))}
                    type="number"
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
                    <span>Minimum group</span>
                    <input
                      value={serviceEditor.minParticipants}
                      min={2}
                      max={serviceEditor.capacity}
                      step={1}
                      onChange={(event) => updateServiceEditor("minParticipants", Number(event.target.value))}
                      type="number"
                    />
                  </label>
                )}
                <label className="settings-field">
                  <span>{serviceEditor.lessonFormat === "group" ? "Maximum group" : "Capacity"}</span>
                  <input
                    value={serviceEditor.capacity}
                    min={serviceEditor.lessonFormat === "group" ? 2 : 1}
                    max={24}
                    step={1}
                    onChange={(event) => updateServiceEditor("capacity", Number(event.target.value))}
                    type="number"
                  />
                </label>
                <label className="settings-field">
                  <span>Location note</span>
                  <input
                    value={serviceEditor.location}
                    onChange={(event) => updateServiceEditor("location", event.target.value)}
                    placeholder={coachAccount.venueShortName}
                  />
                </label>
              </div>
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
              {serviceSaveState === "saving" ? "Saving" : serviceSaveState === "saved" ? "Saved" : "Save Lesson Type"}
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
                    {service.lessonFormat === "group" ? "Group" : "Private"}
                  </span>
                  <strong>{service.name}</strong>
                  {service.description && <em>{service.description}</em>}
                </button>
                <div className="service-row-meta">
                  <strong>{servicePriceLabel(service)}</strong>
                  <span>{service.duration} min</span>
                </div>
                <div className="service-row-actions">
                  <button className="outline-button" onClick={() => editService(service)}>
                    Edit
                  </button>
                  <button className="outline-button" onClick={() => toggleServiceActive(service)}>
                    {service.active ? "Archive" : "Restore"}
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
      <div className="booking-brand">
        {brandSettings.logoPreview ? (
          <img src={brandSettings.logoPreview} alt={`${bookingBrandName} logo`} />
        ) : (
          <>
            <strong>{bookingBrandPrimary.toUpperCase()}</strong>
            {bookingBrandSecondary && <span>{bookingBrandSecondary.toUpperCase()}</span>}
          </>
        )}
        <em>{coachAccount.venueShortName}</em>
      </div>

      <div className="booking-columns">
        <div className="booking-card">
          <span>Select Appointment</span>
          <div className="service-picker">
            {visiblePublicServices.length ? (
              visiblePublicServices.map((service) => (
                <button
                  className={service.id === bookingServiceId ? "selected-service" : ""}
                  key={service.id}
                  onClick={() => {
                    setBookingServiceId(service.id === bookingServiceId ? "" : service.id);
                    setBookingStart(null);
                  }}
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

        <div className="booking-card">
          <span>Date & Time</span>
          <div className="booking-days">
            {weekDays.map((day, index) => (
              <button
                className={bookingDay === index ? "selected-day" : ""}
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
            {bookingSlots.length ? (
              visibleBookingSlots.map((slot) => (
                <button
                  className={bookingStart === slot ? "selected-time" : ""}
                  key={slot}
                  onClick={() => setBookingStart(bookingStart === slot ? null : slot)}
                  type="button"
                >
                  {formatTime(slot)}
                </button>
              ))
            ) : (
              <p>
                {selectedBookingService
                  ? "No public times available for this day."
                  : "Choose an appointment type first."}
              </p>
            )}
          </div>
        </div>

        <div className="booking-card">
          <span>Your Information</span>
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
          {bookingClientSuggestion && bookingClientHasInput && (
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
      </div>

        </div>
      </details>
      <details className="settings-subsection">
        <summary className="settings-subsection-title">
          <Code2 size={18} />
          <div>
            <span>Embed</span>
            <strong>Squarespace iframe</strong>
          </div>
        </summary>
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
      </details>
    </article>
  );

  const selectedDetails = selected ? (
    <>
      <div className="panel-header">
        <span>{selected.kind === "block" ? "Blocked Time" : "Appointment"}</span>
        <button className="icon-button small" onClick={() => setSelectedId("")} aria-label="Close details">
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
            disabled={authStatus === "checking" || forgotState === "sending" || resetState === "saving"}
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
            <p className="eyebrow">{activeView === "booking" ? "Public Booking" : activeView}</p>
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
              <button className="outline-button" onClick={() => setActiveWeekState(0)}>
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
              <div className="dock-tile flying-to-dock">
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
          <div className="calendar-card">
            <div className="calendar-toolbar">
              <h2>{weekTitle}</h2>
            </div>

            <div className="calendar-header-row">
              <div className="time-gutter" />
              {weekDays.map((day) => (
                <div className="day-heading" key={day.label}>
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
                  return (
                    <article
                      data-calendar-item
                      key={item.id}
                      className={`calendar-item ${item.kind} ${selectedId === item.id ? "selected" : ""} ${
                        invalid ? "invalid" : ""
                      } ${flyAnimation ? "just-placed-from-dock" : ""}`}
                      style={{
                        top,
                        height: Math.max(height, 34),
                        left: `calc(${left}% + 6px)`,
                        width: `calc(${width}% - 12px)`,
                        ...(flyAnimation
                          ? ({
                              "--dock-fly-x": `${flyAnimation.fromX}px`,
                              "--dock-fly-y": `${flyAnimation.fromY}px`,
                            } as CSSProperties)
                          : {}),
                      }}
                      onPointerDown={(event) => beginMove(event, item)}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (suppressItemClickRef.current || Date.now() < suppressItemClickUntilRef.current) return;
                        setSelectedId(item.id);
                        setQuickCreate(null);
                      }}
                    >
                      <div className="item-grip" aria-hidden="true">
                        <GripVertical size={14} />
                      </div>
                      <div className="item-content">
                        <strong>{item.title}</strong>
                        <span>{service?.name ?? "Busy"}</span>
                        <em>{formatRange(item.start, item.duration)}</em>
                      </div>
                      <button
                        className="resize-handle"
                        aria-label="Resize calendar item"
                        onPointerDown={(event) => beginResize(event, item)}
                      />
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
                            onFocus={() => setQuickMatchField("name")}
                            onChange={(event) => {
                              setQuickMatchField("name");
                              setQuickClientSearch(event.target.value);
                              setQuickCreate((current) => (current ? { ...current, error: "" } : current));
                            }}
                            onKeyDown={(event) => {
                              if ((event.key === "Tab" || event.key === "ArrowRight") && quickClientSuggestion) {
                                event.preventDefault();
                                applyQuickClient(quickClientSuggestion);
                              }
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
                          onFocus={() => setQuickMatchField("phone")}
                          onChange={(event) => {
                            setQuickMatchField("phone");
                            updateQuickCreateField("phone", event.target.value);
                          }}
                          onKeyDown={(event) => {
                            if ((event.key === "Tab" || event.key === "ArrowRight") && quickClientSuggestion) {
                              event.preventDefault();
                              applyQuickClient(quickClientSuggestion);
                            }
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
                          onChange={(event) => {
                            setQuickMatchField("email");
                            updateQuickCreateField("email", event.target.value);
                          }}
                          onKeyDown={(event) => {
                            if ((event.key === "Tab" || event.key === "ArrowRight") && quickClientSuggestion) {
                              event.preventDefault();
                              applyQuickClient(quickClientSuggestion);
                            }
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

        {!isEmbedMode && activeView === "clients" && (
          <section className="module-page clients-page">
            <div className="client-toolbar">
              <div className="client-search">
                <Search size={18} />
                <input
                  value={clientSearch}
                  onChange={(event) => setClientSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.key === "Tab" || event.key === "ArrowRight") && clientGhostSuggestion) {
                      event.preventDefault();
                      completeClientSearchSuggestion();
                    }
                    if (event.key === "Enter" && filteredClients[0]) {
                      event.preventDefault();
                      openClientProfile(filteredClients[0]);
                    }
                  }}
                  placeholder="Search clients"
                />
                {clientGhostSuggestion && clientSearchTerm && (
                  <button className="client-ghost" onClick={completeClientSearchSuggestion} type="button">
                    <span>{clientGhostSuggestion.name}</span>
                    <em>
                      {[clientGhostSuggestion.email, clientGhostSuggestion.phone].filter(Boolean).join(" · ") ||
                        "Open profile"}
                    </em>
                  </button>
                )}
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

        {isEmbedMode && activeView === "booking" && (
          <section className={`public-booking booking-theme-${brandSettings.bookingTheme} module-page`}>
            <div className="booking-brand">
              {brandSettings.logoPreview ? (
                <img src={brandSettings.logoPreview} alt={`${bookingBrandName} logo`} />
              ) : (
                <>
                  <strong>{bookingBrandPrimary.toUpperCase()}</strong>
                  {bookingBrandSecondary && <span>{bookingBrandSecondary.toUpperCase()}</span>}
                </>
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
                <span>{bookingConfirmation.kind === "booking" ? "Appointment Confirmed" : "Appointment Updated"}</span>
                <h2>{bookingConfirmation.kind === "booking" ? "Booking confirmed" : "Reschedule confirmed"}</h2>
                <div className="booking-confirmed-summary">
                  <strong>{bookingConfirmation.service}</strong>
                  <em>
                    {bookingConfirmation.dayLabel}, {bookingConfirmation.timeLabel}
                  </em>
                  <p>{coachAccount.venueName}</p>
                </div>
                {emailNoticeVisible &&
                  bookingConfirmation.notifications.some((result) => result.channel === "client" && result.sent) && (
                    <div className="email-status-list">
                    <div className="email-status sent">
                      <Check size={17} />
                      <span>Email sent to {bookingConfirmation.email}</span>
                    </div>
                    </div>
                  )}
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
                <button
                  className="primary-button confirm-booking"
	                  onClick={() => {
	                    setBookingConfirmation(null);
	                    setBookingMode("book");
	                    setEmailNoticeVisible(false);
	                  }}
                  type="button"
                >
                  Book another lesson
                </button>
              </div>
            ) : (
            <div className="booking-columns">
              {bookingMode === "book" ? (
                <>
              <div className="booking-card">
                <span>Select Appointment</span>
                <div className="service-picker">
                  {visiblePublicServices.length ? (
                    visiblePublicServices.map((service) => (
                      <button
                        className={service.id === bookingServiceId ? "selected-service" : ""}
                        key={service.id}
                        onClick={() => {
                          setBookingServiceId(service.id === bookingServiceId ? "" : service.id);
                          setBookingStart(null);
                        }}
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

              <div className="booking-card">
                <span>Date & Time</span>
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
                  {bookingSlots.length ? (
                    visibleBookingSlots.map((slot) => (
                      <button
                        className={bookingStart === slot ? "selected-time" : ""}
                        key={slot}
                        onClick={() => setBookingStart(bookingStart === slot ? null : slot)}
                        type="button"
                      >
                        {formatTime(slot)}
                      </button>
                    ))
                  ) : (
                    <p>
                      {selectedBookingService
                        ? "No public times available for this day."
                        : "Choose an appointment type first."}
                    </p>
                  )}
                </div>
              </div>

              <div className="booking-card">
                <span>Your Information</span>
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
                {bookingClientSuggestion && bookingClientHasInput && (
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
                              className={bookingStart === slot ? "selected-time" : ""}
                              key={slot}
                              onClick={() => setBookingStart(slot)}
                            >
                              {formatTime(slot)}
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
                    <h2>Private iCal feed</h2>
                  </div>
                  <KeyRound size={24} />
                </div>

                <div className={`sync-status ${calendarFeedStatus}`}>
                  <span>Feed endpoint</span>
                  <strong>
                    {calendarFeedStatus === "connected"
                      ? "Connected"
                      : calendarFeedStatus === "checking"
                        ? "Checking"
                        : "Offline"}
                  </strong>
                  <em>{calendarFeedUrl}</em>
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
                    <span>Reply-to email</span>
                    <input
                      value={notificationSettings.replyToEmail}
                      onChange={(event) => updateNotificationSetting("replyToEmail", event.target.value)}
                      placeholder={coachAccount.contactEmail}
                    />
                  </label>
                  <label className="settings-field">
                    <span>Notification delay seconds</span>
                    <input
                      value={notificationSettings.notificationDelaySeconds}
                      min={30}
                      step={5}
                      onChange={(event) =>
                        updateNotificationSetting(
                          "notificationDelaySeconds",
                          clamp(Number(event.target.value || 30), 30, 3600),
                        )
                      }
                      type="number"
                    />
                  </label>
                </details>
                <details className="settings-subsection">
                  <summary className="settings-subsection-title">
                    <Check size={18} />
                    <div>
                      <span>Send rules</span>
                      <strong>
                        {[notificationSettings.sendClientEmail && "Customer", notificationSettings.sendAdminEmail && "Admin"]
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
                <details className="settings-subsection" open>
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
        <div className="details-overlay" role="presentation" onPointerDown={() => setSelectedId("")}>
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
                    Notification history
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
                          <strong>{notification.subject}</strong>
                          <span>
                            {notification.kind} email to {notification.recipient}
                          </span>
                        </div>
                        <em>
                          {notification.status}
                          {notification.createdAt ? ` · ${new Date(notification.createdAt).toLocaleString()}` : ""}
                        </em>
                      </div>
                    ))
                  ) : (
                    <p>No email notifications recorded yet.</p>
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
