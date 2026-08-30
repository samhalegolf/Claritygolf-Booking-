-- External booking clients live in their own list until an admin merges them
-- into a main client or moves them across. Only people that an inbound
-- external booking (Optix) created are external; everyone else is a main-list
-- client. booking-core's ensureSchema() carries the same ADD COLUMN, so a
-- fresh database gets the column either way.
ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS external BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: a person whose source is 'optix' only exists because an inbound
-- Optix booking created them, so they start in the external list. People who
-- were merely matched by email kept their original source and stay put.
UPDATE public.people SET external = TRUE WHERE source = 'optix';
