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

