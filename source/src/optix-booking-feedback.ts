type OptixStatusRecord = {
  calendarItemId: string;
  client: string;
  title: string;
  serviceId: string;
  week: number;
  day: number;
  start: number;
  duration: number;
  bayName: string;
  syncStatus: string;
  errorCode: string;
  errorMessage: string;
  optixBookingId: string;
  optixBookingSessionId: string;
  lastAttemptedAt: string | null;
  lastSyncedAt: string | null;
  updatedAt: string | null;
};

/**
 * Fired on `window` the moment Optix confirms a bay for a lesson, with
 * `detail: { calendarItemId, bayResourceId }`. This panel is injected into the
 * DOM outside React, so it is the only thing that knows a booking just
 * succeeded — the React calendar listens for this and paints the orange
 * "bay held" outline straight away instead of waiting for the next hydration.
 */
export const OPTIX_RECONCILE_EVENT = "clarity:optix-reconcile-complete";

export type OptixReconcileCompleteDetail = {
  calendarItemId: string;
  bayResourceId: string;
};

const ERROR_LABELS: Record<string, string> = {
  timeout: "Optix did not respond",
  resource_conflict: "No configured bay is available",
  validation_failed: "Optix rejected the booking details",
  unauthorized: "Optix access was rejected",
  remote_error: "Optix returned an error",
  not_configured: "Optix setup is incomplete",
};

function esc(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(value: string | null) {
  if (!value) return "Not attempted yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not attempted yet";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    day: "numeric",
    month: "short",
  }).format(date);
}

function installStyles() {
  if (document.getElementById("optix-booking-feedback-styles")) return;
  const style = document.createElement("style");
  style.id = "optix-booking-feedback-styles";
  style.textContent = `
    .optix-booking-feedback{margin-top:12px;padding:12px 14px;border:1px solid rgba(0,0,0,.12);border-radius:12px;background:rgba(0,0,0,.025);font-family:inherit}
    .optix-booking-feedback--synced{background:rgba(31,211,109,.055)}
    .optix-booking-feedback--failed{background:rgba(196,132,20,.06)}
    .optix-booking-feedback__head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
    .optix-booking-feedback__eyebrow{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;opacity:.62}
    .optix-booking-feedback__bay{font-size:17px;font-weight:800;margin-top:3px}
    .optix-booking-feedback__status{font-size:13px;margin-top:3px}
    .optix-booking-feedback__message{font-size:12px;line-height:1.4;margin-top:7px;padding:8px 9px;border-radius:8px;background:rgba(180,45,45,.08)}
    .optix-booking-feedback__meta{font-size:11px;opacity:.65;margin-top:7px}
    .optix-booking-feedback__actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}
    .optix-booking-feedback button{border:1px solid rgba(0,0,0,.12);border-radius:8px;padding:7px 9px;background:transparent;font:700 12px/1 inherit;cursor:pointer}
    .optix-booking-feedback button[data-optix-book]{background:#102d20;color:#fff;border-color:#102d20}
    .optix-booking-feedback button:disabled{opacity:.55;cursor:wait}
    .optix-booking-feedback details{margin-top:9px;font-size:11px;opacity:.8}
    .optix-booking-feedback pre{white-space:pre-wrap;word-break:break-word;font:inherit}
  `;
  document.head.appendChild(style);
}

async function loadRecords(): Promise<OptixStatusRecord[]> {
  const response = await fetch("/api/optix-booking-status", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) return [];
  const payload = await response.json();
  return Array.isArray(payload?.records) ? payload.records : [];
}

function findBookingRecordsAnchor(card: HTMLElement) {
  const candidates = Array.from(card.querySelectorAll<HTMLElement>("button,[role='tab'],a,h1,h2,h3,h4,h5,h6,div,span,p"));
  const exact = candidates.find((node) => /^booking records$/i.test((node.textContent || "").trim()));
  if (exact) return exact.parentElement || exact;
  const resend = candidates.find((node) => /^resend confirmation$/i.test((node.textContent || "").trim()));
  if (resend) return resend.parentElement || resend;
  const empty = candidates.find((node) => /^no email records$/i.test((node.textContent || "").trim()));
  if (empty) return empty.parentElement || empty;
  return null;
}

/**
 * Every open booking modal, paired with the booking it is showing.
 *
 * The modal carries its own booking id (App.tsx), which removes the guesswork
 * this file used to depend on — see selectUnambiguousRecord below for what
 * that guesswork cost. A modal with a Booking records section but no id is
 * skipped: showing no bay panel is safe, showing another lesson's bay is not.
 */
function findOpenBookingCards() {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-calendar-item-id]")).flatMap((card) => {
    const id = String(card.dataset.calendarItemId || "").trim();
    return id && findBookingRecordsAnchor(card) ? [{ card, id }] : [];
  });
}

function renderPanel(card: HTMLElement, record: OptixStatusRecord) {
  const existing = card.querySelector<HTMLElement>(".optix-booking-feedback");
  const anchor = findBookingRecordsAnchor(card);
  if (!anchor) return;

  const panel = existing || document.createElement("section");
  const status = record.syncStatus || "pending";
  const isSynced = status === "synced";
  const isCancelled = status === "cancelled";
  const hasFailed = status === "failed" || status === "token_expired";
  // A failure from days ago is history, not the current state. Opening a lesson
  // whose last attempt was the 429 storm on 2 Aug led with a red box about
  // something that had not just happened, and buried the fact that the actual
  // state is simply "no bay yet, press the button".
  const attemptAge = record.lastAttemptedAt ? Date.now() - Date.parse(record.lastAttemptedAt) : Number.NaN;
  const staleFailure = hasFailed && Number.isFinite(attemptAge) && attemptAge > 60 * 60 * 1000;
  panel.className = `optix-booking-feedback${
    isSynced ? " optix-booking-feedback--synced" : hasFailed && !staleFailure ? " optix-booking-feedback--failed" : ""
  }`;

  const heading = isSynced ? record.bayName || "Resource booked" : "Resource not booked";
  const statusLabel = isSynced
    ? "Booked in Optix"
    : isCancelled
      ? "Cancelled in Optix"
      : "No active Optix booking";
  // Name the reason, or failing that the raw code. "Previous booking attempt
  // failed" told the coach only that something had already been tried, which is
  // the least useful thing on the card.
  const failureSummary = record.errorCode
    ? ERROR_LABELS[record.errorCode] || `Optix error: ${record.errorCode}`
    : "Booking failed";
  const failureDetail = `${failureSummary}${record.errorMessage ? `: ${record.errorMessage}` : ""}`;
  const visibleMessage = !hasFailed
    ? ""
    : staleFailure
      ? `Earlier attempt on ${formatTime(record.lastAttemptedAt)} — ${failureDetail}`
      : failureDetail;
  const lastChecked = isSynced
    ? record.lastSyncedAt || record.updatedAt || null
    : record.lastAttemptedAt || record.updatedAt || null;
  const metaLabel = isSynced ? "Last confirmed" : hasFailed ? "Last attempt" : "Last checked";
  const canBook = Boolean(record.calendarItemId) && !isSynced && !isCancelled;
  // One action, worded the same whatever came before it. Every press is a real
  // attempt (the card sends forceRetry), so "Retry" only made a fresh booking
  // look like it was repeating itself.
  const bookLabel = "Book bay";

  panel.innerHTML = `
    <div class="optix-booking-feedback__head">
      <div>
        <div class="optix-booking-feedback__eyebrow">Resource booking</div>
        <div class="optix-booking-feedback__bay">${esc(heading)}</div>
        <div class="optix-booking-feedback__status">${esc(statusLabel)}</div>
      </div>
    </div>
    ${visibleMessage ? `<div class="optix-booking-feedback__message">${esc(visibleMessage)}</div>` : ""}
    <div class="optix-booking-feedback__meta">${esc(metaLabel)}: ${esc(formatTime(lastChecked))}</div>
    <div class="optix-booking-feedback__actions">
      ${canBook ? `<button type="button" data-optix-book data-calendar-item-id="${esc(record.calendarItemId)}">${esc(bookLabel)}</button>` : ""}
      <button type="button" data-optix-refresh>Reload status</button>
    </div>
    <details>
      <summary>Technical details</summary>
      <pre>Booking ID: ${esc(record.optixBookingId || "Not assigned")}
Session ID: ${esc(record.optixBookingSessionId || "Not assigned")}
Previous resource candidate: ${esc(record.bayName || "None")}
Error code: ${esc(record.errorCode || "None")}
${esc(record.errorMessage || "")}</pre>
    </details>
  `;

  if (!existing) anchor.insertAdjacentElement("afterend", panel);
}

function clearPanel(card: HTMLElement) {
  card.querySelector<HTMLElement>(".optix-booking-feedback")?.remove();
}

// Removed: selectUnambiguousRecord(), which picked this card's bay by scoring
// every Optix record against the modal's rendered text — +20 for the client
// name alone, and it only refused to choose on an exact tie. A client with
// three bookings therefore had all three score above the threshold on any one
// of their cards, and the highest scorer won: a lesson with no bay at all
// showed the bay belonging to a different lesson. scoreRecord/slotDate/
// minuteLabel existed only to feed it and went with it. The modal now says
// which booking it is showing.

async function bookResource(button: HTMLButtonElement) {
  const calendarItemId = String(button.dataset.calendarItemId || "").trim();
  if (!calendarItemId || button.disabled) return;
  button.disabled = true;
  button.textContent = "Booking…";
  try {
    const response = await fetch("/api/optix-booking-reconcile", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ forceRetry: true, calendarItemId, source: "manual-book-resource" }),
    });
    const payload = await response.json().catch(() => ({}) as any);
    if (!response.ok && response.status !== 207) {
      throw new Error(payload?.message || "Optix resource booking failed.");
    }
    // 207 means the attempt ran but Optix said no, so only a true `ok` means a
    // bay is actually held. The reconcile call is synchronous — by the time it
    // returns, optix_booking_sync is already 'synced', which is exactly what
    // the calendar's bay_booked column reads. So the outline can be painted now
    // without a refetch.
    if (payload?.ok === true) {
      const detail: OptixReconcileCompleteDetail = {
        calendarItemId,
        bayResourceId: String(payload?.result?.resourceId || ""),
      };
      window.dispatchEvent(new CustomEvent(OPTIX_RECONCILE_EVENT, { detail }));
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = error instanceof Error ? error.message : "Booking failed";
  } finally {
    await refreshPanels();
  }
}

async function refreshPanels() {
  const cards = findOpenBookingCards();
  if (!cards.length) return;
  const records = await loadRecords();
  const byId = new Map(records.map((record) => [record.calendarItemId, record]));
  for (const { card, id } of cards) {
    const record = byId.get(id);
    // No sync row means this lesson has never had a bay attempted. Clear any
    // panel left behind by the booking previously open in this modal.
    if (!record) {
      clearPanel(card);
      continue;
    }
    renderPanel(card, record);
  }
}

export function installOptixBookingFeedback() {
  if (typeof window === "undefined") return;
  installStyles();
  const observer = new MutationObserver(() => void refreshPanels());
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-optix-refresh]")) void refreshPanels();
    const book = target.closest<HTMLButtonElement>("[data-optix-book]");
    if (book) void bookResource(book);
  });
  void refreshPanels();
}
