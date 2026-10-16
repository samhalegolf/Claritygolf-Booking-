// Which languages a business's emails and texts can go out in.
//
// Split from message-language.mts so the browser can validate and list the
// languages without carrying the twelve translation catalogues that module
// imports for the send path. The coach app's workspace model and the Region
// settings read this file; nothing else in src should import
// message-language.mts.

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
