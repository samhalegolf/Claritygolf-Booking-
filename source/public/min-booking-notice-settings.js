(() => {
  const DEFAULT_MINUTES = 240;
  const MAX_MINUTES = 7 * 24 * 60;
  const PANEL_ID = "clarity-min-booking-notice-panel";
  const STYLE_ID = "clarity-min-booking-notice-style";

  const params = new URLSearchParams(window.location.search);
  if (params.get("embed") === "booking" || window.location.hostname === "book.claritygolf.app") return;

  function cleanMinutes(value, fallback = DEFAULT_MINUTES) {
    const minutes = Number(value ?? fallback);
    return Number.isFinite(minutes) ? Math.max(0, Math.min(MAX_MINUTES, Math.round(minutes))) : fallback;
  }

  function minutesToHoursValue(minutes) {
    return String(Math.round((cleanMinutes(minutes) / 60) * 100) / 100);
  }

  function minutesLabel(minutes) {
    const clean = cleanMinutes(minutes);
    if (clean === 0) return "No buffer";
    if (clean % 60 === 0) {
      const hours = clean / 60;
      return `${hours} hour${hours === 1 ? "" : "s"}`;
    }
    return `${clean} minutes`;
  }

  function addStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .minimum-notice-settings {
        display: grid;
        gap: 14px;
        padding: 16px 0 4px;
      }
      .minimum-notice-row {
        display: grid;
        gap: 8px;
      }
      .minimum-notice-row span {
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        opacity: 0.7;
      }
      .minimum-notice-row input {
        width: min(220px, 100%);
        border-radius: 12px;
        border: 1px solid rgba(120, 140, 120, 0.35);
        background: rgba(255, 255, 255, 0.08);
        color: inherit;
        font: inherit;
        padding: 11px 12px;
      }
      .minimum-notice-help {
        margin: 0;
        opacity: 0.72;
        line-height: 1.45;
      }
      .minimum-notice-presets {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .minimum-notice-presets button {
        border: 1px solid rgba(120, 140, 120, 0.35);
        background: rgba(255, 255, 255, 0.06);
        color: inherit;
        border-radius: 999px;
        cursor: pointer;
        padding: 7px 10px;
      }
      .minimum-notice-actions {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 10px;
      }
      .minimum-notice-status {
        font-size: 0.85rem;
        opacity: 0.75;
      }
    `;
    document.head.appendChild(style);
  }

  async function readSettings() {
    const response = await fetch("/api/admin-settings", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    return response.json();
  }

  async function saveNotice(minutes) {
    const response = await fetch("/api/admin-settings", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ minBookingNoticeMinutes: cleanMinutes(minutes) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "Could not save booking notice buffer.");
    return data;
  }

  function createPanel(settings) {
    const initialMinutes = cleanMinutes(settings?.minBookingNoticeMinutes);
    const panel = document.createElement("details");
    panel.id = PANEL_ID;
    panel.className = "settings-subsection";
    panel.innerHTML = `
      <summary class="settings-subsection-title">
        <span aria-hidden="true">⏱</span>
        <div>
          <span>Booking notice</span>
          <strong data-summary>${minutesLabel(initialMinutes)} minimum notice</strong>
        </div>
      </summary>
      <div class="minimum-notice-settings">
        <label class="minimum-notice-row">
          <span>Minimum notice before a public booking</span>
          <input data-hours type="number" min="0" max="168" step="0.25" inputmode="decimal" value="${minutesToHoursValue(initialMinutes)}" />
        </label>
        <p class="minimum-notice-help">
          Enter hours. Example: <strong>4</strong> means clients can only book or reschedule times that start at least 4 hours from now.
        </p>
        <div class="minimum-notice-presets" aria-label="Quick notice presets">
          <button type="button" data-preset="0">No buffer</button>
          <button type="button" data-preset="60">1 hour</button>
          <button type="button" data-preset="120">2 hours</button>
          <button type="button" data-preset="240">4 hours</button>
          <button type="button" data-preset="1440">24 hours</button>
        </div>
        <div class="minimum-notice-actions">
          <button class="outline-button" data-save type="button">Save notice buffer</button>
          <span class="minimum-notice-status" data-status></span>
        </div>
      </div>
    `;

    const input = panel.querySelector("[data-hours]");
    const summary = panel.querySelector("[data-summary]");
    const status = panel.querySelector("[data-status]");
    const save = panel.querySelector("[data-save]");

    function inputMinutes() {
      return cleanMinutes(Number(input.value) * 60);
    }

    function refreshSummary() {
      summary.textContent = `${minutesLabel(inputMinutes())} minimum notice`;
      status.textContent = "";
    }

    input.addEventListener("input", refreshSummary);
    panel.querySelectorAll("[data-preset]").forEach((button) => {
      button.addEventListener("click", () => {
        input.value = minutesToHoursValue(Number(button.dataset.preset));
        refreshSummary();
      });
    });

    save.addEventListener("click", async () => {
      const minutes = inputMinutes();
      save.disabled = true;
      status.textContent = "Saving…";
      try {
        const saved = await saveNotice(minutes);
        const savedMinutes = cleanMinutes(saved.minBookingNoticeMinutes ?? minutes);
        input.value = minutesToHoursValue(savedMinutes);
        summary.textContent = `${minutesLabel(savedMinutes)} minimum notice`;
        status.textContent = "Saved.";
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "Could not save.";
      } finally {
        save.disabled = false;
      }
    });

    return panel;
  }

  async function insertPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const bookingSettings = document.querySelector(".booking-page-settings");
    if (!bookingSettings) return;

    const settings = await readSettings().catch(() => null);
    if (!settings) return;

    addStyle();
    const panel = createPanel(settings);
    const previewSection = bookingSettings.querySelector("details.settings-subsection");
    if (previewSection?.nextSibling) {
      bookingSettings.insertBefore(panel, previewSection.nextSibling);
    } else {
      bookingSettings.appendChild(panel);
    }
  }

  const observer = new MutationObserver(() => {
    void insertPanel();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("focus", () => void insertPanel());
  window.setTimeout(() => void insertPanel(), 800);
  window.setTimeout(() => void insertPanel(), 1800);
})();
