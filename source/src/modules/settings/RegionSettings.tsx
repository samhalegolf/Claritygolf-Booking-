// Settings > Account > Country & region.
//
// The one place a business says where it is. Country used to be a dropdown in
// the coach's Venue details, time zone a free-text box in two places, and
// currency and tax lived in two copies of the invoicing settings. Choosing a
// country now fills in the rest -- time zone, currency, and the local tax's
// name, rate and whether prices include it -- and each can still be changed
// afterwards.

import { useMemo } from "react";
import { phoneCountryOptions } from "../../../netlify/functions/_shared/phone.mts";
import { currencyForCountry } from "../../../netlify/functions/_shared/locale.mts";
import {
  regionDefaultsForCountry,
  timeZoneOffsetLabel,
  timeZonesForCountry,
} from "../../../netlify/functions/_shared/region.mts";

export type RegionValues = {
  country: string;
  timezone: string;
  currency: string;
  taxName: string;
  taxRate: number;
  taxInclusive: boolean;
};

type TimeZoneSelectProps = {
  country: string;
  value: string;
  disabled?: boolean;
  onChange: (zone: string) => void;
};

/**
 * The time zones of one country, labelled with their current UTC offset. A
 * saved zone from outside the country is kept as an option so opening the
 * editor never silently changes it.
 */
export function TimeZoneSelect({ country, value, disabled, onChange }: TimeZoneSelectProps) {
  const options = useMemo(() => {
    const zones = timeZonesForCountry(country);
    if (value && !zones.some((option) => option.zone === value)) {
      zones.unshift({ zone: value, label: value.replace(/_/g, " ") });
    }
    return zones.map((option) => {
      const offset = timeZoneOffsetLabel(option.zone);
      return { zone: option.zone, label: offset ? `${option.label} (${offset})` : option.label };
    });
  }, [country, value]);
  return (
    <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.zone} value={option.zone}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function currencyOptions(current: string) {
  const codes = new Set<string>();
  try {
    for (const code of Intl.supportedValuesOf("currency")) codes.add(code);
  } catch {
    // Older browsers: the currencies of the countries on offer are enough.
  }
  if (!codes.size) {
    for (const option of phoneCountryOptions()) codes.add(currencyForCountry(option.code));
  }
  if (current) codes.add(current);
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(["en"], { type: "currency" });
  } catch {
    names = null;
  }
  return [...codes].sort().map((code) => {
    const name = names?.of(code);
    return { code, label: name && name !== code ? `${code} — ${name}` : code };
  });
}

type RegionSettingsProps = {
  values: RegionValues;
  locked: boolean;
  onChange: (next: Partial<RegionValues>) => void;
  parseRate: (value: string) => number;
};

export function RegionSettings({ values, locked, onChange, parseRate }: RegionSettingsProps) {
  const countries = phoneCountryOptions();
  const currencies = useMemo(() => currencyOptions(values.currency), [values.currency]);
  const taxLabel = values.taxName || "tax";

  return (
    <>
      <div className="service-form-row">
        <label className="settings-field">
          <span>Country</span>
          <select
            value={values.country}
            disabled={locked}
            // A new country brings its own time zone, currency and tax with it.
            // Every one of them can be changed below afterwards.
            onChange={(event) => onChange({ country: event.target.value, ...regionDefaultsForCountry(event.target.value, values.timezone) })}
          >
            {countries.map((option) => (
              <option key={option.code} value={option.code}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-field">
          <span>Time zone</span>
          <TimeZoneSelect
            country={values.country}
            value={values.timezone}
            disabled={locked}
            onChange={(timezone) => onChange({ timezone })}
          />
        </label>
        <label className="settings-field">
          <span>Currency</span>
          <select value={values.currency} disabled={locked} onChange={(event) => onChange({ currency: event.target.value })}>
            {currencies.map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="service-form-row">
        <label className="settings-field">
          <span>Tax name</span>
          <input value={values.taxName} readOnly={locked} onChange={(event) => onChange({ taxName: event.target.value })} />
        </label>
        <label className="settings-field">
          <span>Tax rate (%)</span>
          <input
            value={values.taxRate}
            inputMode="decimal"
            readOnly={locked}
            onChange={(event) => onChange({ taxRate: parseRate(event.target.value) })}
            type="text"
          />
        </label>
        <label className="settings-field">
          <span>Prices and {taxLabel}</span>
          <select
            value={values.taxInclusive ? "inclusive" : "exclusive"}
            disabled={locked}
            onChange={(event) => onChange({ taxInclusive: event.target.value === "inclusive" })}
          >
            <option value="inclusive">Prices include {taxLabel}</option>
            <option value="exclusive">Add {taxLabel} on top</option>
          </select>
        </label>
      </div>
      <p className="field-help">
        Choosing a country fills in its time zone, currency and usual tax. Change any of them if your business
        is different. The country also sets the dialling code for phone numbers and how dates are written.
      </p>
    </>
  );
}
