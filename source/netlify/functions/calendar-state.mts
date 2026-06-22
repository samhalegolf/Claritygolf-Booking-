import type { Config } from "@netlify/functions";
import { createHash, randomUUID } from "node:crypto";

const sessionCookieName = "clarity_session";

const defaultServices = [
  { id: "lesson-30", name: "30min Lesson", duration: 30, price: 100, description: "Price Includes Bay Hire", visibility: "public", active: true, capacity: 1, minParticipants: 1, lessonFormat: "private", priceMode: "session", location: "Bay hire included" },
  { id: "lesson-60", name: "1 Hour Golf Lesson", duration: 60, price: 180, description: "Price Includes Bay Hire", visibility: "public", active: true, capacity: 1, minParticipants: 1, lessonFormat: "private", priceMode: "session", location: "Bay hire included" },
  { id: "lesson-pair", name: "2 Person Golf Lesson", duration: 60, price: 200, description: "Two-player coaching session", visibility: "public", active: true, capacity: 2, minParticipants: 1, lessonFormat: "private", priceMode: "session", location: "Bay hire included" },
  { id: "group-clinic", name: "Group Golf Clinic", duration: 90, price: 55, description: "Small-group coaching session with shared practice goals", visibility: "public", active: true, capacity: 6, minParticipants: 3, lessonFormat: "group", priceMode: "per-person", location: "Group coaching bay" },
  { id: "member-30", name: "30min Golf Lesson (Range 24/7 Member)", duration: 30, price: 90, description: "Bay hire is deducted from membership account", visibility: "public", active: true, capacity: 1, minParticipants: 1, lessonFormat: "private", priceMode: "session", location: "Range 24/7 member bay" },
  { id: "member-60", name: "1 Hour Golf Lesson (Range 24/7 Member)", duration: 60, price: 160, description: "Bay hire is deducted from membership account", visibility: "public", active: true, capacity: 1, minParticipants: 1, lessonFormat: "private", priceMode: "session", location: "Range 24/7 member bay" },
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

const defaultInvoiceSettings = {
  enabled: true,
  showBillingWorkspace: true,
  prefix: "INV",
  nextNumber: 1001,
  currency: "NZD",
  taxName: "GST",
  taxNumber: "",
  taxRate: 15,
  bankAccount: "",
  paymentTermsDays: 7,
  businessAddress: "",
  headerText: "",
  footerText: "Thank you for training with Sam Hale Golf.",
  paymentInstructions: "Please pay by bank transfer and use the invoice number as reference.",
  customFields: [],
};

const defaultAvailability = [
  [{ start: 990, end: 1200 }],
  [],
  [{ start: 840, end: 1200 }],
  [{ start: 420, end: 660 }, { start: 840, end: 990 }],
  [{ start: 840, end: 960 }],
  [],
  [{ start: 900, end: 1080 }],
];

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
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

function nowIso() {
  return new Date().toISOString();
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function cleanString(value: unknown, fallback = "", max = 600) {
  return typeof value === "string" ? value.trim().slice(0, max) || fallback : fallback;
}

function parseCookies(req: Request) {
  const cookieHeaderValue = req.headers.get("cookie") || "";
  return Object.fromEntries(
    cookieHeaderValue
      .split(";")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const index = pair.indexOf("=");
        return index === -1
          ? [decodeURIComponent(pair), ""]
          : [decodeURIComponent(pair.slice(0, index)), decodeURIComponent(pair.slice(index + 1))];
      }),
  );
}

function supabaseConfig() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("Supabase is not configured.");
  return { url, key };
}

async function supabase(table: string, options: { method?: string; query?: string; body?: unknown; prefer?: string } = {}) {
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/${table}${options.query ? `?${options.query}` : ""}`, {
    method: options.method || "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.prefer ? { Prefer: options.prefer } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${options.method || "GET"} ${table} failed ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : [];
}

async function requireAdmin(req: Request) {
  const token = parseCookies(req)[sessionCookieName] || "";
  if (!token) return false;
  const rows = await supabase("admin_sessions", {
    query: `select=id&token_hash=eq.${encodeURIComponent(hashToken(token))}&expires_at=gt.${encodeURIComponent(nowIso())}&limit=1`,
  });
  return rows.length > 0;
}

function settingMap(rows: Array<{ key: string; value: string }>) {
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function parseJsonSetting<T>(settings: Record<string, string>, key: string, fallback: T): T {
  try {
    return settings[key] ? JSON.parse(settings[key]) : fallback;
  } catch {
    return fallback;
  }
}

function rowToItem(row: any) {
  const status = ["completed", "cancelled", "no_show"].includes(row.status) ? row.status : "booked";
  return {
    id: row.id,
    kind: row.kind,
    week: Number(row.week ?? 0),
    day: Number(row.day ?? 0),
    start: Number(row.start ?? 0),
    duration: Number(row.duration ?? 0),
    serviceId: row.service_id || "",
    client: row.client || "",
    title: row.title || row.client || "Booking",
    phone: row.phone || "",
    email: row.email || "",
    note: row.note || "",
    status,
  };
}

function itemToRow(item: any) {
  const kind = item?.kind === "block" ? "block" : "appointment";
  return {
    id: cleanString(item?.id, `${kind}-${randomUUID()}`, 140),
    kind,
    week: Number.isInteger(Number(item?.week)) ? Number(item.week) : 0,
    day: Math.max(0, Math.min(6, Number(item?.day ?? 0))),
    start: Math.max(0, Math.min(1440, Number(item?.start ?? 0))),
    duration: Math.max(15, Math.min(720, Number(item?.duration ?? 30))),
    service_id: cleanString(item?.serviceId, "", 140) || null,
    client: cleanString(item?.client, "", 160) || null,
    title: cleanString(item?.title, item?.client || "Booking", 160),
    phone: cleanString(item?.phone, "", 80) || null,
    email: cleanString(item?.email, "", 180).toLowerCase() || null,
    note: cleanString(item?.note, "", 1200) || null,
    status:
      item?.status === "completed" || item?.status === "cancelled" || item?.status === "no_show"
        ? item.status
        : "booked",
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

function personFromItem(item: ReturnType<typeof itemToRow>) {
  if (item.kind !== "appointment") return null;
  const name = item.client || item.title;
  if (!name && !item.email && !item.phone) return null;
  return {
    id: item.email ? `email-${Buffer.from(item.email).toString("base64url")}` : `person-${randomUUID()}`,
    name: name || item.email || item.phone || "Client",
    email: item.email,
    phone: item.phone,
    notes: item.note,
    source: "appointment",
    caddy_profile_id: null,
    caddy_profile_url: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

function uniqueById<T extends { id?: string | null }>(rows: T[]) {
  const byId = new Map<string, T>();
  for (const row of rows) {
    if (!row.id) continue;
    byId.set(row.id, row);
  }
  return [...byId.values()];
}

function postgrestQuotedList(values: string[]) {
  return values
    .map((value) => `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
    .join(",");
}

async function setSetting(key: string, value: unknown) {
  await supabase("settings", {
    method: "POST",
    query: "on_conflict=key",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: [{ key, value: String(value ?? ""), updated_at: nowIso() }],
  });
}

async function readState() {
  const [settingsRows, itemRows, peopleRows, notificationRows] = await Promise.all([
    supabase("settings", { query: "select=key,value" }),
    supabase("calendar_items", { query: "select=*&order=week.asc,day.asc,start.asc,id.asc" }),
    supabase("people", { query: "select=*&order=name.asc,email.asc,id.asc" }),
    supabase("notification_history", { query: "select=*&order=created_at.desc&limit=500" }),
  ]);
  const settings = settingMap(settingsRows);
  const updatedAt = settings.updatedAt || nowIso();
  if (!settings.updatedAt) await setSetting("updatedAt", updatedAt);
  if (!settings.syncKey) await setSetting("syncKey", env("CLARITY_CALENDAR_SYNC_KEY") || `cg_${randomUUID().replaceAll("-", "")}`);

  return {
    syncKey: settings.syncKey || env("CLARITY_CALENDAR_SYNC_KEY") || "",
    updatedAt,
    items: itemRows.map(rowToItem),
    services: parseJsonSetting(settings, "servicesJson", defaultServices),
    availability: parseJsonSetting(settings, "availabilityJson", defaultAvailability),
    people: peopleRows,
    notifications: notificationRows.map((row: any) => ({
      id: row.id,
      personKey: row.person_key || "",
      calendarItemId: row.calendar_item_id || "",
      recipient: row.recipient || "",
      subject: row.subject || "",
      kind: row.kind || "",
      status: row.status || "",
      provider: row.provider || "",
      providerId: row.provider_id || "",
      error: row.error || "",
      createdAt: row.created_at || "",
    })),
    settings: {
      notificationEmail: settings.notificationEmail || env("CLARITY_NOTIFICATION_EMAIL", "sam@samhalegolf.co.nz"),
      replyToEmail: settings.replyToEmail || env("CLARITY_REPLY_TO_EMAIL", "sam@samhalegolf.co.nz"),
      notificationDelaySeconds: Number(settings.notificationDelaySeconds || 30),
      sendClientEmail: settings.sendClientEmail !== "false",
      sendAdminEmail: settings.sendAdminEmail !== "false",
      clientEmailSubject: settings.clientEmailSubject || "Your {{service}} is confirmed",
      clientEmailIntro: settings.clientEmailIntro || "Thanks {{firstName}}, your booking with {{coach}} is confirmed.",
      clientEmailFooter: settings.clientEmailFooter || "Need to move your booking? Reply to this email and we will help.",
      adminEmailSubject: settings.adminEmailSubject || "New booking: {{client}}",
      adminEmailIntro: settings.adminEmailIntro || "{{client}} booked {{service}} for {{date}} at {{time}}.",
    },
    brand: {
      logoName: settings.brandLogoName || "",
      logoPreview: settings.brandLogoPreview || "",
      neutral: settings.brandNeutral || "#ffffff",
      primary: settings.brandPrimary || "#1fd36d",
      secondary: settings.brandSecondary || "#d7b06b",
      accent: settings.brandAccent || "#07100a",
      bookingTheme: settings.brandBookingTheme || "dark",
    },
    account: {
      id: settings.accountId || "sam-hale-golf",
      coachName: settings.accountCoachName || env("CLARITY_COACH_NAME", "Sam Hale"),
      businessName: settings.accountBusinessName || env("CLARITY_BUSINESS_NAME", "Sam Hale Golf"),
      venueName: settings.accountVenueName || env("CLARITY_VENUE_NAME", "The Range 24/7 - Three Kings"),
      venueShortName: settings.accountVenueShortName || env("CLARITY_VENUE_SHORT_NAME", "The Range 24/7"),
      timezone: settings.accountTimezone || env("CLARITY_TIMEZONE", "Pacific/Auckland"),
      contactEmail: settings.accountContactEmail || env("CLARITY_CONTACT_EMAIL", "sam@samhalegolf.co.nz"),
      bookingUrl: settings.accountBookingUrl || env("CLARITY_BOOKING_URL", "https://book.claritygolf.app"),
      calendarSlug: settings.accountCalendarSlug || "sam-hale-golf",
      caddyWorkspaceUrl: settings.accountCaddyWorkspaceUrl || env("CLARITY_CADDY_WORKSPACE_URL", "https://caddy.claritygolf.app"),
      invoiceSettings: parseJsonSetting(settings, "accountInvoiceSettingsJson", defaultInvoiceSettings),
    },
  };
}

async function writeState(body: any) {
  const rows = uniqueById(Array.isArray(body?.items) ? body.items.map(itemToRow) : []);
  if (rows.length) {
    await supabase("calendar_items", {
      method: "POST",
      query: "on_conflict=id",
      body: rows,
      prefer: "resolution=merge-duplicates,return=minimal",
    });

    const keepIds = postgrestQuotedList(rows.map((row) => row.id));
    if (keepIds) {
      await supabase("calendar_items", {
        method: "DELETE",
        query: `id=not.in.(${keepIds})`,
        prefer: "return=minimal",
      });
    }

    const people = uniqueById(
      rows
        .map(personFromItem)
        .filter((person): person is NonNullable<ReturnType<typeof personFromItem>> => Boolean(person)),
    );
    if (people.length) {
      await supabase("people", {
        method: "POST",
        query: "on_conflict=id",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: people,
      });
    }
  } else {
    await supabase("calendar_items", { method: "DELETE", query: "id=not.is.null", prefer: "return=minimal" });
  }
  if (typeof body?.syncKey === "string") await setSetting("syncKey", body.syncKey);
  await setSetting("updatedAt", nowIso());
  return readState();
}

async function parseBody(req: Request) {
  const raw = await req.text();
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req: Request) {
  try {
    if (!(await requireAdmin(req))) return json({ error: "unauthorized", message: "Admin login required." }, 401);
    if (req.method === "GET") return json(await readState());
    if (req.method === "PUT") {
      const body = await parseBody(req);
      if (!Array.isArray(body?.items)) {
        return json(
          { error: "invalid_calendar_state", message: "PUT /api/calendar-state requires body.items to be an array." },
          400,
        );
      }
      return json(await writeState(body));
    }
    return json({ error: "method_not_allowed" }, 405);
  } catch (error) {
    console.error("calendar_state:failed", error);
    return json(
      { error: "calendar_state_error", message: error instanceof Error ? error.message : "Calendar state failed." },
      500,
    );
  }
}

export const config: Config = {
  path: "/api/calendar-state",
};
