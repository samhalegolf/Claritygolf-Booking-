import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";

import { cleanGiftCardDesign, defaultGiftCardDesign, parseGiftCardDesign } from "./gift-card.mts";
import { buildGiftCardPdf, giftCardImageKind } from "./gift-card-pdf.mts";

// A 4 x 2 red PNG: wide, so the page should be twice as wide as it is tall.
const PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGP4z8AARwzIHABvqgf5gNwAKAAAAABJRU5ErkJggg==", "base64"),
);
const WEBP = Uint8Array.from(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"));

test("a fresh design has no picture and every field on the card", () => {
  const design = defaultGiftCardDesign();
  assert.equal(design.imageUrl, "");
  assert.ok(design.fields.name.show && design.fields.code.show && design.fields.value.show);
});

test("cleaning keeps what makes sense and puts the rest back to the default", () => {
  const design = cleanGiftCardDesign({
    imageUrl: "https://storage.example/site-media/acct/card.png",
    fields: {
      name: { x: 1.4, y: -2, size: 9, color: "red", align: "sideways", font: "comic", bold: "yes", show: false },
      code: { x: 0.25, y: 0.75, size: 0.1, color: "#AA3300", align: "left", font: "serif", bold: true },
    },
    extra: "dropped",
  });
  assert.equal(design.imageUrl, "https://storage.example/site-media/acct/card.png");
  const defaults = defaultGiftCardDesign().fields;
  assert.deepEqual(design.fields.name, { ...defaults.name, x: 1, y: 0, size: 0.25, show: false });
  assert.deepEqual(design.fields.code, { show: true, x: 0.25, y: 0.75, size: 0.1, color: "#aa3300", align: "left", font: "serif", bold: true });
  assert.deepEqual(design.fields.value, defaults.value, "a field the blob never had is the default");
  assert.equal((design as Record<string, unknown>).extra, undefined);
});

test("only a web address is kept as the artwork", () => {
  assert.equal(cleanGiftCardDesign({ imageUrl: "javascript:alert(1)" }).imageUrl, "");
  assert.equal(cleanGiftCardDesign({ imageUrl: "http://plain.example/card.png" }).imageUrl, "");
});

test("a corrupt stored design reads as a fresh one", () => {
  assert.deepEqual(parseGiftCardDesign("{nope"), defaultGiftCardDesign());
  assert.deepEqual(parseGiftCardDesign(""), defaultGiftCardDesign());
  assert.deepEqual(parseGiftCardDesign(undefined), defaultGiftCardDesign());
});

test("a stored design round-trips", () => {
  const design = cleanGiftCardDesign({ imageUrl: "https://storage.example/a.jpg", fields: { code: { x: 0.1, font: "mono" } } });
  assert.deepEqual(parseGiftCardDesign(JSON.stringify(design)), design);
});

test("the picture's type is read from its bytes, and only PNG and JPEG are taken", () => {
  assert.equal(giftCardImageKind(PNG), "png");
  assert.equal(giftCardImageKind(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0])), "jpg");
  assert.equal(giftCardImageKind(WEBP), null);
});

test("one page per voucher, shaped like the artwork", async () => {
  const design = cleanGiftCardDesign({ imageUrl: "https://storage.example/a.png" });
  const bytes = await buildGiftCardPdf(design, PNG, [
    { name: "Ana", code: "CG-AAAA-BBBB", value: "$50.00" },
    { name: "Ben", code: "CG-CCCC-DDDD", value: "$100.00" },
  ]);
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 2);
  const { width, height } = pdf.getPage(0).getSize();
  assert.equal(width, 600);
  assert.equal(height, 300);
});

test("a name the built-in fonts cannot spell, or one far too long, still makes a card", async () => {
  const design = cleanGiftCardDesign({ imageUrl: "https://storage.example/a.png", fields: { name: { x: 0.95, align: "center" } } });
  const bytes = await buildGiftCardPdf(design, PNG, [
    { name: "Łukasz 山田 Zoë", code: "CG-EEEE-FFFF", value: "€20" },
    { name: "A".repeat(140), code: "CG-GGGG-HHHH", value: "$20" },
  ]);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 2);
});

test("a picture the PDF cannot hold is refused, not half-drawn", async () => {
  await assert.rejects(
    () => buildGiftCardPdf(defaultGiftCardDesign(), WEBP, [{ name: "Ana", code: "CG-AAAA-BBBB", value: "$5" }]),
    /PNG or JPEG/,
  );
});
