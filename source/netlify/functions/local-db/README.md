# Local DB compatibility shim

This folder is intentionally named and packaged as a local `@netlify/database` compatibility shim for the active `source/` app.

`source/package.json` maps:

```json
"@netlify/database": "file:netlify/functions/local-db"
```

That alias means imports such as `import { getDatabase } from "@netlify/database"` resolve to this folder, not to an external Netlify Database service.

## Production persistence path

The `local-db` folder is **not** the active production database.

Production persistence is Supabase-backed. The compatibility shim exports `getDatabase()` from `index.mjs`, which forwards to `getSupabaseDatabase()` in `supabase-storage.mjs`. That adapter talks to Supabase REST using the Supabase environment variables configured in Netlify, including `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_SERVICE_KEY`.

## Why this shim exists

`booking-core.mts` currently imports `getDatabase` from `@netlify/database`. Because of the package alias above, that call reaches Supabase through this compatibility shim.

Some functions may still import direct Supabase helpers, such as `source/netlify/functions/supabase-storage.mts`. Keep the direct helper and this compatibility adapter in sync until a later explicit refactor consolidates the persistence imports.

## Do not infer SQLite or local production storage

The names `@netlify/database` and `local-db` are compatibility names only in this app. They do not mean the active Netlify production persistence path is Netlify Database, SQLite, or a local server database.
