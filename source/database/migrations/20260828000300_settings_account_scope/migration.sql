-- Migration B: Settings ownership — add account_id and change the primary key
--
-- The settings table was globally keyed (key TEXT PRIMARY KEY). After this
-- migration the unique boundary is (account_id, key). Existing rows are
-- backfilled to the original workspace row created by Migration A, so the two
-- migrations cannot disagree about which id the original business has.
--
-- Global reads/writes without an account_id are no longer valid at the SQL
-- level: the PK requires one.

alter table public.settings add column if not exists account_id text;

-- 1. Backfill every existing settings row with the original workspace id.
--    Migration A already resolved that id once; read it back rather than
--    re-deriving it here.
update public.settings
set account_id = (
  select id from public.accounts order by created_at asc, id asc limit 1
)
where account_id is null or btrim(account_id) = '';

-- Belt and braces: Migration A always seeds one accounts row, so the update
-- above cannot leave a NULL behind. If it somehow did, land on the legacy id
-- rather than dropping a settings row on the floor.
update public.settings
set account_id = 'sam-hale-golf'
where account_id is null or btrim(account_id) = '';

-- 2. Now that every row has an owner, enforce it.
alter table public.settings alter column account_id set not null;

-- 3. Replace the old global primary key with the composite boundary.
--    The existing key is almost certainly named settings_pkey, but dropping it
--    by name and then adding a new one would fail with "multiple primary keys"
--    if it ever wasn't -- so drop whatever primary key the table actually has.
do $$
declare
  existing_pk text;
begin
  select conname into existing_pk
  from pg_constraint
  where conrelid = 'public.settings'::regclass
    and contype = 'p';

  if existing_pk is not null then
    execute format('alter table public.settings drop constraint %I cascade', existing_pk);
  end if;
end
$$;

alter table public.settings
  add constraint settings_pkey primary key (account_id, key);

-- 4. The PK covers (account_id, key) and the account-wide bulk read.
--    A key-only index is still useful for cross-account admin queries.
create index if not exists idx_settings_key
  on public.settings (key);

notify pgrst, 'reload schema';
