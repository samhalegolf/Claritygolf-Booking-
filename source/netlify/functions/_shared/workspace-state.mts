import { coachAccountFromSettings, isOriginalWorkspace } from "./coach-account.mts";
import { messageText } from "./message-language.mts";
import { playerBookingEmbedFromSettings } from "./player-booking-embed.mts";
import { appUserRoleForMembership, type CoachActor } from "./coach-auth.mts";
import { cleanHexColor, servicesFromSettings } from "./services.mts";
import { parseSettingJson, settingValue } from "./settings-store.mts";
import { cleanSlug, cleanString, timeToMinutes } from "./values.mts";
import {
  defaultAppUserFromAccount,
  defaultCoachProfileFromAccount,
  normalizeCoachProfiles,
  normalizeLocations,
  normalizeWorkspaceAccounts,
  ownCoachIdFor,
} from "./workspace.mts";

/**
 * What the coach app and the booking page read from a business's settings
 * row, cleaned into the shape the browser expects: lesson types, coaches,
 * locations, bookable hours, brand, notification settings and the account.
 *
 * Every route that answers with business state builds it here, so the
 * calendar load, the booking page and the permission checks all see the same
 * business. The calendar shell used to keep its own cleaners, and they
 * drifted.
 */

export const defaultEmailTemplates = {
  clientEmailSubject: "Your {{service}} is confirmed",
  clientEmailIntro:
    "Thanks {{firstName}}, your booking with {{coach}} is confirmed.",
  clientEmailFooter: "We look forward to seeing you.",
  adminEmailSubject: "New booking: {{client}}",
  adminEmailIntro: "{{client}} booked {{service}} for {{date}} at {{time}}.",
};

export const defaultAvailability = [
  [{ start: timeToMinutes(16, 30), end: timeToMinutes(20, 0) }],
  [],
  [{ start: timeToMinutes(14, 0), end: timeToMinutes(20, 0) }],
  [
    { start: timeToMinutes(7, 0), end: timeToMinutes(11, 0) },
    { start: timeToMinutes(14, 0), end: timeToMinutes(16, 30) },
  ],
  [{ start: timeToMinutes(14, 0), end: timeToMinutes(16, 0) }],
  [],
  [{ start: timeToMinutes(15, 0), end: timeToMinutes(18, 0) }],
];

export function normalizeAvailability(availability) {
  const source = Array.isArray(availability)
    ? availability
    : defaultAvailability;
  const dayStartMinutes = 0;
  const dayEndMinutes = (24 * 60) - 15;
  return Array.from({ length: 7 }, (_, day) => {
    const windows = Array.isArray(source[day]) ? source[day] : [];
    return windows
      .map((window) => {
        const rawStart = Number.isFinite(Number(window?.start))
          ? Number(window.start)
          : timeToMinutes(7, 0);
        const rawEnd = Number.isFinite(Number(window?.end))
          ? Number(window.end)
          : rawStart + 60;
        const start = Math.max(
          dayStartMinutes,
          Math.min(dayEndMinutes, Math.round(rawStart / 15) * 15),
        );
        const end = Math.max(
          start + 15,
          Math.min(dayEndMinutes, Math.round(rawEnd / 15) * 15),
        );
        const coachId = cleanSlug(window?.coachId, defaultCoachProfileFromAccount().id);
        // Keep the owning business on the window. Every account filter is
        // strict now, so a window that loses its accountId here is dropped
        // from the public slot calculation and the booking page shows no
        // times at all.
        const accountId = cleanSlug(window?.accountId, "");
        // Where the coach is working in this window. Empty means "wherever the
        // lesson type is" -- every window saved before locations existed.
        const locationId = cleanSlug(window?.locationId, "");
        if (end <= start) return null;
        return {
          start,
          end,
          coachId,
          ...(accountId ? { accountId } : {}),
          ...(locationId ? { locationId } : {}),
        };
      })
      .filter(Boolean)
      .sort(
        (a, b) =>
          (a.coachId || "").localeCompare(b.coachId || "") ||
          (a.locationId || "").localeCompare(b.locationId || "") ||
          a.start - b.start,
      )
      .reduce((merged, window) => {
        const previous = merged.at(-1);
        if (
          previous &&
          previous.coachId === window.coachId &&
          (previous.locationId || "") === (window.locationId || "") &&
          window.start < previous.end
        ) {
          previous.end = Math.max(previous.end, window.end);
        } else {
          merged.push({ ...window });
        }
        return merged;
      }, []);
  });
}

// Reminder lead time: 1 hour to 14 days before the lesson, default 24 hours.
// Mirrors admin-settings.mts, which owns the /api/admin-settings write path.
export function cleanReminderLeadMinutes(value, fallback = 24 * 60) {
  const minutes = Number(value === "" || value === undefined || value === null ? fallback : value);
  return Number.isFinite(minutes) ? Math.max(60, Math.min(14 * 24 * 60, Math.round(minutes))) : fallback;
}

export function adminSettingsFromSettings(settings) {
  const delaySeconds = Number(settingValue(settings, "notificationDelaySeconds") || 30);
  return {
    emailNotificationsEnabled: settingValue(settings, "emailNotificationsEnabled") !== "false",
    notificationEmail: settingValue(settings, "notificationEmail"),
    coachEmail: settingValue(settings, "coachEmail"),
    replyToEmail: settingValue(settings, "replyToEmail"),
    notificationDelaySeconds: Number.isFinite(delaySeconds)
      ? Math.max(30, Math.min(3600, delaySeconds))
      : 30,
    sendClientEmail: settingValue(settings, "sendClientEmail") !== "false",
    sendCoachEmail: settingValue(settings, "sendCoachEmail") !== "false",
    sendAdminEmail: settingValue(settings, "sendAdminEmail") !== "false",
    sendLessonTypeChangeEmail: settingValue(settings, "sendLessonTypeChangeEmail") === "true",
    reminderEnabled: settingValue(settings, "reminderEnabled") === "true",
    reminderLeadMinutes: cleanReminderLeadMinutes(settingValue(settings, "reminderLeadMinutes")),
    clientEmailSubject:
      settingValue(settings, "clientEmailSubject") ||
      defaultEmailTemplates.clientEmailSubject,
    clientEmailIntro:
      settingValue(settings, "clientEmailIntro") ||
      defaultEmailTemplates.clientEmailIntro,
    clientEmailFooter: modernClientEmailFooter(
      settingValue(settings, "clientEmailFooter") ||
        defaultEmailTemplates.clientEmailFooter,
    ),
    adminEmailSubject:
      settingValue(settings, "adminEmailSubject") ||
      defaultEmailTemplates.adminEmailSubject,
    adminEmailIntro:
      settingValue(settings, "adminEmailIntro") ||
      defaultEmailTemplates.adminEmailIntro,
    smsProviderName: settingValue(settings, "smsProviderName"),
    smsWebhookUrl: settingValue(settings, "smsWebhookUrl"),
    smsFromNumber: settingValue(settings, "smsFromNumber"),
    sendClientSms: settingValue(settings, "sendClientSms") === "true",
    sendAdminSms: settingValue(settings, "sendAdminSms") === "true",
    ...playerBookingEmbedFromSettings(settings),
  };
}

/**
 * The two outlines a booking card can wear: a border once the lesson is done,
 * and a ring while a bay is held for it. The fill is not here — that is the
 * lesson type's own colour, stored on the service in servicesJson.
 */
export const defaultCalendarColors = {
  statusCompleted: "#7f8a80",
  statusBayBooked: "#e08a2e",
};

export function cleanCalendarColors(colors) {
  const cleaned = {};
  for (const [key, fallback] of Object.entries(defaultCalendarColors)) {
    cleaned[key] = cleanHexColor(colors?.[key], fallback);
  }
  return cleaned;
}

export function brandSettingsFromSettings(settings, account) {
  return {
    coachName: settingValue(settings, "coachName") || account.businessName,
    logoName: settingValue(settings, "brandLogoName"),
    logoPreview: settingValue(settings, "brandLogoPreview"),
    showLogo: settingValue(settings, "brandShowLogo") === "true",
    neutral: settingValue(settings, "brandNeutral") || "#ffffff",
    primary: settingValue(settings, "brandPrimary") || "#1fd36d",
    secondary: settingValue(settings, "brandSecondary") || "#d7b06b",
    accent: settingValue(settings, "brandAccent") || "#07100a",
    bookingTheme:
      settingValue(settings, "brandBookingTheme") === "light" ? "light" : "dark",
    calendarColors: cleanCalendarColors(
      parseSettingJson(settings, "brandCalendarColorsJson", defaultCalendarColors),
    ),
  };
}

export function workspaceAccountsFromSettings(settings, account) {
  return normalizeWorkspaceAccounts(
    parseSettingJson(settings, "workspaceAccountsJson", []),
    account,
  );
}

export function coachProfilesFromSettings(settings, account) {
  return normalizeCoachProfiles(
    parseSettingJson(settings, "coachProfilesJson", null),
    account,
  );
}

export function appUsersFromSettings(settings, account) {
  const users = parseSettingJson(settings, "appUsersJson", []);
  return Array.isArray(users) && users.length ? users : [defaultAppUserFromAccount(account)];
}

export function locationsFromSettings(settings, account) {
  return normalizeLocations(
    parseSettingJson(settings, "locationsJson", []),
    account,
  );
}

/**
 * A business's bookable hours.
 *
 * defaultAvailability is the original coach's actual working week, so a new
 * business starts closed rather than advertising somebody else's evenings.
 */
export function availabilityFromSettings(settings, accountId = "") {
  const scopedAccountId = cleanSlug(settingValue(settings, "accountId") || accountId, "");
  const seed =
    !scopedAccountId || isOriginalWorkspace(scopedAccountId) ? defaultAvailability : [[], [], [], [], [], [], []];
  // availabilityJson is a per-account settings row, so every window in it
  // belongs to the business whose row was read. Windows saved before accountId
  // was stamped on write (and the seeded defaults) carry no accountId; file
  // them under that account so the strict account filters keep them.
  const ownerAccountId = cleanSlug(accountId, "") || scopedAccountId;
  return normalizeAvailability(parseSettingJson(settings, "availabilityJson", seed)).map((dayWindows) =>
    dayWindows.map((window) =>
      window.accountId || !ownerAccountId ? window : { ...window, accountId: ownerAccountId },
    ),
  );
}

export function modernClientEmailFooter(value, language = "en") {
  const mt = messageText(language);
  const footer = cleanString(value, "", 900);
  const legacyChangeFooter =
    /need to (move|change)|reply to this email.*(move|change|reschedul)|email.*(move|change|reschedul)/i.test(
      footer,
    );
  return footer && !legacyChangeFooter
    ? footer
    : mt("We look forward to seeing you.");
}

/** The business as the public booking page sees it. */
export function stateFromSettings(settingsMap, accountId) {
  const account = coachAccountFromSettings(settingsMap, accountId);
  return {
    accountId,
    account,
    services: servicesFromSettings(settingsMap, accountId),
    workspaceAccounts: workspaceAccountsFromSettings(settingsMap, account),
    coaches: coachProfilesFromSettings(settingsMap, account),
    locations: locationsFromSettings(settingsMap, account),
    availability: availabilityFromSettings(settingsMap, accountId),
    brand: brandSettingsFromSettings(settingsMap, account),
  };
}

/** stateFromSettings plus what only a signed-in coach is sent. */
export function adminStateFromSettings(settingsMap, accountId) {
  const state = stateFromSettings(settingsMap, accountId);
  return {
    ...state,
    currentUser: appUsersFromSettings(settingsMap, state.account)[0],
    settings: adminSettingsFromSettings(settingsMap),
  };
}

/**
 * The signed-in coach as the app sees them: the app-user role vocabulary, and
 * permissions from their membership rather than anything saved in settings.
 * Sent with the session answer and again with every calendar load, so both
 * build it here.
 */
export function coachUserForMembership(membership: CoachActor, coaches, coachName: string) {
  return {
    id: membership.authUserId,
    accountId: membership.accountId,
    name: coachName,
    role: appUserRoleForMembership(membership.role),
    coachId: ownCoachIdFor(membership, coaches, membership.accountId) || undefined,
    permissions: membership.isAdmin
      ? { bookings: "all", services: "all", availability: "all", locations: "all", clients: "all", settings: "all" }
      : { bookings: "own", services: "own", availability: "own", locations: "none", clients: "own", settings: "none" },
  };
}

/** The calendar state as it goes to the coach app: only the known keys. */
export function publicCalendarState(state) {
  return {
    syncKey: state.syncKey,
    updatedAt: state.updatedAt,
    items: state.items,
    services: state.services || [],
    workspaceAccounts: state.workspaceAccounts || [],
    currentUser: state.currentUser || null,
    coaches: state.coaches || [],
    locations: state.locations || [],
    availability: state.availability || [],
    people: state.people || [],
    notifications: state.notifications || [],
    settings: state.settings,
    brand: state.brand,
    account: state.account,
    googleCalendarSync: state.googleCalendarSync,
    diagnostics: state.diagnostics,
  };
}
