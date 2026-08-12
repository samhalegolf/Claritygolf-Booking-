import assert from "node:assert/strict";
import test from "node:test";
import { EXTERNAL_BOOKING_SERVICE_ID, assertProcessableEvent, createCalendarItemFromOptixBooking, externalBookingNote, findDuplicateBooking, matchPersonByEmail, normalizeOptixLessonEvent, updateCalendarItemFromOptixBooking, type OptixLessonMapping } from "./optix-origin.mts";
import { buildOptixAppointmentInput } from "./optix-reconcile.mts";

const mapping: OptixLessonMapping = {
  provider: "optix", organisationId: "org-1", workspaceId: "637949", workspaceName: "Swing Analysis",
  accountId: "sam-hale-golf",
  locationId: "three-kings", defaultCoachId: "sam-hale", enabled: true, expectedDuration: 60,
  bayProfileId: "standard", emailBehaviour: "none",
};

const payload = {
  event: "new_member_booking", booking_id: "swing-123", organization_id: "org-1",
  workspace_id: 637949, workspace_name: "Swing Analysis",
  check_in_timestamp: "2026-08-03T02:00:00.000Z", check_out_timestamp: "2026-08-03T03:00:00.000Z",
  timezone: "Pacific/Auckland", member: { first_name: "Ada", last_name: "Lovelace", email: "ADA@example.com", phone: "0211" },
};

test("workspace 637949 creates the canonical calendar appointment contract", () => {
  const event = normalizeOptixLessonEvent(payload);
  const item = createCalendarItemFromOptixBooking(event, mapping, { itemId: "optix-item-1", personId: "person-1" });
  assert.deepEqual({ kind: item.kind, account: item.account_id, service: item.service_id, location: item.location_id, coach: item.coach_id }, {
    kind: "appointment", account: "sam-hale-golf", service: EXTERNAL_BOOKING_SERVICE_ID, location: "three-kings", coach: "sam-hale",
  });
  assert.equal(item.duration, 60);
  assert.equal(item.client, "Ada Lovelace");
  assert.equal(item.email, "ada@example.com");
  assert.equal(item.person_id, "person-1");
  assert.equal(item.external_booking_id, "swing-123");
  assert.equal(item.external_sync_state, "bay_required");
});

test("reads Optix form payload member_name instead of creating an Optix customer placeholder", () => {
  const event = normalizeOptixLessonEvent({
    ...payload,
    member: undefined,
    member_name: "Samuel",
    member_last_name: "Hale",
    member_email: "sam@example.com",
  });
  assert.equal(event.firstName, "Samuel");
  assert.equal(event.lastName, "Hale");
  const item = createCalendarItemFromOptixBooking(event, mapping, { itemId: "optix-item-2", personId: "person-2" });
  assert.equal(item.client, "Samuel Hale");
  assert.notEqual(item.client, "Optix customer");
});

test("rejects a nameless Optix event rather than pooling it into a fake customer", () => {
  const event = normalizeOptixLessonEvent({
    ...payload,
    member: undefined,
    member_name: "",
    member_last_name: "",
    member_email: "",
    member_phone: "",
  });
  assert.throws(() => assertProcessableEvent(event), (error: any) => error?.code === "missing_customer_identity");
});

test("generated item is accepted unchanged by the existing Book resource payload builder", () => {
  const item: any = createCalendarItemFromOptixBooking(normalizeOptixLessonEvent(payload), mapping, { itemId: "optix-item-1", personId: "person-1" });
  const appointment = {
    id: item.id, kind: item.kind, week: item.week, day: item.day, start: item.start, duration: item.duration,
    title: item.title, client: item.client, note: item.note, serviceId: item.service_id,
    locationId: item.location_id, location: item.location, status: item.status,
  };
  const outbound = buildOptixAppointmentInput(appointment, null, {
    memberId: "clarity-member", ownerUserId: "owner", defaultResourceId: "600006",
    resourceMap: { [`service:${EXTERNAL_BOOKING_SERVICE_ID}`]: "600009" }, defaultTimeZone: "Pacific/Auckland",
  });
  assert.equal(outbound.externalId, "clarity:optix-item-1");
  assert.deepEqual(outbound.resourceIds, ["600009"]);
  assert.equal(outbound.title, "Ada Lovelace");
  assert.equal(outbound.endTimestamp - outbound.startTimestamp, 3600);
});

test("ordinary bay workspace 600006 cannot match the recognised lesson mapping", () => {
  const bay = normalizeOptixLessonEvent({ ...payload, workspace_id: 600006, workspace_name: "Bay #4" });
  assert.notEqual(bay.workspaceId, mapping.workspaceId);
  assert.equal(bay.workspaceName, "Bay #4");
});

test("update and cancellation retain the same external booking identity", () => {
  const updated = normalizeOptixLessonEvent({ ...payload, event: "member_booking_updated", check_out_timestamp: "2026-08-03T03:30:00Z" });
  const cancelled = normalizeOptixLessonEvent({ ...payload, event: "member_booking_cancelled" });
  const updatedItem = createCalendarItemFromOptixBooking(updated, mapping, { itemId: "same-item", personId: "same-person" });
  const cancelledItem = createCalendarItemFromOptixBooking(cancelled, mapping, { itemId: "same-item", personId: "same-person" });
  assert.equal(updatedItem.id, cancelledItem.id);
  assert.equal(updatedItem.external_booking_id, cancelledItem.external_booking_id);
  assert.equal(updatedItem.duration, 90);
  assert.equal(cancelledItem.status, "cancelled");
});

test("an email match is case-insensitive but must be unambiguous", () => {
  const people = [{ id: "person-ada", email: "ADA@example.com" }, { id: "person-sam", email: "sam@example.com" }];
  assert.equal(matchPersonByEmail(people, "ada@example.com"), "person-ada");
  assert.equal(matchPersonByEmail(people, "nobody@example.com"), null);
  assert.equal(matchPersonByEmail([...people, { id: "person-ada-2", email: "ada@example.com" }], "ada@example.com"), null);
});

test("two clients sharing an email or a name never collapse into one record", () => {
  // A duplicate is recoverable through the people merge; a wrong match is not,
  // because merging deletes the loser row.
  const sharedEmail = [{ id: "person-a", email: "family@example.com" }, { id: "person-b", email: "family@example.com" }];
  assert.equal(matchPersonByEmail(sharedEmail, "family@example.com"), null);
  assert.equal(matchPersonByEmail([{ id: "person-a", name: "John Smith" }], ""), null);
});

test("a reschedule moves the booking without touching what an admin owns", () => {
  const moved = normalizeOptixLessonEvent({
    ...payload,
    event: "member_booking_updated",
    check_in_timestamp: "2026-08-04T02:00:00.000Z",
    check_out_timestamp: "2026-08-04T03:30:00.000Z",
  });
  const patch = updateCalendarItemFromOptixBooking(moved, mapping);
  assert.equal(patch.duration, 90);
  assert.equal(patch.external_event_type, "member_booking_updated");
  // Anything an admin can edit after import must be absent from the patch, or
  // the reschedule silently reverts it.
  for (const field of ["coach_id", "note", "person_id", "service_id", "location_id", "client", "title", "email", "phone"]) {
    assert.ok(!(field in patch), `reschedule must not write ${field}`);
  }
});

test("every inbound booking files under the reserved External Booking type", () => {
  const created = createCalendarItemFromOptixBooking(normalizeOptixLessonEvent(payload), mapping, { itemId: "id", personId: "person" });
  assert.equal(created.service_id, EXTERNAL_BOOKING_SERVICE_ID);
  // The Optix wording lives in the note, written on create only.
  assert.equal(created.note, "Optix: Swing Analysis");
});

test("the note carries the source's own label, workspace and type", () => {
  const event = normalizeOptixLessonEvent({ ...payload, workspace_name: "Sam Hale Golf", workspace_type: "Golf Lessons" });
  assert.equal(externalBookingNote(event, mapping), "Optix: Sam Hale Golf · Golf Lessons");
  // A repeated label is not written twice, and an empty payload still notes
  // where the booking came from.
  const bare = normalizeOptixLessonEvent({ ...payload, workspace_name: "", workspace_type: "" });
  assert.equal(externalBookingNote(bare, { ...mapping, workspaceName: "" }), "Optix booking");
  assert.equal(externalBookingNote(bare, mapping), "Optix: Swing Analysis");
});

test("a lesson the coach already has is not imported a second time", () => {
  // The 13 duplicates found on 5 Aug 2026: a native lesson the coach booked,
  // then the same lesson arriving through Optix.
  const event = normalizeOptixLessonEvent(payload);
  const native = { id: "appt-native", client: "Ada Lovelace", email: "", phone: "", start: 840, duration: 60, status: "booked" };
  assert.equal(findDuplicateBooking([native], event, { start: 840, duration: 60 }), "appt-native");
  // Matching on any one identity field is enough.
  assert.equal(
    findDuplicateBooking([{ ...native, client: "", email: "ada@example.com" }], event, { start: 840, duration: 60 }),
    "appt-native",
  );
  // Phone matching is canonical, so stored formatting does not matter.
  const phoneEvent = normalizeOptixLessonEvent({
    ...payload,
    member: { first_name: "", last_name: "", email: "", phone: "021 463 7700" },
  });
  assert.equal(
    findDuplicateBooking(
      [{ ...native, client: "", email: "", phone: "+64214637700" }],
      phoneEvent,
      { start: 840, duration: 60 },
    ),
    "appt-native",
  );
});

test("a cancelled record never blocks the rebooking that replaced it", () => {
  // The other form: Optix cancels a booking and reissues a new ID for the same
  // slot. The cancelled row is history and the slot is genuinely free.
  const event = normalizeOptixLessonEvent(payload);
  const cancelled = { id: "optix-old", client: "Ada Lovelace", start: 840, duration: 60, status: "cancelled" };
  assert.equal(findDuplicateBooking([cancelled], event, { start: 840, duration: 60 }), null);
});

test("a different customer or a clear slot is not a duplicate", () => {
  const event = normalizeOptixLessonEvent(payload);
  const other = { id: "appt-other", client: "Someone Else", start: 840, duration: 60, status: "booked" };
  assert.equal(findDuplicateBooking([other], event, { start: 840, duration: 60 }), null);
  const laterSameClient = { id: "appt-later", client: "Ada Lovelace", start: 1200, duration: 60, status: "booked" };
  assert.equal(findDuplicateBooking([laterSameClient], event, { start: 840, duration: 60 }), null);
  assert.equal(findDuplicateBooking([], event, { start: 840, duration: 60 }), null);
});

test("a lesson that merely overlaps the same customer's slot still counts", () => {
  const event = normalizeOptixLessonEvent(payload);
  const overlapping = { id: "appt-overlap", client: "Ada Lovelace", start: 870, duration: 60, status: "booked" };
  assert.equal(findDuplicateBooking([overlapping], event, { start: 840, duration: 60 }), "appt-overlap");
});

test("external metadata is additive to normal lesson fields", () => {
  const item = createCalendarItemFromOptixBooking(normalizeOptixLessonEvent(payload), mapping, { itemId: "id", personId: "person" });
  const canonical = ["id", "account_id", "kind", "week", "day", "start", "duration", "coach_id", "location_id", "service_id", "client", "title", "phone", "email", "person_id", "note", "status", "coach", "location", "custom_group"];
  for (const field of canonical) assert.ok(field in item, `missing canonical field ${field}`);
  assert.equal(item.origin, "optix");
});
