import type { Config, Context } from "@netlify/functions";
import { randomUUID } from "node:crypto";
import { filterCalendarStateForContext, readItems } from "./_shared/bookings.mts";
import { requireCoachActor } from "./_shared/coach-auth.mts";
import { readSettingsMap, settingValue } from "./_shared/settings-store.mts";
import { cleanSlug, env, nowIso } from "./_shared/values.mts";
import {
  adminStateFromSettings,
  coachUserForMembership,
  publicCalendarState,
} from "./_shared/workspace-state.mts";
import { json } from "./_shared/http.mts";
import { createServerTiming } from "./_shared/server-timing.mts";

/**
 * GET /api/calendar-state: the coach calendar's first load.
 *
 * Answered here rather than by booking-core so a cold start does not have to
 * load the whole API first. Everything it sends is built by the same shared
 * modules booking-core uses, so this is a faster route to the same calendar,
 * not a second copy of it. Saves and deletes go to booking-core.
 */

type BookingCoreModule = {
  handleBookingApiRoute: (req: Request, forcedPathname?: string, context?: Context) => Promise<Response> | Response;
};

function safeErrorDetail(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error || "Unknown error");
  return raw.replace(/\s+/g, " ").slice(0, 1200);
}

function safeErrorStack(error: unknown) {
  return error instanceof Error && error.stack ? error.stack.replace(/\s+/g, " ").slice(0, 1600) : "";
}

function errorStatus(error: unknown) {
  const status = Number((error as { status?: unknown })?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

function jsonError(req: Request, error: unknown, phase: "import" | "handler" | "shell") {
  const status = errorStatus(error);
  return json(
    {
      error: phase === "import" ? "calendar_state_import_error" : "calendar_state_error",
      phase,
      details: safeErrorDetail(error),
      stack: safeErrorStack(error),
      message:
        req.method === "PUT"
          ? "Your calendar change could not be saved. Please try again."
          : "Calendar data could not be loaded. Please refresh.",
    },
    status,
  );
}

async function readTinyCalendarShell(req: Request, requestStartedAt: number) {
  // Server-Timing shows in the browser's network panel, so a slow calendar can
  // be split into auth and data without reading function logs.
  const timing = createServerTiming();
  let actor: Awaited<ReturnType<typeof requireCoachActor>>;
  try {
    actor = await timing.measure("auth", () => requireCoachActor(req));
  } catch (error) {
    return jsonError(req, error, "shell");
  }

  const shellStartedAt = Date.now();
  console.info("CALENDAR_SHELL_STATE_LOAD_STARTED", {
    route: "/api/calendar-state",
    routeUsed: "shell",
    entrypoint: "tiny",
    accountId: actor.accountId,
    role: actor.role,
  });

  const [settingsMap, items] = await timing.measure("data", () =>
    Promise.all([readSettingsMap(actor.accountId), readItems(actor.accountId)]),
  );
  const accountId = actor.accountId;
  const businessState = adminStateFromSettings(settingsMap, accountId);
  const coachName = settingValue(settingsMap, "accountCoachName") || businessState.account.coachName;
  const currentUser = coachUserForMembership(actor, businessState.coaches, coachName);
  const context = {
    accountId,
    isAdmin: actor.isAdmin,
    coachId: cleanSlug(currentUser.coachId, ""),
  };
  const shellLoadDurationMs = Date.now() - shellStartedAt;
  const responseDurationMs = Date.now() - requestStartedAt;
  const deferred = {
    people: true,
    notifications: true,
    googleSyncStatus: true,
  };

  console.info("PEOPLE_LOAD_DEFERRED", { route: "/api/calendar-state", routeUsed: "shell", entrypoint: "tiny" });
  console.info("NOTIFICATION_HISTORY_DEFERRED", { route: "/api/calendar-state", routeUsed: "shell", entrypoint: "tiny" });
  console.info("GOOGLE_SYNC_STATUS_DEFERRED", { route: "/api/calendar-state", routeUsed: "shell", entrypoint: "tiny" });
  console.info("NON_CRITICAL_DATA_DEFERRED", {
    route: "/api/calendar-state",
    routeUsed: "shell",
    entrypoint: "tiny",
    peopleDeferred: deferred.people,
    notificationsDeferred: deferred.notifications,
    googleSyncStatusDeferred: deferred.googleSyncStatus,
  });
  console.info("CALENDAR_SHELL_STATE_LOAD_COMPLETED", {
    route: "/api/calendar-state",
    routeUsed: "shell",
    entrypoint: "tiny",
    shellLoadDurationMs,
    responseDurationMs,
    itemCount: items.length,
    accountId,
    peopleDeferred: deferred.people,
    notificationsDeferred: deferred.notifications,
    googleSyncStatusDeferred: deferred.googleSyncStatus,
  });

  const state = {
    syncKey: settingValue(settingsMap, "syncKey") || env("CLARITY_CALENDAR_SYNC_KEY") || `cg_${randomUUID().replaceAll("-", "")}`,
    updatedAt: settingValue(settingsMap, "updatedAt") || nowIso(),
    items,
    ...businessState,
    currentUser,
    people: [],
    notifications: [],
    // No googleCalendar here on purpose: this route does not read the Google
    // status. The placeholder it used to send said configured: false, which the
    // client applied over the real status and greyed out Connect Google.
    diagnostics: {
      calendarState: {
        routeUsed: "shell",
        entrypoint: "tiny",
        shellLoadDurationMs,
        responseDurationMs,
        itemCount: items.length,
        peopleDeferred: deferred.people,
        notificationsDeferred: deferred.notifications,
        googleSyncStatusDeferred: deferred.googleSyncStatus,
      },
    },
  };

  return json(publicCalendarState(filterCalendarStateForContext(state, context)), 200, {
    "Server-Timing": timing.header(),
  });
}

async function delegateToBookingCore(req: Request, context: Context) {
  let bookingCore: BookingCoreModule;
  try {
    bookingCore = (await import("./booking-core.mts")) as BookingCoreModule;
  } catch (error) {
    console.error("calendar_state_wrapper:booking_core_import_failed", error);
    return jsonError(req, error, "import");
  }

  try {
    return await bookingCore.handleBookingApiRoute(req, "/api/calendar-state", context);
  } catch (error) {
    console.error("calendar_state_wrapper:handler_failed", error);
    return jsonError(req, error, "handler");
  }
}

export default async function handler(req: Request, context: Context) {
  if (req.method !== "GET") return delegateToBookingCore(req, context);
  const requestStartedAt = Date.now();
  try {
    return await readTinyCalendarShell(req, requestStartedAt);
  } catch (error) {
    console.error("calendar_state_wrapper:shell_failed", error);
    return jsonError(req, error, "shell");
  }
}

export const config: Config = {
  path: "/api/calendar-state",
};
