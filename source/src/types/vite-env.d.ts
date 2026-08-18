/**
 * The one piece of Vite's ambient typing this codebase actually uses.
 *
 * Declared here rather than pulling in `vite/client` wholesale: that would
 * also bring type declarations for importing .css, .svg, .png and a dozen other
 * assets as modules, and the app does none of that — stylesheets are imported
 * for their side effect and assets by URL. Narrower is easier to reason about,
 * and if a second field is ever needed, adding it here is the reminder to ask
 * whether it should be.
 */
interface ImportMetaEnv {
  /** True under `vite dev`, false in a production build. */
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
