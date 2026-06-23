# Calendar people-save fix — 23 June 2026

Production error addressed:

`Supabase POST people failed 409 ... idx_people_email_unique`

Cause: `calendar-state.mts` generated a deterministic appointment-person id from email, but an older person row could already hold the same case-insensitive email under a different id. Upserting on `id` then collided with the unique `lower(email)` index.

Fix: before upserting appointment-derived people, the function now resolves existing rows in this order:

1. Existing id
2. Case-insensitive email
3. Normalized name + phone

When a match exists, it reuses the existing id and preserves existing profile metadata. No unique constraint was removed.

The package also records the `calendar_items.status` schema/migration that was applied to Supabase.
