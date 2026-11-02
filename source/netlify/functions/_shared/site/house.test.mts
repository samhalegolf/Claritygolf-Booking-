import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { HOME_PAGE_SLUG, RESERVED_PAGE_SLUGS, cleanPageSlug, cleanSitePageContent, cleanSiteSettings } from "./document.mts";
import { HOUSE_SITE_ROLES, verifyStudioPass } from "./house.mts";
import { HOUSE_SITE_TEMPLATES } from "./house-templates.mts";
import { findSiteTemplate, houseSiteTemplate, SITE_TEMPLATES } from "./templates.mts";

/**
 * The pass Caddy's functions/studio-site-pass.mjs makes for this secret,
 * admin and expiry. Caddy's dev/studio-site-pass.test.js checks it makes
 * exactly this string, so a change to the format on either side fails a test.
 */
export const STUDIO_PASS_TEST_VECTOR = {
  secret: "test-secret",
  email: "admin@example.com",
  exp: 2000000000,
  pass: "v1.eyJhdWQiOiJjbGFyaXR5LXN0dWRpby1zaXRlcyIsInN1YiI6ImFkbWluQGV4YW1wbGUuY29tIiwiZXhwIjoyMDAwMDAwMDAwfQ.mHtdfdlNr7ISNtYFFuPc2UpsNjq170y-t4Snku17kXA",
};

function makePass(secret: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `v1.${body}.${createHmac("sha256", secret).update(`v1.${body}`).digest("base64url")}`;
}

test("a Studio pass made by Caddy is accepted until it expires", () => {
  const { secret, email, exp, pass } = STUDIO_PASS_TEST_VECTOR;
  assert.deepEqual(verifyStudioPass(pass, secret, exp - 60), { email });
  assert.equal(verifyStudioPass(pass, secret, exp), null);
  assert.equal(verifyStudioPass(pass, secret, exp + 1), null);
});

test("a Studio pass is refused when forged, re-signed, or meant for something else", () => {
  const { secret, exp, pass } = STUDIO_PASS_TEST_VECTOR;
  const now = exp - 60;
  assert.equal(verifyStudioPass(pass, "another-secret", now), null);
  assert.equal(verifyStudioPass(pass, "", now), null);
  assert.equal(verifyStudioPass("", secret, now), null);
  assert.equal(verifyStudioPass(pass.replace(/^v1\./, "v2."), secret, now), null);
  assert.equal(verifyStudioPass(`${pass}x`, secret, now), null);
  // A payload swapped in under the old signature.
  const [, , signature] = pass.split(".");
  const swapped = Buffer.from(JSON.stringify({ aud: "clarity-studio-sites", sub: "someone@else.com", exp })).toString("base64url");
  assert.equal(verifyStudioPass(`v1.${swapped}.${signature}`, secret, now), null);
  // Properly signed, but for a different audience, or with no admin named.
  assert.equal(verifyStudioPass(makePass(secret, { aud: "other", sub: "a@b.com", exp }), secret, now), null);
  assert.equal(verifyStudioPass(makePass(secret, { aud: "clarity-studio-sites", sub: "", exp }), secret, now), null);
  assert.equal(verifyStudioPass(makePass(secret, { aud: "clarity-studio-sites", sub: "a@b.com", exp: "2000000000" }), secret, now), null);
});

test("privacy, terms and support are pages a site may have", () => {
  for (const slug of ["privacy", "terms", "support"]) {
    assert.equal(RESERVED_PAGE_SLUGS.includes(slug), false);
    assert.equal(cleanPageSlug(slug), slug);
  }
  assert.equal(cleanPageSlug("api"), "");
});

test("every house site has its own template, and every house template survives the cleaner unchanged", () => {
  for (const role of Object.values(HOUSE_SITE_ROLES)) assert.ok(houseSiteTemplate(role.template), role.template);
  for (const template of HOUSE_SITE_TEMPLATES) {
    assert.equal(findSiteTemplate(template.id), template);
    assert.equal(SITE_TEMPLATES.includes(template), false, "a house template is never offered to a coach");
    const site = template.build({ businessName: "", coachName: "", bookingHref: "", venueName: "", email: "", phone: "" });
    assert.equal(site.pages[0].slug, HOME_PAGE_SLUG);
    assert.deepEqual(cleanSiteSettings(site.settings), site.settings);
    const slugs = new Set<string>();
    for (const page of site.pages) {
      assert.equal(cleanPageSlug(page.slug), page.slug, `${template.id}: ${page.slug} is a page address the cleaner keeps`);
      assert.equal(slugs.has(page.slug), false);
      slugs.add(page.slug);
      assert.ok(page.content.blocks.length > 0, `${template.id}/${page.slug} has blocks`);
      assert.deepEqual(cleanSitePageContent(page.content), page.content, `${template.id}/${page.slug} is already clean`);
      // A link to another page of the site must be to a page the site has.
      for (const match of JSON.stringify(page.content).matchAll(/"page:([a-z0-9/-]+)"/g)) assert.ok(site.pages.some((other) => other.slug === match[1]), `${page.slug} links to ${match[1]}`);
    }
  }
});

test("the Caddy site keeps the pages the app stores link to", () => {
  const site = houseSiteTemplate("house-caddy")!.build({ businessName: "", coachName: "", bookingHref: "", venueName: "", email: "", phone: "" });
  assert.deepEqual(site.pages.map((page) => page.slug), ["home", "how-it-works", "privacy", "terms", "support", "delete-account"]);
  const booking = houseSiteTemplate("house-booking")!.build({ businessName: "", coachName: "", bookingHref: "", venueName: "", email: "", phone: "" });
  assert.deepEqual(booking.pages.map((page) => page.slug), ["home", "privacy", "terms", "support"]);
});
