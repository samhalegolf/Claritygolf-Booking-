import { useEffect, useMemo, useState } from "react";
import { resolveMarket } from "../../../netlify/functions/_shared/market-profile.mts";
import { setActiveRegion } from "../../lib/activeCountry";
import { publishActiveMarket } from "../../lib/activeMarket";
import { isManagedService } from "../../serviceCatalog";
import { AvailabilityWindow, CalendarItem, defaultAvailability } from "../calendar/calendarModel";
import type { Session } from "../auth/session";
import { BOOKING_SCREENS } from "../public-booking/bookingScreens";
import { Service } from "../services/serviceModel";
import { WORKSPACE_ACCOUNTS_STORAGE_KEY } from "../shared/workspaceStorage";
import {
  accountById,
  accountEntitlements,
  accountFeatureKeys,
  AppUser,
  BRAND_STORAGE_KEY,
  BrandSettings,
  canUseFeature,
  cleanCoachProfiles,
  cleanLocations,
  cleanWorkspaceAccounts,
  COACH_ACCOUNT_STORAGE_KEY,
  CoachAccount,
  CoachProfile,
  defaultAccountId,
  defaultAppUserFromCoachAccount,
  defaultLocationFromCoachAccount,
  defaultLocationId,
  defaultWorkspaceAccountFromCoachAccount,
  filterRecordsForAccount,
  firstCoachId,
  getStoredBrandSettings,
  getStoredCoachAccount,
  getStoredWorkspaceAccounts,
  Location,
  locationById,
  recordBelongsToAccount,
  serviceBelongsToAccount,
  userBelongsToAccount,
  WorkspaceAccount,
  workspaceBootstrapFromSession,
} from "./workspaceModel";

/**
 * The business's own data as the coach app holds it: the account and its
 * words and modules, the workspace accounts, coaches, users and brand, and the
 * bookings, lesson types, locations and opening hours -- plus what is worked
 * out from them alone, such as this business's coaches.
 *
 * Seeded from the session answer when there is one, so the first render is
 * already the right business. useWorkspaceSync loads and saves it.
 */
export function useWorkspaceData({ entrySession }: { entrySession: Session }) {
  // What the session answer said about this workspace, if it said anything.
  // It seeds the state below so the frame is right on the first render; the
  // stored copies from the last visit are the fallback, and the calendar shell
  // overwrites all of it when it answers.
  const [bootstrap] = useState(() => workspaceBootstrapFromSession(entrySession));
  const [coachAccount, setCoachAccount] = useState<CoachAccount>(() => bootstrap?.account ?? getStoredCoachAccount());
  // The business's words and the modules it shows. Everything below asks
  // `capabilities.x` and reads `terms.x`; nothing asks which industry it is.
  const market = useMemo(
    () => resolveMarket(coachAccount.market, coachAccount.terminology),
    [coachAccount.market, coachAccount.terminology],
  );
  const terms = market.terminology;
  const capabilities = market.capabilities;
  useEffect(() => {
    publishActiveMarket(market);
  }, [market]);
  useEffect(() => {
    document.title = market.product.documentTitle;
  }, [market.product.documentTitle]);
  // Contact matching and phone formatting resolve bare national numbers against
  // the workspace's country. The server does the same, from the same setting —
  // if these two ever disagree, the client and server disagree about whether
  // two numbers belong to the same person, which is what produced duplicate
  // contacts and the failed saves.
  // Money is shown in the currency the business chose, which is its country's
  // unless it picked another in Country & region.
  useEffect(() => {
    setActiveRegion(coachAccount.country, coachAccount.invoiceSettings.currency);
  }, [coachAccount.country, coachAccount.invoiceSettings.currency]);
  const [workspaceAccounts, setWorkspaceAccounts] = useState<WorkspaceAccount[]>(() =>
    bootstrap?.accounts ?? cleanWorkspaceAccounts(getStoredWorkspaceAccounts(), getStoredCoachAccount()),
  );
  const [coachProfiles, setCoachProfiles] = useState<CoachProfile[]>(
    () => bootstrap?.coaches ?? cleanCoachProfiles(undefined, getStoredCoachAccount()),
  );
  const [currentAppUser, setCurrentAppUser] = useState<AppUser>(
    () => bootstrap?.currentUser ?? defaultAppUserFromCoachAccount(getStoredCoachAccount()),
  );
  const [brandSettings, setBrandSettings] = useState<BrandSettings>(getStoredBrandSettings);
  const [items, setItems] = useState<CalendarItem[]>([]);
  // Empty until the server says otherwise. Seeding this with defaultServices
  // meant every workspace flashed the original coach's lesson list and prices
  // before its own data arrived.
  const [services, setServices] = useState<Service[]>(() => []);
  const [locations, setLocations] = useState<Location[]>(() => cleanLocations(undefined, getStoredCoachAccount()));
  const [availability, setAvailability] = useState<AvailabilityWindow[][]>(() => defaultAvailability);
  const activeAccountId = defaultAccountId(workspaceAccounts);
  const activeAccount =
    accountById(workspaceAccounts, activeAccountId) ?? defaultWorkspaceAccountFromCoachAccount(coachAccount);
  const isAdminUser = currentAppUser.role === "admin" || currentAppUser.role === "account_admin" || currentAppUser.role === "platform_admin";
  // Running Clarity, as distinct from running a business on it.
  const isPlatformAdmin = currentAppUser.role === "platform_admin";
  const accountCoachProfiles = useMemo(() => filterRecordsForAccount(coachProfiles, activeAccountId), [activeAccountId, coachProfiles]);
  const accountLocations = useMemo(() => filterRecordsForAccount(locations, activeAccountId), [activeAccountId, locations]);
  const activeCoachId = currentAppUser.coachId || firstCoachId(accountCoachProfiles);
  const fallbackCoachId = firstCoachId(accountCoachProfiles);
  // The signed-in person's own coach profile, if they coach: what the profile
  // page shows. An owner who only runs the business has none.
  const ownCoachProfile = currentAppUser.coachId
    ? accountCoachProfiles.find((coach) => coach.id === currentAppUser.coachId)
    : undefined;
  const activeCoachList = accountCoachProfiles.filter((coach) => coach.active && !coach.archived && coach.bookable);
  const accountAvailability = useMemo(
    () => availability.map((dayWindows) => dayWindows.filter((window) => recordBelongsToAccount(window, activeAccountId))),
    [activeAccountId, availability],
  );
  const accountServices = services.filter((service) => serviceBelongsToAccount(service, activeAccountId));
  const managedAccountServices = accountServices.filter(isManagedService);
  const sortedLocations = [...accountLocations].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
  const activeLocationList = sortedLocations.filter((location) => location.active && !location.archived);
  const archivedLocationList = sortedLocations.filter((location) => location.archived || !location.active);
  const defaultLocation = locationById(accountLocations, defaultLocationId(accountLocations)) ?? defaultLocationFromCoachAccount(coachAccount);
  const publicBookingEnabled = canUseFeature(activeAccount, "publicBooking");
  const invoiceSettings = coachAccount.invoiceSettings;
  const billingWorkspaceEnabled = invoiceSettings.enabled && invoiceSettings.showBillingWorkspace && canUseFeature(activeAccount, "invoicing");
  const googleCalendarSyncEnabled = canUseFeature(activeAccount, "googleCalendarSync");
  const activeAccountEntitlements = accountEntitlements(activeAccount);
  const accountUsage = {
    maxCoaches: activeCoachList.length,
    maxLocations: activeLocationList.length,
    maxUsers: userBelongsToAccount(currentAppUser, activeAccountId) ? 1 : 0,
    maxServices: managedAccountServices.filter((service) => service.archived !== true).length,
    maxBookingScreens: BOOKING_SCREENS.length,
  };
  const enabledAccountFeatures = accountFeatureKeys.filter((feature) => activeAccountEntitlements.features[feature]);

  // The booking widget only ever holds the public view of the account (see
  // public-account.mts). Storing it would overwrite a coach's own saved copy
  // in the same browser with a thinner one.
  useEffect(() => {
    window.localStorage.setItem(COACH_ACCOUNT_STORAGE_KEY, JSON.stringify(coachAccount));
  }, [coachAccount]);

  useEffect(() => {
    window.localStorage.setItem(WORKSPACE_ACCOUNTS_STORAGE_KEY, JSON.stringify(workspaceAccounts));
  }, [workspaceAccounts]);

  useEffect(() => {
    window.localStorage.setItem(BRAND_STORAGE_KEY, JSON.stringify(brandSettings));
  }, [brandSettings]);

  return {
    coachAccount,
    setCoachAccount,
    market,
    terms,
    capabilities,
    setWorkspaceAccounts,
    coachProfiles,
    setCoachProfiles,
    currentAppUser,
    setCurrentAppUser,
    brandSettings,
    setBrandSettings,
    items,
    setItems,
    services,
    setServices,
    locations,
    setLocations,
    availability,
    setAvailability,
    activeAccountId,
    activeAccount,
    isAdminUser,
    isPlatformAdmin,
    accountCoachProfiles,
    accountLocations,
    activeCoachId,
    fallbackCoachId,
    ownCoachProfile,
    activeCoachList,
    accountAvailability,
    managedAccountServices,
    activeLocationList,
    archivedLocationList,
    defaultLocation,
    publicBookingEnabled,
    invoiceSettings,
    billingWorkspaceEnabled,
    googleCalendarSyncEnabled,
    activeAccountEntitlements,
    accountUsage,
    enabledAccountFeatures,
  };
}

export type WorkspaceData = ReturnType<typeof useWorkspaceData>;
