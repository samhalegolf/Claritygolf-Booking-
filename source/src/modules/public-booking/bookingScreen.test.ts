import assert from "node:assert/strict";
import test from "node:test";

import {
  appearsOnCurrentPublicBookingScreen,
  currentPublicBookingScreenId,
  publicBookingPath,
  publicBookingRoute,
  customDomainPageSlug,
  publicSiteRoute,
} from "./bookingScreen";

test("a public booking path names its business, then its screen", () => {
  assert.deepEqual(publicBookingRoute("/"), { business: "", screenId: "main" });
  assert.deepEqual(publicBookingRoute("/sam-hale-golf"), { business: "sam-hale-golf", screenId: "main" });
  assert.deepEqual(publicBookingRoute("//sam-hale-golf//"), { business: "sam-hale-golf", screenId: "main" });
  assert.deepEqual(publicBookingRoute("/acme-golf/group-lessons"), { business: "acme-golf", screenId: "group-lessons" });
  assert.deepEqual(publicBookingRoute("/acme-golf/nonsense"), { business: "acme-golf", screenId: "main" });
});

test("legacy bare screen links name no business", () => {
  assert.deepEqual(publicBookingRoute("/group-lessons"), { business: "", screenId: "group-lessons" });
  assert.deepEqual(publicBookingRoute("/private-lessons"), { business: "", screenId: "private-lessons" });
  assert.equal(currentPublicBookingScreenId("/group-lessons"), "group-lessons");
});

test("a business's screen paths round-trip", () => {
  for (const screenId of ["main", "group-lessons", "private-lessons"]) {
    const path = publicBookingPath("acme-golf-sandbox", screenId);
    assert.deepEqual(publicBookingRoute(path), { business: "acme-golf-sandbox", screenId });
  }
  assert.equal(publicBookingPath("acme-golf", "main"), "/acme-golf");
});

test("public booking service fallback keeps legacy main services and excludes explicit empties", () => {
  assert.equal(appearsOnCurrentPublicBookingScreen({}, "/sam-hale-golf"), true);
  assert.equal(appearsOnCurrentPublicBookingScreen({ bookingScreenIds: [] }, "/sam-hale-golf"), false);
  assert.equal(appearsOnCurrentPublicBookingScreen({ bookingScreenIds: ["main"] }, "/sam-hale-golf"), true);
});

test("a business's website is /<business>/site and its pages sit under it", () => {
  assert.deepEqual(publicSiteRoute("/riverside/site"), { business: "riverside", slug: "home" });
  assert.deepEqual(publicSiteRoute("/Riverside/Site/"), { business: "riverside", slug: "home" });
  assert.deepEqual(publicSiteRoute("/riverside/site/about"), { business: "riverside", slug: "about" });
  assert.equal(publicSiteRoute("/riverside"), null);
  assert.equal(publicSiteRoute("/riverside/shop"), null);
  assert.equal(publicSiteRoute("/riverside/site/about/extra"), null);
  assert.equal(publicSiteRoute("/group-lessons/site"), null, "a booking screen is not a business");
  assert.equal(publicSiteRoute("/"), null);
});

test("on a business's own domain the root is home and one segment is a page", () => {
  assert.equal(customDomainPageSlug("/"), "home");
  assert.equal(customDomainPageSlug("/about"), "about");
  assert.equal(customDomainPageSlug("/About/"), "about");
  assert.equal(customDomainPageSlug("/about/extra"), "");
});
