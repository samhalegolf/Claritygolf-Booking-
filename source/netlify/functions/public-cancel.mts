import type { Config, Context } from "@netlify/functions";

import { syncGoogleCalendarIfEnabled } from "./google-calendar-sync.mts";
import { notifyBookingEvent } from "./notification-engine.mts";
import { defaultAccountId as fallbackAccountId, defaultCalendarSlug } from "./_shared/account.mts";

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown, fallback = "", max = 500) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : fallback;
}

function normalizeContact(value: unknown) {
  return cleanString(value, "", 180)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function readWorkspaceAccount() {
  const rows = await supabase("settings", { query: "select=key,value&key=in.(workspaceAccountsJson,accountCalendarSlug,accountId)" });
  const settings = Object.fromEntries(rows.map((row: any) => [row.key, row.value]));
  let accounts: any[] = [];
  try {
    accounts = settings.workspaceAccountsJson ? JSON.parse(settings.workspaceAccountsJson) : [];
  } catch {
    accounts = [];
  }
  return accounts.find((account: any) => account?.active !== false) || {
    id: settings.accountCalendarSlug || settings.accountId || fallbackAccountId(),
    planKey: "founder",
    subscriptionStatus: "comped",
    active: true,
  };
}

function accountHasPublicBooking(account: any) {
  if (account?.active === false) return false;
  if (!["trialing", "active", "comped", "internal"].includes(account?.subscriptionStatus || "active")) return false;
  if (account?.entitlementsOverride?.features?.publicBooking === false) return false;
  if (account?.entitlementsOverride?.features?.publicBooking === true) return true;
  return ["solo", "studio", "academy", "enterprise", "founder"].includes(account?.planKey || "solo");
}

async function parseBody(req: Request) {
  try {
    return await req.json();
  } catch {
    return {};
  }
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
  if (!response.ok) {
    throw new Error(
      `Supabase ${options.method || "GET"} ${table} failed ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  return text ? JSON.parse(text) : [];
}

function missingCalendarAccountColumn(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return (
    /calendar_items/i.test(message) &&
    /account_id/i.test(message) &&
    /(42703|PGRST204|column|schema cache|does not exist|Could not find)/i.test(message)
  );
}

async function deleteVerifiedAppointment(appointmentId: string, accountId: string) {
  try {
    await supabase("calendar_items", {
      method: "DELETE",
      query: `id=eq.${encodeURIComponent(appointmentId)}&account_id=eq.${encodeURIComponent(accountId)}`,
      prefer: "return=minimal",
    });
  } catch (error) {
    if (!missingCalendarAccountColumn(error)) throw error;
    console.warn("public_cancel:account_id_column_missing_delete_fallback", error);
    await supabase("calendar_items", {
      method: "DELETE",
      query: `id=eq.${encodeURIComponent(appointmentId)}`,
      prefer: "return=minimal",
    });
  }
}

async function readRemainingRowsForWeek(accountId: string, week: number) {
  try {
    const rows = await supabase("calendar_items", {
      query: `select=*&account_id=eq.${encodeURIComponent(accountId)}&week=eq.${encodeURIComponent(String(week))}&order=day.asc,start.asc,id.asc`,
    });
    return { rows, rowsFetched: rows.length, queryMode: "account_week" };
  } catch (error) {
    if (!missingCalendarAccountColumn(error)) throw error;
    console.warn("public_cancel:account_id_column_missing_refresh_fallback", error);
    const rows = await supabase("calendar_items", {
      query: `select=*&week=eq.${encodeURIComponent(String(week))}&order=day.asc,start.asc,id.asc`,
    });
    const filteredRows = rows.filter((row: any) => (row.account_id || accountId) === accountId);
    return { rows: filteredRows, rowsFetched: rows.length, queryMode: "week_only_legacy_schema" };
  }
}

function rowToItem(row: any) {
  return {
    id: row.id,
    accountId: row.account_id || fallbackAccountId(),
    kind: row.kind,
    week: Number(row.week ?? 0),
    day: Number(row.day ?? 0),
    start: Number(row.start ?? 0),
    duration: Number(row.duration ?? 0),
    serviceId: row.service_id || "",
    client: row.client || row.title || "Client",
    title: row.title || row.client || "Booking",
    phone: row.phone || "",
    email: row.email || "",
    note: row.note || "",
    status:
      row.status === "completed" ||
      row.status === "cancelled" ||
      row.status === "no_show"
        ? row.status
        : "booked",
  };
}

async function cancelPublicBooking(payload: any) {
  const appointmentId = cleanString(payload?.appointmentId, "", 140);
  const email = normalizeContact(payload?.email);
  const phone = normalizeContact(payload?.phone);

  if (!appointmentId || !email || !phone) {
    throw Object.assign(new Error("Choose the booking to cancel."), {
      status: 400,
    });
  }

  const rows = await supabase("calendar_items", {
    query: `select=*&id=eq.${encodeURIComponent(appointmentId)}&limit=1`,
  });
  const account = await readWorkspaceAccount();
  if (!accountHasPublicBooking(account)) {
    throw Object.assign(new Error("Public booking is not available for this account."), { status: 403 });
  }
  const row = rows[0];
  if (
    !row ||
    (row.account_id || account.id) !== account.id ||
    row.kind !== "appointment" ||
    normalizeContact(row.email) !== email ||
    normalizeContact(row.phone) !== phone
  ) {
    throw Object.assign(new Error("That booking could not be verified."), {
      status: 404,
    });
  }

  const appointment = rowToItem(row);

  // The booking deletion is authoritative. Settings, Google Calendar and
  // notification updates are secondary and must not turn a completed
  // cancellation into a misleading failure response.
  await deleteVerifiedAppointment(appointmentId, account.id);

  await supabase("settings", {
    method: "POST",
    query: "on_conflict=key",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: [{ key: "updatedAt", value: nowIso(), updated_at: nowIso() }],
  }).catch((error) => console.error("public_cancel:updated_at_failed", error));

  let stateItems: any[] | null = null;
  try {
    const remainingRead = await readRemainingRowsForWeek(account.id, appointment.week);
    console.info("public_cancel:remaining_items_read", {
      accountId: account.id,
      week: appointment.week,
      rowsFetched: remainingRead.rowsFetched,
      itemCount: remainingRead.rows.length,
      queryMode: remainingRead.queryMode,
    });
    stateItems = remainingRead.rows.map(rowToItem).map((item: any) => ({
      id: item.id,
      kind: item.kind,
      week: item.week,
      day: item.day,
      start: item.start,
      duration: item.duration,
      serviceId: item.serviceId,
    }));
  } catch (error) {
    console.error("public_cancel:state_refresh_failed", error);
  }

  return { appointment, stateItems };
}

function schedulePublicCancelSideEffects(context: Context | undefined, appointment: any) {
  const task = (async () => {
    await syncGoogleCalendarIfEnabled().catch((error) =>
      console.error("public_cancel:google_calendar_sync_failed", error),
    );

    try {
      await notifyBookingEvent({
        action: "cancelled",
        appointment,
        previousAppointment: appointment,
        source: "public-cancel",
      });
    } catch (error) {
      console.error("public_cancel:notification_failed", error);
    }
  })().catch((error) => console.error("public_cancel:side_effects_failed", appointment?.id, error));

  if (context && typeof context.waitUntil === "function") {
    context.waitUntil(task);
  }
}

export default async function handler(req: Request, context: Context) {
  try {
    if (req.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }

    const result = await cancelPublicBooking(await parseBody(req));
    schedulePublicCancelSideEffects(context, result.appointment);
    return json({
      ok: true,
      appointment: {
        id: result.appointment.id,
        week: result.appointment.week,
        day: result.appointment.day,
        start: result.appointment.start,
        duration: result.appointment.duration,
      },
      ...(result.stateItems ? { state: { items: result.stateItems } } : {}),
      notifications: [],
      notificationStatus: "queued",
    });
  } catch (error: any) {
    console.error("public_cancel:failed", error);
    const status = error?.status || 500;
    return json(
      {
        error: status === 500 ? "public_cancel_error" : "request_error",
        message:
          error instanceof Error
            ? error.message
            : "Unknown public cancellation error",
      },
      status,
    );
  }
}

export const config: Config = {
  path: "/api/public-cancel",
};
