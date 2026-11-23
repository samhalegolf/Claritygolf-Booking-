-- Digital products: the files a download hands over.
--
-- A product sold as a download used to carry one pasted link (download_url),
-- public to anyone it was forwarded to. It now carries the files themselves:
-- an ebook's PDF and EPUB, uploaded by the coach into a private storage
-- bucket and handed only to a paid order, by email and by a link that checks
-- the order each time it is opened.
--
--   download_files   what the product hands over, as a JSON list of
--                    { path, name, bytes }: where the file is in the bucket,
--                    its name as the buyer downloads it, and its size.
--   shop-downloads   the bucket. Private: nothing in it has a public address.
--                    Where this role may not write to storage.buckets, the
--                    function makes the bucket on the first upload.
--
-- download_url is no longer read or written. It is left in place here because
-- the functions still running while this deploy builds select it by name; a
-- later migration drops it. No product had one set.
--
-- Re-runnable.

ALTER TABLE public.billing_products_services
  ADD COLUMN IF NOT EXISTS download_files JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  INSERT INTO storage.buckets (id, name, public, file_size_limit)
  VALUES ('shop-downloads', 'shop-downloads', false, 104857600)
  ON CONFLICT (id) DO UPDATE
    SET public = EXCLUDED.public,
        file_size_limit = EXCLUDED.file_size_limit;
EXCEPTION
  WHEN insufficient_privilege OR undefined_table THEN
    RAISE NOTICE 'shop-downloads bucket not created here (%); the functions create it on first use', SQLERRM;
END
$$;

NOTIFY pgrst, 'reload schema';
