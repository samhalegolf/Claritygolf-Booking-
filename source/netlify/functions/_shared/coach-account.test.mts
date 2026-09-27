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

test("the calendar shell and booking-core build the account from the one shared copy", () => {
  for (const file of ["../calendar-state.mts", "../booking-core.mts"]) {
    const source = readFileSync(join(here, file), "utf8");
    assert.doesNotMatch(source, /^\s*(export\s+)?function coachAccountFromSettings\b/m, `${file} defines its own account builder`);
    assert.match(source, /from "\.\/_shared\/coach-account\.mts"/, `${file} does not use the shared account builder`);
  }
});
