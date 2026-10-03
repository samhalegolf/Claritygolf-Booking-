import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_BUSINESS_TERMINOLOGY, terminologyPreset } from "./business-terminology.mts";
import {
  BUSINESS_TERMINOLOGY_PRESETS,
} from "./business-terminology.mts";
import {
  CAPABILITY_KEYS,
  MARKET_PROFILES,
  applyCustomPreset,
  applyMarketProfile,
  capabilitiesFor,
  capabilityLeakSignatures,
  cleanCustomPresets,
  cleanMarketConfig,
  expectedTermFor,
  findTerms,
  forbiddenTermsFor,
  initialMarketConfig,
  marketConfigFromSettings,
  marketConfigSettingsRows,
  marketProfileForEntryPath,
  overridesFor,
  resolveMarket,
  termMatcher,
  upsertCustomPreset,
} from "./market-profile.mts";
import { coachAccountFromSettings, cleanCoachAccount } from "./coach-account.mts";
import { publicCoachAccount } from "./public-account.mts";

test("an account with no market rows resolves to today's golf behaviour", () => {
  const config = marketConfigFromSettings({});
  assert.deepEqual(config, { profileId: "golf", capabilityOverrides: {} });
  const market = resolveMarket(config);
  assert.equal(market.product.name, "Clarity Golf");
  assert.deepEqual(market.terminology, DEFAULT_BUSINESS_TERMINOLOGY);
  // Every module a golf business sees today stays on.
  for (const key of CAPABILITY_KEYS) {
    if (key === "clinicalRecords") continue;
    assert.equal(market.capabilities[key], true, `${key} should stay on for golf`);
  }
  assert.equal(market.capabilities.clinicalRecords, false);
});

test("the original workspace's coach account keeps golf words and capabilities", () => {
  const account = coachAccountFromSettings({}, "");
  assert.deepEqual(account.market, { profileId: "golf", capabilityOverrides: {} });
  assert.equal(account.terminology.staffSingular, "Coach");
  assert.equal(account.terminology.resourceSingular, "Bay");
});

test("every built-in profile is backed by a terminology preset -- one preset system", () => {
  const presetIds = new Set(BUSINESS_TERMINOLOGY_PRESETS.map((preset) => preset.id));
  for (const profile of MARKET_PROFILES) {
    assert.ok(presetIds.has(profile.id), `${profile.id} has no terminology preset`);
    assert.deepEqual(profile.terminology, BUSINESS_TERMINOLOGY_PRESETS.find((p) => p.id === profile.id)?.terminology);
  }
});

test("Hair & Beauty becomes Stylist / Client / Service / Chair with golf modules off", () => {
  const { config, terminology } = applyMarketProfile("hair-beauty");
  const market = resolveMarket(config, terminology);
  assert.equal(market.terminology.staffSingular, "Stylist");
  assert.equal(market.terminology.customerSingular, "Client");
  assert.equal(market.terminology.serviceSingular, "Service");
  assert.equal(market.terminology.resourceSingular, "Chair");
  assert.equal(market.product.name, "Clarity Booking");
  for (const key of ["videoAnalysis", "swingReview", "handedness", "puttingLab", "caddy", "optix", "practice"] as const) {
    assert.equal(market.capabilities[key], false, `${key} should be off for hair`);
  }
  for (const key of ["calendar", "publicBooking", "resources", "billing", "products", "passes", "portal"] as const) {
    assert.equal(market.capabilities[key], true, `${key} should be on for hair`);
  }
});

test("a preset is a default, not a lock: Hair can switch Video Analysis on", () => {
  const config = cleanMarketConfig({ profileId: "hair-beauty", capabilityOverrides: { videoAnalysis: true } });
  assert.deepEqual(config.capabilityOverrides, { videoAnalysis: true });
  const capabilities = capabilitiesFor(config);
  assert.equal(capabilities.videoAnalysis, true);
  // Everything else is still the Hair default.
  assert.equal(capabilities.caddy, false);
  assert.equal(capabilities.swingReview, false);
});

test("Coaching has video on and swing review off, each independently switchable", () => {
  const coaching = capabilitiesFor({ profileId: "coaching" });
  assert.equal(coaching.videoAnalysis, true);
  assert.equal(coaching.swingReview, false);
  assert.equal(coaching.practice, true);
  const noVideo = capabilitiesFor({ profileId: "coaching", capabilityOverrides: { videoAnalysis: false } });
  assert.equal(noVideo.videoAnalysis, false);
  assert.equal(noVideo.practice, true);
});

test("Physio uses the shared practice engine under its own words, and is not a clinical system", () => {
  const market = resolveMarket({ profileId: "physio" });
  assert.equal(market.capabilities.practice, true);
  assert.equal(market.terminology.assignmentPlural, "Exercises");
  assert.equal(market.terminology.customerSingular, "Patient");
  assert.equal(market.capabilities.clinicalRecords, false);
  // Even an explicit save cannot switch a reserved capability on.
  assert.equal(capabilitiesFor({ profileId: "physio", capabilityOverrides: { clinicalRecords: true } }).clinicalRecords, false);
  assert.equal(market.legalMode, "standard");
});

test("overrides that restate the profile default are not stored", () => {
  assert.deepEqual(overridesFor("hair-beauty", { videoAnalysis: false, caddy: false, resources: true }), {});
  assert.deepEqual(
    cleanMarketConfig({ profileId: "golf", capabilityOverrides: { caddy: true, puttingLab: false, bogus: true } }),
    { profileId: "golf", capabilityOverrides: { puttingLab: false } },
  );
});

test("market config round-trips through its settings rows", () => {
  const config = { profileId: "hair-beauty" as const, capabilityOverrides: { videoAnalysis: true } };
  const rows = marketConfigSettingsRows(config);
  assert.deepEqual(rows, {
    accountMarketProfile: "hair-beauty",
    accountMarketCapabilitiesJson: '{"videoAnalysis":true}',
  });
  assert.deepEqual(marketConfigFromSettings(rows), config);
  // An unknown profile or corrupt JSON falls back to golf rather than throwing.
  assert.deepEqual(marketConfigFromSettings({ accountMarketProfile: "plumbing", accountMarketCapabilitiesJson: "{" }), {
    profileId: "golf",
    capabilityOverrides: {},
  });
});

test("custom terminology overrides the profile's words and survives resolution", () => {
  const market = resolveMarket({ profileId: "personal-training" }, { staffSingular: "Coach", staffPlural: "Coaches" });
  assert.equal(market.terminology.staffSingular, "Coach");
  assert.equal(market.terminology.customerSingular, "Client");
  assert.equal(market.terminology.resourceSingular, "Studio");
});

test("the coach account carries the market config and fills words from the profile", () => {
  const account = coachAccountFromSettings(
    {
      accountId: "studio-27",
      accountMarketProfile: "hair-beauty",
      accountMarketCapabilitiesJson: '{"videoAnalysis":true}',
      // Saved before resources had a name: six words only.
      accountTerminologyJson: JSON.stringify({ staffSingular: "Barber", staffPlural: "Barbers" }),
    },
    "studio-27",
  );
  assert.deepEqual(account.market, { profileId: "hair-beauty", capabilityOverrides: { videoAnalysis: true } });
  assert.equal(account.terminology.staffSingular, "Barber");
  assert.equal(account.terminology.customerSingular, "Client");
  assert.equal(account.terminology.resourceSingular, "Chair");
});

test("saving the coach account does not lose the market config it was read with", () => {
  const read = coachAccountFromSettings({ accountId: "studio-27", accountMarketProfile: "massage" }, "studio-27");
  const saved = cleanCoachAccount({ ...read, businessName: "Studio 27" });
  assert.equal(saved.market.profileId, "massage");
  assert.equal(saved.terminology.staffSingular, "Therapist");
});

test("the public booking account receives the business's words and capabilities, nothing private", () => {
  const account = coachAccountFromSettings(
    { accountId: "studio-27", accountMarketProfile: "hair-beauty" },
    "studio-27",
  );
  const pub = publicCoachAccount(account);
  assert.equal(pub.terminology.staffSingular, "Stylist");
  assert.equal(pub.market.capabilities.videoAnalysis, false);
  assert.equal(pub.market.product.name, "Clarity Booking");
  assert.equal("bankAccount" in (pub.invoiceSettings as object), false);
});

test("two accounts resolve independently -- no state leaks between them", () => {
  const hair = coachAccountFromSettings({ accountId: "a", accountMarketProfile: "hair-beauty" }, "a");
  const golf = coachAccountFromSettings({ accountId: "b" }, "b");
  assert.equal(capabilitiesFor(hair.market).videoAnalysis, false);
  assert.equal(capabilitiesFor(golf.market).videoAnalysis, true);
  // Resolving one never mutates the shared profile defaults the other reads.
  capabilitiesFor(hair.market).caddy = true;
  assert.equal(capabilitiesFor({ profileId: "hair-beauty" }).caddy, false);
});

test("entry routes pick a starting profile, but never override a saved account", () => {
  assert.equal(marketProfileForEntryPath("/hair"), "hair-beauty");
  assert.equal(marketProfileForEntryPath("/physio/signup?x=1"), "physio");
  assert.equal(marketProfileForEntryPath("/personal-training"), "personal-training");
  assert.equal(marketProfileForEntryPath("/pricing"), null);
  assert.deepEqual(initialMarketConfig(null, "/hair"), { profileId: "hair-beauty", capabilityOverrides: {} });
  // A salon that turned video on, opening the /coaching URL later, stays itself.
  const saved = { profileId: "hair-beauty" as const, capabilityOverrides: { videoAnalysis: true } };
  assert.deepEqual(initialMarketConfig(saved, "/coaching"), saved);
  assert.deepEqual(initialMarketConfig(null, "/"), { profileId: "golf", capabilityOverrides: {} });
});

test("custom presets save, load, update by name, and reapply exactly", () => {
  const draft = {
    name: "Hair Video Consultation",
    baseProfileId: "hair-beauty",
    terminology: terminologyPreset("hair-beauty"),
    capabilities: { ...capabilitiesFor({ profileId: "hair-beauty" }), videoAnalysis: true },
  };
  const saved = upsertCustomPreset([], draft);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, "hair-video-consultation");
  assert.equal(saved[0].visibility, "sandbox");

  // Load: the stored JSON comes back as the same preset.
  const loaded = cleanCustomPresets(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(loaded, saved);

  // Same name again updates rather than duplicating.
  const updated = upsertCustomPreset(loaded, { ...draft, capabilities: { ...draft.capabilities, passes: false } });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].capabilities.passes, false);
  assert.equal(updated[0].createdAt, saved[0].createdAt);

  const { config, terminology } = applyCustomPreset(updated[0]);
  assert.deepEqual(config, { profileId: "hair-beauty", capabilityOverrides: { videoAnalysis: true, passes: false } });
  const market = resolveMarket(config, terminology);
  assert.equal(market.capabilities.videoAnalysis, true);
  assert.equal(market.terminology.staffSingular, "Stylist");
});

test("custom presets reject junk and cannot carry a reserved capability", () => {
  assert.deepEqual(cleanCustomPresets([null, { name: "" }, { name: "<script>" }]).map((p) => p.name), ["script"]);
  const [preset] = cleanCustomPresets([{ name: "Clinic", baseProfileId: "physio", capabilities: { clinicalRecords: true } }]);
  assert.equal(preset.capabilities.clinicalRecords, false);
});

test("leak detection flags golf words for Hair, but not words the business chose", () => {
  const hair = resolveMarket({ profileId: "hair-beauty" });
  const matcher = termMatcher(forbiddenTermsFor(hair));
  assert.deepEqual(findTerms("Book next lesson with your coach", matcher), ["lesson", "coach"]);
  assert.deepEqual(findTerms("Coaching session", matcher), []);
  assert.deepEqual(findTerms("Bayside salon", matcher), []);
  assert.equal(expectedTermFor("lesson", hair.terminology), "Service");

  // A salon that renamed Stylist to Coach is not leaking "Coach".
  const renamed = resolveMarket({ profileId: "hair-beauty" }, { staffSingular: "Coach", staffPlural: "Coaches" });
  assert.deepEqual(findTerms("Your coach", termMatcher(forbiddenTermsFor(renamed))), []);

  // Golf forbids nothing.
  assert.equal(termMatcher(forbiddenTermsFor(resolveMarket(null))), null);
});

test("capability leak signatures list only what is switched off", () => {
  const hair = capabilitiesFor({ profileId: "hair-beauty" });
  const keys = new Set(capabilityLeakSignatures(hair).map((signature) => signature.key));
  assert.ok(keys.has("videoAnalysis"));
  assert.ok(keys.has("caddy"));
  assert.equal(capabilityLeakSignatures(capabilitiesFor(null)).length, 0);
});
