-- Clarity's own websites, built with the same website builder coaches use.
--
-- A site belongs to an account, so each of Clarity's public sites is an
-- account of its own, of kind 'house'. A house account is not a business:
-- nobody holds a membership on it, it has no booking page (public account
-- resolution only answers for 'live' and 'sandbox'), and the jobs that walk
-- every business only ever read kind = 'live'. Its site is edited from Clarity
-- Studio, through /api/studio-sites, by a Studio admin.
--
--   clarity-caddy     the Clarity Caddy site: the app's landing page, how it
--                     works, and the privacy, terms, support and account
--                     deletion pages the app stores link to.
--   clarity-booking   the Clarity Golf Booking site: the home page and the
--                     privacy, terms and support pages at the root of
--                     claritygolf.app.
--
-- Re-runnable.

INSERT INTO public.accounts (id, slug, business_name, status, kind)
VALUES
  ('clarity-caddy', 'clarity-caddy', 'Clarity Caddy', 'active', 'house'),
  ('clarity-booking', 'clarity-booking', 'Clarity Golf Booking', 'active', 'house')
ON CONFLICT (id) DO UPDATE SET kind = 'house';

NOTIFY pgrst, 'reload schema';
