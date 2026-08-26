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
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
  const response = await fetch("/api/optix-origin-status", {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) return [];
  const payload = await response.json();
  return Array.isArray(payload?.records) ? payload.records : [];
}

/**
 * Every open booking modal, paired with the booking it is showing.
 *
 * This used to guess, by scoring each Optix record against the modal's
 * rendered text: +8 if the record's client name appeared anywhere in it. An
 * inbound Optix booking under the one-word client name "Hale" therefore
 * matched every card in the calendar, because they all carry the coach's name
 * — Sam Hale. Every Clarity booking Sam made himself was stamped OPTIX and
 * given an "External booking" card belonging to someone else's lesson.
 *
 * The modal now carries the booking id it is rendering (App.tsx), so there is
 * nothing left to guess. A card without one is skipped rather than matched
 * approximately.
 */
function openBookingCards() {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-calendar-item-id]")).flatMap(
    (node) => {
      const id = String(node.dataset.calendarItemId || "").trim();
      return id ? [{ node, id }] : [];
    },
  );
}

/** Strip every trace of a previous booking's Optix decoration from this modal. */
function undecorate(node: HTMLElement) {
  delete node.dataset.optixOrigin;
  node.querySelector(".optix-origin-badge")?.remove();
  node.querySelector(".optix-origin-card")?.remove();
}

function decorate(node: HTMLElement, record: OptixOriginRecord) {
  // React reuses this modal for whichever booking is open, so a decoration
  // left over from the last one has to be cleared before the new one goes in
  // — otherwise the badge and card from the previously viewed lesson simply
  // stay put. Cheap: at most one badge and one card per open modal.
  if (node.dataset.optixOrigin !== record.id) undecorate(node);
  node.dataset.optixOrigin = record.id;

  if (!node.querySelector(".optix-origin-badge")) {
    const heading =
      node.querySelector<HTMLElement>("h1,h2,h3,h4,h5,h6,strong") ||
      (node.firstElementChild as HTMLElement | null);
    heading?.insertAdjacentHTML(
      "beforeend",
      '<span class="optix-origin-badge">OPTIX</span>',
    );
  }
  if (
    !node.querySelector(".optix-origin-card") &&
    /booking records|resend confirmation|no email records/i.test(node.textContent || "")
  ) {
    const card = document.createElement("section");
    card.className = "optix-origin-card";
    // The old "Customer email" line printed external_sync_state — the same
    // value as Bay status, one line below it, under a label it has nothing to
    // do with. There is no email on this record (see optix-origin-status.mts,
    // which does not select one), so the line is gone rather than patched.
    card.innerHTML = `<strong>External booking · Optix</strong><div>Bay status: ${esc(record.external_sync_state === "bay_booked" ? "Bay booked" : "Bay assignment required")}</div><details><summary>Source details</summary><div>Inbound lesson booking ID: ${esc(record.external_booking_id)}</div><div>Outbound bay booking is shown separately under Resource booking.</div></details>`;
    node.appendChild(card);
  }
  // This is a standard editable Clarity appointment. In particular, keep the
  // existing Book resource panel and action available for manual bay booking.
}

async function refresh() {
  const cards = openBookingCards();
  if (!cards.length) return;
  const records = await loadRecords();
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const { node, id } of cards) {
    const record = byId.get(id);
    // No record for this booking means Clarity owns it. Strip anything a
    // previous card left behind — the panel is injected into a modal React
    // reuses between bookings, so "render nothing" is not enough on its own.
    if (!record) {
      undecorate(node);
      continue;
    }
    decorate(node, record);
  }
}

export function installOptixOriginFeedback() {
  if (typeof window === "undefined") return;
  installStyles();
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      void refresh();
    });
  };
  new MutationObserver(schedule).observe(document.body, {
    childList: true,
    subtree: true,
  });
  schedule();
}
