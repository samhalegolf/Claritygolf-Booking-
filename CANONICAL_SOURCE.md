# Canonical production source

The repository root is the only production source for `claritygolf.app`.

Netlify must build:

- root `package.json`
- root `src/`
- root `netlify/functions/`
- root `netlify.toml`

Do not add or deploy a second nested `source/`, `deploy/`, or copied app directory. That was allowing fixes to land in one copy while Netlify built another.
