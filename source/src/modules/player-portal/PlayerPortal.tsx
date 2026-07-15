import { useCallback, useEffect, useState, type FormEvent } from "react";

import "./playerPortal.css";

// The portal is its own app personality (like the public booking embed), served
// from players.claritygolf.app. The ?portal=player flag is a fallback so it is
// testable before that subdomain's DNS/Netlify config is in place.
const PLAYER_PORTAL_HOST = "players.claritygolf.app";

export function isPlayerPortalMode(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.location.hostname === PLAYER_PORTAL_HOST ||
    new URLSearchParams(window.location.search).get("portal") === "player"
  );
}

// True when the URL is asking for the booking embed. Used by the entry point so
// a signed-in player handing off to book escapes the portal even on the portal
// host. Kept in sync with isPublicBookingMode / BOOKING_EMBED_* in App.tsx.
export function isBookingHandoff(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("embed") === "booking";
}

// Must match BOOKING_LOGIN_STORAGE_KEY in src/App.tsx -- the booking embed reads
// this on mount (getInitialBookingLogin) to pre-fill the booking form. Writing
// it here, same-origin, is how the player's identity crosses into the booking
// flow without ever putting personal data in a URL.
const BOOKING_LOGIN_STORAGE_KEY = "clarity-booking-login";

// Must match baseWeekStart in src/App.tsx -- calendar_items store `week` as an
// absolute offset from this anchor Monday, so the same anchor is needed to turn
// a booking's (week, day, start) back into a real date.
const BASE_WEEK_START = new Date(2026, 5, 1);

function slotDate(week: number, day: number, start: number) {
  const date = new Date(BASE_WEEK_START);
  date.setDate(BASE_WEEK_START.getDate() + week * 7 + day);
  date.setHours(Math.floor(start / 60), start % 60, 0, 0);
  return date;
}

function formatMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const period = hours >= 12 ? "PM" : "AM";
  const hour12 = ((hours + 11) % 12) + 1;
  return mins === 0 ? `${hour12} ${period}` : `${hour12}:${String(mins).padStart(2, "0")} ${period}`;
}

function formatBookingWhen(booking: Booking) {
  const date = slotDate(booking.week, booking.day, booking.start);
  const dateLabel = date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  return `${dateLabel} · ${formatMinutes(booking.start)}–${formatMinutes(booking.start + booking.duration)}`;
}

function formatNoteDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

type Booking = {
  id: string;
  serviceName?: string;
  duration: number;
  week: number;
  day: number;
  start: number;
  client?: string;
  location?: { name?: string } | null;
};

type Note = {
  id: string;
  title?: string;
  body?: string;
  playerName?: string;
  createdAt?: string;
  updatedAt?: string;
};

type PortalStatus = "checking" | "guest" | "authenticated";

export default function PlayerPortal() {
  const [status, setStatus] = useState<PortalStatus>("checking");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [playerEmail, setPlayerEmail] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [playerPhone, setPlayerPhone] = useState("");
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState("");

  const loadProfile = useCallback(async () => {
    setProfileLoading(true);
    setProfileError("");
    try {
      const res = await fetch("/api/player/profile", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (res.status === 401) {
        setStatus("guest");
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        player?: { email?: string; name?: string; phone?: string };
        bookings?: Booking[];
        notes?: Note[];
      };
      if (!res.ok) throw new Error(data?.message || "We couldn't load your profile.");
      setBookings(Array.isArray(data.bookings) ? data.bookings : []);
      setNotes(Array.isArray(data.notes) ? data.notes : []);
      if (data.player?.email) setPlayerEmail(data.player.email);
      if (data.player?.name) setPlayerName(data.player.name);
      if (data.player?.phone) setPlayerPhone(data.player.phone);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "We couldn't load your profile.");
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "authenticated") void loadProfile();
  }, [status, loadProfile]);

  const checkSession = useCallback(async () => {
    try {
      const res = await fetch("/api/player/session", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as {
        authenticated?: boolean;
        player?: { email?: string };
      };
      if (data?.authenticated) {
        setPlayerEmail(data.player?.email || "");
        setStatus("authenticated");
      } else {
        setStatus("guest");
      }
    } catch {
      setStatus("guest");
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    if (loginBusy) return;
    setLoginBusy(true);
    setLoginError("");
    try {
      const res = await fetch("/api/player/login", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: email.trim(), phone: phone.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        authenticated?: boolean;
        message?: string;
        player?: { email?: string; name?: string };
      };
      if (!res.ok || data?.authenticated !== true) {
        throw new Error(data?.message || "We couldn't log you in. Check your details and try again.");
      }
      setPlayerEmail(data.player?.email || email.trim());
      if (data.player?.name) setPlayerName(data.player.name);
      setPlayerPhone(phone.trim());
      setStatus("authenticated");
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Login failed. Please try again.");
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleLogout() {
    try {
      await fetch("/api/player/logout", { method: "POST", credentials: "same-origin", cache: "no-store" });
    } catch {
      // Best-effort; clear local state regardless so the UI returns to login.
    }
    setStatus("guest");
    setEmail("");
    setPhone("");
    setPlayerEmail("");
    setBookings([]);
    setNotes([]);
    setPlayerName("");
    setPlayerPhone("");
    setProfileError("");
  }

  // Hand off to the booking embed pre-filled, without ever putting personal data
  // in a URL: write the same localStorage key the embed reads on mount, then
  // navigate to ?embed=booking on this same origin.
  function startBooking() {
    try {
      const parts = (playerName || "").trim().split(/\s+/).filter(Boolean);
      const firstName = parts[0] || "";
      const lastName = parts.slice(1).join(" ");
      window.localStorage.setItem(
        BOOKING_LOGIN_STORAGE_KEY,
        JSON.stringify({ firstName, lastName, phone: playerPhone.trim(), email: playerEmail.trim() }),
      );
    } catch {
      // If storage is unavailable the player can still fill the form manually.
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("portal");
    url.searchParams.set("embed", "booking");
    window.location.href = url.toString();
  }

  if (status === "checking") {
    return (
      <div className="player-portal">
        <div className="player-portal-card player-portal-loading">
          <span className="player-portal-spinner" aria-hidden="true" />
          <p>Loading your profile…</p>
        </div>
      </div>
    );
  }

  if (status === "guest") {
    return (
      <div className="player-portal">
        <form className="player-portal-card" onSubmit={handleLogin}>
          <div className="player-portal-brand">
            <strong>Clarity Golf</strong>
            <span>Player Portal</span>
          </div>
          <h1>Sign in</h1>
          <p className="player-portal-lead">
            Enter the email and phone number you used to book your lessons.
          </p>
          <label className="player-portal-field">
            <span>Email</span>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </label>
          <label className="player-portal-field">
            <span>Phone</span>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="021 123 4567"
              required
            />
          </label>
          {loginError && (
            <p className="player-portal-error" role="alert">
              {loginError}
            </p>
          )}
          <button className="player-portal-primary" type="submit" disabled={loginBusy}>
            {loginBusy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    );
  }

  const now = Date.now();
  const upcomingBookings = bookings
    .filter((b) => slotDate(b.week, b.day, b.start).getTime() + b.duration * 60 * 1000 >= now)
    .sort((a, b) => slotDate(a.week, a.day, a.start).getTime() - slotDate(b.week, b.day, b.start).getTime());
  const pastBookings = bookings
    .filter((b) => slotDate(b.week, b.day, b.start).getTime() + b.duration * 60 * 1000 < now)
    .sort((a, b) => slotDate(b.week, b.day, b.start).getTime() - slotDate(a.week, a.day, a.start).getTime());
  const sortedNotes = [...notes].sort((a, b) =>
    String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")),
  );

  const renderBooking = (booking: Booking) => (
    <li className="player-portal-booking" key={booking.id}>
      <div className="player-portal-booking-main">
        <strong>{booking.serviceName || "Lesson"}</strong>
        <span>{formatBookingWhen(booking)}</span>
      </div>
      {booking.location?.name && <span className="player-portal-booking-loc">{booking.location.name}</span>}
    </li>
  );

  return (
    <div className="player-portal">
      <div className="player-portal-card">
        <div className="player-portal-header">
          <div className="player-portal-brand">
            <strong>Clarity Golf</strong>
            <span>Player Portal</span>
          </div>
          <button className="player-portal-ghost" type="button" onClick={() => void handleLogout()}>
            Sign out
          </button>
        </div>
        <h1>{playerName ? `Hi, ${playerName.split(/\s+/)[0]}` : "Your profile"}</h1>
        {playerEmail && <p className="player-portal-lead">{playerEmail}</p>}

        <button className="player-portal-primary" type="button" onClick={startBooking}>
          Book a lesson
        </button>


        {profileLoading && bookings.length === 0 && notes.length === 0 ? (
          <p className="player-portal-lead">Loading your bookings and lesson notes…</p>
        ) : profileError ? (
          <div className="player-portal-error" role="alert">
            <p style={{ margin: 0 }}>{profileError}</p>
            <button className="player-portal-ghost" type="button" onClick={() => void loadProfile()} style={{ marginTop: 10 }}>
              Try again
            </button>
          </div>
        ) : (
          <>
            <section className="player-portal-section">
              <h2>Upcoming lessons</h2>
              {upcomingBookings.length ? (
                <ul className="player-portal-list">{upcomingBookings.map(renderBooking)}</ul>
              ) : (
                <p className="player-portal-empty">No upcoming lessons booked.</p>
              )}
            </section>

            <section className="player-portal-section">
              <h2>Lesson notes</h2>
              {sortedNotes.length ? (
                <ul className="player-portal-list">
                  {sortedNotes.map((note) => (
                    <li className="player-portal-note" key={note.id}>
                      <div className="player-portal-note-head">
                        <strong>{note.title || "Lesson note"}</strong>
                        {formatNoteDate(note.updatedAt || note.createdAt) && (
                          <span>{formatNoteDate(note.updatedAt || note.createdAt)}</span>
                        )}
                      </div>
                      {note.body && <p>{note.body}</p>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="player-portal-empty">No lesson notes yet.</p>
              )}
            </section>

            {pastBookings.length > 0 && (
              <section className="player-portal-section">
                <h2>Past lessons</h2>
                <ul className="player-portal-list">{pastBookings.slice(0, 20).map(renderBooking)}</ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
