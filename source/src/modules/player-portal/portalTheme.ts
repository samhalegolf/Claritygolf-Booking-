/**
 * Light or dark, as the player decides.
 *
 * Until they touch the switch the portal follows the phone: a client opens
 * this once on a device we know nothing about, and their OS preference is a
 * better guess than anything we could save for them. "system" is therefore the
 * default and a real state, not an absence of one.
 *
 * Once they choose, the choice wins in both directions and is remembered on
 * that device only. It is not on their profile on purpose -- a preference is
 * about the screen in their hand, and syncing it would mean a phone in bright
 * sun inheriting what they picked on a laptop at night.
 */

const KEY = "clarity.player.theme.v1";

export type PortalTheme = "system" | "light" | "dark";

export function readPortalTheme(): PortalTheme {
  try {
    const stored = window.localStorage.getItem(KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    // Private windows and blocked site data both throw. Following the device
    // is the right answer when we cannot remember anything anyway.
    return "system";
  }
}

export function writePortalTheme(theme: PortalTheme) {
  try {
    // "system" is stored as the absence of a choice, so a player who goes back
    // to it starts following their phone again rather than being pinned to
    // whatever it happened to be at that moment.
    if (theme === "system") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, theme);
  } catch {
    // The switch still works for this visit; it just will not be remembered.
  }
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

/**
 * What the screen is actually showing right now.
 *
 * The switch has to say which way it is about to go, and "system" cannot
 * answer that on its own.
 */
export function effectiveTheme(theme: PortalTheme, prefersDark: boolean): "light" | "dark" {
  if (theme === "light" || theme === "dark") return theme;
  return prefersDark ? "dark" : "light";
}

/**
 * Where one tap goes.
 *
 * A three-way cycle through System is the honest model and the wrong control:
 * on a phone it means tapping twice to get back to where you were, past a
 * state whose name does not describe what you are looking at. So a tap flips
 * what is on screen, and choosing is what leaves "system" behind.
 */
export function togglePortalTheme(theme: PortalTheme, prefersDark: boolean): "light" | "dark" {
  return effectiveTheme(theme, prefersDark) === "dark" ? "light" : "dark";
}

/**
 * The value for the attribute the stylesheet reads.
 *
 * Empty while following the device: the media query in tokens.css is written
 * to apply unless it is overruled, so "system" must leave no attribute behind
 * for it to be overruled by.
 */
export function portalThemeAttribute(theme: PortalTheme): "light" | "dark" | undefined {
  return theme === "system" ? undefined : theme;
}
