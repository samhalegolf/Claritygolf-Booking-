/**
 * The video workspace keeps its own palette, on purpose.
 *
 * The global token migration folded the coach app and the player terminal onto
 * one --c-* palette. This one is deliberately left out of it, against the
 * handoff's migration map, for two reasons:
 *
 *   It is never light. The workspace is a video surface, and a bright surround
 *   changes how you read what is on the frame. --c-* is light by default, so
 *   aliasing onto it would break the tool the first time a coach opened it in
 *   light mode.
 *
 *   Its colours are signal, not chrome. The mint accent and the marker colour
 *   have to stay legible on top of arbitrary video -- grass, sky, a white
 *   shirt. That is a different job from "the accent colour of the app", and
 *   giving them the same name invites someone to unify them later.
 *
 * The neutrals here are a cool blue-black where the global dark palette is a
 * warm green-black. That is the one difference genuinely worth revisiting --
 * but as a decision about the tool, not as part of a token rename.
 *
 * Known wart, unrelated: videoAnalysisThemeCss publishes on :root, so these
 * variables leak to the whole document once the workspace mounts. Harmless
 * while the names are unique; worth scoping to the workspace element.
 */
export const videoAnalysisTheme = {
  palette: {
    bg: "#05070d",
    panel: "#0d1220",
    panelSoft: "#121a2f",
    panelStrong: "#181f34",
    text: "#e9f0ff",
    mutedText: "#a3adc2",
    accent: "#57e59c",
    accentSoft: "#33c9cd",
    accentGlow: "rgba(87, 229, 156, 0.22)",
    border: "rgba(148, 169, 222, 0.22)",
    danger: "#ff6b8a",
    grid: "rgba(173, 190, 230, 0.12)",
    marker: "#77ffe0",
  },
  typography: {
    title: "'Montserrat', 'Avenir Next', 'Avenir', 'Segoe UI', sans-serif",
    body: "'Inter Tight', 'Nunito Sans', 'Inter', 'Segoe UI', sans-serif",
  },
  shape: {
    radiusSm: "9px",
    radiusMd: "13px",
    radiusLg: "18px",
  },
  shadow: "0 18px 45px rgba(3, 6, 15, 0.42)",
};

export const videoAnalysisThemeCss = `
  :root {
    --va-bg: ${videoAnalysisTheme.palette.bg};
    --va-panel: ${videoAnalysisTheme.palette.panel};
    --va-panel-soft: ${videoAnalysisTheme.palette.panelSoft};
    --va-panel-strong: ${videoAnalysisTheme.palette.panelStrong};
    --va-text: ${videoAnalysisTheme.palette.text};
    --va-muted: ${videoAnalysisTheme.palette.mutedText};
    --va-accent: ${videoAnalysisTheme.palette.accent};
    --va-accent-soft: ${videoAnalysisTheme.palette.accentSoft};
    --va-accent-glow: ${videoAnalysisTheme.palette.accentGlow};
    --va-border: ${videoAnalysisTheme.palette.border};
    --va-danger: ${videoAnalysisTheme.palette.danger};
    --va-grid: ${videoAnalysisTheme.palette.grid};
    --va-marker: ${videoAnalysisTheme.palette.marker};
    --va-radius-sm: ${videoAnalysisTheme.shape.radiusSm};
    --va-radius-md: ${videoAnalysisTheme.shape.radiusMd};
    --va-radius-lg: ${videoAnalysisTheme.shape.radiusLg};
  }
`;

