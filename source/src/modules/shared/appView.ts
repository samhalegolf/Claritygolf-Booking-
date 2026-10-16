import type { BillingSection } from "../billing/billingSections";
import type { SettingsTab } from "../settings/SettingsLayout";

// The sidebar's destinations. Lesson types and availability used to be two of
// them; they are Settings sections now (SETTINGS_SECTIONS "services" and the
// "availability" group under Booking), reached by switchView("settings") plus a
// settings tab, so they are not views any more.
export type View =
  // The phone layout's first screen: today's bookings. Not in the sidebar.
  | "today"
  // The phone layout's Book screen: the week's free times, then who for.
  | "book"
  | "calendar"
  | "clients"
  | "sell"
  | "billing"
  // Who the coach is, and everything Clarity is plugged into on their behalf.
  // Not a second Settings: every card here routes to where the setting really
  // lives, so there is still one place each thing is edited.
  | "profile"
  | "settings"
  | "video"
  | "players"
  // The overhead-camera putting gate.
  | "putting-lab";

// What an overlay is currently showing. A settings overlay carries the tab so
// the section's own tab CSS still applies and the group to focus; a billing
// overlay carries the section. Both carry the title they announce themselves
// with, which is the Business Hub card's own label.
export type WorkspaceOverlay =
  | { kind: "settings"; tab: Exclude<SettingsTab, "none">; group: string; title: string }
  | { kind: "billing"; section: Exclude<BillingSection, "none">; title: string };
