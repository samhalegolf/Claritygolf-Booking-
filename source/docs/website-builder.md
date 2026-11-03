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
3. **Edit, the Squarespace way.** The editor is laid out like Squarespace,
   because that is the workflow coaches already know. "Edit site" opens the
   Pages panel: Main navigation and Not linked, each page with a gear for
   its settings (name, address, search and sharing, kind), "+" to add a
   page, and Site styles, Site header and Footer. The chosen page is drawn
   beside it. **Edit** puts the page itself in edit mode: words are typed
   over where they stand (headings, paragraphs, item titles, quotes,
   captions); every section has **Add section** above and below it and a
   toolbar to edit, move, duplicate or remove it; the header and footer each
   have an edit button. Add section opens a gallery of ready-made layouts
   by category (`sectionLibrary.tsx`), each one of the blocks below with a
   few settings chosen. Edit section opens its **Content** and **Design**
   tabs; Design is the section style. **Site styles** is the look of every
   page. Buttons and links can point at a page of the site, the Clarity
   booking page, or any address.
4. **Save goes live.** As on Squarespace, Save on a site that is already
   public puts the changes live at once (`PUT /api/site/site` with
   `live: true` saves, then publishes). A site that has never been public is
   saved privately until **Make site public**. A whole new site (a template,
   an import) is saved without going live, and the bar says "Changes not
   live yet" until Save. Exit with unsaved changes asks whether to discard
   them. "Take the site offline" (in the ... menu) removes it all and keeps
   the pages.
5. **Where the site lives.** Home is at `https://claritygolf.app/<business>/site`
   and every other page under it (`…/site/about`). On the coach's own
   domain, home is `/` and pages are `/about`. To use their own domain the
   coach types it (a subdomain such as `www.theirclub.com` is recommended),
   adds the two DNS records shown, and presses "Check DNS".

## The shop, from the site

A Shop block (or the Shop page preset) sells what the business already
sells: packages are the lesson types marked sellable, vouchers are the
products ticked as vouchers under Billing, and goods are the products
ticked "Sell on your website" under Billing › Products. A product there
gets a picture (uploaded to the site's bucket), how it reaches the buyer
(collected, posted or downloaded), a download link, and options one per
line ("Large = 45" prices an option on its own; the rest sell at the
product's price). Stock, when the product counts it, is shared across its
options and a product with none left shows as sold out rather than
vanishing.

In "cards" mode the shelf is drawn in the site's own look and the order is
a cart: the visitor adds things (the cart is kept in the browser, one per
business, and the header's bag icon shows the count), gives a name and
email (and for a voucher, who it is for), pays on Stripe's page, and lands
back on the same page, where the order id in the address is confirmed with
the server and the receipt shown: voucher codes, download links, and where
it is being posted. When something in the order is posted, Stripe's page
collects the delivery address and the shop's flat shipping fee is added
once; the address is kept on the sale (Billing › Sales shows it) and the
business is emailed the order to post or have ready. In "embed" mode
Clarity's own shop page is framed instead.

The buyer is emailed a receipt too. When the order has a voucher in it,
that email is the "Gift voucher" template under Settings › Templates
(subject, headline, message and sign-off are the coach's; the codes and
receipt are filled in). Beside it is the gift card designer: the coach
uploads artwork (kept as JPEG or PNG, which is all a PDF takes) and drags
the recipient's name, the code and the value onto it. Each order's cards
are then made as one PDF, a page per voucher, and attached
(`_shared/gift-card-pdf.mts`). No artwork, no attachment; the codes are in
the email either way.

A voucher product says what its vouchers are for (Billing › Products):
an amount, or one lesson type or product. A voucher for an item still
carries the money paid for it, and while none of it is spent it pays for
that item at the till at whatever it costs on the day
(`_shared/voucher-redemption.mts`, read by the till and the server alike).
A price rise is absorbed; a price drop's surplus goes to the client's
account credit (one balance per client, a `billing_coupons` row of kind
`credit`), or stays on the voucher when the sale names no saved client.
Spent on anything else, it is money. The product can leave the value off
the gift card, and can set an expiry in months from purchase. The card's
"What it's for" field prints the item's name on those vouchers.

Product pictures and the gift card artwork share the site's bucket, so the
sweep that tidies the bucket after a site save keeps them as well as the
pictures on pages (`siteImageUrlsInUse`).

The block's inspector is where the coach edits the shop: the switch that
opens it, the shipping fee, what is on the shelf with prices, and why it is
closed if it is (no card payments, nothing for sale). Prices and contents
are still set where the items live. The block calls the same
`/api/public-shop` routes as the shop page, with one addition, a
same-origin `returnPath` so the buyer comes back to the site rather than to
Clarity's shop page. An order is one till sale with several lines, priced
on the server off the shelf, never off the request.

## Free layout

A free layout section (`canvas`) holds pieces placed anywhere, the way
Squarespace's Fluid Engine works: text (six sizes, from a big heading to
small text), pictures, buttons and shapes. Each piece covers cells of a grid
24 columns across the content width and rows of 16px, and later pieces are
drawn over earlier ones. Any piece can have a background from the site's own
colours and square, rounded, pill or circle (oval, when the box is not
square) corners; a picture fills its box and can link somewhere.

In edit mode (`CanvasBlock.tsx`): press and drag a piece to move it, pull any
of its eight handles to stretch it, pull the bar under the section to make
the section taller or shorter, double-click words to type over them, and use
the arrow keys to nudge (Shift for four cells) and Delete to remove. The
picked piece has a toolbar to edit it in the side panel, bring it forward,
send it back, duplicate or remove it. The bar under the section adds a
heading, text, a picture, a button or a shape, below everything already
there. Every move snaps to the grid and is written once, on letting go. The
section grows to hold a piece dragged below it. The grid maths is in
`canvasLayout.ts`.

On a phone the pieces stack in reading order (top to bottom, then left to
right); pictures and shapes keep their height in rows. In the phone preview
pieces can be picked and edited but not dragged.

**Add section is templates of pieces.** The plain layouts in the gallery
(Intro, Text, the single pictures, Call to action, and an empty one) are
free layouts with pieces already placed; once on the page each piece is
moved, added and removed on its own. Sections that draw something live
(lists, reviews, booking, shop, articles, forms, maps) stay blocks of their
own. A hero, text, call to action or picture section made before this (by a
template or the Squarespace import) has an "Arrange freely" button on its
toolbar that turns it into a free layout with the same words, buttons,
picture, id and style.

## Blocks

canvas (the free layout, above), hero, text, image, gallery (with an optional button), features, cards (a
picture, heading, line and button each, 2 to 4 across), logos (small
pictures in a row, a caption each, for certifications and partners),
pricing, testimonials (with a picture or screenshot per review and an
optional button), faq, cta (call to action), video (YouTube), embed
(another website's form, map or player in a frame, https only), booking
(the Clarity widget, embedded or as a button), venues (each place the
coach works, side by side: map, hours, a line, and either a Clarity
booking screen or another system's framed page), form (a message to the
business), shop (packages and vouchers, bought on the page), articles
(the site's article pages as cards), videos (the site's video pages, as a
grid or a list, each with its cover or YouTube's own picture), instagram
(a hand-picked grid of posts with a Follow button; Instagram's own feed
needs an app review, so the pictures are the coach's), contact (email,
phone, address, hours, optional map), divider.

A hero's picture, and an image block's, can be cut to a shape: left as
it is, deep rounded corners, or a circle.

In the editor the pages are a tree: a page sits inside the nearest page up
its address ("articles/tips" inside "articles"), and an article or video
with no such page sits inside the page that lists it. The page strip shows
the pages at the top, with the pages inside the one being edited on a row
beneath; the outline lists them the same way. A page moves only among the
pages beside it, and a new article or video is given an address under the
page that lists it.

Pages come in three kinds. An article and a video both carry a date, a
summary and a cover for the index that lists them; a video page also has
a YouTube link, played above its blocks.

Every block has an id, and `#<id>` works as a link anywhere on the page
(menu links, buttons), which is how "Lessons" in the header reaches the
pricing block. The id is shown above a block's fields in the editor.

### Section style

Every block carries a section style, edited on the Design tab of its
Edit section panel. Colours: same as the
page, a light panel (the theme's surface colour), white, dark (the text
colour as background, white text) or accent (the primary colour). A
picture or a muted, looping video can sit behind the block, darkened by a
chosen amount; text over a backdrop is white unless the block is light or
white, which lighten the backdrop instead. A light or white panel on a
dark site gets dark words. Height sets a minimum (small, medium, large),
content width can override the theme's for that one block, and the top
edge can carry a wave in the button colour over the join with the block
above. A plain style adds nothing to the markup, so untouched blocks
render as before. The theme has a heading colour of its own (the text
colour unless a preset or the coach picks another), applied to the large
headings; the Ember preset is slate with light-blue text and orange
headings, the look of samhalegolf.com.

The header can be transparent: it sits over the first block with no
background of its own, in light text when that block is dark, and scrolls
away with it (a transparent header is never sticky). The header and
footer can carry social links (Instagram, Facebook, YouTube, TikTok, X,
LinkedIn), drawn as icons. The header can also show a bag icon with the
visitor's cart count, opening the page the coach picks (the one with the
Shop block), and an announcement strip above it with a line and a link.

### The contact form

A form block takes a name, email, optional phone and a message. The
server keeps it in `site_form_messages` and emails it to the business's
contact address (Settings › Business), falling back to the notification
address, with reply-to set to the visitor. A hidden field no person sees
catches bots: when it is filled the request is answered ok and dropped.

## Templates

Five starting sites: Classic, Academy, Studio, Performance and Pro. Pro is
modelled on a working coaching site (samhalegolf.com): a transparent
header over a profile hero, what is offered as four cards, reviews on a
dark band, certifications as logos, an Instagram grid; then a Book
page of venues with maps and booking side by side, Group Coaching,
Articles, Videos, Shop (with the bag icon in the header) and Contact
(with the form). It uses the "Ember" theme
preset (orange on white, Manrope and Poppins). A "Book a lesson (venues)"
page preset adds the venues page to any site.

## Clarity's own sites (house sites)

There is one website builder, and Clarity's own public sites are built with
it too: a change to the builder reaches every coach's site and Clarity's at
once. Each Clarity site is an account of kind `house` (migration
`20261102000200_house_sites`):

| Site | What it is | Where it is served |
| --- | --- | --- |
| `clarity-caddy` | The Clarity Caddy site: home, How it works, and the privacy, terms, support and account deletion pages the app stores link to. Replaces the `clarity-golf-landing` and `getclaritycaddy` repos and Caddy's static legal pages. | Its own domain, attached under "Where the page lives" like any coach's; meanwhile `claritygolf.app/clarity-caddy/site`. |
| `clarity-booking` | The Clarity Golf Booking site. | Home at `claritygolf.app/`, and Privacy, Terms and Support at `/privacy`, `/terms`, `/support`. Any other page at `claritygolf.app/clarity-booking/site/<page>`. Until it is first published, the hand-drawn `public-site/PublicSite.tsx` stands in. |

A house account is not a business. Nobody holds a membership on it, it has
no booking page (public account resolution answers only for `live` and
`sandbox`), and the jobs that walk every business read `kind = 'live'`. Its
editor offers no Booking, Venues or Shop blocks and none of the presets built
on them, the link picker has no "Clarity booking page", and the template
chooser offers only the site's own starting template
(`_shared/site/house-templates.mts`, written from the pages it replaced).

**Edited from Clarity Studio.** Studio's Marketing › Websites page (Caddy
repo, `scripts/studio/marketing/websites-page.js`) frames
`claritygolf.app/studio-sites` (`StudioSitesPage.tsx`), which picks a house
site and mounts the ordinary `SiteBuilderPanel` pointed at
`/api/studio-sites` (`setSiteEditorTarget` in `siteApi.ts`). The routes are
the coach's routes, run by the same `editorAction` in `site.mts`; only who is
asking differs. There is no Booking session in the frame: it asks Studio for
a Studio pass, which Caddy's `functions/studio-site-pass.mjs` signs once the
admin's own login is proved, with the service secret both deploys already
hold (`CLARITY_SERVICE_SECRET`). Booking checks the signature, audience and
expiry (`_shared/site/house.mts`) and the pass reaches house sites only. The
two repositories share no code, so both test the same fixed pass
(`house.test.mts` here, `dev/studio-site-pass.test.js` there).

Caddy reads `CLARITY_BOOKING_URL` (default `https://claritygolf.app`) to know
where to frame.

## Bringing a site over from Squarespace

Under the template chooser, "Or bring over a site you already have"
takes the old site's address and a look. The importer
(`netlify/functions/_shared/site/import-squarespace.mts`, route
`POST /api/site/import`) reads the sitemap, then every page twice: its
`?format=json` (the collection, and for a blog post or video lesson the
item with its body, date, summary, picture and search settings) and its
HTML (the title and meta tags, and for a plain page its sections, which
Squarespace 7.1 keeps out of the JSON). Each page becomes a page at the
same address, nested where the old one was ("articles/how-to-practice"),
so old links and search results keep working: blog posts as articles,
video lessons as video pages with the YouTube id read from the page, the
blog index as an Articles block, the video library as a Videos block, the
store as a Shop block, and a plain page's sections as blocks chosen by
their shape (a hero, cards, a logo row, review screenshots, an Instagram
grid, venues with hours and a booking frame each, a contact block, text
and pictures; a picture Squarespace cut to a shape keeps its rounded
corners). The business's own Clarity booking frames become Booking
blocks; any other frame an Embed. The pages are read a few at a time so
the call stays short; the pictures are then brought into the site's bucket
in batches of six (`POST /api/site/import/pictures`), each a short call of
its own, and swapped into every page, so the site outlives the old one.
The old header's
menu order, social links and button carry over. What could not be placed
is reported, never invented, and the result replaces the draft without
publishing anything.

## Page addresses, titles and sharing

A page's address may be nested up to three parts deep. Every page has a
search title (empty: the page's name and the business's), a description
and a sharing picture (empty: the cover, the video's thumbnail, or the
logo). The browser sets these when the page loads; for crawlers and link
previews that do not run JavaScript, the edge function
`netlify/edge-functions/site-meta.ts` reads the public API for any site
page and writes the title, description, Open Graph tags and canonical
link into the served HTML. On a business's own domain, `/sitemap.xml`
lists its published pages (`GET /api/site/public/sitemap`).

## Embeds and the live preview

An embed block, and a venue's "other booking system" field, take an
https address or pasted embed code. An `<iframe>` snippet gives up its
address and height; anything else (a script, a widget) is kept as code
and drawn in a sandboxed frame of its own with no origin, so it can draw
and talk to its servers but never read the page or its visitor's cookies.
The editor's preview shows the real booking page, shop, map and embeds,
inert: a click lands on the block, not inside the frame.

## How it is built

| Piece | Where |
| --- | --- |
| Site settings and page shapes, cleaning, fonts, theme presets, starter blocks, page presets | `netlify/functions/_shared/site/document.mts` |
| Templates (a whole starting site) | `netlify/functions/_shared/site/templates.mts` |
| Hostname rules, DNS check, Netlify attach | `netlify/functions/_shared/site/domains.mts` |
| Image uploads to the `site-media` bucket | `netlify/functions/_shared/site/media.mts` |
| Tables | `netlify/functions/_shared/site/store.mts`, migrations `20261031000300_create_site_pages`, `20261031000400_site_multiple_pages`, `20261031000500_site_form_messages` and `20261101000100_site_video_pages` |
| Routes | `netlify/functions/site.mts` |
| Renderer (editor preview and public page share it) | `src/modules/site-builder/SiteRenderer.tsx`, `site.css` |
| Editor | `src/modules/site-builder/SiteBuilderPanel.tsx`, `Inspectors.tsx`, `fields.tsx` |
| Section gallery (Add section) | `src/modules/site-builder/sectionLibrary.tsx` |
| Free layout: drawing and arranging, grid maths | `src/modules/site-builder/CanvasBlock.tsx`, `canvasLayout.ts`, side panel in `Inspectors.tsx` (`CanvasFields`) |
| Editing on the page: typed-over words, section toolbars | `SiteRenderer.tsx` (`editor` prop, `EditableText`), `blockText.ts`, `site-edit.css` (preview frame only) |
| Shop block and the visitor's cart | `src/modules/site-builder/ShopBlock.tsx`, `siteCart.ts` |
| The shelf, carts and orders (shared with the shop page) | `netlify/functions/_shared/online-shop.mts`, routes in `billing-api.mts`, migration `20261031000600_online_store` |
| Contact form block | `src/modules/site-builder/FormBlock.tsx` |
| Section style to CSS variables | `src/modules/site-builder/siteTheme.ts` |
| Domains panel | `src/modules/site-builder/DomainPanel.tsx` |
| Public page | `src/modules/site-builder/PublicSitePage.tsx`, routed from `src/boot.tsx` |
| Meta tags for crawlers, sitemap on a custom domain | `netlify/edge-functions/site-meta.ts` |
| Squarespace import | `netlify/functions/_shared/site/import-squarespace.mts` |
| Clarity's own sites: house accounts, the Studio pass | `netlify/functions/_shared/site/house.mts` |
| Clarity's own sites' starting content | `netlify/functions/_shared/site/house-templates.mts` |
| The builder inside Clarity Studio | `src/modules/site-builder/StudioSitesPage.tsx`, routed from `src/boot.tsx` at `/studio-sites` |

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
paths Clarity itself answers at (privacy, terms and support are allowed: on
Clarity's hosts a page lives under `/<business>/site/`, and on a business's
own domain the site answers every path). The same functions are imported by the
browser, so the editor cannot build something the server would refuse.

The preview is an iframe with only `site.css` and the chosen fonts inside,
so the coach app's stylesheet never touches it. React renders into it
through a portal, so it is the same component tree as the public page.

Pictures are shrunk in the browser (longest edge 1800px, WebP where the
browser can make one) before upload, land in the public `site-media`
bucket under the business's own folder, and a sweep after each save
removes uploads older than an hour that no page refers to, in its draft
or its published copy.

A save or publish carries the time the browser last saw the site saved,
and the server refuses it (409, `site_changed`) if the site has been
saved since: a stale tab never writes over newer work. A page removed
from the draft keeps its row, without a draft, while the public site
still shows its published copy; the row goes at the next publish. So
pressing Import, or deleting a page, changes nothing visitors see until
Publish.

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

- The public page is drawn by the browser, like the rest of the app. The
  edge function gives crawlers the page's title, description and sharing
  tags; the page's words themselves are not server-rendered.
- A booking block in the preview is a labelled box rather than the live
  widget, so editing never books anything and the preview stays light.
- Pictures pasted by address are used as given; only uploads are shrunk.
- A download is a link the coach pastes (or a file hosted elsewhere), sent
  in the receipt; the shop does not host files itself.
- Instagram posts are added by hand. A live feed needs Instagram's app
  review and a connected account.
