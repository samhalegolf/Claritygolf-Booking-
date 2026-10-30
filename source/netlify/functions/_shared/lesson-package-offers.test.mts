/**
 * Which packages a lesson can be paid with on the booking page. Wrong here is
 * money: offering a package that does not cover the lesson sells credits the
 * booking cannot use, and a "saving" that is not one is a false claim.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { packageOffersForLesson } from "./online-shop.mts";

const hour = { id: "hour", name: "1 Hour Lesson", lessonFormat: "private", price: 160, active: true };
const half = { id: "half", name: "30min Lesson", lessonFormat: "private", price: 90, active: true };
const five = { id: "five", name: "5 × 1 Hour", lessonFormat: "package", price: 700, active: true, packageAllowance: 5, coversServiceIds: ["hour"], passExpiryMonths: 12 };
const ten = { id: "ten", name: "10 × 1 Hour", lessonFormat: "package", price: 1300, active: true, packageAllowance: 10, coversServiceIds: ["hour"] };
const dear = { id: "dear", name: "3 × 1 Hour", lessonFormat: "package", price: 500, active: true, packageAllowance: 3, coversServiceIds: ["hour"] };
const off = { id: "off", name: "Old pack", lessonFormat: "package", price: 400, active: false, packageAllowance: 5, coversServiceIds: ["hour"] };

test("every package that covers the lesson is offered, cheapest first, with its saving", () => {
  const offers = packageOffersForLesson([hour, half, five, ten, off], "NZD", "hour");
  assert.deepEqual(offers.map((offer) => [offer.serviceId, offer.credits, offer.saving, offer.expiryMonths]), [
    ["five", 5, 100, 12],
    ["ten", 10, 300, null],
  ]);
});

test("a package that covers something else is not offered", () => {
  assert.deepEqual(packageOffersForLesson([hour, half, five], "NZD", "half"), []);
});

test("a package dearer than buying the lessons one by one claims no saving", () => {
  assert.equal(packageOffersForLesson([hour, dear], "NZD", "hour")[0].saving, 0);
});
