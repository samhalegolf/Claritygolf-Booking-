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
export type PlayerTerminalDestination = "lessons" | "book" | "notes" | "videos";

type NavLink = {
  id: PlayerTerminalDestination;
  label: string;
};

const NAV_LINKS: NavLink[] = [
  { id: "lessons", label: "Lessons" },
  { id: "book", label: "Book" },
  { id: "notes", label: "Notes" },
  { id: "videos", label: "Videos" },
];

export type PlayerTerminalNavProps = {
  /** Null while a child workspace owns the screen, so no link reads as current. */
  active: PlayerTerminalDestination | null;
  onNavigate: (destination: PlayerTerminalDestination) => void;
  /** Present only inside a child workspace, e.g. the video workspace. */
  back?: { label: string; onBack: () => void } | null;
  onSignOut: () => void;
  /** Tabs that need a real session. Still tappable -- onNavigate decides what
   *  happens -- this is just what tells the player a tab needs signing in for. */
  lockedDestinations?: ReadonlySet<PlayerTerminalDestination>;
  /** Browsing without a session: swaps the sign-out control for a sign-in one. */
  guest?: boolean;
  onSignIn?: () => void;
};

export function PlayerTerminalNav({
  active,
  onNavigate,
  back,
  onSignOut,
  lockedDestinations,
  guest,
  onSignIn,
}: PlayerTerminalNavProps) {
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
          {NAV_LINKS.map((link) => {
            const locked = lockedDestinations?.has(link.id) ?? false;
            return (
              <button
                key={link.id}
                type="button"
                className={[active === link.id ? "active" : "", locked ? "locked" : ""]
                  .filter(Boolean)
                  .join(" ")}
                aria-current={active === link.id ? "page" : undefined}
                title={locked ? "Sign in to use this" : undefined}
                onClick={() => onNavigate(link.id)}
              >
                {link.label}
              </button>
            );
          })}
        </nav>

        <div className="player-terminal-nav-menu">
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
