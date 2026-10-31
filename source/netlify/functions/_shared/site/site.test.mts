import assert from "node:assert/strict";
import test from "node:test";

import { setDatabaseForTests } from "../database.mts";
import {
  MAX_SITE_BLOCKS,
  SITE_BLOCK_TYPES,
  cleanSiteDocument,
  cleanSiteHref,
  googleFontsUrl,
  newSiteBlock,
  siteDocumentImageUrls,
  siteYoutubeId,
  themeFromPreset,
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
import { accountIdForHostname, claimSiteDomain, readSitePage, saveSitePage } from "./store.mts";

// --- The document -----------------------------------------------------------

test("a page is cleaned to its known blocks, in order, with unique ids", () => {
  const document = cleanSiteDocument({
    blocks: [
      { id: "a", type: "hero", heading: "  Hello  " },
      { id: "a", type: "text", body: "twice the same id" },
      { id: "x", type: "marquee", text: "not a block this page knows" },
      { id: "b", type: "divider" },
    ],
  });
  assert.deepEqual(
    document.blocks.map((block) => [block.id, block.type]),
    [
      ["a", "hero"],
      ["a-1", "text"],
      ["b", "divider"],
    ],
  );
  assert.equal(document.blocks[0].type === "hero" && document.blocks[0].heading, "Hello");
});

test("every block type has a starter that survives cleaning unchanged", () => {
  for (const type of SITE_BLOCK_TYPES) {
    const block = newSiteBlock(type);
    const [cleaned] = cleanSiteDocument({ blocks: [block] }).blocks;
    assert.deepEqual(cleaned, block, `${type} starter changed when cleaned`);
  }
});

test("links a stranger will click are http(s), mailto, tel or an anchor, never script", () => {
  assert.equal(cleanSiteHref("javascript:alert(1)"), "");
  assert.equal(cleanSiteHref("data:text/html,hi"), "");
  assert.equal(cleanSiteHref("/relative/path"), "");
  assert.equal(cleanSiteHref("#contact"), "#contact");
  assert.equal(cleanSiteHref("mailto:coach@example.com"), "mailto:coach@example.com");
  assert.equal(cleanSiteHref("tel:+64 21 555 0100"), "tel:+64 21 555 0100");
  assert.equal(cleanSiteHref("yourclub.com/lessons"), "https://yourclub.com/lessons");
  assert.equal(cleanSiteHref("http://yourclub.com"), "http://yourclub.com/");
});

test("pictures are https only, and a block keeps its button while it still has a label", () => {
  const document = cleanSiteDocument({
    blocks: [
      { type: "image", image: { url: "http://insecure.example.com/a.jpg", alt: "x" } },
      { type: "image", image: { url: "https://cdn.example.com/a.jpg", alt: "x" } },
      { type: "cta", heading: "Go", button: { label: "Book", href: "javascript:void(0)" } },
      { type: "cta", heading: "Go", button: { label: "", href: "https://example.com" } },
    ],
  });
  assert.equal(document.blocks[0].type === "image" && document.blocks[0].image, null);
  assert.equal(document.blocks[1].type === "image" && document.blocks[1].image?.url, "https://cdn.example.com/a.jpg");
  assert.deepEqual(document.blocks[2].type === "cta" && document.blocks[2].button, { label: "Book", href: "", style: "primary" });
  assert.equal(document.blocks[3].type === "cta" && document.blocks[3].button, null);
  assert.deepEqual(siteDocumentImageUrls(document), ["https://cdn.example.com/a.jpg"]);
});

test("the theme only speaks six-digit hex, known fonts and known options", () => {
  const theme = cleanSiteDocument({
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
  assert.equal(theme.colors.text, slate.colors.text);
  assert.equal(theme.corners, slate.corners);
  assert.equal(theme.width, "wide");
  assert.equal(theme.buttons, "pill");
  assert.equal(cleanSiteDocument({ theme: { preset: "no-such-preset" } }).theme.preset, themeFromPreset("").preset);
});

test("fonts load from Google only when a chosen font needs it", () => {
  assert.equal(googleFontsUrl({ headingFont: "system", bodyFont: "system" }), "");
  const url = googleFontsUrl({ headingFont: "playfair", bodyFont: "playfair" });
  assert.match(url, /^https:\/\/fonts\.googleapis\.com\/css2\?family=Playfair\+Display/);
  assert.equal(url.split("family=").length - 1, 1, "the same font is not requested twice");
});

test("the block list is capped and a video block only keeps a real YouTube id", () => {
  const blocks = Array.from({ length: MAX_SITE_BLOCKS + 5 }, () => ({ type: "divider" }));
  assert.equal(cleanSiteDocument({ blocks }).blocks.length, MAX_SITE_BLOCKS);
  assert.equal(siteYoutubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10"), "dQw4w9WgXcQ");
  assert.equal(siteYoutubeId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(siteYoutubeId("https://vimeo.com/12345"), "");
  const [video] = cleanSiteDocument({ blocks: [{ type: "video", youtubeUrl: "https://youtu.be/dQw4w9WgXcQ" }] }).blocks;
  assert.equal(video.type === "video" && video.youtubeId, "dQw4w9WgXcQ");
});

test("booking blocks keep their embed height inside sensible bounds", () => {
  const [low, high, none] = cleanSiteDocument({
    blocks: [
      { type: "booking", height: 10 },
      { type: "booking", height: 99999 },
      { type: "booking" },
    ],
  }).blocks;
  assert.equal(low.type === "booking" && low.height, 480);
  assert.equal(high.type === "booking" && high.height, 1600);
  assert.equal(none.type === "booking" && none.height, 760);
});

// --- Templates --------------------------------------------------------------

const templateInput = {
  businessName: "Riverside Golf",
  coachName: "Sam",
  bookingHref: "https://book.claritygolf.app/riverside?embed=booking",
  email: "hello@riverside.example",
  phone: "+64 21 000 0000",
  venueName: "Riverside Range",
};

for (const template of SITE_TEMPLATES) {
  test(`template "${template.id}" builds a page the cleaner would store as is`, () => {
    const document = template.build(templateInput);
    assert.deepEqual(cleanSiteDocument(document), document);
    assert.ok(document.blocks.length >= 3, "a template is more than a blank page");
    assert.equal(document.template, template.id);
    assert.equal(document.title, "Riverside Golf");
    // Every "Book" button points at the business's own booking page.
    const bookButtons = document.blocks.flatMap((block) =>
      block.type === "hero" ? block.buttons : block.type === "cta" && block.button ? [block.button] : [],
    );
    assert.ok(bookButtons.some((button) => button.href === templateInput.bookingHref), "no button points at the booking page");
    assert.equal(document.header.button?.href, templateInput.bookingHref);
    // Block ids are unique: anchors like #contact depend on it.
    assert.equal(new Set(document.blocks.map((block) => block.id)).size, document.blocks.length);
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

test("uploads land in the business's own folder and come back as public addresses", async () => {
  const previous = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = "https://proj.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  try {
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
  } finally {
    process.env.SUPABASE_URL = previous.url ?? "";
    process.env.SUPABASE_SERVICE_ROLE_KEY = previous.key ?? "";
  }
});

test("the sweep removes old uploads nothing refers to, and leaves fresh ones alone", async () => {
  const previous = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = "https://proj.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  try {
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
  } finally {
    process.env.SUPABASE_URL = previous.url ?? "";
    process.env.SUPABASE_SERVICE_ROLE_KEY = previous.key ?? "";
  }
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
  setDatabaseForTests({
    async sql(strings: TemplateStringsArray, ...values: unknown[]) {
      let text = "";
      strings.forEach((part, index) => {
        text += part;
        if (index < values.length) text += `$${index + 1}`;
      });
      return record(text, values);
    },
    pool: { async query(text: string, values: unknown[] = []) { return { rows: record(text, values) }; } },
  });
  return issued;
}

test("every page read and write names its business in the statement itself", async () => {
  const issued = fakeDatabase((text, values) => {
    if (text.startsWith("SELECT") && values[0] !== "riverside") return [];
    return [{ id: "page-1", account_id: "riverside", slug: "home", document: { blocks: [] }, published_document: null, published_at: null, created_at: new Date(), updated_at: new Date() }];
  });
  try {
    assert.equal(await readSitePage(""), null, "no business, no read");
    assert.equal(issued.length, 0);
    const page = await readSitePage("riverside");
    assert.equal(page?.accountId, "riverside");
    assert.match(issued[0].text, /WHERE account_id = \$1 AND slug = \$2/);
    assert.deepEqual(issued[0].values, ["riverside", "home"]);

    await saveSitePage("riverside", { blocks: [{ type: "divider" }] });
    const write = issued[1];
    assert.match(write.text, /INSERT INTO site_pages/);
    assert.equal(write.values[1], "riverside");
    assert.match(write.text, /ON CONFLICT \(account_id, slug\)/);
    await assert.rejects(() => saveSitePage("", {}), /accountId is required/);
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
      return values[0] === "www.live.example" ? [{ id: "domain-1", account_id: "riverside", hostname: "www.live.example", verification_token: "t", status: "active", created_at: new Date() }] : [];
    }
    if (text.startsWith("INSERT INTO site_domains")) {
      return [{ id: values[0], account_id: values[1], hostname: values[2], verification_token: values[3], status: "pending", created_at: new Date() }];
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

test("a missing bucket is made on the first upload, then the upload is retried", async () => {
  const previous = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = "https://proj.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  try {
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
  } finally {
    process.env.SUPABASE_URL = previous.url ?? "";
    process.env.SUPABASE_SERVICE_ROLE_KEY = previous.key ?? "";
  }
});
