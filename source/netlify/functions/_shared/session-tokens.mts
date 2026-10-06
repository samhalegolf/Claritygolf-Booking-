// Where a request carries its session, read without the booking core.
//
// Two cookies and one header. The admin cookie is the coach's; the player
// cookie is a separate space so a coach who is also a player on the same
// browser can hold both without one masquerading as the other. The native app
// is served from capacitor://localhost, where a SameSite=Lax cookie is never
// sent, so it carries the same player token in an Authorization header
// instead: same token, same table, same expiry, only the transport differs.
//
// These live here rather than in booking-core.mts so that auth-session.mts can
// answer "no session" without loading the booking core at all -- which is what
// every visitor arriving at the login screen asks it, and the one request a
// cold start sits in front of.

export const sessionCookieName = "clarity_session";
export const playerSessionCookieName = "clarity_player_session";

export function parseCookies(req: Request): Record<string, string> {
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

export function sessionTokenFromRequest(req: Request): string {
  return parseCookies(req)[sessionCookieName] || "";
}

function bearerTokenFromRequest(req: Request): string {
  const header = req.headers.get("authorization") || "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : "";
}

export function playerSessionTokenFromRequest(req: Request): string {
  return bearerTokenFromRequest(req) || parseCookies(req)[playerSessionCookieName] || "";
}
