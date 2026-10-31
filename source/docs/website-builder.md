# Website builder

**Status:** built, first version
**Where:** Settings › Website (owners and admins)

A business builds one public landing page out of blocks, publishes it, and
can serve it from its own domain. The booking page is built in: a "Booking"
block shows the business's Clarity booking widget on the page, and every
"Book" button points at it.

## What a coach does

1. **Pick a template.** Academy (a full page), Studio (clean, with a video),
   Performance (dark, for serious players) or Simple (one screen). The
   template is filled in with the business name, coach, venue and booking
   address, then forgotten: it is a starting point, not a mode.
2. **Edit.** Three columns: the blocks on the page (add, reorder, duplicate,
   remove), a live preview you click to select things, and the fields of
   whatever is selected. "Page and look" holds the title, the description
   search engines quote, six colour presets, two fonts, the seven colours,
   corners, button shape, page width and spacing. Header and footer are
   edited the same way.
3. **Save and publish.** Save keeps a draft nobody else sees. Publish makes
   the draft the public page. Take down removes it and keeps the draft.
4. **Where the page lives.** It is always at `https://claritygolf.app/<business>/site`
   once published. To use their own domain the coach types it (a subdomain
   such as `www.theirclub.com` is recommended), adds the two DNS records
   shown, and presses "Check DNS".

## Blocks

hero, text, image, gallery, features, pricing, testimonials, faq, cta
(call to action), video (YouTube), booking (the Clarity widget, embedded or
as a button), contact (email, phone, address, hours, optional map), divider.

Every block has an id, and `#<id>` works as a link anywhere on the page
(menu links, buttons), which is how "Lessons" in the header reaches the
pricing block. The id is shown above a block's fields in the editor.

## How it is built

| Piece | Where |
| --- | --- |
| Document shape, cleaning, fonts, theme presets, starter blocks | `netlify/functions/_shared/site/document.mts` |
| Templates | `netlify/functions/_shared/site/templates.mts` |
| Hostname rules, DNS check, Netlify attach | `netlify/functions/_shared/site/domains.mts` |
| Image uploads to the `site-media` bucket | `netlify/functions/_shared/site/media.mts` |
| Tables | `netlify/functions/_shared/site/store.mts`, migration `20261031000300_create_site_pages` |
| Routes | `netlify/functions/site.mts` |
| Renderer (editor preview and public page share it) | `src/modules/site-builder/SiteRenderer.tsx`, `site.css` |
| Editor | `src/modules/site-builder/SiteBuilderPanel.tsx`, `Inspectors.tsx`, `fields.tsx` |
| Domains panel | `src/modules/site-builder/DomainPanel.tsx` |
| Public page | `src/modules/site-builder/PublicSitePage.tsx`, routed from `src/boot.tsx` |

The document is the one shape both ends speak. The server cleans every
write with `cleanSiteDocument`: unknown block types are dropped, every link
is http(s), mailto, tel or an in-page anchor, every picture is https, every
list is capped. The same functions are imported by the browser, so the
editor cannot build something the server would refuse.

The preview is an iframe with only `site.css` and the chosen fonts inside,
so the coach app's stylesheet never touches it. React renders into it
through a portal, so it is the same component tree as the public page.

Pictures are shrunk in the browser (longest edge 1800px, WebP where the
browser can make one) before upload, land in the public `site-media`
bucket under the business's own folder, and a sweep after each save
removes uploads older than an hour that no saved page refers to.

## Custom domains

Three states, each visible in the panel:

- **pending** -- claimed. The coach is shown a TXT record
  (`_clarity-verify.<host>` = `clarity-site=<token>`) and either a CNAME to
  `clarity-golf-booking.netlify.app` (subdomains) or an A record to
  Netlify's load balancer (apex domains).
- **verified** -- both records answered, but attaching to hosting failed
  (no token, or Netlify refused). The error is shown; Check DNS retries.
- **active** -- attached. The page answers on the domain.

The TXT record is what stops business A claiming a domain that business B
pointed at Clarity: pointing proves nothing about who owns the domain, the
token does. One hostname belongs to one business (unique index).

The check reads DNS over HTTPS (Cloudflare, then Google) so the answer is
the public internet's. A provider that flattens CNAMEs is handled by
comparing the domain's A records with the target's.

**Environment.** Attaching needs `NETLIFY_API_TOKEN` (a personal access
token that may change the site; `NETLIFY_PURGE_API_TOKEN` is used if that is
unset) and `SITE_ID`, which Netlify sets. Without a token the panel says
custom domains are not switched on, and domains stop at "verified".
`SITE_NAME` (also set by Netlify) names the CNAME target.

The entry point (`src/boot.tsx`) treats any hostname that is not
`*.claritygolf.app`, `*.netlify.app`, localhost or an IP as a business's
domain, and serves only that business's page there. The server answers
`/api/site/public?host=` only for a domain in the **active** state.

## Not done yet, on purpose

- One page per business. The tables carry a `slug` so more pages can
  follow without a migration.
- The public page is drawn by the browser, like the rest of the app. Search
  engines that run JavaScript (Google does) index it; a server-rendered
  copy for the ones that do not is a follow-up.
- A booking block in the preview is a labelled box rather than the live
  widget, so editing never books anything and the preview stays light.
- Pictures pasted by address are used as given; only uploads are shrunk.
