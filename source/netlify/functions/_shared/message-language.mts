// The language a business's emails and texts go out in.
//
// One per business, chosen in Settings > Account > Country & region and stored
// as accountMessageLanguage. It is not the coach's screen language: that is
// per device (src/lib/i18n.ts), and a coach who reads Clarity in English can
// still write to their clients in Spanish.
//
// Only Clarity's own wording is translated. Anything the coach wrote -- an
// edited template field, a service name, a note -- goes out exactly as they
// wrote it.
//
// The English text is the key, as on screen: mt("Booking details"). Each
// language is one module in message-locales/, checked complete by
// notification-templates.test.mts. Isomorphic: the settings editor shows the
// same defaults the send path uses, so this must not touch any Node API.

import da from "./message-locales/da.mts";
import de from "./message-locales/de.mts";
import es from "./message-locales/es.mts";
import fi from "./message-locales/fi.mts";
import fr from "./message-locales/fr.mts";
import it from "./message-locales/it.mts";
import ja from "./message-locales/ja.mts";
import nb from "./message-locales/nb.mts";
import nl from "./message-locales/nl.mts";
import pl from "./message-locales/pl.mts";
import pt from "./message-locales/pt.mts";
import sv from "./message-locales/sv.mts";

export const MESSAGE_CATALOGS: Record<string, Record<string, string>> = {
  es, fr, de, it, pt, nl, sv, da, nb, fi, pl, ja,
};

/** Every language messages can go out in, named in itself. */
export const MESSAGE_LANGUAGES: { code: string; name: string }[] = [
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

/** A stored or submitted language, or English for anything unknown. */
export function cleanMessageLanguage(value: unknown): string {
  const code = String(value || "").trim().toLowerCase();
  return MESSAGE_LANGUAGES.some((option) => option.code === code) ? code : "en";
}

/** Clarity's English wording in the given language, with {placeholders} filled. */
export function translateMessage(
  language: unknown,
  text: string,
  values?: Record<string, string | number>,
): string {
  const translated = MESSAGE_CATALOGS[cleanMessageLanguage(language)]?.[text] || text;
  if (!values) return translated;
  return translated.replace(/(?<!\{)\{(\w+)\}(?!\})/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

/**
 * A translator bound to one business's language. Always name it `mt`: the
 * completeness test finds every sentence by looking for mt("...") calls.
 */
export function messageText(language: unknown) {
  return (text: string, values?: Record<string, string | number>) => translateMessage(language, text, values);
}
