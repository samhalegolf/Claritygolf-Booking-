import { Building2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  bayLabel,
  describeBookAttempt,
  describeStatusRecord,
  type ResourceOutcome,
  type ResourceStatusRecord,
} from "./bookingResourceOutcome";

/**
 * Resources — the bay this lesson holds in Optix, and the button that books it.
 *
 * Replaces the panel that optix-booking-feedback.ts injected into this modal
 * from outside React. That one drove itself from a MutationObserver on the
 * whole document and re-rendered by writing innerHTML — which was itself a
 * mutation, so it re-fetched in a loop while a card was open, and every
 * re-render wiped the button's in-flight state and whatever error had just been
 * written into it. Nothing here re-renders on its own: the spinner runs for
 * exactly as long as the request, and an error stays up until the coach acts.
 */

const SLOW_AFTER_MS = 8000;

type Props = {
  calendarItemId: string;
  /** Paints the calendar's orange outline without waiting for a hydration. */
  onBooked: (resourceId: string) => void;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; record: ResourceStatusRecord | null }
  | { kind: "signedOut" }
  | { kind: "unreadable"; detail: string };

function formatTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    day: "numeric",
    month: "short",
  }).format(date);
}

/** The one-line state on the summary row, readable without opening the section. */
function summaryLabel(outcome: ResourceOutcome, busy: boolean) {
  if (busy) return "Booking…";
  return outcome.title;
}

function loadOutcome(load: LoadState): ResourceOutcome {
  if (load.kind === "loading") {
    return {
      tone: "idle",
      title: "Checking…",
      line: "Reading this lesson's bay booking.",
      details: "",
      canRetry: false,
      needsOptixCheckFirst: false,
      staleAttemptAt: null,
    };
  }
  if (load.kind === "signedOut") {
    return {
      tone: "error",
      title: "Signed out",
      line: "Your admin session expired. Sign in again to see this lesson's bay.",
      details: "",
      canRetry: false,
      needsOptixCheckFirst: false,
      staleAttemptAt: null,
    };
  }
  if (load.kind === "unreadable") {
    // The old panel turned every failed read into an empty record list, which
    // it then rendered as "no bay attempted". A read that did not happen is
    // not a bay that does not exist.
    return {
      tone: "error",
      title: "Could not read bay status",
      line: "Clarity could not load this lesson's bay booking. Reload status to try again.",
      details: load.detail,
      canRetry: false,
      needsOptixCheckFirst: false,
      staleAttemptAt: null,
    };
  }
  return describeStatusRecord(load.record);
}

export default function BookingResourcesPanel({ calendarItemId, onBooked }: Props) {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [attempt, setAttempt] = useState<ResourceOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  // The modal is reused for whichever lesson is selected, so a reply that
  // arrives after the coach has moved on must not be shown against the new
  // one. Every state write below is gated on this still being the same lesson.
  const shownId = useRef(calendarItemId);

  const readStatus = useCallback(async (id: string) => {
    try {
      const response = await fetch(
        `/api/optix-booking-status?calendarItemId=${encodeURIComponent(id)}`,
        { credentials: "same-origin", cache: "no-store" },
      );
      if (shownId.current !== id) return;
      if (response.status === 401 || response.status === 403) return setLoad({ kind: "signedOut" });
      if (!response.ok) return setLoad({ kind: "unreadable", detail: `Status request failed (HTTP ${response.status}).` });
      const payload = await response.json().catch(() => null);
      if (shownId.current !== id) return;
      if (!payload) return setLoad({ kind: "unreadable", detail: "The status response could not be read." });
      // found:false is a real answer — this is not an appointment on this
      // account — and is shown as such rather than as "no bay yet".
      if (payload.found === false) {
        return setLoad({ kind: "unreadable", detail: "Clarity has no appointment with this id on your account." });
      }
      setLoad({ kind: "ready", record: (payload.record || null) as ResourceStatusRecord | null });
    } catch (error) {
      if (shownId.current !== id) return;
      setLoad({
        kind: "unreadable",
        detail: error instanceof Error ? error.message : "The status request never got an answer.",
      });
    }
  }, []);

  useEffect(() => {
    shownId.current = calendarItemId;
    setAttempt(null);
    setBusy(false);
    setSlow(false);
    setLoad({ kind: "loading" });
    if (!calendarItemId) return;
    void readStatus(calendarItemId);
  }, [calendarItemId, readStatus]);

  const outcome = attempt || loadOutcome(load);

  // The 25 second ceiling is real (OVERALL_TIMEOUT_MS in optix-book-resource),
  // so a long wait is not a hung request. Say that rather than inventing
  // progress the client cannot know about.
  useEffect(() => {
    if (!busy) return setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [busy]);

  async function bookBay() {
    if (busy || !calendarItemId) return;
    const id = calendarItemId;
    setBusy(true);
    setSlow(false);
    setAttempt(null);
    let result: ResourceOutcome;
    try {
      const response = await fetch("/api/optix-booking-reconcile", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ forceRetry: true, calendarItemId: id, source: "manual-book-resource" }),
      });
      const payload = await response.json().catch(() => ({}));
      result = describeBookAttempt({ kind: "response", status: response.status, payload });
      if (payload?.ok === true && shownId.current === id) {
        onBooked(String(payload?.result?.resourceId || ""));
      }
    } catch (error) {
      result = describeBookAttempt({ kind: "unreachable", error });
    }
    if (shownId.current !== id) return;
    setBusy(false);
    setSlow(false);
    // The attempt's own answer is what stays on screen. Re-reading the row
    // afterwards keeps the times and ids below it current, but it does not get
    // to overwrite what just happened.
    setAttempt(result);
    void readStatus(id);
  }

  const record = load.kind === "ready" ? load.record : null;
  const metaLabel = record?.syncStatus === "synced" ? "Last confirmed" : record?.hasSyncRow ? "Last attempt" : "";
  const metaTime = formatTime(
    record?.syncStatus === "synced" ? record?.lastSyncedAt || record?.updatedAt : record?.lastAttemptedAt || record?.updatedAt,
  );
  const bookLabel = outcome.needsOptixCheckFirst ? "I've checked Optix — book anyway" : "Book bay";

  return (
    /* Arrives closed, like every other section. The state that would justify
       opening it — held, failed, booking — is on the summary line instead, so
       the coach reads it without opening anything. */
    <details className="booking-records-tab">
      <summary className="booking-records-summary">
        <Building2 size={16} />
        <span>Resources</span>
        <em>{summaryLabel(outcome, busy)}</em>
      </summary>
      <div className="booking-records-body">
        <div className={`resource-state resource-state--${busy ? "busy" : outcome.tone}`}>
          <strong>{busy ? "Booking bay…" : outcome.title}</strong>
          {busy ? (
            <p className="resource-state-line">
              <span className="resource-spinner" aria-hidden="true" />
              {slow
                ? "Still waiting on Optix. Clarity gives it 25 seconds before it gives up."
                : "Asking Optix to hold a bay for this lesson."}
            </p>
          ) : (
            <p className="resource-state-line">
              {outcome.staleAttemptAt ? `Earlier attempt on ${formatTime(outcome.staleAttemptAt)} — ` : ""}
              {outcome.line}
            </p>
          )}
        </div>

        {!busy && outcome.details ? (
          <details className="resource-details">
            <summary>Details</summary>
            <pre>{outcome.details}</pre>
          </details>
        ) : null}

        {metaLabel && metaTime ? (
          <p className="resource-meta">
            {metaLabel}: {metaTime}
            {record?.resourceId && record?.syncStatus !== "synced" ? ` · last bay tried ${bayLabel(record)}` : ""}
          </p>
        ) : null}

        <div className="resource-actions">
          {outcome.canRetry ? (
            <button
              className="primary-button"
              type="button"
              onClick={() => void bookBay()}
              disabled={busy}
              aria-busy={busy}
            >
              {busy ? "Booking bay…" : bookLabel}
            </button>
          ) : null}
          <button className="outline-button" type="button" onClick={() => void readStatus(calendarItemId)} disabled={busy}>
            <RefreshCw size={16} />
            Reload status
          </button>
        </div>
      </div>
    </details>
  );
}
