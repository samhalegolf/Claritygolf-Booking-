// Which language Clarity Voice listens for, and how it tidies what it hears.
//
// The browser's speech recognition needs a full locale ("de-DE", "en-NZ"): the
// language decides the words, the region the accent. The language is the one
// the coach reads Clarity in; the region is the business's country when that
// language is spoken there, otherwise the language's home region.
//
// Tidying is per language too. The fillers people say while thinking ("um",
// "äh", "えーと") and the words for punctuation ("full stop", "Punkt", "改行")
// are different in every language, and applying English rules to a French note
// would only damage it.

export type DictationRules = {
  /** Sounds dropped wherever they stand alone. */
  fillers: string[];
  /** Filler phrases dropped wherever they appear. */
  fillerPhrases: string[];
  /** Spoken punctuation. Earlier entries win, so longer commands come first. */
  punctuation: Array<[words: string[], mark: string]>;
  /** How a sentence ends when the speaker did not say. */
  fullStop: string;
  /** Written without spaces between words (Japanese). */
  noSpaces?: boolean;
};

const LINE = "\n";

// Outside English, only commands that cannot be ordinary speech are taken as
// punctuation. "Punkt", "point" and "punto" are nouns a coach uses ("der
// tiefste Punkt", "point d'impact"), and most of Europe says "comma" when
// reading out a decimal ("zwei Komma fünf"), so those stay as words. Fillers
// are hesitation sounds only, never real words.
const RULES: Record<string, DictationRules> = {
  en: {
    fillers: ["um", "umm", "uh", "uhh", "ah", "ahh", "erm", "er", "hmm", "mmm"],
    fillerPhrases: ["you know", "i mean", "sort of", "kind of", "basically", "actually", "right so", "okay so", "like"],
    punctuation: [
      [["new paragraph", "new line", "next line"], LINE],
      [["question mark"], "?"],
      [["exclamation mark"], "!"],
      [["full stop", "period"], "."],
      [["comma"], ","],
    ],
    fullStop: ".",
  },
  es: {
    fillers: ["eh", "em", "ehm", "mmm"],
    fillerPhrases: [],
    punctuation: [
      [["punto y aparte", "nueva línea", "nuevo párrafo"], LINE],
      [["signo de interrogación"], "?"],
      [["signo de exclamación"], "!"],
      [["punto y seguido", "punto final"], "."],
    ],
    fullStop: ".",
  },
  fr: {
    fillers: ["euh", "heu", "hum"],
    fillerPhrases: [],
    punctuation: [
      [["nouveau paragraphe", "à la ligne", "nouvelle ligne"], LINE],
      [["point d'interrogation"], "?"],
      [["point d'exclamation"], "!"],
      [["point final"], "."],
    ],
    fullStop: ".",
  },
  de: {
    fillers: ["äh", "ähm", "öhm", "hmm"],
    fillerPhrases: [],
    punctuation: [
      [["neuer absatz", "neue zeile"], LINE],
      [["fragezeichen"], "?"],
      [["ausrufezeichen"], "!"],
    ],
    fullStop: ".",
  },
  it: {
    fillers: ["ehm", "eh", "mmm", "uhm"],
    fillerPhrases: [],
    punctuation: [
      [["nuovo paragrafo", "a capo", "nuova riga"], LINE],
      [["punto interrogativo"], "?"],
      [["punto esclamativo"], "!"],
      [["punto fermo"], "."],
    ],
    fullStop: ".",
  },
  pt: {
    fillers: ["hum", "hmm", "ãh", "hã"],
    fillerPhrases: [],
    punctuation: [
      [["novo parágrafo", "nova linha"], LINE],
      [["ponto de interrogação"], "?"],
      [["ponto de exclamação"], "!"],
      [["ponto final"], "."],
    ],
    fullStop: ".",
  },
  nl: {
    fillers: ["eh", "uh", "uhm", "ehm", "hmm"],
    fillerPhrases: [],
    punctuation: [
      [["nieuwe alinea", "nieuwe regel"], LINE],
      [["vraagteken"], "?"],
      [["uitroepteken"], "!"],
    ],
    fullStop: ".",
  },
  sv: {
    fillers: ["eh", "öh", "ehm", "hmm"],
    fillerPhrases: [],
    punctuation: [
      [["nytt stycke", "ny rad"], LINE],
      [["frågetecken"], "?"],
      [["utropstecken"], "!"],
    ],
    fullStop: ".",
  },
  da: {
    fillers: ["øh", "øhm", "hmm"],
    fillerPhrases: [],
    punctuation: [
      [["nyt afsnit", "ny linje"], LINE],
      [["spørgsmålstegn"], "?"],
      [["udråbstegn"], "!"],
      [["punktum"], "."],
    ],
    fullStop: ".",
  },
  nb: {
    fillers: ["eh", "øh", "ehm", "hmm"],
    fillerPhrases: [],
    punctuation: [
      [["nytt avsnitt", "ny linje"], LINE],
      [["spørsmålstegn"], "?"],
      [["utropstegn"], "!"],
      [["punktum"], "."],
    ],
    fullStop: ".",
  },
  fi: {
    fillers: ["öö", "ööh", "ää", "hmm"],
    fillerPhrases: [],
    punctuation: [
      [["uusi kappale", "uusi rivi"], LINE],
      [["kysymysmerkki"], "?"],
      [["huutomerkki"], "!"],
    ],
    fullStop: ".",
  },
  pl: {
    fillers: ["yyy", "eee", "hmm"],
    fillerPhrases: [],
    punctuation: [
      [["nowy akapit", "nowa linia"], LINE],
      [["znak zapytania"], "?"],
      [["wykrzyknik"], "!"],
      [["kropka"], "."],
    ],
    fullStop: ".",
  },
  ja: {
    fillers: ["えーと", "えっと", "えー", "あのー", "うーん"],
    fillerPhrases: [],
    punctuation: [
      [["改行", "新しい段落"], LINE],
      [["疑問符", "はてな"], "？"],
      [["感嘆符"], "！"],
      [["句点"], "。"],
      [["読点"], "、"],
    ],
    fullStop: "。",
    noSpaces: true,
  },
};

// Where each language is at home, for when the business's country is not one
// it is spoken in.
const HOME_REGION: Record<string, string> = {
  en: "GB",
  es: "ES",
  fr: "FR",
  de: "DE",
  it: "IT",
  pt: "PT",
  nl: "NL",
  sv: "SE",
  da: "DK",
  nb: "NO",
  fi: "FI",
  pl: "PL",
  ja: "JP",
};

// Language-and-country pairs the speech services recognise beyond each home
// region. A German coach in Switzerland is heard as Swiss German; one in New
// Zealand is heard as German from Germany.
const SPOKEN_IN: Record<string, string[]> = {
  en: ["AU", "CA", "GB", "IE", "IN", "NZ", "PH", "SG", "US", "ZA"],
  es: ["AR", "CL", "CO", "ES", "MX", "PE", "US"],
  fr: ["BE", "CA", "CH", "FR"],
  de: ["AT", "CH", "DE"],
  it: ["CH", "IT"],
  pt: ["BR", "PT"],
  nl: ["BE", "NL"],
  sv: ["FI", "SE"],
};

/** The speech-recognition locale for a screen language in a business's country. */
export function speechLocale(language: string, country: string): string {
  const lang = RULES[language] ? language : "en";
  const region = String(country || "").toUpperCase();
  if ((SPOKEN_IN[lang] ?? []).includes(region)) return `${lang}-${region}`;
  return `${lang}-${HOME_REGION[lang]}`;
}

/** The tidying rules for a speech locale ("de-CH" -> German's). */
export function dictationRules(locale: string): DictationRules {
  const primary = String(locale || "").toLowerCase().split(/[-_]/)[0];
  if (primary === "no" || primary === "nn") return RULES.nb;
  return RULES[primary] ?? RULES.en;
}
