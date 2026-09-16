import assert from "node:assert/strict";
import test from "node:test";

import { currencyForAccountSettings } from "./locale.mts";

test("the currency explicitly selected by the account wins", () => {
  assert.equal(currencyForAccountSettings("aud", "NZ"), "AUD");
});

test("the selected country supplies currency when none was chosen", () => {
  assert.equal(currencyForAccountSettings("", "GB"), "GBP");
  assert.equal(currencyForAccountSettings(undefined, "AU"), "AUD");
});

test("an invalid currency selection cannot escape the country fallback", () => {
  assert.equal(currencyForAccountSettings("dollars", "US"), "USD");
});
