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
