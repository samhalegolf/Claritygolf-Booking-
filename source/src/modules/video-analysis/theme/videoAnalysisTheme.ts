/**
 * The video workspace's colours: chrome follows the palette, signal does not.
 *
 * The chrome -- page, panels, ink, lines, hovers, scrims -- is aliased onto
 * the global --c-* tokens below, so there is one palette and one place to
 * change it. What made that safe is in tokens.css: `.video-analysis-shell` is
 * in the explicit-dark trigger, so the workspace is dark with no class to set
 * and nothing to toggle. The old objection here was that --c-* is light by
 * default; it is answered, not ignored.
 *
 * The signal colours are the other half of the split and are meant to stay
 * their own. The mint accent, the cyan marker, the danger pink and the amber
 * warning are marks drawn on top of arbitrary video -- grass, sky, a white
 * shirt -- so they are fixed in both schemes for exactly the reason --c-scrim
 * and --c-on-scrim are. Folding them into --c-accent would hand them to a
 * palette they are not painted on.
 *
 * Published on .video-analysis-shell rather than :root. That keeps the names
 * out of the rest of the document, which was the old wart, and it is also
 * required: on :root the --c-* values are the light ones, so every alias below
 * would resolve light.
 */
export const videoAnalysisTheme = {
  /**
   * Marks on the picture. Literal on purpose -- see the note above.
   *
   * Each family is a base plus the partners the stylesheet actually needs: a
   * wash to fill with, and the ink that has to stay readable on that fill. Any
   * other step is mixed from the base at the point of use rather than named
   * here, because a token per alpha is the drift this file just finished
   * deleting.
   */
  signal: {
    accent: "#57e59c",
    accentSoft: "#33c9cd",
    accentGlow: "rgba(87, 229, 156, 0.22)",
    accentWash: "rgba(87, 229, 156, 0.12)",
    accentWashStrong: "rgba(87, 229, 156, 0.26)",
    accentText: "#8ef4ba",
    accentInk: "#f2fff8",
    marker: "#77ffe0",
    markerWash: "rgba(119, 255, 224, 0.12)",
    danger: "#ff6b8a",
    dangerWash: "rgba(255, 107, 138, 0.16)",
    dangerText: "#ffaec2",
    dangerInk: "#ffe7ed",
    warn: "#ff834c",
    warnWash: "rgba(255, 131, 76, 0.16)",
    warnText: "#ffd7a8",
  },
  /**
   * Depth, not palette: a shadow is the absence of light, so it is black in
   * both schemes and belongs to neither. Two steps, because the stylesheet
   * genuinely has two -- a resting card and something lifted off the frame.
   */
  shadow: {
    soft: "rgba(0, 0, 0, 0.42)",
    strong: "rgba(0, 0, 0, 0.62)",
  },
  shape: {
    radiusMd: "13px",
  },
};

export const videoAnalysisThemeCss = `
  .video-analysis-shell {
    /* Chrome. tokens.css has already turned --c-* dark on this element. */
    --va-bg: var(--c-page);
    --va-panel: var(--c-surface);
    --va-panel-soft: var(--c-surface-soft);
    --va-text: var(--c-text);
    --va-text-body: var(--c-text-body);
    --va-text-soft: var(--c-text-soft);
    --va-muted: var(--c-muted);
    /* Three line weights, not the ten alphas that were here before: a hairline
       that separates, the ordinary edge of a control, and the emphasised edge
       of something selected or held. */
    --va-line-soft: var(--c-border-soft);
    --va-border: var(--c-border);
    --va-border-strong: color-mix(in srgb, var(--c-text) 26%, transparent);
    --va-hover: var(--c-hover);
    --va-active: var(--c-active);
    /* Translucent dark laid over the video itself, and the ink that goes on
       it. Fixed in both schemes upstream, which is what makes them safe on a
       frame we know nothing about. */
    --va-scrim: var(--c-scrim);
    --va-scrim-soft: var(--c-scrim-soft);
    --va-on-scrim: var(--c-on-scrim);

    /* Signal. */
    --va-accent: ${videoAnalysisTheme.signal.accent};
    --va-accent-soft: ${videoAnalysisTheme.signal.accentSoft};
    --va-accent-glow: ${videoAnalysisTheme.signal.accentGlow};
    --va-accent-wash: ${videoAnalysisTheme.signal.accentWash};
    --va-accent-wash-strong: ${videoAnalysisTheme.signal.accentWashStrong};
    --va-accent-text: ${videoAnalysisTheme.signal.accentText};
    --va-accent-ink: ${videoAnalysisTheme.signal.accentInk};
    --va-marker: ${videoAnalysisTheme.signal.marker};
    --va-marker-wash: ${videoAnalysisTheme.signal.markerWash};
    --va-danger: ${videoAnalysisTheme.signal.danger};
    --va-danger-wash: ${videoAnalysisTheme.signal.dangerWash};
    --va-danger-text: ${videoAnalysisTheme.signal.dangerText};
    --va-danger-ink: ${videoAnalysisTheme.signal.dangerInk};
    --va-warn: ${videoAnalysisTheme.signal.warn};
    --va-warn-wash: ${videoAnalysisTheme.signal.warnWash};
    --va-warn-text: ${videoAnalysisTheme.signal.warnText};

    --va-shadow: ${videoAnalysisTheme.shadow.soft};
    --va-shadow-strong: ${videoAnalysisTheme.shadow.strong};

    --va-radius-md: ${videoAnalysisTheme.shape.radiusMd};
  }
`;
