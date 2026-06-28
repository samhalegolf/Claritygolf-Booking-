# Accepting calendar save recovery

Run `production-calendar-items-accepting-save.sql` in the production Supabase SQL Editor if admin calendar changes show `Not saved` after creating or moving a lesson.

The script is idempotent. It adds optional calendar item columns used by newer booking flows and reloads PostgREST's schema cache.

After running it:

1. Reload the admin app.
2. Create one small test lesson.
3. Confirm the save badge clears.
4. Refresh the page and confirm the lesson remains.
