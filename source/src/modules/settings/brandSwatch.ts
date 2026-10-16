// A brand colour swatch: the fill, and text that reads on it.
import type { CSSProperties } from "react";

export function swatchStyle(hex: string): CSSProperties {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return { background: hex };
  const r = Number.parseInt(match[1], 16);
  const g = Number.parseInt(match[2], 16);
  const b = Number.parseInt(match[3], 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return {
    background: hex,
    color: luminance > 0.64 ? "#08100b" : "#ffffff",
    textShadow: luminance > 0.64 ? "none" : undefined,
  };
}
