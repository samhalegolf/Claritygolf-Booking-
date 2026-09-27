/**
 * User-facing words for one business.
 *
 * Internal identifiers deliberately stay golf-shaped (coachId, playerId,
 * lessonFormat, /api/coaches, and so on). This is the single boundary that
 * translates those stable concepts into the words a business's users see.
 */
export type BusinessTerminology = {
  staffSingular: string;
  staffPlural: string;
  customerSingular: string;
  customerPlural: string;
  serviceSingular: string;
  servicePlural: string;
};

export type BusinessTerminologyPreset =
  | "golf"
  | "golf-instructor"
  | "hair-beauty"
  | "massage"
  | "physio"
  | "custom";

export const DEFAULT_BUSINESS_TERMINOLOGY: Readonly<BusinessTerminology> = Object.freeze({
  staffSingular: "Coach",
  staffPlural: "Coaches",
  customerSingular: "Player",
  customerPlural: "Players",
  serviceSingular: "Lesson",
  servicePlural: "Lessons",
});

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
      staffSingular: "Instructor",
      staffPlural: "Instructors",
      customerSingular: "Player",
      customerPlural: "Players",
      serviceSingular: "Lesson",
      servicePlural: "Lessons",
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
    },
  },
  { id: "custom", label: "Custom", terminology: DEFAULT_BUSINESS_TERMINOLOGY },
] as const;

const TERMINOLOGY_KEYS = Object.keys(DEFAULT_BUSINESS_TERMINOLOGY) as Array<keyof BusinessTerminology>;

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

export function terminologyFor(source?: unknown): BusinessTerminology {
  const record = source && typeof source === "object" ? (source as Record<string, unknown>) : {};
  const nested = record.terminology;
  const raw = nested && typeof nested === "object" ? (nested as Record<string, unknown>) : record;
  return TERMINOLOGY_KEYS.reduce((terms, key) => {
    terms[key] = cleanTerm(raw[key], DEFAULT_BUSINESS_TERMINOLOGY[key]);
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
      TERMINOLOGY_KEYS.every((key) => preset.terminology[key] === terms[key]),
  );
  return match?.id ?? "custom";
}
