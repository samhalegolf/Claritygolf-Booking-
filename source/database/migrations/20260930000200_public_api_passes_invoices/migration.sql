-- Passes and invoices join the public API's change capture.
--
-- Same trigger as bookings and clients (api_capture_change, from
-- 20260930000100_create_public_api): one api_change_log row per change, in the
-- same transaction as the change, never able to block it.
--
--   passes             pass.created / pass.voided / pass.updated
--   pass_allocations   credits added to a pass    -> pass.updated
--   pass_redemptions   credits spent / given back -> pass.redeemed / pass.updated
--   billing_invoices   invoice.created / sent / paid / voided / updated / deleted
--
-- Invoice lines are not captured on their own: every line change also
-- rewrites the invoice's totals, and the event carries the lines as they are
-- when it is sent. Re-runnable.

DROP TRIGGER IF EXISTS api_capture_passes ON public.passes;
CREATE TRIGGER api_capture_passes
  AFTER INSERT OR UPDATE OR DELETE ON public.passes
  FOR EACH ROW EXECUTE FUNCTION public.api_capture_change();

DROP TRIGGER IF EXISTS api_capture_pass_allocations ON public.pass_allocations;
CREATE TRIGGER api_capture_pass_allocations
  AFTER INSERT OR UPDATE OR DELETE ON public.pass_allocations
  FOR EACH ROW EXECUTE FUNCTION public.api_capture_change();

DROP TRIGGER IF EXISTS api_capture_pass_redemptions ON public.pass_redemptions;
CREATE TRIGGER api_capture_pass_redemptions
  AFTER INSERT OR UPDATE OR DELETE ON public.pass_redemptions
  FOR EACH ROW EXECUTE FUNCTION public.api_capture_change();

DROP TRIGGER IF EXISTS api_capture_billing_invoices ON public.billing_invoices;
CREATE TRIGGER api_capture_billing_invoices
  AFTER INSERT OR UPDATE OR DELETE ON public.billing_invoices
  FOR EACH ROW EXECUTE FUNCTION public.api_capture_change();
