-- Messages sent through a website's contact form.
--
-- The form block emails each message to the business's contact address and
-- keeps a copy here, so a message is never only an email that may not have
-- arrived. Strangers write these rows through the public form route; nothing
-- in the browser reads the table.
--
-- Re-runnable.

CREATE TABLE IF NOT EXISTS public.site_form_messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  page_slug TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  emailed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_site_form_messages_account
  ON public.site_form_messages (account_id, created_at DESC);

ALTER TABLE public.site_form_messages ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
