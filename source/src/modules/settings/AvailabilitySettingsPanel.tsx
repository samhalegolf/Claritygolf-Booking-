// Settings › Booking › Availability: each coach's bookable hours.
import { t, tn } from "../../lib/i18n";
import { SNAP_MINUTES, availabilityForCoach, formatTime, fullDayNames, inputTimeToMinutes, minutesToInputTime } from "../calendar/calendarModel";
import { ClaritySessions } from "../shared/ClarityIcons";
import { SettingsGroup } from "./SettingsLayout";
import { formatDurationLabel } from "../../calendar-axis";
import { Check, Plus, X } from "lucide-react";
import type { CSSProperties } from "react";
import type { AvailabilityConflict } from "../../availabilityConflicts";
import type { AvailabilityWindow } from "../calendar/calendarModel";
import type { CoachAccount, CoachProfile } from "../workspace/workspaceModel";
import type { Dispatch, SetStateAction } from "react";

export type AvailabilitySettingsPanelProps = {
  availabilityEditorCoaches: CoachProfile[];
  availabilityEditorCoachId: string;
  setEditingAvailabilityWindow: Dispatch<SetStateAction<string>>;
  availabilityEditorWeek: AvailabilityWindow[][];
  availabilityEditorLocationTabs: { id: string; label: string; }[];
  availabilityConflictList: AvailabilityConflict[];
  availabilitySaveState: "idle" | "saving" | "saved";
  accountAvailability: AvailabilityWindow[][];
  activeCoachId: string;
  availabilityLocationLabel: (locationId?: string) => string;
  updateAvailabilityWindow: (day: number, index: number, field: keyof AvailabilityWindow, value: number) => void;
  coachAccount: CoachAccount;
  setAvailabilityCoachChoice: Dispatch<SetStateAction<string>>;
  copyAvailabilityFromCoach: (sourceCoachId: string) => void;
  availabilityEditorLocationId: string | null;
  availabilityLocationHue: (locationId?: string) => number | null;
  setAvailabilityLocationChoice: Dispatch<SetStateAction<string | null>>;
  setAvailabilityConflictList: Dispatch<SetStateAction<AvailabilityConflict[]>>;
  toggleAvailabilityDay: (day: number) => void;
  editingAvailabilityWindow: string;
  removeAvailabilityWindow: (day: number, index: number) => void;
  addAvailabilityWindow: (day: number) => void;
  saveAvailability: (options?: { ignoreConflicts?: boolean; }) => Promise<void>;
};

export function AvailabilitySettingsPanel(props: AvailabilitySettingsPanelProps) {
  const {
    availabilityEditorCoaches,
    availabilityEditorCoachId,
    setEditingAvailabilityWindow,
    availabilityEditorWeek,
    availabilityEditorLocationTabs,
    availabilityConflictList,
    availabilitySaveState,
    accountAvailability,
    activeCoachId,
    availabilityLocationLabel,
    updateAvailabilityWindow,
    coachAccount,
    setAvailabilityCoachChoice,
    copyAvailabilityFromCoach,
    availabilityEditorLocationId,
    availabilityLocationHue,
    setAvailabilityLocationChoice,
    setAvailabilityConflictList,
    toggleAvailabilityDay,
    editingAvailabilityWindow,
    removeAvailabilityWindow,
    addAvailabilityWindow,
    saveAvailability,
  } = props;
  return (
    <SettingsGroup id="availability" icon={ClaritySessions} section="booking" title={t("Availability")}>
      <div className="availability-layout">
        <div className="data-card wide">
          <div className="data-card-header">
            <div>
              <h2>
                {availabilityEditorCoaches.find((coach) => coach.id === availabilityEditorCoachId)?.displayName ||
                  availabilityEditorCoaches.find((coach) => coach.id === availabilityEditorCoachId)?.name ||
                  coachAccount.venueName}
              </h2>
              <p className="availability-coach-hint">{t("Weekly hours this coach can be booked")}{availabilityEditorLocationTabs.length ? t(", one week per location") : ""}{t(". Each location's hours only open bookings there.")}</p>
            </div>
            <button className="primary-button" onClick={() => void saveAvailability()}>
              {availabilitySaveState === "saving"
                ? t("Saving")
                : availabilitySaveState === "saved"
                ? t("Saved")
                : t("Save Availability")}
            </button>
          </div>
          {availabilityEditorCoaches.length > 1 ? (
            <div className="availability-coach-picker">
              <div className="availability-coach-tabs" role="tablist" aria-label={t("Coach")}>
                {availabilityEditorCoaches.map((coach) => {
                  const weekMinutes = availabilityForCoach(accountAvailability, coach.id, activeCoachId)
                    .flat()
                    .reduce((total, window) => total + (window.end - window.start), 0);
                  const selected = coach.id === availabilityEditorCoachId;
                  return (
                    <button
                      key={coach.id}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      className={`availability-coach-tab ${selected ? "is-selected" : ""}`}
                      onClick={() => {
                        setEditingAvailabilityWindow("");
                        setAvailabilityCoachChoice(coach.id);
                      }}
                    >
                      <strong>{coach.displayName || coach.name}</strong>
                      <small>{weekMinutes ? `${formatDurationLabel(weekMinutes)} / week` : t("No hours set")}</small>
                    </button>
                  );
                })}
              </div>
              <label className="availability-copy-from">
                <span>{t("Copy hours from")}</span>
                <select
                  value=""
                  onChange={(event) => copyAvailabilityFromCoach(event.target.value)}
                >
                  <option value="">{t("Choose coach")}</option>
                  {availabilityEditorCoaches
                    .filter((coach) => coach.id !== availabilityEditorCoachId)
                    .map((coach) => (
                      <option key={coach.id} value={coach.id}>
                        {coach.displayName || coach.name}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          ) : null}
          {availabilityEditorLocationTabs.length ? (
            <div className="availability-location-tabs" role="tablist" aria-label={t("Location")}>
              {availabilityEditorLocationTabs.map((tab) => {
                const selected = tab.id === availabilityEditorLocationId;
                const minutes = availabilityForCoach(accountAvailability, availabilityEditorCoachId, activeCoachId)
                  .flat()
                  .filter((window) => (window.locationId || "") === tab.id)
                  .reduce((total, window) => total + (window.end - window.start), 0);
                const hue = tab.id ? availabilityLocationHue(tab.id) : null;
                return (
                  <button
                    key={tab.id || "any"}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className={`availability-location-tab ${selected ? "is-selected" : ""}`}
                    style={hue !== null ? ({ ["--location-hue" as string]: String(hue) } as CSSProperties) : undefined}
                    onClick={() => {
                      setEditingAvailabilityWindow("");
                      setAvailabilityLocationChoice(tab.id);
                    }}
                  >
                    <strong>{tab.label}</strong>
                    <small>{minutes ? `${formatDurationLabel(minutes)} / week` : t("No hours")}</small>
                  </button>
                );
              })}
            </div>
          ) : null}
          {availabilityConflictList.length ? (
            <div className="availability-conflicts" role="alert">
              <strong>
                {tn(availabilityConflictList.length, "One clash: a coach is down at two locations at once", "{count} clashes: a coach is down at two locations at once")}</strong>
              <ul>
                {availabilityConflictList.slice(0, 8).map((conflict, index) => {
                  const coach = availabilityEditorCoaches.find((entry) => entry.id === conflict.coachId);
                  return (
                    <li key={index}>
                      {coach?.displayName || coach?.name || t("Coach")}{" "}{t("· {fullDayNames} {start} – {end} · {locationIds} and {locationIds2}", { fullDayNames: fullDayNames[conflict.day], start: formatTime(conflict.start), end: formatTime(conflict.end), locationIds: availabilityLocationLabel(conflict.locationIds[0]), locationIds2: availabilityLocationLabel(conflict.locationIds[1]) })}</li>
                  );
                })}
              </ul>
              <p>{t("Clients could book them at both places for the same time. Save anyway if that's intended.")}</p>
              <div className="availability-conflict-actions">
                <button className="primary-button" onClick={() => void saveAvailability({ ignoreConflicts: true })} type="button">{t("Save anyway")}</button>
                <button className="outline-button" onClick={() => setAvailabilityConflictList([])} type="button">{t("Keep editing")}</button>
              </div>
            </div>
          ) : null}
          <div className="availability-editor">
            {fullDayNames.map((dayName, dayIndex) => (
              <details className="settings-subsection availability-edit-row" key={dayName}>
                <summary className="settings-subsection-title availability-day-title">
                  <ClaritySessions size={18} />
                  <div>
                    <span>{dayName}</span>
                    <strong>
                      {availabilityEditorWeek[dayIndex].length
                        ? availabilityEditorWeek[dayIndex]
                            .map((window) => `${formatTime(window.start)} - ${formatTime(window.end)}`)
                            .join(", ")
                        : t("Closed")}
                    </strong>
                  </div>
                </summary>
                <div className="availability-day-controls">
                  <button className="outline-button compact-button" onClick={() => toggleAvailabilityDay(dayIndex)}>
                    {availabilityEditorWeek[dayIndex].length ? t("Closed") : t("Open")}
                  </button>
                </div>
                <div className="availability-windows">
                  {availabilityEditorWeek[dayIndex].map((window, windowIndex) => {
                    const windowKey = `${dayIndex}-${windowIndex}`;
                    const isEditingWindow = editingAvailabilityWindow === windowKey;
                    return (
                      <div
                        className={`availability-window ${isEditingWindow ? "is-editing" : ""}`}
                        key={`${dayName}-${windowIndex}`}
                      >
                        {isEditingWindow ? (
                          <>
                            <label>
                              <span>{t("From")}</span>
                              <input
                                value={minutesToInputTime(window.start)}
                                onChange={(event) =>
                                  updateAvailabilityWindow(
                                    dayIndex,
                                    windowIndex,
                                    "start",
                                    inputTimeToMinutes(event.target.value, window.start),
                                  )
                                }
                                type="time"
                                step={SNAP_MINUTES * 60}
                              />
                            </label>
                            <label>
                              <span>{t("To")}</span>
                              <input
                                value={minutesToInputTime(window.end)}
                                onChange={(event) =>
                                  updateAvailabilityWindow(
                                    dayIndex,
                                    windowIndex,
                                    "end",
                                    inputTimeToMinutes(event.target.value, window.end),
                                  )
                                }
                                type="time"
                                step={SNAP_MINUTES * 60}
                              />
                            </label>
                            <button
                              className="icon-button small"
                              aria-label={t("Done editing {dayName} window", { dayName })}
                              onClick={() => setEditingAvailabilityWindow("")}
                            >
                              <Check size={15} />
                            </button>
                          </>
                        ) : (
                          <button
                            className="availability-range-button"
                            onClick={() => setEditingAvailabilityWindow(windowKey)}
                            type="button"
                          >
                            <ClaritySessions size={15} />
                            {formatTime(window.start)} - {formatTime(window.end)}
                          </button>
                        )}
                        <button
                          className="icon-button small"
                          aria-label={t("Remove {dayName} window", { dayName })}
                          onClick={() => removeAvailabilityWindow(dayIndex, windowIndex)}
                        >
                          <X size={15} />
                        </button>
                      </div>
                    );
                  })}
                  <button className="outline-button compact-button add-time-button" onClick={() => addAvailabilityWindow(dayIndex)}>
                    <Plus size={15} />{t("Add time")}</button>
                </div>
              </details>
            ))}
          </div>
        </div>
      </div>
    </SettingsGroup>
  );
}
