import assert from "node:assert/strict";
import test from "node:test";

import { addTextLink, textParts } from "./textLinks";

test("words with no link stay one run", () => {
  assert.deepEqual(textParts("Just words."), ["Just words."]);
});

test("[words](address) becomes a link", () => {
  assert.deepEqual(textParts("Read [my blog](https://example.com/blog) today"), [
    "Read ",
    { text: "my blog", href: "https://example.com/blog" },
    " today",
  ]);
});

test("a page of the site, mailto and tel are links", () => {
  assert.deepEqual(textParts("[About](page:about)"), [{ text: "About", href: "page:about" }]);
  assert.deepEqual(textParts("[Email](mailto:a@b.co)"), [{ text: "Email", href: "mailto:a@b.co" }]);
  assert.deepEqual(textParts("[Call](tel:+441234567)"), [{ text: "Call", href: "tel:+441234567" }]);
});

test("a bare address is a link, without the full stop after it", () => {
  assert.deepEqual(textParts("See https://example.com/drills."), ["See ", { text: "https://example.com/drills", href: "https://example.com/drills" }, "."]);
});

test("an unsafe address stays as the words it was written as", () => {
  assert.deepEqual(textParts("[click](javascript:alert(1))"), ["[click](javascript:alert(1))"]);
});

test("adding a link wraps the chosen words", () => {
  assert.deepEqual(addTextLink("Book a lesson now", 7, 13, "page:book"), { value: "Book a [lesson](page:book) now", caret: 26 });
});

test("adding a link with nothing chosen puts in the address itself", () => {
  assert.equal(addTextLink("Hi ", 3, 3, "https://example.com/").value, "Hi [https://example.com/](https://example.com/)");
});
