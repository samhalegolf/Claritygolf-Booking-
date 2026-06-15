# Clarity Booking Supabase Persistence Fix

This patch moves the booking system off the failing `@netlify/database` runtime path and onto the Supabase project already configured in Netlify.

It also adds an admin-only client migration route:

```txt
POST /api/people/migrate
```

That route rebuilds the client list from saved appointments and can also accept a pasted/imported `people` array in the request body.

## Install

1. In Supabase, open the `clarity-caddie` project.
2. Go to SQL Editor.
3. Run `supabase/booking-schema.sql` once.
4. Copy `netlify/functions/supabase-storage.mts` into the repo at the same path.
5. Apply `booking-core.patch`.
6. Deploy to Netlify.

## Required Netlify environment variables

Production needs:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

`SUPABASE_SERVICE_ROLE_KEY` must be the real service role key, not the anon/public key.

## First test after deploy

1. Log into admin.
2. Create a block called `SAVE TEST 123`.
3. Hard refresh.
4. If it survives, persistence is fixed.
5. Run the client migration route if you need to rebuild the people/client list.
6. Then test a fresh public booking email.
