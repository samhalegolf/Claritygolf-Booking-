// The one place that knows who is signed in.
//
// The app used to decide this twice: the admin shell checked /api/auth/session
// for itself, and the player portal was chosen by hostname before React even
// mounted. Now the server answers once, with a role, and the entry point routes
// on it -- so the same login screen can lead to two different apps.

export type SessionRole = "guest" | "coach" | "player";

export type Session = {
  role: SessionRole;
  email: string;
  name: string;
};

export const guestSession: Session = { role: "guest", email: "", name: "" };

type SessionResponse = {
  authenticated?: boolean;
  role?: string;
  email?: string;
  name?: string;
};

function toSession(data: SessionResponse | null | undefined): Session {
  if (!data?.authenticated) return guestSession;
  const role: SessionRole =
    data.role === "coach" ? "coach" : data.role === "player" ? "player" : "guest";
  if (role === "guest") return guestSession;
  return { role, email: data.email || "", name: data.name || "" };
}

export async function fetchSession(): Promise<Session> {
  try {
    const response = await fetch("/api/auth/session", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return guestSession;
    return toSession((await response.json().catch(() => null)) as SessionResponse);
  } catch {
    // Offline or the function is down. Treat it as signed out: the login screen
    // says so plainly, which beats a workspace that silently has no data.
    return guestSession;
  }
}

export async function signOut(): Promise<void> {
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    // Best effort -- the caller drops local state regardless.
  }
}

export function sessionFromLoginResponse(data: SessionResponse): Session {
  return toSession(data);
}
