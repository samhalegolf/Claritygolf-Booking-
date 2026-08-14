// The one navigation bar for the whole Player Terminal.
//
// It lives outside the portal card and outside the video engine, which is the
// point: before this, opening a video replaced the entire portal UI and the
// only way back was a control inside the video toolbar. The workspace keeps
// owning its own back behaviour -- the bar just calls the callback the portal
// already had.

export type PlayerTerminalDestination = "lessons" | "book" | "notes" | "videos" | "caddy";

type NavLink = {
  id: PlayerTerminalDestination;
  label: string;
  /** True for the destinations that leave the terminal shell. */
  external?: boolean;
};

const NAV_LINKS: NavLink[] = [
  { id: "lessons", label: "Lessons" },
  { id: "book", label: "Book" },
  { id: "notes", label: "Notes" },
  { id: "videos", label: "Videos" },
  { id: "caddy", label: "Clarity Caddy", external: true },
];

export type PlayerTerminalNavProps = {
  /** Null while a child workspace owns the screen, so no link reads as current. */
  active: PlayerTerminalDestination | null;
  onNavigate: (destination: PlayerTerminalDestination) => void;
  /** Present only inside a child workspace, e.g. the video workspace. */
  back?: { label: string; onBack: () => void } | null;
  onSignOut: () => void;
  /** Hidden until the destination is known to exist. */
  caddyAvailable?: boolean;
};

export function PlayerTerminalNav({
  active,
  onNavigate,
  back,
  onSignOut,
  caddyAvailable = true,
}: PlayerTerminalNavProps) {
  const links = NAV_LINKS.filter((link) => link.id !== "caddy" || caddyAvailable);

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
          {links.map((link) => (
            <button
              key={link.id}
              type="button"
              className={active === link.id ? "active" : ""}
              aria-current={active === link.id ? "page" : undefined}
              onClick={() => onNavigate(link.id)}
            >
              {link.label}
              {link.external ? (
                <span className="player-terminal-nav-external" aria-hidden="true">
                  ↗
                </span>
              ) : null}
            </button>
          ))}
        </nav>

        <div className="player-terminal-nav-menu">
          <button className="player-portal-ghost" type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

export default PlayerTerminalNav;
