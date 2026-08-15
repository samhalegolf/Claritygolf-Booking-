-- Products + stock. Run once in the Supabase project used by Clarity Booking,
-- after billing-schema.sql and pos-schema.sql. Every statement is additive and
-- idempotent, so re-running it is safe.
--
-- There is deliberately no new "products" table. billing_products_services
-- already holds the things a coach sells (it is what the invoice line picker
-- reads), so a second list would mean maintaining the same glove in two
-- places and choosing which one the till believes. Stock is therefore extra
-- columns on the row that already exists, plus a ledger.

-- --- Product columns --------------------------------------------------------
-- supplier/sku are plain descriptive fields. cost_price is what you pay; the
-- existing default_price stays as what you charge.
--
-- track_stock is what separates a glove from a club-fitting fee. Both can be
-- kind = 'product'; only one has a countable stock level, and selling the
-- other must never drive a number negative.
alter table public.billing_products_services
  add column if not exists supplier text,
  add column if not exists sku text,
  add column if not exists cost_price numeric not null default 0,
  add column if not exists track_stock boolean not null default false,
  add column if not exists stock_level numeric not null default 0,
  add column if not exists low_stock_threshold numeric not null default 0;

-- SKUs only need to be unique within an account, and only when set - most
-- services never get one. A partial index keeps blank/null SKUs out of the
-- uniqueness check entirely.
create unique index if not exists idx_billing_products_sku
  on public.billing_products_services (account_id, lower(sku))
  where sku is not null and sku <> '';

create index if not exists idx_billing_products_stock
  on public.billing_products_services (account_id, track_stock, active);

-- --- Stock ledger -----------------------------------------------------------
-- Append-only. stock_level on the product is the running total; this is the
-- answer to "why is it 3?". resulting_level is snapshotted at write time so the
-- history stays readable even after later movements.
create table if not exists public.billing_stock_movements (
  id text primary key,
  account_id text not null,
  product_id text not null,
  -- Negative takes stock out, positive puts it back.
  delta numeric not null,
  resulting_level numeric,
  kind text not null default 'adjustment'
    check (kind in ('adjustment', 'stocktake', 'receipt', 'sale', 'sale_reversal')),
  -- Set for 'sale'/'sale_reversal' rows so a movement can be traced back to the
  -- receipt that caused it. Not a foreign key, for the same reason POS sales
  -- don't foreign-key bookings: stock must never be able to block a delete.
  pos_transaction_id text,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_billing_stock_movements_product
  on public.billing_stock_movements (account_id, product_id, created_at desc);

-- --- POS sale line items ----------------------------------------------------
-- A counter sale can be several products at once. Name, SKU and unit price are
-- snapshotted: a receipt has to keep saying what was actually sold and for how
-- much after the product is renamed, repriced or retired.
create table if not exists public.billing_pos_transaction_items (
  id text primary key,
  account_id text not null,
  transaction_id text not null,
  product_id text,
  name text not null,
  sku text,
  quantity numeric not null default 1,
  unit_price numeric not null default 0,
  line_total numeric not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_billing_pos_items_transaction
  on public.billing_pos_transaction_items (account_id, transaction_id);

-- Whether this sale's stock has already been taken off the shelf. The flag
-- lives on the transaction rather than being inferred from status, because
-- status can move paid -> refunded -> paid and each hop must move stock exactly
-- once. See applyPosStock() in billing-api.mts.
alter table public.billing_pos_transactions
  add column if not exists stock_applied boolean not null default false;

-- --- Atomic adjustment ------------------------------------------------------
-- PostgREST cannot express "stock_level = stock_level + delta", and doing it as
-- a read-then-write from the function would lose a sale whenever two tills
-- overlap. This does the arithmetic inside the single UPDATE statement.
--
-- Stock is allowed to go negative: a till that refuses to sell the last glove
-- because the count drifted is worse than a count that reads -1 and gets fixed
-- at the next stocktake.
create or replace function public.billing_adjust_stock(
  p_account_id text,
  p_product_id text,
  p_delta numeric
) returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_level numeric;
begin
  update public.billing_products_services
     set stock_level = coalesce(stock_level, 0) + p_delta,
         updated_at = now()
   where id = p_product_id
     and account_id = p_account_id
     and track_stock = true
  returning stock_level into v_level;
  return v_level;
end;
$$;

-- --- RLS --------------------------------------------------------------------
-- Same posture as the rest of billing: enabled with no policies, so only the
-- service-role key used by billing-api.mts can reach these rows.
alter table public.billing_stock_movements enable row level security;
alter table public.billing_pos_transaction_items enable row level security;
