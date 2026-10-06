import type { Config, Context } from "@netlify/functions";

import { json } from "./_shared/http.mts";
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
  if (
    req.method === "GET" &&
    !req.headers.get("origin") &&
    !sessionTokenFromRequest(req) &&
    !playerSessionTokenFromRequest(req)
  ) {
    return json({ authenticated: false, role: "guest" });
  }
  const { handleBookingApiRoute } = await import("./booking-core.mts");
  return handleBookingApiRoute(req, "/api/auth/session", context);
}

export const config: Config = {
  path: "/api/auth/session",
};
