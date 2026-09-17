-- A pass bought through Stripe is a source the column cannot yet name.
--
-- The Pass Inbox reads Stripe purchases now as well as Optix ones, so a
-- package bought on the booking site can be issued from the same queue. Every
-- other source in this list is already there; 'stripe' is the one that was
-- missing, because until now nothing read Stripe purchases at all.
--
-- WHY NOT REUSE 'clarity_checkout'
--
-- Because it would be a lie that costs somebody an afternoon. clarity_checkout
-- means the buyer went through Clarity's own checkout, which knows the person,
-- the service and the price before the money moves. A Stripe line is the
-- opposite: a description, an amount, and a customer email that may or may not
-- be a client. When a pass is later queried -- "where did this come from, and
-- can I trust the person it is attached to" -- the source is the whole answer,
-- and those two sources deserve different answers.
--
-- WHY NOT 'stripe_subscription'
--
-- That one already means something narrower and load-bearing: a recurring
-- entitlement that stays funded only while the subscription is paid. A one-off
-- voucher or package sale has no such thread, and folding it in would make
-- "is this still being paid for" unanswerable for the rows that matter.
--
-- Both constraints are widened together. pass_allocations carries its own copy
-- of the source so a later top-up lot can say where *it* came from, and a
-- constraint pair that drifts fails at the second allocation rather than the
-- first -- long after the code that caused it shipped.

ALTER TABLE public.passes
  DROP CONSTRAINT IF EXISTS passes_source_check;

ALTER TABLE public.passes
  ADD CONSTRAINT passes_source_check CHECK (source IN (
    'manual',
    'clarity_pos',
    'clarity_invoice',
    'clarity_checkout',
    'optix',
    'stripe',
    'stripe_subscription',
    'promotion'
  ));

ALTER TABLE public.pass_allocations
  DROP CONSTRAINT IF EXISTS pass_allocations_source_check;

ALTER TABLE public.pass_allocations
  ADD CONSTRAINT pass_allocations_source_check CHECK (source IN (
    'manual',
    'clarity_pos',
    'clarity_invoice',
    'clarity_checkout',
    'optix',
    'stripe',
    'stripe_subscription',
    'promotion'
  ));

COMMENT ON COLUMN public.passes.source IS
  'Where the entitlement came from, and what keeps it funded. Deliberately one column rather than a separate funding_type: a Stripe subscription is a source like any other and must not need its own read path. ''stripe'' is a one-off Stripe purchase confirmed through the Pass Inbox -- a description and an amount, not a checkout that knew who was buying.';
