# PR notes

This branch adds the production Supabase recovery SQL and records the remaining defensive code work.

The immediate blocker is expected to be Supabase schema drift: `calendar_items` must accept `status` and `custom_group`. The SQL recovery file is idempotent and reloads PostgREST's schema cache.

The remaining code patch should be done before treating this as fully complete: save paths should retry after omitting only missing optional columns rather than failing the whole lesson save.
