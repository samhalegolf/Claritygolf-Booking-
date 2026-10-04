import { type Dispatch, type RefObject, type SetStateAction, useEffect, useRef, useState } from "react";
import type { AuthStatus } from "../auth/authStatus";
import { t } from "../../lib/i18n";
import { whenIdle } from "../../lib/idle";
import {
  AvailabilityWindow,
  type CalendarFeedStatus,
  CalendarItem,
  calendarItemsEquivalent,
  type CalendarSaveStatus,
  calendarStateFingerprint,
  cleanAvailability,
  mergeCalendarItemsAfterConflict,
} from "../calendar/calendarModel";
import { cleanPeople } from "../clients/clientMatching";
import type { Person } from "../clients/clientsModel";
import { prefetchIntegrations } from "../integrations/integrationsStore";
import { cleanNotificationRecords, NotificationRecord } from "../notifications/notificationModel";
import { NotificationSettings } from "../notifications/notificationSettings";
import { cleanServices, Service } from "../services/serviceModel";
import type { Toast } from "../shared/toast";
import {
  AppUser,
  BrandSettings,
  cleanAppUser,
  cleanCoachProfiles,
  cleanLocations,
  cleanWorkspaceAccounts,
  CoachAccount,
  CoachProfile,
  defaultAccountId,
  defaultAppUserFromCoachAccount,
  Location,
  WorkspaceAccount,
} from "./workspaceModel";
import {
  AdminSaveOwner,
  AdminWorkspaceLoadStatus,
  CalendarStateSaveResponse,
  generateSyncKey,
  WorkspaceApiFailureDetail,
  WorkspaceConfigDiagnostic,
  WorkspaceConfigRecord,
} from "./workspaceSyncModel";
import type { WorkspaceData } from "./useWorkspaceData";
import type { Diagnostics } from "../diagnostics/useDiagnostics";
import type { CalendarState } from "../calendar/useCalendarState";

/**
 * Loading the workspace from the server and saving it back: the calendar
 * shell and the admin details that follow it, item and location writes,
 * and the save/load status the frame shows. Everything it changes lives in
 * the workspace data; what it hands back to App (notification settings,
 * people, Google status) comes in as callbacks.
 */
export function useWorkspaceSync({
  workspace,
  diagnostics,
  calendarState,
  calendarFrameRenderedRef,
  bookingCardsFirstRenderedRef,
  bookingCardsHydratedRef,
  refreshPeopleList,
  refreshLessonNotes,
  refreshPortalPlayers,
  setPeople,
  setNotifications,
  applyNotificationSettings,
  applyCoachAccount,
  applyBrandSettings,
  notificationSettingsDraftVersionRef,
  refreshNotificationHistory,
  refreshGoogleCalendarStatus,
  authStatus,
  setAuthStatus,
  setToast,
  scheduleAdminNotificationDebounceFlush,
  watchBayHold,
  setLocationEditorError,
}: {
  workspace: WorkspaceData;
  diagnostics: Diagnostics;
  calendarState: CalendarState;
  calendarFrameRenderedRef: RefObject<boolean>;
  bookingCardsFirstRenderedRef: RefObject<boolean>;
  bookingCardsHydratedRef: RefObject<boolean>;
  refreshPeopleList: (options?: { maxAgeMs?: number }) => Promise<void>;
  refreshLessonNotes: (options?: { maxAgeMs?: number }) => Promise<void>;
  refreshPortalPlayers: () => Promise<void>;
  setPeople: (items: Person[]) => void;
  setNotifications: Dispatch<SetStateAction<NotificationRecord[]>>;
  applyNotificationSettings: (settings?: Partial<NotificationSettings>) => void;
  applyCoachAccount: (account?: Partial<CoachAccount>) => void;
  applyBrandSettings: (settings?: Partial<BrandSettings>) => void;
  notificationSettingsDraftVersionRef: RefObject<number>;
  refreshNotificationHistory: () => Promise<void>;
  refreshGoogleCalendarStatus: () => Promise<void>;
  authStatus: AuthStatus;
  setAuthStatus: (next: AuthStatus) => void;
  setToast: Dispatch<SetStateAction<Toast | null>>;
  scheduleAdminNotificationDebounceFlush: () => void;
  watchBayHold: (itemId: string, changedAtMs: number, reason: "move" | "new") => Promise<void>;
  setLocationEditorError: Dispatch<SetStateAction<string>>;
}) {
  const {
    items,
    activeAccountId,
    setItems,
    coachAccount,
    setWorkspaceAccounts,
    setServices,
    setLocations,
    setCoachProfiles,
    setCurrentAppUser,
    setAvailability,
    locations,
    coachProfiles,
    isPlatformAdmin,
  } = workspace;
  const {
    startDiagnosticTimer,
    finishDiagnosticTimer,
    trackDiagnosticEvent,
    trackDiagnosticMilestone,
  } = diagnostics;
  const { activeWeek } = calendarState;
  const [adminWorkspaceLoadStatus, setAdminWorkspaceLoadStatus] =
    useState<AdminWorkspaceLoadStatus>("idle");
  const [adminWorkspaceLoadError, setAdminWorkspaceLoadError] = useState("");
  const [locationSaveState, setLocationSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [calendarSyncKey, setCalendarSyncKey] = useState(generateSyncKey);
  const [calendarFeedStatus, setCalendarFeedStatus] = useState<CalendarFeedStatus>("checking");
  const [calendarSaveStatus, setCalendarSaveStatus] = useState<CalendarSaveStatus>("idle");
  const [calendarSaveError, setCalendarSaveError] = useState("");
  // Which kind of change the "failed" banner is describing. An autosave failure
  // really is retried on the next change; a failed delete is rolled back and
  // must be clicked again, so the banner has to say different things.
  const [calendarSaveFailureKind, setCalendarSaveFailureKind] = useState<"change" | "delete">("change");
  const [calendarStateVersion, setCalendarStateVersion] = useState("");
  const hasLoadedCalendarApiRef = useRef(false);
  const adminHydrationRunIdRef = useRef(0);
  const calendarSaveVersionRef = useRef(0);
  const locationSaveVersionRef = useRef(0);
  const coachSaveVersionRef = useRef(0);
  const settingsSaveVersionRef = useRef(0);
  const lastPersistedCalendarFingerprintRef = useRef("");
  const lastPersistedCalendarItemsRef = useRef<CalendarItem[]>([]);
  const activeAdminSaveOwnersRef = useRef<Map<AdminSaveOwner, number>>(new Map());
  const adminBootStartedAtRef = useRef(typeof performance !== "undefined" ? performance.now() : Date.now());

  function hasActiveAdminSave(owner?: AdminSaveOwner) {
    if (owner) return (activeAdminSaveOwnersRef.current.get(owner) ?? 0) > 0;
    return Array.from(activeAdminSaveOwnersRef.current.values()).some((count) => count > 0);
  }

  function beginAdminSave(owner: AdminSaveOwner) {
    activeAdminSaveOwnersRef.current.set(owner, (activeAdminSaveOwnersRef.current.get(owner) ?? 0) + 1);
    adminHydrationRunIdRef.current += 1;
    return ++calendarSaveVersionRef.current;
  }

  function endAdminSave(owner: AdminSaveOwner) {
    const nextCount = (activeAdminSaveOwnersRef.current.get(owner) ?? 0) - 1;
    if (nextCount > 0) {
      activeAdminSaveOwnersRef.current.set(owner, nextCount);
    } else {
      activeAdminSaveOwnersRef.current.delete(owner);
    }
  }

  // The entry point only mounts this component for a coach, having already
  // asked /api/auth/session, so the calendar shell starts at once.
  useEffect(() => {
    void startAdminWorkspaceHydration();
  }, []);

  useEffect(() => {
    if (authStatus !== "authenticated" || !hasLoadedCalendarApiRef.current) return;
    if (hasActiveAdminSave()) return;
    const requestedFingerprint = calendarStateFingerprint(items, calendarSyncKey);
    if (requestedFingerprint === lastPersistedCalendarFingerprintRef.current) return;
    const saveVersion = ++calendarSaveVersionRef.current;
    const desiredItems = items;
    const baselineItems = lastPersistedCalendarItemsRef.current;
    let saveReachedServer = false;
    let sessionExpired = false;
    const timer = startDiagnosticTimer({
      system: "save",
      action: "save_booking_calendar",
      route: "PUT /api/calendar-state",
      functionName: "calendar autosave",
      expectedAccountId: activeAccountId,
      objectType: "calendarState",
      details: { itemCount: items.length },
    });
    setCalendarSaveStatus("saving");
    setCalendarSaveError("");

    const saveTimer = window.setTimeout(() => {
      const saveRequest = (
        requestItems = desiredItems,
        requestSyncKey = calendarSyncKey,
        requestUpdatedAt = calendarStateVersion,
      ) =>
        fetch("/api/calendar-state", {
          method: "PUT",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            items: requestItems,
            replaceItems: true,
            syncKey: requestSyncKey,
            updatedAt: requestUpdatedAt,
          }),
        });
      const readLiveState = () =>
        fetch("/api/calendar-state", {
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
      const retryDelay = (delay = 700) => new Promise((resolve) => window.setTimeout(resolve, delay));
      const saveWithRetries = async (
        requestItems = desiredItems,
        requestSyncKey = calendarSyncKey,
        requestUpdatedAt = calendarStateVersion,
      ) => {
        let lastError: unknown;
        for (const delay of [0, 700, 1400, 2600]) {
          if (delay) await retryDelay(delay);
          try {
            return await saveRequest(requestItems, requestSyncKey, requestUpdatedAt);
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError instanceof Error ? lastError : new Error(t("Calendar save failed."));
      };

      void (async () => {
        let response: Response;
        let submittedItems = desiredItems;
        let submittedSyncKey = calendarSyncKey;
        let submittedUpdatedAt = calendarStateVersion;
        let recoveredData: CalendarStateSaveResponse | null = null;
        let recoveredFromConflict = false;
        try {
          response = await saveWithRetries();
        } catch (networkError) {
          const liveResponse = await readLiveState().catch(() => null);
          if (!liveResponse?.ok) throw networkError;
          recoveredData = (await liveResponse.json().catch(() => ({}))) as CalendarStateSaveResponse;
          if (calendarItemsEquivalent(recoveredData.items, desiredItems)) {
            response = liveResponse;
          } else {
            recoveredData = null;
            response = await saveWithRetries();
          }
        }
        if (calendarSaveVersionRef.current !== saveVersion) return;
        let data = (recoveredData ?? (await response.json().catch(() => ({})))) as CalendarStateSaveResponse;
        // A conflict can recur: our own merged save bumps updatedAt, and a concurrent writer
        // (public booking, Google sync, notification engine) can land again while we retry.
        // Resolving only once meant the second conflict fell straight through to a hard failure.
        for (let conflictAttempt = 0; response.status === 409 && conflictAttempt < 3; conflictAttempt += 1) {
          const liveResponse = await readLiveState();
          const latestData = (await liveResponse.json().catch(() => ({}))) as CalendarStateSaveResponse;
          if (liveResponse.status === 401) {
            sessionExpired = true;
            setAuthStatus("guest");
            throw new Error(latestData.message || t("Admin login expired. Sign in again before editing the calendar."));
          }
          if (!liveResponse.ok || !Array.isArray(latestData.items)) {
            throw new Error(data.message || data.error || t("Calendar save failed because the live calendar could not be reloaded."));
          }
          const mergedItems = mergeCalendarItemsAfterConflict(latestData.items, baselineItems, desiredItems);
          if (!mergedItems) {
            throw new Error(data.message || t("Calendar changed elsewhere. Reload before saving so you do not overwrite live bookings."));
          }
          recoveredFromConflict = true;
          submittedItems = mergedItems;
          submittedSyncKey = typeof latestData.syncKey === "string" ? latestData.syncKey : calendarSyncKey;
          submittedUpdatedAt = typeof latestData.updatedAt === "string" ? latestData.updatedAt : "";
          response = await saveWithRetries(
            mergedItems,
            submittedSyncKey,
            submittedUpdatedAt,
          );
          if (calendarSaveVersionRef.current !== saveVersion) return;
          data = (await response.json().catch(() => ({}))) as CalendarStateSaveResponse;
        }
        if (!response.ok && response.status >= 500) {
          await retryDelay(900);
          response = await saveWithRetries(submittedItems, submittedSyncKey, submittedUpdatedAt);
          if (calendarSaveVersionRef.current !== saveVersion) return;
          data = (await response.json().catch(() => ({}))) as typeof data;
        }
        if (response.status === 401) {
          sessionExpired = true;
          setAuthStatus("guest");
          throw new Error(data.message || t("Admin login expired. Sign in again before editing the calendar."));
        }
        if (!response.ok) throw new Error(data.message || data.error || t("Calendar save failed."));
        saveReachedServer = true;
        setCalendarFeedStatus("connected");
        setCalendarSaveStatus("saved");
        setCalendarSaveError("");
        if (typeof data.updatedAt === "string") setCalendarStateVersion(data.updatedAt);
        const persistedSyncKey = typeof data.syncKey === "string" ? data.syncKey : calendarSyncKey;
        const persistedItems = Array.isArray(data.items) ? data.items : submittedItems;
        lastPersistedCalendarFingerprintRef.current = calendarStateFingerprint(persistedItems, persistedSyncKey);
        lastPersistedCalendarItemsRef.current = persistedItems;
        if (recoveredFromConflict && !calendarItemsEquivalent(persistedItems, desiredItems)) setItems(persistedItems);
        // The server picks each lesson's bay or room during the save. Copy that
        // back onto the cards; resourceId is outside the save fingerprint, so
        // this cannot start another save.
        const savedResourceIds = new Map(
          (Array.isArray(data.items) ? data.items : []).map((item) => [item.id, item.resourceId || ""]),
        );
        if (savedResourceIds.size) {
          setItems((current) => {
            let changed = false;
            const next = current.map((item) => {
              if (!savedResourceIds.has(item.id)) return item;
              const resourceId = savedResourceIds.get(item.id) || "";
              if ((item.resourceId || "") === resourceId) return item;
              changed = true;
              return { ...item, resourceId: resourceId || undefined };
            });
            return changed ? next : current;
          });
        }
        if (typeof data.syncKey === "string" && data.syncKey !== calendarSyncKey) setCalendarSyncKey(data.syncKey);
        if (Array.isArray(data.notifications)) setNotifications(cleanNotificationRecords(data.notifications));
        const clientSyncWarning = Array.isArray(data.warnings)
          ? data.warnings.find((warning) => typeof warning === "string" && warning.trim())
          : "";
        if (clientSyncWarning) setToast({ message: clientSyncWarning });
        finishDiagnosticTimer(timer, "verified", {
          httpStatus: response.status,
          details: {
            persistedItemCount: persistedItems.length,
            notificationCount: Array.isArray(data.notifications) ? data.notifications.length : 0,
          },
        });
        if (data.googleCalendarSync && data.googleCalendarSync.ok === false && data.googleCalendarSync.error) {
          setToast({ message: t("Saved booking calendar, but Google Calendar did not sync: {error}", { error: data.googleCalendarSync.error }) });
        }
        window.setTimeout(() => {
          if (calendarSaveVersionRef.current === saveVersion) setCalendarSaveStatus("idle");
        }, 1800);
        window.setTimeout(() => void refreshNotificationHistory(), 1500);
        window.setTimeout(() => void refreshNotificationHistory(), 8000);
        scheduleAdminNotificationDebounceFlush();
      })().catch((error) => {
        if (calendarSaveVersionRef.current === saveVersion) {
          const message = error instanceof Error ? error.message : t("Calendar save failed.");
          if (saveReachedServer) {
            setCalendarFeedStatus("connected");
            setCalendarSaveStatus("saved");
            setCalendarSaveError("");
            finishDiagnosticTimer(timer, "warning", {
              errorCode: "BOOKING_UPDATE_VERIFY_MISSING",
              humanMessage: t("Calendar saved, but refresh details failed: {message}", { message }),
            });
            setToast({ message: t("Calendar saved, but the page could not refresh all save details: {message}", { message }) });
            window.setTimeout(() => {
              if (calendarSaveVersionRef.current === saveVersion) setCalendarSaveStatus("idle");
            }, 1800);
            return;
          }
          const calmMessage = sessionExpired
            ? message || t("Admin login expired. Sign in again before editing the calendar.")
            : message || t("Your latest calendar change was not saved. Please try again.");
          setCalendarFeedStatus(sessionExpired ? "offline" : "connected");
          setCalendarSaveStatus("failed");
          setCalendarSaveFailureKind("change");
          setCalendarSaveError(calmMessage);
          finishDiagnosticTimer(timer, "failed", {
            errorCode: sessionExpired ? "AUTH_SESSION_MISSING" : "BOOKING_UPDATE_FAILED",
            humanMessage: calmMessage,
          });
          setToast({ message: calmMessage });
        }
      });

    }, 650);

    return () => window.clearTimeout(saveTimer);
  }, [authStatus, calendarSyncKey, items]);


  function workspaceDiagnosticValue(value: unknown) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  async function readApiFailureDetail(response: Response, fallback: string): Promise<WorkspaceApiFailureDetail> {
    const statusText = `${response.status} ${response.statusText}`.trim();
    try {
      const contentType = response.headers.get("Content-Type") || "";
      if (contentType.includes("application/json")) {
        const data = (await response.json()) as {
          message?: unknown;
          error?: unknown;
          details?: unknown;
          failed?: Array<{ name?: unknown; message?: unknown }>;
        };
        const firstFailed = Array.isArray(data.failed) && data.failed[0]
          ? [workspaceDiagnosticValue(data.failed[0].name), workspaceDiagnosticValue(data.failed[0].message)]
              .filter(Boolean)
              .join(": ")
          : "";
        return {
          message: workspaceDiagnosticValue(data.message),
          failed: firstFailed,
          error: workspaceDiagnosticValue(data.error),
          details: workspaceDiagnosticValue(data.details),
          statusText,
        };
      }
      // Not JSON. On Netlify that means the platform answered instead of the
      // function -- a gateway timeout or a crash -- and the body is a full HTML
      // error page. Pasting 280 characters of markup into the settings card is
      // what "a big netlify error" looked like, and it tells the coach nothing.
      const text = (await response.text()).trim();
      const isHtml = /^<(?:!doctype|html)\b/i.test(text);
      if (isHtml) {
        return {
          message:
            response.status === 504 || response.status === 502
              ? t("The server took too long to answer, so it is not clear whether this saved. Reload the page to see what stuck.")
              : t("The server returned an error page instead of a result."),
          statusText,
        };
      }
      return { message: text ? text.slice(0, 280) : fallback, statusText };
    } catch {
      return { message: fallback, statusText };
    }
  }

  function summarizeApiFailureDetail(detail: WorkspaceApiFailureDetail) {
    return [detail.message, detail.failed, detail.error, detail.details, detail.text, detail.statusText].filter(Boolean).join(" · ");
  }

  async function readApiFailure(response: Response, fallback: string) {
    return summarizeApiFailureDetail(await readApiFailureDetail(response, fallback)) || fallback;
  }

  function workspaceRecordName(record: WorkspaceConfigRecord) {
    return record.displayName || record.name || record.id || "unnamed";
  }

  function summarizeWorkspaceRecordIds(records?: WorkspaceConfigRecord[]) {
    if (!Array.isArray(records)) return "not returned";
    if (!records.length) return "none";
    return records.map((record) => record.id || "missing-id").join(", ");
  }

  function summarizeWorkspaceAccountIds(records?: WorkspaceConfigRecord[]) {
    if (!Array.isArray(records)) return "not returned";
    if (!records.length) return "none";
    return Array.from(new Set(records.map((record) => record.accountId || "missing-account"))).join(", ");
  }

  function workspaceRouteStatus(routeLabel: string, diagnostic: WorkspaceConfigDiagnostic) {
    if (routeLabel.startsWith("PUT ")) return diagnostic.putStatus;
    if (routeLabel === "GET /api/calendar-state") return diagnostic.calendarStatus;
    if (routeLabel.startsWith("GET ")) return diagnostic.getStatus;
    return diagnostic.getStatus ?? diagnostic.putStatus ?? diagnostic.calendarStatus;
  }

  function workspaceRouteRecords(routeLabel: string, diagnostic: WorkspaceConfigDiagnostic) {
    if (routeLabel.startsWith("PUT ")) return diagnostic.putRecords;
    if (routeLabel === "GET /api/calendar-state") return diagnostic.calendarRecords;
    if (routeLabel.startsWith("GET ")) return diagnostic.getRecords;
    return diagnostic.getRecords ?? diagnostic.putRecords ?? diagnostic.calendarRecords;
  }

  function normalizeWorkspaceFailureDetail(detail: WorkspaceApiFailureDetail | string): WorkspaceApiFailureDetail {
    return typeof detail === "string" ? { message: detail } : detail;
  }

  function formatWorkspaceSaveFailure(
    label: "Location" | "Coach",
    routeLabel: string,
    stage: string,
    diagnostic: WorkspaceConfigDiagnostic,
    detail: WorkspaceApiFailureDetail | string,
  ) {
    const normalizedDetail = normalizeWorkspaceFailureDetail(detail);
    const routeRecords = workspaceRouteRecords(routeLabel, diagnostic);
    const routeStatus = workspaceRouteStatus(routeLabel, diagnostic);
    const expectedIds = diagnostic.expected.map((record) => record.id).join(", ") || "none";
    return [
      `${label} save failed`,
      `Code: ${stage}`,
      `Route: ${routeLabel}`,
      `HTTP: ${routeStatus ?? "not available"}`,
      normalizedDetail.error ? `Backend error: ${normalizedDetail.error}` : "",
      normalizedDetail.message || normalizedDetail.text || normalizedDetail.statusText
        ? `Message: ${normalizedDetail.message || normalizedDetail.text || normalizedDetail.statusText}`
        : "",
      normalizedDetail.details ? `Details: ${normalizedDetail.details}` : "",
      normalizedDetail.failed ? `Backend failed: ${normalizedDetail.failed}` : "",
      `Expected: ${expectedIds}`,
      `Returned: ${summarizeWorkspaceRecordIds(routeRecords)}`,
      `Active account: ${diagnostic.activeAccountId || "missing"}`,
      `Returned accountIds: ${summarizeWorkspaceAccountIds(routeRecords)}`,
    ].filter(Boolean).join("\n");
  }

  function workspaceDiagnosticErrorCode(label: "Location" | "Coach", stage: string) {
    if (stage.includes("unauthorized")) return "AUTH_SESSION_MISSING";
    if (stage.includes("account_mismatch")) return label === "Location" ? "LOCATION_SCOPE_MISMATCH" : "COACH_SCOPE_MISMATCH";
    if (stage.includes("missing_expected_id")) {
      return label === "Location" ? "LOCATION_SAVE_VERIFY_MISSING" : "COACH_SAVE_VERIFY_MISSING";
    }
    return label === "Location" ? "LOCATION_SAVE_FAILED" : "COACH_SAVE_FAILED";
  }

  function throwWorkspaceSaveFailure(
    label: "Location" | "Coach",
    routeLabel: string,
    stage: string,
    diagnostic: WorkspaceConfigDiagnostic,
    detail: WorkspaceApiFailureDetail | string,
  ): never {
    throw new Error(formatWorkspaceSaveFailure(label, routeLabel, stage, diagnostic, detail));
  }

  function workspaceSaveFailureMessage(
    error: unknown,
    label: "Location" | "Coach",
    routeLabel: string,
    stage: string,
    diagnostic: WorkspaceConfigDiagnostic,
    fallback: string,
  ) {
    if (error instanceof Error && error.message.includes("\nCode: ")) return error.message;
    const message = error instanceof Error && error.message ? error.message : fallback;
    return formatWorkspaceSaveFailure(label, routeLabel, stage, diagnostic, { message });
  }

  function assertExpectedWorkspaceRecords(
    records: WorkspaceConfigRecord[] | undefined,
    label: "Location" | "Coach",
    routeLabel: string,
    missingStage: string,
    mismatchStage: string,
    diagnostic: WorkspaceConfigDiagnostic,
  ) {
    const source = Array.isArray(records) ? records : [];
    for (const expected of diagnostic.expected) {
      const match = source.find((record) => record.id === expected.id);
      if (!match) {
        throwWorkspaceSaveFailure(
          label,
          routeLabel,
          missingStage,
          diagnostic,
          t("{name} ({id}) was missing from the response.", { name: expected.name, id: expected.id }),
        );
      }
      if (match.accountId !== diagnostic.activeAccountId) {
        throwWorkspaceSaveFailure(
          label,
          routeLabel,
          mismatchStage,
          diagnostic,
          `saved record accountId was ${match.accountId || "missing"}, activeAccountId was ${diagnostic.activeAccountId || "missing"}.`,
        );
      }
    }
  }

  async function readWorkspaceSaveJson<T>(
    response: Response,
    label: "Location" | "Coach",
    routeLabel: string,
    stage: string,
    diagnostic: WorkspaceConfigDiagnostic,
  ) {
    try {
      return (await response.json()) as T;
    } catch {
      throwWorkspaceSaveFailure(
        label,
        routeLabel,
        stage,
        diagnostic,
        `expected JSON but received ${response.headers.get("Content-Type") || "unknown content type"}.`,
      );
    }
  }

  async function fetchDatabaseHealthSummary() {
    try {
      const response = await fetch("/api/database-health", { headers: { Accept: "application/json" } });
      if (!response.ok) return "";
      const data = (await response.json()) as { ok?: boolean; failed?: Array<{ name?: string; message?: string }> };
      if (data.ok) return t("Database health passed, but calendar state still failed.");
      const firstFailed = Array.isArray(data.failed) && data.failed[0] ? data.failed[0] : null;
      return firstFailed ? t("Database health failed at {name}: {message}", { name: firstFailed.name ?? "", message: firstFailed.message ?? "" }) : t("Database health failed.");
    } catch {
      return "";
    }
  }

  function adminWorkspaceLoadMessage(error: unknown) {
    if (error instanceof Error && error.message) return error.message;
    return t("Calendar bookings could not be loaded.");
  }

  async function startAdminWorkspaceHydration() {
    if (hasActiveAdminSave()) return;
    const runId = ++adminHydrationRunIdRef.current;
    adminBootStartedAtRef.current = performance.now();
    calendarFrameRenderedRef.current = false;
    bookingCardsFirstRenderedRef.current = false;
    bookingCardsHydratedRef.current = false;
    const timer = startDiagnosticTimer({
      system: "calendar",
      action: "admin_calendar_shell_load",
      route: "GET /api/calendar-state",
      functionName: "startAdminWorkspaceHydration",
      expectedAccountId: activeAccountId,
      details: {
        routeUsed: "shell",
        waitingFor: "calendar_shell_state",
      },
    });
    trackDiagnosticEvent({
      system: "reload",
      action: "ADMIN_CALENDAR_SHELL_RELOAD_STARTED",
      phase: "admin_workspace",
      status: "started",
      route: "GET /api/calendar-state",
      functionName: "startAdminWorkspaceHydration",
      expectedAccountId: activeAccountId,
      details: {
        routeUsed: "shell",
        nonCriticalRefreshDeferred: true,
      },
    });
    hasLoadedCalendarApiRef.current = false;
    setAdminWorkspaceLoadStatus("loading");
    setAdminWorkspaceLoadError("");
    // Clients and lesson notes go out with the shell rather than after the
    // calendar has painted. They hit their own functions, so waiting gained
    // the calendar nothing and cost Clients and Player Profiles a whole round
    // trip after the page already looked ready.
    window.setTimeout(() => void refreshPeopleList({ maxAgeMs: 30_000 }), 0);
    window.setTimeout(() => void refreshLessonNotes({ maxAgeMs: 30_000 }), 0);
    window.setTimeout(() => void refreshPortalPlayers(), 0);
    setCalendarFeedStatus("checking");
    setCalendarSaveStatus("idle");
    setCalendarSaveError("");
    try {
      const applied = await loadAdminCalendarState(runId);
      if (!applied || adminHydrationRunIdRef.current !== runId) return;
      setAdminWorkspaceLoadStatus("loaded");
      setAdminWorkspaceLoadError("");
      setCalendarFeedStatus("connected");
      trackDiagnosticEvent({
        system: "reload",
        action: "ADMIN_CALENDAR_SHELL_RELOAD_COMPLETED",
        phase: "admin_workspace",
        status: "success",
        route: "GET /api/calendar-state",
        functionName: "startAdminWorkspaceHydration",
        expectedAccountId: activeAccountId,
        details: {
          routeUsed: "shell",
          nonCriticalRefreshDeferred: true,
        },
      });
      finishDiagnosticTimer(timer, "success", {
        details: {
          routeUsed: "shell",
          calendarShellApplied: true,
          nonCriticalRefreshDeferred: true,
        },
      });
    } catch (error) {
      if (adminHydrationRunIdRef.current !== runId) return;
      finishDiagnosticTimer(timer, "failed", {
        errorCode: "SUPABASE_READ_FAILED",
        humanMessage: adminWorkspaceLoadMessage(error),
      });
      trackDiagnosticEvent({
        system: "reload",
        action: "ADMIN_CALENDAR_SHELL_RELOAD_COMPLETED",
        phase: "admin_workspace",
        status: "failed",
        route: "GET /api/calendar-state",
        functionName: "startAdminWorkspaceHydration",
        expectedAccountId: activeAccountId,
        errorCode: "SUPABASE_READ_FAILED",
        humanMessage: adminWorkspaceLoadMessage(error),
      });
      hasLoadedCalendarApiRef.current = false;
      setAdminWorkspaceLoadStatus("error");
      setAdminWorkspaceLoadError(adminWorkspaceLoadMessage(error));
      setCalendarFeedStatus("offline");
    }
  }

  async function loadAdminCalendarState(runId = ++adminHydrationRunIdRef.current) {
    const isCurrentRun = () => adminHydrationRunIdRef.current === runId;
    const timer = startDiagnosticTimer({
      system: "supabase",
      action: "calendar_bookings_load",
      route: "GET /api/calendar-state",
      functionName: "loadAdminCalendarState",
      expectedAccountId: activeAccountId,
    });
    hasLoadedCalendarApiRef.current = false;
    setCalendarFeedStatus("checking");
    setCalendarSaveStatus("idle");
    setCalendarSaveError("");
    if (!isCurrentRun() || hasActiveAdminSave()) return false;
    const visibleRangeStartedAt = performance.now();
    trackDiagnosticEvent({
      system: "calendar",
      action: "CALENDAR_VISIBLE_RANGE_LOAD_STARTED",
      phase: "request",
      status: "started",
      route: "GET /api/calendar-state",
      functionName: "loadAdminCalendarState",
      expectedAccountId: activeAccountId,
      details: {
        activeWeek,
        waitingFor: "calendar_items",
      },
    });
    let response: Response;
    try {
      trackDiagnosticEvent({
        system: "calendar",
        action: "CALENDAR_SHELL_STATE_LOAD_STARTED",
        phase: "request",
        status: "started",
        route: "GET /api/calendar-state",
        functionName: "loadAdminCalendarState",
        expectedAccountId: activeAccountId,
        details: {
          routeUsed: "shell",
          waitingFor: "calendar_shell_state",
        },
      });
      response = await fetch("/api/calendar-state", { headers: { Accept: "application/json" } });
    } catch {
      finishDiagnosticTimer(timer, "failed", {
        errorCode: "SUPABASE_READ_FAILED",
        humanMessage: t("Calendar API unavailable."),
      });
      const healthMessage = await fetchDatabaseHealthSummary();
      if (!isCurrentRun()) return false;
      throw new Error([t("Calendar API unavailable"), healthMessage].filter(Boolean).join(" · "));

    }
    if (response.status === 401) {
      finishDiagnosticTimer(timer, "failed", {
        httpStatus: response.status,
        errorCode: "AUTH_SESSION_MISSING",
        humanMessage: t("Admin login required."),
      });
      throw new Error(t("Admin login required"));
    }
    if (!response.ok) {
      const apiMessage = await readApiFailure(response, t("Calendar API unavailable"));
      finishDiagnosticTimer(timer, "failed", {
        httpStatus: response.status,
        errorCode: "SUPABASE_READ_FAILED",
        humanMessage: apiMessage,
      });
      const healthMessage = await fetchDatabaseHealthSummary();
      if (!isCurrentRun()) return false;
      throw new Error([apiMessage, healthMessage].filter(Boolean).join(" · "));
    }
    const data = (await response.json()) as {
      syncKey?: string;
      items?: CalendarItem[];
      people?: Person[];
      notifications?: NotificationRecord[];
      services?: Service[];
      locations?: Location[];
      coaches?: CoachProfile[];
      workspaceAccounts?: WorkspaceAccount[];
      currentUser?: AppUser;
      availability?: AvailabilityWindow[][];
      settings?: Partial<NotificationSettings>;
      brand?: Partial<BrandSettings>;
      account?: Partial<CoachAccount>;
      updatedAt?: string;
      diagnostics?: {
        calendarState?: {
          routeUsed?: string;
          entrypoint?: string;
          shellLoadDurationMs?: number;
          itemCount?: number;
          peopleDeferred?: boolean;
          notificationsDeferred?: boolean;
          googleSyncStatusDeferred?: boolean;
        };
      };
    };
    if (!isCurrentRun() || hasActiveAdminSave()) return false;
    const loadedItems = Array.isArray(data.items) ? data.items : [];
    const loadedAccounts = cleanWorkspaceAccounts(data.workspaceAccounts, data.account ?? coachAccount);
    const loadedAccountId = defaultAccountId(loadedAccounts);
    const accountItems = loadedItems.map((item) => ({ ...item, accountId: item.accountId || loadedAccountId }));
    const loadedSyncKey =
      typeof data.syncKey === "string" && data.syncKey.startsWith("cg_") ? data.syncKey : calendarSyncKey;
    lastPersistedCalendarFingerprintRef.current = calendarStateFingerprint(accountItems, loadedSyncKey);
    lastPersistedCalendarItemsRef.current = accountItems;
    if (typeof data.updatedAt === "string") setCalendarStateVersion(data.updatedAt);
    setWorkspaceAccounts(loadedAccounts);
    if (Array.isArray(data.items)) setItems(accountItems);
    trackDiagnosticMilestone({
      system: "calendar",
      action: "CALENDAR_VISIBLE_RANGE_LOAD_COMPLETED",
      phase: "request",
      status: "success",
      route: "GET /api/calendar-state",
      functionName: "loadAdminCalendarState",
      expectedAccountId: activeAccountId,
      returnedAccountId: loadedAccountId,
      startedAt: visibleRangeStartedAt,
      details: {
        activeWeek,
        itemCount: accountItems.length,
        waitingFor: "calendar_items",
      },
    });
    const calendarStateDiagnostics = data.diagnostics?.calendarState;
    const calendarStateRouteUsed = calendarStateDiagnostics?.routeUsed === "shell" ? "shell" : "full";
    const peopleDeferred = calendarStateDiagnostics?.peopleDeferred === true;
    const notificationsDeferred = calendarStateDiagnostics?.notificationsDeferred === true;
    const googleSyncStatusDeferred = calendarStateDiagnostics?.googleSyncStatusDeferred === true;
    if (calendarStateRouteUsed === "shell") {
      trackDiagnosticEvent({
        system: "calendar",
        action: "CALENDAR_SHELL_STATE_LOAD_COMPLETED",
        phase: "request",
        status: "success",
        route: "GET /api/calendar-state",
        functionName: "loadAdminCalendarState",
        expectedAccountId: activeAccountId,
        returnedAccountId: loadedAccountId,
        details: {
          routeUsed: calendarStateRouteUsed,
          entrypoint: calendarStateDiagnostics?.entrypoint || "",
          shellLoadDurationMs: calendarStateDiagnostics?.shellLoadDurationMs ?? 0,
          itemCount: calendarStateDiagnostics?.itemCount ?? accountItems.length,
          peopleDeferred,
          notificationsDeferred,
          googleSyncStatusDeferred,
        },
      });
      trackDiagnosticEvent({
        system: "cache",
        action: "NON_CRITICAL_DATA_DEFERRED",
        phase: "admin_workspace",
        status: "success",
        route: "GET /api/calendar-state",
        functionName: "loadAdminCalendarState",
        details: {
          routeUsed: calendarStateRouteUsed,
          peopleDeferred,
          notificationsDeferred,
          googleSyncStatusDeferred,
          blockingCalendar: false,
        },
      });
      if (peopleDeferred) {
        trackDiagnosticEvent({
          system: "cache",
          action: "PEOPLE_LOAD_DEFERRED",
          phase: "admin_workspace",
          status: "success",
          route: "GET /api/calendar-state",
          functionName: "loadAdminCalendarState",
          details: { routeUsed: calendarStateRouteUsed, blockingCalendar: false },
        });
      }
      if (notificationsDeferred) {
        trackDiagnosticEvent({
          system: "cache",
          action: "NOTIFICATION_HISTORY_DEFERRED",
          phase: "admin_workspace",
          status: "success",
          route: "GET /api/calendar-state",
          functionName: "loadAdminCalendarState",
          details: { routeUsed: calendarStateRouteUsed, blockingCalendar: false },
        });
      }
      if (googleSyncStatusDeferred) {
        trackDiagnosticEvent({
          system: "cache",
          action: "GOOGLE_SYNC_STATUS_DEFERRED",
          phase: "admin_workspace",
          status: "success",
          route: "GET /api/calendar-state",
          functionName: "loadAdminCalendarState",
          details: { routeUsed: calendarStateRouteUsed, blockingCalendar: false },
        });
      }
    }
    if (Array.isArray(data.people) && !peopleDeferred) setPeople(cleanPeople(data.people));
    if (Array.isArray(data.notifications) && !notificationsDeferred) setNotifications(cleanNotificationRecords(data.notifications));
    if (Array.isArray(data.services)) setServices(cleanServices(data.services).map((service) => ({ ...service, accountId: service.accountId || loadedAccountId })));
    const fallbackAccount = data.account ?? coachAccount;
    if (Array.isArray(data.locations) && data.locations.length) {
      setLocations(cleanLocations(data.locations, fallbackAccount));
    }
    if (Array.isArray(data.coaches) && data.coaches.length) {
      setCoachProfiles(cleanCoachProfiles(data.coaches, fallbackAccount));
    }
    if (data.currentUser) setCurrentAppUser(cleanAppUser(data.currentUser, defaultAppUserFromCoachAccount(data.account ?? coachAccount), loadedAccountId));
    if (Array.isArray(data.availability)) {
      setAvailability(cleanAvailability(data.availability).map((day) => day.map((window) => ({ ...window, accountId: window.accountId || loadedAccountId }))));
    }
    if (typeof data.syncKey === "string" && data.syncKey.startsWith("cg_")) {
      setCalendarSyncKey(data.syncKey);
    }
    applyNotificationSettings(data.settings);
    applyCoachAccount(data.account);
    applyBrandSettings(data.brand);
    hasLoadedCalendarApiRef.current = true;
    finishDiagnosticTimer(timer, "success", {
      httpStatus: response.status,
      returnedAccountId: loadedAccountId,
      details: {
        bookingsLoaded: accountItems.length,
        peopleLoaded: Array.isArray(data.people) ? data.people.length : 0,
        servicesLoaded: Array.isArray(data.services) ? data.services.length : 0,
        locationsLoaded: Array.isArray(data.locations) ? data.locations.length : 0,
        coachesLoaded: Array.isArray(data.coaches) ? data.coaches.length : 0,
        availabilityBlocks: Array.isArray(data.availability) ? data.availability.flat().length : 0,
        routeUsed: calendarStateRouteUsed,
        entrypoint: calendarStateDiagnostics?.entrypoint || "",
        shellLoadDurationMs: calendarStateDiagnostics?.shellLoadDurationMs ?? 0,
        peopleDeferred,
        notificationsDeferred,
        googleSyncStatusDeferred,
      },
    });
    return true;
  }

  function shouldApplyAdminWorkspaceDetail(runId: number) {
    return adminHydrationRunIdRef.current === runId && !hasActiveAdminSave();
  }

  function refreshAdminWorkspaceDetails(runId: number, fallbackAccount: Partial<CoachAccount>) {
    const locationVersion = locationSaveVersionRef.current;
    const coachVersion = coachSaveVersionRef.current;
    const settingsSaveVersion = settingsSaveVersionRef.current;
    const settingsDraftVersion = notificationSettingsDraftVersionRef.current;
    const calendarWasRendered = calendarFrameRenderedRef.current;
    trackDiagnosticEvent({
      system: "cache",
      action: "NON_CRITICAL_DATA_DEFERRED",
      phase: "admin_workspace",
      status: "success",
      functionName: "refreshAdminWorkspaceDetails",
      details: {
        locations: true,
        coaches: true,
        settings: true,
        people: false,
        notifications: true,
        googleSyncStatus: true,
        backgroundRefresh: true,
        blockingCalendar: false,
        calendarFrameRendered: calendarWasRendered,
      },
    });
    window.setTimeout(() => void refreshNotificationHistory(), 0);
    window.setTimeout(() => void refreshGoogleCalendarStatus(), 0);

    void (async () => {
      const timer = startDiagnosticTimer({
        system: "cache",
        action: "COLD_REFRESH_STARTED",
        route: "GET /api/locations",
        functionName: "refreshAdminWorkspaceDetails",
        objectType: "location",
        details: {
          cacheHit: locations.length > 0,
          backgroundRefresh: true,
          blockingCalendar: false,
          calendarFrameRendered: calendarWasRendered,
        },
      });
      try {
        const response = await fetch("/api/locations", {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!shouldApplyAdminWorkspaceDetail(runId) || locationSaveVersionRef.current !== locationVersion) return;
        if (!response.ok) {
          finishDiagnosticTimer(timer, "warning", {
            httpStatus: response.status,
            errorCode: "CACHE_REFRESH_FAILED",
            humanMessage: t("Locations background refresh failed."),
          });
          console.warn("admin_workspace_detail_load_failed", { detail: "locations", status: response.status });
          return;
        }
        const responseText = await response.text();
        const data = (responseText ? JSON.parse(responseText) : {}) as { locations?: Location[] };
        if (Array.isArray(data.locations) && data.locations.length) {
          setLocations(cleanLocations(data.locations, fallbackAccount));
        }
        finishDiagnosticTimer(timer, "success", {
          httpStatus: response.status,
          phase: "COLD_REFRESH_COMPLETED",
          details: {
            rowsReturned: Array.isArray(data.locations) ? data.locations.length : 0,
            payloadBytes: responseText.length,
            cacheHit: locations.length > 0,
            backgroundRefresh: true,
            blockingCalendar: false,
            calendarFrameRendered: calendarWasRendered,
          },
        });
      } catch (error) {
        finishDiagnosticTimer(timer, "warning", {
          errorCode: "CACHE_REFRESH_FAILED",
          humanMessage: t("Locations background refresh failed."),
        });
        console.warn("admin_workspace_detail_load_failed", { detail: "locations", error });
      }
    })();

    void (async () => {
      const timer = startDiagnosticTimer({
        system: "cache",
        action: "COLD_REFRESH_STARTED",
        route: "GET /api/coaches",
        functionName: "refreshAdminWorkspaceDetails",
        objectType: "coach",
        details: {
          cacheHit: coachProfiles.length > 0,
          backgroundRefresh: true,
          blockingCalendar: false,
          calendarFrameRendered: calendarWasRendered,
        },
      });
      try {
        const response = await fetch("/api/coaches", {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!shouldApplyAdminWorkspaceDetail(runId) || coachSaveVersionRef.current !== coachVersion) return;
        if (!response.ok) {
          finishDiagnosticTimer(timer, "warning", {
            httpStatus: response.status,
            errorCode: "CACHE_REFRESH_FAILED",
            humanMessage: t("Coaches background refresh failed."),
          });
          console.warn("admin_workspace_detail_load_failed", { detail: "coaches", status: response.status });
          return;
        }
        const responseText = await response.text();
        const data = (responseText ? JSON.parse(responseText) : {}) as { coaches?: CoachProfile[] };
        if (Array.isArray(data.coaches) && data.coaches.length) {
          setCoachProfiles(cleanCoachProfiles(data.coaches, fallbackAccount));
        }
        finishDiagnosticTimer(timer, "success", {
          httpStatus: response.status,
          phase: "COLD_REFRESH_COMPLETED",
          details: {
            rowsReturned: Array.isArray(data.coaches) ? data.coaches.length : 0,
            payloadBytes: responseText.length,
            cacheHit: coachProfiles.length > 0,
            backgroundRefresh: true,
            blockingCalendar: false,
            calendarFrameRendered: calendarWasRendered,
          },
        });
      } catch (error) {
        finishDiagnosticTimer(timer, "warning", {
          errorCode: "CACHE_REFRESH_FAILED",
          humanMessage: t("Coaches background refresh failed."),
        });
        console.warn("admin_workspace_detail_load_failed", { detail: "coaches", error });
      }
    })();

    void (async () => {
      const timer = startDiagnosticTimer({
        system: "cache",
        action: "COLD_REFRESH_STARTED",
        route: "GET /api/admin-settings",
        functionName: "refreshAdminWorkspaceDetails",
        objectType: "settings",
        details: {
          cacheHit: true,
          backgroundRefresh: true,
          blockingCalendar: false,
          calendarFrameRendered: calendarWasRendered,
        },
      });
      try {
        const response = await fetch("/api/admin-settings", { headers: { Accept: "application/json" } });
        if (
          !shouldApplyAdminWorkspaceDetail(runId) ||
          settingsSaveVersionRef.current !== settingsSaveVersion ||
          notificationSettingsDraftVersionRef.current !== settingsDraftVersion
        ) {
          return;
        }
        if (!response.ok) {
          finishDiagnosticTimer(timer, "warning", {
            httpStatus: response.status,
            errorCode: "CACHE_REFRESH_FAILED",
            humanMessage: t("Admin settings background refresh failed."),
          });
          console.warn("admin_workspace_detail_load_failed", { detail: "admin-settings", status: response.status });
          return;
        }
        const responseText = await response.text();
        applyNotificationSettings((responseText ? JSON.parse(responseText) : {}) as Partial<NotificationSettings>);
        finishDiagnosticTimer(timer, "success", {
          httpStatus: response.status,
          phase: "COLD_REFRESH_COMPLETED",
          details: {
            rowsReturned: 1,
            payloadBytes: responseText.length,
            cacheHit: true,
            backgroundRefresh: true,
            blockingCalendar: false,
            calendarFrameRendered: calendarWasRendered,
          },
        });
      } catch (error) {
        finishDiagnosticTimer(timer, "warning", {
          errorCode: "CACHE_REFRESH_FAILED",
          humanMessage: t("Admin settings background refresh failed."),
        });
        console.warn("admin_workspace_detail_load_failed", { detail: "admin-settings", error });
      }
    })();
  }

  function requireLiveDatabase(action = "edit the calendar") {
    if (authStatus !== "authenticated") {
      hasLoadedCalendarApiRef.current = false;
      setCalendarFeedStatus("offline");
      setAuthStatus("guest");
      setToast({ message: t("Sign in again before editing. The calendar is not connected to the live database.") });
      return false;
    }
    if (!hasLoadedCalendarApiRef.current) {
      setCalendarSaveStatus("failed");
      setCalendarSaveFailureKind("change");
      setCalendarSaveError(t("Calendar is not connected to the live database."));
      setToast({ message: t("Cannot {action}: the live database is not connected. Reload and sign in again.", { action }) });
      return false;
    }
    if (calendarFeedStatus !== "connected") {
      setCalendarFeedStatus("connected");
    }
    if (calendarSaveStatus === "failed" && calendarSaveError === "Calendar is not connected to the live database.") {
      setCalendarSaveStatus("idle");
      setCalendarSaveError("");
    }
    return true;
  }

  async function persistUpsertItem(item: CalendarItem, previousItems: CalendarItem[], optimisticItems: CalendarItem[]) {
    beginAdminSave("upsert_item");
    try {
      const response = await fetch("/api/calendar-state", {
        method: "PUT",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ action: "upsert_item", item }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        setAuthStatus("guest");
        throw new Error(data?.message || t("Admin login expired. Sign in again before saving calendar changes."));
      }
      if (!response.ok || data?.ok === false || !data?.item) {
        throw new Error(data?.message || t("Calendar change could not be saved."));
      }
      const persistedItem = { ...item, ...data.item } as CalendarItem;
      const persistedItems = optimisticItems.map((candidate) => (candidate.id === item.id ? persistedItem : candidate));
      setItems(persistedItems);
      lastPersistedCalendarFingerprintRef.current = calendarStateFingerprint(persistedItems, calendarSyncKey);
      lastPersistedCalendarItemsRef.current = persistedItems;
      if (typeof data.updatedAt === "string") {
        setCalendarStateVersion(data.updatedAt);
      }
      scheduleAdminNotificationDebounceFlush();
      // A moved lesson takes its bay with it: the server cancels and rebooks
      // the Optix bay in the background. Drop the orange outline now so it
      // never claims a bay held at the old time, then watch the sync row to
      // restore it when the rebook lands.
      const previousVersion = previousItems.find((entry) => entry.id === item.id);
      if (
        item.kind === "appointment" &&
        previousVersion?.bayBooked === true &&
        (previousVersion.week !== item.week ||
          previousVersion.day !== item.day ||
          previousVersion.start !== item.start ||
          previousVersion.duration !== item.duration)
      ) {
        setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, bayBooked: false } : entry)));
        void watchBayHold(item.id, Date.now(), "move");
      }
      // A new lesson whose type has Auto-book ticked: the server queued its bay
      // and books it after responding, so watch for it to land.
      if (data.bayHoldQueued === true) {
        void watchBayHold(item.id, Date.now(), "new");
      }
    } catch (error) {
      setItems(previousItems);
      setToast({ message: error instanceof Error ? error.message : t("Calendar change could not be saved.") });
    } finally {
      endAdminSave("upsert_item");
    }
  }

  // Undo/rollback only needs to talk to the server if the change it's reverting
  // already made it past the debounced blob autosave (or a granular save) and is
  // sitting in the database. If it isn't, the client-side revert alone already
  // matches what's persisted, and lastPersistedCalendarFingerprintRef is left
  // untouched on purpose so the whole-array autosave stays the fallback if this
  // best-effort reconciliation fails.
  async function reconcileUndoByDelete(itemId: string, previousItems: CalendarItem[]) {
    if (!lastPersistedCalendarItemsRef.current.some((entry) => entry.id === itemId)) return;
    beginAdminSave("calendar_delete");
    try {
      const response = await fetch(`/api/calendar-state?id=${encodeURIComponent(itemId)}`, {
        method: "DELETE",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.message || t("Could not undo that change."));
      const persistedItems: CalendarItem[] = Array.isArray(data.items) ? data.items : previousItems;
      lastPersistedCalendarFingerprintRef.current = calendarStateFingerprint(persistedItems, calendarSyncKey);
      lastPersistedCalendarItemsRef.current = persistedItems;
      if (typeof data.updatedAt === "string") {
        setCalendarStateVersion(data.updatedAt);
      }
    } catch (error) {
      console.error("calendar_state:undo_delete_failed", error);
    } finally {
      endAdminSave("calendar_delete");
    }
  }

  async function reconcileUndoByUpsert(item: CalendarItem, previousItems: CalendarItem[]) {
    if (!lastPersistedCalendarItemsRef.current.some((entry) => entry.id === item.id)) return;
    beginAdminSave("upsert_item");
    try {
      const response = await fetch("/api/calendar-state", {
        method: "PUT",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ action: "upsert_item", item }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false || !data?.item) {
        throw new Error(data?.message || t("Could not undo that change."));
      }
      const persistedItem = { ...item, ...data.item } as CalendarItem;
      const persistedItems = previousItems.map((entry) => (entry.id === item.id ? persistedItem : entry));
      lastPersistedCalendarFingerprintRef.current = calendarStateFingerprint(persistedItems, calendarSyncKey);
      lastPersistedCalendarItemsRef.current = persistedItems;
      if (typeof data.updatedAt === "string") {
        setCalendarStateVersion(data.updatedAt);
      }
    } catch (error) {
      console.error("calendar_state:undo_upsert_failed", error);
    } finally {
      endAdminSave("upsert_item");
    }
  }

  async function persistLocations(nextLocations: Location[], message = t("Locations saved.")): Promise<boolean> {
    const saveVersion = ++locationSaveVersionRef.current;
    beginAdminSave("locations");
    const isCurrentSave = () => locationSaveVersionRef.current === saveVersion;
    const snapshot = locations;
    const clean = cleanLocations(nextLocations, coachAccount);
    const diagnostic: WorkspaceConfigDiagnostic = {
      activeAccountId,
      expected: clean.map((location) => ({ id: location.id, name: workspaceRecordName(location) })).filter((location) => location.id),
    };
    const timer = startDiagnosticTimer({
      system: "save",
      action: "save_location",
      route: "PUT /api/locations",
      functionName: "persistLocations",
      expectedAccountId: activeAccountId,
      objectType: "location",
      details: { expectedCount: diagnostic.expected.length },
    });
    let failureRoute = "PUT /api/locations";
    let failureStage = "location_put_request_failed";
    setLocations(clean);
    setLocationSaveState("saving");
    setLocationEditorError("");
    try {
      failureRoute = "PUT /api/locations";
      failureStage = "location_put_request_failed";
      const response = await fetch("/api/locations", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ locations: clean }),
      });
      diagnostic.putStatus = response.status;
      if (response.status === 401) {
        setAuthStatus("guest");
        throwWorkspaceSaveFailure("Location", "PUT /api/locations", "location_put_unauthorized", diagnostic, {
          error: "unauthorized",
          message: t("Admin login required"),
        });
      }
      if (!response.ok) {
        const detail = await readApiFailureDetail(response, t("Location save failed"));
        throwWorkspaceSaveFailure("Location", "PUT /api/locations", "location_put_failed", diagnostic, detail);
      }
      failureStage = "location_put_failed";
      const putLocationsData = await readWorkspaceSaveJson<{ locations?: Location[] }>(
        response,
        "Location",
        "PUT /api/locations",
        "location_put_failed",
        diagnostic,
      );
      const savedLocationRecords = Array.isArray(putLocationsData.locations) ? putLocationsData.locations : undefined;
      diagnostic.putRecords = savedLocationRecords;
      assertExpectedWorkspaceRecords(
        savedLocationRecords,
        "Location",
        "PUT /api/locations",
        "location_put_missing_expected_id",
        "location_put_account_mismatch",
        diagnostic,
      );
      failureRoute = "GET /api/locations";
      failureStage = "location_get_request_failed";
      const locationsResponse = await fetch("/api/locations", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      diagnostic.getStatus = locationsResponse.status;
      if (locationsResponse.status === 401) {
        setAuthStatus("guest");
        throwWorkspaceSaveFailure("Location", "GET /api/locations", "location_get_unauthorized", diagnostic, {
          error: "unauthorized",
          message: t("Admin login required"),
        });
      }
      if (!locationsResponse.ok) {
        const detail = await readApiFailureDetail(locationsResponse, t("Location save failed"));
        throwWorkspaceSaveFailure("Location", "GET /api/locations", "location_get_failed", diagnostic, detail);
      }
      failureStage = "location_get_failed";
      const locationsData = await readWorkspaceSaveJson<{ locations?: Location[] }>(
        locationsResponse,
        "Location",
        "GET /api/locations",
        "location_get_failed",
        diagnostic,
      );
      const loadedLocationRecords = Array.isArray(locationsData.locations) ? locationsData.locations : undefined;
      const loadedLocations = cleanLocations(locationsData.locations, coachAccount);
      diagnostic.getRecords = loadedLocationRecords;
      assertExpectedWorkspaceRecords(
        loadedLocationRecords,
        "Location",
        "GET /api/locations",
        "location_get_missing_expected_id",
        "location_get_account_mismatch",
        diagnostic,
      );
      failureRoute = "GET /api/calendar-state";
      failureStage = "location_calendar_state_request_failed";
      const calendarStateResponse = await fetch("/api/calendar-state", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      diagnostic.calendarStatus = calendarStateResponse.status;
      if (calendarStateResponse.status === 401) {
        setAuthStatus("guest");
        throwWorkspaceSaveFailure("Location", "GET /api/calendar-state", "location_calendar_state_unauthorized", diagnostic, {
          error: "unauthorized",
          message: t("Admin login required"),
        });
      }
      if (!calendarStateResponse.ok) {
        const detail = await readApiFailureDetail(calendarStateResponse, t("Location save failed"));
        throwWorkspaceSaveFailure("Location", "GET /api/calendar-state", "location_calendar_state_failed", diagnostic, detail);
      }
      failureStage = "location_calendar_state_failed";
      const calendarStateData = await readWorkspaceSaveJson<{ locations?: Location[] }>(
        calendarStateResponse,
        "Location",
        "GET /api/calendar-state",
        "location_calendar_state_failed",
        diagnostic,
      );
      const calendarLocationRecords = Array.isArray(calendarStateData.locations) ? calendarStateData.locations : undefined;
      diagnostic.calendarRecords = calendarLocationRecords;
      assertExpectedWorkspaceRecords(
        calendarLocationRecords,
        "Location",
        "GET /api/calendar-state",
        "location_calendar_state_missing_expected_id",
        "location_calendar_state_account_mismatch",
        diagnostic,
      );
      if (!isCurrentSave()) return false;
      setLocations(loadedLocations);
      finishDiagnosticTimer(timer, "verified", {
        route: "GET /api/calendar-state",
        httpStatus: calendarStateResponse.status,
        returnedAccountId: summarizeWorkspaceAccountIds(calendarLocationRecords),
        details: { returnedCount: loadedLocationRecords?.length ?? 0 },
      });
      setLocationSaveState("saved");
      setLocationEditorError("");
      setToast({ message });
      window.setTimeout(() => {
        if (isCurrentSave()) setLocationSaveState("idle");
      }, 1600);
      return true;
    } catch (error) {
      if (!isCurrentSave()) return false;
      setLocations(snapshot);
      setLocationSaveState("error");
      const errorMessage = workspaceSaveFailureMessage(
        error,
        "Location",
        failureRoute,
        failureStage,
        diagnostic,
        t("Could not save locations."),
      );
      finishDiagnosticTimer(timer, "failed", {
        route: failureRoute,
        httpStatus: workspaceRouteStatus(failureRoute, diagnostic),
        errorCode: workspaceDiagnosticErrorCode("Location", failureStage),
        humanMessage: errorMessage,
        returnedAccountId: summarizeWorkspaceAccountIds(workspaceRouteRecords(failureRoute, diagnostic)),
      });
      setLocationEditorError(errorMessage);
      setToast({ message: errorMessage });
      return false;
    } finally {
      endAdminSave("locations");
    }
  }

  // Settings, warmed. Once the calendar has painted and the browser is quiet,
  // the integrations list (and the panel that shows it) are fetched so that
  // Settings › Integrations paints with its cards already there instead of a
  // beat behind the tab. Nothing here blocks anything the coach can see.
  useEffect(() => {
    if (authStatus !== "authenticated" || adminWorkspaceLoadStatus !== "loaded") return;
    return whenIdle(() => {
      prefetchIntegrations("integration");
      if (isPlatformAdmin) prefetchIntegrations("admin");
      void import("../integrations/IntegrationsPanel").catch(() => undefined);
    }, 2500);
  }, [authStatus, adminWorkspaceLoadStatus, isPlatformAdmin]);

  return {
    adminWorkspaceLoadStatus,
    setAdminWorkspaceLoadStatus,
    adminWorkspaceLoadError,
    setAdminWorkspaceLoadError,
    locationSaveState,
    setLocationSaveState,
    calendarSyncKey,
    setCalendarSyncKey,
    calendarFeedStatus,
    setCalendarFeedStatus,
    calendarSaveStatus,
    setCalendarSaveStatus,
    calendarSaveError,
    setCalendarSaveError,
    calendarSaveFailureKind,
    setCalendarSaveFailureKind,
    calendarStateVersion,
    setCalendarStateVersion,
    hasLoadedCalendarApiRef,
    adminHydrationRunIdRef,
    calendarSaveVersionRef,
    coachSaveVersionRef,
    settingsSaveVersionRef,
    lastPersistedCalendarFingerprintRef,
    lastPersistedCalendarItemsRef,
    adminBootStartedAtRef,
    beginAdminSave,
    endAdminSave,
    workspaceDiagnosticValue,
    readApiFailureDetail,
    readApiFailure,
    workspaceRecordName,
    summarizeWorkspaceAccountIds,
    workspaceRouteStatus,
    workspaceRouteRecords,
    workspaceDiagnosticErrorCode,
    throwWorkspaceSaveFailure,
    workspaceSaveFailureMessage,
    assertExpectedWorkspaceRecords,
    readWorkspaceSaveJson,
    startAdminWorkspaceHydration,
    refreshAdminWorkspaceDetails,
    requireLiveDatabase,
    persistUpsertItem,
    reconcileUndoByDelete,
    reconcileUndoByUpsert,
    persistLocations,
  };
}

export type WorkspaceSync = ReturnType<typeof useWorkspaceSync>;
