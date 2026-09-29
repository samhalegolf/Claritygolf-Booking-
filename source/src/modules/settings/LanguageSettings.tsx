// The language this person reads Clarity in.
//
// Personal and per device, not a business setting: two coaches in one
// workspace can read it in two languages, and a player reads the portal in
// their own. Left on "Same as this device", it follows the browser.

import { LANGUAGES, chooseLanguage, storedLanguage, t, type LanguageCode } from "../../lib/i18n";

export function LanguageSelect() {
  return (
    <label className="settings-field">
      <span>{t("Language")}</span>
      <select
        value={storedLanguage()}
        onChange={(event) => chooseLanguage(event.target.value as LanguageCode | "")}
      >
        <option value="">{t("Same as this device")}</option>
        {LANGUAGES.map((option) => (
          <option key={option.code} value={option.code}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );
}
