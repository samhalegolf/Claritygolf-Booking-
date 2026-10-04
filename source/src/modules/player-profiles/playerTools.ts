import { ImagePlus } from "lucide-react";
import type { CapabilityKey } from "../../../netlify/functions/_shared/market-profile.mts";
import { t } from "../../lib/i18n";
import {
  ClarityBookingPages,
  ClarityCalendar,
  ClarityEmail,
  ClarityIntegrations,
  ClarityLessonsProgrammes,
  ClarityPassesCredits,
  ClarityPayments,
  ClarityVideoAnalysis,
  type IconComponent,
} from "../shared/ClarityIcons";

/* The nine sections of a player profile. The first four are the coach's
 * daily reads and sit on the bar; the last five are the record and live behind
 * its toggle -- see .player-tool-tabs.is-expanded. */
export type PlayerProfileTool =
  | "bookings"
  | "reviews"
  | "videos"
  | "practice"
  | "notes"
  | "emails"
  | "transactions"
  | "passes"
  | "portals";

/* What the Practice tab shows per block. The full practice module owns the
 * composer and the wall; the profile only needs enough of a block to list it,
 * so it takes a flattened copy rather than importing the module's types into
 * the console's bundle. */
export type PlayerPracticeSummary = {
  id: string;
  title: string;
  typeLabel: string;
  tone: string;
  dose: string;
  steps: number;
  assignedAt: string;
  expiryType: string;
  expiryDate: string | null;
  hasVideo: boolean;
  linkedVideoId: string;
  content: string;
  status: string;
};

/* The bar itself, in order. Split into the four that are always on it and the
 * five behind the toggle -- SECONDARY_PLAYER_TOOLS below is derived from the
 * second list so the two can never drift apart. */
export const PRIMARY_PLAYER_TOOL_TABS = [
  { id: "bookings", label: t("Bookings"), Icon: ClarityCalendar },
  { id: "reviews", label: t("Swing reviews"), Icon: ImagePlus },
  { id: "videos", label: t("Videos"), Icon: ClarityVideoAnalysis },
  { id: "practice", label: t("Practice"), Icon: ClarityLessonsProgrammes },
] as const satisfies ReadonlyArray<{ id: PlayerProfileTool; label: string; Icon: IconComponent }>;

export const SECONDARY_PLAYER_TOOL_TABS = [
  { id: "notes", label: t("Notes"), Icon: ClarityBookingPages },
  { id: "emails", label: t("Emails"), Icon: ClarityEmail },
  { id: "transactions", label: t("Transactions"), Icon: ClarityPayments },
  { id: "passes", label: t("Passes"), Icon: ClarityPassesCredits },
  { id: "portals", label: t("Portals"), Icon: ClarityIntegrations },
] as const satisfies ReadonlyArray<{ id: PlayerProfileTool; label: string; Icon: IconComponent }>;

// The module each client-profile tool belongs to; unlisted tools are part of
// every business. Same mapping the client portal uses for its own tabs.
export const PLAYER_TOOL_CAPABILITY: Partial<Record<PlayerProfileTool, CapabilityKey>> = {
  reviews: "swingReview",
  videos: "videoAnalysis",
  practice: "practice",
  passes: "passes",
  portals: "portal",
};

export function playerToolAllowed(tool: PlayerProfileTool, capabilities: Record<CapabilityKey, boolean>) {
  const capability = PLAYER_TOOL_CAPABILITY[tool];
  return !capability || capabilities[capability];
}

/** The five that only appear once the tab bar is opened out. */
export const SECONDARY_PLAYER_TOOLS: ReadonlySet<PlayerProfileTool> = new Set<PlayerProfileTool>(
  SECONDARY_PLAYER_TOOL_TABS.map((tab) => tab.id),
);
