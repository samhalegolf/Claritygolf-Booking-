// The wording of every client-facing booking message, per thing that happened.
//
// Before this there was one client email template (clientEmailSubject /
// clientEmailIntro / clientEmailFooter) shared by every action, and the words a
// client actually read for a cancellation or a reminder were hardcoded in
// notification-engine.mts. A coach could not change them.
//
// One template per variant now, each with the parts a coach writes: subject,
// heading, body, the primary button's label, the sign-off, and the text message.
// Everything else on the message — the booking table, the links, the footer — is
// filled in per lesson and is not the coach's to edit.
//
// Isomorphic: imported by both the settings editor (src/App.tsx) and the send
// path (notification-engine.mts), so the preview a coach approves and the email
// a client receives come from the same defaults. It must not touch `process` or
// any Node API.

export type NotificationVariantId =
  | "booked"
  | "reschedule"
  | "reminder"
  | "cancelled"
  | "group"
  | "package";

export type NotificationTemplateField =
  | "subject"
  | "heading"
  | "body"
  | "cta"
  | "signoff"
  | "smsText";

export type NotificationTemplate = Record<NotificationTemplateField, string>;

export type NotificationTemplates = Record<NotificationVariantId, NotificationTemplate>;

// The order the tabs appear in, and the one-line explanation of when each one
// goes out. The "when" text is the only place that promise is written down, so
// the editor and any future docs read the same sentence.
export const NOTIFICATION_VARIANTS: Array<{
  id: NotificationVariantId;
  label: string;
  when: string;
}> = [
  { id: "booked", label: "New booking", when: "Sent the moment a lesson is booked" },
  { id: "reschedule", label: "Rescheduled", when: "Sent when a lesson moves" },
  { id: "reminder", label: "Reminder", when: "Sent before the lesson, at your reminder lead time" },
  { id: "cancelled", label: "Cancelled", when: "Sent immediately on cancellation" },
  { id: "group", label: "Group session", when: "Sent instead of New booking when the lesson type is a group" },
  { id: "package", label: "Package", when: "Sent instead of New booking when the lesson type is a package" },
];

export const NOTIFICATION_TEMPLATE_FIELDS: NotificationTemplateField[] = [
  "subject",
  "heading",
  "body",
  "cta",
  "signoff",
  "smsText",
];

// Per-field caps. Generous enough that nobody hits them writing normally, tight
// enough that a paste accident cannot put a novel in a subject line.
const FIELD_LIMITS: Record<NotificationTemplateField, number> = {
  subject: 180,
  heading: 120,
  body: 1200,
  cta: 40,
  signoff: 160,
  smsText: 480,
};

// What the map link beside the venue is called. One label for every variant:
// it names the same link wherever it appears, so it is not per-template.
export const DEFAULT_MAP_LINK_LABEL = "Take me there";

/**
 * Clarity's own wording, used wherever the coach has not written their own.
 *
 * The merge fields are the ones variablesFor() in notification-engine.mts
 * actually supplies. Writing a field that isn't there renders as empty, so this
 * list is the contract: client, firstName, coach, coachFirstName, business,
 * service, date, time, previousDate, previousTime, venue, location,
 * locationAddress, mapUrl, phone, email, rescheduleUrl, bookingUrl,
 * googleCalendarUrl, appleCalendarUrl, packageAllowance.
 *
 * `cta` names the primary button, which links to the manage/reschedule page.
 * The label is the coach's; where that link goes is not, so the default says
 * what the button actually does. Cancellation emails carry no button, so its
 * cta is blank.
 */
export const DEFAULT_NOTIFICATION_TEMPLATES: NotificationTemplates = {
  booked: {
    subject: "Your {{service}} is booked — {{date}}",
    heading: "You're booked in",
    body:
      "Thanks {{firstName}}, your lesson is confirmed. Arrive five minutes early and bring your own clubs if you have them — there are range clubs if you don't.",
    cta: "Manage / Reschedule",
    signoff: "See you on the range, {{coachFirstName}}",
    smsText: "{{business}}: you're booked for {{service}} on {{date}} at {{time}}, {{location}}. Map: {{mapUrl}}",
  },
  reschedule: {
    subject: "Your {{service}} has moved to {{date}}",
    heading: "New time confirmed",
    body: "Your lesson has been moved. The details below are the new ones — nothing else has changed.",
    cta: "Manage / Reschedule",
    signoff: "See you then, {{coachFirstName}}",
    smsText: "{{business}}: your lesson has moved to {{date}} at {{time}}. Details: {{rescheduleUrl}}",
  },
  reminder: {
    subject: "Coming up: your {{service}} at {{time}}",
    heading: "Your lesson is coming up",
    body:
      "A quick reminder. If anything has come up, let me know as early as you can and I'll find you another slot.",
    cta: "Manage / Reschedule",
    signoff: "See you soon, {{coachFirstName}}",
    smsText: "Reminder: your lesson is at {{time}} on {{date}}, {{location}}. Map: {{mapUrl}}",
  },
  cancelled: {
    subject: "Your {{service}} on {{date}} is cancelled",
    heading: "That lesson is cancelled",
    body:
      "This lesson has been cancelled and nothing has been charged. Book again whenever suits — reply to this email and I'll find you a time.",
    cta: "",
    signoff: "Hope to see you soon, {{coachFirstName}}",
    smsText: "{{business}}: your lesson on {{date}} is cancelled and nothing has been charged.",
  },
  group: {
    subject: "You're in: {{service}} on {{date}}",
    heading: "You're in the group",
    body:
      "You're booked into this group session. Numbers are capped, so tell me early if you can't make it and I'll offer the place on.",
    cta: "Manage / Reschedule",
    signoff: "See you there, {{coachFirstName}}",
    smsText: "You're in: {{service}} on {{date}} at {{time}}, {{location}}. Map: {{mapUrl}}",
  },
  package: {
    subject: "Your package is ready: {{service}}",
    heading: "Your package is ready",
    body: "Your package is set up. Book each lesson as you go, and the balance updates as you use it.",
    cta: "Manage / Reschedule",
    signoff: "Let's get to work, {{coachFirstName}}",
    smsText: "{{business}}: your package is ready — book your lessons any time. {{bookingUrl}}",
  },
};

/**
 * An untouched template: every field blank, meaning "use Clarity's wording".
 * Blank is the resting state rather than a copy of the defaults, so improving a
 * default reaches every coach who never overrode it — and so the editor's Reset
 * has something to reset *to*.
 */
export function emptyNotificationTemplate(): NotificationTemplate {
  return { subject: "", heading: "", body: "", cta: "", signoff: "", smsText: "" };
}

export function emptyNotificationTemplates(): NotificationTemplates {
  return {
    booked: emptyNotificationTemplate(),
    reschedule: emptyNotificationTemplate(),
    reminder: emptyNotificationTemplate(),
    cancelled: emptyNotificationTemplate(),
    group: emptyNotificationTemplate(),
    package: emptyNotificationTemplate(),
  };
}

/**
 * Normalises whatever came out of storage (or off the wire) into a complete set
 * of six templates. Unknown variants and unknown fields are dropped; missing
 * ones become blank, so a template saved before a field existed still loads.
 *
 * Values are not trimmed. A body is prose - trailing spaces and blank lines are
 * the coach's, and trimming here would also fight the settings editor, which
 * feeds this straight back into a controlled input.
 */
export function cleanNotificationTemplates(raw?: unknown): NotificationTemplates {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const templates = emptyNotificationTemplates();
  for (const variant of NOTIFICATION_VARIANTS) {
    const entry = source[variant.id];
    if (!entry || typeof entry !== "object") continue;
    const fields = entry as Record<string, unknown>;
    for (const field of NOTIFICATION_TEMPLATE_FIELDS) {
      const value = fields[field];
      if (typeof value === "string") templates[variant.id][field] = value.slice(0, FIELD_LIMITS[field]);
    }
  }
  return templates;
}

/** Parses the JSON blob the settings table holds. A corrupt value reads as untouched. */
export function parseNotificationTemplates(raw?: unknown): NotificationTemplates {
  if (typeof raw !== "string" || !raw.trim()) return emptyNotificationTemplates();
  try {
    return cleanNotificationTemplates(JSON.parse(raw));
  } catch {
    return emptyNotificationTemplates();
  }
}

/**
 * One field's effective wording: what the coach wrote, or Clarity's default.
 *
 * A field the coach has deliberately emptied still falls back to the default -
 * there is no way to send a message with no subject, and "blank" is how Reset
 * is stored. The one field allowed to resolve empty is a default that is itself
 * empty (cancelled's button, which does not exist).
 */
export function notificationTemplateText(
  templates: NotificationTemplates | undefined,
  variant: NotificationVariantId,
  field: NotificationTemplateField,
): string {
  const written = templates?.[variant]?.[field];
  if (typeof written === "string" && written.trim()) return written;
  return DEFAULT_NOTIFICATION_TEMPLATES[variant][field];
}

/** True when this variant's field is the coach's wording rather than Clarity's. */
export function isNotificationTemplateEdited(
  templates: NotificationTemplates | undefined,
  variant: NotificationVariantId,
): boolean {
  const entry = templates?.[variant];
  if (!entry) return false;
  return NOTIFICATION_TEMPLATE_FIELDS.some((field) => typeof entry[field] === "string" && entry[field].trim() !== "");
}

/**
 * Which template a message uses. The four booking actions map straight across;
 * a new booking splits three ways on what was booked, because "you're in the
 * group" and "your package is ready" are not the same message as a private
 * lesson confirmation.
 *
 * "updated" and "test" have no wording of their own and read as a new booking -
 * an update is a confirmation of the current details, and a test should show
 * the coach the email they send most.
 */
export function notificationVariantFor(
  action: string,
  lessonFormat?: string,
): NotificationVariantId {
  if (action === "rescheduled") return "reschedule";
  if (action === "cancelled") return "cancelled";
  if (action === "reminder") return "reminder";
  if (lessonFormat === "group") return "group";
  if (lessonFormat === "package") return "package";
  return "booked";
}

/**
 * How a text message counts against a carrier's 160-character segment. Shown
 * while editing, because the length is part of writing one - a stray sentence
 * quietly doubles what the send costs.
 */
export function smsSegmentLabel(text: string): string {
  const length = text.length;
  const segments = Math.max(1, Math.ceil(length / 160));
  return `${length} characters · ${segments} ${segments === 1 ? "segment" : "segments"}`;
}
