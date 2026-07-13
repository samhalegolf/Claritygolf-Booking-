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
const BASE_WEEK_START = Date.UTC(2026, 5, 1);
const CANCELLED_GROUP_SESSION_TITLE = "Cancelled group session";
const CANCELLED_GROUP_SESSION_NOTE = "__cancelled_group_session__";

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
  if (!value || typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
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
      entitlementsOverride:
        raw?.entitlementsOverride && typeof raw.entitlementsOverride === "object"
          ? raw.entitlementsOverride
          : undefined,
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
  const fallbackCoachId = defaultCoachAccount().id || "sam-hale-golf";
  return cleanSlug(
    coaches.find((coach) => coach?.isDefault && coach?.active !== false && !coach?.archived)?.id ||
      coaches.find((coach) => coach?.active !== false && !coach?.archived)?.id ||
      coaches[0]?.id ||
      fallbackCoachId,
    fallbackCoachId,
  );
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
    ...(customGroup
      ? {
          customGroup: Boolean((customGroup as any).customGroup),
          attendees: (customGroup as any).attendees || [],
          calculatedPrice: (customGroup as any).calculatedPrice || 0,
        }
      : {}),
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

  async request(
    table: string,
    { method = "GET", query = "", body, prefer = "" }: { method?: string; query?: string; body?: unknown; prefer?: string } = {},
  ) {
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

  async upsertSetting(key: string, value: string) {
    await this.request("settings", {
      method: "POST",
      query: "on_conflict=key",
      body: [{ key, value }],
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  }

  async readItems() {
    const rows = await this.request("calendar_items", { query: "select=*&order=week.asc,day.asc,start.asc,id.asc" });
    return rows.map(rowToItem);
  }

  calendarItemsWeekQuery(accountId: string, week: number, useAccountScope = true) {
    const query = ["select=*"];
    if (useAccountScope) query.push(`account_id=eq.${encodeURIComponent(accountId)}`);
    query.push(`week=eq.${encodeURIComponent(String(week))}`, "order=day.asc,start.asc,id.asc");
    return query.join("&");
  }

  missingAccountScopeColumn(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || "");
    return (
      /calendar_items/i.test(message) &&
      /account_id/i.test(message) &&
      /(schema cache|column|PGRST204|42703|Could not find|does not exist)/i.test(message)
    );
  }

  async readItemsForWeek(accountId: string, week: number) {
    const primaryQuery = this.calendarItemsWeekQuery(accountId, week, true);
    try {
      const rows = await this.request("calendar_items", { query: primaryQuery });
      return {
        items: rows.map(rowToItem),
        rowsFetched: rows.length,
        queryMode: "account_week",
      };
    } catch (error) {
      if (!this.missingAccountScopeColumn(error)) throw error;
      const fallbackQuery = this.calendarItemsWeekQuery(accountId, week, false);
      console.warn("public_booking_lean:calendar_items_account_scope_fallback", {
        accountId,
        week,
        error: errorMessage(error).slice(0, 300),
      });
      const rows = await this.request("calendar_items", { query: fallbackQuery });
      const items = rows.map(rowToItem).filter((item: any) => recordBelongsToAccount(item, accountId));
      return {
        items,
        rowsFetched: rows.length,
        queryMode: "week_only_legacy_schema",
      };
    }
  }

  missingOptionalColumn(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (!/calendar_items/i.test(message)) return "";
    if (!/(schema cache|column|PGRST204|42703|Could not find)/i.test(message)) return "";
    return OPTIONAL_CALENDAR_ITEM_COLUMNS.find((column) => new RegExp("['\"`]" + column + "['\"`]|\\b" + column + "\\b", "i").test(message)) || "";
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
    settings,
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
  return Math.round((Date.UTC(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate()) - BASE_WEEK_START) / (7 * 24 * 60 * 60 * 1000));
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

function isCancelledGroupSessionRecord(item: any, serviceId: string, session: any) {
  return (
    item?.kind === "block" &&
    (item?.note === CANCELLED_GROUP_SESSION_NOTE || item?.title === CANCELLED_GROUP_SESSION_TITLE) &&
    item?.serviceId === serviceId &&
    Number(item?.week ?? 0) === session.week &&
    Number(item?.day) === session.day &&
    Number(item?.start) === session.start
  );
}

// Recurring group sessions have no calendar row until someone books one, so overlapping
// occurrences must be synthesised as holds or a private lesson can land on top of them.
function scheduledGroupSessionHolds(items: any[], slot: any, service: any, state: any) {
  const services = state?.services || [];
  if (!Number.isInteger(slot?.week)) return [];
  const holds: any[] = [];
  for (const groupService of services) {
    if (groupService?.id === service?.id) continue;
    if (!groupService?.active || groupService.archived === true) continue;
    if (!isScheduledGroupService(groupService)) continue;
    const schedule = groupService.groupSchedule;
    if (!schedule || schedule.active === false) continue;
    const session = {
      week: slot.week,
      day: Number(schedule.dayOfWeek),
      start: Number(schedule.startMinutes),
      duration: Number(groupService.duration),
    };
    if (!isGroupSlotMatch(groupService, session)) continue;
    if (!slotOverlaps(session, slot)) continue;
    if (items.some((item) => isCancelledGroupSessionRecord(item, groupService.id, session))) continue;
    holds.push({
      ...session,
      id: `group-session-hold-${groupService.id}-${session.week}`,
      kind: "appointment",
      status: "booked",
      serviceId: groupService.id,
      coachId: groupService.coachId || defaultCoachId(state.coaches || []),
      locationId: serviceLocationSnapshot(groupService, state.locations || [], state.account).locationId,
      title: `${groupService.name} (group session)`,
    });
  }
  return holds;
}

function itemActiveForConflict(item: any) {
  return !["cancelled", "no_show"].includes(item?.status || "");
}

function explicitCoachId(item: any) {
  return cleanSlug(item?.coachId || item?.coach?.coachId || "", "");
}

function explicitLocationId(item: any) {
  return cleanSlug(item?.locationId || item?.location?.locationId || "", "");
}

function itemService(item: any, services: any[] = []) {
  return services.find((service) => service?.id && service.id === item?.serviceId);
}

function isLocationOnlyBlock(item: any) {
  return item?.kind === "block" && Boolean(explicitLocationId(item)) && !explicitCoachId(item);
}

function isCoachOnlyBlock(item: any) {
  return item?.kind === "block" && Boolean(explicitCoachId(item)) && !explicitLocationId(item);
}

function isCoachLocationBlock(item: any) {
  return item?.kind === "block" && Boolean(explicitCoachId(item)) && Boolean(explicitLocationId(item));
}

function resolvedItemCoachId(item: any, service: any, state: any) {
  return explicitCoachId(item) || service?.coachId || (item?.kind === "appointment" ? defaultCoachId(state.coaches || []) : "");
}

function resolvedItemLocationId(item: any, service: any, state: any) {
  const fallbackLocationId = serviceLocationSnapshot(service, state.locations || [], state.account).locationId;
  return explicitLocationId(item) || service?.locationId || (item?.kind === "appointment" ? fallbackLocationId : "");
}

function conflictItemSummary(item: any, state: any) {
  const service = itemService(item, state.services || []);
  return item
    ? {
        id: item.id,
        kind: item.kind,
        status: item.status || "booked",
        serviceId: item.serviceId || "",
        serviceName: service?.name || "",
        week: item.week ?? 0,
        day: item.day,
        start: item.start,
        duration: item.duration,
        coachId: resolvedItemCoachId(item, service, state) || explicitCoachId(item),
        locationId: resolvedItemLocationId(item, service, state) || explicitLocationId(item),
      }
    : null;
}

function findCollision(items: any[], slot: any, service: any, state: any) {
  const candidateCoachId = service?.coachId || defaultCoachId(state.coaches || []);
  const candidateLocationId = serviceLocationSnapshot(service, state.locations || [], state.account).locationId;
  const groupHolds = scheduledGroupSessionHolds(items, slot, service, state);
  const conflictItems = groupHolds.length ? [...items, ...groupHolds] : items;
  const overlaps = conflictItems.filter((item) => slotOverlaps(item, slot) && itemActiveForConflict(item));
  const isCoachConflict = (item: any) => {
    if (isLocationOnlyBlock(item)) return false;
    const existingService = itemService(item, state.services || []);
    const itemCoachId = resolvedItemCoachId(item, existingService, state);
    return Boolean(candidateCoachId && itemCoachId && candidateCoachId === itemCoachId);
  };
  const isLocationConflict = (item: any) => {
    const existingService = itemService(item, state.services || []);
    const itemLocationId = resolvedItemLocationId(item, existingService, state);
    if (!candidateLocationId || !itemLocationId || candidateLocationId !== itemLocationId) return false;
    if (isLocationOnlyBlock(item)) return true;
    if (isCoachOnlyBlock(item)) return false;
    if (isCoachLocationBlock(item)) return isCoachConflict(item);
    return false;
  };
  const isAppointmentConflict = (item: any) => isCoachConflict(item) || isLocationConflict(item);
  if (isScheduledGroupService(service)) {
    const blockingItem = overlaps.find((item) => (item.kind !== "appointment" || item.serviceId !== service.id) && isAppointmentConflict(item));
    if (blockingItem) return { reason: "blocking_item", item: blockingItem, candidateCoachId, candidateLocationId };
    const sameService = overlaps.filter((item) => item.serviceId === service.id && item.kind === "appointment");
    if (sameService.length >= Number(service.capacity || 1)) {
      return { reason: "capacity_full", item: sameService[0], candidateCoachId, candidateLocationId };
    }
    return null;
  }
  const item = overlaps.find(isAppointmentConflict);
  return item ? { reason: "blocking_item", item, candidateCoachId, candidateLocationId } : null;
}

function hasCollision(items: any[], slot: any, service: any, state: any) {
  return Boolean(findCollision(items, slot, service, state));
}

function isInsideAvailability(availability: any[][], day: number, start: number, duration: number, coachId: string) {
  const end = start + duration;
  const windows = Array.isArray(availability?.[day]) ? availability[day] : [];
  return windows.some((window) => {
    const windowCoachId = cleanSlug(window?.coachId || coachId, coachId);
    return windowCoachId === coachId && start >= Number(window?.start) && end <= Number(window?.end);
  });
}

function publicSlotUnavailableError(detail: Record<string, unknown>, stateItems: any[]) {
  console.warn("public_booking_lean:slot_rejected", detail);
  return Object.assign(new Error("That time is no longer available."), {
    status: 409,
    detail,
    stateItems,
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function slotDateLabel(week = 0, day = 0) {
  const date = new Date(BASE_WEEK_START);
  date.setUTCDate(date.getUTCDate() + Number(week || 0) * 7 + Number(day || 0));
  return date.toLocaleDateString("en-NZ", { weekday: "long", month: "short", day: "numeric", year: "numeric" });
}

function timeLabel(minutes = 0) {
  const value = Number(minutes || 0);
  const hour24 = Math.floor(value / 60);
  const mins = value % 60;
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour = hour24 % 12 || 12;
  return `${hour}:${String(mins).padStart(2, "0")} ${period}`;
}

function rangeLabel(start = 0, duration = 0) {
  return `${timeLabel(start)}-${timeLabel(Number(start || 0) + Number(duration || 0))}`;
}

function fallbackRecipient(settings: Record<string, string> = {}, account = defaultCoachAccount()) {
  return (
    cleanEmail(settings.notificationEmail, "") ||
    cleanEmail(settings.coachEmail, "") ||
    cleanEmail(account.contactEmail, "") ||
    cleanEmail(env("CLARITY_NOTIFICATION_EMAIL"), "") ||
    cleanEmail(env("CLARITY_CONTACT_EMAIL"), "") ||
    "samhalegolf@gmail.com"
  );
}

function emailFrom(settings: Record<string, string> = {}, account = defaultCoachAccount()) {
  const businessName = cleanString(settings.accountBusinessName, account.businessName, 140) || "Sam Hale Golf";
  return env("CLARITY_EMAIL_FROM", `${businessName} <onboarding@resend.dev>`);
}

function fallbackEmailBody(input: { appointment: any; service: any; settings: Record<string, string>; account: any; fallbackId: string; error: string }) {
  const rows = [
    ["Fallback appointment id", input.fallbackId],
    ["Timestamp", nowIso()],
    ["Route/function", "public-booking"],
    ["Customer", input.appointment.client],
    ["Phone", input.appointment.phone || "not supplied"],
    ["Email", input.appointment.email],
    ["Service", input.service?.name || input.appointment.serviceId || "Unknown service"],
    ["Date", slotDateLabel(input.appointment.week, input.appointment.day)],
    ["Time", rangeLabel(input.appointment.start, input.appointment.duration)],
    ["Raw slot", `week=${input.appointment.week}, day=${input.appointment.day}, start=${input.appointment.start}, duration=${input.appointment.duration}`],
    ["Location", [input.appointment.location?.name, input.appointment.location?.address].filter(Boolean).join(" · ") || input.appointment.locationId],
    ["Coach", input.appointment.coach?.name || input.appointment.coachId],
    ["Exact error/status/response", input.error],
  ] as Array<[string, string]>;
  const text = ["URGENT fallback booking — public booking did not save normally", "", ...rows.map(([label, value]) => `${label}: ${value}`)].join("\n");
  const htmlRows = rows
    .map(([label, value]) => `<tr><td style="font-weight:700;padding:6px 10px;border-bottom:1px solid #e8ede6">${escapeHtml(label)}</td><td style="padding:6px 10px;border-bottom:1px solid #e8ede6">${escapeHtml(value)}</td></tr>`)
    .join("");
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.5;color:#172017"><h1>URGENT fallback booking</h1><p>Public booking did not save normally. Customer was shown the normal confirmed booking screen. Manually add this booking.</p><table cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#fff;border:1px solid #e8ede6">${htmlRows}</table></div>`;
  return { text, html };
}

async function sendFallbackBookingEmail(input: { appointment: any; service: any; settings: Record<string, string>; account: any; fallbackId: string; error: string }) {
  const apiKey = env("RESEND_API_KEY");
  if (!apiKey) throw new Error("fallback email failed: missing RESEND_API_KEY");
  const to = fallbackRecipient(input.settings, input.account);
  if (!cleanEmail(to, "")) throw new Error("fallback email failed: missing fallback recipient");
  const body = fallbackEmailBody(input);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `public-booking-fallback-${input.fallbackId}`,
    },
    body: JSON.stringify({
      from: emailFrom(input.settings, input.account),
      to: [to],
      subject: "URGENT fallback booking — public booking did not save normally",
      html: body.html,
      text: body.text,
      reply_to: input.appointment.email,
    }),
  });
  const responseText = await response.text().catch(() => "");
  if (!response.ok) throw new Error(`fallback email failed ${response.status}: ${responseText.slice(0, 500)}`);
}

function logUncapturedFallback(label: string, detail: { appointment: any; service?: any; supabaseError?: string; fallbackEmailError?: string; originalError?: string }) {
  console.error(label, {
    route: "public-booking",
    timestamp: nowIso(),
    serviceId: detail.appointment?.serviceId,
    serviceName: detail.service?.name,
    fallbackAppointmentId: detail.appointment?.id,
    customer: detail.appointment?.client,
    phone: detail.appointment?.phone,
    email: detail.appointment?.email,
    week: detail.appointment?.week,
    day: detail.appointment?.day,
    start: detail.appointment?.start,
    duration: detail.appointment?.duration,
    location: detail.appointment?.location,
    coach: detail.appointment?.coach,
    supabaseError: detail.supabaseError,
    fallbackEmailError: detail.fallbackEmailError,
    originalError: detail.originalError,
  });
}

function successPayload(appointment: any, items: any[], fallback = false, fallbackEmailSent?: boolean) {
  return {
    ok: true,
    ...(fallback ? { fallback: true, fallbackEmailSent: Boolean(fallbackEmailSent) } : {}),
    appointment: {
      id: appointment.id,
      week: appointment.week,
      day: appointment.day,
      start: appointment.start,
      duration: appointment.duration,
      coachId: appointment.coachId,
      locationId: appointment.locationId,
      coach: appointment.coach,
      location: appointment.location,
    },
    state: { items },
    notifications: [],
  };
}

async function createPublicBooking(payload: any) {
  const store = new SupabaseRest();
  const settings = await store.readSettingsMap();
  const state = publicStateFromSettings(settings, []);
  const workspaceAccount = state.workspaceAccounts.find((account: any) => account.id === defaultAccountId(state.workspaceAccounts)) || state.workspaceAccounts[0] || defaultWorkspaceAccountFromCoachAccount(state.account);
  if (!accountHasPublicBooking(workspaceAccount)) {
    throw Object.assign(new Error("Public booking is not available for this workspace."), { status: 403 });
  }

  const accountId = workspaceAccount.id;
  const services = state.services.filter((service: any) => recordBelongsToAccount(service, accountId));
  const coaches = state.coaches.filter((coach: any) => recordBelongsToAccount(coach, accountId));
  const locations = state.locations.filter((location: any) => recordBelongsToAccount(location, accountId));
  const availability = (state.availability || []).map((day: any[]) => (Array.isArray(day) ? day.filter((window) => recordBelongsToAccount(window, accountId)) : []));

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

  const itemRead = await store.readItemsForWeek(accountId, week);
  const items = itemRead.items.filter((item: any) => recordBelongsToAccount(item, accountId));
  console.info("public_booking_lean:items_read", {
    accountId,
    week,
    rowsFetched: itemRead.rowsFetched,
    itemCount: items.length,
    queryMode: itemRead.queryMode,
  });
  const scopedState = { ...state, services, coaches, locations, availability, items };
  const slot = { week, day, start, duration };
  const coachId = service.coachId || defaultCoachId(coaches);
  const location = serviceLocationSnapshot(service, locations, state.account);
  const rejectionBase = {
    serviceId: service.id,
    serviceName: service.name,
    slot,
    coachId,
    locationId: location.locationId,
    itemCount: items.length,
  };
  if (isScheduledGroupService(service)) {
    if (!isGroupSlotMatch(service, slot)) {
      throw publicSlotUnavailableError({ ...rejectionBase, reason: "group_schedule_mismatch" }, scopedState.items);
    }
    const collision = findCollision(scopedState.items, slot, service, scopedState);
    if (collision) {
      throw publicSlotUnavailableError(
        {
          ...rejectionBase,
          reason: collision.reason,
          candidateCoachId: collision.candidateCoachId,
          candidateLocationId: collision.candidateLocationId,
          conflictItem: conflictItemSummary(collision.item, scopedState),
        },
        scopedState.items,
      );
    }
  } else if (!isInsideAvailability(availability, day, start, duration, coachId)) {
    throw publicSlotUnavailableError({ ...rejectionBase, reason: "outside_availability", availability: availability[day] || [] }, scopedState.items);
  } else {
    const collision = findCollision(scopedState.items, slot, service, scopedState);
    if (collision) {
      throw publicSlotUnavailableError(
        {
          ...rejectionBase,
          reason: collision.reason,
          candidateCoachId: collision.candidateCoachId,
          candidateLocationId: collision.candidateLocationId,
          conflictItem: conflictItemSummary(collision.item, scopedState),
        },
        scopedState.items,
      );
    }
  }

  const client = `${firstName} ${lastName}`;
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

  try {
    const savedAt = nowIso();
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
      created_at: savedAt,
      updated_at: savedAt,
    });
    await store.upsertSetting("updatedAt", savedAt).catch((error) => {
      console.warn("public_booking_lean:updated_at_save_skipped", errorMessage(error));
    });
  } catch (error) {
    const fallbackId = `fallback-appt-${Date.now()}`;
    const fallbackAppointment = { ...appointment, id: fallbackId };
    const supabaseError = errorMessage(error);
    let fallbackEmailSent = false;
    console.error("public_booking_lean:calendar_save_failed_customer_still_confirmed", supabaseError);
    try {
      await sendFallbackBookingEmail({
        appointment: fallbackAppointment,
        service,
        settings,
        account: state.account,
        fallbackId,
        error: supabaseError,
      });
      fallbackEmailSent = true;
      console.warn("public_booking_lean:fallback_email_sent", fallbackId);
    } catch (fallbackError) {
      logUncapturedFallback("public_booking_lean:fallback_email_failed_customer_still_confirmed", {
        appointment: fallbackAppointment,
        service,
        supabaseError,
        fallbackEmailError: errorMessage(fallbackError),
      });
    }
    return successPayload(fallbackAppointment, state.items, true, fallbackEmailSent);
  }

  await store.savePerson({
    id: randomUUID(),
    name: client,
    email,
    phone: phone || null,
    notes: null,
    source: "appointment",
    created_at: nowIso(),
    updated_at: nowIso(),
  });

  const nextItems = [...items, appointment].sort((a, b) => a.week - b.week || a.day - b.day || a.start - b.start || String(a.id).localeCompare(String(b.id)));
  return successPayload(appointment, nextItems, false);
}

async function fallbackFromRawPayload(payload: any, originalError: unknown) {
  const fallbackItems = Array.isArray((originalError as any)?.stateItems) ? (originalError as any).stateItems : [];
  const firstName = cleanString(payload?.firstName, "", 80);
  const lastName = cleanString(payload?.lastName, "", 80);
  const email = cleanEmail(payload?.email, "");
  const hasWeek = payload?.week !== undefined && payload?.week !== null && payload?.week !== "";
  const hasDay = payload?.day !== undefined && payload?.day !== null && payload?.day !== "";
  const hasStart = payload?.start !== undefined && payload?.start !== null && payload?.start !== "";
  const week = Number(payload?.week);
  const day = Number(payload?.day);
  const start = Number(payload?.start);
  if (
    !payload?.serviceId ||
    !firstName ||
    !lastName ||
    !email ||
    !hasWeek ||
    !hasDay ||
    !hasStart ||
    !Number.isInteger(week) ||
    !Number.isInteger(day) ||
    !Number.isInteger(start) ||
    day < 0 ||
    day > 6
  ) {
    throw originalError;
  }
  const fallbackId = `fallback-appt-${Date.now()}`;
  const account = defaultCoachAccount();
  const appointment = {
    id: fallbackId,
    accountId: defaultWorkspaceAccountFromCoachAccount(account).id,
    kind: "appointment",
    week,
    day,
    start,
    duration: Number(payload.duration ?? 0),
    coachId: cleanSlug(payload.coachId, account.id || "sam-hale-golf"),
    locationId: cleanSlug(payload.locationId, "default-location"),
    coach: payload.coach || { coachId: cleanSlug(payload.coachId, account.id || "sam-hale-golf"), name: account.coachName },
    serviceId: cleanString(payload.serviceId, "", 180),
    client: `${firstName} ${lastName}`,
    title: `${firstName} ${lastName}`,
    phone: cleanString(payload.phone, "", 80),
    email,
    note: "Booked from public booking page. Supabase read/save failed before full validation.",
    location: payload.location || { locationId: cleanSlug(payload.locationId, "default-location"), name: account.venueName, timezone: account.timezone },
    status: "booked",
  };
  let fallbackEmailSent = false;
  try {
    await sendFallbackBookingEmail({
      appointment,
      service: { id: appointment.serviceId, name: appointment.serviceId },
      settings: {},
      account,
      fallbackId,
      error: errorMessage(originalError),
    });
    fallbackEmailSent = true;
  } catch (fallbackError) {
    logUncapturedFallback("public_booking_lean:raw_payload_fallback_email_failed_customer_still_confirmed", {
      appointment,
      service: { id: appointment.serviceId, name: appointment.serviceId },
      originalError: errorMessage(originalError),
      fallbackEmailError: errorMessage(fallbackError),
    });
  }
  return successPayload(appointment, fallbackItems, true, fallbackEmailSent);
}

async function parseBody(req: Request) {
  const raw = await req.text();
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed", message: "Use POST." }, 405);
  let payload: any = {};
  try {
    payload = await parseBody(req);
    console.log("public_booking_lean:start");
    const result = await createPublicBooking(payload);
    console.log(result.fallback ? "public_booking_lean:fallback_confirmed" : "public_booking_lean:saved", result.appointment.id);
    return json(result);
  } catch (error) {
    const status = (error as any)?.status || 500;
    try {
      const fallback = await fallbackFromRawPayload(payload, error);
      console.warn("public_booking_lean:any_error_payload_fallback_confirmed", {
        fallbackAppointmentId: fallback.appointment.id,
        originalStatus: status,
        originalError: errorMessage(error),
      });
      return json(fallback);
    } catch (fallbackError) {
      console.error("public_booking_lean:any_error_payload_fallback_unavailable", fallbackError);
    }
    console.error("public_booking_lean:failed", error);
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
