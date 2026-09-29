// The words on screen, in the reader's language.
//
// The English text is the key: `t("Save changes")` reads as what it says, and a
// missing translation falls back to exactly what was written. Each language is
// one flat file in src/locales/, English sentence -> translated sentence. There
// is no English file; English is the source.
//
// Words that change per call go in braces and are passed by name:
//   t("Remove {name} from this group?", { name })
// A translation must keep every {placeholder} its English key has --
// src/i18n.test.ts checks that for every language.
//
// The language is chosen once per page load, before anything renders (see
// src/main.tsx). Changing it saves the choice and reloads, so nothing on screen
// is ever half one language and half another, and a label built once at module
// load is as right as one built on every render.

export type LanguageCode =
  | "en"
  | "es"
  | "fr"
  | "de"
  | "it"
  | "pt"
  | "nl"
  | "sv"
  | "da"
  | "nb"
  | "fi"
  | "pl"
  | "ja";

type Catalog = Record<string, string>;

// Each language is its own chunk, fetched only by someone reading it.
const CATALOGS: Record<Exclude<LanguageCode, "en">, () => Promise<{ default: Catalog }>> = {
  es: () => import("../locales/es.json"),
  fr: () => import("../locales/fr.json"),
  de: () => import("../locales/de.json"),
  it: () => import("../locales/it.json"),
  pt: () => import("../locales/pt.json"),
  nl: () => import("../locales/nl.json"),
  sv: () => import("../locales/sv.json"),
  da: () => import("../locales/da.json"),
  nb: () => import("../locales/nb.json"),
  fi: () => import("../locales/fi.json"),
  pl: () => import("../locales/pl.json"),
  ja: () => import("../locales/ja.json"),
};

/** Every language on offer, named in itself so a reader can find their own. */
export const LANGUAGES: { code: LanguageCode; name: string }[] = [
  { code: "en", name: "English" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "it", name: "Italiano" },
  { code: "pt", name: "Português" },
  { code: "nl", name: "Nederlands" },
  { code: "sv", name: "Svenska" },
  { code: "da", name: "Dansk" },
  { code: "nb", name: "Norsk" },
  { code: "fi", name: "Suomi" },
  { code: "pl", name: "Polski" },
  { code: "ja", name: "日本語" },
];

const STORAGE_KEY = "clarity.language";

let language: LanguageCode = "en";
let catalog: Catalog = {};

function isLanguage(value: unknown): value is LanguageCode {
  return LANGUAGES.some((option) => option.code === value);
}

/** "de-CH" -> "de", "no"/"nn" -> "nb". Anything we do not offer -> null. */
export function matchLanguage(tag: unknown): LanguageCode | null {
  const primary = String(tag || "").trim().toLowerCase().split(/[-_]/)[0];
  if (primary === "no" || primary === "nn") return "nb";
  return isLanguage(primary) ? primary : null;
}

/** What this person picked on this device, or "" for "follow the browser". */
export function storedLanguage(): LanguageCode | "" {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isLanguage(value) ? value : "";
  } catch {
    return "";
  }
}

function browserLanguage(): LanguageCode {
  const tags = globalThis.navigator?.languages?.length
    ? globalThis.navigator.languages
    : [globalThis.navigator?.language];
  for (const tag of tags) {
    const match = matchLanguage(tag);
    if (match) return match;
  }
  return "en";
}

/**
 * Loads the reader's language. Called once, before the first render. A catalog
 * that fails to load leaves the page in English rather than leaving it blank.
 */
export async function initI18n(): Promise<LanguageCode> {
  const wanted = storedLanguage() || browserLanguage();
  if (wanted !== "en") {
    try {
      catalog = (await CATALOGS[wanted]()).default;
      language = wanted;
    } catch {
      catalog = {};
      language = "en";
    }
  }
  if (typeof document !== "undefined") document.documentElement.lang = language;
  return language;
}

/** The language on screen now. */
export function activeLanguage(): LanguageCode {
  return language;
}

/**
 * Saves the choice on this device and reloads into it. "" goes back to
 * following the browser.
 */
export function chooseLanguage(code: LanguageCode | ""): void {
  try {
    if (code) globalThis.localStorage?.setItem(STORAGE_KEY, code);
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Private mode: the choice lasts this page only, which is still the choice.
  }
  if (typeof window !== "undefined") window.location.reload();
}

/** The English text, in the reader's language, with its {placeholders} filled. */
export function t(text: string, values?: Record<string, string | number>): string {
  const translated = catalog[text] || text;
  if (!values) return translated;
  return translated.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}
