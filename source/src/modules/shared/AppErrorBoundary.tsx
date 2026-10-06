import { Component, type ErrorInfo, type ReactNode } from "react";
import { isChunkLoadError, reloadForStaleDeploy } from "./staleDeploy";
import { t } from "../../lib/i18n";

// The last line of defence. Without it any error thrown while rendering, a
// failed lazy import included, unmounts the whole tree and leaves a white page
// with nothing to say why. This keeps the page saying something, and keeps the
// error in the console where it can be read.

type Props = { children: ReactNode };
type State = { error: Error | null };

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("app_render_failed", { error, componentStack: info.componentStack });
    // A chunk that slipped past the vite:preloadError listener is still a
    // stale tab; the same once-only reload applies.
    if (isChunkLoadError(error)) reloadForStaleDeploy();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const stale = isChunkLoadError(error);
    return (
      <main className="loading-screen">
        <div className="loading-screen-card" role="alert">
          <h1>{stale ? t("Clarity has been updated") : t("Something went wrong")}</h1>
          <p>
            {stale
              ? t("This tab is running an older version. Reload to pick up the new one.")
              : t("This screen hit an error. Reloading usually clears it; nothing you had saved is lost.")}
          </p>
          {stale ? null : <p className="muted">{error.message}</p>}
          <button className="primary-button" onClick={() => window.location.reload()} type="button">{t("Reload")}</button>
        </div>
      </main>
    );
  }
}
