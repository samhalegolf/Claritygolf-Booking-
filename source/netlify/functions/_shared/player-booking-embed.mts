// The player portal's slot for a booking widget that isn't ours.
//
// A business can run its lessons through Clarity and still send players
// somewhere else to book a bay, a range slot or a simulator -- Skedda, a club
// tee-sheet, Calendly, whatever the venue already uses. This is the config for
// that: one URL per business, plus what to call the tab it appears in.
//
// It deliberately does NOT replace the Lessons > Book flow. That is Clarity's
// own booking, filed against the coach's calendar. This is a second door, and
// the two exist side by side.
//
// Both implementations of /api/admin-settings read and write through here
// (admin-settings.mts is authoritative; booking-core.mts keeps a mirror), so
// the accepted key list cannot drift between them the way the notification
// template keys did.

export const PLAYER_BOOKING_EMBED_DEFAULT_LABEL = "Book";
export const PLAYER_BOOKING_EMBED_DEFAULT_HEIGHT = 760;
export const PLAYER_BOOKING_EMBED_MIN_HEIGHT = 320;
export const PLAYER_BOOKING_EMBED_MAX_HEIGHT = 2400;

/** The settings rows this config lives in, in write order. */
export const PLAYER_BOOKING_EMBED_SETTING_KEYS = [
  "playerBookingEmbedUrl",
  "playerBookingEmbedLabel",
  "playerBookingEmbedIntro",
  "playerBookingEmbedHeight",
] as const;

export type PlayerBookingEmbed = {
  /** Empty when the business has not configured one -- the tab then does not exist. */
  playerBookingEmbedUrl: string;
  /** What the nav tab is called. A venue's own word for it beats ours. */
  playerBookingEmbedLabel: string;
  /** One line above the frame, for "bays only -- lessons are under Lessons". */
  playerBookingEmbedIntro: string;
  /** Starting height in px. The frame can grow past it if the provider posts a resize. */
  playerBookingEmbedHeight: number;
};

function trimmed(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * https only, and only ever an absolute URL.
 *
 * A relative path would resolve against the portal's own origin and frame the
 * portal inside itself; `javascript:` and `data:` in a src attribute are script
 * injection with extra steps. Anything that is not plain https is not a booking
 * widget, so it becomes "" -- which reads downstream as "not configured" and
 * hides the tab rather than rendering a broken frame.
 */
export function cleanPlayerBookingEmbedUrl(value: unknown, fallback = "") {
  const candidate = trimmed(value, 700);
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

export function cleanPlayerBookingEmbedLabel(value: unknown) {
  return trimmed(value, 24) || PLAYER_BOOKING_EMBED_DEFAULT_LABEL;
}

export function cleanPlayerBookingEmbedIntro(value: unknown) {
  return trimmed(value, 240);
}

export function cleanPlayerBookingEmbedHeight(value: unknown) {
  const height = Number(value ?? PLAYER_BOOKING_EMBED_DEFAULT_HEIGHT);
  if (!Number.isFinite(height)) return PLAYER_BOOKING_EMBED_DEFAULT_HEIGHT;
  return Math.max(
    PLAYER_BOOKING_EMBED_MIN_HEIGHT,
    Math.min(PLAYER_BOOKING_EMBED_MAX_HEIGHT, Math.round(height)),
  );
}

/** Read the four rows out of a settings key/value map. */
export function playerBookingEmbedFromSettings(
  settings: Record<string, unknown> | null | undefined,
): PlayerBookingEmbed {
  return {
    playerBookingEmbedUrl: cleanPlayerBookingEmbedUrl(settings?.playerBookingEmbedUrl),
    playerBookingEmbedLabel: cleanPlayerBookingEmbedLabel(settings?.playerBookingEmbedLabel),
    playerBookingEmbedIntro: cleanPlayerBookingEmbedIntro(settings?.playerBookingEmbedIntro),
    playerBookingEmbedHeight: cleanPlayerBookingEmbedHeight(settings?.playerBookingEmbedHeight),
  };
}

/**
 * What the player portal is handed on /api/player/profile.
 *
 * Renamed off the settings keys on purpose: the portal has one embed, so it
 * does not need to carry "playerBookingEmbed" in every field name, and an empty
 * `url` is the single signal that means "no tab".
 */
export function playerBookingEmbedForPortal(settings: Record<string, unknown> | null | undefined) {
  const config = playerBookingEmbedFromSettings(settings);
  return {
    url: config.playerBookingEmbedUrl,
    label: config.playerBookingEmbedLabel,
    intro: config.playerBookingEmbedIntro,
    height: config.playerBookingEmbedHeight,
  };
}
