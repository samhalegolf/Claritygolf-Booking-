type OptixStatusRecord = {
  calendarItemId: string;
  client: string;
  title: string;
  serviceId: string;
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

const STATUS_LABELS: Record<string, string> = {
  pending: "Waiting to sync",
  synced: "Booked in Optix",
  failed: "Optix booking failed",
  token_expired: "Optix token expired",
  cancelled: "Cancelled in Optix",
};

function esc(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(value: string | null) {
  if (!value) return "Not checked yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not checked yet";
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
    .optix-booking-feedback{margin-top:12px;padding:12px 14px;border:1px solid rgba(0,0,0,.12);border-radius:12px;background:rgba(31,211,109,.055);font-family:inherit}
    .optix-booking-feedback__head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
    .optix-booking-feedback__eyebrow{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;opacity:.62}
    .optix-booking-feedback__bay{font-size:17px;font-weight:800;margin-top:3px}
    .optix-booking-feedback__status{font-size:13px;margin-top:3px}
    .optix-booking-feedback__meta{font-size:11px;opacity:.65;margin-top:7px}
    .optix-booking-feedback__actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}
    .optix-booking-feedback button{border:1px solid rgba(0,0,0,.12);border-radius:8px;padding:7px 9px;background:transparent;font:700 12px/1 inherit;cursor:pointer}
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

function scoreRecord(record: OptixStatusRecord, cardText: string) {
  const text = cardText.toLowerCase();
  let score = 0;
  if (record.client && text.includes(record.client.toLowerCase())) score += 5;
  if (record.title && text.includes(record.title.toLowerCase())) score += 3;
  if (record.serviceId && text.includes(record.serviceId.toLowerCase())) score += 1;
  return score;
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

function findBookingCard(anchor: HTMLElement) {
  const explicit = anchor.closest<HTMLElement>(
    "[role='dialog'],[aria-modal='true'],.modal,.drawer,.sheet,.appointment-card,.booking-card,aside",
  );
  if (explicit) return explicit;

  let node: HTMLElement | null = anchor;
  while (node && node !== document.body) {
    const text = node.textContent || "";
    if (/booking records/i.test(text) && /resend confirmation|no email records/i.test(text)) return node;
    node = node.parentElement;
  }
  return null;
}

function findOpenBookingCards() {
  const anchors = Array.from(
    document.querySelectorAll<HTMLElement>("button,[role='tab'],a,h1,h2,h3,h4,h5,h6,div,span,p"),
  ).filter((node) => /^(booking records|resend confirmation|no email records)$/i.test((node.textContent || "").trim()));

  const cards = new Set<HTMLElement>();
  for (const anchor of anchors) {
    const card = findBookingCard(anchor);
    if (card && findBookingRecordsAnchor(card)) cards.add(card);
  }
  return Array.from(cards);
}

function renderPanel(card: HTMLElement, record: OptixStatusRecord | null) {
  const existing = card.querySelector<HTMLElement>(".optix-booking-feedback");
  const anchor = findBookingRecordsAnchor(card);
  if (!anchor) return;

  const panel = existing || document.createElement("section");
  panel.className = "optix-booking-feedback";
  const status = record?.syncStatus || "pending";
  const label = STATUS_LABELS[status] || "Waiting to sync";
  const bay = record?.bayName || (status === "pending" ? "Bay not assigned yet" : "No bay assigned");
  const lastChecked = record?.lastSyncedAt || record?.lastAttemptedAt || record?.updatedAt || null;
  const showRetry = status === "failed" || status === "token_expired";

  panel.innerHTML = `
    <div class="optix-booking-feedback__head">
      <div>
        <div class="optix-booking-feedback__eyebrow">Resource booking</div>
        <div class="optix-booking-feedback__bay">${esc(bay)}</div>
        <div class="optix-booking-feedback__status">${esc(label)}</div>
      </div>
    </div>
    <div class="optix-booking-feedback__meta">Last checked: ${esc(formatTime(lastChecked))}</div>
    <div class="optix-booking-feedback__actions">
      <button type="button" data-optix-refresh>Refresh status</button>
      ${showRetry ? '<button type="button" data-optix-retry>Retry</button>' : ""}
    </div>
    <details>
      <summary>Technical details</summary>
      <pre>Booking ID: ${esc(record?.optixBookingId || "Not assigned")}
Session ID: ${esc(record?.optixBookingSessionId || "Not assigned")}
Error code: ${esc(record?.errorCode || "None")}
${esc(record?.errorMessage || "")}</pre>
    </details>
  `;

  if (!existing) anchor.insertAdjacentElement("afterend", panel);
}

async function refreshPanels(runReconcile = false) {
  if (runReconcile) {
    await fetch("/api/optix-booking-reconcile", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
    }).catch(() => null);
  }
  const records = await loadRecords();
  const cards = findOpenBookingCards();
  for (const card of cards) {
    const ranked = records
      .map((record) => ({ record, score: scoreRecord(record, card.textContent || "") }))
      .sort((a, b) => b.score - a.score);
    renderPanel(card, ranked[0]?.score > 0 ? ranked[0].record : records[0] || null);
  }
}

export function installOptixBookingFeedback() {
  if (typeof window === "undefined") return;
  installStyles();
  const observer = new MutationObserver(() => void refreshPanels(false));
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-optix-refresh]")) void refreshPanels(false);
    if (target.closest("[data-optix-retry]")) void refreshPanels(true);
  });
  window.setInterval(() => void refreshPanels(false), 30000);
  void refreshPanels(false);
}
