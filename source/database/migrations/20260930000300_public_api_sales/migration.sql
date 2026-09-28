-- Till sales join the public API's change capture: sale.created / paid /
-- refunded / voided / updated. Same trigger as bookings, passes and invoices
-- (api_capture_change, 20260930000100_create_public_api). Sale items are not
-- captured on their own: the event carries them as they are when it is sent.
-- Re-runnable.

DROP TRIGGER IF EXISTS api_capture_billing_pos_transactions ON public.billing_pos_transactions;
CREATE TRIGGER api_capture_billing_pos_transactions
  AFTER INSERT OR UPDATE OR DELETE ON public.billing_pos_transactions
  FOR EACH ROW EXECUTE FUNCTION public.api_capture_change();
