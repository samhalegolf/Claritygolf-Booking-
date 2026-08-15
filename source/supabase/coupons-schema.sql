-- Gift vouchers ("coupons"). Run once in the Supabase project used by Clarity
-- Booking, after billing-schema.sql, pos-schema.sql and products-stock-schema.sql.
-- Every statement is additive and idempotent.
--
-- A coupon here is stored value, not a discount: someone pays for a voucher on
-- Squarespace (through Stripe) or at the counter, gets a code, and spends it
-- later. That is why it has a balance and a redemption ledger, and why it is
-- kept apart from billing_discounts - a discount preset is a label that reduces
-- a price, and nothing about it is owed to anybody.

-- --- Which catalog items are vouchers ---------------------------------------
-- Selling one of these issues a coupon rather than just taking money. The flag
-- lives on the product because that is what a Squarespace listing maps to, and
-- because guessing from the name ("...Voucher") would silently break the day
-- someone renames a product.
--
-- Note for anyone tracing the Stripe sync: syncStripeProduct upserts a partial
-- payload, so PostgREST only overwrites the columns it sends. This flag (like
-- supplier/sku/stock) survives a product resync.
alter table public.billing_products_services
  add column if not exists is_voucher boolean not null default false;

-- --- Coupons ----------------------------------------------------------------
create table if not exists public.billing_coupons (
  id text primary key,
  account_id text not null,
  -- Read over a counter and over the phone, so the generator avoids characters
  -- that get misheard or mistyped (0/O, 1/I). Stored uppercase.
  code text not null,

  status text not null default 'active'
    check (status in ('active', 'redeemed', 'void')),

  -- original_value never changes; remaining_value is what is left to spend.
  -- Keeping both means a half-spent voucher still says what it was worth.
  original_value numeric not null default 0,
  remaining_value numeric not null default 0,
  currency text not null default 'NZD',

  -- Who it belongs to, as far as we know. All optional: a voucher bought as a
  -- gift is usually redeemed by someone other than the buyer.
  issued_to_name text,
  issued_to_email text,
  customer_id text,

  -- Where it came from. 'stripe' = imported from a synced Stripe purchase,
  -- 'pos' = a voucher product sold at the till, 'manual' = issued by hand.
  source text not null default 'manual'
    check (source in ('stripe', 'pos', 'manual')),

  -- The catalog row that was sold, when there was one.
  product_id text,

  -- Dedupe key for the Stripe import: the billing_invoice_items row that paid
  -- for this voucher. Unique below, so re-running the import can never issue a
  -- second coupon for the same purchase.
  source_line_id text,
  source_invoice_id text,

  -- Null means it never expires, which is the honest default for something
  -- someone has already paid for.
  expires_at timestamptz,

  note text,
  issued_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Codes are unique per account, compared case-insensitively - nobody typing a
-- code off a printed card is going to match our capitalisation.
create unique index if not exists idx_billing_coupons_code
  on public.billing_coupons (account_id, lower(code));

-- The import's idempotency guarantee.
create unique index if not exists idx_billing_coupons_source_line
  on public.billing_coupons (account_id, source_line_id)
  where source_line_id is not null;

create index if not exists idx_billing_coupons_account
  on public.billing_coupons (account_id, status, issued_at desc);

-- --- Redemption ledger ------------------------------------------------------
-- Append-only, same reasoning as billing_stock_movements: the balance on the
-- coupon is the running total, this is the answer to "where did the rest go?".
create table if not exists public.billing_coupon_redemptions (
  id text primary key,
  account_id text not null,
  coupon_id text not null,
  -- Positive takes value off the coupon, negative puts it back (a refunded or
  -- voided sale).
  amount numeric not null,
  resulting_balance numeric,
  pos_transaction_id text,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_billing_coupon_redemptions_coupon
  on public.billing_coupon_redemptions (account_id, coupon_id, created_at desc);

-- --- POS linkage ------------------------------------------------------------
-- A sale can be part voucher, part card. coupon_amount is the slice covered by
-- the coupon; billing_pos_transactions.amount stays the full value of the sale,
-- so the takings report has to subtract one from the other to get what actually
-- went through each payment method (see posSummary in billing-api.mts).
alter table public.billing_pos_transactions
  add column if not exists coupon_id text,
  add column if not exists coupon_amount numeric not null default 0,
  -- Whether this sale's coupon value has been put back. Same compare-and-swap
  -- guard as stock_applied: a sale can go paid -> refunded -> paid and the
  -- balance must move once per hop, not once per request.
  add column if not exists coupon_reversed boolean not null default false;

-- --- Atomic balance moves ---------------------------------------------------
-- PostgREST cannot express "remaining_value = remaining_value - amount, but
-- only if there is enough left". Doing it as a read-then-write from the
-- function would let two tills spend the same voucher twice - which, unlike a
-- drifting stock count, is money out the door. The guard lives in the WHERE
-- clause of a single UPDATE.
--
-- Returns the new balance, or NULL when the coupon is missing, void, expired or
-- short. NULL is the caller's signal to refuse the sale.
create or replace function public.billing_redeem_coupon(
  p_account_id text,
  p_coupon_id text,
  p_amount numeric
) returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric;
begin
  if p_amount is null or p_amount <= 0 then
    return null;
  end if;

  update public.billing_coupons
     set remaining_value = remaining_value - p_amount,
         status = case when remaining_value - p_amount <= 0 then 'redeemed' else status end,
         updated_at = now()
   where id = p_coupon_id
     and account_id = p_account_id
     and status = 'active'
     and remaining_value >= p_amount
     and (expires_at is null or expires_at > now())
  returning remaining_value into v_balance;

  return v_balance;
end;
$$;

-- Refunding or voiding a sale puts the value back. Deliberately does not check
-- expiry: value taken off a voucher belongs to the customer, and a coupon that
-- expired between the sale and the refund must still be made whole. A fully
-- spent coupon returns to 'active'.
create or replace function public.billing_restore_coupon(
  p_account_id text,
  p_coupon_id text,
  p_amount numeric
) returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric;
begin
  if p_amount is null or p_amount <= 0 then
    return null;
  end if;

  update public.billing_coupons
     set remaining_value = remaining_value + p_amount,
         status = case when status = 'redeemed' then 'active' else status end,
         updated_at = now()
   where id = p_coupon_id
     and account_id = p_account_id
     and status <> 'void'
  returning remaining_value into v_balance;

  return v_balance;
end;
$$;

-- --- RLS --------------------------------------------------------------------
-- Same posture as the rest of billing: enabled with no policies, so only the
-- service-role key used by billing-api.mts can reach these rows.
alter table public.billing_coupons enable row level security;
alter table public.billing_coupon_redemptions enable row level security;
