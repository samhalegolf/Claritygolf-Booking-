import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanPlayerBookingEmbedHeight,
  cleanPlayerBookingEmbedIntro,
  cleanPlayerBookingEmbedLabel,
  cleanPlayerBookingEmbedUrl,
  PLAYER_BOOKING_EMBED_DEFAULT_HEIGHT,
  PLAYER_BOOKING_EMBED_DEFAULT_LABEL,
  PLAYER_BOOKING_EMBED_MAX_HEIGHT,
  PLAYER_BOOKING_EMBED_MIN_HEIGHT,
  PLAYER_BOOKING_EMBED_SETTING_KEYS,
  playerBookingEmbedForPortal,
  playerBookingEmbedFromSettings,
} from "./player-booking-embed.mts";

test("only absolute https survives as an embed URL", () => {
  assert.equal(
    cleanPlayerBookingEmbedUrl("https://booking.example.com/bays"),
    "https://booking.example.com/bays",
  );
  // Whitespace around a pasted URL is the normal case, not an error.
  assert.equal(cleanPlayerBookingEmbedUrl("  https://example.com/book  "), "https://example.com/book");
});

test("anything that is not a plain https page is not a booking widget", () => {
  // http would put a mixed-content frame in a signed-in portal.
  assert.equal(cleanPlayerBookingEmbedUrl("http://booking.example.com"), "");
  // A src of javascript:/data: is script injection with extra steps.
  assert.equal(cleanPlayerBookingEmbedUrl("javascript:alert(1)"), "");
  assert.equal(cleanPlayerBookingEmbedUrl("data:text/html,<script>alert(1)</script>"), "");
  // A relative path would resolve against the portal and frame it in itself.
  assert.equal(cleanPlayerBookingEmbedUrl("/book"), "");
  assert.equal(cleanPlayerBookingEmbedUrl("booking.example.com"), "");
  assert.equal(cleanPlayerBookingEmbedUrl(""), "");
  assert.equal(cleanPlayerBookingEmbedUrl(null), "");
  assert.equal(cleanPlayerBookingEmbedUrl(42), "");
});

test("a rejected URL does not quietly keep the old one", () => {
  // The write path passes no fallback, so a coach who pastes an http URL over
  // a working https one gets "not configured" -- not the previous widget still
  // live under a value the panel says was replaced.
  assert.equal(cleanPlayerBookingEmbedUrl("http://example.com"), "");
});

test("the tab always has a name", () => {
  assert.equal(cleanPlayerBookingEmbedLabel("Tee times"), "Tee times");
  assert.equal(cleanPlayerBookingEmbedLabel("   "), PLAYER_BOOKING_EMBED_DEFAULT_LABEL);
  assert.equal(cleanPlayerBookingEmbedLabel(undefined), PLAYER_BOOKING_EMBED_DEFAULT_LABEL);
  // Long enough to break the nav bar gets cut, not rejected.
  assert.equal(cleanPlayerBookingEmbedLabel("x".repeat(80)).length, 24);
});

test("the intro line is optional and bounded", () => {
  assert.equal(cleanPlayerBookingEmbedIntro("  Bays only.  "), "Bays only.");
  assert.equal(cleanPlayerBookingEmbedIntro(undefined), "");
  assert.equal(cleanPlayerBookingEmbedIntro("y".repeat(400)).length, 240);
});

test("height is clamped to something a frame can actually be", () => {
  assert.equal(cleanPlayerBookingEmbedHeight(900), 900);
  assert.equal(cleanPlayerBookingEmbedHeight("640"), 640);
  assert.equal(cleanPlayerBookingEmbedHeight(10), PLAYER_BOOKING_EMBED_MIN_HEIGHT);
  assert.equal(cleanPlayerBookingEmbedHeight(99999), PLAYER_BOOKING_EMBED_MAX_HEIGHT);
  assert.equal(cleanPlayerBookingEmbedHeight("not a number"), PLAYER_BOOKING_EMBED_DEFAULT_HEIGHT);
  assert.equal(cleanPlayerBookingEmbedHeight(undefined), PLAYER_BOOKING_EMBED_DEFAULT_HEIGHT);
});

test("a business that never set one up reads as not configured", () => {
  const config = playerBookingEmbedFromSettings({});
  assert.equal(config.playerBookingEmbedUrl, "");
  assert.equal(config.playerBookingEmbedLabel, PLAYER_BOOKING_EMBED_DEFAULT_LABEL);
  assert.equal(config.playerBookingEmbedHeight, PLAYER_BOOKING_EMBED_DEFAULT_HEIGHT);
  assert.equal(playerBookingEmbedFromSettings(null).playerBookingEmbedUrl, "");
});

test("the portal shape is the settings shape with the prefix dropped", () => {
  const portal = playerBookingEmbedForPortal({
    playerBookingEmbedUrl: "https://booking.example.com/bays",
    playerBookingEmbedLabel: "Bay",
    playerBookingEmbedIntro: "Bays only.",
    playerBookingEmbedHeight: "820",
  });
  assert.deepEqual(portal, {
    url: "https://booking.example.com/bays",
    label: "Bay",
    intro: "Bays only.",
    height: 820,
  });
});

test("a bad URL hides the tab even when the other three are set", () => {
  // The portal keys the whole feature off a non-empty url, so a label and a
  // height left over from a working config must not resurrect an empty tab.
  const portal = playerBookingEmbedForPortal({
    playerBookingEmbedUrl: "http://booking.example.com",
    playerBookingEmbedLabel: "Bay",
    playerBookingEmbedHeight: "820",
  });
  assert.equal(portal.url, "");
});

test("both implementations of /api/admin-settings accept these keys", async () => {
  // admin-settings.mts serves the route; booking-core.mts holds a mirror of the
  // same read/write behind a pathname branch. The mirror has drifted before --
  // it silently dropped the notification template keys -- and booking-core's
  // params are untyped, so nothing warns you. This is the guard for these four.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const read = (name: string) => readFileSync(`${dir}../${name}`, "utf8");

  for (const key of PLAYER_BOOKING_EMBED_SETTING_KEYS) {
    for (const file of ["admin-settings.mts", "booking-core.mts"]) {
      assert.ok(
        read(file).includes(`"${key}"`),
        `${file} does not write ${key} — the two /api/admin-settings implementations have drifted.`,
      );
    }
  }
});
