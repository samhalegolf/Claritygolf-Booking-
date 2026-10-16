// Settings › Business › Locations. Drawn here; state and handlers arrive from App.tsx.
import { t, tn } from "../../lib/i18n";
import { Archive, Check, ChevronDown, ChevronUp, Plus, RefreshCw, X } from "lucide-react";
import { SettingsGroup } from "./SettingsLayout";
import { Suspense } from "react";
import { ClarityLocations } from "../shared/ClarityIcons";
import { Loading } from "../shared/Loading";
import { cleanResourceType } from "../../../netlify/functions/_shared/resources.mts";
import { TimeZoneSelect } from "./RegionSettings";
import type { ResourceHandedness, ResourceSource } from "../../../netlify/functions/_shared/resources.mts";
import type { Location } from "../workspace/workspaceModel";
import type { MarketCapabilities } from "../../../netlify/functions/_shared/market-profile.mts";
import type { LocationResource } from "../../../netlify/functions/_shared/resources.mts";
import type { CoachAccount } from "../workspace/workspaceModel";
import type { Dispatch, SetStateAction } from "react";

export type LocationsSettingsPanelProps = {
  locationEditor: Location;
  updateLocationEditor: <K extends keyof Location>(field: K, value: Location[K]) => void;
  locationSaveState: "idle" | "error" | "saving" | "saved";
  updateLocationResources: (edit: (resources: LocationResource[]) => LocationResource[]) => void;
  activeLocationList: Location[];
  moveLocationResource: (index: number, step: -1 | 1) => void;
  addLocationResources: (count: number) => void;
  locationEditorError: string;
  startNewLocation: () => void;
  showLocationEditor: boolean;
  editingLocationId: string | null;
  setShowLocationEditor: Dispatch<SetStateAction<boolean>>;
  coachAccount: CoachAccount;
  capabilities: MarketCapabilities;
  accountLocations: Location[];
  archivedLocationList: Location[];
  editLocation: (location: Location) => void;
  locationUsageCount: (locationId: string) => number;
  makeDefaultLocation: (location: Location) => void;
  restoreLocation: (location: Location) => void;
  archiveLocation: (location: Location) => void;
  saveEditedLocation: () => Promise<void>;
};

export function LocationsSettingsPanel(props: LocationsSettingsPanelProps) {
  const {
    locationEditor,
    updateLocationEditor,
    locationSaveState,
    updateLocationResources,
    activeLocationList,
    moveLocationResource,
    addLocationResources,
    locationEditorError,
    startNewLocation,
    showLocationEditor,
    editingLocationId,
    setShowLocationEditor,
    coachAccount,
    capabilities,
    accountLocations,
    archivedLocationList,
    editLocation,
    locationUsageCount,
    makeDefaultLocation,
    restoreLocation,
    archiveLocation,
    saveEditedLocation,
  } = props;
  return (
    <SettingsGroup id="locations" icon={ClarityLocations} section="business" title={t("Locations")}>
      <div className="data-card wide">
        <div className="data-card-header">
          <div>
            <h2>{tn(activeLocationList.length, "{count} active place", "{count} active places")}</h2>
          </div>
          <button className="primary-button" onClick={startNewLocation} type="button">
            <Plus size={16} />
            <span>{t("Add location")}</span>
          </button>
        </div>
        <p className="field-help">{t("Locations are real places customers can travel to. Lesson-specific inclusions like \"Bay hire included\" belong on the lesson type, not here.")}</p>

        {showLocationEditor && (
          <article className="service-editor-card">
            <div className="data-card-header compact">
              <div>
                <span>{editingLocationId ? t("Edit location") : t("New location")}</span>
                <h3>{locationEditor.name || t("Location details")}</h3>
              </div>
              <button
                className="icon-button"
                disabled={locationSaveState === "saving"}
                onClick={() => setShowLocationEditor(false)}
                type="button"
                aria-label={t("Close location editor")}
              >
                <X size={16} />
              </button>
            </div>
            <div className="service-form-grid">
              <label className="settings-field">
                <span>{t("Location name")}</span>
                <input value={locationEditor.name} onChange={(event) => updateLocationEditor("name", event.target.value)} />
              </label>
              <label className="settings-field">
                <span>{t("Short name")}</span>
                <input value={locationEditor.shortName} onChange={(event) => updateLocationEditor("shortName", event.target.value)} />
              </label>
              {locationEditor.kind !== "online" ? (
                <>
                  <label className="settings-field">
                    <span>{t("Address")}</span>
                    <input value={locationEditor.address} onChange={(event) => updateLocationEditor("address", event.target.value)} />
                  </label>
                  <label className="settings-field">
                    <span>{t("Map URL")}</span>
                    <input value={locationEditor.mapUrl ?? ""} onChange={(event) => updateLocationEditor("mapUrl", event.target.value)} />
                  </label>
                </>
              ) : null}
              <label className="settings-field">
                <span>{t("Time zone")}</span>
                <Suspense fallback={<Loading what={t("time zones")} size="inline" />}>
                  <TimeZoneSelect
                    country={coachAccount.country}
                    value={locationEditor.timezone}
                    onChange={(timezone) => updateLocationEditor("timezone", timezone)}
                  />
                </Suspense>
              </label>
              <label className="settings-field">
                <span>{t("Sort order")}</span>
                <input
                  value={locationEditor.sortOrder ?? 0}
                  inputMode="numeric"
                  onChange={(event) => updateLocationEditor("sortOrder", Number(event.target.value))}
                  type="text"
                />
              </label>
            </div>
            <div className="location-facility">
              <div className="location-facility-kind" role="radiogroup" aria-label={t("Kind of location")}>
                {(
                  [
                    ["physical", t("Physical place"), t("Customers come here. Can have bays or rooms.")],
                    ["online", t("Online"), t("Video calls and remote lessons. No address, no limit.")],
                  ] as const
                ).map(([kind, label, hint]) => (
                  <button
                    key={kind}
                    type="button"
                    role="radio"
                    aria-checked={(locationEditor.kind ?? "physical") === kind}
                    className={`location-kind-option ${(locationEditor.kind ?? "physical") === kind ? "is-selected" : ""}`}
                    onClick={() => updateLocationEditor("kind", kind)}
                  >
                    <strong>{label}</strong>
                    <small>{hint}</small>
                  </button>
                ))}
              </div>
              {/* A business with resources switched off is not offered them --
                  unless this place already has some, which the server still
                  enforces, so they stay editable (and removable) here. */}
              {locationEditor.kind !== "online" && (capabilities.resources || (locationEditor.resources?.length ?? 0) > 0) ? (
                <div className="location-resources">
                  <div className="location-resources-header">
                    <div>
                      <strong>{t("Resources")}</strong>
                      <small>{t("Hitting bays, rooms or nets. Give each a type so a lesson type can take every one of that type. A booking takes the first free one in this order, so put the ones you want filled first at the top. Leave empty if this place has no limit.")}</small>
                    </div>
                    <label className="settings-field location-resource-source">
                      <span>{t("Who keeps track of them")}</span>
                      <select
                        value={locationEditor.resourceSource ?? "clarity"}
                        onChange={(event) => updateLocationEditor("resourceSource", event.target.value as ResourceSource)}
                      >
                        <option value="clarity">{t("Clarity")}</option>
                        <option value="external">{t("Another booking system")}</option>
                      </select>
                    </label>
                  </div>
                  {locationEditor.resourceSource === "external" ? (
                    <p className="field-help">{t("Clarity won't limit bookings here. The other system decides which bay or room is free. Connect it under Settings › Booking › Bay & room system.")}</p>
                  ) : null}
                  {(locationEditor.resources ?? []).map((resource, index) => (
                    <div className="location-resource-row" key={index}>
                      <input
                        aria-label={t("Resource {value} name", { value: index + 1 })}
                        value={resource.name}
                        onChange={(event) =>
                          updateLocationResources((resources) =>
                            resources.map((entry, entryIndex) =>
                              entryIndex === index ? { ...entry, name: event.target.value } : entry,
                            ),
                          )
                        }
                      />
                      <input
                        aria-label={t("{name} type", { name: resource.name || t("Resource") })}
                        list="location-resource-types"
                        placeholder={t("Type, e.g. Hitting bay")}
                        value={resource.type ?? ""}
                        onChange={(event) =>
                          updateLocationResources((resources) =>
                            resources.map((entry, entryIndex) =>
                              entryIndex === index ? { ...entry, type: event.target.value } : entry,
                            ),
                          )
                        }
                      />
                      <select
                        aria-label={t("{name} set up for", { name: resource.name || t("Resource") })}
                        value={resource.handedness}
                        onChange={(event) =>
                          updateLocationResources((resources) =>
                            resources.map((entry, entryIndex) =>
                              entryIndex === index
                                ? { ...entry, handedness: event.target.value as ResourceHandedness }
                                : entry,
                            ),
                          )
                        }
                      >
                        <option value="any">{t("Left or right-handed")}</option>
                        <option value="right">{t("Right-handed only")}</option>
                        <option value="left">{t("Left-handed only")}</option>
                      </select>
                      <label className="settings-toggle">
                        <input
                          checked={resource.active !== false}
                          onChange={(event) =>
                            updateLocationResources((resources) =>
                              resources.map((entry, entryIndex) =>
                                entryIndex === index ? { ...entry, active: event.target.checked } : entry,
                              ),
                            )
                          }
                          type="checkbox"
                        />
                        <span>{t("In use")}</span>
                      </label>
                      <div className="location-resource-row-actions">
                        <button
                          className="icon-button small"
                          aria-label={t("Book {name} earlier", { name: resource.name || t("resource") })}
                          disabled={index === 0}
                          onClick={() => moveLocationResource(index, -1)}
                          type="button"
                        >
                          <ChevronUp size={15} />
                        </button>
                        <button
                          className="icon-button small"
                          aria-label={t("Book {name} later", { name: resource.name || t("resource") })}
                          disabled={index === (locationEditor.resources ?? []).length - 1}
                          onClick={() => moveLocationResource(index, 1)}
                          type="button"
                        >
                          <ChevronDown size={15} />
                        </button>
                        <button
                          className="icon-button small"
                          aria-label={t("Remove {name}", { name: resource.name || t("resource") })}
                          onClick={() =>
                            updateLocationResources((resources) => resources.filter((_, entryIndex) => entryIndex !== index))
                          }
                          type="button"
                        >
                          <X size={15} />
                        </button>
                      </div>
                    </div>
                  ))}
                  <datalist id="location-resource-types">
                    {[
                      ...new Map(
                        [...accountLocations.flatMap((location) => location.resources ?? []), ...(locationEditor.resources ?? [])]
                          .map((resource) => cleanResourceType(resource.type))
                          .filter(Boolean)
                          .map((type) => [type.toLowerCase(), type] as const),
                      ).values(),
                    ].map((type) => (
                      <option key={type} value={type} />
                    ))}
                  </datalist>
                  <div className="location-resource-actions">
                    <button className="outline-button compact-button" onClick={() => addLocationResources(1)} type="button">
                      <Plus size={15} />{t("Add resource")}</button>
                    {!(locationEditor.resources ?? []).length ? (
                      <button className="outline-button compact-button" onClick={() => addLocationResources(4)} type="button">
                        <Plus size={15} />{t("Add 4 bays")}</button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="service-form-row">
              <label className="settings-field">
                <span>{t("Arrival instructions")}</span>
                <textarea
                  value={locationEditor.arrivalInstructions ?? ""}
                  onChange={(event) => updateLocationEditor("arrivalInstructions", event.target.value)}
                  rows={3}
                />
              </label>
              <label className="settings-field">
                <span>{t("Public notes")}</span>
                <textarea
                  value={locationEditor.publicNotes ?? ""}
                  onChange={(event) => updateLocationEditor("publicNotes", event.target.value)}
                  rows={3}
                />
              </label>
            </div>
            <div className="service-form-row">
              <label className="settings-toggle">
                <input
                  checked={locationEditor.active !== false && locationEditor.archived !== true}
                  onChange={(event) => {
                    updateLocationEditor("active", event.target.checked);
                    updateLocationEditor("archived", !event.target.checked);
                  }}
                  type="checkbox"
                />
                <span>{t("Active")}</span>
              </label>
              <label className="settings-toggle">
                <input
                  checked={locationEditor.isDefault === true}
                  onChange={(event) => updateLocationEditor("isDefault", event.target.checked)}
                  type="checkbox"
                />
                <span>{t("Default location")}</span>
              </label>
            </div>
            {locationSaveState === "error" && locationEditorError && (
              <p className="workspace-save-error" role="alert">
                {locationEditorError}
              </p>
            )}
            <button className="primary-button settings-save" disabled={locationSaveState === "saving"} onClick={saveEditedLocation} type="button">
              {locationSaveState === "saving"
                ? t("Saving")
                : locationSaveState === "saved"
                  ? t("Saved")
                  : locationSaveState === "error"
                    ? t("Not saved")
                    : t("Save Location")}
            </button>
          </article>
        )}

        <div className="service-list" aria-label={t("Locations")}>
          {[...activeLocationList, ...archivedLocationList].map((location) => (
            <article className={`service-row ${location.active && !location.archived ? "" : "is-archived"}`} key={location.id}>
              <button className="service-row-main" onClick={() => editLocation(location)} type="button">
                <span>
                  {location.isDefault ? t("Default · ") : ""}{location.active && !location.archived ? t("Active") : t("Archived")}
                </span>
                <strong>{location.name}</strong>
                {location.kind === "online" ? <em>{t("Online")}</em> : location.address && <em>{location.address}</em>}
                {location.kind !== "online" && (location.resources ?? []).some((resource) => resource.active) ? (
                  <em>{tn((location.resources ?? []).filter((resource) => resource.active).length, "{count} resource", "{count} resources")}
                    {location.resourceSource === "external" ? t(" · kept by another system") : ""}
                  </em>
                ) : null}
                <em>{tn(locationUsageCount(location.id), "Used by {count} lesson type", "Used by {count} lesson types")}</em>
              </button>
              <div className="service-row-meta">
                <strong>{location.shortName}</strong>
                <span>{location.timezone}</span>
              </div>
              <div className="service-row-actions">
                {!location.isDefault && location.active && !location.archived ? (
                  <button className="outline-button service-action-button" onClick={() => makeDefaultLocation(location)} type="button">
                    <Check size={15} />
                    <span>{t("Default")}</span>
                  </button>
                ) : null}
                {location.archived || !location.active ? (
                  <button className="outline-button service-action-button" onClick={() => restoreLocation(location)} type="button">
                    <RefreshCw size={15} />
                    <span>{t("Restore")}</span>
                  </button>
                ) : (
                  <button className="outline-button service-action-button" onClick={() => archiveLocation(location)} type="button">
                    <Archive size={15} />
                    <span>{t("Archive")}</span>
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </div>
    </SettingsGroup>
  );
}
