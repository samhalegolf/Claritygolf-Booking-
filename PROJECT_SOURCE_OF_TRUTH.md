# Project Source of Truth

This repository contains duplicate and legacy copies of the Clarity Golf booking app.

## Active application

`source/` is the only active application.

Production deploys come from the app inside `source/`. Treat `source/` as the deployable project root for future production work.

## Legacy / duplicate root-level copies

The following root-level paths are legacy or duplicate copies and must not be treated as the active application:

- `src/`
- `netlify/`
- `server/`
- root-level SQLite / local database files
- duplicate Netlify functions outside `source/`

These files have not been removed because they may still be useful for audit, comparison, or a future explicit migration. Do not edit them as part of normal application changes.

## Future change rule

Future code changes should be made inside `source/` only, unless a migration explicitly requires otherwise.

If a future task appears to require editing root-level app files, first confirm whether the equivalent file exists inside `source/` and use the `source/` version by default.

## Persistence

The project currently uses Supabase-backed persistence through the `source/` application.

Do not refactor persistence, database logic, Netlify functions, or storage paths unless that work is requested as a separate technical patch.

## Guardrail intent

This file is documentation only. It is intended to prevent future chats and developers from modifying duplicate root-level code paths by mistake. It does not change runtime behaviour, build output, deployment configuration, UI, invoicing, or application logic.
