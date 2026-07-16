// Shared numeric primitives. Not owned by any one feature - App.tsx and the
// feature modules import from here so a generic helper like clamp lives in one
// place instead of being redefined per module.

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
