-- Run this once in the Supabase project used by Clarity Booking before
-- deploying the billing-api Netlify function.
--
-- These tables are intentionally separate from booking-schema.sql. Billing
-- reads completed bookings (calendar_items) but does not own booking logic,
-- and booking/calendar tables must not depend on anything in this file.

create table if not exists public.billing_products_services (
  id text primary key,
  account_id text not null,
  name text not null,
  kind text not null default 'service'
    check (kind in ('service', 'product', 'package', 'lesson-type')),
  description text,
  default_price numeric not null default 0,
  tax_rate numeric not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_billing_products_services_account
  on public.billing_products_services (account_id, active);

create table if not exists public.billing_invoices (
  id text primary key,
  account_id text not null,
  invoice_number text not null,
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'paid', 'overdue', 'void')),
  customer_id text,
  customer_name text not null,
  customer_email text,
  customer_phone text,
  issue_date date not null default current_date,
  due_date date,
  currency text not null default 'NZD',
  subtotal numeric not null default 0,
  tax_total numeric not null default 0,
  discount_total numeric not null default 0,
  discount_label text,
  total numeric not null default 0,
  amount_paid numeric not null default 0,
  customer_note text,
  internal_note text,
  reference text,
  sent_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Invoice numbers only need to be unique per account, not globally.
create unique index if not exists idx_billing_invoices_account_number
  on public.billing_invoices (account_id, invoice_number);

create index if not exists idx_billing_invoices_account_status
  on public.billing_invoices (account_id, status, issue_date desc);

create table if not exists public.billing_invoice_items (
  id text primary key,
  invoice_id text not null references public.billing_invoices (id) on delete cascade,
  account_id text not null,
  source_type text not null default 'manual'
    check (source_type in ('booking', 'product', 'manual')),
  source_id text,
  description text not null,
  quantity numeric not null default 1,
  unit_price numeric not null default 0,
  tax_rate numeric not null default 0,
  tax_amount numeric not null default 0,
  discount_amount numeric not null default 0,
  line_total numeric not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_billing_invoice_items_invoice
  on public.billing_invoice_items (invoice_id);

-- Prevents the same completed booking from being invoiced twice: inserting a
-- second link for a booking_id already scoped to this account fails with a
-- unique-violation, which billing-api.mts turns into a 409 the UI can read as
-- "already invoiced".
create table if not exists public.billing_booking_invoice_links (
  id text primary key,
  account_id text not null,
  booking_id text not null,
  invoice_id text not null references public.billing_invoices (id) on delete cascade,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_billing_booking_invoice_links_booking
  on public.billing_booking_invoice_links (account_id, booking_id);

create index if not exists idx_billing_booking_invoice_links_invoice
  on public.billing_booking_invoice_links (invoice_id);

alter table public.billing_products_services enable row level security;
alter table public.billing_invoices enable row level security;
alter table public.billing_invoice_items enable row level security;
alter table public.billing_booking_invoice_links enable row level security;
