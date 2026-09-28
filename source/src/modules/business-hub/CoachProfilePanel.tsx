// One coach, on one screen: their photo, bio and contact, the week ahead on
// their calendar, and the settings that belong to them rather than to the
// business.
//
// It is the same screen from both ends. The owner reaches it by clicking a
// coach in Settings › Business › Coaches and can change everything; the coach
// reaches it as their own Coach profile (the top of their Business Hub) and
// changes the parts that are theirs to say — photo, public name, phone, bio.
// There is no second coach editor anywhere else to drift from this one.

import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { ArrowLeft, Camera, Phone, Trash2 } from "lucide-react";
import { ClarityCalendar, ClarityEmail, ClarityLocations, ClaritySessions, ClaritySettings } from "../shared/ClarityIcons";

/** The coach fields this screen reads and writes. App's CoachProfile satisfies it. */
export type CoachProfileRecord = {
  id: string;
  name: string;
  displayName: string;
  shortName?: string;
  email: string;
  phone?: string;
  bio?: string;
  photoUrl?: string;
  active: boolean;
  archived?: boolean;
  assignedLocationIds?: string[];
  defaultLocationId?: string;
  sortOrder?: number;
};

export type CoachWeekEntry = {
  id: string;
  time: string;
  title: string;
  kind: "lesson" | "block";
  color?: string;
};

export type CoachWeekDay = {
  key: string;
  /** "Mon" */
  short: string;
  /** Day of the month. */
  date: number;
  isToday: boolean;
  entries: CoachWeekEntry[];
};

export type CoachProfilePanelProps<T extends CoachProfileRecord> = {
  coach: T;
  /** A coach being added: the form starts open and there is no week yet. */
  isNew?: boolean;
  /** "owner" edits every field; "self" is a coach editing their own card. */
  access: "owner" | "self";
  roleLabel: string;
  /** The business's word for a coach — "Coach", "Instructor", "Staff". */
  staffSingular: string;
  staffPlural: string;
  locations: Array<{ id: string; label: string }>;
  week: CoachWeekDay[];
  /** Resolves true when saved. Failures are reported by the caller. */
  onSave: (next: T) => Promise<boolean>;
  onBack?: () => void;
  onOpenCalendar?: () => void;
  onOpenAvailability?: () => void;
  /** More of this coach's settings, drawn under the profile — connections on the Business Hub. */
  children?: ReactNode;
};

/** Stored as a data URL alongside the coach, like the business logo. */
const PHOTO_SIZE = 320;
const PHOTO_MAX_LENGTH = 150_000;

/** A square, centre-cropped JPEG small enough to live in the coach record. */
export async function resizeCoachPhoto(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("unreadable"));
      element.src = objectUrl;
    });
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    if (!side) throw new Error("unreadable");
    const canvas = document.createElement("canvas");
    canvas.width = PHOTO_SIZE;
    canvas.height = PHOTO_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("unreadable");
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      PHOTO_SIZE,
      PHOTO_SIZE,
    );
    for (const quality of [0.86, 0.72, 0.58]) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      if (dataUrl.length <= PHOTO_MAX_LENGTH) return dataUrl;
    }
    throw new Error("too-large");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function initialsOf(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

export function CoachAvatar({ name, photoUrl, size = 96 }: { name: string; photoUrl?: string; size?: number }) {
  return (
    <span className="cp-avatar" style={{ width: size, height: size, fontSize: Math.round(size / 3) }} aria-hidden="true">
      {photoUrl ? <img src={photoUrl} alt="" /> : initialsOf(name)}
    </span>
  );
}

export function CoachProfilePanel<T extends CoachProfileRecord>({
  coach,
  isNew = false,
  access,
  roleLabel,
  staffSingular,
  staffPlural,
  locations,
  week,
  onSave,
  onBack,
  onOpenCalendar,
  onOpenAvailability,
  children,
}: CoachProfilePanelProps<T>) {
  const [editing, setEditing] = useState(isNew);
  const [draft, setDraft] = useState<T>(coach);
  const [saving, setSaving] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isOwner = access === "owner";
  const staffWord = staffSingular.toLowerCase();

  // Follow the saved record while nobody is typing, so a save (or a change
  // made from the other end) shows here without reopening the screen.
  useEffect(() => {
    if (!editing) setDraft(coach);
  }, [coach, editing]);

  useEffect(() => {
    setEditing(isNew);
    setPhotoError("");
  }, [coach.id, isNew]);

  function update<K extends keyof T>(field: K, value: T[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setPhotoError("Choose an image file.");
      return;
    }
    try {
      const photoUrl = await resizeCoachPhoto(file);
      setPhotoError("");
      update("photoUrl", photoUrl as T["photoUrl"]);
    } catch {
      setPhotoError("Could not read that photo. Try a JPG or PNG.");
    }
  }

  async function save() {
    setSaving(true);
    try {
      if (await onSave(draft)) setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    if (isNew && onBack) {
      onBack();
      return;
    }
    setDraft(coach);
    setPhotoError("");
    setEditing(false);
  }

  const shown = editing ? draft : coach;
  const name = shown.displayName || shown.name;
  const assigned = new Set(shown.assignedLocationIds ?? []);
  const assignedLabels = locations.filter((location) => assigned.has(location.id)).map((location) => location.label);
  const weekCount = week.reduce((total, day) => total + day.entries.filter((entry) => entry.kind === "lesson").length, 0);

  return (
    <div className="coach-profile">
      {onBack && (
        <button className="text-button cp-back" onClick={onBack} type="button">
          <ArrowLeft size={16} />
          All {staffPlural.toLowerCase()}
        </button>
      )}

      <article className="cp-card cp-identity">
        <div className="cp-photo">
          <CoachAvatar name={name} photoUrl={shown.photoUrl} />
          {editing && (
            <div className="cp-photo-actions">
              <input ref={fileInputRef} accept="image/*" hidden onChange={choosePhoto} type="file" />
              <button className="outline-button" onClick={() => fileInputRef.current?.click()} type="button">
                <Camera size={15} />
                {shown.photoUrl ? "Change" : "Add photo"}
              </button>
              {shown.photoUrl && (
                <button
                  className="icon-button"
                  onClick={() => update("photoUrl", "" as T["photoUrl"])}
                  title="Remove photo"
                  aria-label="Remove photo"
                  type="button"
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          )}
          {photoError && <p className="cp-photo-error">{photoError}</p>}
        </div>

        {!editing ? (
          <div className="cp-identity-main">
            <div className="cp-name">
              <strong>{name || `New ${staffWord}`}</strong>
              <span className="cp-role">{roleLabel}</span>
              {shown.archived || !shown.active ? <span className="cp-role is-muted">Archived</span> : null}
            </div>
            <p className={`cp-bio${shown.bio ? "" : " is-empty"}`}>
              {shown.bio || (access === "self" ? "Add a short bio — it is what players read before they book you." : "No bio yet.")}
            </p>
            <div className="cp-facts">
              <div>
                <span>
                  <ClarityEmail size={14} />
                  Email
                </span>
                <strong>{shown.email || "Not set"}</strong>
              </div>
              <div>
                <span>
                  <Phone size={14} />
                  Phone
                </span>
                <strong>{shown.phone || "Not set"}</strong>
              </div>
              <div>
                <span>
                  <ClarityLocations size={14} />
                  Locations
                </span>
                <strong>{assignedLabels.length ? assignedLabels.join(", ") : "None assigned"}</strong>
              </div>
            </div>
          </div>
        ) : (
          <div className="cp-identity-main cp-form">
            <div className="cp-form-grid">
              {isOwner && (
                <label className="settings-field">
                  <span>Name</span>
                  <input value={draft.name} maxLength={120} onChange={(event) => update("name", event.target.value)} />
                </label>
              )}
              <label className="settings-field">
                <span>Public name</span>
                <input
                  value={draft.displayName}
                  maxLength={120}
                  placeholder={draft.name}
                  onChange={(event) => update("displayName", event.target.value)}
                />
              </label>
              {isOwner && (
                <label className="settings-field">
                  <span>Short name</span>
                  <input
                    value={draft.shortName ?? ""}
                    maxLength={60}
                    onChange={(event) => update("shortName", event.target.value as T["shortName"])}
                  />
                </label>
              )}
              {isOwner && (
                <label className="settings-field">
                  <span>Sort order</span>
                  <input
                    value={draft.sortOrder ?? 0}
                    inputMode="numeric"
                    onChange={(event) => update("sortOrder", (Number(event.target.value) || 0) as T["sortOrder"])}
                    type="text"
                  />
                </label>
              )}
              {isOwner && (
                <label className="settings-field">
                  <span>Email</span>
                  <input
                    value={draft.email}
                    type="email"
                    maxLength={180}
                    onChange={(event) => update("email", event.target.value)}
                  />
                </label>
              )}
              <label className="settings-field">
                <span>Phone</span>
                <input
                  value={draft.phone ?? ""}
                  type="tel"
                  maxLength={80}
                  onChange={(event) => update("phone", event.target.value as T["phone"])}
                />
              </label>
            </div>
            <label className="settings-field">
              <span>Bio</span>
              <textarea
                value={draft.bio ?? ""}
                maxLength={600}
                rows={4}
                placeholder="A few lines about how you coach."
                onChange={(event) => update("bio", event.target.value as T["bio"])}
              />
            </label>

            {isOwner && locations.length > 0 && (
              <div className="cp-form-grid">
                <div className="settings-field">
                  <span>Assigned locations</span>
                  <div className="booking-screen-list">
                    {locations.map((location) => (
                      <label key={location.id}>
                        <input
                          checked={assigned.has(location.id)}
                          onChange={(event) => {
                            const current = draft.assignedLocationIds ?? [];
                            update(
                              "assignedLocationIds",
                              (event.target.checked
                                ? Array.from(new Set([...current, location.id]))
                                : current.filter((id) => id !== location.id)) as T["assignedLocationIds"],
                            );
                          }}
                          type="checkbox"
                        />
                        <span>{location.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <label className="settings-field">
                  <span>Default location</span>
                  <select
                    value={draft.defaultLocationId || locations[0]?.id || ""}
                    onChange={(event) => update("defaultLocationId", event.target.value as T["defaultLocationId"])}
                  >
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {isOwner && !isNew && (
              <label className="settings-toggle">
                <input
                  checked={draft.active !== false && draft.archived !== true}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, active: event.target.checked, archived: !event.target.checked }))
                  }
                  type="checkbox"
                />
                <span>Active — bookable and shown on the calendar</span>
              </label>
            )}

            <div className="cp-form-actions">
              <button className="outline-button" disabled={saving} onClick={cancel} type="button">
                Cancel
              </button>
              <button className="primary-button" disabled={saving} onClick={() => void save()} type="button">
                {saving ? "Saving" : isNew ? `Add ${staffWord}` : "Save"}
              </button>
            </div>
          </div>
        )}

        {!editing && (
          <button className="bh-gear cp-edit" onClick={() => setEditing(true)} title="Edit profile" type="button">
            <ClaritySettings size={16} />
          </button>
        )}
      </article>

      {!isNew && (
        <article className="cp-card cp-week">
          <header className="cp-card-head">
            <h3>
              <ClarityCalendar size={14} />
              Next 7 days
            </h3>
            <span className="cp-week-count">
              {weekCount} lesson{weekCount === 1 ? "" : "s"}
            </span>
            {onOpenCalendar && (
              <button className="text-button" onClick={onOpenCalendar} type="button">
                Open calendar
              </button>
            )}
          </header>
          <div className="cp-week-grid">
            {week.map((day) => (
              <div className={`cp-week-day${day.isToday ? " is-today" : ""}`} key={day.key}>
                <div className="cp-week-date">
                  <span>{day.short}</span>
                  <strong>{day.date}</strong>
                </div>
                {day.entries.length ? (
                  <ul>
                    {day.entries.map((entry) => (
                      <li
                        className={`cp-week-entry is-${entry.kind}`}
                        key={entry.id}
                        style={entry.color ? { borderLeftColor: entry.color } : undefined}
                        title={`${entry.time} · ${entry.title}`}
                      >
                        <span>{entry.time}</span>
                        <strong>{entry.title}</strong>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="cp-week-free">Free</p>
                )}
              </div>
            ))}
          </div>
        </article>
      )}

      {!isNew && onOpenAvailability && (
        <article className="cp-card">
          <header className="cp-card-head">
            <h3>
              <ClaritySettings size={14} />
              {staffSingular} settings
            </h3>
          </header>
          <button className="cp-setting-row" onClick={onOpenAvailability} type="button">
            <ClaritySessions size={18} />
            <span>
              <strong>Availability</strong>
              <em>Weekly hours {access === "self" ? "you" : "this " + staffWord} can be booked</em>
            </span>
            <ClaritySettings size={16} />
          </button>
        </article>
      )}

      {children}
    </div>
  );
}
