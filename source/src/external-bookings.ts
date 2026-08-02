import { openOptixResourceEditor } from "./optix-booking-type-settings";

type OptixTab = "setup" | "feed" | "resources" | "diagnostics";
type State = { mappings: any[]; catalog: { services: any[]; locations: any[]; coaches: any[] }; events: any[] };
const esc = (value: unknown) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
let state: State | null = null;
let activeTab: OptixTab = "setup";
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

function setupView(mapping: any) {
  if (!state) return "";
  return `<div class="optix-callout"><strong>Inbound lesson creation</strong><span>Only workspace ID 637949 is recognised. All bay workspaces are ignored.</span></div>
    <div class="optix-grid">
      <label class="optix-toggle"><input type="checkbox" data-optix-enabled${mapping.enabled ? " checked" : ""}> Enable inbound lesson creation</label>
      <label>Optix workspace<input value="637949 · Swing Analysis" readonly></label>
      <label>Clarity service<select data-optix-service>${optionRows(state.catalog.services || [], mapping.service_id || "", "Select service")}</select></label>
      <label>Clarity location<select data-optix-location>${optionRows(state.catalog.locations || [], mapping.location_id || "", "Select location")}</select></label>
      <label>Default coach (optional)<select data-optix-coach>${optionRows(state.catalog.coaches || [], mapping.default_coach_id || "", "No default coach")}</select></label>
      <label>Customer email<select data-optix-email><option value="none"${mapping.email_behaviour === "none" || !mapping.email_behaviour ? " selected" : ""}>No Clarity email</option><option value="immediate"${mapping.email_behaviour === "immediate" ? " selected" : ""}>Send immediately</option><option value="after_bay"${mapping.email_behaviour === "after_bay" ? " selected" : ""}>Send after manual bay booking</option></select></label>
      <label>Bay booking<input value="Manual" readonly></label>
    </div><div class="optix-actions"><button class="primary" type="button" data-optix-save>${busy ? "Saving…" : "Save Optix settings"}</button><span data-optix-message></span></div>`;
}

function feedView() {
  const events = state?.events || [];
  if (!events.length) return `<div class="optix-empty"><strong>No Optix data received yet</strong><span>Validated webhook events will appear here without needing to create a calendar appointment.</span></div>`;
  return `<div class="optix-feed-head"><div><strong>Received webhook data</strong><span>${events.length} most recent events · newest first</span></div><button type="button" data-optix-refresh>Refresh feed</button></div>
    <div class="optix-feed">${events.map((event) => `<details class="optix-event"${event.processing_status === "failed" ? " open" : ""}>
      <summary><span class="optix-dot is-${esc(event.processing_status)}"></span><strong>${esc(event.event_type || "Unknown event")}</strong><span>${esc(event.customer || "No customer name")}</span><time>${esc(event.received_at ? new Date(event.received_at).toLocaleString() : "")}</time><em>${esc(event.processing_status)}</em></summary>
      <div class="optix-event-meta"><span>Workspace <b>${esc(event.workspaceId || "—")}</b></span><span>Inbound booking <b>${esc(event.external_booking_id || "—")}</b></span><span>Appointment <b>${esc(event.clarity_item_id || "Not created")}</b></span><span>Bay booking <b>${esc(event.outboundBayBookingId || "Not booked")}</b></span><span>Email <b>${esc(event.emailStatus || "—")}</b></span><span>Attempts <b>${esc(event.attempt_count || 0)}</b></span></div>
      ${event.error_message ? `<div class="optix-error"><strong>${esc(event.failure_code || "Processing error")}</strong>${esc(event.error_message)}</div>` : ""}
      <div class="optix-payload-head"><strong>Raw webhook payload</strong><span>Protected admin data</span></div><pre>${esc(JSON.stringify(event.rawPayload || {}, null, 2))}</pre>
      ${event.processing_status === "failed" ? `<button class="retry" type="button" data-optix-retry="${esc(event.event_key)}">Retry this event</button>` : ""}
    </details>`).join("")}</div>`;
}

function resourcesView() {
  return `<div class="optix-resource-view"><div class="optix-resource-icon">7</div><div><h3>Optix bay resources</h3><p>Choose eligible bays, set their priority order, configure left-handed profiles, and attach profiles to Clarity lesson types.</p><p>Resource booking remains manual from the appointment’s <strong>Book resource</strong> action.</p><button class="primary" type="button" data-optix-resources>Manage resource profiles</button></div></div>`;
}

function diagnosticsView() {
  const events = state?.events || [];
  const count = (status: string) => events.filter((event) => event.processing_status === status).length;
  const latest = events[0];
  return `<div class="optix-diagnostics"><div><span>Received</span><strong>${events.length}</strong></div><div><span>Processed</span><strong>${count("processed")}</strong></div><div><span>Ignored</span><strong>${count("ignored")}</strong></div><div><span>Failed</span><strong>${count("failed")}</strong></div></div>
    <div class="optix-debug-list"><p><span>Webhook endpoint</span><code>/api/optix-webhook</code></p><p><span>Recognised workspace</span><code>637949 · Swing Analysis</code></p><p><span>Ordinary bay example</span><code>600006 · ignored</code></p><p><span>Latest receipt</span><code>${esc(latest?.received_at ? new Date(latest.received_at).toLocaleString() : "None")}</code></p><p><span>Bay booking mode</span><code>Manual only</code></p></div>`;
}

function render(panel: HTMLElement) {
  if (!state) return;
  const mapping = state.mappings.find((row) => String(row.workspace_id) === "637949") || {};
  const view = activeTab === "setup" ? setupView(mapping) : activeTab === "feed" ? feedView() : activeTab === "resources" ? resourcesView() : diagnosticsView();
  panel.innerHTML = `<div class="optix-title"><div><span class="optix-kicker">Integration</span><h2>Optix</h2><p>Inbound lesson data, bay resources, and processing diagnostics in one place.</p></div><span class="optix-health ${state.events.some((event) => event.processing_status === "failed") ? "has-errors" : ""}">${state.events.some((event) => event.processing_status === "failed") ? "Needs attention" : "Connected"}</span></div>
    <div class="optix-tabs" role="tablist">${(["setup", "feed", "resources", "diagnostics"] as OptixTab[]).map((tab) => `<button type="button" role="tab" data-optix-tab="${tab}" class="${activeTab === tab ? "active" : ""}">${tab === "feed" ? "Data feed" : tab[0].toUpperCase() + tab.slice(1)}${tab === "feed" && state!.events.length ? `<b>${state!.events.length}</b>` : ""}</button>`).join("")}</div><div class="optix-view">${view}</div>`;
}

async function refresh(panel: HTMLElement) { if (await load()) render(panel); }
async function save(panel: HTMLElement) {
  if (busy) return; const service = panel.querySelector<HTMLSelectElement>("[data-optix-service]");
  const body = { workspaceId: "637949", enabled: panel.querySelector<HTMLInputElement>("[data-optix-enabled]")?.checked === true, serviceId: service?.value || "", serviceName: service?.selectedOptions[0]?.textContent || "", locationId: panel.querySelector<HTMLSelectElement>("[data-optix-location]")?.value || "", defaultCoachId: panel.querySelector<HTMLSelectElement>("[data-optix-coach]")?.value || "", emailBehaviour: panel.querySelector<HTMLSelectElement>("[data-optix-email]")?.value || "none" };
  busy = true; render(panel); const response = await fetch("/api/external-bookings", { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const result = await response.json().catch(() => ({})); busy = false; if (response.ok) state = result.state; render(panel); const message = panel.querySelector<HTMLElement>("[data-optix-message]"); if (message) message.textContent = response.ok ? "Saved" : result.message || "Could not save";
}
async function retry(panel: HTMLElement, eventKey: string) { const response = await fetch("/api/external-bookings", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "retry", eventKey }) }); const result = await response.json().catch(() => ({})); if (response.ok) { state = result.state; render(panel); } }

function styles() {
  if (document.getElementById("optix-integration-styles")) return; const style = document.createElement("style"); style.id = "optix-integration-styles";
  style.textContent = `.optix-integration{grid-column:1/-1;padding:0!important;overflow:hidden}.optix-title{display:flex;justify-content:space-between;gap:20px;padding:22px 24px 18px;background:linear-gradient(120deg,rgba(39,214,111,.12),transparent 55%)}.optix-title h2{margin:2px 0;font-size:26px}.optix-title p{margin:4px 0;opacity:.68}.optix-kicker{font-size:10px;font-weight:900;letter-spacing:.13em;text-transform:uppercase;color:#179b50}.optix-health{height:max-content;padding:6px 10px;border-radius:99px;background:rgba(39,214,111,.14);color:#14763e;font-size:11px;font-weight:800}.optix-health.has-errors{background:rgba(190,55,55,.12);color:#a52f2f}.optix-tabs{display:flex;gap:3px;padding:0 24px;border-bottom:1px solid rgba(0,0,0,.1);overflow:auto}.optix-tabs button{display:flex;gap:7px;align-items:center;padding:11px 13px;border:0;border-bottom:2px solid transparent;background:transparent;font:700 12px/1 inherit;opacity:.65;cursor:pointer;white-space:nowrap}.optix-tabs button.active{opacity:1;border-color:#27b965}.optix-tabs b{min-width:18px;padding:2px 5px;border-radius:99px;background:rgba(39,214,111,.15);font-size:10px}.optix-view{padding:22px 24px}.optix-callout{display:flex;flex-direction:column;gap:4px;padding:13px 15px;margin-bottom:16px;border-radius:10px;background:rgba(39,214,111,.07)}.optix-callout span{font-size:12px;opacity:.7}.optix-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:13px}.optix-grid label{display:grid;gap:5px;font-size:12px;font-weight:700}.optix-grid input,.optix-grid select{padding:9px;border:1px solid rgba(0,0,0,.16);border-radius:8px;background:transparent}.optix-toggle{display:flex!important;align-items:center}.optix-actions{display:flex;align-items:center;gap:10px;margin-top:18px}.optix-integration button.primary,.optix-event button.retry,.optix-feed-head button{padding:9px 13px;border:0;border-radius:8px;background:#102d20;color:white;font-weight:750;cursor:pointer}.optix-feed-head{display:flex;justify-content:space-between;gap:14px;align-items:center;margin-bottom:12px}.optix-feed-head>div{display:grid;gap:2px}.optix-feed-head span{font-size:11px;opacity:.6}.optix-event{border:1px solid rgba(0,0,0,.11);border-radius:10px;margin:8px 0;overflow:hidden}.optix-event summary{display:grid;grid-template-columns:10px minmax(130px,1.1fr) minmax(120px,1fr) auto auto;gap:10px;align-items:center;padding:11px 13px;cursor:pointer}.optix-event summary span,.optix-event time{font-size:11px;opacity:.68}.optix-event summary em{font-size:10px;font-style:normal;font-weight:800;text-transform:uppercase}.optix-dot{width:7px;height:7px;border-radius:50%;background:#999}.optix-dot.is-processed{background:#27b965}.optix-dot.is-failed{background:#c34141}.optix-dot.is-ignored{background:#d49b35}.optix-event-meta{display:flex;gap:12px;flex-wrap:wrap;padding:10px 13px;background:rgba(0,0,0,.025);font-size:11px}.optix-payload-head{display:flex;justify-content:space-between;padding:12px 13px 5px;font-size:11px}.optix-payload-head span{opacity:.55}.optix-event pre{margin:4px 13px 13px;padding:12px;max-height:360px;overflow:auto;border-radius:8px;background:#0c1710;color:#dce8df;font:11px/1.5 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word}.optix-error{margin:10px 13px;padding:10px;border-radius:8px;background:rgba(190,55,55,.09);color:#9d3030;font-size:12px}.optix-error strong{display:block}.optix-event .retry{margin:0 13px 13px}.optix-empty{display:grid;gap:5px;padding:30px;text-align:center;border:1px dashed rgba(0,0,0,.18);border-radius:12px}.optix-empty span{font-size:12px;opacity:.65}.optix-resource-view{display:grid;grid-template-columns:auto 1fr;gap:18px;max-width:720px}.optix-resource-icon{display:grid;place-items:center;width:54px;height:54px;border-radius:14px;background:rgba(39,214,111,.12);color:#16884a;font-size:23px;font-weight:900}.optix-resource-view h3{margin:2px 0}.optix-resource-view p{font-size:13px;line-height:1.55;opacity:.72}.optix-diagnostics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.optix-diagnostics>div{display:grid;gap:4px;padding:15px;border-radius:10px;background:rgba(0,0,0,.035)}.optix-diagnostics span{font-size:11px;opacity:.6}.optix-diagnostics strong{font-size:22px}.optix-debug-list{margin-top:16px}.optix-debug-list p{display:flex;justify-content:space-between;gap:15px;padding:9px 0;border-bottom:1px solid rgba(0,0,0,.08);font-size:12px}.optix-debug-list code{word-break:break-all}.optix-error+*{}@media(max-width:720px){.optix-event summary{grid-template-columns:10px 1fr auto}.optix-event summary>span,.optix-event summary>time{display:none}.optix-diagnostics{grid-template-columns:repeat(2,1fr)}.optix-title{padding:18px}.optix-view{padding:18px}.optix-tabs{padding:0 12px}}`;
  document.head.appendChild(style);
}

async function mount() {
  const grid = document.querySelector<HTMLElement>(".settings-grid.settings-tab-integrations");
  if (!grid || grid.querySelector(".optix-integration")) return;
  if (!(await load()) || !document.body.contains(grid)) return;
  const panel = document.createElement("article"); panel.className = "data-card settings-section settings-integrations optix-integration"; render(panel); grid.prepend(panel);
  panel.addEventListener("click", (event) => { const target = event.target as HTMLElement; const tab = target.closest<HTMLElement>("[data-optix-tab]")?.dataset.optixTab as OptixTab | undefined; if (tab) { activeTab = tab; render(panel); return; } if (target.closest("[data-optix-save]")) void save(panel); if (target.closest("[data-optix-refresh]")) void refresh(panel); if (target.closest("[data-optix-resources]")) void openOptixResourceEditor(); const retryButton = target.closest<HTMLElement>("[data-optix-retry]"); if (retryButton?.dataset.optixRetry) void retry(panel, retryButton.dataset.optixRetry); });
}

export function installExternalBookings() { if (typeof window === "undefined") return; styles(); let queued = false; const schedule = () => { if (queued) return; queued = true; setTimeout(() => { queued = false; void mount(); }, 100); }; new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true }); schedule(); }
