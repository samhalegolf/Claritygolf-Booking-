/**
 * Who pays for a custom group, and what each person is asked for. The money
 * is the reason for a test: a covered group whose friends are still sent a
 * share would be asked to pay twice for one lesson.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { bookerGroupAmount, cleanGroupPayment, customGroupInviteUrl, evenShare, friendShareAmount } from "./group-invite.mts";

const group = (groupPayment?: string) => ({
  customGroup: true,
  groupPayment,
  calculatedPrice: 240,
  attendees: [{ id: "booker" }, { id: "attendee-1" }, { id: "attendee-2" }],
});

test("a booking from before the choice existed is split, as it always was", () => {
  assert.equal(cleanGroupPayment(undefined), "split");
  assert.equal(cleanGroupPayment("anything"), "split");
  assert.equal(cleanGroupPayment("booker"), "booker");
});

test("split: each friend and the booker pay an even share", () => {
  assert.equal(evenShare(group("split")), 80);
  assert.equal(friendShareAmount(group("split")), 80);
  assert.equal(bookerGroupAmount(group("split")), 80);
});

test("covered: friends are asked for nothing and the booker pays the whole lesson", () => {
  assert.equal(friendShareAmount(group("booker")), 0);
  assert.equal(bookerGroupAmount(group("booker")), 240);
});

test("a share that does not divide evenly is rounded to the cent", () => {
  assert.equal(evenShare({ ...group("split"), calculatedPrice: 100 }), 33.33);
});

test("the invite link names its business, so it still works with more than one", () => {
  const url = new URL(customGroupInviteUrl("https://claritygolf.app", "acct-1", "tok-1"));
  assert.equal(url.pathname, "/api/custom-group-confirm");
  assert.equal(url.searchParams.get("business"), "acct-1");
  assert.equal(url.searchParams.get("token"), "tok-1");
  assert.equal(customGroupInviteUrl("https://claritygolf.app", "acct-1", ""), "");
});
