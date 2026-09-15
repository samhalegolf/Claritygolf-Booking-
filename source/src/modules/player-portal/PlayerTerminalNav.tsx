// The one navigation bar for the whole Player Terminal.
//
// It lives outside the portal card and outside the video engine, which is the
// point: before this, opening a video replaced the entire portal UI and the
// only way back was a control inside the video toolbar. The workspace keeps
// owning its own back behaviour -- the bar just calls the callback the portal
// already had.

// Clarity Caddy is deliberately absent. It is a different product, and its one
// way in is the card on the home route -- a permanent link in the bar would put
// "leave here" next to every screen in the terminal.
export type PlayerTerminalDestination =
  | "home"
  | "lessons"
  | "reviews"
  | "passes"
  | "practice"
  | "notes"
  | "videos"
  | "book";

type NavLink = {
  id: PlayerTerminalDestination;
  label: string;
};

// The order of the thing: a lesson happens, the coach reviews it, practice
// comes out of that, and notes and videos are the record. Reviews sits where
// it does for that reason -- it is the sitting itself, and the three after it
// are the pieces that sitting produced, each also reachable on its own.
//
// Passes follows Reviews rather than sitting near the end, because what a
// player holds is the answer to "can I book another one" -- a question asked
// while looking at the first two, not while reading old notes.
//
// "book" is not in this list: it only exists for a business that has
// configured an outside booking widget, and it is named by that business
// rather than by us, so it is appended from `externalBooking` below.
const NAV_LINKS: NavLink[] = [
  { id: "home", label: "Home" },
  { id: "lessons", label: "Lessons" },
  { id: "reviews", label: "Reviews" },
  { id: "passes", label: "Passes" },
  { id: "practice", label: "Practice" },
  { id: "notes", label: "Notes" },
  { id: "videos", label: "Videos" },
];

// Lessons -- and booking with it -- doesn't exist for a guest at all, and
// neither does practice or reviews: prescribed practice and swing reviews both
// come from a coach, and a guest has not got one yet. Not shown-but-locked,
// just not here: there is nothing behind any of them to show.
const GUEST_HIDDEN: ReadonlySet<PlayerTerminalDestination> = new Set([
  "lessons",
  "reviews",
  "passes",
  "practice",
]);

export type PlayerTerminalNavProps = {
  /** Null while a child workspace owns the screen, so no link reads as current. */
  active: PlayerTerminalDestination | null;
  onNavigate: (destination: PlayerTerminalDestination) => void;
  /** Present only inside a child workspace, e.g. the video workspace. */
  back?: { label: string; onBack: () => void } | null;
  onSignOut: () => void;
  /** Jumps straight into recording. Hidden while a back-mode workspace owns
   *  the screen -- that workspace already has its own record controls. */
  onRecord: () => void;
  /** Browsing without a session: swaps the sign-out control for a sign-in one. */
  guest?: boolean;
  onSignIn?: () => void;
  /** The business's outside booking widget, when it has configured one. Null
   *  means the link is not in the bar at all -- there is nothing behind it. */
  externalBooking?: { label: string } | null;
  /** What the screen is showing, and how to flip it. Present for everyone --
   *  a guest reads the same screens and gets the same choice. */
  theme: "light" | "dark";
  onToggleTheme: () => void;
  /** Credits on hand, shown beside the record button so the answer to "can I
   *  book another one" is on every screen rather than one tab away. Null for a
   *  guest, who holds none and has no coach to hold them with. */
  balance?: { credits: number } | null;
  onOpenBalance?: () => void;
};

export function PlayerTerminalNav({
  active,
  onNavigate,
  back,
  onSignOut,
  onRecord,
  guest,
  onSignIn,
  externalBooking,
  theme,
  onToggleTheme,
  balance,
  onOpenBalance,
}: PlayerTerminalNavProps) {
  const baseLinks = guest ? NAV_LINKS.filter((link) => !GUEST_HIDDEN.has(link.id)) : NAV_LINKS;

  // Last in the bar, and only when there is one. A guest never gets it either:
  // the config arrives with the player profile, and a guest has no account to
  // read one from.
  const visibleLinks =
    !guest && externalBooking
      ? [...baseLinks, { id: "book" as const, label: externalBooking.label }]
      : baseLinks;

  return (
    <header className="player-terminal-nav">
      <div className="player-terminal-nav-inner">
        <div className="player-terminal-nav-lead">
          {back ? (
            <button
              className="player-terminal-nav-back"
              type="button"
              onClick={back.onBack}
            >
              <span aria-hidden="true">←</span>
              {back.label}
            </button>
          ) : (
            <div className="player-portal-brand">
              <strong>Clarity Golf</strong>
              <span>Player Portal</span>
            </div>
          )}
        </div>

        <nav className="player-terminal-nav-links" aria-label="Player Terminal">
          {visibleLinks.map((link) => (
            <button
              key={link.id}
              type="button"
              className={active === link.id ? "active" : ""}
              aria-current={active === link.id ? "page" : undefined}
              onClick={() => onNavigate(link.id)}
            >
              {link.label}
            </button>
          ))}
        </nav>

        <div className="player-terminal-nav-menu">
          {!back && balance && (
            <button
              type="button"
              className="player-terminal-nav-balance"
              title="Your passes"
              onClick={onOpenBalance}
            >
              <span>Balance</span>
              <strong>
                {balance.credits} credit{balance.credits === 1 ? "" : "s"}
              </strong>
            </button>
          )}
          {/* Stays visible inside the video workspace too: a player who opens a
              video at night is exactly the person who wants to dim the screen,
              and that is the one place the rest of this bar goes away. */}
          <button
            type="button"
            className="player-terminal-nav-theme"
            aria-label={theme === "dark" ? "Switch to light" : "Switch to dark"}
            title={theme === "dark" ? "Switch to light" : "Switch to dark"}
            onClick={onToggleTheme}
          >
            <span aria-hidden="true">{theme === "dark" ? "\u2600" : "\u263D"}</span>
          </button>
          {!back && (
            <button
              type="button"
              className="player-terminal-nav-record"
              aria-label="Record a video"
              title="Record a video"
              onClick={onRecord}
            >
              <span className="player-terminal-nav-record-dot" aria-hidden="true" />
            </button>
          )}
          {guest ? (
            <button className="player-portal-ghost" type="button" onClick={onSignIn}>
              Sign in
            </button>
          ) : (
            <button className="player-portal-ghost" type="button" onClick={onSignOut}>
              Sign out
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

export default PlayerTerminalNav;
