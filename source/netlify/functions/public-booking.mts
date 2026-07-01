import type { Config } from "@netlify/functions";

import { randomUUID } from "node:crypto";

const OPTIONAL_CALENDAR_ITEM_COLUMNS = [
  "account_id",
  "status",
  "custom_group",
  "coach_id",
  "location_id",
  "coach",
  "location",
];
const ACCOUNT_SCOPE_COLUMNS = ["account_id", "coach_id", "location_id", "coach", "location"];
const JSON_COLUMNS = new Set(["custom_group", "coach", "location"]);

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function cleanString(value: unknown, fallback = "", max = 600) {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

function cleanEmail(value: unknown, fallback = "") {
  const email = cleanString(value, "", 180).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : fallback;
}

function cleanSlug(value: unknown, fallback = "sam-hale-golf") {
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

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (!value) return fallback;
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function encodeFilter(value: unknown) {
  return encodeURIComponent(String(value ?? ""));
}

function defaultCoachAccount() {
  return {
    id: env("CLARITY_COACH_ACCOUNT_ID", "sam-hale-golf"),
    coachName: env("CLARITY_COACH_NAME", "Sam Hale"),
    businessName: env("CLARITY_BUSINESS_NAME", "Sam Hale Golf"),
    venueName: env("CLARITY_VENUE_NAME", "The Range 24/7 - Three Kings"),
    venueShortName: env("CLARITY_VENUE_SHORT_NAME", "The Range 24/7"),
    timezone: env("CLARITY_TIMEZONE", "Pacific/Auckland"),
    contactEmail: env("CLARITY_CONTACT_EMAIL", ""),
    bookingUrl: env("CLARITY_BOOKING_URL", "https://book.claritygolf.app"),
    calendarSlug: env("CLARITY_CALENDAR_SLUG", "sam-hale-golf"),
  };
}

function defaultWorkspaceAccountFromCoachAccount(account = defaultCoachAccount()) {
  const slug = cleanSlug(account.calendarSlug || account.businessName, "sam-hale-golf");
  return {
    id: slug,
    name: account.businessName || "Sam Hale Golf",
    slug,
    planKey: "founder",
    subscriptionStatus: "comped",
    billingProvider: "none",
    active: true,
  };
}

function normalizeWorkspaceAccounts(rawAccounts: unknown, account = defaultCoachAccount()) {
  const fallback = defaultWorkspaceAccountFromCoachAccount(account);
  const source = Array.isArray(rawAccounts) && rawAccounts.length ? rawAccounts : [fallback];
  const seen = new Set<string>();
  return source.map((raw: any, index) => {
    const name = cleanString(raw?.name, fallback.name, 120);
    const baseSlug = cleanSlug(raw?.slug || raw?.id || name, fallback.slug);
    let id = cleanSlug(raw?.id, baseSlug);
    let suffix = 2;
    while (seen.has(id)) {
      id = `${baseSlug}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return {
      id,
      name,
      slug: baseSlug,
      planKey: cleanString(raw?.planKey, fallback.planKey, 40),
      subscriptionStatus: cleanString(raw?.subscriptionStatus, fallback.subscriptionStatus, 40),
      billingProvider: cleanString(raw?.billingProvider, fallback.billingProvider, 40),
      active: raw?.active !== false || index === 0,
      entitlementsOverride: raw?.entitlementsOverride && typeof raw.entitlementsOverride === "object" ? raw.entitlementsOverride : undefined,
    };
  });
}

function defaultAccountId(accounts: Array<{ id: string; active?: boolean }>) {
  return accounts.find((account) => account.active)?.id || accounts[0]?.id || defaultWorkspaceAccountFromCoachAccount().id;
}

function accountIsActive(account: any) {
  return account?.active !== false && ["trialing", "active", "comped", "internal", ""].includes(account?.subscriptionStatus || "comped");
}

function accountHasPublicBooking(account: any) {
  if (!accountIsActive(account)) return false;
  const override = account?.entitlementsOverride?.features?.publicBooking;
  return override !== false;
}

function recordBelongsToAccount(record: any, accountId: string) {
  return !record?.accountId || record.accountId === accountId;
}

function defaultCoachId(coaches: any[] = []) {
  return cleanSlug(coaches.find((coach) => coach?.active !== false && !coach?.archived)?.id || coaches[0]?.id || "sam-hale", "sam-hale");
}

function cleanJsonObject(value: unknown) {
  if (!value) return null;
  if (typeof value === "object") return value as Record<string, unknown>;
  return safeJsonParse<Record<string, unknown> | null>(value, null);
}

function rowToItem(row: any) {
  const coach = cleanJsonObject(row.coach);
  const location = cleanJsonObject(row.location);
  const customGroup = cleanJsonObject(row.custom_group);
  return {
    id: row.id,
    accountId: row.account_id || defaultWorkspaceAccountFromCoachAccount().id,
    kind: row.kind,
    week: Number(row.week ?? 0),
    day: Number(row.day ?? 0),
    start: Number(row.start ?? 0),
    duration: Number(row.duration ?? 0),
    coachId: row.coach_id || (coach as any)?.coachId || "",
    locationId: row.location_id || (location as any)?.locationId || "",
    serviceId: row.service_id || "",
    client: row.client || "",
    title: row.title || row.client || "Appointment",
    phone: row.phone || "",
    email: row.email || "",
    note: row.note || "",
    status: ["completed", "cancelled", "no_show"].includes(row.status) ? row.status : "booked",
    ...(coach ? { coach } : {}),
    ...(location ? { location } : {}),
    ...(customGroup ? { customGroup: Boolean((customGroup as any).customGroup), attendees: (customGroup as any).attendees || [], calculatedPrice: (customGroup as any).calculatedPrice || 0 } : {}),
  };
}

class SupabaseRest {
  url: string;
  key: string;
  omittedCalendarItemColumns = new Set<string>();

  constructor() {
    this.url = env("SUPABASE_URL").replace(/\/$/, "");
    this.key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
    if (!this.url || !this.key) {
      throw Object.assign(new Error("Supabase is not configured."), { status: 503 });
    }
  }

  async request(table: string, { method = "GET", query = "", body, prefer = "" }: { method?: string; query?: string; body?: unknown; prefer?: string } = {}) {
    const response = await fetch(`${this.url}/rest/v1/${table}${query ? `?${query}` : ""}`, {
      method,
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Supabase ${method} ${table} failed ${response.status}: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : [];
  }

  async readSettingsMap() {
    const rows = await this.request("settings", { query: "select=key,value" });
    return Object.fromEntries(rows.map((row: any) => [row.key, row.value || ""]));
  }

  async readItems() {
    const rows = await this.request("calendar_items", { query: "select=*&order=week.asc,day.asc,start.asc,id.asc" });
    return rows.map(rowToItem);
  }

  missingOptionalColumn(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (!/calendar_items/i.test(message)) return "";
    if (!/(schema cache|column|PGRST204|42703|Could not find)/i.test(message)) return "";
    return OPTIONAL_CALENDAR_ITEM_COLUMNS.find((column) => new RegExp(`['"\\`]${column}['"\\`]|\\b${column}\\b`, "i").test(message)) || "";
  }

  omitColumns(row: Record<string, unknown>, columns: string[]) {
    return Object.fromEntries(Object.entries(row).filter(([key, value]) => value !== undefined && !columns.includes(key)));
  }

  async upsertCalendarItem(row: Record<string, unknown>) {
    let omitted = [...this.omittedCalendarItemColumns];
    while (true) {
      try {
        await this.request("calendar_items", {
          method: "POST",
          query: "on_conflict=id",
          body: [this.omitColumns(row, omitted)],
          prefer: "resolution=merge-duplicates,return=minimal",
        });
        return omitted;
      } catch (error) {
        const missing = this.missingOptionalColumn(error);
        if (!missing || omitted.includes(missing)) throw error;
        const related = (ACCOUNT_SCOPE_COLUMNS.includes(missing) ? ACCOUNT_SCOPE_COLUMNS : [missing]).filter((column) => !omitted.includes(column));
        related.forEach((column) => this.omittedCalendarItemColumns.add(column));
        omitted = [...this.omittedCalendarItemColumns];
        console.warn("public_booking:optional_calendar_item_columns_omitted", { missing, related });
      }
    }
  }

  async savePerson(row: Record<string, unknown>) {
    const email = cleanEmail(row.email, "");
    const body = [{ ...row, email: email || null }];
    try {
      await this.request("people", {
        method: "POST",
        query: "on_conflict=id",
        body,
        prefer: "resolution=merge-duplicates,return=minimal",
      });
    } catch (error) {
      console.warn("public_booking:person_save_skipped", error instanceof Error ? error.message : String(error || ""));
    }
  }
}

function settingsValue(settings: Record<string, string>, key: string) {
  return settings[key] || "";
}

function publicStateFromSettings(settings: Record<string, string>, items: any[]) {
  const account = defaultCoachAccount();
  const workspaceAccounts = normalizeWorkspaceAccounts(safeJsonParse(settingsValue(settings, "workspaceAccountsJson"), []), account);
  const accountId = defaultAccountId(workspaceAccounts);
  return {
    account,
    workspaceAccounts,
    services: safeJsonParse<any[]>(settingsValue(settings, "servicesJson"), []),
    coaches: safeJsonParse<any[]>(settingsValue(settings, "coachProfilesJson"), []),
    locations: safeJsonParse<any[]>(settingsValue(settings, "locationsJson"), []),
    availability: safeJsonParse<any[][]>(settingsValue(settings, "availabilityJson"), []),
    items: items.filter((item) => recordBelongsToAccount(item, accountId)),
  };
}

function serviceLocationSnapshot(service: any, locations: any[], account: any) {
  const location = locations.find((candidate) => candidate?.id === service?.locationId && candidate?.archived !== true) || locations.find((candidate) => candidate?.isDefault) || locations[0];
  return {
    locationId: cleanSlug(location?.id || service?.locationId || "default-location", "default-location"),
    name: cleanString(location?.name || service?.location || account?.venueName, "The Range 24/7 - Three Kings", 140),
    shortName: cleanString(location?.shortName || location?.name || account?.venueShortName, "The Range 24/7", 80),
    address: cleanString(location?.address, "", 240),
    timezone: cleanString(location?.timezone || account?.timezone, "Pacific/Auckland", 80),
  };
}

function serviceCoachSnapshot(coachId: string, coaches: any[], account: any) {
  const coach = coaches.find((candidate) => candidate?.id === coachId) || coaches[0];
  return {
    coachId: cleanSlug(coach?.id || coachId || "sam-hale", "sam-hale"),
    name: cleanString(coach?.name || account?.coachName, "Sam Hale", 120),
    email: cleanEmail(coach?.email || account?.contactEmail, ""),
    phone: cleanString(coach?.phone, "", 80),
  };
}

function isScheduledGroupService(service: any) {
  return service?.lessonFormat === "group" && service?.customGroup !== true && service?.customGroupEnabled !== true;
}

function currentWeekOffset() {
  const today = new Date();
  const day = today.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const weekStart = new Date(today);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() + mondayOffset);
  const base = Date.UTC(2026, 5, 1);
  return Math.round((Date.UTC(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate()) - base) / (7 * 24 * 60 * 60 * 1000));
}

function isGroupSlotMatch(service: any, slot: any) {
  const schedule = service?.groupSchedule || {};
  if (!isScheduledGroupService(service) || schedule.active === false) return false;
  const occurrenceCount = Math.max(1, Math.min(52, Math.round(Number(schedule.occurrenceCount || 1))));
  const minWeek = currentWeekOffset();
  return slot.day === Number(schedule.dayOfWeek) && slot.start === Number(schedule.startMinutes) && slot.week >= minWeek && slot.week < minWeek + occurrenceCount;
}

function slotOverlaps(a: any, b: any) {
  return a.week === b.week && a.day === b.day && a.start < b.start + b.duration && a.start + a.duration > b.start;
}

function itemActiveForConflict(item: any) {
  return !["cancelled", "completed", "no_show"].includes(item?.status || "");
}

function hasCollision(items: any[], slot: any, service: any, state: any) {
  const candidateCoachId = service?.coachId || defaultCoachId(state.coaches || []);
  const candidateLocationId = serviceLocationSnapshot(service, state.locations || [], state.account).locationId;
  const overlaps = items.filter((item) => slotOverlaps(item, slot) && itemActiveForConflict(item));
  if (isScheduledGroupService(service)) {
    const sameServiceCount = overlaps.filter((item) => item.serviceId === service.id && item.kind === "appointment").length;
    const blocksOrOtherService = overlaps.some((item) => item.kind !== "appointment" || item.serviceId !== service.id);
    return blocksOrOtherService || sameServiceCount >= Number(service.capacity || 1);
  }
  return overlaps.some((item) => {
    const itemCoachId = item.coachId || item.coach?.coachId || candidateCoachId;
    const itemLocationId = item.locationId || item.location?.locationId || "";
    if (item.kind === "block") {
      return !itemCoachId || itemCoachId === candidateCoachId || !itemLocationId || itemLocationId === candidateLocationId;
    }
    return itemCoachId === candidateCoachId || (itemLocationId && itemLocationId === candidateLocationId && item.kind === "block");
  });
}

function isInsideAvailability(availability: any[][], day: number, start: number, duration: number, coachId: string) {
  const end = start + duration;
  const windows = Array.isArray(availability?.[day]) ? availability[day] : [];
  return windows.some((window) => {
    const windowCoachId = cleanSlug(window?.coachId || coachId, coachId);
    return windowCoachId === coachId && start >= Number(window?.start) && end <= Number(window?.end);
  });
}

async function createPublicBooking(payload: any) {
  const store = new SupabaseRest();
  const [settings, items] = await Promise.all([store.readSettingsMap(), store.readItems()]);
  const state = publicStateFromSettings(settings, items);
  const workspaceAccount = state.workspaceAccounts.find((account: any) => account.id === defaultAccountId(state.workspaceAccounts)) || state.workspaceAccounts[0] || defaultWorkspaceAccountFromCoachAccount(state.account);
  if (!accountHasPublicBooking(workspaceAccount)) {
    throw Object.assign(new Error("Public booking is not available for this workspace."), { status: 403 });
  }

  const accountId = workspaceAccount.id;
  const services = state.services.filter((service: any) => recordBelongsToAccount(service, accountId));
  const coaches = state.coaches.filter((coach: any) => recordBelongsToAccount(coach, accountId));
  const locations = state.locations.filter((location: any) => recordBelongsToAccount(location, accountId));
  const availability = (state.availability || []).map((day: any[]) => (Array.isArray(day) ? day.filter((window) => recordBelongsToAccount(window, accountId)) : []));
  const scopedState = { ...state, services, coaches, locations, availability, items: state.items };

  const service = services.find((candidate: any) => candidate.id === payload?.serviceId && candidate.active !== false && candidate.archived !== true && candidate.visibility === "public" && candidate.lessonFormat !== "package");
  if (!service) throw Object.assign(new Error("Choose a public lesson type."), { status: 400 });

  const week = Number(payload.week ?? 0);
  const day = Number(payload.day);
  const start = Number(payload.start);
  const duration = Number(service.duration || payload.duration || 0);
  const firstName = cleanString(payload.firstName, "", 80);
  const lastName = cleanString(payload.lastName, "", 80);
  const email = cleanEmail(payload.email, "");
  const phone = cleanString(payload.phone, "", 80);
  if (!firstName || !lastName || !email) {
    throw Object.assign(new Error("First name, last name, and email are required."), { status: 400 });
  }
  if (!Number.isInteger(week) || !Number.isInteger(day) || !Number.isInteger(start) || !Number.isInteger(duration) || day < 0 || day > 6 || duration <= 0) {
    throw Object.assign(new Error("Choose a valid appointment time."), { status: 400 });
  }

  const slot = { week, day, start, duration };
  const coachId = service.coachId || defaultCoachId(coaches);
  if (isScheduledGroupService(service)) {
    if (!isGroupSlotMatch(service, slot) || hasCollision(scopedState.items, slot, service, scopedState)) {
      throw Object.assign(new Error("That time is no longer available."), { status: 409 });
    }
  } else if (!isInsideAvailability(availability, day, start, duration, coachId) || hasCollision(scopedState.items, slot, service, scopedState)) {
    throw Object.assign(new Error("That time is no longer available."), { status: 409 });
  }

  const client = `${firstName} ${lastName}`;
  const location = serviceLocationSnapshot(service, locations, state.account);
  const coach = serviceCoachSnapshot(coachId, coaches, state.account);
  const appointment = {
    id: `appt-${Date.now()}`,
    accountId,
    kind: "appointment",
    ...slot,
    coachId,
    locationId: location.locationId,
    coach,
    serviceId: service.id,
    client,
    title: client,
    phone,
    email,
    note: "Booked from public booking page.",
    location,
    status: "booked",
  };

  await store.upsertCalendarItem({
    id: appointment.id,
    account_id: appointment.accountId,
    kind: appointment.kind,
    week: appointment.week,
    day: appointment.day,
    start: appointment.start,
    duration: appointment.duration,
    coach_id: appointment.coachId,
    location_id: appointment.locationId,
    service_id: appointment.serviceId,
    client: appointment.client,
    title: appointment.title,
    phone: appointment.phone,
    email: appointment.email,
    note: appointment.note,
    status: appointment.status,
    custom_group: null,
    coach: appointment.coach,
    location: appointment.location,
    created_at: nowIso(),
    updated_at: nowIso(),
  });
  await store.savePerson({
    id: randomUUID(),
    name: client,
    email,
    phone: phone || null,
    notes: appointment.note,
    source: "appointment",
    created_at: nowIso(),
    updated_at: nowIso(),
  });

  const nextItems = [...items, appointment].sort((a, b) => a.week - b.week || a.day - b.day || a.start - b.start || String(a.id).localeCompare(String(b.id)));
  return { appointment, state: { items: nextItems } };
}

async function parseBody(req: Request) {
  const raw = await req.text();
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed", message: "Use POST." }, 405);
  try {
    console.log("public_booking_lean:start");
    const result = await createPublicBooking(await parseBody(req));
    console.log("public_booking_lean:saved", result.appointment.id);
    return json({
      ok: true,
      appointment: {
        id: result.appointment.id,
        week: result.appointment.week,
        day: result.appointment.day,
        start: result.appointment.start,
        duration: result.appointment.duration,
        coachId: result.appointment.coachId,
        locationId: result.appointment.locationId,
        coach: result.appointment.coach,
        location: result.appointment.location,
      },
      state: { items: result.state.items },
      notifications: [],
    });
  } catch (error) {
    console.error("public_booking_lean:failed", error);
    const status = (error as any)?.status || 500;
    return json(
      {
        error: status === 500 ? "public_booking_error" : "request_error",
        message: error instanceof Error ? error.message : "Unknown public booking error",
      },
      status,
    );
  }
}

export const config: Config = { path: "/api/public-booking" };
