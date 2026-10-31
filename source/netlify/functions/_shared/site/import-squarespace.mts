/**
 * Bring a Squarespace site into the builder.
 *
 * WHAT IT READS
 *
 * A Squarespace site answers every page with `?format=json`: the page's
 * collection (its title, address, kind) and, for a blog post or a video, the
 * item with its body, date, summary, picture and search settings. A 7.1 page's
 * sections are not in that JSON, only in the HTML, so the HTML is read too:
 * its <title> and meta tags for every page, and its page-sections for a plain
 * page. The sitemap says which pages exist.
 *
 * WHAT IT MAKES
 *
 * One page of the site per page found, at the same address ("articles/how-
 * to-practice" stays "articles/how-to-practice", so old links and search
 * results keep working): articles as article pages, video lessons as video
 * pages (their YouTube id read from the page), a blog index as an Articles
 * block, a video library as a Videos block, the store as a Shop block, and a
 * plain page's sections as blocks chosen by what the section holds. Pictures
 * are brought into the site's own bucket, so the site outlives the old one.
 * What the reader could not place is reported rather than invented.
 *
 * This module has no opinion about the account: the caller passes how to
 * upload a picture and which business the booking pages belong to.
 */

import {
  HOME_PAGE_SLUG,
  SITE_BOOKING_SCREENS,
  cleanInstagramHandle,
  cleanPageSlug,
  cleanSitePageContent,
  cleanSiteSettings,
  embedSource,
  siteId,
  siteYoutubeId,
  themeFromPreset,
  type SiteBlockInput,
  type SiteBlockStyle,
  type SiteBookingScreen,
  type SiteImage,
  type SitePage,
  type SitePageKind,
  type SiteSettings,
  type SiteSocialLink,
} from "./document.mts";

export type ImportFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type ImportUpload = (type: string, dataBase64: string) => Promise<string>;

export type ImportInput = {
  url: string;
  preset: string;
  /** The business's slug, so its own booking frames become Booking blocks. */
  bookingSlug: string;
  fetch?: ImportFetch;
};

export type ImportedSite = {
  settings: SiteSettings;
  pages: Array<Omit<SitePage, "id" | "sortOrder">>;
  /** The old site's pictures the pages still point at, for bringPictures to fetch in batches afterwards. */
  pictures: string[];
  report: string[];
};

/** How many pages are read at once. A function call has seconds, not minutes, so pages come in parallel. */
const PAGE_CONCURRENCY = 6;

export class ImportError extends Error {
  status = 400;
}

const MAX_PAGES = 60;
const MAX_IMAGES = 80;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "image/jpeg", "image/png": "image/png", "image/webp": "image/webp", "image/gif": "image/gif" };

// --- Small HTML helpers -------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©" };

export function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
}

/** The words of a fragment, with line breaks where the markup had them and the tags gone. */
export function textOf(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|h[1-6]|li|div|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function attr(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return decodeEntities(match?.[1] ?? match?.[2] ?? "");
}

/** A Squarespace CDN picture without its size suffix, so the full one is read. */
function pictureUrl(src: string): string {
  const url = src.trim().replace(/\?.*$/, "");
  return /^https:\/\//.test(url) ? url : "";
}

// --- What a section holds ----------------------------------------------------

type Piece =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "image"; src: string; alt: string; href: string }
  | { kind: "frame"; src: string }
  | { kind: "button"; label: string; href: string }
  | { kind: "link"; label: string; href: string };

/** The parts of a fragment of page in the order they appear. */
export function piecesOf(fragment: string): Piece[] {
  const pieces: Piece[] = [];
  const pattern = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>|<p\b[^>]*>([\s\S]*?)<\/p>|<li\b[^>]*>([\s\S]*?)<\/li>|<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>|(<a\b[^>]*>)([\s\S]*?)<\/a>|(<img\b[^>]*>)|(<iframe\b[^>]*>)/gi;
  let linkDepthUntil = -1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(fragment))) {
    const at = match.index;
    if (match[1]) {
      const text = textOf(match[2]);
      if (text) pieces.push({ kind: "heading", level: Number(match[1][1]), text });
      continue;
    }
    if (match[3] !== undefined) {
      const text = textOf(match[3]);
      if (text) pieces.push({ kind: "paragraph", text });
      continue;
    }
    if (match[4] !== undefined) {
      // A list item holding headings, pictures or paragraphs is a card, not a bullet: read inside it.
      if (/<(h[1-6]|p|img|iframe)\b/i.test(match[4])) {
        pattern.lastIndex = at + match[0].indexOf(">") + 1;
        continue;
      }
      const text = textOf(match[4]);
      if (text) pieces.push({ kind: "paragraph", text: `• ${text}` });
      continue;
    }
    if (match[5] !== undefined) {
      const text = textOf(match[5]);
      if (text) pieces.push({ kind: "paragraph", text: `“${text}”` });
      continue;
    }
    if (match[6]) {
      const tag = match[6];
      const href = attr(tag, "href");
      const inner = match[7];
      const image = inner.match(/<img\b[^>]*>/i);
      if (image) {
        const src = pictureUrl(attr(image[0], "data-src") || attr(image[0], "src"));
        if (src) pieces.push({ kind: "image", src, alt: attr(image[0], "alt"), href });
        linkDepthUntil = at + match[0].length;
        continue;
      }
      const label = textOf(inner);
      if (!label || !href) continue;
      pieces.push({ kind: /sqs-button-element|\bbtn\b|button/i.test(attr(tag, "class")) ? "button" : "link", label, href });
      linkDepthUntil = at + match[0].length;
      continue;
    }
    if (match[8]) {
      if (at < linkDepthUntil) continue;
      const src = pictureUrl(attr(match[8], "data-src") || attr(match[8], "src"));
      if (src) pieces.push({ kind: "image", src, alt: attr(match[8], "alt"), href: "" });
      continue;
    }
    if (match[9]) {
      const src = attr(match[9], "src");
      if (src) pieces.push({ kind: "frame", src });
    }
  }
  // A paragraph that is only a link's words appears twice: once as the link, once as the paragraph.
  return pieces.filter((piece, index) => !(piece.kind === "paragraph" && pieces[index - 1]?.kind === "button" && pieces[index - 1].kind === "button" && (pieces[index - 1] as { label: string }).label === piece.text));
}

/** The page-sections of a Squarespace 7.1 page, each with its theme and background picture. */
export function sectionsOf(html: string): Array<{ theme: string; background: string; html: string }> {
  const starts: number[] = [];
  const pattern = /<section\b[^>]*\bpage-section\b/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) starts.push(match.index);
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : html.indexOf("</main>", start) > 0 ? html.indexOf("</main>", start) : html.length;
    const section = html.slice(start, end);
    const open = section.match(/<section\b[^>]*>/i)?.[0] || "";
    const background = section.match(/class="section-background"[^>]*>[\s\S]{0,400}?<img\b[^>]*(?:data-src|src)="([^"?]+)/i)?.[1] || "";
    return { theme: attr(open, "data-section-theme"), background: pictureUrl(background), html: section };
  });
}

/** The <title> and the meta tags a page carries. */
export function metaOf(html: string, siteName: string): { title: string; description: string; image: string } {
  const rawTitle = textOf(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "");
  const title = rawTitle.replace(new RegExp(`\\s*[—–|-]\\s*${siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "").trim();
  const meta = (name: string) => {
    const tag = html.match(new RegExp(`<meta\\s+(?:name|property)="${name}"[^>]*>`, "i"))?.[0] || "";
    return tag ? attr(tag, "content").trim() : "";
  };
  return {
    title: title === siteName ? "" : title,
    description: meta("description") || meta("og:description"),
    image: pictureUrl(meta("og:image").replace(/^http:/, "https:")),
  };
}

// --- Sections into blocks ------------------------------------------------------

function styleFor(theme: string): Partial<SiteBlockStyle> {
  if (/black|dark/i.test(theme)) return { theme: "dark" };
  if (/white/i.test(theme)) return { theme: "white" };
  if (/light|bright/i.test(theme)) return { theme: "light" };
  return {};
}

const DAY = /\b(mon|tue|wed|thu|thur|fri|sat|sun)[a-z]*\b/i;
const CLARITY_BOOKING = /^https:\/\/book\.claritygolf\.app\/([^/?#]+)?\/?([^/?#]*)/i;

type Imported = { block: SiteBlockInput & { style?: Partial<SiteBlockStyle> }; images: string[] };

/** A Clarity booking frame's screen, or null when the frame is another system's. */
function bookingScreenOf(src: string, bookingSlug: string): SiteBookingScreen | null {
  const match = src.match(CLARITY_BOOKING);
  if (!match) return null;
  const [, business = "", screen = ""] = match;
  if (business && business !== bookingSlug && !SITE_BOOKING_SCREENS.includes(business as SiteBookingScreen)) return null;
  const candidate = SITE_BOOKING_SCREENS.includes(business as SiteBookingScreen) ? business : screen;
  return (SITE_BOOKING_SCREENS.find((known) => known === candidate) ?? "main") as SiteBookingScreen;
}

function frameHeight(src: string): number {
  return /layout=compact/.test(src) ? 600 : 760;
}

function image(src: string, alt = ""): SiteImage | null {
  return src ? { url: src, alt } : null;
}

function button(label: string, href: string) {
  return { label: label.slice(0, 60), href: mapHref(href), style: "primary" as const };
}

/** A link on the old site: a page of it becomes a page link; anything else stays an address. */
function mapHref(href: string): string {
  const value = href.trim().replace(/^\/https?:\/\//, "https://");
  if (!value || value === "#") return "";
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (sameSite(url.hostname)) return pageLink(url.pathname);
      return value;
    } catch {
      return "";
    }
  }
  if (value.startsWith("/")) return pageLink(value);
  if (/^(mailto|tel):/i.test(value)) return value;
  return "";
}

let siteHost = "";
function sameSite(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return Boolean(siteHost) && host === siteHost;
}
function pageLink(pathname: string): string {
  const slug = cleanPageSlug(pathname.replace(/^\/+/, "") || HOME_PAGE_SLUG, "");
  return slug ? `page:${slug === "" ? HOME_PAGE_SLUG : slug}` : "";
}

/**
 * The blocks a section becomes, from what it holds. Each rule looks at the
 * shape of the content, not its words: a row of small pictures with a line
 * each is a Logos block whatever it is called.
 */
export function blocksOfSection(section: { theme: string; background: string; html: string }, options: { bookingSlug: string; first: boolean; report: string[]; siteName?: string; instagram?: string }): Imported[] {
  const pieces = piecesOf(section.html).filter((piece) => !(piece.kind === "image" && piece.src === section.background));
  const style: Partial<SiteBlockStyle> = { ...styleFor(section.theme), ...(section.background ? { background: image(section.background), overlay: 40 } : {}) };
  const headings = pieces.filter((piece) => piece.kind === "heading");
  const paragraphs = pieces.filter((piece) => piece.kind === "paragraph");
  const images = pieces.filter((piece) => piece.kind === "image");
  const frames = pieces.filter((piece) => piece.kind === "frame");
  const buttons = pieces.filter((piece) => piece.kind === "button" || piece.kind === "link");
  const out: Imported[] = [];
  const id = (prefix: string) => siteId(prefix);
  const instagram = images.filter((piece) => /instagram\.com/i.test(piece.href));
  // An email or phone is written as words, or as a mailto:/tel: link.
  const lines = pieces.flatMap((piece) => (piece.kind === "paragraph" || piece.kind === "heading" ? piece.text.split("\n") : piece.kind === "link" || piece.kind === "button" ? [piece.href.replace(/^(mailto|tel):/i, ""), piece.label] : []));
  const email = lines.find((line) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line)) || "";
  const phone = lines.find((line) => /^\+?[0-9 ()-]{7,20}$/.test(line)) || "";
  const isContactLine = (line: string) => line === email || line === phone;
  const words = pieces
    .filter((piece): piece is Extract<Piece, { kind: "paragraph" | "heading" }> => piece.kind === "paragraph" || piece.kind === "heading")
    .map((piece) => ({ ...piece, text: piece.text.split("\n").filter((line) => !isContactLine(line)).join("\n") }))
    .filter((piece) => piece.text);

  // Nothing at all: skip.
  if (!headings.length && !paragraphs.length && !images.length && !frames.length) return out;

  // A footer repeated at the bottom of every page: the business name and an email, nothing else.
  if (!frames.length && !images.length && (email || phone) && words.length <= 2 && words.every((piece) => piece.text.length <= 40)) {
    return out;
  }

  // Venues: more than one frame with venue headings and opening hours between them.
  if (frames.length >= 2 && headings.length >= 2 && paragraphs.some((piece) => DAY.test(piece.text))) {
    const venues: Array<{ id: string; name: string; address: string; hours: string; text: string; showMap: boolean; booking: "none" | SiteBookingScreen; embedUrl: string; height: number }> = [];
    let current: (typeof venues)[number] | null = null;
    const intro = headings[0].level <= 2 ? headings[0].text : "";
    for (const piece of pieces) {
      if (piece.kind === "heading" && (piece.text !== intro || current)) {
        if (current && !current.hours && !current.embedUrl && current.booking === "none" && piece.level > 3) {
          current.name = `${current.name} · ${piece.text}`;
          continue;
        }
        current = { id: id("venue"), name: piece.text, address: "", hours: "", text: "", showMap: false, booking: "none", embedUrl: "", height: 760 };
        venues.push(current);
      } else if (piece.kind === "paragraph" && current) {
        if (DAY.test(piece.text)) current.hours = current.hours ? `${current.hours}\n${piece.text}` : piece.text;
        else if (!current.address && piece.text.length <= 80) {
          // The first plain line under a venue's name is where it is: the map finds it.
          current.address = piece.text;
          current.showMap = true;
        } else current.text = current.text ? `${current.text}\n\n${piece.text}` : piece.text;
      } else if (piece.kind === "frame" && current) {
        const screen = bookingScreenOf(piece.src, options.bookingSlug);
        if (screen) current.booking = screen;
        else current.embedUrl = embedSource(piece.src).url;
        current.height = frameHeight(piece.src);
      }
    }
    // A grid lays both venues' hours out before the second venue's name. Hours
    // that start the week again are the next venue's, when it has none.
    for (let index = 0; index + 1 < venues.length; index += 1) {
      const groups = hoursGroups(venues[index].hours);
      if (groups.length > 1 && !venues[index + 1].hours) {
        venues[index + 1].hours = groups.slice(1).join("\n");
        venues[index].hours = groups[0];
      }
    }
    const filled = venues.filter((venue) => venue.hours || venue.embedUrl || venue.booking !== "none");
    if (filled.length >= 2) {
      out.push({ block: { id: id("venues"), type: "venues", heading: intro, intro: "", columns: 2, items: filled.slice(0, 6), style }, images: [] });
      return out;
    }
  }

  // Contact: an email or phone with a heading, and maybe a booking frame.
  if ((email || phone) && headings.length && images.length === 0 && paragraphs.length <= 4) {
    const rest = words.filter((piece) => piece.kind === "paragraph").map((piece) => piece.text).join("\n\n");
    out.push({
      block: { id: id("contact"), type: "contact", heading: headings[0].text, text: rest.slice(0, 600), email, phone, address: "", hours: "", showMap: false, style },
      images: [],
    });
    for (const frame of frames) out.push(frameBlock(frame.src, options.bookingSlug, "", style, id));
    return out;
  }

  // Instagram: pictures linking to posts, or a heading that says so.
  if (instagram.length >= 3 || (images.length >= 4 && headings.some((h) => /instagram/i.test(h.text)))) {
    const handle = cleanInstagramHandle(pieces.find((piece): piece is Extract<Piece, { kind: "link" | "button" | "image" }> => "href" in piece && /instagram\.com\/[A-Za-z0-9._]+\/?$/i.test(piece.href))?.href || options.instagram || "");
    const items = images.slice(0, 12).map((piece) => ({ id: id("post"), image: image(piece.src, piece.alt), href: /instagram\.com\/p\//i.test(piece.href) ? piece.href : "" }));
    out.push({ block: { id: id("instagram"), type: "instagram", heading: headings[0]?.text || "Follow on Instagram", handle, items, columns: 4, style }, images: items.map((item) => item.image!.url) });
    return out;
  }

  // Cards: repeated picture, heading, line, button.
  const cardGroups = groupCards(pieces).length >= 2 ? groupCards(pieces) : zipCards(pieces);
  if (cardGroups.length >= 2) {
    const intro = headings[0].level <= 2 && !cardGroups.some((card) => card.title === headings[0].text) ? headings[0].text : "";
    const items = cardGroups.slice(0, 8).map((card) => ({ id: id("card"), image: image(card.image, card.title), title: card.title, text: card.text, button: card.button ? button(card.button.label, card.button.href) : null }));
    out.push({ block: { id: id("cards"), type: "cards", heading: intro, intro: "", columns: Math.min(4, Math.max(2, items.length)) as 2 | 3 | 4, items, style }, images: items.flatMap((item) => (item.image ? [item.image.url] : [])) });
    return out;
  }

  // Logos: small pictures with one short line each.
  if (images.length >= 2 && paragraphs.length >= images.length && paragraphs.every((piece) => piece.text.length <= 60) && headings.length <= 1 && !buttons.length) {
    const captions = paragraphs.map((piece) => piece.text);
    const items = images.slice(0, 8).map((piece, index) => ({ id: id("logo"), image: image(piece.src, piece.alt), caption: captions[index] || "", href: piece.href && !sameSite(hostOf(piece.href)) ? piece.href : "" }));
    out.push({ block: { id: id("logos"), type: "logos", heading: headings[0]?.text || "", intro: "", size: "regular", items, style }, images: items.map((item) => item.image!.url) });
    return out;
  }

  // Reviews or a gallery: a heading, pictures, little else.
  if (images.length >= 3 && paragraphs.length <= 1) {
    const heading = headings[0]?.text || "";
    const link = buttons[0];
    if (/review|feedback|testimonial|say/i.test(heading)) {
      const items = images.slice(0, 12).map((piece) => ({ id: id("review"), quote: "", name: reviewerName(piece), role: "", image: image(piece.src, piece.alt) }));
      out.push({ block: { id: id("reviews"), type: "testimonials", heading, intro: "", items, button: link ? button(link.label, link.href) : null, style }, images: items.map((item) => item.image!.url) });
    } else {
      const pictures = images.slice(0, 12).map((piece) => ({ url: piece.src, alt: piece.alt }));
      out.push({ block: { id: id("gallery"), type: "gallery", heading, images: pictures, columns: pictures.length >= 6 ? 4 : 3, button: link ? button(link.label, link.href) : null, style }, images: pictures.map((picture) => picture.url) });
    }
    return out;
  }

  // The first section of a page with one picture and words: a hero.
  if (options.first && images.length <= 1 && (headings.length || paragraphs.length) && !frames.length) {
    const heading = headings[0]?.text || options.siteName || "";
    const body = paragraphs.map((piece) => piece.text).join("\n\n");
    const picture = images[0];
    out.push({
      block: {
        id: id("hero"),
        type: "hero",
        eyebrow: headings.length > 1 && headings[0].level > headings[1].level ? headings[0].text : "",
        heading: headings.length > 1 && headings[0].level > headings[1].level ? headings[1].text : heading,
        text: body.slice(0, 1000),
        image: picture ? image(picture.src, picture.alt) : null,
        layout: picture ? "split" : "left",
        height: "regular",
        buttons: buttons.slice(0, 2).map((piece, index) => ({ ...button(piece.label, piece.href), style: index === 0 ? ("primary" as const) : ("secondary" as const) })),
        style,
      },
      images: picture ? [picture.src] : [],
    });
    if (body.length > 1000) out.push({ block: { id: id("text"), type: "text", heading: "", body: body.slice(1000), align: "left", columns: 1 }, images: [] });
    return out;
  }

  // Otherwise: the words as one text block (first heading above, later headings as lines of their own),
  // then the pictures, then the frames, then any button as a call to action.
  const firstWords = pieces.findIndex((piece) => piece.kind === "heading" || piece.kind === "paragraph");
  const leading = images.filter((piece) => pieces.indexOf(piece) < firstWords);
  const picture = (piece: Extract<Piece, { kind: "image" }>): Imported => ({ block: { id: id("image"), type: "image", image: image(piece.src, piece.alt), caption: "", size: "wide", style }, images: [piece.src] });
  for (const piece of leading) out.push(picture(piece));
  if (words.length) {
    const [first, ...others] = words;
    const heading = first.kind === "heading" ? first.text : "";
    const body = (first.kind === "heading" ? others : words).map((piece) => piece.text).join("\n\n");
    out.push({ block: { id: id("text"), type: "text", heading, body: body.slice(0, 8000), align: "left", columns: 1, style }, images: [] });
  }
  for (const piece of images) if (!leading.includes(piece)) out.push(picture(piece));
  for (const piece of frames) out.push(frameBlock(piece.src, options.bookingSlug, "", style, id));
  for (const piece of buttons.filter((entry) => entry.kind === "button" && entry.href !== "#")) {
    out.push({ block: { id: id("cta"), type: "cta", heading: "", text: "", button: button(piece.label, piece.href), tone: "surface", style }, images: [] });
  }
  return out;
}

const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Lines of opening hours split where the week starts over. */
export function hoursGroups(hours: string): string[] {
  const groups: string[][] = [];
  let last = -1;
  for (const line of hours.split("\n").filter(Boolean)) {
    const day = DAY_ORDER.indexOf((line.match(DAY)?.[1] || "").slice(0, 3).toLowerCase());
    if (!groups.length || (day >= 0 && day <= last)) groups.push([]);
    groups[groups.length - 1].push(line);
    if (day >= 0) last = day;
  }
  return groups.map((group) => group.join("\n"));
}

/** Who a review screenshot is from: its alt text, or the file's name ("Les+Laban+Review") when the alt is only "Google Review". */
function reviewerName(piece: Extract<Piece, { kind: "image" }>): string {
  const fromAlt = piece.alt.replace(/\b(google|facebook|customer)?\s*reviews?\b/gi, "").trim();
  if (fromAlt) return fromAlt.slice(0, 80);
  const file = decodeURIComponent(piece.src.split("/").pop() || "").replace(/\+/g, " ").replace(/\.[a-z0-9]+$/i, "");
  const fromFile = file.replace(/\b(google|facebook|customer)?\s*reviews?\b/gi, "").replace(/[-_]/g, " ").trim();
  return /^[A-Za-z][A-Za-z .'-]{1,60}$/.test(fromFile) && !/^(image asset|screenshot)/i.test(fromFile) ? fromFile : "";
}

function hostOf(href: string): string {
  try {
    return new URL(href).hostname;
  } catch {
    return "";
  }
}

/** A frame on the old page: the business's own booking page becomes a Booking block, anything else an Embed. */
function frameBlock(src: string, bookingSlug: string, heading: string, style: Partial<SiteBlockStyle>, id: (prefix: string) => string): Imported {
  const screen = bookingScreenOf(src, bookingSlug);
  if (screen) {
    return { block: { id: id("booking"), type: "booking", heading, text: "", screen, mode: "embed", buttonLabel: "Book now", height: frameHeight(src), style }, images: [] };
  }
  const source = embedSource(src);
  return { block: { id: id("embed"), type: "embed", heading, text: "", url: source.url, code: "", height: 760, style }, images: [] };
}

type Card = { image: string; title: string; text: string; button: { label: string; href: string } | null };

/**
 * Cards whose parts arrive grouped by kind rather than by card (a grid lays
 * its pictures out first, then its headings): as many headings as pictures,
 * each with a line and maybe a button, zipped up in order.
 */
function zipCards(pieces: Piece[]): Card[] {
  const headings = pieces.filter((piece): piece is Extract<Piece, { kind: "heading" }> => piece.kind === "heading" && piece.level >= 2);
  const images = pieces.filter((piece): piece is Extract<Piece, { kind: "image" }> => piece.kind === "image");
  const buttons = pieces.filter((piece): piece is Extract<Piece, { kind: "button" }> => piece.kind === "button" && piece.href !== "#" && piece.label !== "");
  if (headings.length < 2 || images.length !== headings.length) return [];
  // Each heading's line is the paragraph that follows it, if one does before the next heading.
  const cards: Card[] = headings.map((heading, index) => {
    const at = pieces.indexOf(heading);
    const next = pieces.slice(at + 1).find((piece) => piece.kind === "heading" || piece.kind === "paragraph");
    const text = next?.kind === "paragraph" ? next.text : "";
    const button = buttons[index] || null;
    return { image: images[index].src, title: heading.text, text: text.slice(0, 400), button: button ? { label: button.label, href: button.href } : null };
  });
  return cards.length >= 2 ? cards : [];
}

/** Runs of picture → heading → line → button, two or more of them. */
function groupCards(pieces: Piece[]): Card[] {
  const cards: Card[] = [];
  let current: Card | null = null;
  for (const piece of pieces) {
    if (piece.kind === "image") {
      if (current && (current.title || current.text)) cards.push(current);
      current = { image: piece.src, title: "", text: "", button: null };
    } else if (piece.kind === "heading" && piece.level >= 2) {
      if (!current || current.title) {
        if (current && (current.title || current.text)) cards.push(current);
        current = { image: "", title: "", text: "", button: null };
      }
      current.title = piece.text;
    } else if (piece.kind === "paragraph" && current && current.title && piece.text.length <= 400) {
      current.text = current.text ? `${current.text} ${piece.text}` : piece.text;
    } else if ((piece.kind === "button" || piece.kind === "link") && current && current.title) {
      if (!current.button) current.button = { label: piece.label, href: piece.href };
    }
  }
  if (current && (current.title || current.text)) cards.push(current);
  const complete = cards.filter((card) => card.title && (card.image || card.button));
  return complete.length >= 2 && complete.length === cards.filter((card) => card.title).length ? complete : [];
}

// --- An article's body into blocks ------------------------------------------------

export function blocksOfBody(body: string): Imported[] {
  const out: Imported[] = [];
  let heading = "";
  let paragraphs: string[] = [];
  const flush = () => {
    if (!heading && !paragraphs.length) return;
    out.push({ block: { id: siteId("text"), type: "text", heading, body: paragraphs.join("\n\n").slice(0, 8000), align: "left", columns: 1 }, images: [] });
    heading = "";
    paragraphs = [];
  };
  for (const piece of piecesOf(body)) {
    if (piece.kind === "heading") {
      flush();
      heading = piece.text;
    } else if (piece.kind === "paragraph") {
      paragraphs.push(piece.text);
    } else if (piece.kind === "image") {
      flush();
      out.push({ block: { id: siteId("image"), type: "image", image: image(piece.src, piece.alt), caption: "", size: "wide" }, images: [piece.src] });
    } else if (piece.kind === "frame") {
      flush();
      const youtube = siteYoutubeId(piece.src);
      if (youtube) out.push({ block: { id: siteId("video"), type: "video", heading: "", youtubeId: youtube, caption: "" }, images: [] });
      else out.push({ block: { id: siteId("embed"), type: "embed", heading: "", text: "", url: embedSource(piece.src).url, code: "", height: 600 }, images: [] });
    } else if (piece.kind === "link" && paragraphs.length === 0 && !heading) {
      // A bare link between paragraphs: keep its words and address.
      paragraphs.push(`${piece.label}: ${piece.href}`);
    }
  }
  flush();
  return out;
}

// --- Reading the old site -------------------------------------------------------------

type Collection = { title?: string; navigationTitle?: string; urlId?: string; fullUrl?: string; typeName?: string; description?: string };
type Item = {
  title?: string;
  urlId?: string;
  fullUrl?: string;
  publishOn?: number;
  excerpt?: string;
  body?: string;
  assetUrl?: string;
  seoData?: { seoTitle?: string; seoDescription?: string; seoImage?: { assetUrl?: string } } | null;
};
type PageJson = { collection?: Collection; item?: Item; items?: Item[]; website?: { siteTitle?: string } };

function timeout(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function readText(doFetch: ImportFetch, url: string, accept: string): Promise<string> {
  const response = await doFetch(url, { headers: { accept, "user-agent": "Mozilla/5.0 (compatible; ClarityImport/1.0)" }, redirect: "follow", signal: timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new ImportError(`${url} answered ${response.status}.`);
  const text = await response.text();
  if (text.length > MAX_HTML_BYTES) throw new ImportError(`${url} is too large to read.`);
  return text;
}

function dateOf(ms: number | undefined): string {
  return ms ? new Date(ms).toISOString().slice(0, 10) : "";
}

/** The addresses in a sitemap worth a page each: no tag listings, no store items or categories. */
export function pagePathsOf(sitemap: string, origin: string): string[] {
  const host = new URL(origin).hostname.replace(/^www\./, "");
  const paths = [...sitemap.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
    .map((match) => {
      try {
        const url = new URL(decodeEntities(match[1]));
        if (url.hostname.replace(/^www\./, "") !== host) return null;
        return url.pathname.replace(/\/+$/, "") || "/";
      } catch {
        return null;
      }
    })
    .filter((path): path is string => path !== null)
    .filter((path) => !/\/tag\/|\/category\/|\/store\/p\/|\/store\/[^/]+$|\/\?/.test(path));
  const unique = [...new Set(paths)];
  // The home page first, then everything in sitemap order.
  unique.sort((a, b) => (a === "/" || a === "/home" ? -1 : b === "/" || b === "/home" ? 1 : 0));
  return unique.slice(0, MAX_PAGES);
}

export async function importSquarespaceSite(input: ImportInput): Promise<ImportedSite> {
  const doFetch: ImportFetch = input.fetch || ((url, init) => fetch(url, init));
  let origin: URL;
  try {
    origin = new URL(/^https?:\/\//i.test(input.url) ? input.url : `https://${input.url}`);
  } catch {
    throw new ImportError("That is not a website address.");
  }
  if (origin.protocol !== "https:" || !origin.hostname.includes(".")) throw new ImportError("The address must be an https website.");
  siteHost = origin.hostname.toLowerCase().replace(/^www\./, "");
  const base = origin.origin;
  const report: string[] = [];

  const sitemap = await readText(doFetch, `${base}/sitemap.xml`, "application/xml,text/xml").catch(() => "");
  const paths = sitemap ? pagePathsOf(sitemap, base) : ["/"];
  if (!paths.length) throw new ImportError("No pages were found at that address.");

  const pages: ImportedSite["pages"] = [];
  const imagesToBring = new Map<string, Array<(url: string) => void>>();
  let siteName = "";
  let header: { links: Array<{ label: string; href: string }>; social: SiteSocialLink[]; button: { label: string; href: string } | null } = { links: [], social: [], button: null };
  let footerText = "";
  const seen = new Set<string>();

  const bring = (imported: Imported, assign?: (urls: string[]) => void) => {
    for (const url of imported.images) if (!imagesToBring.has(url)) imagesToBring.set(url, []);
    void assign;
  };

  // Every page is read up front, a few at a time, so the whole import fits in
  // the seconds a function call has. The pages are then walked in sitemap order.
  const fetched = new Map<string, { json: PageJson; html: string } | Error>();
  await Promise.all(
    Array.from({ length: Math.min(PAGE_CONCURRENCY, paths.length) }, async (_, worker) => {
      for (let index = worker; index < paths.length; index += PAGE_CONCURRENCY) {
        const path = paths[index];
        const pageUrl = `${base}${path === "/" ? "" : path}`;
        try {
          const [json, html] = await Promise.all([
            readText(doFetch, `${pageUrl}?format=json`, "application/json").then((text) => JSON.parse(text) as PageJson),
            readText(doFetch, pageUrl, "text/html"),
          ]);
          fetched.set(path, { json, html });
        } catch (error) {
          fetched.set(path, error instanceof Error ? error : new Error("could not read it"));
        }
      }
    }),
  );

  for (const path of paths) {
    const read = fetched.get(path);
    if (!read || read instanceof Error) {
      report.push(`Skipped ${path}: ${read instanceof Error ? read.message : "could not read it"}.`);
      continue;
    }
    const { json, html } = read;
    siteName = siteName || json.website?.siteTitle || textOf(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "").split(/\s[—–|-]\s/).pop() || "";
    if (!header.links.length) header = headerOf(html);
    const collection = json.collection || {};
    const meta = metaOf(html, siteName);
    const typeName = String(collection.typeName || "");
    const item = json.item;
    const fullPath = (item?.fullUrl || collection.fullUrl || path).replace(/\/+$/, "") || "/";
    const slug = fullPath === "/" || fullPath === "/home" ? HOME_PAGE_SLUG : cleanPageSlug(fullPath.replace(/^\/+/, ""), "");
    if (!slug) {
      report.push(`Skipped ${path}: its address cannot be used here.`);
      continue;
    }
    // A category or filter of a page already read is that page.
    if (seen.has(slug)) continue;
    seen.add(slug);

    const page = (kind: SitePageKind, title: string, blocks: Imported[], extra: Record<string, unknown> = {}, inNav = true) => {
      for (const block of blocks) bring(block);
      const built: Omit<SitePage, "id" | "sortOrder"> = {
        slug,
        title: (title || collection.navigationTitle || collection.title || slug).slice(0, 120),
        kind,
        inNav,
        content: cleanSitePageContent({
          description: meta.description,
          seoTitle: meta.title,
          socialImage: meta.image ? image(meta.image) : null,
          ...extra,
          blocks: blocks.map((entry) => entry.block),
        }),
      };
      if (meta.image) register(imagesToBring, meta.image);
      if (built.content.cover) register(imagesToBring, built.content.cover.url);
      pages.push(built);
    };

    if (item && /^blog/.test(typeName)) {
      const seo = item.seoData || {};
      page("article", item.title || "", blocksOfBody(item.body || ""), {
        summary: textOf(item.excerpt || ""),
        date: dateOf(item.publishOn),
        cover: item.assetUrl ? image(pictureUrl(item.assetUrl)) : null,
        description: seo.seoDescription || meta.description,
        seoTitle: seo.seoTitle || meta.title,
      }, false);
      continue;
    }
    if (item && typeName === "lessons") {
      const youtube = youtubeIdIn(html);
      if (!youtube) report.push(`${path}: the video is not on YouTube, so the page has its words but no player. Add a YouTube link to it.`);
      const words = textOf(item.excerpt || "") || textOf(item.body || "");
      page("video", item.title || "", words ? [{ block: { id: siteId("text"), type: "text", heading: "", body: words, align: "left", columns: 1 }, images: [] }] : [], {
        summary: textOf(item.excerpt || "").slice(0, 400),
        date: dateOf(item.publishOn),
        video: youtube,
        cover: null,
      }, false);
      continue;
    }
    if (/^blog/.test(typeName) && json.items) {
      page("page", collection.navigationTitle || collection.title || "", [
        { block: { id: siteId("hero"), type: "hero", eyebrow: "", heading: collection.title || "Articles", text: textOf(collection.description || ""), image: null, layout: "left", height: "regular", buttons: [] }, images: [] },
        { block: { id: siteId("articles"), type: "articles", heading: "", intro: "", limit: 24 }, images: [] },
      ]);
      continue;
    }
    if (typeName === "lessons") {
      const sections = sectionsOf(html);
      const lead = sections.length ? blocksOfSection(sections[0], { bookingSlug: input.bookingSlug, first: true, report, siteName }).filter((entry) => entry.block.type === "hero" || entry.block.type === "text") : [];
      page("page", collection.navigationTitle || collection.title || "", [
        ...(lead.length ? lead.slice(0, 1) : [{ block: { id: siteId("hero"), type: "hero", eyebrow: "", heading: collection.title || "Videos", text: "", image: null, layout: "left", height: "regular", buttons: [] }, images: [] } as Imported]),
        { block: { id: siteId("videos"), type: "videos", heading: "", intro: "", limit: 24, layout: "list" }, images: [] },
      ]);
      continue;
    }
    if (typeName === "products") {
      const count = Array.isArray(json.items) ? json.items.length : 0;
      if (count) report.push(`${path}: ${count} products were on the old store. Vouchers and packages are already sold by your shop; add the rest under Billing › Products and tick "Sell on your website".`);
      page("page", collection.navigationTitle || collection.title || "Store", [
        { block: { id: siteId("shop"), type: "shop", heading: collection.title || "Store", intro: "", mode: "cards", height: 900 }, images: [] },
      ]);
      continue;
    }

    // A plain page: its sections, in order.
    const sections = sectionsOf(html);
    if (!sections.length) {
      report.push(`${path}: nothing could be read from the page, so it was added empty.`);
      page("page", collection.navigationTitle || collection.title || "", []);
      continue;
    }
    const instagram = header.social.find((entry) => entry.kind === "instagram")?.url || "";
    const blocks = sections.flatMap((section, index) => blocksOfSection(section, { bookingSlug: input.bookingSlug, first: index === 0 && slug === HOME_PAGE_SLUG, report, siteName, instagram }));
    const footer = sections[sections.length - 1];
    if (!footerText) footerText = textOf(footer.html).split("\n").find((line) => line && !line.includes("@")) || "";
    page("page", collection.navigationTitle || collection.title || "", blocks);
  }

  if (!pages.some((page) => page.slug === HOME_PAGE_SLUG)) {
    const first = pages[0];
    if (first) first.slug = HOME_PAGE_SLUG;
    else throw new ImportError("No pages could be read from that site.");
  }

  // Pictures stay at their old addresses for now; the caller brings them over
  // in batches with bringPictures, each batch its own short call.
  const pictures = [...imagesToBring.keys()].slice(0, MAX_IMAGES);
  if (imagesToBring.size > MAX_IMAGES) report.push(`${imagesToBring.size - MAX_IMAGES} pictures beyond the first ${MAX_IMAGES} stay at their old addresses.`);

  // A link to a page of the old site that did not come over (a store item, a
  // tag listing) leads to the nearest page above it, or back to the old site.
  const slugs = new Set(pages.map((page) => page.slug));
  const settle = (href: string): string => {
    if (!href.startsWith("page:")) return href;
    let slug = href.slice(5);
    while (slug && !slugs.has(slug)) slug = slug.includes("/") ? slug.slice(0, slug.lastIndexOf("/")) : "";
    return slug ? `page:${slug}` : `${base}/${href.slice(5)}`;
  };
  for (const page of pages) {
    page.content = cleanSitePageContent(JSON.parse(JSON.stringify(page.content, (key, value) => (key === "href" && typeof value === "string" ? settle(value) : value))));
  }
  const inNav = new Set<string>();
  const extraLinks: Array<{ label: string; href: string }> = [];
  for (const link of header.links) {
    const href = mapHref(link.href);
    const slug = href.startsWith("page:") ? href.slice(5) : "";
    if (slug && slugs.has(slug)) inNav.add(slug);
    else if (href && !href.startsWith("page:")) extraLinks.push({ label: link.label, href });
  }
  const order = (page: (typeof pages)[number]) => {
    if (page.slug === HOME_PAGE_SLUG) return -1;
    const at = header.links.findIndex((link) => mapHref(link.href) === `page:${page.slug}`);
    return at < 0 ? 999 : at;
  };
  const ordered = [...pages].sort((a, b) => order(a) - order(b) || pages.indexOf(a) - pages.indexOf(b));
  for (const page of ordered) if (page.kind === "page") page.inNav = inNav.size ? inNav.has(page.slug) || page.slug === HOME_PAGE_SLUG : true;

  const headerButton = header.button ? { label: header.button.label.slice(0, 40), href: mapHref(header.button.href), style: "primary" as const } : null;
  const settings = cleanSiteSettings({
    theme: themeFromPreset(input.preset),
    header: {
      showLogo: true,
      showName: true,
      links: extraLinks.slice(0, 6),
      button: headerButton?.href ? headerButton : null,
      sticky: true,
      transparent: false,
      social: header.social,
      shopPage: ordered.find((page) => page.content.blocks.some((block) => block.type === "shop"))?.slug || "",
    },
    footer: { text: footerText || `© ${siteName}`, links: [], social: header.social, showCredit: true },
  });

  report.unshift(`${ordered.length} pages came over from ${siteHost}: ${ordered.filter((p) => p.kind === "page").length} pages, ${ordered.filter((p) => p.kind === "article").length} articles, ${ordered.filter((p) => p.kind === "video").length} videos.`);
  return { settings, pages: ordered, pictures, report };
}

/**
 * A batch of the old site's pictures brought into the bucket: each address
 * mapped to its new one. One that cannot be read is reported and left as it
 * was, so a broken picture never stops the rest.
 */
export async function bringPictures(urls: string[], upload: ImportUpload, doFetch: ImportFetch = (url, init) => fetch(url, init)): Promise<{ moved: Record<string, string>; report: string[] }> {
  const moved: Record<string, string> = {};
  const report: string[] = [];
  await Promise.all(
    urls.slice(0, 8).map(async (url) => {
      if (!/^https:\/\//.test(url)) return;
      try {
        moved[url] = await bringImage(doFetch, upload, url);
      } catch (error) {
        report.push(`A picture stays at its old address (${url.slice(0, 80)}…): ${error instanceof Error ? error.message : "could not be read"}.`);
      }
    }),
  );
  return { moved, report };
}

/** A page's content with every moved picture at its new address. */
export function replacePictureUrls<T>(value: T, moved: Record<string, string>): T {
  return JSON.parse(JSON.stringify(value, (key, entry) => (typeof entry === "string" && moved[entry] ? moved[entry] : entry))) as T;
}

function register(map: Map<string, Array<(url: string) => void>>, url: string) {
  if (url && !map.has(url)) map.set(url, []);
}

/** The old header: its menu links, social links and button. */
export function headerOf(html: string): { links: Array<{ label: string; href: string }>; social: SiteSocialLink[]; button: { label: string; href: string } | null } {
  const header = html.match(/<header\b[^>]*>[\s\S]*?<\/header>/i)?.[0] || "";
  const links: Array<{ label: string; href: string }> = [];
  const seen = new Set<string>();
  for (const match of header.matchAll(/<div class="header-nav-item[^"]*"[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(match[1], "href");
    const label = textOf(match[2]);
    if (!href || !label || seen.has(href)) continue;
    seen.add(href);
    links.push({ label, href });
  }
  const social: SiteSocialLink[] = [];
  const kinds: Array<[RegExp, SiteSocialLink["kind"]]> = [
    [/instagram\.com/i, "instagram"],
    [/facebook\.com/i, "facebook"],
    [/youtube\.com|youtu\.be/i, "youtube"],
    [/tiktok\.com/i, "tiktok"],
    [/linkedin\.com/i, "linkedin"],
    [/(?:twitter|x)\.com/i, "x"],
  ];
  for (const match of header.matchAll(/<a\b[^>]*href="(https?:\/\/[^"]+)"/gi)) {
    const kind = kinds.find(([pattern]) => pattern.test(match[1]))?.[1];
    if (kind && !social.some((entry) => entry.kind === kind)) social.push({ kind, url: match[1] });
  }
  const buttonMatch = header.match(/<a\b([^>]*class="[^"]*\bbtn\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/i);
  const button = buttonMatch ? { label: textOf(buttonMatch[2]), href: attr(buttonMatch[1], "href") } : null;
  return { links, social, button: button?.label ? button : null };
}

/** The first YouTube video on a page: an embed, an oEmbed reference or a watch link. */
export function youtubeIdIn(html: string): string {
  const found =
    html.match(/youtube(?:-nocookie)?\.com(?:%2F|\/)embed(?:%2F|\/)([A-Za-z0-9_-]{11})/i)?.[1] ||
    html.match(/youtube\.com(?:%2F|\/)watch(?:%3F|\?)v(?:%3D|=)([A-Za-z0-9_-]{11})/i)?.[1] ||
    html.match(/youtu\.be(?:%2F|\/)([A-Za-z0-9_-]{11})/i)?.[1] ||
    "";
  return siteYoutubeId(found);
}

/** A picture read from the old site and uploaded into the bucket. */
async function bringImage(doFetch: ImportFetch, upload: ImportUpload, url: string): Promise<string> {
  const response = await doFetch(`${url}?format=1500w`, { headers: { accept: "image/*" }, redirect: "follow", signal: timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`answered ${response.status}`);
  const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_TYPES[type]) throw new Error(`is ${type || "not a picture"}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error("arrived empty");
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("is too large");
  return upload(type, Buffer.from(bytes).toString("base64"));
}
