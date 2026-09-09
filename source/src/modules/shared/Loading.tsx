// One way of saying "not yet".
//
// Every screen used to wait in its own words: thirty phrasings, four kinds of
// container, two kinds of ellipsis, and a Suspense class nobody had styled.
// The waits are the same wait, so this is the one place they are written.
// Say what is coming in the reader's own words -- "clients", "your lessons" --
// and pick the size by where the wait sits, not by how long it is.

export function loadingLabel(what?: string) {
  return what ? `Loading ${what}…` : "Loading…";
}

export type LoadingSize =
  /** A few words where a value will be. */
  | "inline"
  /** A line where a list or a panel will be. The default, and what Suspense shows. */
  | "block"
  /** A centred card where a whole screen will be. */
  | "panel"
  /** The whole page, before any shell exists. */
  | "screen";

type LoadingProps = {
  /** What is on its way: "clients", "your lessons", "the till". */
  what?: string;
  /** Replaces the label outright, for the rare wait that is not a load ("Checking session…"). */
  label?: string;
  size?: LoadingSize;
  /** A second line under the label. Panel and screen only. */
  detail?: string;
  /** Layout classes the surrounding screen already relies on. */
  className?: string;
};

export function Loading({ what, label, size = "block", detail, className = "" }: LoadingProps) {
  const text = label ?? loadingLabel(what);
  const classes = (base: string) => ["loading", `loading-${size}`, base, className].filter(Boolean).join(" ");
  if (size === "screen") {
    return (
      <main className={classes("login-shell")}>
        <div className="login-card" role="status">
          <p>{text}</p>
          {detail ? <p>{detail}</p> : null}
        </div>
      </main>
    );
  }
  if (size === "panel") {
    return (
      <div className={classes("empty-panel compact")} role="status">
        <h2>{text}</h2>
        {detail ? <p>{detail}</p> : null}
      </div>
    );
  }
  if (size === "inline") {
    return (
      <span className={classes("")} role="status">
        {text}
      </span>
    );
  }
  return (
    <p className={classes("")} role="status">
      {text}
    </p>
  );
}
