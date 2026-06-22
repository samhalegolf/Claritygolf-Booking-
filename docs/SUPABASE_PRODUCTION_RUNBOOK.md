# Supabase production runbook

This booking app is intentionally Supabase-backed in production.

## Production configuration

On the `clarity-golf-booking` Netlify project, production must have the Supabase project URL, a server-only Supabase service key, and the coach admin login values configured as environment variables.

Email flows also need the Resend API key and sender/reply-to settings.

## Database schema

Apply `docs/supabase_schema.sql` in the SQL editor for the production Supabase project.

The app expects these tables:

- `settings`
- `calendar_items`
- `people`
- `admin_users`
- `admin_sessions`
- `admin_password_resets`
- `notification_history`
- `notification_webhook_events`

## Deployment check

After deploy:

1. Open the admin login page.
2. Log in with the coach admin account.
3. Open `/api/system-smoke` while logged in.
4. Confirm the smoke response has `ok: true` and the Supabase read/write steps pass.

If login fails with a Supabase configuration message, fix the Netlify environment configuration before changing app code.
If login succeeds but smoke fails on a table read, apply or repair `docs/supabase_schema.sql` in Supabase.
