import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { coachAccountFromSettings } from "./coach-account.mts";

const here = dirname(fileURLToPath(import.meta.url));

// A US business's calendar loaded showing New Zealand, NZD and GST: the
// calendar shell built its own account without country or invoice settings,
// and the browser filled the gaps with defaults.
test("the account carries the business's own country, currency and tax", () => {
  const account = coachAccountFromSettings(
    {
      accountId: "us-business",
      accountCountry: "US",
      accountTimezone: "America/New_York",
      accountInvoiceSettingsJson: JSON.stringify({
        currency: "USD",
        taxName: "Sales tax",
        taxRate: 10,
        taxInclusive: false,
      }),
    },
    "us-business",
  );
  assert.equal(account.country, "US");
  assert.equal(account.timezone, "America/New_York");
  assert.equal(account.invoiceSettings.currency, "USD");
  assert.equal(account.invoiceSettings.taxName, "Sales tax");
  assert.equal(account.invoiceSettings.taxRate, 10);
  assert.equal(account.invoiceSettings.taxInclusive, false);
});

test("the calendar shell builds its state from the shared modules", () => {
  // The shell answers every calendar load. It used to carry its own copies of
  // the visibility filter, the booking row reader and the settings cleaners,
  // and they drifted from the ones booking-core uses: a business with no
  // lesson types was shown the original workspace's, and availability saved
  // before accountId was stamped vanished on load.
  const source = readFileSync(join(here, "../calendar-state.mts"), "utf8");
  for (const name of [
    "filterCalendarStateForContext",
    "rowToItem",
    "readItems",
    "normalizeServices",
    "normalizeAvailability",
    "normalizeCoachProfiles",
    "normalizeLocations",
    "adminSettingsFromSettings",
    "brandSettingsFromSettings",
    "coachAccountFromSettings",
  ]) {
    assert.doesNotMatch(source, new RegExp(`^\\s*(export\\s+)?(async\\s+)?function ${name}\\b`, "m"), `calendar-state defines its own ${name}`);
  }
  assert.doesNotMatch(source, /^const default(Services|Availability)\b/m, "calendar-state keeps its own defaults");
  assert.match(source, /from "\.\/_shared\/workspace-state\.mts"/);
  assert.match(source, /from "\.\/_shared\/bookings\.mts"/);
});

test("booking-core builds the account from the one shared copy", () => {
  const source = readFileSync(join(here, "../booking-core.mts"), "utf8");
  assert.doesNotMatch(source, /^\s*(export\s+)?function coachAccountFromSettings\b/m, "booking-core defines its own account builder");
  assert.match(source, /from "\.\/_shared\/coach-account\.mts"/, "booking-core does not use the shared account builder");
});
