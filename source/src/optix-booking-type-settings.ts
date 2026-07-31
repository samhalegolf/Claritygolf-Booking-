type Service = { id: string; name?: string };
type Handedness = "standard" | "left";
type ResourceProfile = {
  id: string;
  name: string;
  handedness: Handedness;
  resourceIds: string[];
  serviceIds: string[];
};

type SavedState = {
  config?: Record<string, any>;
  profiles?: ResourceProfile[];
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

function esc(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function labelForBay(id: string) {
  return BAYS.find(([candidate]) => candidate === id)?.[1] || id;
}

function makeProfile(name = "New resource profile", handedness: Handedness = "standard"): ResourceProfile {
  return {
    id: `resource-profile-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    handedness,
    resourceIds: [...DEFAULT_ORDER],
    serviceIds: [],
  };
}

async function loadServices(): Promise<Service[]> {
  const response = await fetch("/api/services", { credentials: "same-origin" });
  if (!response.ok) return [];
  const payload = await response.json();
  return Array.isArray(payload?.services) ? payload.services : [];
}

async function loadState(): Promise<SavedState> {
  const response = await fetch("/api/optix-booking-type-settings", { credentials: "same-origin" });
  if (!response.ok) return {};
  return response.json();
}

function migrateProfiles(services: Service[], saved: SavedState): ResourceProfile[] {
  if (Array.isArray(saved.profiles) && saved.profiles.length) {
    return saved.profiles.map((profile): ResourceProfile => ({
      id: String(profile.id || makeProfile().id),
      name: String(profile.name || "Resource profile"),
      handedness: profile.handedness === "left" ? "left" : "standard",
      resourceIds: Array.isArray(profile.resourceIds)
        ? profile.resourceIds.filter((id) => DEFAULT_ORDER.includes(id))
        : [],
      serviceIds: Array.isArray(profile.serviceIds) ? profile.serviceIds.map(String) : [],
    })).filter((profile) => profile.resourceIds.length);
  }

  const config = saved.config || {};
  const profiles: ResourceProfile[] = [];
  for (const service of services) {
    const item = config?.[service.id];
    if (item?.enabled !== true) continue;
    const handedness: Handedness = item.leftHanded === true ? "left" : "standard";
    const order = handedness === "left" ? item.leftHandedResourceIds : item.preferredResourceIds;
    const resourceIds = Array.isArray(order)
      ? order.filter((id: string) => DEFAULT_ORDER.includes(id))
      : [...DEFAULT_ORDER];
    const key = `${handedness}:${resourceIds.join(",")}`;
    const existing = profiles.find((profile) => `${profile.handedness}:${profile.resourceIds.join(",")}` === key);
    if (existing) existing.serviceIds.push(service.id);
    else profiles.push({
      ...makeProfile(handedness === "left" ? "Left-handed lessons" : "Standard lessons", handedness),
      resourceIds: resourceIds.length ? resourceIds : [...DEFAULT_ORDER],
      serviceIds: [service.id],
    });
  }
  return profiles.length ? profiles : [makeProfile("Standard lessons")];
}

function installStyles() {
  if (document.getElementById("optix-resource-styles")) return;
  const style = document.createElement("style");
  style.id = "optix-resource-styles";
  style.textContent = `
    #clarity-resources-menu-item{font:inherit}
    #optix-resource-modal{position:fixed;inset:0;z-index:10030;background:rgba(0,0,0,.62);display:grid;place-items:center;padding:20px;font-family:system-ui;color:#eef7ef}
    #optix-resource-modal .resource-panel{width:min(920px,100%);max-height:90vh;overflow:auto;background:#0b160f;border:1px solid rgba(255,255,255,.14);border-radius:18px;padding:20px;box-shadow:0 24px 80px rgba(0,0,0,.45)}
    #optix-resource-modal .resource-head,#optix-resource-modal .resource-foot,#optix-resource-modal .profile-head{display:flex;justify-content:space-between;align-items:center;gap:14px}
    #optix-resource-modal h2{font-size:21px;margin:0}
    #optix-resource-modal .resource-subtitle{font-size:12px;color:#9cad9f;margin-top:4px}
    #optix-resource-modal button{border:0;border-radius:9px;padding:9px 12px;cursor:pointer;font-weight:700}
    #optix-resource-modal .secondary{background:#243129;color:#fff}
    #optix-resource-modal .primary{background:#27d66f;color:#061008}
    #optix-resource-modal .danger{background:#4b2020;color:#ffd8d8}
    #optix-resource-modal .add-profile{margin:16px 0;background:#243129;color:#fff}
    #optix-resource-modal .profile-card{border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:15px;margin:12px 0;background:rgba(255,255,255,.025)}
    #optix-resource-modal .profile-name{width:min(360px,58vw);background:#142219;color:#fff;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:9px;font-weight:700}
    #optix-resource-modal .handedness{background:#142219;color:#fff;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:9px}
    #optix-resource-modal .profile-grid{display:grid;grid-template-columns:minmax(250px,.9fr) minmax(280px,1.1fr);gap:18px;margin-top:14px}
    #optix-resource-modal .section-title{font-size:12px;color:#a9b7ac;margin-bottom:8px}
    #optix-resource-modal .bay-row{display:grid;grid-template-columns:24px 1fr auto;align-items:center;gap:8px;padding:7px 8px;margin:5px 0;border-radius:9px;background:#142219}
    #optix-resource-modal .bay-actions{display:flex;gap:5px}
    #optix-resource-modal .bay-actions button{padding:5px 8px;background:#26382c;color:#fff}
    #optix-resource-modal .bay-actions .remove-bay{background:#4b2020;color:#ffd8d8}
    #optix-resource-modal .removed-bays{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}
    #optix-resource-modal .removed-bays button{background:#26382c;color:#fff;padding:7px 9px}
    #optix-resource-modal .service-list{display:grid;gap:7px}
    #optix-resource-modal .service-list label{display:flex;align-items:center;gap:9px;padding:8px;border-radius:8px;background:#142219;font-size:13px}
    #optix-resource-modal .resource-foot{justify-content:flex-end;margin-top:18px}
    #optix-resource-modal .status{font-size:12px;color:#a9b7ac;margin-right:auto}
    #optix-resource-modal .empty-note{padding:18px;border:1px dashed rgba(255,255,255,.18);border-radius:12px;color:#a9b7ac}
    @media(max-width:720px){#optix-resource-modal .profile-grid{grid-template-columns:1fr}.profile-head{align-items:flex-start!important;flex-wrap:wrap}}
  `;
  document.head.appendChild(style);
}

function renderProfile(profile: ResourceProfile, services: Service[]) {
  const removed = DEFAULT_ORDER.filter((id) => !profile.resourceIds.includes(id));
  return `<section class="profile-card" data-profile-id="${esc(profile.id)}">
    <div class="profile-head">
      <input class="profile-name" value="${esc(profile.name)}" aria-label="Profile name">
      <select class="handedness" aria-label="Player handedness">
        <option value="standard"${profile.handedness === "standard" ? " selected" : ""}>Standard / any player</option>
        <option value="left"${profile.handedness === "left" ? " selected" : ""}>Left-handed players</option>
      </select>
      <button class="danger delete-profile" type="button">Delete profile</button>
    </div>
    <div class="profile-grid">
      <div>
        <div class="section-title">Bay order — remove a bay to exclude it completely</div>
        <div class="bay-list">${profile.resourceIds.map((id, index) => `<div class="bay-row" data-bay-id="${id}"><span>${index + 1}</span><strong>${esc(labelForBay(id))}</strong><div class="bay-actions"><button type="button" class="move-up" aria-label="Move up">↑</button><button type="button" class="move-down" aria-label="Move down">↓</button><button type="button" class="remove-bay">Remove</button></div></div>`).join("")}</div>
        <div class="section-title" style="margin-top:12px">Removed bays</div>
        <div class="removed-bays">${removed.length ? removed.map((id) => `<button type="button" data-add-bay="${id}">+ ${esc(labelForBay(id))}</button>`).join("") : `<span class="resource-subtitle">All bays are available to this profile.</span>`}</div>
      </div>
      <div>
        <div class="section-title">Apply this profile to lesson types</div>
        <div class="service-list">${services.map((service) => `<label><input type="checkbox" data-service-id="${esc(service.id)}"${profile.serviceIds.includes(service.id) ? " checked" : ""}> ${esc(service.name || service.id)}</label>`).join("")}</div>
      </div>
    </div>
  </section>`;
}

async function openEditor() {
  if (document.getElementById("optix-resource-modal")) return;
  const [services, saved] = await Promise.all([loadServices(), loadState()]);
  let profiles = migrateProfiles(services, saved);
  const modal = document.createElement("div");
  modal.id = "optix-resource-modal";

  const render = () => {
    modal.innerHTML = `<div class="resource-panel"><div class="resource-head"><div><h2>Resources</h2><div class="resource-subtitle">Create a bay order once, choose its player handedness, then apply it to lesson types.</div></div><button class="secondary close-resources">Close</button></div><button class="add-profile" type="button">+ New resource profile</button><div class="profiles">${profiles.length ? profiles.map((profile) => renderProfile(profile, services)).join("") : `<div class="empty-note">No resource profiles yet.</div>`}</div><div class="resource-foot"><span class="status"></span><button class="primary save-resources">Save resources</button></div></div>`;
  };

  const syncFromDom = () => {
    profiles = Array.from(modal.querySelectorAll<HTMLElement>(".profile-card")).map((card): ResourceProfile => ({
      id: card.dataset.profileId || makeProfile().id,
      name: card.querySelector<HTMLInputElement>(".profile-name")?.value.trim() || "Resource profile",
      handedness: card.querySelector<HTMLSelectElement>(".handedness")?.value === "left" ? "left" : "standard",
      resourceIds: Array.from(card.querySelectorAll<HTMLElement>(".bay-row")).map((row) => row.dataset.bayId || "").filter(Boolean),
      serviceIds: Array.from(card.querySelectorAll<HTMLInputElement>("[data-service-id]:checked")).map((input) => input.dataset.serviceId || "").filter(Boolean),
    }));
  };

  render();
  document.body.appendChild(modal);

  modal.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target === modal || target.closest(".close-resources")) {
      modal.remove();
      return;
    }
    if (target.closest(".add-profile")) {
      syncFromDom();
      profiles.push(makeProfile(`Resource profile ${profiles.length + 1}`));
      render();
      return;
    }
    const card = target.closest<HTMLElement>(".profile-card");
    if (!card) return;
    if (target.closest(".delete-profile")) {
      syncFromDom();
      profiles = profiles.filter((profile) => profile.id !== card.dataset.profileId);
      render();
      return;
    }
    const row = target.closest<HTMLElement>(".bay-row");
    if (row && (target.closest(".move-up") || target.closest(".move-down") || target.closest(".remove-bay"))) {
      syncFromDom();
      const profile = profiles.find((item) => item.id === card.dataset.profileId);
      if (!profile) return;
      const index = profile.resourceIds.indexOf(row.dataset.bayId || "");
      if (target.closest(".remove-bay") && index >= 0) profile.resourceIds.splice(index, 1);
      if (target.closest(".move-up") && index > 0) [profile.resourceIds[index - 1], profile.resourceIds[index]] = [profile.resourceIds[index], profile.resourceIds[index - 1]];
      if (target.closest(".move-down") && index >= 0 && index < profile.resourceIds.length - 1) [profile.resourceIds[index + 1], profile.resourceIds[index]] = [profile.resourceIds[index], profile.resourceIds[index + 1]];
      render();
      return;
    }
    const addBay = target.closest<HTMLButtonElement>("[data-add-bay]");
    if (addBay) {
      syncFromDom();
      const profile = profiles.find((item) => item.id === card.dataset.profileId);
      const id = addBay.dataset.addBay || "";
      if (profile && id && !profile.resourceIds.includes(id)) profile.resourceIds.push(id);
      render();
    }
  });

  modal.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    if (!target.closest(".save-resources")) return;
    syncFromDom();
    const status = modal.querySelector<HTMLElement>(".status");
    if (profiles.some((profile) => !profile.resourceIds.length)) {
      if (status) status.textContent = "Every profile needs at least one bay.";
      return;
    }
    const assigned = new Map<string, string>();
    for (const profile of profiles) {
      for (const serviceId of profile.serviceIds) {
        if (assigned.has(serviceId)) {
          if (status) status.textContent = "A lesson type can only belong to one resource profile.";
          return;
        }
        assigned.set(serviceId, profile.id);
      }
    }
    const config = Object.fromEntries(services.map((service) => {
      const profile = profiles.find((item) => item.serviceIds.includes(service.id));
      const isLeft = profile?.handedness === "left";
      return [service.id, {
        enabled: Boolean(profile),
        leftHanded: isLeft,
        preferredResourceIds: profile && !isLeft ? profile.resourceIds : [],
        leftHandedResourceIds: profile && isLeft ? profile.resourceIds : [],
      }];
    }));
    if (status) status.textContent = "Saving…";
    const response = await fetch("/api/optix-booking-type-settings", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profiles, config }),
    });
    if (status) status.textContent = response.ok ? "Saved" : "Could not save";
  });
}

function addResourcesMenuItem() {
  if (document.getElementById("clarity-resources-menu-item")) return;
  const settingsButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.trim() === "Settings");
  if (!settingsButton) return;

  const locations = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.trim() === "Locations" && button.offsetParent !== null);
  if (!locations?.parentElement) return;

  const button = locations.cloneNode(true) as HTMLButtonElement;
  button.id = "clarity-resources-menu-item";
  button.type = "button";
  button.textContent = "Resources";
  button.removeAttribute("aria-current");
  button.addEventListener("click", openEditor);
  locations.insertAdjacentElement("afterend", button);
}

export function installOptixBookingTypeSettings() {
  if (typeof window === "undefined") return;
  installStyles();
  addResourcesMenuItem();
  const observer = new MutationObserver(addResourcesMenuItem);
  observer.observe(document.body, { childList: true, subtree: true });
}
