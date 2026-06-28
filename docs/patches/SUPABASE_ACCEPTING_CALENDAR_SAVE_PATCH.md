# Supabase accepting calendar save patch

## Problem

Admin calendar saves can fail when the app sends newer optional `calendar_items` fields to an older Supabase schema. The visible admin symptom is the yellow `Not saved` state after creating or moving a lesson.

Known optional fields currently sent by the app:

- `status`
- `custom_group`

If either column is missing from Supabase or PostgREST has a stale schema cache, Supabase rejects the whole `calendar_items` upsert even though the core lesson data is otherwise valid.

## Schema patch

The migration in `source/netlify/database/migrations/20260628000200_accept_calendar_item_optional_data/migration.sql` is idempotent and can be run safely in Supabase SQL Editor.

It adds:

- `calendar_items.status text not null default 'booked'`
- `calendar_items_status_check`
- `calendar_items.custom_group jsonb`
- `notify pgrst, 'reload schema'`

## Defensive code patch still required

Patch the save paths so Supabase remains as accepting as possible if a future optional column lags behind production.

### `source/netlify/functions/calendar-state.mts`

Replace the direct `calendar_items` upsert in `writeState` with a helper that:

1. Tries to save the full row payload first.
2. If Supabase reports a missing optional `calendar_items` column, retries after omitting only that optional column.
3. Continues saving core lesson fields rather than failing the whole calendar change.
4. Returns a warning so the admin UI knows the calendar saved but optional data was not fully preserved.

Current direct call to replace:

```ts
await supabase("calendar_items", {
  method: "POST",
  query: "on_conflict=id",
  body: rows,
  prefer: "resolution=merge-duplicates,return=minimal",
});
```

Target replacement:

```ts
await upsertCalendarItemRows(rows, warnings);
```

Add helpers near the existing `supabase` helper:

```ts
const OPTIONAL_CALENDAR_ITEM_ROW_COLUMNS = ["status", "custom_group"];

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "");
}

function missingOptionalCalendarItemColumn(error: unknown, omitted: Set<string>) {
  const message = errorText(error).toLowerCase();
  return OPTIONAL_CALENDAR_ITEM_ROW_COLUMNS.find((column) => {
    if (omitted.has(column)) return false;
    const needle = column.toLowerCase();
    const namesColumn =
      message.includes(`'${needle}'`) ||
      message.includes(`"${needle}"`) ||
      message.includes(`.${needle}`) ||
      message.includes(`column ${needle}`) ||
      message.includes(` ${needle} `);
    return namesColumn && (message.includes("calendar_items") || message.includes("schema cache"));
  });
}

function omitCalendarItemColumns(rows: any[], omitted: Set<string>) {
  if (!omitted.size) return rows;
  return rows.map((row) => {
    const next = { ...row };
    omitted.forEach((column) => delete next[column]);
    return next;
  });
}

function optionalCalendarItemWarning(omitted: Set<string>) {
  return `Calendar saved core lesson details, but Supabase is missing optional calendar_items columns: ${Array.from(omitted).join(", ")}. Run the calendar item schema migration so all booking details are preserved.`;
}

async function upsertCalendarItemRows(rows: any[], warnings: string[]) {
  const omitted = new Set<string>();
  while (true) {
    try {
      await supabase("calendar_items", {
        method: "POST",
        query: "on_conflict=id",
        body: omitCalendarItemColumns(rows, omitted),
        prefer: "resolution=merge-duplicates,return=minimal",
      });
      if (omitted.size) warnings.push(optionalCalendarItemWarning(omitted));
      return;
    } catch (error) {
      const missingColumn = missingOptionalCalendarItemColumn(error, omitted);
      if (!missingColumn) throw error;
      omitted.add(missingColumn);
      console.warn("calendar_state:calendar_items_optional_column_missing", {
        column: missingColumn,
        error: errorText(error).slice(0, 500),
      });
    }
  }
}
```

### `source/netlify/functions/supabase-storage.mts`

The booking-core adapter should use the same fallback for public booking and other non-admin calendar writes.

Replace:

```ts
await this.upsert(
  "calendar_items",
  [calendarItemFromParams(values)],
  "id",
);
```

with:

```ts
await this.upsertCalendarItemRows([calendarItemFromParams(values)]);
```

Add equivalent JavaScript/TypeScript helpers in the `SupabaseRestStore` path.

### `source/netlify/functions/local-db/supabase-storage.mjs`

Mirror the same adapter fallback here so the packaged `@netlify/database` shim stays aligned with the direct Supabase helper.

## Validation

Run from `source/`:

```bash
npm run build
```

Manual smoke test:

1. Sign into admin.
2. Create one normal private lesson.
3. Confirm the yellow `Not saved` banner clears.
4. Move that lesson once.
5. Confirm it persists after refresh.
6. Create a custom group lesson if available.
7. Confirm the app either preserves `custom_group` or warns without losing the core lesson.
