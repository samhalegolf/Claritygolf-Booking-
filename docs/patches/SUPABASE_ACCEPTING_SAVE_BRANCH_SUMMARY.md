# Branch summary

`codex/supabase-accepting-calendar-save` adds the Supabase recovery layer needed for the current admin lesson save failure.

Files added:

- `source/netlify/database/migrations/20260628000200_accept_calendar_item_optional_data/migration.sql`
- `source/supabase/production-calendar-items-accepting-save.sql`
- `source/supabase/README_ACCEPTING_CALENDAR_SAVE.md`
- `docs/patches/SUPABASE_ACCEPTING_CALENDAR_SAVE_PATCH.md`
- `docs/patches/SUPABASE_ACCEPTING_SAVE_CODEX_PROMPT.md`
- `docs/patches/SUPABASE_ACCEPTING_SAVE_STATUS.md`
- `docs/patches/SUPABASE_ACCEPTING_SAVE_PR_NOTES.md`
- `docs/patches/SUPABASE_ACCEPTING_SAVE_TODO.md`

Important: the defensive code patch is specified but not applied yet.
