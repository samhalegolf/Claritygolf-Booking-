import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanNotificationTemplates,
  DEFAULT_NOTIFICATION_TEMPLATES,
  emptyNotificationTemplates,
  isNotificationTemplateEdited,
  NOTIFICATION_VARIANTS,
  notificationTemplateText,
  notificationVariantFor,
  parseNotificationTemplates,
  smsSegmentLabel,
} from "./notification-templates.mts";

test("a new booking splits on what was booked", () => {
  assert.equal(notificationVariantFor("booking", "private"), "booked");
  assert.equal(notificationVariantFor("booking", "group"), "group");
  assert.equal(notificationVariantFor("booking", "package"), "package");
  // A lesson type with no format set is a private lesson as far as wording goes.
  assert.equal(notificationVariantFor("booking", undefined), "booked");
});

test("the other actions map straight across, whatever was booked", () => {
  // A rescheduled group session is still a reschedule email: what changed is
  // the time, and "you're in the group" would be the wrong thing to say.
  for (const format of ["private", "group", "package", undefined]) {
    assert.equal(notificationVariantFor("rescheduled", format), "reschedule");
    assert.equal(notificationVariantFor("cancelled", format), "cancelled");
    assert.equal(notificationVariantFor("reminder", format), "reminder");
  }
});

test("updated and test read as a new booking", () => {
  assert.equal(notificationVariantFor("updated", "private"), "booked");
  assert.equal(notificationVariantFor("test", "private"), "booked");
});

test("every variant ships a complete default", () => {
  for (const variant of NOTIFICATION_VARIANTS) {
    const template = DEFAULT_NOTIFICATION_TEMPLATES[variant.id];
    assert.ok(template, `${variant.id} has no default`);
    for (const field of ["subject", "heading", "body", "signoff", "smsText"] as const) {
      assert.ok(template[field].trim(), `${variant.id}.${field} is empty`);
    }
  }
});

test("a cancellation carries no button", () => {
  // There is nothing to manage or reschedule once the lesson is gone, so the
  // default label is blank and the engine drops the button entirely.
  assert.equal(DEFAULT_NOTIFICATION_TEMPLATES.cancelled.cta, "");
});

test("blank falls back to Clarity's wording", () => {
  const templates = emptyNotificationTemplates();
  assert.equal(notificationTemplateText(templates, "booked", "subject"), DEFAULT_NOTIFICATION_TEMPLATES.booked.subject);
  // Whitespace is not wording. A field cleared to spaces still sends something.
  templates.booked.subject = "   ";
  assert.equal(notificationTemplateText(templates, "booked", "subject"), DEFAULT_NOTIFICATION_TEMPLATES.booked.subject);
});

test("what the coach wrote wins", () => {
  const templates = emptyNotificationTemplates();
  templates.reminder.body = "Bring the new driver.";
  assert.equal(notificationTemplateText(templates, "reminder", "body"), "Bring the new driver.");
  // ...and only for the variant it was written against.
  assert.equal(notificationTemplateText(templates, "booked", "body"), DEFAULT_NOTIFICATION_TEMPLATES.booked.body);
});

test("undefined templates resolve rather than throw", () => {
  // A workspace that has never opened the editor has no stored blob at all.
  assert.equal(notificationTemplateText(undefined, "group", "heading"), DEFAULT_NOTIFICATION_TEMPLATES.group.heading);
});

test("an edited variant is reported as edited", () => {
  const templates = emptyNotificationTemplates();
  assert.equal(isNotificationTemplateEdited(templates, "booked"), false);
  templates.booked.cta = "   ";
  assert.equal(isNotificationTemplateEdited(templates, "booked"), false, "whitespace is not an edit");
  templates.booked.cta = "See the details";
  assert.equal(isNotificationTemplateEdited(templates, "booked"), true);
  assert.equal(isNotificationTemplateEdited(templates, "reminder"), false);
});

test("normalising fills in what storage is missing", () => {
  const cleaned = cleanNotificationTemplates({ booked: { subject: "Hi" }, nonsense: { subject: "no" } });
  assert.equal(cleaned.booked.subject, "Hi");
  assert.equal(cleaned.booked.body, "", "a field the blob never had becomes blank, not undefined");
  assert.ok(cleaned.package, "every variant is present after normalising");
  assert.equal((cleaned as Record<string, unknown>).nonsense, undefined);
});

test("normalising keeps the whitespace a coach typed", () => {
  // This runs against the settings draft, so trimming here would eat the space
  // in "See you there, " as it was being typed.
  const cleaned = cleanNotificationTemplates({ booked: { signoff: "See you there, " } });
  assert.equal(cleaned.booked.signoff, "See you there, ");
});

test("a field longer than its cap is cut, not dropped", () => {
  const cleaned = cleanNotificationTemplates({ booked: { subject: "x".repeat(500) } });
  assert.equal(cleaned.booked.subject.length, 180);
});

test("a corrupt stored blob reads as untouched", () => {
  assert.deepEqual(parseNotificationTemplates("{not json"), emptyNotificationTemplates());
  assert.deepEqual(parseNotificationTemplates(""), emptyNotificationTemplates());
  assert.deepEqual(parseNotificationTemplates(undefined), emptyNotificationTemplates());
});

test("a stored blob round-trips", () => {
  const templates = emptyNotificationTemplates();
  templates.cancelled.subject = "Sorry — {{date}} is off";
  assert.deepEqual(parseNotificationTemplates(JSON.stringify(templates)), templates);
});

test("segment count is what the carrier charges for", () => {
  assert.equal(smsSegmentLabel(""), "0 characters · 1 segment");
  assert.equal(smsSegmentLabel("x".repeat(160)), "160 characters · 1 segment");
  assert.equal(smsSegmentLabel("x".repeat(161)), "161 characters · 2 segments");
});

test("every default only uses merge fields the engine supplies", () => {
  // variablesFor() in notification-engine.mts is the contract. A field that is
  // not there renders as empty, which is a hole in a client's email.
  const SUPPLIED = new Set([
    "client", "firstName", "coach", "coachFirstName", "business", "service", "date", "time",
    "previousDate", "previousTime", "venue", "location", "locationShortName", "locationAddress",
    "mapUrl", "arrivalInstructions", "publicNotes", "phone", "email", "action", "rescheduleUrl",
    "bookingUrl", "packageAllowance", "googleCalendarUrl", "appleCalendarUrl",
  ]);
  const unknown: string[] = [];
  for (const variant of NOTIFICATION_VARIANTS) {
    const template = DEFAULT_NOTIFICATION_TEMPLATES[variant.id];
    for (const value of Object.values(template)) {
      for (const match of value.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
        if (!SUPPLIED.has(match[1])) unknown.push(`${variant.id}: {{${match[1]}}}`);
      }
    }
  }
  assert.deepEqual(unknown, [], unknown.join("\n  "));
});
