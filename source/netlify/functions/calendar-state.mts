import type { Config, Context } from "@netlify/functions";

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

function jsonError(req: Request, error: unknown, phase: "import" | "handler") {
  const status = errorStatus(error);
  return new Response(
    JSON.stringify({
      error: phase === "import" ? "calendar_state_import_error" : "calendar_state_error",
      phase,
      details: safeErrorDetail(error),
      stack: safeErrorStack(error),
      message:
        req.method === "PUT"
          ? "Your calendar change could not be saved. Please try again."
          : "Calendar data could not be loaded. Please refresh.",
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

export default async function handler(req: Request, context: Context) {
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

export const config: Config = {
  path: "/api/calendar-state",
};
