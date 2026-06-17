import { readFileSync, writeFileSync } from "node:fs";

const appPath = new URL("../src/App.tsx", import.meta.url);
let source = readFileSync(appPath, "utf8");
let changed = false;

function replaceOnce(label, before, after) {
  if (source.includes(after)) return;
  if (!source.includes(before)) {
    console.warn(`[booking-ui-updates] skipped ${label}: target not found`);
    return;
  }
  source = source.replace(before, after);
  changed = true;
  console.log(`[booking-ui-updates] applied ${label}`);
}

function replaceAll(label, before, after) {
  if (!source.includes(before)) return;
  source = source.split(before).join(after);
  changed = true;
  console.log(`[booking-ui-updates] applied ${label}`);
}

replaceOnce(
  "coach account live editing",
  '    setCoachAccount((current) => cleanCoachAccount({ ...current, [field]: value }));',
  '    setCoachAccount((current) => ({ ...current, [field]: value }));',
);

const dayButtonsBefore = `            {weekDays.map((day, index) => (
              <button
                className={bookingDay === index ? "selected-day" : ""}
                key={day.label}
                onClick={() => {
                  setBookingDay(index);
                  setBookingStart(null);
                }}
              >
                <strong>{day.short}</strong>
                <em>{day.date}</em>
              </button>
            ))}`;

const dayButtonsAfter = `            {weekDays.map((day, index) =>
              bookingStart !== null && bookingDay !== index ? null : (
              <button
                className={bookingDay === index ? "selected-day" : ""}
                key={day.label}
                onClick={() => {
                  setBookingDay(index);
                  setBookingStart(null);
                }}
              >
                <strong>{day.short}</strong>
                <em>{day.date}</em>
              </button>
              ),
            )}`;

replaceOnce("date card hides unselected days in preview", dayButtonsBefore, dayButtonsAfter);

const publicDayButtonsBefore = `                  {weekDays.map((day, index) => (
                    <button
                      className={bookingDay === index ? "selected-day" : ""}
                      key={day.label}
                      onClick={() => {
                        setBookingDay(index);
                        setBookingStart(null);
                      }}
                    >
                      <strong>{day.short}</strong>
                      <em>{day.date}</em>
                    </button>
                  ))}`;

const publicDayButtonsAfter = `                  {weekDays.map((day, index) =>
                    bookingStart !== null && bookingDay !== index ? null : (
                    <button
                      className={bookingDay === index ? "selected-day" : ""}
                      key={day.label}
                      onClick={() => {
                        setBookingDay(index);
                        setBookingStart(null);
                      }}
                    >
                      <strong>{day.short}</strong>
                      <em>{day.date}</em>
                    </button>
                    ),
                  )}`;

replaceOnce("date card hides unselected days on public booking", publicDayButtonsBefore, publicDayButtonsAfter);

const weekControlsBefore = `                <div className="booking-week-controls">
                  <button onClick={() => moveWeek(-1)} type="button">
                    <ArrowLeft size={15} />
                    <span>Previous week</span>
                  </button>
                  <strong>{weekTitle}</strong>
                  <button onClick={() => moveWeek(1)} type="button">
                    <span>Next week</span>
                    <ArrowRight size={15} />
                  </button>
                </div>`;

const weekControlsAfter = `                {bookingStart === null && (
                <div className="booking-week-controls">
                  <button onClick={() => moveWeek(-1)} type="button">
                    <ArrowLeft size={15} />
                    <span>Previous week</span>
                  </button>
                  <strong>{weekTitle}</strong>
                  <button onClick={() => moveWeek(1)} type="button">
                    <span>Next week</span>
                    <ArrowRight size={15} />
                  </button>
                </div>
                )}`;

replaceOnce("date card hides week controls after selection", weekControlsBefore, weekControlsAfter);

replaceAll(
  "remove duplicated booking preview settings panel",
  `              {servicesSettingsPanel}
              {availabilitySettingsPanel}
              {bookingSettingsPanel}`,
  `              {servicesSettingsPanel}
              {availabilitySettingsPanel}`,
);

replaceOnce(
  "move connected app settings under admin label",
  `                      <div>
                        <span>Connected apps</span>
                        <strong>Booking and Caddy</strong>
                      </div>`,
  `                      <div>
                        <span>Admin</span>
                        <strong>Booking links and workspace</strong>
                      </div>`,
);

const duplicateBookingTheme = `                <details className="settings-subsection">
                  <summary className="settings-subsection-title">
                    <Eye size={18} />
                    <div>
                      <span>Booking surface</span>
                      <strong>{brandSettings.bookingTheme === "dark" ? "Dark branded cards" : "Light branded cards"}</strong>
                    </div>
                  </summary>
                  <div className="booking-surface-setting">
                    <div>
                      <span>Booking surface</span>
                      <strong>{brandSettings.bookingTheme === "dark" ? "Dark branded cards" : "Light branded cards"}</strong>
                    </div>
                    <button
                      aria-label={\`Switch booking cards to \${brandSettings.bookingTheme === "dark" ? "light" : "dark"}\`}
                      aria-pressed={brandSettings.bookingTheme === "dark"}
                      className={\`theme-switch theme-toggle \${brandSettings.bookingTheme === "dark" ? "is-dark" : "is-light"}\`}
                      data-testid="booking-theme-switch"
                      onClick={() => setBookingCardTheme(brandSettings.bookingTheme === "dark" ? "light" : "dark")}
                      type="button"
                    >
                      <span className={brandSettings.bookingTheme === "light" ? "active" : ""} aria-hidden="true">
                        <Sun size={15} />
                      </span>
                      <span className={brandSettings.bookingTheme === "dark" ? "active" : ""} aria-hidden="true">
                        <Moon size={15} />
                      </span>
                    </button>
                  </div>
                </details>`;

if (source.includes(duplicateBookingTheme)) {
  source = source.replace(duplicateBookingTheme, "");
  changed = true;
  console.log("[booking-ui-updates] removed duplicate booking theme control");
}

const publicThemeControl = `

                <details className="settings-subsection">
                  <summary className="settings-subsection-title">
                    <Eye size={18} />
                    <div>
                      <span>Public card theme</span>
                      <strong>{brandSettings.bookingTheme === "dark" ? "Dark branded cards" : "Light branded cards"}</strong>
                    </div>
                  </summary>
                  <div className="booking-surface-setting">
                    <div>
                      <span>Public booking cards</span>
                      <strong>{brandSettings.bookingTheme === "dark" ? "Dark branded cards" : "Light branded cards"}</strong>
                    </div>
                    <button
                      aria-label={\`Switch booking cards to \${brandSettings.bookingTheme === "dark" ? "light" : "dark"}\`}
                      aria-pressed={brandSettings.bookingTheme === "dark"}
                      className={\`theme-switch theme-toggle \${brandSettings.bookingTheme === "dark" ? "is-dark" : "is-light"}\`}
                      data-testid="booking-theme-switch"
                      onClick={() => setBookingCardTheme(brandSettings.bookingTheme === "dark" ? "light" : "dark")}
                      type="button"
                    >
                      <span className={brandSettings.bookingTheme === "light" ? "active" : ""} aria-hidden="true">
                        <Sun size={15} />
                      </span>
                      <span className={brandSettings.bookingTheme === "dark" ? "active" : ""} aria-hidden="true">
                        <Moon size={15} />
                      </span>
                    </button>
                  </div>
                </details>`;

if (!source.includes('data-testid="booking-theme-switch"')) {
  const importCardMarker = '              <article className="data-card import-card settings-section settings-data">';
  const brandCardMarker = '              <article className="data-card brand-vein-card settings-section settings-branding settings-experience">';
  const importIndex = source.indexOf(importCardMarker);
  const brandIndex = source.lastIndexOf(brandCardMarker, importIndex);
  const brandCloseIndex = source.indexOf('              </article>', brandIndex);
  if (importIndex !== -1 && brandIndex !== -1 && brandCloseIndex !== -1) {
    source = source.slice(0, brandCloseIndex) + publicThemeControl + source.slice(brandCloseIndex);
    changed = true;
    console.log("[booking-ui-updates] moved public card theme into coach branding");
  } else {
    console.warn("[booking-ui-updates] skipped public card theme move: brand card not found");
  }
}

if (changed) writeFileSync(appPath, source);
