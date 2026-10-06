// Billing > Passes > Issue or Redeem Passes: find the client, then their own
// Passes tab does the granting and spending. Nothing is listed until something
// is typed, so the page is a search box rather than a wall of names.

import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { t } from "../../lib/i18n";

export type PassClientPickerProps = {
  people: Array<{ id: string; name: string; email?: string }>;
  onPick: (personId: string) => void;
};

const MAX_MATCHES = 8;

export function PassClientPicker({ people, onPick }: PassClientPickerProps) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();

  const matches = useMemo(() => {
    if (!needle) return [];
    return people
      .filter((person) => [person.name, person.email].some((field) => (field || "").toLowerCase().includes(needle)))
      .slice(0, MAX_MATCHES);
  }, [people, needle]);

  return (
    <>
      <div className="settings-field product-search-field">
        <label htmlFor="pass-client-search">{t("Client")}</label>
        <div className="product-search-input">
          <Search size={15} />
          <input
            id="pass-client-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("Name or email")}
          />
          {Boolean(search) && (
            <button className="icon-button small" onClick={() => setSearch("")} type="button" aria-label={t("Clear search")}>
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      {Boolean(needle) && !matches.length && <p className="field-help">{t("Nobody matches that.")}</p>}
      {matches.length > 0 && (
        <ul className="pass-client-matches">
          {matches.map((person) => (
            <li key={person.id}>
              <button className="text-link-button" onClick={() => onPick(person.id)} type="button">
                {person.name}
              </button>
              {person.email && <em>{person.email}</em>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
