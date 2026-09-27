import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultTimeZoneForCountry,
  regionDefaultsForCountry,
  taxDefaultsForCountry,
  timeZoneForCountryChange,
  timeZoneOffsetLabel,
  timeZonesForCountry,
} from "./region.mts";

test("each country names its own tax", () => {
  assert.deepEqual(taxDefaultsForCountry("NZ"), { taxName: "GST", taxRate: 15, taxInclusive: true });
  assert.deepEqual(taxDefaultsForCountry("GB"), { taxName: "VAT", taxRate: 20, taxInclusive: true });
  assert.deepEqual(taxDefaultsForCountry("US"), { taxName: "Sales tax", taxRate: 0, taxInclusive: false });
});

test("a country with no tax entry charges nothing rather than New Zealand GST", () => {
  assert.deepEqual(taxDefaultsForCountry("IS"), { taxName: "Tax", taxRate: 0, taxInclusive: false });
});

test("a multi-zone country starts on its main city, not the first line of zone.tab", () => {
  assert.equal(defaultTimeZoneForCountry("AU"), "Australia/Sydney");
  assert.equal(defaultTimeZoneForCountry("CA"), "America/Toronto");
  assert.equal(defaultTimeZoneForCountry("NZ"), "Pacific/Auckland");
  assert.equal(defaultTimeZoneForCountry("GB"), "Europe/London");
});

test("only the chosen country's zones are offered", () => {
  const zones = timeZonesForCountry("NZ").map((option) => option.zone);
  assert.deepEqual(zones, ["Pacific/Auckland", "Pacific/Chatham"]);
  assert.equal(timeZonesForCountry("GB")[0].label, "London");
  assert.match(timeZonesForCountry("NZ")[0].label, /^Auckland — /);
});

test("changing country keeps a zone that still fits and replaces one that does not", () => {
  assert.equal(timeZoneForCountryChange("AU", "Australia/Perth"), "Australia/Perth");
  assert.equal(timeZoneForCountryChange("AU", "Pacific/Auckland"), "Australia/Sydney");
});

test("choosing a country fills in currency, zone and tax together", () => {
  assert.deepEqual(regionDefaultsForCountry("GB", "Pacific/Auckland"), {
    currency: "GBP",
    timezone: "Europe/London",
    taxName: "VAT",
    taxRate: 20,
    taxInclusive: true,
  });
});

test("offsets read as UTC, including UTC itself", () => {
  const winter = new Date("2026-01-15T00:00:00Z");
  assert.equal(timeZoneOffsetLabel("Pacific/Auckland", winter), "UTC+13:00");
  assert.equal(timeZoneOffsetLabel("Europe/London", winter), "UTC+00:00");
  assert.equal(timeZoneOffsetLabel("Not/AZone", winter), "");
});
