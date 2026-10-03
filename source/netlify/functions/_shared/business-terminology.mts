/**
 * User-facing words for one business.
 *
 * Internal identifiers deliberately stay golf-shaped (coachId, playerId,
 * lessonFormat, /api/coaches, and so on). This is the single boundary that
 * translates those stable concepts into the words a business's users see.
 *
 * The presets here are also the word lists of the market profiles in
 * market-profile.mts -- a market profile names one of these ids rather than
 * carrying a second copy of the words, so there is one preset system, not two.
 */
export type BusinessTerminology = {
  staffSingular: string;
  staffPlural: string;
  customerSingular: string;
  customerPlural: string;
  serviceSingular: string;
  servicePlural: string;
  /** A bookable bay, chair, room or court -- see resources.mts. */
  resourceSingular: string;
  resourcePlural: string;
  /**
   * The practice-block engine (practice-blocks.mts) as the business names it:
   * the module ("Practice", "Exercises", "Aftercare") and one item in it
   * ("Drill", "Exercise", "Routine"). The engine itself is not renamed.
   */
  assignmentPlural: string;
  assignmentSingular: string;
};

export type BusinessTerminologyPreset =
  | "golf"
  | "golf-instructor"
  | "hair-beauty"
  | "coaching"
  | "personal-training"
  | "massage"
  | "physio"
  | "generic-service"
  | "custom";

export const DEFAULT_BUSINESS_TERMINOLOGY: Readonly<BusinessTerminology> = Object.freeze({
  staffSingular: "Coach",
  staffPlural: "Coaches",
  customerSingular: "Player",
  customerPlural: "Players",
  serviceSingular: "Lesson",
  servicePlural: "Lessons",
  resourceSingular: "Bay",
  resourcePlural: "Bays",
  assignmentPlural: "Practice",
  assignmentSingular: "Drill",
});

/**
 * The six words the terminology editor has always had. Saved terminology from
 * before resources and assignments were added carries only these, so preset
 * matching compares on them -- otherwise every business that picked "Physio"
 * last month would read as "Custom" today.
 */
export const CORE_TERMINOLOGY_KEYS = [
  "staffSingular",
  "staffPlural",
  "customerSingular",
  "customerPlural",
  "serviceSingular",
  "servicePlural",
] as const satisfies ReadonlyArray<keyof BusinessTerminology>;

export const BUSINESS_TERMINOLOGY_PRESETS: ReadonlyArray<{
  id: BusinessTerminologyPreset;
  label: string;
  terminology: Readonly<BusinessTerminology>;
}> = [
  { id: "golf", label: "Golf", terminology: DEFAULT_BUSINESS_TERMINOLOGY },
  {
    id: "golf-instructor",
    label: "Golf Instructor",
    terminology: {
      ...DEFAULT_BUSINESS_TERMINOLOGY,
      staffSingular: "Instructor",
      staffPlural: "Instructors",
    },
  },
  {
    id: "hair-beauty",
    label: "Hair & Beauty",
    terminology: {
      staffSingular: "Stylist",
      staffPlural: "Stylists",
      customerSingular: "Client",
      customerPlural: "Clients",
      serviceSingular: "Service",
      servicePlural: "Services",
      resourceSingular: "Chair",
      resourcePlural: "Chairs",
      assignmentPlural: "Aftercare",
      assignmentSingular: "Aftercare step",
    },
  },
  {
    id: "coaching",
    label: "Coaching",
    terminology: {
      staffSingular: "Coach",
      staffPlural: "Coaches",
      customerSingular: "Client",
      customerPlural: "Clients",
      serviceSingular: "Session",
      servicePlural: "Sessions",
      resourceSingular: "Room",
      resourcePlural: "Rooms",
      assignmentPlural: "Assignments",
      assignmentSingular: "Exercise",
    },
  },
  {
    id: "personal-training",
    label: "Personal Training",
    terminology: {
      staffSingular: "Trainer",
      staffPlural: "Trainers",
      customerSingular: "Client",
      customerPlural: "Clients",
      serviceSingular: "Session",
      servicePlural: "Sessions",
      resourceSingular: "Studio",
      resourcePlural: "Studios",
      assignmentPlural: "Programme",
      assignmentSingular: "Exercise",
    },
  },
  {
    id: "massage",
    label: "Massage",
    terminology: {
      staffSingular: "Therapist",
      staffPlural: "Therapists",
      customerSingular: "Client",
      customerPlural: "Clients",
      serviceSingular: "Treatment",
      servicePlural: "Treatments",
      resourceSingular: "Treatment Room",
      resourcePlural: "Treatment Rooms",
      assignmentPlural: "Aftercare",
      assignmentSingular: "Routine",
    },
  },
  {
    id: "physio",
    label: "Physio",
    terminology: {
      staffSingular: "Physiotherapist",
      staffPlural: "Physiotherapists",
      customerSingular: "Patient",
      customerPlural: "Patients",
      serviceSingular: "Appointment",
      servicePlural: "Appointments",
      resourceSingular: "Treatment Room",
      resourcePlural: "Treatment Rooms",
      assignmentPlural: "Exercises",
      assignmentSingular: "Exercise",
    },
  },
  {
    id: "generic-service",
    label: "Generic Service",
    terminology: {
      staffSingular: "Staff member",
      staffPlural: "Staff",
      customerSingular: "Customer",
      customerPlural: "Customers",
      serviceSingular: "Appointment",
      servicePlural: "Appointments",
      resourceSingular: "Resource",
      resourcePlural: "Resources",
      assignmentPlural: "Follow-ups",
      assignmentSingular: "Follow-up",
    },
  },
  { id: "custom", label: "Custom", terminology: DEFAULT_BUSINESS_TERMINOLOGY },
] as const;

export const TERMINOLOGY_KEYS = Object.keys(DEFAULT_BUSINESS_TERMINOLOGY) as Array<keyof BusinessTerminology>;

function cleanTerm(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  // Terms are short labels, not sentences or markup. Keeping normal word
  // punctuation supports names such as "Practitioner-in-charge" while
  // removing control characters and angle brackets before UI/email use.
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return cleaned || fallback;
}

/**
 * The business's words, with anything it has not set filled from `base`.
 *
 * `base` is the business's market profile's words (see market-profile.mts),
 * golf when it has none -- so a salon that saved its six words before
 * resources had a name reads "Chair", not "Bay".
 */
export function terminologyFor(
  source?: unknown,
  base: Readonly<BusinessTerminology> = DEFAULT_BUSINESS_TERMINOLOGY,
): BusinessTerminology {
  const record = source && typeof source === "object" ? (source as Record<string, unknown>) : {};
  const nested = record.terminology;
  const raw = nested && typeof nested === "object" ? (nested as Record<string, unknown>) : record;
  return TERMINOLOGY_KEYS.reduce((terms, key) => {
    terms[key] = cleanTerm(raw[key], cleanTerm(base[key], DEFAULT_BUSINESS_TERMINOLOGY[key]));
    return terms;
  }, {} as BusinessTerminology);
}

export function terminologyPreset(id: unknown): BusinessTerminology {
  const preset = BUSINESS_TERMINOLOGY_PRESETS.find((candidate) => candidate.id === id);
  return terminologyFor(preset?.terminology);
}

export function matchingTerminologyPreset(source?: unknown): BusinessTerminologyPreset {
  const terms = terminologyFor(source);
  const match = BUSINESS_TERMINOLOGY_PRESETS.find(
    (preset) =>
      preset.id !== "custom" &&
      CORE_TERMINOLOGY_KEYS.every((key) => preset.terminology[key] === terms[key]),
  );
  return match?.id ?? "custom";
}
