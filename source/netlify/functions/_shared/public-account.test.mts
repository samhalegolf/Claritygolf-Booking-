import assert from "node:assert/strict";
import test from "node:test";

import { publicCoachAccount } from "./public-account.mts";

const account = {
  id: "acme-golf",
  coachName: "Coach",
  businessName: "Acme Golf",
  venueName: "Acme Range",
  venueShortName: "Acme",
  timezone: "Europe/London",
  country: "GB",
  contactEmail: "owner@example.com",
  bookingUrl: "https://book.example.com",
  calendarSlug: "acme-golf",
  caddyWorkspaceUrl: "https://caddy.example.com",
  invoiceSettings: {
    currency: "GBP",
    taxName: "VAT",
    taxRate: 20,
    taxInclusive: true,
    taxNumber: "GB123456789",
    bankAccount: "12-34-56 12345678",
    businessAddress: "1 High Street",
    footerText: "Thanks",
    paymentInstructions: "Pay by transfer",
    customFields: [{ id: "f", label: "Sort code", value: "12-34-56", placement: "footer" }],
  },
};

test("the booking page gets what a price needs and nothing private", () => {
  const shown = publicCoachAccount(account);
  assert.deepEqual(shown.invoiceSettings, { currency: "GBP", taxName: "VAT", taxRate: 20, taxInclusive: true });
  assert.equal(shown.businessName, "Acme Golf");
  assert.equal(shown.country, "GB");
  assert.equal(shown.terminology.staffSingular, "Coach");
  const text = JSON.stringify(shown);
  for (const secret of ["owner@example.com", "GB123456789", "12345678", "1 High Street", "Pay by transfer", "Sort code"]) {
    assert.ok(!text.includes(secret), `${secret} reached the public account`);
  }
});

test("a missing account still produces a well-formed public account", () => {
  assert.deepEqual(publicCoachAccount(undefined).invoiceSettings, {
    currency: undefined,
    taxName: undefined,
    taxRate: undefined,
    taxInclusive: undefined,
  });
});
