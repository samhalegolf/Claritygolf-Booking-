import assert from "node:assert/strict";
import test from "node:test";

import { speechLocale } from "./clarityVoiceLanguage";
import { cleanClarityTranscript, suppressDictationFillers } from "./clarityVoiceTextCleaner";

test("the speech locale is the reader's language with the business's accent", () => {
  assert.equal(speechLocale("en", "NZ"), "en-NZ");
  assert.equal(speechLocale("de", "CH"), "de-CH");
  // German is not spoken in New Zealand, so a German coach there is heard as German from Germany.
  assert.equal(speechLocale("de", "NZ"), "de-DE");
  assert.equal(speechLocale("pt", "NZ"), "pt-PT");
  assert.equal(speechLocale("ja", "JP"), "ja-JP");
  assert.equal(speechLocale("xx", "NZ"), "en-NZ");
});

test("English notes are tidied as they always were", () => {
  assert.equal(
    cleanClarityTranscript("um so the driver was a push fade comma then basically a pull hook new line next step more drills", { locale: "en-NZ" }),
    "So the driver was a push fade, then a pull hook.\nNext step more drills.",
  );
});

test("German hesitations go, German spoken punctuation becomes marks", () => {
  assert.equal(
    cleanClarityTranscript("ähm der Schwung war gut neue Zeile war das zu flach Fragezeichen", { locale: "de-DE" }),
    "Der Schwung war gut.\nWar das zu flach?",
  );
});

test("a word that is also punctuation elsewhere stays a word", () => {
  // "Punkt" is the low point of the swing here, not a full stop; "Komma" is a decimal.
  assert.equal(
    cleanClarityTranscript("der tiefste Punkt liegt zwei Komma fünf Zentimeter hinter dem Ball", { locale: "de-DE" }),
    "Der tiefste Punkt liegt zwei Komma fünf Zentimeter hinter dem Ball.",
  );
  assert.equal(
    cleanClarityTranscript("le point d'impact est trop bas", { locale: "fr-FR" }),
    "Le point d'impact est trop bas.",
  );
});

test("French accents do not stop a filler or a capital", () => {
  assert.equal(suppressDictationFillers("euh élan correct", "fr-FR").text, "élan correct");
  assert.equal(cleanClarityTranscript("élan correct", { locale: "fr-FR" }), "Élan correct.");
});

test("Japanese is tidied without spaces and ends with its own full stop", () => {
  assert.equal(
    cleanClarityTranscript("えーとスイングは良かった改行次はパター", { locale: "ja-JP" }),
    "スイングは良かった。\n次はパター。",
  );
});
