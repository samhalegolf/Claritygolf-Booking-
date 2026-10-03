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
    resourceSingular: "Room",
    resourcePlural: "Rooms",
    assignmentPlural: "Aftercare",
    assignmentSingular: "Routine",
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
      resourceSingular: "Bay",
      resourcePlural: "Bays",
      assignmentPlural: "Practice",
      assignmentSingular: "Drill",
    },
  );
});

test("words saved before resources and assignments existed fill from the base, not golf", () => {
  const savedLastMonth = {
    staffSingular: "Stylist",
    staffPlural: "Stylists",
    customerSingular: "Client",
    customerPlural: "Clients",
    serviceSingular: "Service",
    servicePlural: "Services",
  };
  const terms = terminologyFor(savedLastMonth, terminologyPreset("hair-beauty"));
  assert.equal(terms.resourceSingular, "Chair");
  assert.equal(terms.assignmentPlural, "Aftercare");
  // Still matches its preset, though it never saved the newer words.
  assert.equal(matchingTerminologyPreset(savedLastMonth), "hair-beauty");
});

test("presets populate values without introducing an application mode", () => {
  const physio = terminologyPreset("physio");
  assert.equal(physio.staffSingular, "Physiotherapist");
  assert.equal(physio.customerPlural, "Patients");
  assert.equal(physio.servicePlural, "Appointments");
  assert.equal(matchingTerminologyPreset({ terminology: physio }), "physio");
  assert.equal(matchingTerminologyPreset({ staffSingular: "Pro" }), "custom");
});
