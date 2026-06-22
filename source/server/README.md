# Local server and SQLite notes

This folder is not the active Netlify production persistence path for the booking app.

The active application is `source/`, and production Netlify functions persist booking data through Supabase-backed adapters under `source/netlify/functions/`.

SQLite files in this folder, including `clarity-booking.sqlite` and related WAL/SHM files, are local-server development artifacts only. Do not treat them as production storage, and do not update them as part of Supabase adapter work unless a later task explicitly requests a local-server migration.

For the current production path, `booking-core.mts` imports `getDatabase` from `@netlify/database`; `source/package.json` intentionally aliases that package name to `source/netlify/functions/local-db`, whose adapter forwards to Supabase REST using Supabase environment variables.
