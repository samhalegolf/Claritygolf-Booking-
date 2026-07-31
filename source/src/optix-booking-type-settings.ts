type Service = { id: string; name?: string };
type ServiceConfig = {
  enabled: boolean;
  leftHanded: boolean;
  preferredResourceIds: string[];
  leftHandedResourceIds: string[];
};

const BAYS = [
  ["600009", "Bay #1"],
  ["600004", "Bay #2"],
  ["600005", "Bay #3"],
  ["600006", "Bay #4"],
  ["600007", "Bay #5"],
  ["600008", "Bay #6"],
  ["600010", "Bay #7"],
] as const;

const DEFAULT_ORDER = BAYS.map(([id]) => id);
const LEFT_HANDED_ORDER = ["600009", "600004", "600005", "600006", "600007", "600008", "600010"];

function esc(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normaliseConfig(value: any): ServiceConfig {
  return {
    enabled: value?.enabled === true,
    leftHanded: value?.leftHanded === true,
    preferredResourceIds: Array.isArray(value?.preferredResourceIds) && value.preferredResourceIds.length
      ? value.preferredResourceIds
      : [...DEFAULT_ORDER],
    leftHandedResourceIds: Array.isArray(value?.leftHandedResourceIds) && value.leftHandedResourceIds.length
      ? value.leftHandedResourceIds
      : [...LEFT_HANDED_ORDER],
  };
}

function orderSelect(name: string, selected: string[]) {
  const ordered = [...selected, ...DEFAULT_ORDER.filter((id) => !selected.includes(id))];
  return `<div class="optix-order" data-order="${name}">${ordered.map((id, index) => {
    const label = BAYS.find(([candidate]) => candidate === id)?.[1] || id;
    return `<label><span>${index + 1}</span><select data-index="${index}">${DEFAULT_ORDER.map((candidate) => {
      const candidateLabel = BAYS.find(([bayId]) => bayId === candidate)?.[1] || candidate;
      return `<option value="${candidate}"${candidate === id ? " selected" : ""}>${candidateLabel}</option>`;
    }).join("")}</select></label>`;
  }).join("")}</div>`;
}

async function loadServices(): Promise<Service[]> {
  const response = await fetch("/api/services", { credentials: "same-origin" });
  if (!response.ok) return [];
  const payload = await response.json();
  return Array.isArray(payload?.services) ? payload.services : [];
}

async function loadConfig() {
  const response = await fetch("/api/optix-booking-type-settings", { credentials: "same-origin" });
  if (!response.ok) return {};
  const payload = await response.json();
  return payload?.config && typeof payload.config === "object" ? payload.config : {};
}

function collectOrder(card: HTMLElement, key: string) {
  return Array.from(card.querySelectorAll<HTMLSelectElement>(`.optix-order[data-order="${key}"] select`))
    .map((select) => select.value)
    .filter((id, index, values) => id && values.indexOf(id) === index);
}

function installStyles() {
  if (document.getElementById("optix-booking-type-styles")) return;
  const style = document.createElement("style");
  style.id = "optix-booking-type-styles";
  style.textContent = `
    #optix-booking-type-button{position:fixed;right:22px;bottom:22px;z-index:10020;border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:10px 14px;background:#102117;color:#fff;font:600 13px/1 system-ui;box-shadow:0 10px 30px rgba(0,0,0,.28);cursor:pointer}
    #optix-booking-type-modal{position:fixed;inset:0;z-index:10030;background:rgba(0,0,0,.65);display:grid;place-items:center;padding:20px;font-family:system-ui;color:#eef7ef}
    #optix-booking-type-modal .optix-panel{width:min(760px,100%);max-height:88vh;overflow:auto;background:#0b160f;border:1px solid rgba(255,255,255,.14);border-radius:18px;padding:20px;box-shadow:0 24px 80px rgba(0,0,0,.45)}
    #optix-booking-type-modal .optix-head{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:14px}
    #optix-booking-type-modal h2{font-size:20px;margin:0} #optix-booking-type-modal h3{font-size:15px;margin:0 0 12px}
    #optix-booking-type-modal button{border:0;border-radius:9px;padding:9px 12px;cursor:pointer;font-weight:700}
    #optix-booking-type-modal .optix-close{background:#243129;color:#fff} #optix-booking-type-modal .optix-save{background:#27d66f;color:#061008}
    #optix-booking-type-modal .optix-card{border:1px solid rgba(255,255,255,.12);border-radius:13px;padding:14px;margin:10px 0;background:rgba(255,255,255,.025)}
    #optix-booking-type-modal .optix-switches{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:12px} #optix-booking-type-modal .optix-switches label{display:flex;gap:8px;align-items:center;font-size:13px}
    #optix-booking-type-modal .optix-columns{display:grid;grid-template-columns:1fr 1fr;gap:14px} #optix-booking-type-modal .optix-column-title{font-size:12px;color:#a9b7ac;margin-bottom:7px}
    #optix-booking-type-modal .optix-order label{display:flex;align-items:center;gap:7px;margin:5px 0} #optix-booking-type-modal .optix-order span{width:18px;color:#8fa096;font-size:11px}
    #optix-booking-type-modal select{width:100%;background:#142219;color:#fff;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:7px}
    #optix-booking-type-modal .optix-foot{display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-top:16px} #optix-booking-type-modal .optix-status{font-size:12px;color:#a9b7ac}
    @media(max-width:640px){#optix-booking-type-modal .optix-columns{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);
}

async function openEditor() {
  if (document.getElementById("optix-booking-type-modal")) return;
  const [services, saved] = await Promise.all([loadServices(), loadConfig()]);
  const modal = document.createElement("div");
  modal.id = "optix-booking-type-modal";
  modal.innerHTML = `<div class="optix-panel"><div class="optix-head"><div><h2>Optix bay preferences</h2><div style="font-size:12px;color:#9cad9f;margin-top:4px">Booking type settings</div></div><button class="optix-close">Close</button></div>${services.map((service) => {
    const config = normaliseConfig(saved?.[service.id]);
    return `<section class="optix-card" data-service-id="${esc(service.id)}"><h3>${esc(service.name || service.id)}</h3><div class="optix-switches"><label><input type="checkbox" data-field="enabled"${config.enabled ? " checked" : ""}> Book an Optix bay</label><label><input type="checkbox" data-field="leftHanded"${config.leftHanded ? " checked" : ""}> Left-handed booking type</label></div><div class="optix-columns"><div><div class="optix-column-title">Preferred bay order</div>${orderSelect("preferredResourceIds", config.preferredResourceIds)}</div><div><div class="optix-column-title">Left-handed bay order</div>${orderSelect("leftHandedResourceIds", config.leftHandedResourceIds)}</div></div></section>`;
  }).join("")}<div class="optix-foot"><span class="optix-status"></span><button class="optix-save">Save bay preferences</button></div></div>`;
  document.body.appendChild(modal);
  modal.querySelector<HTMLButtonElement>(".optix-close")?.addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (event) => { if (event.target === modal) modal.remove(); });
  modal.querySelector<HTMLButtonElement>(".optix-save")?.addEventListener("click", async () => {
    const status = modal.querySelector<HTMLElement>(".optix-status");
    const config = Object.fromEntries(Array.from(modal.querySelectorAll<HTMLElement>(".optix-card")).map((card) => {
      const serviceId = card.dataset.serviceId || "";
      return [serviceId, {
        enabled: card.querySelector<HTMLInputElement>('[data-field="enabled"]')?.checked === true,
        leftHanded: card.querySelector<HTMLInputElement>('[data-field="leftHanded"]')?.checked === true,
        preferredResourceIds: collectOrder(card, "preferredResourceIds"),
        leftHandedResourceIds: collectOrder(card, "leftHandedResourceIds"),
      }];
    }));
    if (status) status.textContent = "Saving…";
    const response = await fetch("/api/optix-booking-type-settings", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config }),
    });
    if (status) status.textContent = response.ok ? "Saved" : "Could not save";
  });
}

export function installOptixBookingTypeSettings() {
  if (typeof window === "undefined") return;
  installStyles();
  const button = document.createElement("button");
  button.id = "optix-booking-type-button";
  button.type = "button";
  button.textContent = "Optix bays";
  button.addEventListener("click", openEditor);
  document.body.appendChild(button);
}
