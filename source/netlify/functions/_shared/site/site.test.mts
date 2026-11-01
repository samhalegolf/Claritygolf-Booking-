import assert from "node:assert/strict";
import test from "node:test";

import { setDatabaseForTests } from "../database.mts";
import {
  HOME_PAGE_SLUG,
  MAX_SITE_BLOCKS,
  SITE_BLOCK_TYPES,
  SITE_PAGE_PRESETS,
  blockStyleIsPlain,
  cleanBlockStyle,
  cleanHeader,
  cleanInstagramHandle,
  cleanPageSlug,
  cleanSiteHref,
  cleanSitePageContent,
  cleanSitePageMeta,
  cleanSiteSettings,
  cleanTheme,
  googleFontsUrl,
  instagramUrl,
  newSiteBlock,
  pageHref,
  pageSlugFromHref,
  sitePageCard,
  sitePageImageUrls,
  siteYoutubeId,
  themeFromPreset,
  uniquePageSlug,
  youtubeThumbnail,
} from "./document.mts";
import { SITE_TEMPLATES } from "./templates.mts";
import {
  DomainInputError,
  NETLIFY_APEX_IPS,
  attachDomainToSite,
  checkDomainDns,
  cleanHostname,
  cnameTarget,
  dnsInstructions,
  isApexDomain,
  type DnsLookup,
} from "./domains.mts";
import { siteMediaPathFromUrl, siteMediaUrl, sweepUnusedSiteImages, uploadSiteImage } from "./media.mts";
import { cleanReturnPath } from "../../public-shop.mts";
import { accountIdForHostname, claimSiteDomain, listSitePages, markSiteFormMessageEmailed, readPublishedSite, readSite, saveSite, saveSiteFormMessage } from "./store.mts";

// --- Pages and their content ------------------------------------------------

test("a page is cleaned to its known blocks, in order, with unique ids", () => {
  const content = cleanSitePageContent({
    blocks: [
      { id: "a", type: "hero", heading: "  Hello  " },
      { id: "a", type: "text", body: "twice the same id" },
      { id: "x", type: "marquee", text: "not a block this page knows" },
      { id: "b", type: "divider" },
    ],
  });
  assert.deepEqual(
    content.blocks.map((block) => [block.id, block.type]),
    [
      ["a", "hero"],
      ["a-1", "text"],
      ["b", "divider"],
    ],
  );
  assert.equal(content.blocks[0].type === "hero" && content.blocks[0].heading, "Hello");
});

test("every block type has a starter that survives cleaning unchanged", () => {
  for (const type of SITE_BLOCK_TYPES) {
    const block = newSiteBlock(type);
    const [cleaned] = cleanSitePageContent({ blocks: [block] }).blocks;
    assert.deepEqual(cleaned, block, `${type} starter changed when cleaned`);
  }
});

test("links a stranger will click are http(s), mailto, tel, an anchor or a page, never script", () => {
  assert.equal(cleanSiteHref("javascript:alert(1)"), "");
  assert.equal(cleanSiteHref("data:text/html,hi"), "");
  assert.equal(cleanSiteHref("/relative/path"), "");
  assert.equal(cleanSiteHref("#contact"), "#contact");
  assert.equal(cleanSiteHref("page:about"), "page:about");
  assert.equal(cleanSiteHref("page:About Us"), "page:about-us");
  assert.equal(cleanSiteHref("page:api"), "", "a reserved address is not a page");
  assert.equal(pageSlugFromHref(pageHref("book")), "book");
  assert.equal(pageSlugFromHref("https://example.com"), "");
  assert.equal(cleanSiteHref("mailto:coach@example.com"), "mailto:coach@example.com");
  assert.equal(cleanSiteHref("tel:+64 21 555 0100"), "tel:+64 21 555 0100");
  assert.equal(cleanSiteHref("yourclub.com/lessons"), "https://yourclub.com/lessons");
});

test("a page's address is lower-case, hyphenated, never reserved, and made unique against its neighbours", () => {
  assert.equal(cleanPageSlug("  About Us! "), "about-us");
  assert.equal(cleanPageSlug("api"), "");
  assert.equal(cleanPageSlug("shop", "fallback"), "fallback");
  assert.equal(uniquePageSlug("about", ["home"]), "about");
  assert.equal(uniquePageSlug("about", ["home", "about"]), "about-2");
  assert.equal(uniquePageSlug("about", ["about", "about-2"]), "about-3");
  const meta = cleanSitePageMeta({ id: "page-1", slug: "Find Us", title: "Find us", kind: "poem", inNav: "yes", sortOrder: "3" }, 4);
  assert.deepEqual(meta, { id: "page-1", slug: "find-us", title: "Find us", kind: "page", inNav: true, sortOrder: 3 });
  assert.equal(cleanSitePageMeta({ slug: "api" }, 2).slug, "page-3", "a reserved address falls back to a numbered one");
});

test("an article's summary, cover and date are kept, and a bad date is dropped", () => {
  const content = cleanSitePageContent({ summary: " A short line ", cover: { url: "https://cdn.example/c.jpg", alt: "" }, date: "2026-10-31" });
  assert.equal(content.summary, "A short line");
  assert.equal(content.cover?.url, "https://cdn.example/c.jpg");
  assert.equal(content.date, "2026-10-31");
  assert.equal(cleanSitePageContent({ date: "31/10/2026" }).date, "");
  assert.deepEqual(sitePageImageUrls(content), ["https://cdn.example/c.jpg"]);
});

test("pictures are https only, and a block keeps its button while it still has a label", () => {
  const content = cleanSitePageContent({
    blocks: [
      { type: "image", image: { url: "http://insecure.example.com/a.jpg", alt: "x" } },
      { type: "image", image: { url: "https://cdn.example.com/a.jpg", alt: "x" } },
      { type: "cta", heading: "Go", button: { label: "Book", href: "javascript:void(0)" } },
      { type: "cta", heading: "Go", button: { label: "", href: "https://example.com" } },
    ],
  });
  assert.equal(content.blocks[0].type === "image" && content.blocks[0].image, null);
  assert.equal(content.blocks[1].type === "image" && content.blocks[1].image?.url, "https://cdn.example.com/a.jpg");
  assert.deepEqual(content.blocks[2].type === "cta" && content.blocks[2].button, { label: "Book", href: "", style: "primary" });
  assert.equal(content.blocks[3].type === "cta" && content.blocks[3].button, null);
  assert.deepEqual(sitePageImageUrls(content), ["https://cdn.example.com/a.jpg"]);
});

test("a theme's heading colour defaults to its text colour, and a preset may pick its accent", () => {
  assert.equal(cleanTheme({ preset: "classic" }).colors.heading, themeFromPreset("classic").colors.text);
  assert.equal(cleanTheme({ preset: "ember" }).colors.heading, "#fe914d");
  assert.equal(cleanTheme({ preset: "classic", colors: { heading: "#ff0000" } }).colors.heading, "#ff0000");
});

test("the theme only speaks six-digit hex, known fonts and known options", () => {
  const theme = cleanSiteSettings({
    theme: {
      preset: "slate",
      headingFont: "comic-sans",
      bodyFont: "lora",
      colors: { primary: "#ABC", background: "red", text: "#12345g" },
      corners: "bevelled",
      width: "wide",
      buttons: "pill",
    },
  }).theme;
  const slate = themeFromPreset("slate");
  assert.equal(theme.preset, "slate");
  assert.equal(theme.headingFont, slate.headingFont, "an unknown font falls back to the preset's");
  assert.equal(theme.bodyFont, "lora");
  assert.equal(theme.colors.primary, "#aabbcc", "three-digit hex is expanded");
  assert.equal(theme.colors.background, slate.colors.background, "a named colour falls back");
  assert.equal(theme.corners, slate.corners);
  assert.equal(theme.width, "wide");
  assert.equal(theme.buttons, "pill");
  assert.equal(cleanSiteSettings({ theme: { preset: "no-such-preset" } }).theme.preset, themeFromPreset("").preset);
});

test("fonts load from Google only when a chosen font needs it", () => {
  assert.equal(googleFontsUrl({ headingFont: "system", bodyFont: "system" }), "");
  const url = googleFontsUrl({ headingFont: "playfair", bodyFont: "playfair" });
  assert.match(url, /^https:\/\/fonts\.googleapis\.com\/css2\?family=Playfair\+Display/);
  assert.equal(url.split("family=").length - 1, 1, "the same font is not requested twice");
});

test("the block list is capped and a video block only keeps a real YouTube id", () => {
  const blocks = Array.from({ length: MAX_SITE_BLOCKS + 5 }, () => ({ type: "divider" }));
  assert.equal(cleanSitePageContent({ blocks }).blocks.length, MAX_SITE_BLOCKS);
  assert.equal(siteYoutubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10"), "dQw4w9WgXcQ");
  assert.equal(siteYoutubeId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(siteYoutubeId("https://vimeo.com/12345"), "");
  const [video] = cleanSitePageContent({ blocks: [{ type: "video", youtubeUrl: "https://youtu.be/dQw4w9WgXcQ" }] }).blocks;
  assert.equal(video.type === "video" && video.youtubeId, "dQw4w9WgXcQ");
});

test("booking, shop and article blocks keep their numbers inside sensible bounds", () => {
  const [low, high, none, shop, articles] = cleanSitePageContent({
    blocks: [
      { type: "booking", height: 10 },
      { type: "booking", height: 99999 },
      { type: "booking" },
      { type: "shop", mode: "popup", height: 50 },
      { type: "articles", limit: 500 },
    ],
  }).blocks;
  assert.equal(low.type === "booking" && low.height, 480);
  assert.equal(high.type === "booking" && high.height, 1600);
  assert.equal(none.type === "booking" && none.height, 760);
  assert.deepEqual(shop.type === "shop" && [shop.mode, shop.height], ["cards", 480]);
  assert.equal(articles.type === "articles" && articles.limit, 24);
});

// --- Presets and templates --------------------------------------------------

const presetInput = {
  businessName: "Riverside Golf",
  coachName: "Sam",
  bookingHref: "https://book.claritygolf.app/riverside?embed=booking",
  venueName: "Riverside Range",
  email: "hello@riverside.example",
  phone: "+64 21 000 0000",
};

test("every block carries a section style, and a plain one changes nothing", () => {
  assert.deepEqual(cleanBlockStyle(undefined), { theme: "default", background: null, video: "", overlay: 30, height: "auto", width: "inherit", divider: "none" });
  assert.equal(cleanBlockStyle({ divider: "wave" }).divider, "wave");
  assert.ok(!blockStyleIsPlain(cleanBlockStyle({ divider: "wave" })), "a wave is drawn, so the block is not plain");
  assert.ok(blockStyleIsPlain(cleanBlockStyle({})));
  const styled = cleanBlockStyle({
    theme: "dark",
    background: { url: "https://cdn.example/bg.jpg", alt: "" },
    video: "https://cdn.example/loop.mp4?v=2",
    overlay: 140,
    height: "medium",
    width: "wide",
  });
  assert.equal(styled.theme, "dark");
  assert.equal(styled.background?.url, "https://cdn.example/bg.jpg");
  assert.equal(styled.video, "https://cdn.example/loop.mp4?v=2");
  assert.equal(styled.overlay, 90, "the overlay stops short of hiding the picture");
  assert.equal(styled.height, "medium");
  assert.equal(styled.width, "wide");
  assert.ok(!blockStyleIsPlain(styled));
  assert.equal(cleanBlockStyle({ theme: "neon", video: "https://cdn.example/not-a-video.html", overlay: -5 }).theme, "default");
  assert.equal(cleanBlockStyle({ video: "https://cdn.example/not-a-video.html" }).video, "", "only a video file plays behind a block");
  assert.equal(cleanBlockStyle({ overlay: -5 }).overlay, 0);
  // The style rides on the block through cleaning, and an unknown style falls back to plain.
  const content = cleanSitePageContent({ blocks: [{ id: "t", type: "text", heading: "Hi", body: "", style: { theme: "accent" } }, { id: "d", type: "divider" }] });
  assert.equal(content.blocks[0].style.theme, "accent");
  assert.ok(blockStyleIsPlain(content.blocks[1].style));
});

test("cards, logos, embeds, venues and the contact form keep only what they can draw", () => {
  const content = cleanSitePageContent({
    blocks: [
      { id: "cards", type: "cards", columns: 7, items: [{ title: "One", text: "x", button: { label: "Go", href: "page:shop-page" } }, { title: "Two", button: { label: "", href: "page:shop-page" } }] },
      { id: "logos", type: "logos", size: "huge", items: [{ caption: "PGA", href: "javascript:alert(1)" }, { caption: "TPI", href: "https://tpi.example/" }] },
      { id: "embed", type: "embed", url: "http://plain.example/form", height: 20 },
      { id: "embed2", type: "embed", url: "https://forms.example/f/1", height: 100000 },
      {
        id: "venues",
        type: "venues",
        columns: 3,
        items: [
          { name: "The Range", address: "1 Fairway Road", booking: "group-lessons", height: 10 },
          { name: "The Club", showMap: false, booking: "nope", embedUrl: "https://maps.example/embed" },
        ],
      },
      { id: "form", type: "form", askPhone: false, buttonLabel: "Send it", thanks: "Cheers" },
    ],
  });
  const [cards, logos, embed, embed2, venues, form] = content.blocks;
  assert.equal(cards.type === "cards" && cards.columns, 4, "an unknown column count falls back");
  assert.equal(cards.type === "cards" && cards.items[0].button?.href, "page:shop-page");
  assert.equal(cards.type === "cards" && cards.items[1].button, null, "a button without a label is dropped");
  assert.equal(logos.type === "logos" && logos.size, "regular");
  assert.equal(logos.type === "logos" && logos.items[0].href, "", "a script link is dropped");
  assert.equal(logos.type === "logos" && logos.items[1].href, "https://tpi.example/");
  assert.equal(embed.type === "embed" && embed.url, "", "a frame is https only");
  assert.equal(embed.type === "embed" && embed.height, 200);
  assert.ok(embed2.type === "embed" && embed2.url === "https://forms.example/f/1" && embed2.height < 100000);
  assert.equal(venues.type === "venues" && venues.columns, 2);
  assert.ok(venues.type === "venues" && venues.items[0].showMap, "a venue shows its map unless told not to");
  assert.equal(venues.type === "venues" && venues.items[0].booking, "group-lessons");
  assert.ok(venues.type === "venues" && venues.items[0].height >= 300, "a booking frame is never too short to use");
  assert.equal(venues.type === "venues" && venues.items[1].booking, "none", "an unknown booking screen means no booking");
  assert.equal(venues.type === "venues" && venues.items[1].embedUrl, "https://maps.example/embed");
  assert.deepEqual(form.type === "form" && [form.askPhone, form.buttonLabel, form.thanks], [false, "Send it", "Cheers"]);
});

test("a video page keeps its YouTube id, and the index blocks keep only what they draw", () => {
  const meta = cleanSitePageMeta({ slug: "putting-drill", title: "Putting drill", kind: "video", inNav: false });
  assert.equal(meta.kind, "video");
  assert.equal(cleanSitePageMeta({ slug: "x", title: "x", kind: "podcast" }).kind, "page");
  const content = cleanSitePageContent({ video: "https://youtu.be/dQw4w9WgXcQ?t=4", blocks: [] });
  assert.equal(content.video, "dQw4w9WgXcQ");
  assert.equal(cleanSitePageContent({ video: "https://example.com/not-youtube" }).video, "");
  const card = sitePageCard({ ...meta, id: "p1", sortOrder: 3, content: { ...content, summary: "A drill", cover: null } });
  assert.deepEqual([card.slug, card.video, card.summary, card.cover], ["putting-drill", "dQw4w9WgXcQ", "A drill", null]);
  assert.equal(youtubeThumbnail("dQw4w9WgXcQ"), "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  assert.equal(youtubeThumbnail(""), "");

  const page = cleanSitePageContent({
    blocks: [
      { id: "v", type: "videos", limit: 99, layout: "carousel" },
      { id: "i", type: "instagram", handle: "https://www.instagram.com/samhalegolf/", columns: 5, items: [{ image: { url: "https://cdn.example/a.jpg" }, href: "https://www.instagram.com/p/abc/" }, { image: null, href: "javascript:x" }] },
    ],
  });
  const [videos, instagram] = page.blocks;
  assert.deepEqual(videos.type === "videos" && [videos.limit, videos.layout], [24, "grid"]);
  assert.equal(instagram.type === "instagram" && instagram.handle, "samhalegolf");
  assert.equal(instagram.type === "instagram" && instagram.columns, 4);
  assert.equal(instagram.type === "instagram" && instagram.items.length, 2);
  assert.equal(instagram.type === "instagram" && instagram.items[1].href, "", "a script link is dropped");
  assert.equal(cleanInstagramHandle("@Sam.Hale_Golf"), "Sam.Hale_Golf");
  assert.equal(cleanInstagramHandle("not a handle!"), "");
  assert.equal(instagramUrl("samhalegolf"), "https://www.instagram.com/samhalegolf/");
  assert.deepEqual(sitePageImageUrls(page), ["https://cdn.example/a.jpg"], "the instagram pictures count as the page's");
});

test("a header may carry an announcement strip and name the page its bag icon opens", () => {
  const header = cleanHeader({ announcement: "  Winter clinics now open  ", announcementHref: "page:group-coaching", shopPage: "Shop Page" });
  assert.equal(header.announcement, "Winter clinics now open");
  assert.equal(header.announcementHref, "page:group-coaching");
  assert.equal(header.shopPage, "shop-page");
  assert.deepEqual([cleanHeader({}).announcement, cleanHeader({}).shopPage], ["", ""]);
  assert.equal(cleanHeader({ shopPage: "shop" }).shopPage, "", "a reserved address is not a page");
});

test("a header may sit over the first block and carry social links of known kinds", () => {
  const header = cleanHeader({ transparent: true, social: [{ kind: "instagram", url: "https://instagram.com/x" }, { kind: "myspace", url: "https://myspace.example" }, { kind: "facebook", url: "javascript:x" }] });
  assert.equal(header.transparent, true);
  assert.deepEqual(header.social, [{ kind: "instagram", url: "https://instagram.com/x" }]);
  assert.equal(cleanHeader({}).transparent, false, "a header is opaque unless asked");
});

test("a page's pictures include backdrops and the pictures on cards, logos and reviews", () => {
  const content = cleanSitePageContent({
    blocks: [
      { id: "t", type: "text", body: "", style: { background: { url: "https://cdn.example/bg.jpg" } } },
      { id: "c", type: "cards", items: [{ title: "x", image: { url: "https://cdn.example/card.jpg" } }] },
      { id: "l", type: "logos", items: [{ caption: "x", image: { url: "https://cdn.example/logo.png" } }] },
      { id: "r", type: "testimonials", items: [{ quote: "x", name: "y", image: { url: "https://cdn.example/review.png" } }] },
    ],
  });
  assert.deepEqual(sitePageImageUrls(content).sort(), ["https://cdn.example/bg.jpg", "https://cdn.example/card.jpg", "https://cdn.example/logo.png", "https://cdn.example/review.png"]);
});

test('the "pro" template is the full coaching site: venues as its booking page, a dark review band and a contact form', () => {
  const pro = SITE_TEMPLATES.find((template) => template.id === "pro");
  assert.ok(pro);
  const site = pro.build(presetInput);
  assert.equal(site.settings.header.transparent, true);
  const home = site.pages[0].content.blocks;
  assert.deepEqual(home.map((block) => block.type), ["hero", "cards", "testimonials", "logos", "instagram"]);
  assert.equal(site.settings.header.shopPage, "shop-page", "the bag icon opens the shop page");
  assert.ok(site.pages.some((page) => page.slug === "videos"), "a videos page is one of its pages");
  assert.equal(home[2].style.theme, "dark");
  const book = site.pages.find((page) => page.slug === "book");
  assert.equal(book?.content.blocks[0].type, "venues");
  assert.equal(book?.title, "Book a Lesson");
  const contact = site.pages.find((page) => page.slug === "contact");
  assert.ok(contact?.content.blocks.some((block) => block.type === "form"));
  assert.ok(site.pages.some((page) => page.slug === "shop-page"), "the shop is one of its pages");
  // Every page link on the home page leads to a page the site has.
  const slugs = new Set(site.pages.map((page) => page.slug));
  for (const block of home) {
    const hrefs = block.type === "hero" ? block.buttons.map((b) => b.href) : block.type === "cards" ? block.items.map((item) => item.button?.href || "") : [];
    for (const href of hrefs) if (href.startsWith("page:")) assert.ok(slugs.has(href.slice(5)), `${href} leads nowhere`);
  }
});

for (const preset of SITE_PAGE_PRESETS) {
  test(`page preset "${preset.id}" builds a page the cleaner would store as is`, () => {
    const page = preset.build(presetInput);
    assert.deepEqual(cleanSitePageContent(page.content), page.content);
    assert.equal(cleanPageSlug(page.slug), page.slug, "a preset's address is a valid one");
    assert.notEqual(page.slug, HOME_PAGE_SLUG);
    assert.ok(page.title);
    assert.ok(page.content.blocks.length >= 1);
    if (preset.id === "article") {
      assert.equal(page.kind, "article");
      assert.equal(page.inNav, false, "an article is listed by the articles page, not the menu");
      assert.match(page.content.date, /^\d{4}-\d{2}-\d{2}$/);
    }
    if (preset.id === "video") {
      assert.equal(page.kind, "video");
      assert.equal(page.inNav, false, "a video is listed by the videos page, not the menu");
    }
    if (preset.id === "book") assert.equal(page.content.blocks[0].type, "booking");
    if (preset.id === "shop") assert.equal(page.content.blocks[0].type, "shop");
  });
}

for (const template of SITE_TEMPLATES) {
  test(`template "${template.id}" builds a site the cleaner would store as is`, () => {
    const site = template.build(presetInput);
    assert.deepEqual(cleanSiteSettings(site.settings), site.settings);
    assert.equal(site.pages[0].slug, HOME_PAGE_SLUG, "the first page is home");
    assert.ok(site.pages.some((page) => page.slug === "book"), "every site starts with its booking page");
    for (const page of site.pages) assert.deepEqual(cleanSitePageContent(page.content), page.content);
    assert.equal(new Set(site.pages.map((page) => page.slug)).size, site.pages.length, "page addresses are unique");
    // Every "Book" button on the home page leads to the site's own booking page.
    const bookButtons = site.pages[0].content.blocks.flatMap((block) =>
      block.type === "hero" ? block.buttons : block.type === "cta" && block.button ? [block.button] : [],
    );
    assert.ok(bookButtons.some((button) => button.href === pageHref("book")), "no button points at the booking page");
    assert.equal(site.settings.header.button?.href, pageHref("book"));
    // Block ids are unique within a page: anchors like #lessons depend on it.
    const home = site.pages[0].content.blocks;
    assert.equal(new Set(home.map((block) => block.id)).size, home.length);
  });
}

// --- Hostnames and DNS ------------------------------------------------------

test("a hostname is stored lower-case, without scheme or path, and must be a real domain", () => {
  assert.equal(cleanHostname("  HTTPS://WWW.YourClub.com/lessons?x=1  "), "www.yourclub.com");
  assert.equal(cleanHostname("golf.yourclub.co.nz."), "golf.yourclub.co.nz");
  assert.equal(cleanHostname("bücher.example"), "xn--bcher-kva.example");
  for (const bad of ["", "localhost", "192.168.1.1", "yourclub", "-bad.example.com", "a b.example.com", "www.claritygolf.app", "x.netlify.app"]) {
    assert.throws(() => cleanHostname(bad), DomainInputError, `${JSON.stringify(bad)} should be refused`);
  }
});

test("the records to add depend on whether the domain is an apex", () => {
  assert.equal(isApexDomain("yourclub.com"), true);
  assert.equal(isApexDomain("yourclub.co.nz"), true);
  assert.equal(isApexDomain("www.yourclub.com"), false);
  assert.equal(isApexDomain("golf.yourclub.co.nz"), false);

  const sub = dnsInstructions("www.yourclub.com", "tok123");
  assert.deepEqual(sub, [
    { type: "TXT", name: "_clarity-verify.www.yourclub.com", value: "clarity-site=tok123" },
    { type: "CNAME", name: "www.yourclub.com", value: cnameTarget() },
  ]);
  const apex = dnsInstructions("yourclub.com", "tok123");
  assert.equal(apex[1].type, "A");
  assert.equal(apex[1].value, NETLIFY_APEX_IPS[0]);
});

function fakeLookup(answers: Record<string, string[]>): DnsLookup {
  return async (name, type) => answers[`${type} ${name}`] || [];
}

test("the DNS check wants both the proof of ownership and the pointer", async () => {
  const host = "www.yourclub.com";
  const target = cnameTarget();
  const neither = await checkDomainDns(host, "tok", fakeLookup({}));
  assert.deepEqual([neither.verified, neither.pointed], [false, false]);
  assert.match(neither.problem, /Neither record/);

  const onlyTxt = await checkDomainDns(host, "tok", fakeLookup({ [`TXT _clarity-verify.${host}`]: ["clarity-site=tok"] }));
  assert.deepEqual([onlyTxt.verified, onlyTxt.pointed], [true, false]);
  assert.match(onlyTxt.problem, /does not point/);

  const wrongToken = await checkDomainDns(
    host,
    "tok",
    fakeLookup({ [`TXT _clarity-verify.${host}`]: ["clarity-site=someone-elses"], [`CNAME ${host}`]: [target] }),
  );
  assert.deepEqual([wrongToken.verified, wrongToken.pointed], [false, true]);

  const both = await checkDomainDns(host, "tok", fakeLookup({ [`TXT _clarity-verify.${host}`]: ["clarity-site=tok"], [`CNAME ${host}`]: [target] }));
  assert.deepEqual([both.verified, both.pointed, both.problem], [true, true, ""]);
});

test("an apex A record, or a flattened CNAME, counts as pointed", async () => {
  const apex = "yourclub.com";
  const viaApexIp = await checkDomainDns(
    apex,
    "tok",
    fakeLookup({ [`TXT _clarity-verify.${apex}`]: ["clarity-site=tok"], [`A ${apex}`]: [NETLIFY_APEX_IPS[0]] }),
  );
  assert.equal(viaApexIp.pointed, true);
  const flattened = await checkDomainDns(
    apex,
    "tok",
    fakeLookup({
      [`TXT _clarity-verify.${apex}`]: ["clarity-site=tok"],
      [`A ${apex}`]: ["203.0.113.9"],
      [`A ${cnameTarget()}`]: ["203.0.113.9", "203.0.113.10"],
    }),
  );
  assert.equal(flattened.pointed, true);
  const elsewhere = await checkDomainDns(
    apex,
    "tok",
    fakeLookup({ [`TXT _clarity-verify.${apex}`]: ["clarity-site=tok"], [`A ${apex}`]: ["198.51.100.1"], [`A ${cnameTarget()}`]: ["203.0.113.9"] }),
  );
  assert.equal(elsewhere.pointed, false);
});

test("attaching a domain adds it to the site's aliases once, and reads a taken domain as a conflict", async () => {
  const previous = { token: process.env.NETLIFY_API_TOKEN, site: process.env.SITE_ID };
  process.env.NETLIFY_API_TOKEN = "test-token";
  process.env.SITE_ID = "site-1";
  try {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchWith = (site: { domain_aliases: string[] }, patchStatus = 200) => async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method || "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      if (!init?.method || init.method === "GET") return new Response(JSON.stringify(site), { status: 200 });
      if (init.method === "PATCH") return new Response(patchStatus === 200 ? "{}" : '{"errors":"domain_aliases is already in use"}', { status: patchStatus });
      return new Response("{}", { status: 200 });
    };

    await attachDomainToSite("www.yourclub.com", fetchWith({ domain_aliases: ["book.claritygolf.app"] }));
    const patch = calls.find((call) => call.method === "PATCH");
    assert.deepEqual(patch?.body, { domain_aliases: ["book.claritygolf.app", "www.yourclub.com"] });
    assert.ok(calls.every((call) => call.url.startsWith("https://api.netlify.com/api/v1/sites/site-1")));
    assert.ok(calls.some((call) => call.url.endsWith("/ssl") && call.method === "POST"), "a certificate is asked for");

    calls.length = 0;
    await attachDomainToSite("www.yourclub.com", fetchWith({ domain_aliases: ["www.yourclub.com"] }));
    assert.equal(calls.filter((call) => call.method === "PATCH").length, 0, "already attached means nothing to change");

    await assert.rejects(
      () => attachDomainToSite("www.other.com", fetchWith({ domain_aliases: [] }, 422)),
      (error: any) => error?.status === 409,
    );
  } finally {
    process.env.NETLIFY_API_TOKEN = previous.token ?? "";
    process.env.SITE_ID = previous.site ?? "";
  }
});

// --- Pictures ---------------------------------------------------------------

function withStorageEnv<T>(work: () => Promise<T>): Promise<T> {
  const previous = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = "https://proj.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  return work().finally(() => {
    process.env.SUPABASE_URL = previous.url ?? "";
    process.env.SUPABASE_SERVICE_ROLE_KEY = previous.key ?? "";
  });
}

test("uploads land in the business's own folder and come back as public addresses", () =>
  withStorageEnv(async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const doFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init || {} });
      return new Response("{}", { status: 200 });
    };
    const uploaded = await uploadSiteImage("riverside", { type: "image/webp", dataBase64: Buffer.from("picture-bytes").toString("base64") }, doFetch);
    assert.match(uploaded.path, /^riverside\/[a-z0-9]+-[a-z0-9]{8}\.webp$/);
    assert.equal(uploaded.url, siteMediaUrl(uploaded.path));
    assert.equal(siteMediaPathFromUrl(uploaded.url), uploaded.path);
    assert.equal(calls[0].url, `https://proj.supabase.co/storage/v1/object/site-media/${uploaded.path}`);
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer service-key");
    assert.equal(siteMediaPathFromUrl("https://elsewhere.example/a.jpg"), "");

    await assert.rejects(() => uploadSiteImage("riverside", { type: "image/svg+xml", dataBase64: "PHN2Zz4=" }, doFetch), /JPG, PNG, WebP or GIF/);
    await assert.rejects(() => uploadSiteImage("riverside", { type: "image/png", dataBase64: "" }, doFetch), /arrived empty/);
  }));

test("the sweep removes old uploads nothing refers to, and leaves fresh ones alone", () =>
  withStorageEnv(async () => {
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    let deleted: string[] = [];
    const doFetch = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/object/list/site-media")) {
        return new Response(
          JSON.stringify([
            { name: "kept.jpg", created_at: old },
            { name: "orphan.jpg", created_at: old },
            { name: "just-added.jpg", created_at: fresh },
          ]),
          { status: 200 },
        );
      }
      if (init?.method === "DELETE") {
        deleted = (JSON.parse(String(init.body)) as { prefixes: string[] }).prefixes;
        return new Response("[]", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    const removed = await sweepUnusedSiteImages("riverside", [siteMediaUrl("riverside/kept.jpg")], doFetch);
    assert.equal(removed, 1);
    assert.deepEqual(deleted, ["riverside/orphan.jpg"]);
  }));

test("a missing bucket is made on the first upload, then the upload is retried", () =>
  withStorageEnv(async () => {
    const calls: string[] = [];
    let bucketExists = false;
    const doFetch = async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method || "GET"} ${url.replace("https://proj.supabase.co/storage/v1", "")}`);
      if (url.endsWith("/bucket")) {
        bucketExists = true;
        return new Response('{"name":"site-media"}', { status: 200 });
      }
      if (!bucketExists) return new Response('{"statusCode":"404","error":"Bucket not found","message":"Bucket not found"}', { status: 400 });
      return new Response("{}", { status: 200 });
    };
    const uploaded = await uploadSiteImage("riverside", { type: "image/png", dataBase64: Buffer.from("png").toString("base64") }, doFetch);
    assert.equal(calls.length, 3, "upload, make bucket, upload again");
    assert.equal(calls[1], "POST /bucket");
    assert.equal(calls[2], `POST /object/site-media/${uploaded.path}`);
  }));

// --- The shop's way back ----------------------------------------------------

test("a shop order only ever returns the buyer to a path on the same origin", () => {
  assert.equal(cleanReturnPath("/shop-page"), "/shop-page");
  assert.equal(cleanReturnPath("/riverside/site/shop-page"), "/riverside/site/shop-page");
  assert.equal(cleanReturnPath("//evil.example/x"), "");
  assert.equal(cleanReturnPath("https://evil.example/x"), "");
  assert.equal(cleanReturnPath("shop"), "");
  assert.equal(cleanReturnPath("/shop?x=1"), "/shop", "a query is dropped: the order id is added on");
});

// --- The store is account-scoped --------------------------------------------

type Issued = { text: string; values: unknown[] };

function fakeDatabase(rows: (text: string, values: unknown[]) => unknown[]) {
  const issued: Issued[] = [];
  const record = (text: string, values: unknown[]) => {
    const flat = text.replace(/\s+/g, " ").trim();
    issued.push({ text: flat, values });
    return rows(flat, values);
  };
  const query = async (text: string, values: unknown[] = []) => ({ rows: record(text, values) });
  setDatabaseForTests({
    async sql(strings: TemplateStringsArray, ...values: unknown[]) {
      let text = "";
      strings.forEach((part, index) => {
        text += part;
        if (index < values.length) text += `$${index + 1}`;
      });
      return record(text, values);
    },
    pool: { query, async connect() { return { query, release() {} }; } },
  });
  return issued;
}

const now = new Date();

test("every site read and write names its business in the statement itself", async () => {
  const issued = fakeDatabase((text, values) => {
    if (text.startsWith("SELECT document, published_document")) {
      return values[0] === "riverside" ? [{ document: { theme: {} }, published_document: null, published_at: null, updated_at: now }] : [];
    }
    if (text.startsWith("SELECT id, slug, title")) {
      return [{ id: "page-home", slug: "home", title: "Home", kind: "page", in_nav: true, sort_order: 0, document: { blocks: [] }, published_document: null, published_at: null, updated_at: now }];
    }
    if (text.startsWith("SELECT id FROM site_pages")) return [{ id: "page-home" }];
    return [];
  });
  try {
    assert.equal(await readSite(""), null, "no business, no read");
    assert.deepEqual(await listSitePages(""), []);
    assert.equal(issued.length, 0);

    const site = await readSite("riverside");
    assert.ok(site);
    assert.match(issued[0].text, /FROM sites WHERE account_id = \$1/);

    await saveSite("riverside", {
      settings: {},
      pages: [
        { id: "page-home", slug: "home", title: "Home", content: { blocks: [{ type: "divider" }] } },
        { slug: "About", title: "About", content: {} },
      ],
    });
    const writes = issued.filter((statement) => /INSERT INTO|DELETE FROM|UPDATE site_pages/.test(statement.text));
    assert.match(writes[0].text, /INSERT INTO sites/);
    assert.equal(writes[0].values[0], "riverside");
    // Rows that are going leave first, and rows that stay step off their
    // addresses, so a replaced or reordered site never trips the unique address.
    assert.match(writes[1].text, /DELETE FROM site_pages WHERE account_id = \$1 AND NOT \(id = ANY/);
    assert.equal(writes[1].values[0], "riverside");
    assert.match(writes[2].text, /UPDATE site_pages SET slug = '~' \|\| id WHERE account_id = \$1 AND id = ANY/);
    assert.deepEqual(writes[2].values, ["riverside", ["page-home"]]);
    assert.match(writes[3].text, /INSERT INTO site_pages/);
    assert.equal(writes[3].values[0], "page-home", "an existing page keeps its id");
    assert.equal(writes[3].values[1], "riverside");
    assert.match(String(writes[4].values[0]), /^page-/, "a new page gets an id");
    assert.equal(writes[4].values[2], "about", "and a cleaned address");
    assert.ok(issued.some((statement) => statement.text === "COMMIT"));

    await assert.rejects(() => saveSite("riverside", { settings: {}, pages: [{ slug: "about", title: "About" }] }), /home page cannot be removed/);
    await assert.rejects(
      () => saveSite("riverside", { settings: {}, pages: [{ slug: "home", title: "Home" }, { slug: "x", title: "" }, { slug: "x", title: "" }] }),
      /Two pages have the address/,
    );
    await assert.rejects(() => saveSite("", { settings: {}, pages: [] }), /accountId is required/);
  } finally {
    setDatabaseForTests(null);
  }
});

test("the public read serves the published copy only, with each page's published meta", async () => {
  fakeDatabase((text, values) => {
    if (text.startsWith("SELECT document, published_document")) {
      return [{ document: { theme: { preset: "slate" } }, published_document: { theme: { preset: "fairway" } }, published_at: now, updated_at: now }];
    }
    if (text.includes("WHERE account_id = $1 AND published_document IS NOT NULL")) {
      assert.equal(values[0], "riverside");
      return [
        { id: "p1", slug: "home-renamed-in-draft", title: "Draft title", kind: "page", in_nav: true, sort_order: 0, published_document: { slug: "home", title: "Home", kind: "page", inNav: true, sortOrder: 0, blocks: [] } },
        { id: "p2", slug: "tips", title: "Tips", kind: "article", in_nav: false, sort_order: 1, published_document: { slug: "tips", title: "Tips", kind: "article", inNav: false, sortOrder: 1, summary: "S", date: "2026-10-01", blocks: [] } },
        { id: "p3", slug: "old", title: "Old", kind: "page", in_nav: true, sort_order: 2, published_document: { blocks: [] } },
      ];
    }
    return [];
  });
  try {
    const home = await readPublishedSite("riverside", "");
    assert.ok(home);
    assert.equal(home.settings.theme.preset, "fairway", "the published theme, not the draft");
    assert.equal(home.page?.slug, "home", "the published address wins over the draft's");
    assert.equal(home.page?.title, "Home");
    assert.deepEqual(
      home.pages.map((page) => [page.slug, page.kind, page.summary]),
      [
        ["home", "page", ""],
        ["tips", "article", "S"],
        ["old", "page", ""],
      ],
      "a copy from before meta rode along falls back to the columns",
    );
    const missing = await readPublishedSite("riverside", "nowhere");
    assert.equal(missing?.page, null);
  } finally {
    setDatabaseForTests(null);
  }
});

test("a hostname only answers for a business once it is live, and cannot be claimed twice", async () => {
  const issued = fakeDatabase((text, values) => {
    if (text.includes("FROM site_domains WHERE hostname = $1 AND status = 'active'")) {
      return values[0] === "www.live.example" ? [{ account_id: "riverside" }] : [];
    }
    if (text.includes("FROM site_domains WHERE hostname = $1")) {
      return values[0] === "www.live.example" ? [{ id: "domain-1", account_id: "riverside", hostname: "www.live.example", verification_token: "t", status: "active", created_at: now }] : [];
    }
    if (text.startsWith("INSERT INTO site_domains")) {
      return [{ id: values[0], account_id: values[1], hostname: values[2], verification_token: values[3], status: "pending", created_at: now }];
    }
    return [];
  });
  try {
    assert.equal(await accountIdForHostname("www.live.example"), "riverside");
    assert.equal(await accountIdForHostname("www.pending.example"), "");
    assert.equal(await accountIdForHostname(""), "");

    const mine = await claimSiteDomain("riverside", "www.live.example");
    assert.equal(mine.id, "domain-1", "claiming your own domain again is the same domain");
    await assert.rejects(() => claimSiteDomain("other-club", "www.live.example"), (error: any) => error?.status === 409);
    const fresh = await claimSiteDomain("other-club", "www.new.example");
    assert.equal(fresh.accountId, "other-club");
    assert.equal(fresh.status, "pending");
    assert.ok(fresh.verificationToken.length >= 20);
    assert.ok(issued.every((statement) => !statement.text.includes("site_domains") || statement.text.includes("account_id") || statement.text.includes("hostname = $1")));
  } finally {
    setDatabaseForTests(null);
  }
});

test("a website message is stored under its business, then marked as emailed", async () => {
  const issued = fakeDatabase(() => []);
  try {
    const id = await saveSiteFormMessage("riverside", { name: "Ann", email: "ann@example.com", phone: "", message: "Hello", pageSlug: "contact" });
    assert.match(id, /^msg-/);
    assert.match(issued[0].text, /INSERT INTO site_form_messages/);
    assert.deepEqual(issued[0].values.slice(0, 4), [id, "riverside", "contact", "Ann"]);
    await markSiteFormMessageEmailed("riverside", id);
    assert.match(issued[1].text, /UPDATE site_form_messages SET emailed = true WHERE account_id = \$1 AND id = \$2/);
    assert.deepEqual(issued[1].values, ["riverside", id]);
    await assert.rejects(() => saveSiteFormMessage("", { name: "x", email: "x@example.com", phone: "", message: "x", pageSlug: "home" }), /accountId is required/);
  } finally {
    setDatabaseForTests(null);
  }
});
