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
  /** Absolute API origin the native app calls. Empty on the web. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * True in the Capacitor build, false on the web. Both vite configs `define` it.
 *
 * A bare define rather than a VITE_ env var, because the two substitute
 * differently. Vite hoists `import.meta.env` to one object and reads fields
 * off it at runtime, so a branch guarded by it cannot fold. A plain define is
 * replaced at the use site with a literal, which is what lets the bundler drop
 * the native-only code from the web build instead of shipping it unreachable.
 *
 * Undeclared under `tsx` in plain Node, hence the `typeof` guard at the only
 * place that reads it.
 */
declare const __CLARITY_NATIVE__: boolean;
