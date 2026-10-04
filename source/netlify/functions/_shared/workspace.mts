import { legacyOriginalWorkspaceId } from "./account.mts";
import { cleanCoachAccount, defaultCoachAccount, defaultTimeZone } from "./coach-account.mts";
import { recordBelongsToAccountStrict } from "./coach-auth.mts";
import { accountPlanCatalog } from "./permissions.mts";
import { cleanLocationKind, cleanLocationResources, cleanResourceSource } from "./resources.mts";
import { getSetting } from "./settings-store.mts";
import { cleanEmail, cleanSlug, cleanString, cleanUrl } from "./values.mts";

/**
 * The business itself: its account record, its coaches and its locations.
 *
 * Bookings and lesson types both point at a coach and a location, so this sits
 * underneath them. It is read from settings and cleaned here, so the rest of
 * the API can trust the shape.
 */

// A coach photo: either a link, or a small image uploaded from the coach
// profile screen and kept as a data URL beside the coach (like the logo).
const COACH_PHOTO_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
export function cleanCoachPhoto(value) {
  if (typeof value === "string" && value.startsWith("data:image/")) {
    return value.length <= 200_000 && COACH_PHOTO_DATA_URL.test(value) ? value : "";
  }
  return cleanUrl(value, "");
}

function defaultWorkspaceAccountFromCoachAccount(account = defaultCoachAccount()) {
  const clean = cleanCoachAccount(account);
  const slug = cleanSlug(clean.calendarSlug || clean.businessName, legacyOriginalWorkspaceId());
  return {
    id: slug,
    name: clean.businessName,
    slug,
    planKey: "founder",
    subscriptionStatus: "comped",
    billingProvider: "none",
    active: true,
  };
}

function cleanWorkspaceAccount(raw = {}, fallback = defaultWorkspaceAccountFromCoachAccount()) {
  const name = cleanString(raw?.name, fallback.name, 120);
  const slug = cleanSlug(raw?.slug || raw?.id || name, fallback.slug);
  const planKey = accountPlanCatalog[raw?.planKey] ? raw.planKey : fallback.planKey;
  const subscriptionStatus = ["trialing", "active", "past_due", "paused", "cancelled", "comped", "internal"].includes(raw?.subscriptionStatus)
    ? raw.subscriptionStatus
    : fallback.subscriptionStatus;
  return {
    id: cleanSlug(raw?.id, slug),
    name,
    slug,
    planKey,
    subscriptionStatus,
    ownerUserId: cleanString(raw?.ownerUserId, fallback.ownerUserId || "", 120) || undefined,
    billingProvider: ["stripe", "manual", "none"].includes(raw?.billingProvider) ? raw.billingProvider : fallback.billingProvider,
    billingCustomerId: cleanString(raw?.billingCustomerId, "", 160) || undefined,
    billingSubscriptionId: cleanString(raw?.billingSubscriptionId, "", 160) || undefined,
    trialEndsAt: cleanString(raw?.trialEndsAt, "", 80) || undefined,
    currentPeriodEndsAt: cleanString(raw?.currentPeriodEndsAt, "", 80) || undefined,
    entitlementsOverride: raw?.entitlementsOverride && typeof raw.entitlementsOverride === "object" ? raw.entitlementsOverride : undefined,
    active: raw?.active !== false,
    createdAt: cleanString(raw?.createdAt, fallback.createdAt || "", 80) || undefined,
    updatedAt: cleanString(raw?.updatedAt, fallback.updatedAt || "", 80) || undefined,
  };
}

export function normalizeWorkspaceAccounts(rawAccounts, account = defaultCoachAccount()) {
  const fallback = defaultWorkspaceAccountFromCoachAccount(account);
  const source = Array.isArray(rawAccounts) && rawAccounts.length ? rawAccounts : [fallback];
  const seen = new Set();
  return source.map((raw, index) => {
    const clean = cleanWorkspaceAccount(raw, index === 0 ? fallback : defaultWorkspaceAccountFromCoachAccount(account));
    let id = clean.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${clean.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return { ...clean, id, active: clean.active || index === 0 };
  });
}

export function defaultLocationFromCoachAccount(account = defaultCoachAccount()) {
  const clean = cleanCoachAccount(account);
  const workspaceAccount = defaultWorkspaceAccountFromCoachAccount(clean);
  return {
    id: "default-location",
    accountId: workspaceAccount.id,
    name: clean.venueName,
    shortName: clean.venueShortName || clean.venueName,
    address: "",
    timezone: clean.timezone,
    active: true,
    archived: false,
    isDefault: true,
    sortOrder: 0,
  };
}

export function defaultCoachProfileFromAccount(account = defaultCoachAccount()) {
  const clean = cleanCoachAccount(account);
  const workspaceAccount = defaultWorkspaceAccountFromCoachAccount(clean);
  return {
    id: clean.id || legacyOriginalWorkspaceId(),
    accountId: workspaceAccount.id,
    name: clean.coachName,
    displayName: clean.coachName || clean.businessName,
    shortName: clean.coachName.split(/\s+/)[0] || "",
    email: clean.contactEmail,
    active: true,
    archived: false,
    bookable: true,
    assignedLocationIds: ["default-location"],
    defaultLocationId: "default-location",
    sortOrder: 0,
  };
}

export function defaultAppUserFromAccount(account = defaultCoachAccount()) {
  const coach = defaultCoachProfileFromAccount(account);
  const workspaceAccount = defaultWorkspaceAccountFromCoachAccount(account);
  return {
    id: `${coach.id}-admin`,
    accountId: workspaceAccount.id,
    email: coach.email,
    name: coach.displayName,
    role: "admin",
    coachId: coach.id,
    permissions: {
      bookings: "all",
      services: "all",
      availability: "all",
      locations: "all",
      clients: "all",
      settings: "all",
    },
  };
}

function cleanCoachProfile(raw = {}, fallback = defaultCoachProfileFromAccount(), index = 0) {
  const name = cleanString(raw?.name, fallback.name, 120);
  return {
    id: cleanSlug(raw?.id, cleanSlug(name, `coach-${index + 1}`)),
    // The fallback is the caller's account (via `fallback`), never the original
    // workspace: a coach profile whose stored accountId is missing belongs to
    // the business being read, not to Sam Hale Golf.
    accountId: cleanSlug(raw?.accountId, fallback.accountId || ""),
    name,
    displayName: cleanString(raw?.displayName, name, 120),
    shortName: cleanString(raw?.shortName, name.split(/\s+/).map((part) => part[0]).join("").slice(0, 4).toUpperCase(), 60),
    email: cleanEmail(raw?.email, fallback.email),
    phone: cleanString(raw?.phone, "", 80) || undefined,
    bio: cleanString(raw?.bio, "", 600) || undefined,
    photoUrl: cleanCoachPhoto(raw?.photoUrl) || undefined,
    active: raw?.active !== false,
    archived: raw?.archived === true,
    bookable: raw?.bookable !== false,
    assignedLocationIds: Array.isArray(raw?.assignedLocationIds)
      ? raw.assignedLocationIds.map((id) => cleanSlug(id, "")).filter(Boolean)
      : fallback.assignedLocationIds,
    defaultLocationId: cleanSlug(raw?.defaultLocationId, raw?.assignedLocationIds?.[0] || fallback.assignedLocationIds?.[0] || "") || undefined,
    sortOrder: Number.isFinite(Number(raw?.sortOrder)) ? Math.round(Number(raw.sortOrder)) : index,
  };
}

/**
 * A business's coaches, exactly as stored. Only a business that has never
 * saved a coach list is seeded, with the owner's coach profile; a saved empty
 * list means the owner runs the business without coaching and is kept empty.
 * A business with no bookable coach simply shows no availability.
 */
export function normalizeCoachProfiles(rawProfiles, account = defaultCoachAccount()) {
  const seeded = !Array.isArray(rawProfiles);
  const fallback = defaultCoachProfileFromAccount(account);
  const source = seeded ? [fallback] : rawProfiles;
  const seen = new Set();
  const cleaned = source.map((raw, index) => {
    const coach = cleanCoachProfile(raw, seeded ? fallback : blankCoachProfile(fallback.accountId), index);
    let id = coach.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${coach.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return { ...coach, id };
  });
  return cleaned.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.displayName.localeCompare(b.displayName));
}

// What a stored coach is missing is left blank, never borrowed from the
// business: a coach's name and email are their own.
function blankCoachProfile(accountId = "") {
  return { ...defaultCoachProfileFromAccount(), id: "", accountId, name: "", displayName: "", shortName: "", email: "" };
}

/**
 * The signed-in person's own coach profile, or "" when they have none. The
 * owner's is the one seeded with the business (its id is the account id)
 * until their membership names one; an owner who deleted theirs has none and
 * is never handed another coach's calendar. Anyone else keeps the old
 * first-coach fallback.
 */
export function ownCoachIdFor(actor, coaches, accountId) {
  const live = (id) => (id && coaches.some((coach) => coach.id === id) ? id : "");
  if (live(actor?.coachId)) return actor.coachId;
  if (actor?.isOwner) return live(cleanSlug(accountId, ""));
  return firstCoachId(coaches);
}

/**
 * The coach a record that names none belongs to: the first active coach in
 * the business's list. There is no "default coach" setting -- lesson types,
 * bookings and availability all name their coach -- so this only decides
 * where rows saved before that are shown.
 */
export function firstCoachId(coaches) {
  return (
    coaches.find((coach) => coach.active && !coach.archived)?.id ||
    coaches[0]?.id ||
    ""
  );
}

export function coachById(coaches, id) {
  if (!id) return null;
  return (coaches || []).find((coach) => coach.id === id) || null;
}

export function coachSnapshot(coach) {
  return {
    coachId: coach.id,
    name: coach.name,
    displayName: coach.displayName,
    email: coach.email || undefined,
    phone: coach.phone || undefined,
  };
}

function cleanLocation(raw = {}, fallback = defaultLocationFromCoachAccount(), index = 0) {
  const name = cleanString(raw?.name, fallback.name, 140);
  const shortName = cleanString(raw?.shortName, name, 80);
  return {
    id: cleanSlug(raw?.id, cleanSlug(name, `location-${index + 1}`)),
    // As cleanCoachProfile: the caller's account, not the original workspace.
    accountId: cleanSlug(raw?.accountId, fallback.accountId || ""),
    name,
    shortName,
    // An online location has no address; without this the first location
    // would inherit the venue's.
    address: cleanLocationKind(raw?.kind) === "online" ? "" : cleanString(raw?.address, fallback.address || "", 240),
    mapUrl: cleanUrl(raw?.mapUrl, "", 300) || undefined,
    arrivalInstructions: cleanString(raw?.arrivalInstructions, "", 500) || undefined,
    publicNotes: cleanString(raw?.publicNotes, "", 500) || undefined,
    timezone: cleanString(raw?.timezone, fallback.timezone, 80),
    // Physical or online, and the bays or rooms it has. See _shared/resources.mts.
    kind: cleanLocationKind(raw?.kind),
    resourceSource: cleanResourceSource(raw?.resourceSource),
    resources: cleanLocationResources(raw?.resources),
    active: raw?.active !== false,
    archived: raw?.archived === true,
    isDefault: raw?.isDefault === true || fallback.isDefault === true,
    sortOrder: Number.isFinite(Number(raw?.sortOrder)) ? Math.round(Number(raw.sortOrder)) : index,
  };
}

export function normalizeLocations(rawLocations, account = defaultCoachAccount()) {
  const fallback = defaultLocationFromCoachAccount(account);
  const source = Array.isArray(rawLocations) && rawLocations.length ? rawLocations : [fallback];
  const seen = new Set();
  const cleaned = source.map((raw, index) => {
    const location = cleanLocation(raw, index === 0 ? fallback : undefined, index);
    let id = location.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${location.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return { ...location, id };
  });
  if (!cleaned.some((location) => location.active && !location.archived)) {
    cleaned[0] = { ...cleaned[0], active: true, archived: false };
  }
  const defaultIndex = cleaned.findIndex((location) => location.isDefault && location.active && !location.archived);
  const fallbackDefaultIndex = defaultIndex >= 0 ? defaultIndex : cleaned.findIndex((location) => location.active && !location.archived);
  return cleaned
    .map((location, index) => ({ ...location, isDefault: index === fallbackDefaultIndex }))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
}

function activeLocations(locations) {
  return (locations || []).filter((location) => location.active && !location.archived);
}

export function defaultLocationId(locations) {
  return activeLocations(locations).find((location) => location.isDefault)?.id || activeLocations(locations)[0]?.id || locations?.[0]?.id || "";
}

export function locationById(locations, id) {
  if (!id) return null;
  return (locations || []).find((location) => location.id === id) || null;
}

export function locationSnapshot(location) {
  return {
    locationId: location.id,
    name: location.name,
    shortName: location.shortName,
    address: location.address || undefined,
    mapUrl: location.mapUrl || undefined,
    arrivalInstructions: location.arrivalInstructions || undefined,
    publicNotes: location.publicNotes || undefined,
    timezone: location.timezone || undefined,
  };
}

export function filterCoachesForContext(coaches, context) {
  if (context.isAdmin) return (coaches || []).filter((coach) => recordBelongsToAccountStrict(coach, context.accountId));
  return (coaches || []).filter((coach) => recordBelongsToAccountStrict(coach, context.accountId) && coach.id === context.coachId);
}

export function filterLocationsForContext(locations, context, coaches = []) {
  const accountLocations = (locations || []).filter((location) => recordBelongsToAccountStrict(location, context.accountId));
  if (context.isAdmin) return accountLocations;
  const coach = (coaches || []).find((candidate) => candidate.id === context.coachId);
  const assigned = new Set([...(coach?.assignedLocationIds || []), coach?.defaultLocationId].filter(Boolean));
  return accountLocations.filter((location) => assigned.has(location.id) || location.isDefault);
}

/**
 * The timezone a business's wall-clock times are in.
 *
 * One key rather than readSettingsMap(): the bulk settings read is measured in
 * tens of kilobytes and some of these paths run per request. Mirrors
 * accountPhoneCountry() below, for the same reason.
 */
export async function accountTimeZoneFor(accountId: string) {
  return (
    cleanString(await getSetting(cleanSlug(accountId, ""), "accountTimezone"), "", 80) ||
    defaultTimeZone()
  );
}
