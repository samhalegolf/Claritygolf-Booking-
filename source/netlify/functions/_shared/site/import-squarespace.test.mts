/**
 * The Squarespace importer reads another site's pages and makes ours. What
 * matters: the addresses survive, the words survive, every section lands in
 * the block its shape calls for, and a site it cannot read is reported, not
 * invented.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { blocksOfBody, blocksOfSection, headerOf, hoursGroups, importSquarespaceSite, metaOf, pagePathsOf, piecesOf, sectionsOf, textOf, youtubeIdIn } from "./import-squarespace.mts";

const section = (theme: string, inner: string) => `<section data-test="page-section" data-section-theme="${theme}" class="page-section">${inner}</section>`;
const footer = section("", `<h2>Riverside Golf</h2><p><a href="mailto:hi@riverside.example">hi@riverside.example</a></p>`);

test("words come out of markup with their lines, entities and bullets", () => {
  assert.equal(textOf("<p>One&nbsp;two &amp; three</p><p>Four<br>five</p>"), "One two & three\nFour\nfive");
  assert.deepEqual(
    piecesOf(`<h2>Hello</h2><p>A line</p><ul><li>One</li></ul><a class="sqs-button-element" href="/book">Book</a><img data-src="https://cdn.example/a.jpg?format=500w" alt="A"><iframe src="https://x.example/f"></iframe>`).map((piece) => piece.kind),
    ["heading", "paragraph", "paragraph", "button", "image", "frame"],
  );
  const image = piecesOf(`<a href="https://www.instagram.com/p/abc/"><img src="https://cdn.example/b.jpg" alt=""></a>`)[0];
  assert.deepEqual(image, { kind: "image", src: "https://cdn.example/b.jpg", alt: "", href: "https://www.instagram.com/p/abc/" });
  // A list item that holds a card is read inside, not swallowed as a bullet.
  const kinds = piecesOf(`<ul><li><img src="https://cdn.example/c.jpg"><h3>Card</h3><p>Line</p></li></ul>`).map((piece) => piece.kind);
  assert.deepEqual(kinds, ["image", "heading", "paragraph"]);
});

test("the sections of a page come with their theme and backdrop, and the meta tags with the site name trimmed", () => {
  const html = `<html><head><title>Group Coaching &mdash; Riverside Golf</title><meta name="description" content="Join us"><meta property="og:image" content="http://cdn.example/og.jpg?format=1500w"></head><body><main>${section("black-bold", `<div class="section-background"><img data-src="https://cdn.example/bg.jpg?format=2500w"></div><h1>Hi</h1>`)}${footer}</main></body></html>`;
  const sections = sectionsOf(html);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].theme, "black-bold");
  assert.equal(sections[0].background, "https://cdn.example/bg.jpg");
  assert.deepEqual(metaOf(html, "Riverside Golf"), { title: "Group Coaching", description: "Join us", image: "https://cdn.example/og.jpg" });
  assert.equal(metaOf("<title>Riverside Golf</title>", "Riverside Golf").title, "", "the bare site name is no title of its own");
});

const options = { bookingSlug: "riverside", first: false, report: [] as string[], siteName: "Riverside Golf", instagram: "https://www.instagram.com/riversidegolf" };

test("a footer of name and email becomes nothing; a heading with an email, phone and booking frame becomes contact and booking", () => {
  assert.deepEqual(blocksOfSection(sectionsOf(footer)[0], options), []);
  const blocks = blocksOfSection(sectionsOf(section("", `<h2>Contact us.</h2><p>hi@riverside.example<br>021 000 000</p><iframe src="https://book.claritygolf.app/?embed=booking&layout=compact"></iframe>`))[0], options).map((entry) => entry.block);
  assert.equal(blocks[0].type, "contact");
  assert.ok(blocks[0].type === "contact" && blocks[0].email === "hi@riverside.example" && blocks[0].phone === "021 000 000");
  assert.ok(blocks[1].type === "booking" && blocks[1].screen === "main" && blocks[1].height === 600, "a compact Clarity frame is the main screen, shorter");
});

test("two venues with hours and a frame each become a venues block, hours split where the week starts over", () => {
  const html = section("", `<h1>Locations</h1><h3>Takapuna</h3><p>Golf HQ</p><p>Tue 5pm–9pm</p><p>Sun 8am–1pm</p><p>Mon 5pm–9pm</p><p>Fri 1pm–7pm</p><iframe src="https://bale.example/form?x=1"></iframe><h3>Three Kings</h3><p>The Range</p><iframe src="https://book.claritygolf.app/riverside?embed=booking"></iframe>`);
  const [block] = blocksOfSection(sectionsOf(html)[0], options).map((entry) => entry.block);
  assert.equal(block.type, "venues");
  if (block.type !== "venues") return;
  assert.equal(block.heading, "Locations");
  assert.deepEqual(block.items.map((venue) => [venue.name, venue.address, venue.hours, venue.booking, venue.embedUrl]), [
    ["Takapuna", "Golf HQ", "Tue 5pm–9pm\nSun 8am–1pm", "none", "https://bale.example/form?x=1"],
    ["Three Kings", "The Range", "Mon 5pm–9pm\nFri 1pm–7pm", "main", ""],
  ]);
  assert.deepEqual(hoursGroups("Mon 9-5\nWed 9-5\nMon 1-2"), ["Mon 9-5\nWed 9-5", "Mon 1-2"]);
  assert.ok(block.items[0].showMap);
});

test("a row of pictures with a line each is logos; review screenshots are testimonials; posts are an instagram grid", () => {
  const logos = blocksOfSection(sectionsOf(section("white", `<h2>Certifications</h2><img src="https://cdn.example/1.png"><p>PGA</p><img src="https://cdn.example/2.png"><p>TPI</p>`))[0], options)[0].block;
  assert.ok(logos.type === "logos" && logos.items.map((item) => item.caption).join(",") === "PGA,TPI" && logos.style?.theme === "white");
  const reviews = blocksOfSection(sectionsOf(section("", `<h2>Customer Feedback</h2><img src="https://cdn.example/a.jpg" alt="Ann Review"><img src="https://cdn.example/b.jpg" alt="Bob Review"><img src="https://cdn.example/c.jpg" alt=""><a class="sqs-button-element" href="https://g.page/r/x/review">Leave a Review</a>`))[0], options)[0].block;
  assert.ok(reviews.type === "testimonials" && reviews.items.length === 3 && reviews.items[0].name === "Ann" && reviews.button?.href === "https://g.page/r/x/review");
  const grid = blocksOfSection(sectionsOf(section("", `<h2>Follow On Instagram</h2>${[1, 2, 3, 4].map((n) => `<img src="https://cdn.example/ig${n}.jpg">`).join("")}`))[0], options)[0].block;
  assert.ok(grid.type === "instagram" && grid.handle === "riversidegolf" && grid.items.length === 4, "the handle comes from the header's social link");
});

test("pictures, headings, lines and buttons laid out by kind still zip into cards", () => {
  const html = section("white", `<ul>${["Private", "Group", "Vouchers"].map((name) => `<li><img src="https://cdn.example/${name}.jpg"><h3>${name}</h3><p>About ${name}</p><a class="sqs-button-element" href="/${name.toLowerCase()}">Go</a></li>`).join("")}</ul>`);
  const [block] = blocksOfSection(sectionsOf(html)[0], options).map((entry) => entry.block);
  assert.equal(block.type, "cards");
  if (block.type !== "cards") return;
  assert.deepEqual(block.items.map((item) => [item.title, item.text, item.button?.href]), [
    ["Private", "About Private", "page:private"],
    ["Group", "About Group", "page:group"],
    ["Vouchers", "About Vouchers", "page:vouchers"],
  ]);
});

test("the first section of the home page is a hero; a dark section with a logo, words and a group frame keeps that order", () => {
  const hero = blocksOfSection(sectionsOf(section("", `<img src="https://cdn.example/sam.jpg"><p>Sam coaches.</p><p>Golf is fun.</p>`))[0], { ...options, first: true })[0].block;
  assert.ok(hero.type === "hero" && hero.heading === "Riverside Golf" && hero.layout === "split" && hero.text === "Sam coaches.\n\nGolf is fun.");
  const blocks = blocksOfSection(sectionsOf(section("black-bold", `<img src="https://cdn.example/logo.png"><h1>Group Coaching</h1><iframe src="https://book.claritygolf.app/riverside/group-lessons?embed=booking"></iframe><p>Round up some friends.</p>`))[0], options).map((entry) => entry.block);
  assert.deepEqual(blocks.map((block) => block.type), ["image", "text", "booking"]);
  assert.ok(blocks[1].type === "text" && blocks[1].heading === "Group Coaching" && blocks[1].body === "Round up some friends." && blocks[1].style?.theme === "dark");
  assert.ok(blocks[2].type === "booking" && blocks[2].screen === "group-lessons");
  const other = blocksOfSection(sectionsOf(section("", `<h2>Elsewhere</h2><iframe src="https://book.claritygolf.app/someone-else?embed=booking"></iframe>`))[0], options).map((entry) => entry.block);
  assert.ok(other[1].type === "embed", "another business's booking page is an embed, not this one's booking block");
});

test("an article's body becomes text, picture and video blocks in order", () => {
  const blocks = blocksOfBody(`<p>First.</p><p>Second.</p><h4>A heading</h4><p>Third.</p><img data-src="https://cdn.example/p.jpg"><p>Fourth.</p><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>`).map((entry) => entry.block);
  assert.deepEqual(blocks.map((block) => block.type), ["text", "text", "image", "text", "video"]);
  assert.ok(blocks[0].type === "text" && blocks[0].body === "First.\n\nSecond." && blocks[1].type === "text" && blocks[1].heading === "A heading" && blocks[1].body === "Third.");
  assert.ok(blocks[4].type === "video" && blocks[4].youtubeId === "dQw4w9WgXcQ");
});

test("the header gives its menu, social links and button; a video page gives up its YouTube id", () => {
  const header = headerOf(`<header id="header"><div class="header-nav-item"><a href="/">Home</a></div><div class="header-nav-item"><a href="/store">Store</a></div><div class="header-nav-item"><a href="/store">Store again</a></div><a href="https://www.instagram.com/riversidegolf"><svg></svg></a><a class="btn" href="/book">Book Now</a></header>`);
  assert.deepEqual(header.links, [{ label: "Home", href: "/" }, { label: "Store", href: "/store" }]);
  assert.deepEqual(header.social, [{ kind: "instagram", url: "https://www.instagram.com/riversidegolf" }]);
  assert.deepEqual(header.button, { label: "Book Now", href: "/book" });
  assert.equal(youtubeIdIn(`...url=https%3A%2F%2Fwww.youtube.com%2Fembed%2FneYfj2DzbY8%3Ffeature%3Doembed...`), "neYfj2DzbY8");
  assert.equal(youtubeIdIn("<p>no video</p>"), "");
});

test("the sitemap gives the pages worth bringing, home first, without tags, store items or categories", () => {
  const sitemap = `<urlset>${["/articles/one", "/articles/tag/Golf", "/home", "/store", "/store/p/book", "/store/ebook", "/contact", "https://other.example/x"].map((path) => `<url><loc>${path.startsWith("http") ? path : `https://www.riverside.example${path}`}</loc></url>`).join("")}</urlset>`;
  assert.deepEqual(pagePathsOf(sitemap, "https://www.riverside.example"), ["/home", "/articles/one", "/store", "/contact"]);
});

test("a whole site comes over at its own addresses, with the menu in the old order, and what could not be read is reported", async () => {
  const siteHtml = (title: string, body: string, description = "") =>
    `<html><head><title>${title} — Riverside Golf</title>${description ? `<meta name="description" content="${description}">` : ""}</head><body><header id="header"><div class="header-nav-item"><a href="/">Home</a></div><div class="header-nav-item"><a href="/articles">Articles</a></div><div class="header-nav-item"><a href="/contact">Contact</a></div><a href="https://www.facebook.com/riverside">f</a><a class="btn" href="/contact">Book Now</a></header><main>${body}${footer}</main></body></html>`;
  const files: Record<string, { json?: unknown; html?: string }> = {
    "/": { json: { website: { siteTitle: "Riverside Golf" }, collection: { title: "Home", fullUrl: "/", typeName: "page" } }, html: siteHtml("Riverside Golf", section("", `<img src="https://cdn.example/sam.jpg"><p>Sam coaches here.</p><a class="sqs-button-element" href="/store/p/voucher">Vouchers</a>`), "Golf lessons by the river") },
    "/contact": { json: { collection: { title: "Contact", fullUrl: "/contact", typeName: "page" } }, html: siteHtml("Contact", section("", `<h2>Contact us.</h2><p>hi@riverside.example</p>`)) },
    "/articles": { json: { collection: { title: "Articles", fullUrl: "/articles", typeName: "blog-side-by-side", description: "Tips" }, items: [{}] }, html: siteHtml("Articles", "") },
    "/articles/one": { json: { collection: { typeName: "blog-side-by-side" }, item: { title: "One", fullUrl: "/articles/one", publishOn: Date.UTC(2023, 2, 26), excerpt: "<p>About one</p>", body: "<p>Body of one.</p>", assetUrl: "https://cdn.example/one.jpg", seoData: { seoTitle: "Article One", seoDescription: "Read one" } } }, html: siteHtml("One", "") },
    "/videos/v/flow": { json: { collection: { typeName: "lessons" }, item: { title: "Flow", fullUrl: "/videos/v/flow", publishOn: Date.UTC(2022, 2, 19), excerpt: "<p>Flow it.</p>" } }, html: siteHtml("Flow", `<a href="https://www.youtube.com/watch?v=neYfj2DzbY8">v</a>`) },
  };
  const sitemap = `<urlset>${["/", "/contact", "/articles", "/articles/one", "/videos/v/flow", "/broken"].map((path) => `<url><loc>https://www.riverside.example${path}</loc></url>`).join("")}</urlset>`;
  const fetched: string[] = [];
  const uploaded: string[] = [];
  const result = await importSquarespaceSite({
    url: "www.riverside.example",
    preset: "ember",
    bookingSlug: "riverside",
    upload: async (type) => {
      uploaded.push(type);
      return `https://bucket.example/${uploaded.length}.jpg`;
    },
    fetch: async (url) => {
      fetched.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === "/sitemap.xml") return new Response(sitemap, { status: 200 });
      if (parsed.hostname === "cdn.example") return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
      const file = files[parsed.pathname];
      if (!file) return new Response("gone", { status: 404 });
      if (parsed.searchParams.get("format") === "json") return new Response(JSON.stringify(file.json), { status: 200 });
      return new Response(file.html || "", { status: 200 });
    },
  });
  assert.deepEqual(result.pages.map((page) => [page.slug, page.kind, page.inNav]), [
    ["home", "page", true],
    ["articles", "page", true],
    ["contact", "page", true],
    ["articles/one", "article", false],
    ["videos/v/flow", "video", false],
  ]);
  assert.equal(result.settings.theme.preset, "ember");
  assert.deepEqual(result.settings.header.button, { label: "Book Now", href: "page:contact", style: "primary" });
  assert.deepEqual(result.settings.header.social, [{ kind: "facebook", url: "https://www.facebook.com/riverside" }]);
  const home = result.pages[0].content;
  assert.equal(home.description, "Golf lessons by the river");
  assert.ok(home.blocks[0].type === "hero" && home.blocks[0].image?.url === "https://bucket.example/1.jpg", "the hero's picture was brought into the bucket");
  assert.ok(home.blocks[0].type === "hero" && home.blocks[0].buttons[0].href === "https://www.riverside.example/store/p/voucher", "a link to a page that did not come over goes back to the old site");
  const article = result.pages[3].content;
  assert.deepEqual([article.seoTitle, article.description, article.summary, article.date], ["Article One", "Read one", "About one", "2023-03-26"]);
  assert.ok(article.cover?.url.startsWith("https://bucket.example/"));
  assert.equal(result.pages[4].content.video, "neYfj2DzbY8");
  assert.ok(result.report.some((line) => line.includes("Skipped /broken")), "the unreadable page is reported");
  assert.ok(result.report[0].startsWith("5 pages came over"));
  assert.ok(fetched.every((url) => url.startsWith("https://www.riverside.example") || url.startsWith("https://cdn.example")), "only the site and its pictures are read");
});

test("an address that is not an https site is refused before anything is read", async () => {
  await assert.rejects(() => importSquarespaceSite({ url: "ftp://x", preset: "classic", bookingSlug: "r", fetch: async () => new Response("") }), /https/);
  await assert.rejects(() => importSquarespaceSite({ url: "nonsense", preset: "classic", bookingSlug: "r", fetch: async () => new Response("") }), /https|address/);
});
