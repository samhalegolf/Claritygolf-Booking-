import type { Config, Context } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

function safeErrorDetail(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error || "Unknown error");
  return raw.replace(/\s+/g, " ").slice(0, 700);
}

function errorStatus(error: unknown) {
  const status = Number((error as { status?: unknown })?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

export default async function handler(req: Request, context: Context) {
  try {
    return await handleBookingApiRoute(req, "/api/calendar-state", context);
  } catch (error) {
    console.error("calendar_state_wrapper:failed", error);
    return new Response(
      JSON.stringify({
        error: "calendar_state_error",
        details: safeErrorDetail(error),
        message:
          req.method === "PUT"
            ? "Your calendar change could not be saved. Please try again."
            : "Calendar data could not be loaded. Please refresh.",
      }),
      {
        status: errorStatus(error),
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }
}

export const config: Config = {
  path: "/api/calendar-state",
};
