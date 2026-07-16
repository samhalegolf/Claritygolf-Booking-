// Shared date primitives. Like lib/number, these are generic helpers used
// across App.tsx and the feature modules, so they live in one neutral place.

export function dateInputValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
