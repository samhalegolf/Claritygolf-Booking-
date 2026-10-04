/** Small text helpers shared by the app's models. */

export function safeText(value: unknown, fallback = "") {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}

export function browserBase64(value: string) {
  try {
    return window.btoa(value);
  } catch {
    return "";
  }
}
