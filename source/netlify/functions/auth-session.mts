import type { Config, Context } from "@netlify/functions";

import { json } from "./_shared/http.mts";
import { createServerTiming } from "./_shared/server-timing.mts";
import { playerSessionTokenFromRequest, sessionTokenFromRequest } from "./_shared/session-tokens.mts";

/**
 * Who is this request? The first thing every page load asks.
 *
 * A browser with no session cookie is answered here, before the booking core
 * is even loaded: that module and its dependencies are most of this function's
 * cold start, and a visitor arriving at the login screen has nothing in it to
 * look up. The core keeps the same early answer for the catch-all route, so the
 * two agree. Everything else -- a cookie to verify, a bearer token, a
 * cross-origin call from the native app that needs CORS headers -- goes to
 * the core, loaded on first use and kept for the instance's lifetime.
 */
export default async function handler(req: Request, context: Context) {
  const sameOriginGet = req.method === "GET" && !req.headers.get("origin");
  const adminToken = sessionTokenFromRequest(req);
  const playerToken = playerSessionTokenFromRequest(req);

  if (sameOriginGet && !playerToken) {
    if (!adminToken) {
      const timing = createServerTiming();
      return json(
        { authenticated: false, role: "guest" },
        200,
        { "Server-Timing": timing.header() },
      );
    }
    const { handleCoachAuthSession } = await import("./_shared/auth-session-handler.mts");
    return handleCoachAuthSession(req);
  }
  const { handleBookingApiRoute } = await import("./booking-core.mts");
  return handleBookingApiRoute(req, "/api/auth/session", context);
}

export const config: Config = {
  path: "/api/auth/session",
};
