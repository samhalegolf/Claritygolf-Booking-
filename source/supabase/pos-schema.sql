-- POS (point of sale) tables. Run once in the Supabase project used by
-- Clarity Booking, after billing-schema.sql.
--
-- These are deliberately NOT part of billing_invoices. A POS sale is money
-- taken at the counter; an invoice is a document sent to a customer. The same
-- lesson can legitimately appear in both places (a customer pays cash for a
-- lesson that was also pulled onto a monthly invoice), so POS receipts carry
-- their own number series and are never summed into invoice revenue, A/R
-- aging or the invoice reports. Keeping them in a separate table is what makes
-- that guarantee structural rather than a filter someone can forget.

-- Payment methods shown as buttons in the checkout modal. 'clarity_pay' is the
-- Stripe-backed method (there is exactly one, seeded below and not deletable
-- from the UI); 'custom' covers Cash, Eftpos, On account, Voucher, etc.
create table if not exists public.billing_payment_methods (
  id text primary key,
  account_id text not null,
  name text not null,
  kind text not null default 'custom'
    check (kind in ('clarity_pay', 'custom')),
  -- Marks the money as owed rather than received (On account). Reporting can
  -- then separate "taken at the counter" from "still to collect" without
  -- hard-coding a method name.
  settles_immediately boolean not null default true,
  sort_order integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_billing_payment_methods_account
  on public.billing_payment_methods (account_id, active, sort_order);

-- Method names only need to be unique per account.
create unique index if not exists idx_billing_payment_methods_account_name
  on public.billing_payment_methods (account_id, lower(name));

-- One row per counter sale.
--
-- amount is what was actually taken; listed_amount is what the lesson type or
-- product was priced at when the modal opened. Keeping both means a discount
-- given at the counter is visible after the fact instead of being lost.
create table if not exists public.billing_pos_transactions (
  id text primary key,
  account_id text not null,
  receipt_number text not null,
  status text not null default 'paid'
    check (status in ('pending', 'paid', 'refunded', 'void')),

  payment_method_id text,
  payment_method_name text not null,
  payment_method_kind text not null default 'custom'
    check (payment_method_kind in ('clarity_pay', 'custom')),

  description text not null,
  amount numeric not null default 0,
  listed_amount numeric,
  currency text not null default 'NZD',

  customer_id text,
  customer_name text,
  customer_email text,

  -- The calendar item this sale settles, when the sale was started from a
  -- lesson card. Nullable: counter sales and client-profile sales have no
  -- booking. Deliberately not a foreign key - billing must never be able to
  -- block or cascade a booking delete.
  booking_id text,

  -- Where the sale was started from, for reporting.
  source text not null default 'counter'
    check (source in ('lesson', 'client', 'counter')),

  stripe_session_id text,
  stripe_payment_intent_id text,

  note text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Receipt numbers only need to be unique per account. This is the POS series
-- (POS-0001...), completely independent of billing_invoices.invoice_number.
create unique index if not exists idx_billing_pos_transactions_account_receipt
  on public.billing_pos_transactions (account_id, receipt_number);

create index if not exists idx_billing_pos_transactions_account_created
  on public.billing_pos_transactions (account_id, created_at desc);

-- Drives the "paid at POS" lookup on lesson cards and the invoice pull list.
create index if not exists idx_billing_pos_transactions_account_booking
  on public.billing_pos_transactions (account_id, booking_id)
  where booking_id is not null;

create index if not exists idx_billing_pos_transactions_session
  on public.billing_pos_transactions (stripe_session_id)
  where stripe_session_id is not null;

alter table public.billing_payment_methods enable row level security;
alter table public.billing_pos_transactions enable row level security;

-- billing-api.mts has always written billing_invoices.tax_inclusive, but
-- billing-schema.sql never declared it, so a project provisioned from that
-- file alone would reject every invoice insert. Adding it here (idempotent)
-- alongside the matching column in billing-schema.sql.
alter table public.billing_invoices
  add column if not exists tax_inclusive boolean not null default false;
