// The wire contract between the auth endpoints and the app shell.
//
// Three role vocabularies meet at the login response and they are not
// interchangeable:
//
//   AccountRole   owner | admin | coach            which business you act for
//   SessionRole   guest | coach | player           which app shell loads
//   AppUserRole   account_admin | coach | staff …  permissions inside that shell
//
// They were all typed `string` on both sides, so the server could answer with a
// value from one vocabulary where the client expected another and nothing
// objected. That is not hypothetical: a login once replied with the account
// role "owner" where a session role was expected, the client did not recognise
// it, mapped the user to `guest`, and a *successful* sign-in sat on the sign-in
// screen showing no error at all — 200, `authenticated: true`, and silence.
//
// This module exists so both halves import the same unions and a mismatch is a
// compile error rather than a silent demotion. src/ already imports directly
// from _shared for the same reason (see phone.mts): one definition, so the two
// sides cannot drift.

/** Which business an authenticated user acts for. From account_memberships. */
export type AccountRole = "owner" | "admin" | "coach";

/** Which app the shell should load. What /api/auth/* answers with. */
export type SessionRole = "guest" | "coach" | "player";

/** Permissions inside the coach app. What appUsersJson stores. */
export type AppUserRole = "account_admin" | "coach" | "staff" | "platform_admin" | "admin";

/**
 * The body of /api/auth/login and /api/auth/session.
 *
 * `role` is the session vocabulary — the only field the shell routes on.
 * `accountRole` reports the membership separately for anything that wants to
 * show it; nothing should route on it.
 */
export type AuthSessionResponse = {
  authenticated: boolean;
  role: SessionRole;
  accountRole?: AccountRole;
  accountId?: string;
  email?: string;
  name?: string;
  expiresAt?: string;
  /** Native clients only — the browser gets an HttpOnly cookie instead. */
  token?: string;
  error?: string;
  message?: string;
};

/**
 * Build an auth response with the union checked at the call site.
 *
 * Wrapping the literal is what makes this useful: booking-core.mts is largely
 * untyped, so an inline object would have been inferred as `{ role: string }`
 * and accepted anything.
 */
export function authSessionResponse(body: AuthSessionResponse): AuthSessionResponse {
  return body;
}
