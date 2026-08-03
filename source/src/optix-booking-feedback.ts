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

const OPTIX_RECONCILE_EVENT = "clarity:optix-reconcile-complete";

const STATUS_LABELS: Record<string, string> = {
  pending: "Not booked in Optix",
  synced: "Booked in Optix",
  failed: "Optix booking failed",
  token_expired: "Optix token expired",
  cancelled: "Cancelled in Optix",
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
  if (!value) return "Not booked yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not booked yet";
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

function slotDate(record: OptixStatusRecord) {
  const date = new Date(Date.UTC(2026, 5, 1));
  date.setUTCDate(date.getUTCDate() + Number(record.week || 0) * 7 + Number(record.day || 0));
  return date;
}

function minuteLabel(minutes: number) {
  const hour24 = Math.floor(Number(minutes || 0) / 60);
  const minute = Number(minutes || 0) % 60;
  const suffix = hour24 >= 12 ? "pm" : "am";
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function scoreRecord(record: OptixStatusRecord, cardText: string) {
  const text = cardText.toLowerCase().replace(/\s+/g, " ");
  let score = 0;
  if (record.client && text.includes(record.client.toLowerCase())) score += 20;
  if (record.title && text.includes(record.title.toLowerCase())) score += 8;
  if (record.serviceId && text.includes(record.serviceId.toLowerCase())) score += 2;

  const date = slotDate(record);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(date).toLowerCase();
  const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date).toLowerCase();
  const start = minuteLabel(record.start);
  const end = minuteLabel(record.start + record.duration);
  if (text.includes(weekday)) score += 6;
  if (text.includes(monthDay)) score += 12;
  if (text.includes(start)) score += 12;
  if (text.includes(end)) score += 4;
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
  const explicit = anchor.closest<HTMLElement>("[role='dialog'],[aria-modal='true'],.modal,.drawer,.sheet,.appointment-card,.booking-card,aside");
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
  const anchors = Array.from(document.querySelectorAll<HTMLElement>("button,[role='tab'],a,h1,h2,h3,h4,h5,h6,div,span,p"))
    .filter((node) => /^(booking records|resend confirmation|no email records)$/i.test((node.textContent || "").trim()));
  const cards = new Set<HTMLElement>();
  for (const anchor of anchors) {
    const card = findBookingCard(anchor);
    if (card && findBookingRecordsAnchor(card)) cards.add(card);
  }
  return Array.from(cards);
}

function renderPanel(card: HTMLElement, record: OptixStatusRecord) {
  const existing = card.querySelector<HTMLElement>(".optix-booking-feedback");
  const anchor = findBookingRecordsAnchor(card);
  if (!anchor) return;

  const panel = existing || document.createElement("section");
  panel.className = "optix-booking-feedback";
  const status = record.syncStatus || "pending";
  const label = record.errorCode && ERROR_LABELS[record.errorCode]
    ? ERROR_LABELS[record.errorCode]
    : STATUS_LABELS[status] || "Not booked in Optix";
  const bay = record.bayName || (status === "synced" ? "Resource booked" : "Resource booking");
  const lastChecked = record.lastSyncedAt || record.lastAttemptedAt || record.updatedAt || null;
  const canBook = Boolean(record.calendarItemId) && status !== "synced" && status !== "cancelled";
  const visibleMessage = status === "failed" || status === "token_expired" ? record.errorMessage || "" : "";

  panel.innerHTML = `
    <div class="optix-booking-feedback__head">
      <div>
        <div class="optix-booking-feedback__eyebrow">Resource booking</div>
        <div class="optix-booking-feedback__bay">${esc(bay)}</div>
        <div class="optix-booking-feedback__status">${esc(label)}</div>
      </div>
    </div>
    ${visibleMessage ? `<div class="optix-booking-feedback__message">${esc(visibleMessage)}</div>` : ""}
    <div class="optix-booking-feedback__meta">Last checked: ${esc(formatTime(lastChecked))}</div>
    <div class="optix-booking-feedback__actions">
      ${canBook ? `<button type="button" data-optix-book data-calendar-item-id="${esc(record.calendarItemId)}">Book resource</button>` : ""}
      <button type="button" data-optix-refresh>Refresh status</button>
    </div>
    <details>
      <summary>Technical details</summary>
      <pre>Booking ID: ${esc(record.optixBookingId || "Not assigned")}
Session ID: ${esc(record.optixBookingSessionId || "Not assigned")}
Error code: ${esc(record.errorCode || "None")}
${esc(record.errorMessage || "")}</pre>
    </details>
  `;

  if (!existing) anchor.insertAdjacentElement("afterend", panel);
}

function clearPanel(card: HTMLElement) {
  card.querySelector<HTMLElement>(".optix-booking-feedback")?.remove();
}

function selectUnambiguousRecord(records: OptixStatusRecord[], card: HTMLElement) {
  const ranked = records
    .map((record) => ({ record, score: scoreRecord(record, card.textContent || "") }))
    .filter((entry) => entry.score >= 20)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) return null;
  return ranked[0].record;
}

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
    if (!response.ok && response.status !== 207) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.message || "Optix resource booking failed.");
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = error instanceof Error ? error.message : "Booking failed";
  } finally {
    await refreshPanels();
  }
}

async function refreshPanels() {
  const records = await loadRecords();
  const cards = findOpenBookingCards();
  for (const card of cards) {
    const record = selectUnambiguousRecord(records, card);
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
  window.addEventListener(OPTIX_RECONCILE_EVENT, () => void refreshPanels());
  void refreshPanels();
}
