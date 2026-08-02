type State = { mappings: any[]; catalog: { services: any[]; locations: any[]; coaches: any[] }; events: any[] };

const esc = (value: unknown) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
let state: State | null = null;
let busy = false;

async function load() {
  const response = await fetch("/api/external-bookings", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) return null;
  state = await response.json();
  return state;
}

function optionRows(rows: any[], selected: string, empty: string) {
  return `<option value="">${esc(empty)}</option>${rows.map((row) => `<option value="${esc(row.id)}"${row.id === selected ? " selected" : ""}>${esc(row.name || row.displayName || row.id)}</option>`).join("")}`;
}

function eventRows(events: any[]) {
  if (!events.length) return '<p class="external-empty">No inbound Optix events received yet.</p>';
  return `<div class="external-table-wrap"><table><thead><tr><th>Received</th><th>Customer</th><th>Workspace</th><th>Status</th><th>Appointment</th><th>Bay</th><th>Email</th><th>IDs</th><th></th></tr></thead><tbody>${events.map((event) => `<tr><td>${esc(event.received_at ? new Date(event.received_at).toLocaleString() : "")}</td><td>${esc(event.customer)}</td><td>${esc(event.workspaceName || event.workspaceId)}</td><td>${esc(event.processing_status)}${event.error_message ? `<small>${esc(event.error_message)}</small>` : ""}</td><td>${esc(event.clarity_item_id || "—")}</td><td>${esc(event.bayStatus)}</td><td>${esc(event.emailStatus || "—")}</td><td><small>Lesson: ${esc(event.external_booking_id || "—")}<br>Bay: ${esc(event.outboundBayBookingId || "—")}</small></td><td>${event.processing_status === "failed" ? `<button type="button" data-external-retry="${esc(event.event_key)}">Retry</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
}

function render(panel: HTMLElement) {
  if (!state) return;
  const mapping = state.mappings.find((row) => String(row.workspace_id) === "637949") || {};
  panel.innerHTML = `<div class="external-head"><div><h2>External bookings</h2><p>Recognised Optix lesson bookings become normal Clarity appointments. Bay booking remains manual.</p></div><span>Optix</span></div>
    <div class="external-grid">
      <label class="external-toggle"><input type="checkbox" data-external-enabled${mapping.enabled ? " checked" : ""}> Enable inbound lesson creation</label>
      <label>Optix workspace<input value="637949 · Swing Analysis" readonly></label>
      <label>Clarity service<select data-external-service>${optionRows(state.catalog.services || [], mapping.service_id || "", "Select service")}</select></label>
      <label>Clarity location<select data-external-location>${optionRows(state.catalog.locations || [], mapping.location_id || "", "Select location")}</select></label>
      <label>Default coach (optional)<select data-external-coach>${optionRows(state.catalog.coaches || [], mapping.default_coach_id || "", "No default coach")}</select></label>
      <label>Customer email<select data-external-email><option value="none"${mapping.email_behaviour === "none" || !mapping.email_behaviour ? " selected" : ""}>No Clarity email</option><option value="immediate"${mapping.email_behaviour === "immediate" ? " selected" : ""}>Send Clarity confirmation immediately</option><option value="after_bay"${mapping.email_behaviour === "after_bay" ? " selected" : ""}>Send only after bay is manually booked</option></select></label>
      <label>Bay booking<input value="Manual" readonly></label>
    </div><div class="external-actions"><button type="button" data-external-save>${busy ? "Saving…" : "Save settings"}</button><span data-external-message></span></div>
    <h3>Recent inbound events</h3>${eventRows(state.events || [])}`;
}

async function save(panel: HTMLElement) {
  if (busy) return; busy = true; render(panel);
  const service = panel.querySelector<HTMLSelectElement>("[data-external-service]");
  const body = {
    workspaceId: "637949", enabled: panel.querySelector<HTMLInputElement>("[data-external-enabled]")?.checked === true,
    serviceId: service?.value || "", serviceName: service?.selectedOptions[0]?.textContent || "",
    locationId: panel.querySelector<HTMLSelectElement>("[data-external-location]")?.value || "",
    defaultCoachId: panel.querySelector<HTMLSelectElement>("[data-external-coach]")?.value || "",
    emailBehaviour: panel.querySelector<HTMLSelectElement>("[data-external-email]")?.value || "none",
  };
  const response = await fetch("/api/external-bookings", { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({})); busy = false;
  if (response.ok) state = result.state;
  render(panel);
  const message = panel.querySelector<HTMLElement>("[data-external-message]");
  if (message) message.textContent = response.ok ? "Saved" : result.message || "Could not save";
}

async function retry(panel: HTMLElement, eventKey: string) {
  const response = await fetch("/api/external-bookings", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "retry", eventKey }) });
  const result = await response.json().catch(() => ({}));
  if (response.ok) { state = result.state; render(panel); }
}

function styles() {
  if (document.getElementById("external-bookings-styles")) return;
  const style = document.createElement("style"); style.id = "external-bookings-styles";
  style.textContent = `.external-bookings{margin:20px 0;padding:20px;border:1px solid rgba(0,0,0,.12);border-radius:16px;background:var(--surface,#fff)}.external-head{display:flex;justify-content:space-between;gap:16px}.external-head h2{margin:0}.external-head p{margin:5px 0 18px;opacity:.7}.external-head>span{height:max-content;padding:5px 9px;border-radius:99px;background:#dff7e9;font-weight:800}.external-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.external-grid label{display:grid;gap:5px;font-size:12px;font-weight:700}.external-grid input,.external-grid select{padding:9px;border:1px solid rgba(0,0,0,.16);border-radius:8px;background:transparent}.external-toggle{display:flex!important;align-items:center}.external-actions{display:flex;align-items:center;gap:10px;margin:16px 0 22px}.external-actions button,.external-bookings td button{padding:8px 12px;border:0;border-radius:8px;background:#102d20;color:white;font-weight:700}.external-table-wrap{overflow:auto}.external-bookings table{width:100%;border-collapse:collapse;font-size:12px}.external-bookings th,.external-bookings td{text-align:left;padding:8px;border-bottom:1px solid rgba(0,0,0,.1);vertical-align:top}.external-bookings td small{display:block;max-width:220px}.external-empty{opacity:.65}`;
  document.head.appendChild(style);
}

async function mount() {
  if (!/settings/i.test(document.body.textContent || "")) return;
  if (document.querySelector(".external-bookings")) return;
  const headings = Array.from(document.querySelectorAll<HTMLElement>("h1,h2")).filter((node) => /settings/i.test(node.textContent || ""));
  const anchor = headings[0]?.closest<HTMLElement>("main,section,.settings-view") || headings[0]?.parentElement;
  if (!anchor) return;
  const data = await load(); if (!data || document.querySelector(".external-bookings")) return;
  const panel = document.createElement("article"); panel.className = "external-bookings"; render(panel); anchor.appendChild(panel);
  panel.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("[data-external-save]")) void save(panel);
    const retryButton = (event.target as HTMLElement).closest<HTMLElement>("[data-external-retry]");
    if (retryButton?.dataset.externalRetry) void retry(panel, retryButton.dataset.externalRetry);
  });
}

export function installExternalBookings() {
  if (typeof window === "undefined") return; styles();
  let queued = false; const schedule = () => { if (queued) return; queued = true; setTimeout(() => { queued = false; void mount(); }, 100); };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true }); schedule();
}
