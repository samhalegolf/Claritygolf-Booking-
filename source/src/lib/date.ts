// Shared date primitives. Like lib/number, these are generic helpers used
// across App.tsx and the feature modules, so they live in one neutral place.

import { activeLocale } from "./activeCountry";

export function dateInputValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function timeToMinutes(hour: number, minute: number) {
  return hour * 60 + minute;
}

// "2026-07-15" -> "15 Jul 2026". Parsed as a local date (not UTC) so the day
// never shifts; falls back to the raw value / em dash if it isn't a plain date.
export function formatDateForDisplay(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!match) return value || "—";
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.toLocaleDateString(activeLocale(), { day: "numeric", month: "short", year: "numeric" });
}
