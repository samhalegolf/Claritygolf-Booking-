// The one place that knows who is signed in.
//
// The app used to decide this twice: the admin shell checked /api/auth/session
// for itself, and the player portal was chosen by hostname before React even
// mounted. Now the server answers once, with a role, and the entry point routes
// on it -- so the same login screen can lead to two different apps.
//
// It is also the one place that signs in, because signing in is where the
// native build picks up its bearer token. Doing that inside the login form
// would put the token somewhere the portal and the coach app cannot see.

import { apiFetch, clearAuthToken, setAuthToken } from "./apiFetch";
// The same definitions the auth endpoints answer with. Imported rather than
// restated so the client cannot expect a vocabulary the server does not send --
// which is what let a successful login read as a guest. src/ already imports
// from _shared for this reason (see phone.mts).
import type {
  AuthSessionResponse,
  SessionRole as WireSessionRole,
} from "../../../netlify/functions/_shared/auth-contract.mts";

export type SessionRole = WireSessionRole;

export type Session = {
  role: SessionRole;
  email: string;
  name: string;
};

export const guestSession: Session = { role: "guest", email: "", name: "" };

type SessionResponse = Partial<AuthSessionResponse>;

function toSession(data: SessionResponse | null | undefined): Session {
  if (!data?.authenticated) return guestSession;
  const role: SessionRole =
    data.role === "coach" ? "coach" : data.role === "player" ? "player" : "guest";
  if (role === "guest") return guestSession;
  return { role, email: data.email || "", name: data.name || "" };
}

export async function fetchSession(): Promise<Session> {
  try {
    const response = await apiFetch("/api/auth/session");
    if (!response.ok) return guestSession;
    return toSession((await response.json().catch(() => null)) as SessionResponse);
  } catch {
    // Offline or the function is down. Treat it as signed out: the login screen
    // says so plainly, which beats a workspace that silently has no data.
    return guestSession;
  }
}

/**
 * Signs in and returns the role the server decided on. Throws with the
 * server's own message when the credentials are wrong, which is the only thing
 * the caller has to render.
 */
export async function login(email: string, password: string): Promise<Session> {
  const response = await apiFetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = (await response.json().catch(() => ({}))) as SessionResponse;
  if (!response.ok || !data.authenticated) {
    throw new Error(data.message || "Email or password is incorrect.");
  }
  // Present in the native build only. Storing it is what keeps the player
  // signed in across launches; on the web this is a no-op.
  if (data.token) await setAuthToken(data.token);
  return toSession(data);
}

export async function signOut(): Promise<void> {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Best effort -- the caller drops local state regardless.
  }
  // Not best effort. A token left in native storage would sign the player
  // straight back in on the next launch.
  await clearAuthToken();
  // The guest token is deliberately NOT cleared here. It is not a session --
  // it is how someone with no account is known to the coach they already sent
  // a video to. Clearing it on sign-out would orphan their remaining allowance
  // and any send still in flight. The omission looks like a bug, so: it isn't.
}

export function sessionFromLoginResponse(data: SessionResponse): Session {
  return toSession(data);
}
