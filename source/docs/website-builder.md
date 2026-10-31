# Website builder

**Status:** built, first version
**Where:** Settings › Website (owners and admins)

A business builds a public website out of pages and blocks, publishes it,
and can serve it from its own domain. The booking page and the shop are
built in: a "Booking" block shows the business's Clarity booking widget on
a page, a "Shop" block sells its packages and gift vouchers in the site's
own look, and every "Book" button can point at the site's own Book page.

## What a coach does

1. **Pick a template.** Academy (a full home page), Studio (clean, with a
   video), Performance (dark, for serious players) or Simple (one screen).
   Every template also makes a Book page (the booking widget), and all but
   Simple an About and a Find us page. The template is filled in with the
   business name, coach, venue and booking address, then forgotten: it is a
   starting point, not a mode.
2. **Add pages.** Add page offers presets: Blank, About, Find us, Lessons &
   prices, Booking page, Shop, Articles (an index that lists article pages,
   newest first), Article, Gallery. Each page has a name in the menu, an
   address (`/about`), a description for search engines, and a "Show in the
   menu" switch. The header menu is built from the pages in order; the home
   page stays first and cannot be removed.
3. **Edit.** At rest the tab shows the pages across the top and the chosen
   one drawn full width. Edit takes the whole pane: pages and the blocks on
   the chosen page (add, reorder, duplicate, remove), a live preview you
   click to select things (click a menu link to move to that page), and the
   fields of whatever is selected. "Look" (colours, fonts, shapes), Header
   and Footer are site-wide. Buttons and links can point at a page of the
   site, the Clarity booking page, or any address.
4. **Save and publish.** Save keeps a draft of the whole site nobody else
   sees. Publish makes every page public at once. Take down removes it all
   and keeps the drafts.
5. **Where the site lives.** Home is at `https://claritygolf.app/<business>/site`
   and every other page under it (`…/site/about`). On the coach's own
   domain, home is `/` and pages are `/about`. To use their own domain the
   coach types it (a subdomain such as `www.theirclub.com` is recommended),
   adds the two DNS records shown, and presses "Check DNS".

## The shop, from the site

A Shop block (or the Shop page preset) sells what the business already
sells: packages are the lesson types marked sellable, vouchers are the
products ticked as vouchers under Billing. In "cards" mode the items are
drawn in the site's own look and the order is taken on the page: the buyer
fills in name and email (and for a voucher, who it is for), pays on
Stripe's page, and lands back on the same page, where the order id in the
address is confirmed with the server and the receipt and any voucher code
shown. In "embed" mode Clarity's own shop page is framed instead.

The block's inspector is where the coach edits the shop: the switch that
opens it, what is on the shelf with prices, and why it is closed if it is
(no card payments, nothing for sale). Prices and contents are still set
where the items live. The server side is unchanged: the block calls the
same `/api/public-shop` routes as the shop page, with one addition, a
same-origin `returnPath` so the buyer comes back to the site rather than to
Clarity's shop page.

## Blocks

hero, text, image, gallery, features, pricing, testimonials, faq, cta
(call to action), video (YouTube), booking (the Clarity widget, embedded or
as a button), shop (packages and vouchers, bought on the page), articles
(the site's article pages as cards), contact (email, phone, address, hours,
optional map), divider.

Every block has an id, and `#<id>` works as a link anywhere on the page
(menu links, buttons), which is how "Lessons" in the header reaches the
pricing block. The id is shown above a block's fields in the editor.

## How it is built

| Piece | Where |
| --- | --- |
| Site settings and page shapes, cleaning, fonts, theme presets, starter blocks, page presets | `netlify/functions/_shared/site/document.mts` |
| Templates (a whole starting site) | `netlify/functions/_shared/site/templates.mts` |
| Hostname rules, DNS check, Netlify attach | `netlify/functions/_shared/site/domains.mts` |
| Image uploads to the `site-media` bucket | `netlify/functions/_shared/site/media.mts` |
| Tables | `netlify/functions/_shared/site/store.mts`, migrations `20261031000300_create_site_pages` and `20261031000400_site_multiple_pages` |
| Routes | `netlify/functions/site.mts` |
| Renderer (editor preview and public page share it) | `src/modules/site-builder/SiteRenderer.tsx`, `site.css` |
| Editor | `src/modules/site-builder/SiteBuilderPanel.tsx`, `Inspectors.tsx`, `fields.tsx` |
| Shop block | `src/modules/site-builder/ShopBlock.tsx` |
| Domains panel | `src/modules/site-builder/DomainPanel.tsx` |
| Public page | `src/modules/site-builder/PublicSitePage.tsx`, routed from `src/boot.tsx` |

`sites` holds the parts every page shares (theme, header, footer), one row
per business; `site_pages` holds one row per page (address, title, kind,
whether it sits in the menu, order) with its blocks in `document`. Both
have a draft and a published copy; Publish copies every draft at once and
stamps each page's meta into its published copy, so a title changed
afterwards stays private until the next publish. The public read serves
published copies only.

The settings and page shapes are the ones both ends speak. The server
cleans every write with `cleanSiteSettings` and `cleanSitePageContent`:
unknown block types are dropped, every link is http(s), mailto, tel, an
in-page anchor or a page of the site (`page:<slug>`), every picture is
https, every list is capped, and a page's address can never be one of the
paths Clarity itself answers at. The same functions are imported by the
browser, so the editor cannot build something the server would refuse.

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
domain, and serves only that business's site there: `/` is home and
`/<page>` any other page. The server answers `/api/site/public?host=` only
for a domain in the **active** state. Moving between pages fetches the
next one and swaps it in without a reload; Back and Forward work.

## Not done yet, on purpose

- The public page is drawn by the browser, like the rest of the app. Search
  engines that run JavaScript (Google does) index it; a server-rendered
  copy for the ones that do not is a follow-up.
- A booking block in the preview is a labelled box rather than the live
  widget, so editing never books anything and the preview stays light.
- Pictures pasted by address are used as given; only uploads are shrunk.
