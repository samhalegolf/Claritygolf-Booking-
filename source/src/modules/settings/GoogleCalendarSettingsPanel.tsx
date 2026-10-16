// Settings › Booking › Google Calendar: the coach's sync, export and import choices.
import { t, tn } from "../../lib/i18n";
import { Check, Copy, ExternalLink, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { SettingsGroup } from "./SettingsLayout";
import { ClarityAdmin, ClarityCalendar, ClarityCalendarSync } from "../shared/ClarityIcons";
import { formatDebugJson, googleCalendarDebugTimestamp, googleCalendarFailureCode, googleCalendarFailureHint, googleCalendarSkipReasonLabels, googleCalendarStageLabel, googleCalendarTriggerLabel, googleSyncTimeLabel, importRuleIsActive, relativeTimeLabel } from "./googleCalendarLabels";
import { featureUnavailableMessage } from "../workspace/workspaceModel";
import { loadingLabel } from "../shared/Loading";
import type { Service } from "../services/serviceModel";
import type { GoogleCalendarActionState, GoogleCalendarDebugEntry, GoogleCalendarDebugLog, GoogleCalendarExportRules, GoogleCalendarImportRule, GoogleCalendarSyncStatus } from "./googleCalendarTypes";
import type { Dispatch, SetStateAction } from "react";

export type GoogleCalendarSettingsPanelProps = {
  googleCalendar: GoogleCalendarSyncStatus;
  googleCalendarAction: GoogleCalendarActionState;
  googleCalendarDebug: GoogleCalendarDebugLog | null;
  googleCalendarSyncEnabled: boolean;
  googleCalendarExport: GoogleCalendarExportRules;
  updateGoogleCalendarImportRule: (ruleId: string, updates: Partial<GoogleCalendarImportRule>) => void;
  googleCalendarDebugLoading: boolean;
  googleCalendarStatusError: string;
  googleCalendarCoachName: string;
  removeGoogleCalendarImportRule: (ruleId: string) => void;
  updateGoogleCalendarExport: (updates: Partial<GoogleCalendarExportRules>) => void;
  services: Service[];
  googleCalendarDebugError: string;
  setGoogleCalendar: Dispatch<SetStateAction<GoogleCalendarSyncStatus>>;
  editingImportRuleId: string | null;
  setEditingImportRuleId: Dispatch<SetStateAction<string | null>>;
  toggleGoogleCalendarImportRuleCalendar: (ruleId: string, calendarId: string, include: boolean) => void;
  addGoogleCalendarImportRule: () => void;
  isDeveloper: boolean;
  googleCalendarDebugOpen: boolean;
  setGoogleCalendarDebugOpen: Dispatch<SetStateAction<boolean>>;
  clearGoogleCalendarDebugLog: () => void;
  toggleGoogleCalendarDebugLogging: (enabled: boolean) => void;
  expandedGoogleCalendarDebugId: string | null;
  setExpandedGoogleCalendarDebugId: Dispatch<SetStateAction<string | null>>;
  copyGoogleCalendarDebugEntry: (entry: GoogleCalendarDebugEntry) => void;
  saveGoogleCalendarSettings: (next?: Partial<GoogleCalendarSyncStatus>) => Promise<void>;
  connectGoogleCalendar: () => Promise<void>;
  syncGoogleCalendarNow: () => Promise<void>;
  disconnectGoogleCalendar: () => Promise<void>;
  refreshGoogleCalendarDebugLog: () => Promise<void>;
};

export function GoogleCalendarSettingsPanel(props: GoogleCalendarSettingsPanelProps) {
  const {
    googleCalendar,
    googleCalendarAction,
    googleCalendarDebug,
    googleCalendarSyncEnabled,
    googleCalendarExport,
    updateGoogleCalendarImportRule,
    googleCalendarDebugLoading,
    googleCalendarStatusError,
    googleCalendarCoachName,
    removeGoogleCalendarImportRule,
    updateGoogleCalendarExport,
    services,
    googleCalendarDebugError,
    setGoogleCalendar,
    editingImportRuleId,
    setEditingImportRuleId,
    toggleGoogleCalendarImportRuleCalendar,
    addGoogleCalendarImportRule,
    isDeveloper,
    googleCalendarDebugOpen,
    setGoogleCalendarDebugOpen,
    clearGoogleCalendarDebugLog,
    toggleGoogleCalendarDebugLogging,
    expandedGoogleCalendarDebugId,
    setExpandedGoogleCalendarDebugId,
    copyGoogleCalendarDebugEntry,
    saveGoogleCalendarSettings,
    connectGoogleCalendar,
    syncGoogleCalendarNow,
    disconnectGoogleCalendar,
    refreshGoogleCalendarDebugLog,
  } = props;
  return (
    <SettingsGroup id="google-calendar" icon={ClarityCalendarSync} section="booking" title={t("Google Calendar")}>
      <div className="data-card wide cp-google-calendar-body">
        {googleCalendarCoachName ? (
          <p className="gcal-settings-owner">{t("Calendar for {name}", { name: googleCalendarCoachName })}</p>
        ) : null}
        <div className={`sync-status ${googleCalendar.connected ? "connected" : googleCalendar.configured ? "checking" : "offline"}`}>
          <span>{t("Google account")}</span>
          <strong>
            {!googleCalendarSyncEnabled
              ? t("Plan feature unavailable")
              : googleCalendarStatusError
              ? t("Status check failed")
              : !googleCalendar.configured
              ? t("Needs OAuth credentials")
              : googleCalendar.connected
                ? googleCalendar.manualOnly
                  ? t("Manual sync only")
                  : googleCalendar.lastSyncStatus === "failed"
                  ? t("Connected, sync failed")
                  : t("Connected")
                : t("Ready to connect")}
          </strong>
          <em>
            {!googleCalendarSyncEnabled
              ? featureUnavailableMessage("googleCalendarSync")
              : googleCalendarStatusError
              ? t("{googleCalendarStatusError} — the settings below are placeholders, not the live configuration.", { googleCalendarStatusError })
              : googleCalendar.lastSyncError
              ? googleCalendar.manualOnly
                ? t("Last sync failed: {lastSyncError}", { lastSyncError: googleCalendar.lastSyncError })
                : googleCalendar.lastSyncError
              : googleCalendar.connected
                ? `${googleCalendar.accountEmail || t("Google account")} · ${googleSyncTimeLabel(googleCalendar.lastSyncAt)}`
                : googleCalendar.redirectUri || t("Add Google OAuth credentials in Netlify.")}
          </em>
        </div>

        <details className="settings-subsection">
          <summary className="settings-subsection-title">
            <ClarityCalendarSync size={18} />
            <div>
              <span>{t("Sync mode")}</span>
              <strong>
                {googleCalendar.calendarId || "primary"} ·{" "}
                {googleCalendar.manualOnly ? t("Manual only") : t("Automatic after every change")}
              </strong>
            </div>
          </summary>
          <label className="sync-field">
            <span>{t("Google calendar ID")}</span>
            <input
              value={googleCalendar.calendarId}
              disabled={!googleCalendarSyncEnabled}
              onChange={(event) => setGoogleCalendar((current) => ({ ...current, calendarId: event.target.value }))}
              placeholder={t("primary or calendar email")}
            />
          </label>
          <div className="sync-meta">
            <span>{t("Redirect URI")}</span>
            <code>{googleCalendar.redirectUri || "Set GOOGLE_CALENDAR_REDIRECT_URI or use /api/google-calendar/callback"}</code>
          </div>
          <div className="sync-actions">
            {!googleCalendar.connected ? (
              <button
                className="primary-button"
                disabled={!googleCalendarSyncEnabled || !googleCalendar.configured || googleCalendarAction !== "idle"}
                onClick={connectGoogleCalendar}
                type="button"
              >
                <ExternalLink size={16} />
                {googleCalendarAction === "connecting" ? t("Opening Google") : t("Connect Google")}
              </button>
            ) : (
              <>
                <button
                  className="primary-button"
                  disabled={!googleCalendarSyncEnabled || googleCalendarAction !== "idle"}
                  onClick={syncGoogleCalendarNow}
                  type="button"
                >
                  <RefreshCw size={16} />
                  {googleCalendarAction === "syncing" ? t("Syncing") : t("Sync now")}
                </button>
                <button
                  className="outline-button"
                  disabled={!googleCalendarSyncEnabled || googleCalendarAction !== "idle"}
                  onClick={() => void saveGoogleCalendarSettings()}
                  type="button"
                >
                  <Check size={16} />
                  {googleCalendarAction === "saving" ? t("Saving") : t("Save settings")}
                </button>
                <button
                  className="danger-button"
                  disabled={!googleCalendarSyncEnabled || googleCalendarAction !== "idle"}
                  onClick={disconnectGoogleCalendar}
                  type="button"
                >
                  <X size={16} />
                  {googleCalendarAction === "disconnecting" ? t("Disconnecting") : t("Disconnect")}
                </button>
              </>
            )}
          </div>
        </details>

        <details className="settings-subsection">
          <summary className="settings-subsection-title">
            <ClarityCalendar size={18} />
            <div>
              <span>{t("Selective event import")}</span>
              <strong>
                {googleCalendar.importRules?.length
                  ? tn(googleCalendar.importRules.length, "{active} of {count} rule active", "{active} of {count} rules active", { active: googleCalendar.importRules.filter(importRuleIsActive).length })
                  : t("Name the outside sources Clarity should pull in")}
              </strong>
            </div>
          </summary>

          <p className="google-calendar-source-intro">{t("Clarity only imports Google events that match a rule below. Name the source — \"Golf HQ Portal\" — list the spellings that identify it, and Clarity will match them against the event's organiser, title, description and location. Add keywords to narrow it further; leave them blank to take everything from that source.")}</p>

          {googleCalendar.sourceListError ? (
            <p className="gcal-debug-error" role="alert">
              {googleCalendar.sourceListError}
            </p>
          ) : null}

          {!googleCalendar.importRules?.length ? (
            <p className="google-calendar-source-empty">{t("No import rules yet, so nothing from Google appears on the calendar. Add one to start pulling a source in.")}</p>
          ) : (
            <div className="gcal-rule-list">
              {googleCalendar.importRules.map((rule) => {
                const busy = !googleCalendarSyncEnabled || googleCalendarAction !== "idle";
                if (editingImportRuleId !== rule.id) {
                  const scope = rule.calendarIds.length
                    ? rule.calendarIds
                        .map((id) => googleCalendar.sources?.find((source) => source.id === id)?.name || id)
                        .join(", ")
                    : t("All calendars");
                  return (
                    <div className={`gcal-rule-card is-summary ${importRuleIsActive(rule) ? "" : "is-off"}`} key={rule.id}>
                      <div className="gcal-rule-head">
                        <div className="gcal-rule-summary">
                          <strong>{rule.name.trim() || t("Unnamed source")}</strong>
                          <span>
                            {rule.aliases.trim() ? t("Matches {aliases}", { aliases: rule.aliases.trim() }) : t("No aliases yet, so nothing imports")}
                          </span>
                          <span>
                            {rule.keywords.trim() ? t("Only when it mentions {keywords}", { keywords: rule.keywords.trim() }) : t("Everything from this source")}
                          </span>
                          <span>{scope}</span>
                        </div>
                        <div className="gcal-rule-summary-actions">
                          <button
                            className="outline-button"
                            type="button"
                            disabled={busy}
                            onClick={() => setEditingImportRuleId(rule.id)}
                          >{t("Edit")}</button>
                          <button
                            className="icon-button"
                            type="button"
                            aria-label={t("Remove {name}", { name: rule.name.trim() || t("source") })}
                            disabled={busy}
                            onClick={() => removeGoogleCalendarImportRule(rule.id)}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                      <label className="google-calendar-source-toggle">
                        <span>{t("Rule active")}</span>
                        <input
                          type="checkbox"
                          checked={rule.enabled}
                          disabled={busy}
                          onChange={(event) => updateGoogleCalendarImportRule(rule.id, { enabled: event.target.checked })}
                        />
                      </label>
                    </div>
                  );
                }
                return (
                  <div className="gcal-rule-card is-editing" key={rule.id}>
                    <div className="gcal-rule-head">
                      <input
                        className="gcal-rule-name"
                        type="text"
                        value={rule.name}
                        placeholder={t("Source name, e.g. Golf HQ Portal")}
                        disabled={busy}
                        onChange={(event) => updateGoogleCalendarImportRule(rule.id, { name: event.target.value })}
                      />
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={t("Remove rule")}
                        disabled={busy}
                        onClick={() => removeGoogleCalendarImportRule(rule.id)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>

                    <label className="gcal-rule-field">
                      <span>{t("Aliases")}</span>
                      <input
                        type="text"
                        value={rule.aliases}
                        placeholder={t("Golf HQ, golfhq.com, bookings@golfhq.co.nz")}
                        disabled={busy}
                        onChange={(event) => updateGoogleCalendarImportRule(rule.id, { aliases: event.target.value })}
                      />
                      <em>{t("Comma separated. An event must contain one of these to match. No aliases means the rule is off.")}</em>
                    </label>

                    <label className="gcal-rule-field">
                      <span>{t("Keywords (optional)")}</span>
                      <input
                        type="text"
                        value={rule.keywords}
                        placeholder={t("lesson, fitting")}
                        disabled={busy}
                        onChange={(event) => updateGoogleCalendarImportRule(rule.id, { keywords: event.target.value })}
                      />
                      <em>{t("Narrows the source. Leave blank to import everything it puts on the calendar.")}</em>
                    </label>

                    <div className="gcal-rule-field">
                      <span>{t("Look in")}</span>
                      {!googleCalendar.sources?.length ? (
                        <em>
                          {googleCalendar.connected
                            ? t("No calendars loaded yet. Reconnect Google and refresh this panel.")
                            : t("Connect Google Calendar to choose calendars.")}
                        </em>
                      ) : (
                        <>
                          <div className="gcal-rule-calendars">
                            {googleCalendar.sources.map((source) => (
                              <label className="gcal-rule-calendar" key={source.id}>
                                <input
                                  type="checkbox"
                                  checked={rule.calendarIds.includes(source.id)}
                                  disabled={busy}
                                  onChange={(event) =>
                                    toggleGoogleCalendarImportRuleCalendar(rule.id, source.id, event.target.checked)
                                  }
                                />
                                <span>{source.name}</span>
                                {source.primary ? <em>{t("Primary")}</em> : null}
                              </label>
                            ))}
                          </div>
                          <em>
                            {rule.calendarIds.length
                              ? tn(rule.calendarIds.length, "Scanning {count} calendar.", "Scanning {count} calendars.")
                              : t("Nothing ticked, so every calendar on the account is scanned.")}
                          </em>
                        </>
                      )}
                    </div>

                    <div className="gcal-rule-toggles">
                      <label className="google-calendar-source-toggle">
                        <span>{t("Show event title")}</span>
                        <input
                          type="checkbox"
                          checked={rule.showLabel}
                          disabled={busy}
                          onChange={(event) => updateGoogleCalendarImportRule(rule.id, { showLabel: event.target.checked })}
                        />
                      </label>
                      <label className="google-calendar-source-toggle">
                        <span>{t("Rule active")}</span>
                        <input
                          type="checkbox"
                          checked={rule.enabled}
                          disabled={busy}
                          onChange={(event) => updateGoogleCalendarImportRule(rule.id, { enabled: event.target.checked })}
                        />
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="gcal-rule-actions">
            <button
              className="outline-button"
              type="button"
              disabled={!googleCalendarSyncEnabled || googleCalendarAction !== "idle"}
              onClick={addGoogleCalendarImportRule}
            >
              <Plus size={16} />{t("Add source")}</button>
            <button
              className="primary-button"
              type="button"
              disabled={!googleCalendarSyncEnabled || googleCalendarAction !== "idle"}
              onClick={() => void saveGoogleCalendarSettings()}
            >
              <Check size={16} />
              {googleCalendarAction === "saving" ? t("Saving") : t("Save rules")}
            </button>
          </div>
        </details>

        {/* What goes the other way: which of this coach's items reach Google,
            and whether a lesson shows who it is with. Anything switched off
            is taken down from Google on the next sync. */}
        <details className="settings-subsection">
          <summary className="settings-subsection-title">
            <ExternalLink size={18} />
            <div>
              <span>{t("Selective event export")}</span>
              <strong>
                {[
                  googleCalendarExport.lessons ? t("Lessons") : "",
                  googleCalendarExport.blocks ? t("Blocked time") : "",
                  googleCalendarExport.unavailable ? t("Unavailable hours") : "",
                ]
                  .filter(Boolean)
                  .join(" · ") || t("Nothing is sent to Google")}
              </strong>
            </div>
          </summary>

          <p className="google-calendar-source-intro">{t("Choose what Clarity sends to this Google calendar. Anything you switch off is removed from Google on the next sync.")}</p>

          <div className="gcal-rule-toggles">
            {(
              [
                ["lessons", t("Lessons")],
                ["blocks", t("Blocked time")],
                ["unavailable", t("Unavailable hours")],
                ["clientDetails", t("Client name, phone and email on lessons")],
              ] as const
            ).map(([key, label]) => (
              <label className="google-calendar-source-toggle" key={key}>
                <span>{label}</span>
                <input
                  type="checkbox"
                  checked={googleCalendarExport[key]}
                  disabled={googleCalendarAction !== "idle" || (key === "clientDetails" && !googleCalendarExport.lessons)}
                  onChange={(event) => updateGoogleCalendarExport({ [key]: event.target.checked })}
                />
              </label>
            ))}
          </div>

          {googleCalendarExport.lessons && services.length ? (
            <div className="gcal-rule-field">
              <span>{t("Lesson types sent")}</span>
              <div className="gcal-rule-calendars">
                {services.map((service) => (
                  <label className="gcal-rule-calendar" key={service.id}>
                    <input
                      type="checkbox"
                      checked={!googleCalendarExport.excludedServiceIds.includes(service.id)}
                      disabled={googleCalendarAction !== "idle"}
                      onChange={(event) =>
                        updateGoogleCalendarExport({
                          excludedServiceIds: event.target.checked
                            ? googleCalendarExport.excludedServiceIds.filter((id) => id !== service.id)
                            : [...googleCalendarExport.excludedServiceIds, service.id],
                        })
                      }
                    />
                    <span>{service.name}</span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}

          <div className="gcal-rule-actions">
            <button
              className="primary-button"
              type="button"
              disabled={!googleCalendarSyncEnabled || googleCalendarAction !== "idle"}
              onClick={() => void saveGoogleCalendarSettings()}
            >
              <Check size={16} />
              {googleCalendarAction === "saving" ? t("Saving") : t("Save export")}
            </button>
          </div>
        </details>

        {/* Developer only: it shows raw Google payloads and failure codes. */}
        {isDeveloper ? (
          <details
            className="settings-subsection gcal-debug"
            open={googleCalendarDebugOpen}
            onToggle={(event) => setGoogleCalendarDebugOpen((event.target as HTMLDetailsElement).open)}
          >
            <summary className="settings-subsection-title">
              <ClarityAdmin size={18} />
              <div>
                <span>{t("Debug")}</span>
                <strong>
                  {googleCalendarDebug
                    ? tn(googleCalendarDebug.entries.length, "{count} recent trigger", "{count} recent triggers")
                    : t("Google failure codes, payloads and triggers")}
                </strong>
              </div>
            </summary>

            <p className="gcal-debug-intro">{t("Every Google Calendar sync attempt is recorded here — what triggered it, the exact event payload sent to the Calendar API, and the failure code Google returned.")}</p>

            <div className="gcal-debug-toolbar">
              <button
                className="outline-button"
                disabled={googleCalendarDebugLoading}
                onClick={() => void refreshGoogleCalendarDebugLog()}
                type="button"
              >
                <RefreshCw size={16} />
                {googleCalendarDebugLoading ? loadingLabel() : t("Refresh")}
              </button>
              <button
                className="outline-button"
                disabled={googleCalendarDebugLoading || !googleCalendarDebug?.entries.length}
                onClick={clearGoogleCalendarDebugLog}
                type="button"
              >
                <Trash2 size={16} />{t("Clear log")}</button>
              <label className="gcal-debug-toggle">
                <input
                  type="checkbox"
                  checked={googleCalendarDebug?.enabled !== false}
                  disabled={googleCalendarDebugLoading || !googleCalendarDebug}
                  onChange={(event) => toggleGoogleCalendarDebugLogging(event.target.checked)}
                />
                <span>{t("Record sync attempts")}</span>
              </label>
            </div>

            {googleCalendarDebugError ? (
              <p className="gcal-debug-error" role="alert">
                {googleCalendarDebugError}
              </p>
            ) : null}

            {googleCalendarDebug ? (
              <div className="gcal-debug-facts">
                <div>
                  <span>{t("Auto-sync")}</span>
                  <strong>{googleCalendarDebug.manualOnly ? t("Manual only") : googleCalendarDebug.autoSync ? t("On") : t("Off")}</strong>
                </div>
                <div>
                  <span>{t("Target calendar")}</span>
                  <strong>{googleCalendarDebug.calendarId || "primary"}</strong>
                </div>
                <div>
                  <span>{t("Log capacity")}</span>
                  <strong>{t("Last {maxEntries} runs", { maxEntries: googleCalendarDebug.maxEntries })}</strong>
                </div>
              </div>
            ) : null}

            {googleCalendarDebug && !googleCalendarDebug.entries.length ? (
              <p className="gcal-debug-empty">{t("No sync attempts recorded yet. Hit")}{" "}<strong>{t("Sync now")}</strong>{" "}{t("on the profile card, or save a booking, then refresh this panel. If nothing ever appears, the sync is not being triggered at all.")}</p>
            ) : null}

            <ol className="gcal-debug-list">
              {(googleCalendarDebug?.entries || []).map((entry) => {
                const expanded = expandedGoogleCalendarDebugId === entry.id;
                const failureCode = googleCalendarFailureCode(entry.error);
                return (
                  <li key={entry.id} className={`gcal-debug-entry is-${entry.outcome}`}>
                    <button
                      className="gcal-debug-entry-head"
                      onClick={() => setExpandedGoogleCalendarDebugId(expanded ? null : entry.id)}
                      aria-expanded={expanded}
                      type="button"
                    >
                      <span className={`gcal-debug-badge is-${entry.outcome}`}>{entry.outcome}</span>
                      <span className="gcal-debug-entry-main">
                        <strong>{googleCalendarTriggerLabel(entry.trigger)}</strong>
                        <em>
                          {googleCalendarDebugTimestamp(entry.startedAt)}
                          {relativeTimeLabel(entry.startedAt) ? ` · ${relativeTimeLabel(entry.startedAt)}` : ""}
                          {t(" · {durationMs}ms", { durationMs: entry.durationMs })}
                        </em>
                      </span>
                      <span className="gcal-debug-entry-result">
                        {entry.outcome === "failed"
                          ? failureCode
                          : entry.outcome === "skipped"
                            ? entry.reason || "skipped"
                            : `${entry.upserted} sent · ${entry.deleted} removed${
                                entry.unchanged ? ` · ${entry.unchanged} unchanged` : ""
                              }`}
                      </span>
                    </button>

                    {expanded ? (
                      <div className="gcal-debug-entry-body">
                        <div className="gcal-debug-grid">
                          <div>
                            <span>{t("Trigger code")}</span>
                            <code>{entry.trigger}</code>
                          </div>
                          <div>
                            <span>{t("Stage reached")}</span>
                            <code>{googleCalendarStageLabel(entry.stage)}</code>
                          </div>
                          <div>
                            <span>{t("Calendar")}</span>
                            <code>{entry.calendarId || "primary"}</code>
                          </div>
                          <div>
                            <span>{t("Google account")}</span>
                            <code>{entry.accountEmail || "—"}</code>
                          </div>
                          <div>
                            <span>{t("Sync mode")}</span>
                            <code>{entry.mode === "full" ? t("Full rebuild") : t("Targeted changes")}</code>
                          </div>
                          <div>
                            <span>{entry.mode === "full" ? t("Bookings in run") : t("Bookings targeted")}</span>
                            <code>{entry.itemCount}</code>
                          </div>
                          <div>
                            <span>{t("Already up to date")}</span>
                            <code>{entry.unchanged || 0}</code>
                          </div>
                          <div>
                            <span>{t("Rate-limit retries")}</span>
                            <code>{entry.retries || 0}</code>
                          </div>
                          <div>
                            <span>{t("Finished")}</span>
                            <code>{googleCalendarDebugTimestamp(entry.finishedAt)}</code>
                          </div>
                        </div>

                        {entry.changes?.length ? (
                          <section className="gcal-debug-block">
                            <h4>{t("Bookings this run targeted")}</h4>
                            <pre className="gcal-debug-pre">
                              {entry.changes.map((change) => `${change.action.toUpperCase()}  ${change.id}`).join("\n")}
                            </pre>
                          </section>
                        ) : null}

                        {entry.outcome === "skipped" || (entry.outcome === "success" && entry.reason) ? (
                          <p className="gcal-debug-note">
                            {googleCalendarSkipReasonLabels[entry.reason] ||
                              (entry.outcome === "skipped"
                                ? t("Skipped: {reason}", { reason: entry.reason || t("unknown reason") })
                                : t("Nothing sent: {reason}", { reason: entry.reason || t("unknown reason") }))}
                          </p>
                        ) : null}

                        {entry.error ? (
                          <section className="gcal-debug-block is-error">
                            <h4>{t("Google failure")}</h4>
                            <div className="gcal-debug-grid">
                              <div>
                                <span>{t("HTTP status")}</span>
                                <code>
                                  {entry.error.httpStatus
                                    ? `${entry.error.httpStatus}${entry.error.httpStatusText ? ` ${entry.error.httpStatusText}` : ""}`
                                    : t("— (failed before the request)")}

                                </code>
                              </div>
                              <div>
                                <span>{t("error.code")}</span>
                                <code>{entry.error.googleCode || "—"}</code>
                              </div>
                              <div>
                                <span>{t("error.status")}</span>
                                <code>{entry.error.googleStatus || "—"}</code>
                              </div>
                              <div>
                                <span>{t("errors[0].reason")}</span>
                                <code>{entry.error.googleReason || "—"}</code>
                              </div>
                              <div>
                                <span>{t("errors[0].domain")}</span>
                                <code>{entry.error.googleDomain || "—"}</code>
                              </div>
                              <div>
                                <span>{t("Clarity code")}</span>
                                <code>{entry.error.providerCode || "—"}</code>
                              </div>
                            </div>
                            <p className="gcal-debug-message">{entry.error.googleMessage || entry.error.message}</p>
                            {googleCalendarFailureHint(entry.error) ? (
                              <p className="gcal-debug-note">{googleCalendarFailureHint(entry.error)}</p>
                            ) : null}
                            {entry.error.rawBody ? (
                              <>
                                <h5>{t("Raw response body")}</h5>
                                <pre className="gcal-debug-pre">{entry.error.rawBody}</pre>
                              </>
                            ) : null}
                          </section>
                        ) : null}

                        {entry.request ? (
                          <section className="gcal-debug-block">
                            <h4>
                              {entry.requestIsSample ? t("Payload sent (sample from this run)") : t("Payload that failed")}
                            </h4>
                            <div className="gcal-debug-grid">
                              <div>
                                <span>{t("Method")}</span>
                                <code>{entry.request.method}</code>
                              </div>
                              <div>
                                <span>{t("Booking")}</span>
                                <code>{entry.request.itemLabel || entry.request.itemId || "—"}</code>
                              </div>
                              <div>
                                <span>{t("Event ID")}</span>
                                <code>{entry.request.eventId || "—"}</code>
                              </div>
                              <div>
                                <span>{t("Clarity booking ID")}</span>
                                <code>{entry.request.itemId || "—"}</code>
                              </div>
                            </div>
                            <h5>{t("Endpoint")}</h5>
                            <pre className="gcal-debug-pre">{entry.request.url}</pre>
                            {entry.request.payload ? (
                              <>
                                <h5>{t("Request body")}</h5>
                                <pre className="gcal-debug-pre">{formatDebugJson(entry.request.payload)}</pre>
                              </>
                            ) : (
                              <p className="gcal-debug-note">{t("No request body (DELETE request).")}</p>
                            )}
                          </section>
                        ) : entry.outcome !== "skipped" ? (
                          <p className="gcal-debug-note">{t("No payload captured — the run failed before building an event, or there were no bookings to send.")}</p>
                        ) : null}

                        <div className="gcal-debug-entry-actions">
                          <button className="outline-button" onClick={() => copyGoogleCalendarDebugEntry(entry)} type="button">
                            <Copy size={16} />{t("Copy entry JSON")}</button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </details>
        ) : null}
      </div>
    </SettingsGroup>
  );
}
