// Settings > Notifications > Message templates. The coach writes what a client
// reads, on a preview of the message itself rather than in a column of labelled
// boxes — so the length of a subject line and the tone of a sign-off are judged
// where they will actually be seen.
//
// Presentational: it renders the templates it is given and reports edits back
// through onChange. It owns no fetching and no settings state - App.tsx does -
// matching the other panel components.
//
// The defaults and the variant list come from the same shared module the send
// path reads (netlify/functions/_shared/notification-templates.mts), so the
// wording previewed here is the wording that goes out.

import { useState } from "react";
import { Check, Mail, MessageSquare, Pencil, RotateCcw, Smartphone, X } from "lucide-react";
import {
  emptyNotificationTemplate,
  isNotificationTemplateEdited,
  NOTIFICATION_VARIANTS,
  notificationTemplateText,
  smsSegmentLabel,
} from "../../../netlify/functions/_shared/notification-templates.mts";
import type {
  NotificationTemplateField,
  NotificationTemplates,
  NotificationVariantId,
} from "../../../netlify/functions/_shared/notification-templates.mts";

// The rows Clarity fills in per lesson. Not editable and deliberately shown:
// they are most of what a client actually reads, and a coach writing the body
// needs to see what the message already says without them.
const PREVIEW_ROWS: Record<NotificationVariantId, Array<[string, string]>> = {
  booked: [
    ["Lesson", "45 min private lesson"],
    ["When", "Tue 8 Sep, 9:00am"],
  ],
  reschedule: [
    ["Lesson", "45 min private lesson"],
    ["Previous", "Tue 8 Sep, 9:00am"],
    ["When", "Thu 10 Sep, 2:30pm"],
  ],
  reminder: [
    ["Lesson", "45 min private lesson"],
    ["When", "Tomorrow, 9:00am"],
  ],
  cancelled: [
    ["Lesson", "45 min private lesson"],
    ["Previous", "Tue 8 Sep, 9:00am"],
  ],
  group: [
    ["Lesson", "Short game clinic"],
    ["When", "Sat 12 Sep, 8:00am"],
  ],
  package: [
    ["Lesson", "Six lesson block"],
    ["When", "Book as you go"],
  ],
};

export type MessageTemplatesPanelProps = {
  templates: NotificationTemplates;
  mapLinkLabel: string;
  /** Read-only until the settings block is put into edit mode. */
  locked: boolean;
  businessName: string;
  logoUrl: string;
  /** The venue name shown on the "Where" row of the preview. */
  venueName: string;
  /** Renders {{merge}} fields against the example booking, for the preview only. */
  renderPreview: (template: string) => string;
  onChange: (templates: NotificationTemplates) => void;
  onMapLinkLabelChange: (label: string) => void;
};

export function MessageTemplatesPanel({
  templates,
  mapLinkLabel,
  locked,
  businessName,
  logoUrl,
  venueName,
  renderPreview,
  onChange,
  onMapLinkLabelChange,
}: MessageTemplatesPanelProps) {
  const [variant, setVariant] = useState<NotificationVariantId>("booked");
  const [channel, setChannel] = useState<"email" | "text">("email");
  const [narrow, setNarrow] = useState(false);
  // Which field is open, and the uncommitted text in it. One at a time: the
  // preview has to stay readable as a message while one line of it is edited.
  const [editing, setEditing] = useState<NotificationTemplateField | "mapLink" | "">("");
  const [draft, setDraft] = useState("");

  const active = NOTIFICATION_VARIANTS.find((entry) => entry.id === variant) ?? NOTIFICATION_VARIANTS[0];
  const isText = channel === "text";
  const phoneFrame = isText || narrow;

  /** The effective wording: what the coach wrote, or Clarity's default. */
  function text(field: NotificationTemplateField) {
    return notificationTemplateText(templates, variant, field);
  }

  function beginEdit(field: NotificationTemplateField | "mapLink") {
    if (locked) return;
    setEditing(field);
    setDraft(field === "mapLink" ? mapLinkLabel : text(field));
  }

  function cancelEdit() {
    setEditing("");
    setDraft("");
  }

  function commit() {
    if (!editing) return;
    if (editing === "mapLink") {
      onMapLinkLabelChange(draft);
    } else {
      onChange({
        ...templates,
        [variant]: { ...(templates[variant] ?? emptyNotificationTemplate()), [editing]: draft },
      });
    }
    cancelEdit();
  }

  /** Clears this variant back to blank, which is how "use Clarity's wording" is stored. */
  function resetVariant() {
    onChange({ ...templates, [variant]: emptyNotificationTemplate() });
    cancelEdit();
  }

  // One editable line of the message. Resting it is a dashed button that reads
  // as the text it holds; open it is an input with commit/cancel beside it.
  function field(
    name: NotificationTemplateField | "mapLink",
    options: { className: string; multiline?: boolean; rows?: number; label: string; value: string },
  ) {
    const open = editing === name;
    if (open) {
      return (
        <span className={`mt-editing ${options.className}`}>
          {options.multiline ? (
            <textarea
              value={draft}
              rows={options.rows ?? 4}
              onChange={(event) => setDraft(event.target.value)}
              aria-label={options.label}
              autoFocus
            />
          ) : (
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label={options.label}
              autoFocus
            />
          )}
          <button className="mt-commit" onClick={commit} type="button" aria-label={`Save ${options.label}`}>
            <Check size={15} />
          </button>
          <button className="mt-cancel" onClick={cancelEdit} type="button" aria-label={`Cancel ${options.label}`}>
            <X size={15} />
          </button>
        </span>
      );
    }
    return (
      <button
        className={`mt-slot ${options.className}`}
        onClick={() => beginEdit(name)}
        disabled={locked}
        title={locked ? undefined : `Edit the ${options.label.toLowerCase()}`}
        type="button"
      >
        <span className="mt-slot-value">{options.value}</span>
        {!locked && (
          <span className="mt-slot-pencil">
            <Pencil size={14} />
          </span>
        )}
      </button>
    );
  }

  const smsBody = text("smsText");
  const ctaLabel = text("cta");

  return (
    <div className="message-templates">
      <div className="mt-toolbar">
        <div className="mt-channel" role="group" aria-label="Message channel">
          <button
            className={isText ? "" : "is-active"}
            onClick={() => {
              setChannel("email");
              cancelEdit();
            }}
            aria-pressed={!isText}
            type="button"
          >
            <Mail size={15} />
            Email
          </button>
          <button
            className={isText ? "is-active" : ""}
            onClick={() => {
              setChannel("text");
              cancelEdit();
            }}
            aria-pressed={isText}
            type="button"
          >
            <MessageSquare size={15} />
            Text
          </button>
        </div>
        {!isText && (
          <button
            className={`mt-width${narrow ? " is-active" : ""}`}
            onClick={() => setNarrow((current) => !current)}
            aria-pressed={narrow}
            title="Preview at phone width"
            type="button"
          >
            <Smartphone size={16} />
          </button>
        )}
        <span className="mt-dashed-key">
          <span className="mt-dashed-swatch" />
          Dashed is yours to write
        </span>
        {/* Rule 10: reverting wording is text, not a filled button sitting
            beside the thing it would undo. */}
        <button
          className="text-button"
          onClick={resetVariant}
          disabled={locked || !isNotificationTemplateEdited(templates, variant)}
          type="button"
        >
          <RotateCcw size={14} />
          Reset {active.label.toLowerCase()}
        </button>
      </div>

      <div className="mt-tabs" role="tablist" aria-label="What happened">
        {NOTIFICATION_VARIANTS.map((entry) => (
          <button
            key={entry.id}
            className={entry.id === variant ? "is-active" : ""}
            onClick={() => {
              setVariant(entry.id);
              cancelEdit();
            }}
            role="tab"
            aria-selected={entry.id === variant}
            type="button"
          >
            {entry.label}
            {isNotificationTemplateEdited(templates, entry.id) && <em className="mt-tab-dot" aria-label="Edited" />}
          </button>
        ))}
      </div>

      <div className="mt-stage">
        <p className="mt-when">{active.when}</p>

        <div className={`mt-mat${phoneFrame ? " is-phone" : ""}`}>
          <div className={`mt-sheet${narrow && !isText ? " is-narrow" : ""}`}>
            {isText ? (
              <>
                <div className="mt-sms-head">
                  <span className="mt-sms-avatar">
                    {logoUrl ? <img src={logoUrl} alt="" /> : <MessageSquare size={16} />}
                  </span>
                  <div>
                    <strong>{businessName || "Your business name"}</strong>
                    <em>Text message</em>
                  </div>
                </div>
                <div className="mt-sms-body">
                  {field("smsText", {
                    className: "mt-sms-bubble",
                    multiline: true,
                    rows: 5,
                    label: "Text message",
                    value: renderPreview(smsBody),
                  })}
                  <span className="mt-sms-count">{smsSegmentLabel(smsBody)}</span>
                </div>
              </>
            ) : (
              <>
                <div className="mt-email-head">
                  {logoUrl && (
                    <span className="mt-logo">
                      <img src={logoUrl} alt={`${businessName} logo`} />
                    </span>
                  )}
                  <div>
                    <strong>{businessName || "Your business name"}</strong>
                    <em>{businessName ? "Logo and name, from Settings › Business" : "Set your business name in Settings › Business"}</em>
                  </div>
                </div>

                <div className="mt-subject">
                  <span className="mt-label">Subject</span>
                  {field("subject", { className: "mt-subject-slot", label: "Subject line", value: renderPreview(text("subject")) })}
                </div>

                <div className="mt-email-body">
                  {field("heading", { className: "mt-heading", label: "Headline", value: renderPreview(text("heading")) })}
                  {field("body", {
                    className: "mt-body",
                    multiline: true,
                    rows: 4,
                    label: "Message",
                    value: renderPreview(text("body")),
                  })}

                  <div className="mt-rows">
                    <div className="mt-rows-head">The booking · filled in by Clarity</div>
                    {PREVIEW_ROWS[variant].map(([key, value]) => (
                      <div className="mt-row" key={key}>
                        <span>{key}</span>
                        <span>{value}</span>
                      </div>
                    ))}
                    <div className="mt-row mt-row-where">
                      <span>Where</span>
                      <span className="mt-where-value">
                        <em>{venueName || "Your venue"}</em>
                        {field("mapLink", { className: "mt-maplink", label: "Map link name", value: mapLinkLabel })}
                      </span>
                    </div>
                  </div>

                  <div className="mt-actions">
                    {field("cta", {
                      className: "mt-cta",
                      label: "Button",
                      value: ctaLabel || "No button on this message",
                    })}
                    <span className="mt-cta-note">Links to the manage / reschedule page. Clear it to drop the button.</span>
                  </div>

                  {field("signoff", { className: "mt-signoff", label: "Sign-off", value: renderPreview(text("signoff")) })}

                  <p className="mt-footer">
                    Sent by Clarity on your behalf. Your business name, venue and reply-to address are added here.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>

        <p className="mt-note">
          {isText
            ? "Links and merge fields are filled in per lesson. What you write is saved against " + active.label + " only."
            : "The booking table, the button's link and the footer are filled in per lesson and cannot be edited here. What you write is saved against " +
              active.label +
              " only."}
        </p>
      </div>
    </div>
  );
}
