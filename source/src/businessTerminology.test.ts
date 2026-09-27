import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_BUSINESS_TERMINOLOGY,
  matchingTerminologyPreset,
  terminologyFor,
  terminologyPreset,
} from "../netlify/functions/_shared/business-terminology.mts";

test("terminology keeps the existing golf words by default", () => {
  assert.deepEqual(terminologyFor(), DEFAULT_BUSINESS_TERMINOLOGY);
});

test("terminology resolves either an account or the terminology object itself", () => {
  const custom = {
    staffSingular: "Therapist",
    staffPlural: "Therapists",
    customerSingular: "Client",
    customerPlural: "Clients",
    serviceSingular: "Treatment",
    servicePlural: "Treatments",
  };
  assert.deepEqual(terminologyFor(custom), custom);
  assert.deepEqual(terminologyFor({ terminology: custom }), custom);
});

test("terminology sanitises saved values and fills missing fields", () => {
  assert.deepEqual(
    terminologyFor({
      terminology: {
        staffSingular: "  <Stylist>  ",
        staffPlural: "",
        customerSingular: "Client\u0000",
      },
    }),
    {
      staffSingular: "Stylist",
      staffPlural: "Coaches",
      customerSingular: "Client",
      customerPlural: "Players",
      serviceSingular: "Lesson",
      servicePlural: "Lessons",
    },
  );
});

test("presets populate values without introducing an application mode", () => {
  const physio = terminologyPreset("physio");
  assert.equal(physio.staffSingular, "Physiotherapist");
  assert.equal(physio.customerPlural, "Patients");
  assert.equal(physio.servicePlural, "Appointments");
  assert.equal(matchingTerminologyPreset({ terminology: physio }), "physio");
  assert.equal(matchingTerminologyPreset({ staffSingular: "Pro" }), "custom");
});
