/**
 * Market profiles: one application presented for more than one industry.
 *
 * A market profile is a STARTING configuration, not a business type. It names
 * three things a new business would otherwise have to set by hand:
 *
 *   - its words      (a terminology preset from business-terminology.mts)
 *   - its modules    (which capabilities start on)
 *   - its product    (Clarity Golf or Clarity Booking, for platform chrome)
 *
 * After that the business's own saved choices win. A salon can rename Stylist
 * to Barber or switch Video Analysis on, and nothing here undoes it: the saved
 * account carries the profile id plus only the capabilities it moved away from
 * that profile's defaults (see AccountMarketConfig).
 *
 * The rest of the app must never ask "is this a salon?". It asks
 * `capabilities.videoAnalysis`, `capabilities.practice`, and reads
 * `terminology.staffSingular`. The profile id exists to pick defaults, to name
 * the product, and to tell the sandbox leak detector which words look wrong --
 * that is all.
 *
 * Internal names stay golf-shaped on purpose (coachId, playerId,
 * practice_blocks, /api/coaches). This file generalises the boundary, not the
 * vocabulary of the database.
 */

import {
  BUSINESS_TERMINOLOGY_PRESETS,
  DEFAULT_BUSINESS_TERMINOLOGY,
  TERMINOLOGY_KEYS,
  terminologyFor,
  terminologyPreset,
  type BusinessTerminology,
  type BusinessTerminologyPreset,
} from "./business-terminology.mts";

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Whether a major module is part of this business's product.
 *
 * Not the same as a plan entitlement (accountPlanCatalog / AccountFeatureKey).
 * A plan decides what a business has PAID for; a capability decides what the
 * business is SHOWN. A module is on screen only when both agree.
 *
 * Every key here gates something real -- see CAPABILITY_DEFINITIONS for where.
 * Keys are added when a module actually needs switching, not in advance.
 */
export const CAPABILITY_KEYS = [
  "calendar",
  "publicBooking",
  "resources",
  "billing",
  "products",
  "passes",
  "portal",
  "practice",
  "videoAnalysis",
  "swingReview",
  "handedness",
  "puttingLab",
  "caddy",
  "optix",
  "clinicalRecords",
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
export type MarketCapabilities = Record<CapabilityKey, boolean>;

export type CapabilityDefinition = {
  key: CapabilityKey;
  label: string;
  /** Where switching it off takes effect, for the sandbox builder. */
  gates: string;
  /**
   * Reserved capabilities are named so a profile can say where it is heading,
   * but there is nothing behind them yet. They always resolve off, whatever is
   * saved, so a Physio preset can never present Clarity as a clinical record
   * system by accident.
   */
  reserved?: boolean;
  /**
   * Visible phrases that belong only to this module. When the module is off
   * and one of these is on screen, the sandbox leak detector reports a
   * capability leak. Matched case-insensitively on word boundaries.
   */
  signatures: string[];
};

export const CAPABILITY_DEFINITIONS: ReadonlyArray<CapabilityDefinition> = [
  { key: "calendar", label: "Calendar", gates: "Calendar in the sidebar", signatures: [] },
  {
    key: "publicBooking",
    label: "Public booking",
    gates: "The public booking page, and bookings made through it (server-enforced)",
    signatures: [],
  },
  {
    key: "resources",
    label: "Resources",
    gates: "Bay/room/chair limits on facilities and in the booking modal",
    signatures: [],
  },
  {
    key: "billing",
    label: "Billing",
    gates: "Sell and Billing in the sidebar",
    signatures: [],
  },
  {
    key: "products",
    label: "Products",
    gates: "The shop on the client portal's Passes screen",
    signatures: [],
  },
  {
    key: "passes",
    label: "Passes",
    gates: "Passes in the client portal and on the client profile",
    signatures: [],
  },
  {
    key: "portal",
    label: "Client portal",
    gates: "Portal access tools on the client profile (players already invited keep their login)",
    signatures: [],
  },
  {
    key: "practice",
    label: "Practice / assignments",
    gates: "The practice-block engine (portal and client profile), under the business's assignment words",
    signatures: [],
  },
  {
    key: "videoAnalysis",
    label: "Video analysis",
    gates: "Video Analysis, its shortcuts, Videos on the client profile and in the portal",
    signatures: ["Video Analysis", "Open video analysis"],
  },
  {
    key: "swingReview",
    label: "Swing review",
    gates: "Reviews in the client portal and on the client profile",
    signatures: ["Swing Review", "Swing Reviews"],
  },
  {
    key: "handedness",
    label: "Handedness",
    gates: "\"Which way do you swing?\" on the booking page, and the handedness line bay allocation reads",
    signatures: ["Which way do you swing?"],
  },
  {
    key: "puttingLab",
    label: "Putting Lab",
    gates: "Putting Lab in the sidebar",
    signatures: ["Putting Lab"],
  },
  {
    key: "caddy",
    label: "Clarity Caddy",
    gates: "The Clarity Caddy card in the client portal",
    signatures: ["Clarity Caddy", "Caddy"],
  },
  {
    key: "optix",
    label: "Optix",
    gates: "Optix as an available integration",
    signatures: ["Optix"],
  },
  {
    key: "clinicalRecords",
    label: "Clinical records",
    gates: "Nothing yet -- reserved for future specialist work",
    reserved: true,
    signatures: [],
  },
];

const RESERVED_CAPABILITIES = new Set<CapabilityKey>(
  CAPABILITY_DEFINITIONS.filter((definition) => definition.reserved).map((definition) => definition.key),
);

/** Every capability on except the reserved ones: what Clarity Golf has always shown. */
const ALL_ON: MarketCapabilities = CAPABILITY_KEYS.reduce(
  (all, key) => ({ ...all, [key]: !RESERVED_CAPABILITIES.has(key) }),
  {} as MarketCapabilities,
);

function withOff(...keys: CapabilityKey[]): MarketCapabilities {
  const next = { ...ALL_ON };
  for (const key of keys) next[key] = false;
  return next;
}

// ---------------------------------------------------------------------------
// Product identity
// ---------------------------------------------------------------------------

/**
 * The PLATFORM a business runs on, as distinct from the business itself.
 *
 * Product identity is platform chrome: the name beside the logo, the browser
 * title, the support address. Business identity -- "Sam Hale Golf",
 * "Studio 27" -- lives on the coach account and is never decided here. A
 * business can be "Studio 27, powered by Clarity Booking".
 */
export type ProductKey = "clarity-golf" | "clarity-booking";

export type ProductIdentity = {
  key: ProductKey;
  name: string;
  /** Under the name in the sidebar. */
  tagline: string;
  /** Null when the product has no logo of its own yet; the UI shows the name alone. */
  logoSrc: string | null;
  supportEmail: string;
  /** The browser tab and installed-app title. */
  documentTitle: string;
};

export const PRODUCT_IDENTITIES: Readonly<Record<ProductKey, ProductIdentity>> = {
  "clarity-golf": {
    key: "clarity-golf",
    name: "Clarity Golf",
    tagline: "Booking System",
    logoSrc: "/assets/clarity-golf-logo-208.png",
    supportEmail: "support@claritygolf.app",
    documentTitle: "Clarity Golf Booking",
  },
  "clarity-booking": {
    key: "clarity-booking",
    name: "Clarity Booking",
    tagline: "Booking System",
    logoSrc: null,
    supportEmail: "support@claritygolf.app",
    documentTitle: "Clarity Booking",
  },
};

export function productIdentityFor(key: unknown): ProductIdentity {
  return PRODUCT_IDENTITIES[key as ProductKey] ?? PRODUCT_IDENTITIES["clarity-golf"];
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export type MarketProfileId = BusinessTerminologyPreset;

/**
 * How legal pages and data-handling wording should read. Only "standard"
 * exists. "clinical" is named so a health profile can ask for it later; until
 * that specialist work happens it resolves to the standard wording.
 */
export type LegalMode = "standard" | "clinical";

export type MarketProfile = {
  id: MarketProfileId;
  label: string;
  product: ProductKey;
  terminology: Readonly<BusinessTerminology>;
  capabilities: Readonly<MarketCapabilities>;
  /** How shared modules introduce themselves under this profile. */
  presentation: {
    /** The video module's name ("Video Analysis", "Session Review"). */
    videoLabel: string;
    /** An example dose for the assignment engine's placeholder text. */
    assignmentDoseExample: string;
  };
  legalMode: LegalMode;
  /**
   * Words that should not appear on screen for this profile, for the sandbox
   * leak detector. Words the business has chosen for itself are removed at
   * check time (see forbiddenTermsFor), so a coaching business that keeps
   * "Coach" is not told "Coach" is a leak.
   */
  forbiddenTerms: string[];
};

const GOLF_WORDS = ["golf", "golfer", "golfers", "swing", "swings", "caddy", "bay", "bays", "putting", "driving range"];
const GOLF_ROLE_WORDS = ["coach", "coaches", "player", "players", "lesson", "lessons"];

function terms(id: BusinessTerminologyPreset): Readonly<BusinessTerminology> {
  return (
    BUSINESS_TERMINOLOGY_PRESETS.find((preset) => preset.id === id)?.terminology ??
    DEFAULT_BUSINESS_TERMINOLOGY
  );
}

export const DEFAULT_MARKET_PROFILE_ID: MarketProfileId = "golf";

export const MARKET_PROFILES: ReadonlyArray<MarketProfile> = [
  {
    id: "golf",
    label: "Golf",
    product: "clarity-golf",
    terminology: terms("golf"),
    // Exactly what every business saw before profiles existed. An account with
    // no profile saved resolves here, so nothing about it changes.
    capabilities: ALL_ON,
    presentation: { videoLabel: "Video Analysis", assignmentDoseExample: "20 balls" },
    legalMode: "standard",
    forbiddenTerms: [],
  },
  {
    id: "golf-instructor",
    label: "Golf Instructor",
    product: "clarity-golf",
    terminology: terms("golf-instructor"),
    capabilities: ALL_ON,
    presentation: { videoLabel: "Video Analysis", assignmentDoseExample: "20 balls" },
    legalMode: "standard",
    forbiddenTerms: ["coach", "coaches"],
  },
  {
    id: "hair-beauty",
    label: "Hair & Beauty",
    product: "clarity-booking",
    terminology: terms("hair-beauty"),
    capabilities: withOff("practice", "videoAnalysis", "swingReview", "handedness", "puttingLab", "caddy", "optix"),
    presentation: { videoLabel: "Video Consultation", assignmentDoseExample: "Once a week" },
    legalMode: "standard",
    forbiddenTerms: [...GOLF_WORDS, ...GOLF_ROLE_WORDS, "drill", "drills"],
  },
  {
    id: "coaching",
    label: "Coaching",
    product: "clarity-booking",
    terminology: terms("coaching"),
    capabilities: withOff("swingReview", "handedness", "puttingLab", "caddy", "optix"),
    presentation: { videoLabel: "Session Review", assignmentDoseExample: "20 minutes" },
    legalMode: "standard",
    forbiddenTerms: [...GOLF_WORDS, "player", "players", "lesson", "lessons"],
  },
  {
    id: "personal-training",
    label: "Personal Training",
    product: "clarity-booking",
    terminology: terms("personal-training"),
    capabilities: withOff("swingReview", "handedness", "puttingLab", "caddy", "optix"),
    presentation: { videoLabel: "Movement Review", assignmentDoseExample: "3 × 10 reps" },
    legalMode: "standard",
    forbiddenTerms: [...GOLF_WORDS, ...GOLF_ROLE_WORDS],
  },
  {
    id: "massage",
    label: "Massage",
    product: "clarity-booking",
    terminology: terms("massage"),
    capabilities: withOff("videoAnalysis", "swingReview", "handedness", "puttingLab", "caddy", "optix"),
    presentation: { videoLabel: "Video Review", assignmentDoseExample: "5 minutes" },
    legalMode: "standard",
    forbiddenTerms: [...GOLF_WORDS, ...GOLF_ROLE_WORDS, "drill", "drills"],
  },
  {
    id: "physio",
    label: "Physio",
    product: "clarity-booking",
    terminology: terms("physio"),
    capabilities: withOff("videoAnalysis", "swingReview", "handedness", "puttingLab", "caddy", "optix"),
    presentation: { videoLabel: "Movement Review", assignmentDoseExample: "3 × 10 reps" },
    // Clinical wording is future specialist work. Naming it here does not turn
    // it on: legalModeFor() answers "standard" until it exists.
    legalMode: "clinical",
    forbiddenTerms: [...GOLF_WORDS, ...GOLF_ROLE_WORDS, "drill", "drills", "client", "clients"],
  },
  {
    id: "generic-service",
    label: "Generic Service",
    product: "clarity-booking",
    terminology: terms("generic-service"),
    capabilities: withOff("practice", "videoAnalysis", "swingReview", "handedness", "puttingLab", "caddy", "optix"),
    presentation: { videoLabel: "Video Review", assignmentDoseExample: "Once a week" },
    legalMode: "standard",
    forbiddenTerms: [...GOLF_WORDS, ...GOLF_ROLE_WORDS, "drill", "drills"],
  },
  {
    // A blank starting point for a combination none of the above describes.
    // Golf-shaped defaults so picking it changes nothing until something is
    // edited -- the editing is the point.
    id: "custom",
    label: "Custom",
    product: "clarity-booking",
    terminology: terms("custom"),
    capabilities: ALL_ON,
    presentation: { videoLabel: "Video Analysis", assignmentDoseExample: "20 minutes" },
    legalMode: "standard",
    forbiddenTerms: [],
  },
];

export function isMarketProfileId(value: unknown): value is MarketProfileId {
  return MARKET_PROFILES.some((profile) => profile.id === value);
}

export function marketProfileFor(id: unknown): MarketProfile {
  return (
    MARKET_PROFILES.find((profile) => profile.id === id) ??
    (MARKET_PROFILES.find((profile) => profile.id === DEFAULT_MARKET_PROFILE_ID) as MarketProfile)
  );
}

/** "clinical" is reserved: nothing reads clinical wording until it is written. */
export function legalModeFor(_profile: MarketProfile): LegalMode {
  return "standard";
}

// ---------------------------------------------------------------------------
// What an account saves
// ---------------------------------------------------------------------------

/**
 * A business's market configuration, as saved.
 *
 * Overrides, not a full map: only the capabilities this business moved away
 * from its profile's defaults. A capability added to the app later then starts
 * at the profile's default for every business, instead of at whatever a frozen
 * full map happened to omit.
 *
 * Settings rows: `accountMarketProfile`, `accountMarketCapabilitiesJson`.
 * Terminology stays in `accountTerminologyJson`, where it always was.
 * A business with neither market row resolves to golf with no overrides --
 * exactly the behaviour every existing account has today.
 */
export type AccountMarketConfig = {
  profileId: MarketProfileId;
  capabilityOverrides: Partial<MarketCapabilities>;
};

export const DEFAULT_ACCOUNT_MARKET_CONFIG: Readonly<AccountMarketConfig> = Object.freeze({
  profileId: DEFAULT_MARKET_PROFILE_ID,
  capabilityOverrides: {},
});

export function cleanCapabilityOverrides(raw: unknown): Partial<MarketCapabilities> {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const clean: Partial<MarketCapabilities> = {};
  for (const key of CAPABILITY_KEYS) {
    if (typeof record[key] === "boolean" && !RESERVED_CAPABILITIES.has(key)) clean[key] = record[key] as boolean;
  }
  return clean;
}

export function cleanMarketConfig(raw: unknown): AccountMarketConfig {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const profileId = isMarketProfileId(record.profileId) ? record.profileId : DEFAULT_MARKET_PROFILE_ID;
  return {
    profileId,
    capabilityOverrides: minimalOverrides(profileId, cleanCapabilityOverrides(record.capabilityOverrides)),
  };
}

/** Drop overrides that only restate the profile's default. */
export function minimalOverrides(
  profileId: MarketProfileId,
  overrides: Partial<MarketCapabilities>,
): Partial<MarketCapabilities> {
  const defaults = marketProfileFor(profileId).capabilities;
  const next: Partial<MarketCapabilities> = {};
  for (const key of CAPABILITY_KEYS) {
    const value = overrides[key];
    if (typeof value === "boolean" && value !== defaults[key] && !RESERVED_CAPABILITIES.has(key)) next[key] = value;
  }
  return next;
}

/** Overrides that turn `profileId`'s defaults into exactly `capabilities`. */
export function overridesFor(profileId: MarketProfileId, capabilities: Partial<MarketCapabilities>) {
  return minimalOverrides(profileId, cleanCapabilityOverrides(capabilities));
}

/** The settings rows a market config is stored as. */
export function marketConfigFromSettings(settings: Record<string, unknown> | null | undefined): AccountMarketConfig {
  const profileId = typeof settings?.accountMarketProfile === "string" ? settings.accountMarketProfile : "";
  let overrides: unknown = {};
  const rawOverrides = settings?.accountMarketCapabilitiesJson;
  if (typeof rawOverrides === "string" && rawOverrides) {
    try {
      overrides = JSON.parse(rawOverrides);
    } catch {
      overrides = {};
    }
  }
  return cleanMarketConfig({ profileId, capabilityOverrides: overrides });
}

export function marketConfigSettingsRows(config: AccountMarketConfig): Record<string, string> {
  const clean = cleanMarketConfig(config);
  return {
    accountMarketProfile: clean.profileId,
    accountMarketCapabilitiesJson: JSON.stringify(clean.capabilityOverrides),
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export function capabilitiesFor(config?: Partial<AccountMarketConfig> | null): MarketCapabilities {
  const clean = cleanMarketConfig(config);
  const resolved = { ...marketProfileFor(clean.profileId).capabilities, ...clean.capabilityOverrides };
  for (const key of RESERVED_CAPABILITIES) resolved[key] = false;
  return resolved;
}

/** The profile's words, under whatever the business has saved for itself. */
export function marketTerminologyFor(config: Partial<AccountMarketConfig> | null | undefined, saved?: unknown) {
  return terminologyFor(saved, marketProfileFor(cleanMarketConfig(config).profileId).terminology);
}

export type ResolvedMarket = {
  profileId: MarketProfileId;
  label: string;
  product: ProductIdentity;
  capabilities: MarketCapabilities;
  terminology: BusinessTerminology;
  presentation: MarketProfile["presentation"];
  legalMode: LegalMode;
};

export function resolveMarket(
  config: Partial<AccountMarketConfig> | null | undefined,
  savedTerminology?: unknown,
): ResolvedMarket {
  const clean = cleanMarketConfig(config);
  const profile = marketProfileFor(clean.profileId);
  return {
    profileId: profile.id,
    label: profile.label,
    product: productIdentityFor(profile.product),
    capabilities: capabilitiesFor(clean),
    terminology: marketTerminologyFor(clean, savedTerminology),
    presentation: profile.presentation,
    legalMode: legalModeFor(profile),
  };
}

/**
 * A resolved market as it arrives over the wire to the booking page or the
 * client portal ({ profileId, capabilities, presentation, product }), cleaned
 * back into the full shape. Anything missing reads as golf -- an older server
 * answer must never switch a module off by omission.
 */
export function resolvedMarketFromWire(raw: unknown, savedTerminology?: unknown): ResolvedMarket {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const profile = marketProfileFor(record.profileId);
  const capabilities = { ...profile.capabilities, ...cleanCapabilityOverrides(record.capabilities) };
  for (const key of RESERVED_CAPABILITIES) capabilities[key] = false;
  const product = record.product && typeof record.product === "object" ? (record.product as Record<string, unknown>) : {};
  return {
    profileId: profile.id,
    label: profile.label,
    product: productIdentityFor(product.key ?? profile.product),
    capabilities,
    terminology: terminologyFor(savedTerminology, profile.terminology),
    presentation: profile.presentation,
    legalMode: legalModeFor(profile),
  };
}

// ---------------------------------------------------------------------------
// Public entry routes
// ---------------------------------------------------------------------------

/**
 * claritybooking.app/<segment> -> the profile a NEW business starts from.
 *
 * This only ever picks onboarding and marketing defaults. Once an account
 * exists its saved configuration is authoritative, and no route or hostname
 * overrides it -- a salon that signed up through /hair and then turned Video
 * Analysis on keeps it on whichever URL it opens.
 */
export const MARKET_ENTRY_ROUTES: Readonly<Record<string, MarketProfileId>> = {
  golf: "golf",
  hair: "hair-beauty",
  beauty: "hair-beauty",
  coaching: "coaching",
  "personal-training": "personal-training",
  massage: "massage",
  physio: "physio",
};

export function marketProfileForEntryPath(pathname: unknown): MarketProfileId | null {
  if (typeof pathname !== "string") return null;
  const segment = pathname.replace(/^\/+/, "").split(/[/?#]/)[0]?.toLowerCase() || "";
  return MARKET_ENTRY_ROUTES[segment] ?? null;
}

/**
 * The market config a brand-new business is created with. An existing
 * account's config is passed as `existing` and always wins.
 */
export function initialMarketConfig(
  existing: Partial<AccountMarketConfig> | null | undefined,
  entryPath?: string,
): AccountMarketConfig {
  if (existing && isMarketProfileId(existing.profileId)) return cleanMarketConfig(existing);
  return cleanMarketConfig({ profileId: marketProfileForEntryPath(entryPath) ?? DEFAULT_MARKET_PROFILE_ID });
}

// ---------------------------------------------------------------------------
// Saved custom presets
// ---------------------------------------------------------------------------

/**
 * A named recipe saved from the sandbox builder: a base profile, the words,
 * and the full capability map as it was on screen.
 *
 * Full map, not overrides, because a preset is a snapshot someone chose on
 * purpose ("Hair Video Consultation"); applying it should reproduce exactly
 * what they saw.
 *
 * `visibility` is the hook for a preset graduating from sandbox experiment to
 * a public Clarity Booking entry option or a dedicated product. Only
 * "sandbox" exists today; the shape is the same whichever it becomes.
 */
export type CustomMarketPreset = {
  id: string;
  name: string;
  baseProfileId: MarketProfileId;
  terminology: BusinessTerminology;
  capabilities: MarketCapabilities;
  visibility: "sandbox";
  createdAt: string;
};

export const MAX_CUSTOM_PRESETS = 30;

function presetIdFor(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "preset";
}

export function cleanCustomPreset(raw: unknown, now = new Date().toISOString()): CustomMarketPreset | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const name =
    typeof record.name === "string"
      ? record.name.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60)
      : "";
  if (!name) return null;
  const baseProfileId = isMarketProfileId(record.baseProfileId) ? record.baseProfileId : "custom";
  const base = marketProfileFor(baseProfileId);
  const capabilities = { ...base.capabilities, ...cleanCapabilityOverrides(record.capabilities) };
  for (const key of RESERVED_CAPABILITIES) capabilities[key] = false;
  return {
    id: typeof record.id === "string" && /^[a-z0-9-]{1,48}$/.test(record.id) ? record.id : presetIdFor(name),
    name,
    baseProfileId,
    terminology: terminologyFor(record.terminology, base.terminology),
    capabilities,
    visibility: "sandbox",
    createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt.slice(0, 40) : now,
  };
}

export function cleanCustomPresets(raw: unknown): CustomMarketPreset[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const presets: CustomMarketPreset[] = [];
  for (const entry of raw) {
    const preset = cleanCustomPreset(entry);
    if (!preset || seen.has(preset.id)) continue;
    seen.add(preset.id);
    presets.push(preset);
    if (presets.length >= MAX_CUSTOM_PRESETS) break;
  }
  return presets;
}

/**
 * Add or replace a preset by name. Saving "Hair Video Consultation" twice
 * updates the one preset rather than making two that look identical.
 */
export function upsertCustomPreset(existing: unknown, incoming: unknown): CustomMarketPreset[] {
  const list = cleanCustomPresets(existing);
  const preset = cleanCustomPreset(incoming);
  if (!preset) return list;
  const id = presetIdFor(preset.name);
  const index = list.findIndex((candidate) => candidate.id === id);
  const next = { ...preset, id };
  if (index >= 0) {
    list[index] = { ...next, createdAt: list[index].createdAt };
    return list;
  }
  return [...list, next].slice(-MAX_CUSTOM_PRESETS);
}

/** The account config that applying a custom preset produces. */
export function applyCustomPreset(preset: CustomMarketPreset): {
  config: AccountMarketConfig;
  terminology: BusinessTerminology;
} {
  return {
    config: {
      profileId: preset.baseProfileId,
      capabilityOverrides: overridesFor(preset.baseProfileId, preset.capabilities),
    },
    terminology: preset.terminology,
  };
}

/** Applying a built-in profile: its words and its defaults, no overrides. */
export function applyMarketProfile(profileId: MarketProfileId): {
  config: AccountMarketConfig;
  terminology: BusinessTerminology;
} {
  return {
    config: { profileId, capabilityOverrides: {} },
    terminology: terminologyPreset(profileId),
  };
}

// ---------------------------------------------------------------------------
// Leak detection (sandbox only -- see src/modules/sandbox/IndustryLeakDetector)
// ---------------------------------------------------------------------------

function wordsOf(terminology: BusinessTerminology) {
  const words = new Set<string>();
  for (const key of TERMINOLOGY_KEYS) {
    const value = terminology[key].toLowerCase();
    words.add(value);
    for (const word of value.split(/[^a-z0-9]+/)) if (word) words.add(word);
  }
  return words;
}

/**
 * The words that look wrong on screen for this business.
 *
 * The profile's list, minus anything the business uses itself. A coaching
 * business keeping "Coach" is not leaking "Coach"; a salon that renamed
 * Stylist to Coach is not either.
 */
export function forbiddenTermsFor(market: Pick<ResolvedMarket, "profileId" | "terminology">): string[] {
  const own = wordsOf(market.terminology);
  return [...new Set(marketProfileFor(market.profileId).forbiddenTerms.map((term) => term.toLowerCase()))].filter(
    (term) => !own.has(term),
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One case-insensitive, word-bounded matcher for a list of terms. */
export function termMatcher(termsToFind: string[]): RegExp | null {
  const cleaned = termsToFind.map((term) => term.trim()).filter(Boolean);
  if (!cleaned.length) return null;
  // Longest first, so "driving range" wins over "range" and "players" over "player".
  const pattern = cleaned
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  return new RegExp(`(?<![A-Za-z0-9])(?:${pattern})(?![A-Za-z0-9])`, "gi");
}

export function findTerms(text: string, matcher: RegExp | null): string[] {
  if (!matcher || !text) return [];
  return [...text.matchAll(matcher)].map((match) => match[0]);
}

/** The terminology word a forbidden term was probably standing in for. */
export function expectedTermFor(term: string, terminology: BusinessTerminology): string | null {
  const lower = term.toLowerCase();
  if (["coach", "instructor"].includes(lower)) return terminology.staffSingular;
  if (["coaches", "instructors"].includes(lower)) return terminology.staffPlural;
  if (["player", "golfer", "client"].includes(lower)) return terminology.customerSingular;
  if (["players", "golfers", "clients"].includes(lower)) return terminology.customerPlural;
  if (lower === "lesson") return terminology.serviceSingular;
  if (lower === "lessons") return terminology.servicePlural;
  if (lower === "bay") return terminology.resourceSingular;
  if (lower === "bays") return terminology.resourcePlural;
  if (["drill", "drills", "practice"].includes(lower)) return terminology.assignmentPlural;
  return null;
}

/** Capability signatures that should not be visible, given what is switched off. */
export function capabilityLeakSignatures(capabilities: MarketCapabilities): Array<{ key: CapabilityKey; phrase: string }> {
  return CAPABILITY_DEFINITIONS.flatMap((definition) =>
    capabilities[definition.key] ? [] : definition.signatures.map((phrase) => ({ key: definition.key, phrase })),
  );
}
