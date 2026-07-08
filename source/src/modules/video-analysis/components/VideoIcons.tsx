import React from "react";

// Themed icon set derived from the Clarity Video Analysis icon pack (v1).
// Shapes come from the pack; colors are intentionally `currentColor` so each
// icon inherits the button's text color and its hover / active / disabled
// states from CSS (per the pack's "active state via CSS" guidance). The raw
// palette SVGs are kept under ./assets/icons for reference.

type IconProps = { className?: string };

const Svg = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
    <g
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </g>
  </svg>
);

export const IconModeSingle = ({ className }: IconProps) => (
  <Svg className={className}>
    <rect x="5" y="6" width="14" height="12" rx="2.5" />
    <path d="M8 9h8M8 12h5M8 15h7" />
  </Svg>
);

export const IconModeCompare = ({ className }: IconProps) => (
  <Svg className={className}>
    <rect x="3.5" y="6" width="7" height="12" rx="2" />
    <rect x="13.5" y="6" width="7" height="12" rx="2" />
    <path d="M6 9h2M16 9h2" />
  </Svg>
);

export const IconLinked = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M9.5 8.5H8a4 4 0 0 0 0 8h2.2" />
    <path d="M14.5 15.5H16a4 4 0 0 0 0-8h-2.2" />
    <path d="M9 12h6" />
  </Svg>
);

export const IconSync = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M7 7h7a4 4 0 0 1 4 4v1" />
    <path d="M16 9l2 3 2-3" />
    <path d="M17 17h-7a4 4 0 0 1-4-4v-1" />
    <path d="M8 15l-2-3-2 3" />
  </Svg>
);

export const IconToolSelect = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M6 4.5 17.5 12 12 13.3l-2.2 5.2L6 4.5z" />
  </Svg>
);

export const IconToolLine = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M6 18 18 6" />
    <circle cx="6" cy="18" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="18" cy="6" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconToolCircle = ({ className }: IconProps) => (
  <Svg className={className}>
    <ellipse cx="12" cy="12" rx="6.5" ry="5.2" />
  </Svg>
);

export const IconToolPen = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M5 17c2-5 5-5 7-2s4 3 7-3" />
    <path d="M15.5 5.5 18.5 8.5" />
    <path d="M14 7l3 3" />
  </Svg>
);

export const IconToolAngle = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M6 18h12" />
    <path d="M6 18 15 7" />
    <path d="M9.5 18a4.5 4.5 0 0 1 1.3-3.2" />
  </Svg>
);

export const IconFocus = ({ className }: IconProps) => (
  <Svg className={className}>
    <circle cx="10.5" cy="10.5" r="5.5" />
    <path d="M15 15l4 4" />
    <path d="M10.5 7.5v6M7.5 10.5h6" />
  </Svg>
);

export const IconFocusArea = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M5 9V6h3" />
    <path d="M16 6h3v3" />
    <path d="M19 15v3h-3" />
    <path d="M8 18H5v-3" />
    <rect x="8" y="9" width="8" height="6" rx="1" />
  </Svg>
);

export const IconPlay = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M9 6.5v11l8-5.5-8-5.5z" fill="currentColor" />
  </Svg>
);

export const IconPause = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M9 6.5v11M15 6.5v11" />
  </Svg>
);

export const IconUpload = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M12 15V5" />
    <path d="M8 9l4-4 4 4" />
    <path d="M5 15v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3" />
  </Svg>
);

export const IconBack = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M10 6 4 12l6 6" />
    <path d="M5 12h15" />
  </Svg>
);

export const IconTrash = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M8 8h8" />
    <path d="M10 8V6h4v2" />
    <path d="M9 10l.6 8h4.8l.6-8" />
    <path d="M11 12v4M13 12v4" />
  </Svg>
);

export const IconFocusTrackBeta = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M5 9V6h3" />
    <path d="M16 6h3v3" />
    <path d="M19 15v3h-3" />
    <path d="M8 18H5v-3" />
    <circle cx="12" cy="10" r="2" />
    <path d="M8.5 17c.7-2.2 2-3.2 3.5-3.2s2.8 1 3.5 3.2" />
  </Svg>
);
