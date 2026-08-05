import assert from "node:assert/strict";
import test from "node:test";
import { assertProcessableEvent, createCalendarItemFromOptixBooking, matchPersonByEmail, matchPersonByPhone, normalizeOptixLessonEvent, type OptixLessonMapping } from "./optix-origin.mts";
import { buildOptixAppointmentInput } from "./optix-reconcile.mts";

const mapping: OptixLessonMapping = {
  provider: "optix", organisationId: "org-1", workspaceId: "637949", workspaceName: "Swing Analysis",
  accountId: "sam-hale-golf", serviceId: "lesson-60", serviceName: "1 Hour Golf Lesson",
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
    kind: "appointment", account: "sam-hale-golf", service: "lesson-60", location: "three-kings", coach: "sam-hale",
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
    resourceMap: { "service:lesson-60": "600009" }, defaultTimeZone: "Pacific/Auckland",
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

test("a phone match compares canonical numbers rather than stored formatting", () => {
  const people = [{ id: "person-ada", phone: "021 463 7700" }, { id: "person-sam", phone: "+64274637700" }];
  assert.equal(matchPersonByPhone(people, "+6421 4637700"), "person-ada");
  assert.equal(matchPersonByPhone(people, "0274637700"), "person-sam");
  assert.equal(matchPersonByPhone(people, "021 999 0000"), null);
});

test("two clients sharing a name or a phone never collapse into one record", () => {
  // A duplicate is recoverable through the people merge; a wrong match is not,
  // because merging deletes the loser row.
  const sharedPhone = [{ id: "person-a", phone: "0211" }, { id: "person-b", phone: "0211" }];
  assert.equal(matchPersonByPhone(sharedPhone, "0211"), null);
  assert.equal(matchPersonByEmail([{ id: "person-a", name: "John Smith" }], ""), null);
  assert.equal(matchPersonByPhone([{ id: "person-a", name: "John Smith" }], ""), null);
});

test("external metadata is additive to normal lesson fields", () => {
  const item = createCalendarItemFromOptixBooking(normalizeOptixLessonEvent(payload), mapping, { itemId: "id", personId: "person" });
  const canonical = ["id", "account_id", "kind", "week", "day", "start", "duration", "coach_id", "location_id", "service_id", "client", "title", "phone", "email", "person_id", "note", "status", "coach", "location", "custom_group"];
  for (const field of canonical) assert.ok(field in item, `missing canonical field ${field}`);
  assert.equal(item.origin, "optix");
});
