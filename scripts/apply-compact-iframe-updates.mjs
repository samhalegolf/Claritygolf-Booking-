import { readFileSync, writeFileSync } from "node:fs";

const appPath = new URL("../src/App.tsx", import.meta.url);
let source = readFileSync(appPath, "utf8");
let changed = false;

function replaceOnce(label, before, after) {
  if (source.includes(after)) return;
  if (!source.includes(before)) {
    console.warn(`[compact-iframe-updates] skipped ${label}: target not found`);
    return;
  }
  source = source.replace(before, after);
  changed = true;
  console.log(`[compact-iframe-updates] applied ${label}`);
}

replaceOnce(
  "dynamic compact widget URL",
  '  const bookingWidgetUrl = useMemo(getBookingWidgetUrl, []);',
  `  const bookingWidgetUrl = useMemo(() => {
    const rawUrl = getBookingWidgetUrl();
    if (!rawUrl) return "";
    const url = new URL(rawUrl);
    url.searchParams.set("layout", "compact");
    url.searchParams.set("theme", brandSettings.bookingTheme);
    url.searchParams.set("v", calendarStateVersion || brandSettings.bookingTheme);
    return url.toString();
  }, [brandSettings.bookingTheme, calendarStateVersion]);`,
);

replaceOnce(
  "shorter iframe embed height",
  'height="760" style="border:0;max-width:100%;"',
  'height="520" style="border:0;max-width:100%;width:100%;"',
);

replaceOnce(
  "public theme save feedback",
  `                  <div className="booking-preview-mini">
                    <span>Customer booking card preview</span>`,
  `                  <div className="booking-theme-save-note" aria-live="polite">
                    {brandSaveState === "saving"
                      ? "Saving public card theme..."
                      : brandSaveState === "saved"
                      ? "Public card theme saved"
                      : "Theme changes save automatically"}
                  </div>
                  <div className="booking-preview-mini">
                    <span>Customer booking card preview</span>`,
);

if (changed) writeFileSync(appPath, source);
