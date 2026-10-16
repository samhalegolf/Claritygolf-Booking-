# Project layout

`source/` is the application: the coach web app, the player portal, the public
booking widget, the Netlify functions and the two native shells. Netlify builds
from it (`netlify.toml` at this root points `base` at `source`).

Everything else at the root is plumbing:

- `netlify.toml`, the deploy configuration.
- `.github/workflows/`, the Android player bundle build.
- `releases/`, where `scripts/native-release.mjs` writes signed builds.
- `.claude/launch.json`, dev launch configurations.

Design notes, audits and handovers live in `source/docs/`. The most recent
whole-app audit is `source/docs/site-audit-2026-10-16.md`.

The root-level `src/`, `netlify/` and `server/` copies this file used to warn
about were removed; there is one application and one place to change it.
