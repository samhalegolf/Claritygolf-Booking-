(() => {
  const PANEL_ID = "clarity-notification-subject-panel";
  const STYLE_ID = "clarity-notification-subject-style";
  const DEFAULT_SUBJECT = "{{service}} with {{coach}} - {{date}} at {{time}}";

  const params = new URLSearchParams(window.location.search);
  if (params.get("embed") === "booking" || window.location.hostname === "book.claritygolf.app") return;

  function cleanSubject(value) {
    return typeof value === "string" ? value.trim().slice(0, 180) : "";
  }

  function addStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .notification-subject-settings {
        display: grid;
        gap: 14px;
        padding: 16px 0 4px;
      }
      .notification-subject-row {
        display: grid;
        gap: 8px;
      }
      .notification-subject-row span,
      .notification-subject-tokens span {
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        opacity: 0.7;
      }
      .notification-subject-row input {
        width: min(620px, 100%);
        border-radius: 12px;
        border: 1px solid rgba(120, 140, 120, 0.35);
        background: rgba(255, 255, 255, 0.08);
        color: inherit;
        font: inherit;
        padding: 11px 12px;
      }
      .notification-subject-help,
      .notification-subject-preview {
        margin: 0;
        opacity: 0.72;
        line-height: 1.45;
      }
      .notification-subject-preview strong {
        opacity: 1;
      }
      .notification-subject-tokens {
        display: grid;
        gap: 8px;
      }
      .notification-subject-token-list {
        display: flex;
        flex-wrap: wrap;
        gap: 7px;
      }
      .notification-subject-token-list button {
        border: 1px solid rgba(120, 140, 120, 0.35);
        background: rgba(255, 255, 255, 0.06);
        color: inherit;
        border-radius: 999px;
        cursor: pointer;
        padding: 7px 10px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.78rem;
      }
      .notification-subject-actions {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 10px;
      }
      .notification-subject-status {
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

  async function saveSubject(subject) {
    const response = await fetch("/api/admin-settings", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ notificationSubjectLine: cleanSubject(subject) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "Could not save notification subject line.");
    return data;
  }

  function renderPreview(template) {
    const source = cleanSubject(template) || "Current per-notification defaults";
    if (!cleanSubject(template)) return source;
    return source
      .replaceAll("{{service}}", "1 Hour Golf Lesson")
      .replaceAll("{{coach}}", "Sam Hale")
      .replaceAll("{{business}}", "Sam Hale Golf")
      .replaceAll("{{client}}", "Donna Steele")
      .replaceAll("{{firstName}}", "Donna")
      .replaceAll("{{date}}", "Thursday, Jun 4, 2026")
      .replaceAll("{{time}}", "2:00 PM-3:00 PM")
      .replaceAll("{{venue}}", "The Range 24/7 - Three Kings")
      .replaceAll("{{action}}", "booking");
  }

  function insertAtCursor(input, token) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = `${input.value.slice(0, start)}${token}${input.value.slice(end)}`;
    const nextCursor = start + token.length;
    input.focus();
    input.setSelectionRange(nextCursor, nextCursor);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function createPanel(settings) {
    const initialSubject = cleanSubject(settings?.notificationSubjectLine);
    const panel = document.createElement("details");
    panel.id = PANEL_ID;
    panel.className = "settings-subsection";
    panel.open = true;
    panel.innerHTML = `
      <summary class="settings-subsection-title">
        <span aria-hidden="true">✉️</span>
        <div>
          <span>Email subject</span>
          <strong data-summary>${initialSubject ? "Shared subject active" : "Using notification defaults"}</strong>
        </div>
      </summary>
      <div class="notification-subject-settings">
        <label class="notification-subject-row">
          <span>Subject line for all email notifications</span>
          <input data-subject type="text" maxlength="180" placeholder="${DEFAULT_SUBJECT}" value="${initialSubject.replaceAll("&", "&amp;").replaceAll("\"", "&quot;")}" />
        </label>
        <p class="notification-subject-help">
          This optional subject overrides booking, reschedule, cancellation, update, reminder, coach, admin, and client email subjects. Leave it blank to keep the existing per-notification defaults.
        </p>
        <p class="notification-subject-preview">Preview: <strong data-preview>${renderPreview(initialSubject)}</strong></p>
        <div class="notification-subject-tokens">
          <span>Insert tokens</span>
          <div class="notification-subject-token-list">
            <button type="button" data-token="{{service}}">{{service}}</button>
            <button type="button" data-token="{{coach}}">{{coach}}</button>
            <button type="button" data-token="{{client}}">{{client}}</button>
            <button type="button" data-token="{{date}}">{{date}}</button>
            <button type="button" data-token="{{time}}">{{time}}</button>
            <button type="button" data-token="{{action}}">{{action}}</button>
          </div>
        </div>
        <div class="notification-subject-actions">
          <button class="outline-button" data-save type="button">Save subject line</button>
          <button class="outline-button" data-clear type="button">Clear override</button>
          <span class="notification-subject-status" data-status></span>
        </div>
      </div>
    `;

    const input = panel.querySelector("[data-subject]");
    const preview = panel.querySelector("[data-preview]");
    const summary = panel.querySelector("[data-summary]");
    const status = panel.querySelector("[data-status]");
    const save = panel.querySelector("[data-save]");
    const clear = panel.querySelector("[data-clear]");

    function refresh() {
      const subject = cleanSubject(input.value);
      preview.textContent = renderPreview(subject);
      summary.textContent = subject ? "Shared subject active" : "Using notification defaults";
      status.textContent = "";
    }

    input.addEventListener("input", refresh);
    panel.querySelectorAll("[data-token]").forEach((button) => {
      button.addEventListener("click", () => insertAtCursor(input, button.dataset.token || ""));
    });

    save.addEventListener("click", async () => {
      save.disabled = true;
      status.textContent = "Saving…";
      try {
        const saved = await saveSubject(input.value);
        input.value = cleanSubject(saved.notificationSubjectLine ?? input.value);
        refresh();
        status.textContent = "Saved.";
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "Could not save.";
      } finally {
        save.disabled = false;
      }
    });

    clear.addEventListener("click", async () => {
      input.value = "";
      refresh();
      save.click();
    });

    return panel;
  }

  function findSettingsTarget() {
    const candidates = Array.from(document.querySelectorAll("article, section, .data-card, .settings-section"));
    return (
      candidates.find((element) => /email|notification/i.test(element.textContent || "")) ||
      candidates.find((element) => /settings/i.test(element.className || "")) ||
      document.querySelector("main")
    );
  }

  async function insertPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const target = findSettingsTarget();
    if (!target) return;

    const settings = await readSettings().catch(() => null);
    if (!settings) return;

    addStyle();
    const panel = createPanel(settings);
    const firstDetails = target.querySelector?.("details.settings-subsection");
    if (firstDetails?.nextSibling) {
      target.insertBefore(panel, firstDetails.nextSibling);
    } else {
      target.appendChild(panel);
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
