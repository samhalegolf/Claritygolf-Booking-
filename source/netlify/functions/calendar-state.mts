import type { Config } from "@netlify/functions";
import { createHash, randomUUID } from "node:crypto";

import { getGoogleCalendarSyncStatus, syncGoogleCalendarIfEnabled } from "./google-calendar-sync.mts";

const sessionCookieName = "clarity_session";

const defaultServices = [
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
  paymentInstructions:
    "Please pay by bank transfer and use the invoice number as reference.",
  customFields: [],
};

const defaultAvailability = [
  [{ start: 990, end: 1200 }],
  [],
  [{ start: 840, end: 1200 }],
  [
    { start: 420, end: 660 },
    { start: 840, end: 990 },
  ],
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
  return typeof value === "string"
    ? value.trim().slice(0, max) || fallback
    : fallback;
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
          : [
              decodeURIComponent(pair.slice(0, index)),
              decodeURIComponent(pair.slice(index + 1)),
            ];
      }),
  );
}

function supabaseConfig() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("Supabase is not configured.");
  return { url, key };
}

async function supabase(
  table: string,
  options: {
    method?: string;
    query?: string;
    body?: unknown;
    prefer?: string;
  } = {},
) {
  const { url, key } = supabaseConfig();
  const response = await fetch(
    `${url}/rest/v1/${table}${options.query ? `?${options.query}` : ""}`,
    {
      method: options.method || "GET",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(options.prefer ? { Prefer: options.prefer } : {}),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    },
  );
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `Supabase ${options.method || "GET"} ${table} failed ${response.status}: ${text.slice(0, 500)}`,
    );
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

function parseJsonSetting<T>(
  settings: Record<string, string>,
  key: string,
  fallback: T,
): T {
  try {
    return settings[key] ? JSON.parse(settings[key]) : fallback;
  } catch {
    return fallback;
  }
}

function rowToItem(row: any) {
  const status = ["completed", "cancelled", "no_show"].includes(row.status)
    ? row.status
    : "booked";
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
      item?.status === "completed" ||
      item?.status === "cancelled" ||
      item?.status === "no_show"
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

  // A contact's email is not their identity: families and organisations can
  // legitimately share one address. Use the full booking contact snapshot for
  // a stable candidate id, then resolve against existing people more carefully
  // below. The booking itself remains authoritative regardless of client sync.
  const identitySource = [
    cleanString(name, "", 180).toLowerCase().replace(/\s+/g, " ").trim(),
    cleanString(item.email, "", 180).toLowerCase(),
    cleanString(item.phone, "", 80).replace(/\D/g, ""),
  ].join("|");
  const identityHash = createHash("sha256")
    .update(identitySource || randomUUID())
    .digest("hex")
    .slice(0, 32);

  return {
    id: `person-${identityHash}`,
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

function normalizedEmail(value: unknown) {
  return cleanString(value, "", 180).toLowerCase();
}

function normalizedName(value: unknown) {
  return cleanString(value, "", 180).toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizedPhone(value: unknown) {
  return cleanString(value, "", 80).replace(/\D/g, "");
}

function normalizedNamePhoneKey(person: { name?: unknown; phone?: unknown }) {
  const name = normalizedName(person?.name);
  const phone = normalizedPhone(person?.phone);
  return name && phone ? `${name}|${phone}` : "";
}

function normalizedNameEmailKey(person: { name?: unknown; email?: unknown }) {
  const name = normalizedName(person?.name);
  const email = normalizedEmail(person?.email);
  return name && email ? `${name}|${email}` : "";
}

function namesAreCompatible(candidate: any, existing: any) {
  const candidateName = normalizedName(candidate?.name);
  const existingName = normalizedName(existing?.name);
  return !candidateName || !existingName || candidateName === existingName;
}

function phonesAreCompatible(candidate: any, existing: any) {
  const candidatePhone = normalizedPhone(candidate?.phone);
  const existingPhone = normalizedPhone(existing?.phone);
  return !candidatePhone || !existingPhone || candidatePhone === existingPhone;
}

function chooseCompatiblePerson(candidate: any, rows: any[]) {
  if (!Array.isArray(rows) || !rows.length) return null;

  const candidateId = cleanString(candidate?.id, "", 140);
  if (candidateId) {
    const exactId = rows.find((row) => String(row?.id || "") === candidateId);
    if (exactId) return exactId;
  }

  const nameEmailKey = normalizedNameEmailKey(candidate || {});
  if (nameEmailKey) {
    const exact = rows.find(
      (row) => normalizedNameEmailKey(row || {}) === nameEmailKey,
    );
    if (exact) return exact;
  }

  const namePhoneKey = normalizedNamePhoneKey(candidate || {});
  if (namePhoneKey) {
    const exact = rows.find(
      (row) => normalizedNamePhoneKey(row || {}) === namePhoneKey,
    );
    if (exact) return exact;
  }

  // Only use a single email match when the names and phones do not conflict.
  // This prevents two family members who share an address from being merged.
  const email = normalizedEmail(candidate?.email);
  if (email) {
    const emailMatches = rows.filter(
      (row) => normalizedEmail(row?.email) === email,
    );
    if (emailMatches.length === 1) {
      const only = emailMatches[0];
      if (
        namesAreCompatible(candidate, only) &&
        phonesAreCompatible(candidate, only)
      )
        return only;
    }
  }

  // The same conservative rule applies to phone-only matching.
  const phone = normalizedPhone(candidate?.phone);
  if (phone) {
    const phoneMatches = rows.filter(
      (row) => normalizedPhone(row?.phone) === phone,
    );
    if (phoneMatches.length === 1) {
      const only = phoneMatches[0];
      if (namesAreCompatible(candidate, only)) return only;
    }
  }

  return null;
}

function isDuplicatePersonEmailError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return (
    message.includes("Supabase POST people failed 409") &&
    (message.includes("idx_people_email_unique") ||
      message.includes('"23505"') ||
      message.includes("lower(email)"))
  );
}

async function findPeopleByEmail(value: unknown) {
  const email = normalizedEmail(value);
  if (!email) return [] as any[];
  const rows = await supabase("people", {
    query: `select=*&email=ilike.${encodeURIComponent(email)}&limit=50`,
  });
  return rows.filter((row: any) => normalizedEmail(row?.email) === email);
}

function mergePersonForUpsert(candidate: any, existing: any | null) {
  if (!existing) return candidate;
  return {
    id: existing.id,
    name: candidate.name || existing.name,
    email: existing.email || candidate.email || null,
    phone: candidate.phone || existing.phone || null,
    notes: candidate.notes || existing.notes || null,
    source: existing.source || candidate.source || "appointment",
    caddy_profile_id:
      existing.caddy_profile_id || candidate.caddy_profile_id || null,
    caddy_profile_url:
      existing.caddy_profile_url || candidate.caddy_profile_url || null,
    created_at: existing.created_at || candidate.created_at || nowIso(),
    updated_at: nowIso(),
  };
}

async function resolvePeopleForUpsert(candidates: any[]) {
  if (!candidates.length) return [];

  const existingRows = await supabase("people", {
    query: "select=*&limit=10000",
  });

  const workingRows = [...existingRows];
  const resolved: any[] = [];

  for (const candidate of candidates) {
    let existing = chooseCompatiblePerson(candidate, workingRows);

    // Supabase/PostgREST can cap broad collection reads. When a candidate was
    // not found, perform a targeted email lookup, but still require compatible
    // identity details before reusing a person row.
    if (!existing && normalizedEmail(candidate?.email)) {
      existing = chooseCompatiblePerson(
        candidate,
        await findPeopleByEmail(candidate.email),
      );
    }

    const person = mergePersonForUpsert(candidate, existing);
    resolved.push(person);

    const index = workingRows.findIndex(
      (row) => String(row?.id || "") === String(person?.id || ""),
    );
    if (index >= 0) workingRows[index] = person;
    else workingRows.push(person);
  }

  return uniqueById(resolved);
}

async function patchPersonById(person: any) {
  const id = cleanString(person?.id, "", 140);
  if (!id) throw new Error("Cannot update a client record without an id.");
  const { id: _id, ...patch } = person;
  await supabase("people", {
    method: "PATCH",
    query: `id=eq.${encodeURIComponent(id)}`,
    prefer: "return=minimal",
    body: patch,
  });
}

async function syncPersonByIdentity(candidate: any) {
  const email = normalizedEmail(candidate?.email);
  const emailMatches = email ? await findPeopleByEmail(email) : [];
  const existing = chooseCompatiblePerson(candidate, emailMatches);
  if (existing) {
    await patchPersonById(mergePersonForUpsert(candidate, existing));
    return true;
  }

  try {
    await supabase("people", {
      method: "POST",
      query: "on_conflict=id",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: [candidate],
    });
    return true;
  } catch (error) {
    // Before the shared-contact migration is applied, a legacy unique email
    // index may still reject a different person who shares an address. Reuse a
    // row only when identity details are compatible; otherwise leave the
    // booking saved and report a non-blocking client-directory warning.
    if (!email || !isDuplicatePersonEmailError(error)) throw error;
    const matched = chooseCompatiblePerson(
      candidate,
      await findPeopleByEmail(email),
    );
    if (!matched) return false;
    await patchPersonById(mergePersonForUpsert(candidate, matched));
    return true;
  }
}

async function syncPeopleBestEffort(candidates: any[]) {
  if (!candidates.length) return [] as string[];

  try {
    const people = await resolvePeopleForUpsert(candidates);
    if (people.length) {
      await supabase("people", {
        method: "POST",
        query: "on_conflict=id",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: people,
      });
    }
    return [] as string[];
  } catch (error) {
    if (isDuplicatePersonEmailError(error)) {
      console.warn("calendar_state:people_email_conflict_recovering", error);
      let needsReview = 0;
      for (const candidate of candidates) {
        try {
          if (!(await syncPersonByIdentity(candidate))) needsReview += 1;
        } catch (personError) {
          needsReview += 1;
          console.warn("calendar_state:person_sync_warning", personError);
        }
      }
      if (!needsReview) return [] as string[];
    } else {
      console.warn("calendar_state:people_sync_warning", error);
    }

    // Calendar items hold their own contact snapshot and are the authoritative
    // lesson record. Client-directory synchronisation is secondary and must not
    // turn a successfully stored booking change into a fatal save error.
    return ["Calendar saved. Some client profiles need review."];
  }
}

function postgrestQuotedList(values: string[]) {
  return values
    .map(
      (value) =>
        `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
    )
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
  const [settingsRows, itemRows, peopleRows, notificationRows] =
    await Promise.all([
      supabase("settings", { query: "select=key,value" }),
      supabase("calendar_items", {
        query: "select=*&order=week.asc,day.asc,start.asc,id.asc",
      }),
      supabase("people", { query: "select=*&order=name.asc,email.asc,id.asc" }),
      supabase("notification_history", {
        query: "select=*&order=created_at.desc&limit=500",
      }),
    ]);
  const settings = settingMap(settingsRows);
  const updatedAt = settings.updatedAt || nowIso();
  if (!settings.updatedAt) await setSetting("updatedAt", updatedAt);
  if (!settings.syncKey)
    await setSetting(
      "syncKey",
      env("CLARITY_CALENDAR_SYNC_KEY") ||
        `cg_${randomUUID().replaceAll("-", "")}`,
    );

  return {
    syncKey: settings.syncKey || env("CLARITY_CALENDAR_SYNC_KEY") || "",
    updatedAt,
    items: itemRows.map(rowToItem),
    services: parseJsonSetting(settings, "servicesJson", defaultServices),
    availability: parseJsonSetting(
      settings,
      "availabilityJson",
      defaultAvailability,
    ),
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
      emailNotificationsEnabled: settings.emailNotificationsEnabled !== "false",
      notificationEmail: settings.notificationEmail || env("CLARITY_NOTIFICATION_EMAIL", ""),
      coachEmail: settings.coachEmail || env("CLARITY_COACH_EMAIL", ""),
      replyToEmail: settings.replyToEmail || env("CLARITY_REPLY_TO_EMAIL", ""),
      notificationDelaySeconds: Number(settings.notificationDelaySeconds || 30),
      sendClientEmail: settings.sendClientEmail !== "false",
      sendCoachEmail: settings.sendCoachEmail !== "false",
      sendAdminEmail: settings.sendAdminEmail !== "false",
      clientEmailSubject: settings.clientEmailSubject || "Your {{service}} is confirmed",
      clientEmailIntro:
        settings.clientEmailIntro ||
        "Thanks {{firstName}}, your booking with {{coach}} is confirmed.",
      clientEmailFooter:
        settings.clientEmailFooter ||
        "Need to move your booking? Reply to this email and we will help.",
      adminEmailSubject: settings.adminEmailSubject || "New booking: {{client}}",
      adminEmailIntro:
        settings.adminEmailIntro ||
        "{{client}} booked {{service}} for {{date}} at {{time}}.",
      smsProviderName: settings.smsProviderName || "",
      smsWebhookUrl: settings.smsWebhookUrl || "",
      smsFromNumber: settings.smsFromNumber || "",
      sendClientSms: settings.sendClientSms === "true",
      sendAdminSms: settings.sendAdminSms === "true",
    },
    brand: {
      logoName: settings.brandLogoName || "",
      logoPreview: settings.brandLogoPreview || "",
      showLogo: settings.brandShowLogo === "true",
      neutral: settings.brandNeutral || "#ffffff",
      primary: settings.brandPrimary || "#1fd36d",
      secondary: settings.brandSecondary || "#d7b06b",
      accent: settings.brandAccent || "#07100a",
      bookingTheme: settings.brandBookingTheme || "dark",
    },
    account: {
      id: settings.accountId || "sam-hale-golf",
      coachName: settings.accountCoachName || env("CLARITY_COACH_NAME", "Sam Hale"),
      businessName:
        settings.accountBusinessName || env("CLARITY_BUSINESS_NAME", "Sam Hale Golf"),
      venueName:
        settings.accountVenueName ||
        env("CLARITY_VENUE_NAME", "The Range 24/7 - Three Kings"),
      venueShortName:
        settings.accountVenueShortName || env("CLARITY_VENUE_SHORT_NAME", "The Range 24/7"),
      timezone: settings.accountTimezone || env("CLARITY_TIMEZONE", "Pacific/Auckland"),
      contactEmail: settings.accountContactEmail || env("CLARITY_CONTACT_EMAIL", ""),
      bookingUrl:
        settings.accountBookingUrl || env("CLARITY_BOOKING_URL", "https://book.claritygolf.app"),
      calendarSlug: settings.accountCalendarSlug || "sam-hale-golf",
      caddyWorkspaceUrl:
        settings.accountCaddyWorkspaceUrl ||
        env("CLARITY_CADDY_WORKSPACE_URL", "https://caddy.claritygolf.app"),
      invoiceSettings: parseJsonSetting(
        settings,
        "accountInvoiceSettingsJson",
        defaultInvoiceSettings,
      ),
    },
    googleCalendar: await getGoogleCalendarSyncStatus(),
  };
}

async function writeState(body: any) {
  const hasItemsPayload = Object.prototype.hasOwnProperty.call(body || {}, "items");
  const shouldReplaceItems = body?.replaceItems === true || body?.itemsOperation === "replace";
  const rows = uniqueById(Array.isArray(body?.items) ? body.items.map(itemToRow) : []);
  const warnings: string[] = [];

  if (hasItemsPayload && rows.length) {
    // Calendar items are the authoritative lesson records. Store them before
    // attempting the secondary client-directory synchronisation.
    await supabase("calendar_items", {
      method: "POST",
      query: "on_conflict=id",
      body: rows,
      prefer: "resolution=merge-duplicates,return=minimal",
    });

    const keepIds = postgrestQuotedList(rows.map((row) => row.id));
    if (shouldReplaceItems && keepIds) {
      await supabase("calendar_items", {
        method: "DELETE",
        query: `id=not.in.(${keepIds})`,
        prefer: "return=minimal",
      });
    }

    const peopleCandidates = uniqueById(
      rows
        .map(personFromItem)
        .filter(
          (person): person is NonNullable<ReturnType<typeof personFromItem>> =>
            Boolean(person),
        ),
    );
    warnings.push(...(await syncPeopleBestEffort(peopleCandidates)));
  } else if (
    hasItemsPayload &&
    (body?.clearItems === true || shouldReplaceItems)
  ) {
    // An empty replacement is an intentional clear-all operation. Malformed
    // requests cannot reach this branch because the handler requires an array.
    await supabase("calendar_items", {
      method: "DELETE",
      query: "id=not.is.null",
      prefer: "return=minimal",
    });
  }

  if (body?.settings && typeof body.settings === "object") {
    const nextSettings = body.settings as Record<string, unknown>;
    const settingKeys = [
      "emailNotificationsEnabled",
      "notificationEmail",
      "coachEmail",
      "replyToEmail",
      "notificationDelaySeconds",
      "sendClientEmail",
      "sendCoachEmail",
      "sendAdminEmail",
      "clientEmailSubject",
      "clientEmailIntro",
      "clientEmailFooter",
      "adminEmailSubject",
      "adminEmailIntro",
      "smsProviderName",
      "smsWebhookUrl",
      "smsFromNumber",
      "sendClientSms",
      "sendAdminSms",
    ];
    for (const key of settingKeys) {
      if (Object.prototype.hasOwnProperty.call(nextSettings, key)) {
        await setSetting(key, String(nextSettings[key] ?? ""));
      }
    }
  }

  if (typeof body?.syncKey === "string") await setSetting("syncKey", body.syncKey);
  await setSetting("updatedAt", nowIso());

  let googleCalendarSync = null;
  if (hasItemsPayload) {
    try {
      googleCalendarSync = await syncGoogleCalendarIfEnabled();
    } catch (error) {
      googleCalendarSync = {
        ...(await getGoogleCalendarSyncStatus()),
        ok: false,
        skipped: false,
        error: error instanceof Error ? error.message : "Google Calendar sync failed.",
      };
      warnings.push(
        `Calendar saved, but Google Calendar did not sync: ${googleCalendarSync.error}`,
      );
    }
  }

  const state = await readState();
  return {
    ...state,
    ...(googleCalendarSync ? { googleCalendarSync } : {}),
    ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
  };
}

async function parseBody(req: Request) {
  const raw = await req.text();
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req: Request) {
  try {
    if (!(await requireAdmin(req)))
      return json(
        { error: "unauthorized", message: "Admin login required." },
        401,
      );
    if (req.method === "GET") return json(await readState());
    if (req.method === "PUT") {
      const body = await parseBody(req);
      if (!Array.isArray(body?.items)) {
        return json(
          {
            error: "invalid_calendar_state",
            message:
              "PUT /api/calendar-state requires body.items to be an array.",
          },
          400,
        );
      }
      return json(await writeState(body));
    }
    return json({ error: "method_not_allowed" }, 405);
  } catch (error) {
    console.error("calendar_state:failed", error);
    return json(
      {
        error: "calendar_state_error",
        message:
          req.method === "PUT"
            ? "Your calendar change could not be saved. Please try again."
            : "Calendar data could not be loaded. Please refresh.",
      },
      500,
    );
  }
}

export const config: Config = {
  path: "/api/calendar-state",
};
