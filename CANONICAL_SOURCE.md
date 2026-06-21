# Canonical production source

The repository root is the only production source for `claritygolf.app`.

- Build from the root `package.json` and `netlify.toml`.
- Deploy root `dist/` and root `netlify/functions/`.
- The nested `source/` directory is a legacy handover copy and must not be edited or deployed.
- `npm run build` verifies the root and applies the checked-in reliability source patch before compiling.

This rule prevents fixes landing in one copy while Netlify deploys another.
