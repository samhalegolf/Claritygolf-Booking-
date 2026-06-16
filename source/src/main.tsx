import { Component, StrictMode } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

type FatalErrorBoundaryState = {
  error: Error | null;
  errorInfo: ErrorInfo | null;
};

class FatalErrorBoundary extends Component<{ children: ReactNode }, FatalErrorBoundaryState> {
  state: FatalErrorBoundaryState = { error: null, errorInfo: null };

  static getDerivedStateFromError(error: Error): FatalErrorBoundaryState {
    return { error, errorInfo: null };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    console.error("Clarity Booking render crash", error, errorInfo);
  }

  render() {
    const { error, errorInfo } = this.state;
    if (!error) return this.props.children;

    const details = [error.name, error.message, errorInfo?.componentStack]
      .filter(Boolean)
      .join("\n\n");

    return (
      <main className="fatal-screen" role="alert">
        <section className="fatal-card">
          <p className="eyebrow">Clarity Booking</p>
          <h1>Something stopped the app loading.</h1>
          <p>
            The app has caught the crash instead of leaving you on a blank white screen. Copy the
            details below and send them to the developer.
          </p>
          <pre>{details || "Unknown render error"}</pre>
          <button type="button" onClick={() => window.location.reload()}>
            Reload app
          </button>
        </section>
      </main>
    );
  }
}

function installBootErrorScreen() {
  const showBootError = (error: unknown) => {
    const root = document.getElementById("root");
    if (!root || root.childElementCount > 0) return;
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    root.innerHTML = `
      <main class="fatal-screen" role="alert">
        <section class="fatal-card">
          <p class="eyebrow">Clarity Booking</p>
          <h1>The app could not start.</h1>
          <p>The startup error has been shown here instead of a blank white screen.</p>
          <pre></pre>
          <button type="button" onclick="window.location.reload()">Reload app</button>
        </section>
      </main>`;
    const pre = root.querySelector("pre");
    if (pre) pre.textContent = message;
  };

  window.addEventListener("error", (event) => showBootError(event.error || event.message));
  window.addEventListener("unhandledrejection", (event) => showBootError(event.reason));
}

installBootErrorScreen();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Clarity Booking root element was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    <FatalErrorBoundary>
      <App />
    </FatalErrorBoundary>
  </StrictMode>,
);
