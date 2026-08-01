type OptixOriginRecord = {
  id: string;
  title: string;
  client: string;
  status: string;
  external_booking_id: string;
  external_booking_session_id: string;
  external_resource_id: string;
  external_updated_at: string | null;
  external_sync_state: string;
};

function esc(value: unknown) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function installStyles() {
  if (document.getElementById("optix-origin-feedback-styles")) return;
  const style = document.createElement("style");
  style.id = "optix-origin-feedback-styles";
  style.textContent = `
    .optix-origin-badge{display:inline-flex;align-items:center;width:max-content;padding:2px 6px;border-radius:999px;border:1px solid rgba(16,45,32,.22);background:rgba(31,211,109,.10);color:#102d20;font:800 10px/1.35 inherit;letter-spacing:.06em;text-transform:uppercase;margin-left:6px;vertical-align:middle}
    .optix-origin-card{margin-top:10px;padding:10px 12px;border:1px solid rgba(16,45,32,.15);border-radius:10px;background:rgba(31,211,109,.045);font:12px/1.45 inherit}
    .optix-origin-card strong{display:block;font-size:13px;margin-bottom:3px}
    .optix-origin-card details{margin-top:7px;opacity:.75}
    .optix-origin-locked{opacity:.78}
  `;
  document.head.appendChild(style);
}

async function loadRecords(): Promise<OptixOriginRecord[]> {
  const response = await fetch("/api/optix-origin-status", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) return [];
  const payload = await response.json();
  return Array.isArray(payload?.records) ? payload.records : [];
}

function score(record: OptixOriginRecord, text: string) {
  const haystack = text.toLowerCase();
  let result = 0;
  if (record.external_booking_id && haystack.includes(record.external_booking_id.toLowerCase())) result += 100;
  if (record.client && haystack.includes(record.client.toLowerCase())) result += 8;
  if (record.title && haystack.includes(record.title.toLowerCase())) result += 4;
  return result;
}

function candidates() {
  return Array.from(document.querySelectorAll<HTMLElement>("[role='dialog'],[aria-modal='true'],.modal,.drawer,.sheet,.appointment-card,.booking-card,[data-calendar-item-id]"));
}

function decorate(node: HTMLElement, record: OptixOriginRecord) {
  node.dataset.optixOrigin = "true";
  if (!node.querySelector(".optix-origin-badge")) {
    const heading = node.querySelector<HTMLElement>("h1,h2,h3,h4,h5,h6,strong") || node.firstElementChild as HTMLElement | null;
    heading?.insertAdjacentHTML("beforeend", '<span class="optix-origin-badge">OPTIX</span>');
  }
  if (!node.querySelector(".optix-origin-card") && /booking records|resend confirmation|no email records/i.test(node.textContent || "")) {
    const card = document.createElement("section");
    card.className = "optix-origin-card";
    card.innerHTML = `<strong>Optix-origin booking</strong><div>Resource: ${esc(record.external_resource_id || "Not supplied")}</div><div>Sync state: ${esc(record.external_sync_state || record.status || "synced")}</div><div>Optix controls the customer, time, bay and cancellation state. Use Optix for those changes.</div><details><summary>Source details</summary><div>Booking ID: ${esc(record.external_booking_id)}</div><div>Session ID: ${esc(record.external_booking_session_id || "Not supplied")}</div></details>`;
    node.appendChild(card);
  }
  node.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input,select,textarea").forEach((field) => {
    const label = `${field.name} ${field.id} ${field.getAttribute("aria-label") || ""}`.toLowerCase();
    if (/client|customer|start|time|date|duration|location|resource|bay/.test(label)) {
      field.disabled = true;
      field.classList.add("optix-origin-locked");
      field.title = "This field is owned by Optix. Edit it in Optix.";
    }
  });
  node.querySelectorAll<HTMLElement>(".optix-booking-feedback,[data-optix-book]").forEach((element) => element.remove());
}

async function refresh() {
  const records = await loadRecords();
  if (!records.length) return;
  for (const node of candidates()) {
    const ranked = records.map((record) => ({ record, score: score(record, node.textContent || "") })).sort((a, b) => b.score - a.score);
    if ((ranked[0]?.score || 0) >= 8) decorate(node, ranked[0].record);
  }
}

export function installOptixOriginFeedback() {
  if (typeof window === "undefined") return;
  installStyles();
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; void refresh(); });
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  schedule();
}
