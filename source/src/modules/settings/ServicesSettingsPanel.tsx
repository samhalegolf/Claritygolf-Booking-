// Settings › Lesson types: the catalogue and the service editor. Drawn here;
// the editor state and the save handlers still live in App.tsx and arrive as
// props. Loaded with Settings, not with the shell.
import { t } from "../../lib/i18n";
import { DEFAULT_CUSTOM_GROUP_MAX_PARTICIPANTS, MAX_GROUP_OCCURRENCE_COUNT, MAX_REVIEW_TURNAROUND_DAYS, canPricePerPerson, defaultServiceColor, emptyServiceEditor, hasCustomGroupFlag, serviceEditorFormat, serviceFormatLabel, servicePriceLabel } from "../services/serviceModel";
import { timeToMinutes } from "../../lib/date";
import { Archive, ChevronDown, ChevronUp, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { BOOKING_SCREENS, formatBookingScreenLabels } from "../public-booking/bookingScreens";
import { SNAP_MINUTES, bookingCoachSnapshotFor, bookingLocationShortDisplay, bookingLocationSnapshotFor, fullDayNames, inputTimeToMinutes, minutesToInputTime } from "../calendar/calendarModel";
import { resourceSelectionId } from "../../../netlify/functions/_shared/resources.mts";
import { ClarityServices } from "../shared/ClarityIcons";
import { firstCoachId, locationById } from "../workspace/workspaceModel";
import type { Location } from "../workspace/workspaceModel";
import type { BusinessTerminology } from "../../../netlify/functions/_shared/business-terminology.mts";
import type { LocationResource, ResourceMode } from "../../../netlify/functions/_shared/resources.mts";
import type { GroupServiceSchedule, Service, ServiceEditor, ServiceEditorFormat, ServiceListTab, ServiceNumberField } from "../services/serviceModel";
import type { CoachAccount, CoachProfile } from "../workspace/workspaceModel";
import type { Dispatch, SetStateAction } from "react";

export type ServicesSettingsPanelProps = {
  serviceEditor: ServiceEditor;
  terms: BusinessTerminology;
  updateServiceEditor: <K extends keyof ServiceEditor>(field: K, value: ServiceEditor[K]) => void;
  serviceNumberInputValue: (field: ServiceNumberField) => string;
  updateServiceNumberDraft: (field: ServiceNumberField, raw: string) => void;
  commitServiceNumberDraft: (field: ServiceNumberField) => void;
  isAdminUser: boolean;
  activeCoachList: CoachProfile[];
  updateGroupSchedule: <K extends keyof GroupServiceSchedule>(field: K, value: GroupServiceSchedule[K]) => void;
  applyGroupDraftInputs: () => ServiceEditor;
  serviceEditorResourceLocations: Location[];
  serviceSaveState: "idle" | "saving" | "saved" | "error";
  serviceListTab: ServiceListTab;
  requestServiceAction: (service: Service, mode: "archive" | "delete") => void;
  editingServiceId: string | null;
  groupMaximumInput: string;
  toggleServiceEditorScope: (field: "coachIds" | "locationIds", id: string, order: string[]) => void;
  activeLocationList: Location[];
  setServiceEditorResourceMode: (mode: ResourceMode) => void;
  serviceEditorClarityResourceLocations: Location[];
  serviceEditorResourceGroups: { key: string; type: string; resources: Array<{ location: Location; resource: LocationResource; }>; }[];
  serviceEditorResourceChosen: (location: Location, resource: LocationResource) => boolean;
  activeServices: Service[];
  setServiceListTab: Dispatch<SetStateAction<ServiceListTab>>;
  listedLessonTypes: Service[];
  editService: (service: Service) => void;
  coachProfiles: CoachProfile[];
  locations: Location[];
  canPermanentlyDeleteService: (service: Service) => boolean;
  startNewService: () => void;
  showServiceEditor: boolean;
  setShowServiceEditor: Dispatch<SetStateAction<boolean>>;
  setEditingServiceId: Dispatch<SetStateAction<string | null>>;
  setServiceNumberDrafts: Dispatch<SetStateAction<Partial<Record<ServiceNumberField, string>>>>;
  setServiceEditor: Dispatch<SetStateAction<ServiceEditor>>;
  updateServiceEditorFormat: (format: ServiceEditorFormat) => void;
  updateBookingScreens: (screenId: string, checked: boolean) => void;
  groupOccurrenceInput: string;
  setGroupOccurrenceInput: Dispatch<SetStateAction<string>>;
  groupMinimumInput: string;
  setGroupMinimumInput: Dispatch<SetStateAction<string>>;
  setGroupMaximumInput: Dispatch<SetStateAction<string>>;
  openResourceTypes: string[];
  serviceEditorTypeChosen: (key: string) => boolean;
  toggleServiceEditorResourceType: (group: { key: string; type: string; resources: Array<{ location: Location; resource: LocationResource; }>; }) => void;
  setOpenResourceTypes: Dispatch<SetStateAction<string[]>>;
  toggleServiceEditorResource: (group: { key: string; type: string; resources: Array<{ location: Location; resource: LocationResource; }>; }, location: Location, resource: LocationResource) => void;
  saveEditedService: () => void;
  coachAccount: CoachAccount;
  restoreService: (service: Service) => void;
};

export function ServicesSettingsPanel(props: ServicesSettingsPanelProps) {
  const {
    serviceEditor,
    terms,
    updateServiceEditor,
    serviceNumberInputValue,
    updateServiceNumberDraft,
    commitServiceNumberDraft,
    isAdminUser,
    activeCoachList,
    updateGroupSchedule,
    applyGroupDraftInputs,
    serviceEditorResourceLocations,
    serviceSaveState,
    serviceListTab,
    requestServiceAction,
    editingServiceId,
    groupMaximumInput,
    toggleServiceEditorScope,
    activeLocationList,
    setServiceEditorResourceMode,
    serviceEditorClarityResourceLocations,
    serviceEditorResourceGroups,
    serviceEditorResourceChosen,
    activeServices,
    setServiceListTab,
    listedLessonTypes,
    editService,
    coachProfiles,
    locations,
    canPermanentlyDeleteService,
    startNewService,
    showServiceEditor,
    setShowServiceEditor,
    setEditingServiceId,
    setServiceNumberDrafts,
    setServiceEditor,
    updateServiceEditorFormat,
    updateBookingScreens,
    groupOccurrenceInput,
    setGroupOccurrenceInput,
    groupMinimumInput,
    setGroupMinimumInput,
    setGroupMaximumInput,
    openResourceTypes,
    serviceEditorTypeChosen,
    toggleServiceEditorResourceType,
    setOpenResourceTypes,
    toggleServiceEditorResource,
    saveEditedService,
    coachAccount,
    restoreService,
  } = props;
  const customGroup = serviceEditor.lessonFormat === "group" && hasCustomGroupFlag(serviceEditor);
  const priceField: ServiceNumberField = customGroup ? "basePrice" : "price";
  return (
    <div className="settings-section settings-services">
      <div className="service-layout">
        <div className="services-topline">
          <div>
            <span>{t("{serviceSingular} options", { serviceSingular: terms.serviceSingular })}</span>
            <h2>{t("{serviceSingular} types", { serviceSingular: terms.serviceSingular })}</h2>
          </div>
          <button className="outline-button" onClick={startNewService}>
            <Plus size={16} />{t("New")}</button>
        </div>

        {showServiceEditor && (
          <article className="data-card service-editor">
            <div className="data-card-header">
              <div>
                <span>{editingServiceId ? t("Edit {serviceSingular} Type", { serviceSingular: terms.serviceSingular }) : t("New {serviceSingular} Type", { serviceSingular: terms.serviceSingular })}</span>
                <h2>{editingServiceId ? serviceEditor.name || `${terms.serviceSingular} details` : t("Add {serviceSingular}", { serviceSingular: terms.serviceSingular.toLowerCase() })}</h2>
              </div>
              <button
                className="outline-button"
                onClick={() => {
                  setShowServiceEditor(false);
                  setEditingServiceId(null);
                  setServiceNumberDrafts({});
                  setServiceEditor(emptyServiceEditor());
                }}
              >
                <X size={16} />{t("Close")}</button>
            </div>

            <div className="service-form">
              <div className="service-form-row">
                <label className="settings-field">
                  <span>{t("Lesson format")}</span>
                  <select
                    value={serviceEditorFormat(serviceEditor)}
                    onChange={(event) => updateServiceEditorFormat(event.target.value as ServiceEditorFormat)}
                  >
                    <option value="private">{t("Private lesson")}</option>
                    <option value="group">{t("Group lesson")}</option>
                    <option value="custom-group">{t("Custom group lesson")}</option>
                    <option value="video-review">{t("Video review (no set time)")}</option>
                    {/* Only an older package opened from somewhere else shows
                        this; new pass types are made in Billing > Passes. */}
                    {serviceEditor.lessonFormat === "package" && <option value="package">{t("Package")}</option>}
                  </select>
                </label>
                <label className="settings-field">
                  <span>{t("Visibility")}</span>
                  <select
                    value={serviceEditor.visibility}
                    onChange={(event) =>
                      updateServiceEditor("visibility", event.target.value === "private" ? "private" : "public")
                    }
                  >
                    <option value="public">{t("Public booking page")}</option>
                    <option value="private">{t("Admin only")}</option>
                  </select>
                </label>
                <label className="settings-field">
                  <span>{t("Show on booking screens")}</span>
                  <div className="service-screen-checkboxes">
                    {BOOKING_SCREENS.map((screen) => (
                      <label className="settings-toggle" key={screen.id}>
                        <input
                          checked={Boolean((serviceEditor.bookingScreenIds ?? ["main"]).includes(screen.id))}
                          onChange={(event) => updateBookingScreens(screen.id, event.target.checked)}
                          type="checkbox"
                        />
                        <span>{screen.label}</span>
                      </label>
                    ))}
                  </div>
                  {serviceEditor.visibility === "private" && (
                    <p className="field-help">{t("Admin-only lesson types will not appear publicly until visibility is set to Public.")}</p>
                  )}
                </label>
              </div>
              <label className="settings-field">
                <span>{t("Name")}</span>
                <input
                  value={serviceEditor.name}
                  onChange={(event) => updateServiceEditor("name", event.target.value)}
                  placeholder={`${terms.serviceSingular} name`}
                />
              </label>
              {/* The colour lives on the lesson type because that is the thing
                  it identifies. A card on the calendar is filled with it, which
                  is how a week reads as several kinds of lesson at a glance. */}
              <label className="settings-field calendar-colour-field service-colour-field">
                <input
                  type="color"
                  value={serviceEditor.color || defaultServiceColor(0)}
                  aria-label={t("Calendar colour for this lesson type")}
                  onChange={(event) => updateServiceEditor("color", event.target.value)}
                />
                <span>
                  <strong>{t("Calendar colour")}</strong>
                  <em>{t("Card fill")}</em>
                </span>
                <code>{serviceEditor.color || defaultServiceColor(0)}</code>
              </label>
              <label className="settings-field">
                <span>{t("Optional description")}</span>
                <input
                  value={serviceEditor.description}
                  onChange={(event) => updateServiceEditor("description", event.target.value)}
                  placeholder={t("Short booking note")}
                />
              </label>
              <div className="service-form-row">
                <label className="settings-field">
                  <span>{t("Duration")}</span>
                  <input
                    value={serviceNumberInputValue("duration")}
                    min={15}
                    max={240}
                    step={15}
                    inputMode="numeric"
                    onChange={(event) => updateServiceNumberDraft("duration", event.target.value)}
                    onBlur={() => commitServiceNumberDraft("duration")}
                    type="number"
                  />
                </label>
                {/* One price box. A custom group's price is its base price, so
                    there the box edits that and `price` follows it on save. */}
                <label className="settings-field">
                  <span>{customGroup ? t("Base price NZD") : t("Price NZD")}</span>
                  <input
                    value={serviceNumberInputValue(priceField)}
                    min={0}
                    step={1}
                    inputMode="decimal"
                    onChange={(event) => updateServiceNumberDraft(priceField, event.target.value)}
                    onBlur={() => commitServiceNumberDraft(priceField)}
                    type="number"
                  />
                </label>
                {canPricePerPerson(serviceEditor) && (
                  <div className="settings-field">
                    <span>{t("Pricing")}</span>
                    <div className="service-price-mode" role="radiogroup" aria-label={t("Pricing")}>
                      {(["per-person", "session"] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          role="radio"
                          aria-checked={serviceEditor.priceMode === mode}
                          className={`pill ${serviceEditor.priceMode === mode ? "active-pill" : ""}`}
                          onClick={() => updateServiceEditor("priceMode", mode)}
                        >
                          {mode === "per-person" ? t("Per person") : t("Total")}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              {customGroup && (
                <div className="service-form-row">
                  <label className="settings-field">
                    <span>{t("Base participants")}</span>
                    <input
                      value={serviceNumberInputValue("baseParticipants")}
                      min={serviceEditor.minParticipants}
                      max={serviceEditor.capacity}
                      step={1}
                      inputMode="numeric"
                      onChange={(event) => updateServiceNumberDraft("baseParticipants", event.target.value)}
                      onBlur={() => commitServiceNumberDraft("baseParticipants")}
                      type="number"
                    />
                  </label>
                  <label className="settings-field">
                    <span>{t("Extra person NZD")}</span>
                    <input
                      value={serviceNumberInputValue("extraPersonPrice")}
                      min={0}
                      step={1}
                      inputMode="decimal"
                      onChange={(event) => updateServiceNumberDraft("extraPersonPrice", event.target.value)}
                      onBlur={() => commitServiceNumberDraft("extraPersonPrice")}
                      type="number"
                    />
                  </label>
                </div>
              )}
              <div className="service-form-row">
                {serviceEditor.lessonFormat === "group" && !hasCustomGroupFlag(serviceEditor) && (
                  <label className="settings-field">
                    <span>{t("Day of week")}</span>
                    <select
                      value={serviceEditor.groupSchedule?.dayOfWeek ?? 2}
                      onChange={(event) => updateGroupSchedule("dayOfWeek", Number(event.target.value))}
                    >
                      {fullDayNames.map((dayName, index) => (
                        <option key={dayName} value={index}>
                          {dayName}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {serviceEditor.lessonFormat === "group" && !hasCustomGroupFlag(serviceEditor) && (
                  <label className="settings-field">
                    <span>{t("Start time")}</span>
                    <input
                      value={minutesToInputTime(serviceEditor.groupSchedule?.startMinutes ?? timeToMinutes(18, 0))}
                      inputMode="numeric"
                      onChange={(event) =>
                        updateGroupSchedule(
                          "startMinutes",
                          inputTimeToMinutes(
                            event.target.value,
                            serviceEditor.groupSchedule?.startMinutes ?? timeToMinutes(18, 0),
                          ),
                        )
                      }
                      type="time"
                      step={SNAP_MINUTES * 60}
                    />
                  </label>
                )}
                {serviceEditor.lessonFormat === "group" && !hasCustomGroupFlag(serviceEditor) && (
                  <label className="settings-field">
                    <span>{t("Generate next")}</span>
                    <input
                      value={groupOccurrenceInput}
                      min={1}
                      max={MAX_GROUP_OCCURRENCE_COUNT}
                      step={1}
                      inputMode="numeric"
                      onChange={(event) => setGroupOccurrenceInput(event.target.value)}
                      onBlur={() => void applyGroupDraftInputs()}
                      type="number"
                    />
                  </label>
                )}
                {serviceEditor.lessonFormat === "group" && (
                  <label className="settings-field">
                    <span>{hasCustomGroupFlag(serviceEditor) ? t("Minimum participants") : t("Minimum group")}</span>
                    <input
                      value={groupMinimumInput}
                      min={2}
                      max={Number(groupMaximumInput) || 24}
                      step={1}
                      inputMode="numeric"
                      onChange={(event) => setGroupMinimumInput(event.target.value)}
                      onBlur={() => void applyGroupDraftInputs()}
                      type="number"
                    />
                  </label>
                )}
                {serviceEditor.lessonFormat === "group" && !hasCustomGroupFlag(serviceEditor) && (
                  <label className="settings-toggle">
                    <input
                      checked={serviceEditor.groupSchedule?.active !== false}
                      onChange={(event) => updateGroupSchedule("active", event.target.checked)}
                      type="checkbox"
                    />
                    <span>{t("Enable recurring schedule")}</span>
                  </label>
                )}
                {serviceEditor.lessonFormat !== "package" && (
                  <label className="settings-field">
                    <span>
                      {hasCustomGroupFlag(serviceEditor)
                        ? t("Max participants")
                        : serviceEditor.lessonFormat === "group"
                          ? t("Maximum group")
                          : t("Capacity")}
                    </span>
                    <input
                      value={groupMaximumInput}
                      min={serviceEditor.lessonFormat === "group" ? 2 : 1}
                      max={hasCustomGroupFlag(serviceEditor) ? DEFAULT_CUSTOM_GROUP_MAX_PARTICIPANTS : 24}
                      step={1}
                      inputMode="numeric"
                      onChange={(event) => setGroupMaximumInput(event.target.value)}
                      onBlur={() => void applyGroupDraftInputs()}
                      type="number"
                    />
                  </label>
                )}
                {(isAdminUser || activeCoachList.length > 1) && (
                  <div className="service-scope-field">
                    <span>{terms.staffPlural}</span>
                    <small>
                      {isAdminUser
                        ? t("Who teaches it. Customers see every time any of them is free.")
                        : t("Who teaches it. An admin can change this.")}
                    </small>
                    <div className="service-resource-choices" aria-label={t("{staffPlural} who provide this {serviceSingular} type", { staffPlural: terms.staffPlural, serviceSingular: terms.serviceSingular.toLowerCase() })}>
                      {activeCoachList.map((coach) => {
                        const chosen = serviceEditor.coachIds.includes(coach.id);
                        return (
                          <button
                            key={coach.id}
                            type="button"
                            aria-pressed={chosen}
                            disabled={!isAdminUser}
                            className={`service-resource-chip ${chosen ? "is-selected" : ""}`}
                            onClick={() =>
                              toggleServiceEditorScope(
                                "coachIds",
                                coach.id,
                                activeCoachList.map((entry) => entry.id),
                              )
                            }
                          >
                            {coach.displayName || coach.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {serviceEditor.lessonFormat !== "package" && serviceEditor.lessonFormat !== "video-review" && (
                  <div className="service-scope-field">
                    <span>{t("Locations")}</span>
                    <small>{t("Where it runs. Customers see every time it is free at any of them.")}</small>
                    <div className="service-resource-choices" aria-label={t("Locations this lesson type runs at")}>
                      {activeLocationList.map((location) => {
                        const chosen = serviceEditor.locationIds.includes(location.id);
                        return (
                          <button
                            key={location.id}
                            type="button"
                            aria-pressed={chosen}
                            className={`service-resource-chip ${chosen ? "is-selected" : ""}`}
                            onClick={() =>
                              toggleServiceEditorScope(
                                "locationIds",
                                location.id,
                                activeLocationList.map((entry) => entry.id),
                              )
                            }
                          >
                            {location.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {serviceEditorResourceLocations.length > 0 &&
                serviceEditor.lessonFormat !== "package" &&
                serviceEditor.lessonFormat !== "video-review" ? (
                  <div className="service-resource-field">
                    <span>{t("Resources")}</span>
                    <label className="settings-toggle">
                      <input
                        checked={serviceEditor.resourceMode === "usable"}
                        onChange={() => setServiceEditorResourceMode("usable")}
                        type="checkbox"
                      />
                      <span>{t("Resource usable")}<small>{t("Takes a free one when there is one. Still bookable when they are all in use.")}</small>
                      </span>
                    </label>
                    <label className="settings-toggle">
                      <input
                        checked={serviceEditor.resourceMode === "required"}
                        onChange={() => setServiceEditorResourceMode("required")}
                        type="checkbox"
                      />
                      <span>{t("Resource required")}<small>{t("Only bookable while one is free.")}</small>
                      </span>
                    </label>
                    {serviceEditor.resourceMode && serviceEditor.resourceMode !== "none" ? (
                      <>
                        {serviceEditorResourceLocations.length > serviceEditorClarityResourceLocations.length ? (
                          <small>
                            {serviceEditorResourceLocations
                              .filter((location) => location.resourceSource === "external")
                              .map((location) => location.shortName || location.name)
                              .join(", ")}{" "}{t("is tracked by another booking system, so Clarity won't limit bookings there.")}</small>
                        ) : null}
                        {serviceEditorResourceGroups.length > 0 ? (
                          <div className="service-resource-types" aria-label={t("Resources this lesson type can use")}>
                            <small>
                              {(serviceEditor.resourceTypes ?? []).length || (serviceEditor.resourceIds ?? []).length
                                ? t("Can use only the ones chosen. Choose a type for all of them, or open it to choose single ones.")
                                : t("Nothing chosen, so it can use any of them. Choose a type for all of them, or open it to choose single ones.")}
                            </small>
                            {serviceEditorResourceGroups.map((group) => {
                              const groupKey = group.key || "(no type)";
                              const open = openResourceTypes.includes(groupKey);
                              const chosenCount = group.resources.filter(({ location, resource }) =>
                                serviceEditorResourceChosen(location, resource),
                              ).length;
                              const wholeType = group.key
                                ? serviceEditorTypeChosen(group.key)
                                : chosenCount === group.resources.length;
                              return (
                                <div className="service-resource-type" key={groupKey}>
                                  <div className="service-resource-type-row">
                                    <label className="settings-toggle">
                                      <input
                                        checked={wholeType}
                                        onChange={() => toggleServiceEditorResourceType(group)}
                                        type="checkbox"
                                      />
                                      <span>
                                        {group.type || t("No type")}
                                        <small>
                                          {wholeType
                                            ? t("All {length}", { length: group.resources.length })
                                            : chosenCount
                                              ? t("{chosen} of {total}", { chosen: chosenCount, total: group.resources.length })
                                              : group.resources.length === 1
                                                ? t("1 resource")
                                                : t("{n} resources", { n: group.resources.length })}
                                        </small>
                                      </span>
                                    </label>
                                    <button
                                      className="icon-button small"
                                      type="button"
                                      aria-expanded={open}
                                      aria-label={
                                        open
                                          ? t("Hide {type} resources", { type: group.type || t("untyped") })
                                          : t("Show {type} resources", { type: group.type || t("untyped") })
                                      }
                                      onClick={() =>
                                        setOpenResourceTypes((current) =>
                                          open ? current.filter((key) => key !== groupKey) : [...current, groupKey],
                                        )
                                      }
                                    >
                                      {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                                    </button>
                                  </div>
                                  {open ? (
                                    <div className="service-resource-choices">
                                      {group.resources.map(({ location, resource }) => {
                                        const chosen = serviceEditorResourceChosen(location, resource);
                                        return (
                                          <button
                                            key={resourceSelectionId(location.id, resource.id)}
                                            type="button"
                                            aria-pressed={chosen}
                                            className={`service-resource-chip ${chosen ? "is-selected" : ""}`}
                                            onClick={() => toggleServiceEditorResource(group, location, resource)}
                                          >
                                            {resource.name}
                                            {serviceEditorClarityResourceLocations.length > 1
                                              ? ` · ${location.shortName || location.name}`
                                              : ""}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                ) : null}
                <label className="settings-field">
                  <span>{t("Lesson note")}</span>
                  {/* Optional and free text. The placeholder is a generic hint on
                      purpose -- it used to read "Bay hire included", one
                      business's own wording, which read as a prescribed value. */}
                  <input
                    value={serviceEditor.lessonNote ?? serviceEditor.location ?? ""}
                    onChange={(event) => updateServiceEditor("lessonNote", event.target.value)}
                    placeholder={t("Optional")}
                  />
                </label>
              </div>
              {serviceEditor.lessonFormat === "video-review" && (
                <div className="service-form-row">
                  <label className="settings-field">
                    <span>{t("Turnaround (days)")}</span>
                    <input
                      value={serviceNumberInputValue("reviewTurnaroundDays")}
                      min={1}
                      max={MAX_REVIEW_TURNAROUND_DAYS}
                      step={1}
                      inputMode="numeric"
                      onChange={(event) => updateServiceNumberDraft("reviewTurnaroundDays", event.target.value)}
                      onBlur={() => commitServiceNumberDraft("reviewTurnaroundDays")}
                      type="number"
                    />
                    <p className="field-help">{t("A review has no appointment time. Booking one puts it on your calendar on the day it is due back, at the end of that day, so it sits with the rest of that day's work. Duration is how long you expect to spend on it.")}</p>
                  </label>
                </div>
              )}
              {serviceEditor.lessonFormat === "package" && (
                <div className="service-form-row">
                  <label className="settings-field">
                    <span>{t("Allowance")}</span>
                    <input
                      value={serviceNumberInputValue("packageAllowance")}
                      min={1}
                      max={100}
                      step={1}
                      inputMode="numeric"
                      onChange={(event) => updateServiceNumberDraft("packageAllowance", event.target.value)}
                      onBlur={() => commitServiceNumberDraft("packageAllowance")}
                      type="number"
                    />
                  </label>
                  <label className="settings-field">
                    <span>{t("Coverage style")}</span>
                    <select
                      value={serviceEditor.packageCoverageMode ?? "upfront"}
                      onChange={(event) =>
                        updateServiceEditor(
                          "packageCoverageMode",
                          event.target.value === "lesson-by-lesson" ? "lesson-by-lesson" : "upfront",
                        )
                      }
                    >
                      <option value="upfront">{t("Paid upfront")}</option>
                      <option value="lesson-by-lesson">{t("Lesson-by-lesson")}</option>
                    </select>
                  </label>
                  <label className="settings-field">
                    <span>{t("Covers lesson type")}</span>
                    <select
                      value={serviceEditor.packageCoversServiceId ?? ""}
                      onChange={(event) => updateServiceEditor("packageCoversServiceId", event.target.value)}
                    >
                      <option value="">{t("Choose a lesson type")}</option>
                      {activeServices
                        .filter((service) => service.lessonFormat !== "package")
                        .map((service) => (
                          <option key={service.id} value={service.id}>
                            {service.name}
                          </option>
                        ))}
                    </select>
                    <p className="field-help">{t("Credits from this package can only pay for the lesson type you pick here. A package that covers nothing cannot be sold or spent.")}</p>
                  </label>
                </div>
              )}
              {serviceEditor.lessonFormat === "package" ? (
                <label className="settings-toggle">
                  <input
                    checked={serviceEditor.crossRedeemable === true}
                    onChange={(event) => updateServiceEditor("crossRedeemable", event.target.checked)}
                    type="checkbox"
                  />
                  <span>{t("Cross redeemable by its original purchase value")}</span>
                </label>
              ) : (
                <label className="settings-toggle">
                  <input
                    checked={serviceEditor.acceptsCrossRedemption !== false}
                    onChange={(event) => updateServiceEditor("acceptsCrossRedemption", event.target.checked)}
                    type="checkbox"
                  />
                  <span>{t("Accept Clarity balance from other eligible passes")}</span>
                </label>
              )}
              <label className="settings-toggle">
                <input
                  checked={serviceEditor.active}
                  onChange={(event) => updateServiceEditor("active", event.target.checked)}
                  type="checkbox"
                />
                <span>{t("Active and bookable")}</span>
              </label>
            </div>

            <button className="primary-button settings-save" onClick={saveEditedService}>
              {serviceSaveState === "saving"
                ? t("Saving")
                : serviceSaveState === "saved"
                  ? t("Saved")
                  : serviceSaveState === "error"
                    ? t("Not saved")
                    : t("Save {serviceSingular} Type", { serviceSingular: terms.serviceSingular })}
            </button>
          </article>
        )}

        <details className="settings-subsection service-list-section">
          <summary className="settings-subsection-title">
            <ClarityServices size={18} />
            <div>
              <span>{t("{serviceSingular} types", { serviceSingular: terms.serviceSingular })}</span>
              <strong>{t("{length} active", { length: activeServices.filter((service) => service.lessonFormat !== "package").length })}</strong>
            </div>
          </summary>
          <div className="service-list-tabs" role="tablist" aria-label={t("{serviceSingular} type status", { serviceSingular: terms.serviceSingular })}>
            <button
              className={`pill ${serviceListTab === "active" ? "active-pill" : ""}`}
              onClick={() => setServiceListTab("active")}
              type="button"
            >{t("Active")}</button>
            <button
              className={`pill ${serviceListTab === "archived" ? "active-pill" : ""}`}
              onClick={() => setServiceListTab("archived")}
              type="button"
            >{t("Archived")}</button>
          </div>
          <div className="service-list" aria-label={t("{serviceSingular} types", { serviceSingular: terms.serviceSingular })}>
            {listedLessonTypes.map((service) => (
              <article className={`service-row ${service.active ? "" : "is-archived"}`} key={service.id}>
                <button className="service-row-main" onClick={() => editService(service)} type="button">
                  <span>
                    {service.archived ? t("Archived") : service.active ? t("Active") : t("Inactive")} · {service.visibility === "public" ? t("Public") : t("Admin only")} ·{" "}
                    {serviceFormatLabel(service)} ·{" "}
                    {formatBookingScreenLabels(service.bookingScreenIds ?? ["main"]).join(", ")}
                  </span>
                  <strong>{service.name}</strong>
                  {service.description && <em>{service.description}</em>}
                  {(isAdminUser || activeCoachList.length > 1) && (
                    <em>
                      {service.coachIds.length > 1 ? terms.staffPlural : terms.staffSingular}:{" "}
                      {(service.coachIds.length ? service.coachIds : [firstCoachId(coachProfiles)])
                        .map((id) => {
                          const coach = bookingCoachSnapshotFor(id, coachProfiles);
                          return coach?.displayName || coach?.name || "";
                        })
                        .filter(Boolean)
                        .join(", ") || t("None")}
                    </em>
                  )}
                  <em>
                    {service.locationIds.length > 1 ? t("Booking locations") : t("Booking location")}:{" "}
                    {service.locationIds.length > 1
                      ? service.locationIds
                          .map((id) => locationById(locations, id))
                          .filter((location): location is Location => Boolean(location))
                          .map((location) => location.shortName || location.name)
                          .join(", ")
                      : bookingLocationShortDisplay(bookingLocationSnapshotFor(service, locations, coachAccount))}
                  </em>
                  {(service.lessonNote || service.location) && <em>{t("{serviceSingular} note:", { serviceSingular: terms.serviceSingular })}{" "}{service.lessonNote || service.location}</em>}
                  {service.lessonFormat === "package" && (
                    <em>
                      {service.packageAllowance ?? 5}{" "}{t("slots ·")}{" "}{service.packageCoverageMode === "lesson-by-lesson" ? "lesson-by-lesson" : "paid upfront"}
                    </em>
                  )}
                </button>
                <div className="service-row-meta">
                  <strong>{servicePriceLabel(service)}</strong>
                  <span>{t("{duration} min", { duration: service.duration })}</span>
                </div>
                <div className="service-row-actions">
                  {service.archived ? (
                    <>
                      <button
                        className="outline-button service-action-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          restoreService(service);
                        }}
                        type="button"
                      >
                        <RefreshCw size={15} />
                        <span>{t("Restore")}</span>
                      </button>
                      {canPermanentlyDeleteService(service) ? (
                        <button
                          className="danger-button service-action-button service-action-delete"
                          onClick={(event) => {
                            event.stopPropagation();
                            requestServiceAction(service, "delete");
                          }}
                          type="button"
                        >
                          <Trash2 size={15} />
                          <span>{t("Delete")}</span>
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <button
                        className="outline-button service-action-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          editService(service);
                        }}
                        type="button"
                      >
                        <Pencil size={15} />
                        <span>{t("Edit")}</span>
                      </button>
                      <button
                        className="outline-button service-action-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          requestServiceAction(service, "archive");
                        }}
                        type="button"
                      >
                        <Archive size={15} />
                        <span>{t("Archive")}</span>
                      </button>
                      {canPermanentlyDeleteService(service) ? (
                        <button
                          className="danger-button service-action-button service-action-delete"
                          onClick={(event) => {
                            event.stopPropagation();
                            requestServiceAction(service, "delete");
                          }}
                          type="button"
                        >
                          <Trash2 size={15} />
                          <span>{t("Delete")}</span>
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              </article>
            ))}
            {!listedLessonTypes.length && (
              <p className="service-list-empty">
                {serviceListTab === "active" ? t("No active lesson types yet.") : t("No archived lesson types yet.")}
              </p>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}
