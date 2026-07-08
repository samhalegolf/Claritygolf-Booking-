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

-- Discount presets (10%, $20, Member, Family, Package credit, etc). Kept out
-- of the default invoice flow - these are picked from an optional preset
-- list, not required to create an invoice.
create table if not exists public.billing_discounts (
  id text primary key,
  account_id text not null,
  name text not null,
  discount_type text not null default 'fixed'
    check (discount_type in ('percentage', 'fixed')),
  value numeric not null default 0,
  coupon_code text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_billing_discounts_account
  on public.billing_discounts (account_id, active);

-- Coupon codes only need to be unique per account, and only when set.
create unique index if not exists idx_billing_discounts_account_coupon
  on public.billing_discounts (account_id, lower(coupon_code))
  where coupon_code is not null and btrim(coupon_code) <> '';

-- Expense categories (Coaching supplies, Range fees, Travel, Software,
-- etc). Presets only, same pattern as billing_discounts - picked from a
-- dropdown when logging an expense, not required to log one ("Uncategorised"
-- is always a valid choice in the UI).
create table if not exists public.billing_expense_categories (
  id text primary key,
  account_id text not null,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_billing_expense_categories_account
  on public.billing_expense_categories (account_id, active);

create unique index if not exists idx_billing_expense_categories_account_name
  on public.billing_expense_categories (account_id, lower(name));

-- Expense records. Not linked to invoices/bookings - this is simple outgoing
-- spend tracking (what the coach paid for), not cost-of-goods-sold against a
-- specific invoice line. category_id is nullable and not a foreign key
-- on delete cascade on purpose: deactivating or renaming a category must
-- never delete historical expense records.
create table if not exists public.billing_expenses (
  id text primary key,
  account_id text not null,
  category_id text,
  category_name_snapshot text,
  description text not null,
  vendor text,
  amount numeric not null default 0,
  currency text not null default 'NZD',
  expense_date date not null default current_date,
  note text,
  voided boolean not null default false,
  -- Set only by bank-CSV import: either the bank's own transaction
  -- reference (when the export has one) or a hash of date+description+
  -- amount. Lets re-importing the same file, or an export with an
  -- overlapping date range, skip rows it's already seen instead of
  -- double-counting them. Manually-logged expenses leave this null.
  external_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_billing_expenses_account_external_ref
  on public.billing_expenses (account_id, external_ref)
  where external_ref is not null and btrim(external_ref) <> '';

create index if not exists idx_billing_expenses_account_date
  on public.billing_expenses (account_id, expense_date desc);

create index if not exists idx_billing_expenses_category
  on public.billing_expenses (category_id);

alter table public.billing_products_services enable row level security;
alter table public.billing_invoices enable row level security;
alter table public.billing_discounts enable row level security;
alter table public.billing_invoice_items enable row level security;
alter table public.billing_booking_invoice_links enable row level security;
alter table public.billing_expense_categories enable row level security;
alter table public.billing_expenses enable row level security;
