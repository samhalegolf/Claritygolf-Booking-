/**
 * The shape of a business's website.
 *
 * Shared by the server (which cleans every write with these functions), the
 * editor in Settings › Website (which builds pages out of these blocks) and
 * the public page (which renders them), so no end can disagree about what a
 * block is. Same bargain as _shared/review-document.mts.
 *
 * A site is its settings (theme, header, footer) and a set of pages. A page
 * is a slug, a title, whether it sits in the menu, and an ordered list of
 * blocks. Every string that reaches a stranger's browser passes through here
 * first: unknown block types are dropped, every link is http(s)/mailto/tel,
 * an anchor or another page of the site, and every list is capped. Nothing
 * here touches the network or the database.
 */

const text = (value: unknown, max = 600) => String(value ?? "").trim().slice(0, max);

export const SITE_DOCUMENT_VERSION = 1;

/**
 * The hosts Clarity itself answers on. A coach cannot claim one of these as
 * their domain, and the page entry point treats any hostname outside them as
 * a business's own domain serving its page.
 */
export const CLARITY_HOST_SUFFIXES = ["claritygolf.app", "netlify.app", "localhost"];

/** True for Clarity's own hosts, a local run, and anything that is not a domain name at all. */
export function isClarityHost(hostname: string): boolean {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host || !host.includes(".")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return true;
  return CLARITY_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}
/** Generous, but bounded: the page is one JSON column. */
export const MAX_SITE_BLOCKS = 40;

// --- Fonts ------------------------------------------------------------------

export type SiteFontId =
  | "system"
  | "inter"
  | "dm-sans"
  | "manrope"
  | "nunito"
  | "montserrat"
  | "space-grotesk"
  | "oswald"
  | "playfair"
  | "lora"
  | "merriweather"
  | "cormorant";

export type SiteFont = {
  id: SiteFontId;
  label: string;
  /** The CSS font-family value, fallbacks included. */
  family: string;
  /** The Google Fonts css2 `family=` fragment, or null for a system font. */
  google: string | null;
};

export const SITE_FONTS: readonly SiteFont[] = [
  { id: "system", label: "System", family: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif", google: null },
  { id: "inter", label: "Inter", family: "'Inter', ui-sans-serif, system-ui, sans-serif", google: "Inter:wght@400;500;600;700" },
  { id: "dm-sans", label: "DM Sans", family: "'DM Sans', ui-sans-serif, system-ui, sans-serif", google: "DM+Sans:wght@400;500;600;700" },
  { id: "manrope", label: "Manrope", family: "'Manrope', ui-sans-serif, system-ui, sans-serif", google: "Manrope:wght@400;500;600;700;800" },
  { id: "nunito", label: "Nunito", family: "'Nunito', ui-sans-serif, system-ui, sans-serif", google: "Nunito:wght@400;600;700;800" },
  { id: "montserrat", label: "Montserrat", family: "'Montserrat', ui-sans-serif, system-ui, sans-serif", google: "Montserrat:wght@400;500;600;700;800" },
  { id: "space-grotesk", label: "Space Grotesk", family: "'Space Grotesk', ui-sans-serif, system-ui, sans-serif", google: "Space+Grotesk:wght@400;500;600;700" },
  { id: "oswald", label: "Oswald", family: "'Oswald', ui-sans-serif, system-ui, sans-serif", google: "Oswald:wght@400;500;600;700" },
  { id: "playfair", label: "Playfair Display", family: "'Playfair Display', ui-serif, Georgia, serif", google: "Playfair+Display:wght@400;600;700;800" },
  { id: "lora", label: "Lora", family: "'Lora', ui-serif, Georgia, serif", google: "Lora:wght@400;500;600;700" },
  { id: "merriweather", label: "Merriweather", family: "'Merriweather', ui-serif, Georgia, serif", google: "Merriweather:wght@300;400;700" },
  { id: "cormorant", label: "Cormorant Garamond", family: "'Cormorant Garamond', ui-serif, Georgia, serif", google: "Cormorant+Garamond:wght@400;500;600;700" },
];

const FONT_IDS = new Set<string>(SITE_FONTS.map((font) => font.id));

export function siteFont(id: string): SiteFont {
  return SITE_FONTS.find((font) => font.id === id) || SITE_FONTS[0];
}

/** The Google Fonts stylesheet for a theme's two fonts, or "" when both are system. */
export function googleFontsUrl(theme: Pick<SiteTheme, "headingFont" | "bodyFont">): string {
  const families = [...new Set([siteFont(theme.headingFont).google, siteFont(theme.bodyFont).google].filter(Boolean))];
  if (!families.length) return "";
  return `https://fonts.googleapis.com/css2?${families.map((family) => `family=${family}`).join("&")}&display=swap`;
}

// --- Theme ------------------------------------------------------------------

export type SiteColors = {
  background: string;
  surface: string;
  text: string;
  muted: string;
  primary: string;
  onPrimary: string;
  accent: string;
};

export type SiteTheme = {
  /** The preset this started from. Informational: the colours are the truth. */
  preset: string;
  headingFont: SiteFontId;
  bodyFont: SiteFontId;
  colors: SiteColors;
  corners: "sharp" | "soft" | "round";
  width: "narrow" | "regular" | "wide";
  buttons: "filled" | "outline" | "pill";
  spacing: "compact" | "regular" | "airy";
};

export type SiteThemePreset = {
  id: string;
  label: string;
  theme: Omit<SiteTheme, "preset">;
};

export const SITE_THEME_PRESETS: readonly SiteThemePreset[] = [
  {
    id: "fairway",
    label: "Fairway",
    theme: {
      headingFont: "playfair",
      bodyFont: "inter",
      colors: { background: "#f6f7f2", surface: "#ffffff", text: "#14201a", muted: "#5d6b63", primary: "#1f6f43", onPrimary: "#ffffff", accent: "#c9a227" },
      corners: "soft",
      width: "regular",
      buttons: "filled",
      spacing: "regular",
    },
  },
  {
    id: "slate",
    label: "Slate",
    theme: {
      headingFont: "manrope",
      bodyFont: "inter",
      colors: { background: "#ffffff", surface: "#f4f5f7", text: "#111827", muted: "#6b7280", primary: "#111827", onPrimary: "#ffffff", accent: "#2563eb" },
      corners: "sharp",
      width: "regular",
      buttons: "filled",
      spacing: "regular",
    },
  },
  {
    id: "sand",
    label: "Sand",
    theme: {
      headingFont: "cormorant",
      bodyFont: "nunito",
      colors: { background: "#faf6ef", surface: "#ffffff", text: "#2b2419", muted: "#7a6e5f", primary: "#b4532a", onPrimary: "#ffffff", accent: "#2d6a4f" },
      corners: "round",
      width: "regular",
      buttons: "pill",
      spacing: "airy",
    },
  },
  {
    id: "midnight",
    label: "Midnight",
    theme: {
      headingFont: "space-grotesk",
      bodyFont: "inter",
      colors: { background: "#0f1a14", surface: "#16241c", text: "#f3f6f1", muted: "#a8b3aa", primary: "#58c48a", onPrimary: "#0b140f", accent: "#e9c46a" },
      corners: "soft",
      width: "wide",
      buttons: "filled",
      spacing: "regular",
    },
  },
  {
    id: "ivory",
    label: "Ivory",
    theme: {
      headingFont: "playfair",
      bodyFont: "lora",
      colors: { background: "#fffdf8", surface: "#f6f1e7", text: "#1f1d1a", muted: "#6f6861", primary: "#1f1d1a", onPrimary: "#ffffff", accent: "#8c6a3f" },
      corners: "sharp",
      width: "narrow",
      buttons: "outline",
      spacing: "airy",
    },
  },
  {
    id: "coastal",
    label: "Coastal",
    theme: {
      headingFont: "montserrat",
      bodyFont: "dm-sans",
      colors: { background: "#f3f8fa", surface: "#ffffff", text: "#0f2a3a", muted: "#587283", primary: "#0f6e8c", onPrimary: "#ffffff", accent: "#f2a541" },
      corners: "round",
      width: "regular",
      buttons: "pill",
      spacing: "regular",
    },
  },
];

export function themeFromPreset(id: string): SiteTheme {
  const preset = SITE_THEME_PRESETS.find((candidate) => candidate.id === id) || SITE_THEME_PRESETS[0];
  return { preset: preset.id, ...structuredClone(preset.theme) };
}

/** A six-digit hex colour, or the fallback. The one colour format the theme speaks. */
export function cleanColor(value: unknown, fallback: string): string {
  const raw = text(value, 9).toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/.test(raw)) return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  return fallback;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return (options as readonly string[]).includes(String(value)) ? (value as T) : fallback;
}

export function cleanTheme(value: unknown): SiteTheme {
  const input = (value || {}) as Record<string, unknown>;
  const base = themeFromPreset(text(input.preset, 40));
  const colors = (input.colors || {}) as Record<string, unknown>;
  return {
    preset: base.preset,
    headingFont: FONT_IDS.has(String(input.headingFont)) ? (input.headingFont as SiteFontId) : base.headingFont,
    bodyFont: FONT_IDS.has(String(input.bodyFont)) ? (input.bodyFont as SiteFontId) : base.bodyFont,
    colors: {
      background: cleanColor(colors.background, base.colors.background),
      surface: cleanColor(colors.surface, base.colors.surface),
      text: cleanColor(colors.text, base.colors.text),
      muted: cleanColor(colors.muted, base.colors.muted),
      primary: cleanColor(colors.primary, base.colors.primary),
      onPrimary: cleanColor(colors.onPrimary, base.colors.onPrimary),
      accent: cleanColor(colors.accent, base.colors.accent),
    },
    corners: oneOf(input.corners, ["sharp", "soft", "round"], base.corners),
    width: oneOf(input.width, ["narrow", "regular", "wide"], base.width),
    buttons: oneOf(input.buttons, ["filled", "outline", "pill"], base.buttons),
    spacing: oneOf(input.spacing, ["compact", "regular", "airy"], base.spacing),
  };
}

// --- Links, images, buttons -------------------------------------------------

/** A link to another page of the site: page:<slug>. Resolved to a path where it is drawn. */
export const PAGE_HREF_PREFIX = "page:";

export function pageHref(slug: string): string {
  return `${PAGE_HREF_PREFIX}${slug}`;
}

/** The page a page: link names, or "" for any other kind of link. */
export function pageSlugFromHref(href: string): string {
  return href.startsWith(PAGE_HREF_PREFIX) ? href.slice(PAGE_HREF_PREFIX.length) : "";
}

/**
 * A link a stranger will click. http(s), mailto: and tel: pass; a bare domain
 * is given https; an in-page anchor (#contact) and a page of the site
 * (page:about) pass as they are. Anything else -- javascript:, data:, a
 * relative path that means nothing on another domain -- is dropped.
 */
export function cleanSiteHref(input: unknown): string {
  const value = text(input, 2000);
  if (!value) return "";
  if (/^#[A-Za-z0-9_-]{1,80}$/.test(value)) return value;
  if (value.startsWith(PAGE_HREF_PREFIX)) {
    const slug = cleanPageSlug(value.slice(PAGE_HREF_PREFIX.length));
    return slug ? pageHref(slug) : "";
  }
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(value)) return value;
  if (/^tel:\+?[0-9() .-]{3,30}$/i.test(value)) return value;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (!url.hostname.includes(".")) return "";
    return url.toString();
  } catch {
    return "";
  }
}

/**
 * An image address: https only, since the page itself is served over https
 * and a plain-http picture would be blocked as mixed content. Uploads land as
 * https URLs on the storage bucket; a coach may also paste one.
 */
export function cleanImageUrl(input: unknown): string {
  const value = text(input, 2000);
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export type SiteImage = { url: string; alt: string };

export function cleanImage(value: unknown): SiteImage | null {
  const input = (value || {}) as Record<string, unknown>;
  const url = cleanImageUrl(input.url);
  return url ? { url, alt: text(input.alt, 200) } : null;
}

function cleanImages(value: unknown, max: number): SiteImage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).map(cleanImage).filter((image): image is SiteImage => Boolean(image));
}

export type SiteButton = { label: string; href: string; style: "primary" | "secondary" };

/**
 * A button is kept while it has a label: the coach has just added it and is
 * about to type the address. The page skips a button with no address.
 */
export function cleanButton(value: unknown): SiteButton | null {
  const input = (value || {}) as Record<string, unknown>;
  const label = text(input.label, 60);
  if (!label) return null;
  return { label, href: cleanSiteHref(input.href), style: oneOf(input.style, ["primary", "secondary"], "primary") };
}

function cleanButtons(value: unknown, max: number): SiteButton[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).map(cleanButton).filter((button): button is SiteButton => Boolean(button));
}

export type SiteLink = { label: string; href: string };

function cleanLinks(value: unknown, max: number): SiteLink[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, max)
    .map((entry) => {
      const input = (entry || {}) as Record<string, unknown>;
      return { label: text(input.label, 60), href: cleanSiteHref(input.href) };
    })
    .filter((link) => link.label);
}

function cleanList<T>(value: unknown, max: number, clean: (entry: Record<string, unknown>, index: number) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, max)
    .map((entry, index) => clean((entry || {}) as Record<string, unknown>, index))
    .filter((entry): entry is T => entry !== null);
}

// --- Blocks -----------------------------------------------------------------

/** The icons a feature may wear. Rendered by name from the lucide set. */
export const SITE_FEATURE_ICONS = [
  "flag",
  "target",
  "trophy",
  "users",
  "video",
  "calendar",
  "map-pin",
  "star",
  "clock",
  "heart",
  "zap",
  "award",
  "graduation-cap",
  "line-chart",
  "shield",
  "sun",
] as const;
export type SiteFeatureIcon = (typeof SITE_FEATURE_ICONS)[number];

/** The booking screens a booking block can point at. Mirrors BOOKING_SCREENS. */
export const SITE_BOOKING_SCREENS = ["main", "group-lessons", "private-lessons"] as const;
export type SiteBookingScreen = (typeof SITE_BOOKING_SCREENS)[number];

export const SITE_SOCIAL_KINDS = ["instagram", "facebook", "youtube", "tiktok", "x", "linkedin"] as const;
export type SiteSocialKind = (typeof SITE_SOCIAL_KINDS)[number];

export type SiteHeroBlock = {
  id: string;
  type: "hero";
  eyebrow: string;
  heading: string;
  text: string;
  image: SiteImage | null;
  layout: "centre" | "left" | "split" | "cover";
  height: "regular" | "tall";
  buttons: SiteButton[];
};
export type SiteTextBlock = { id: string; type: "text"; heading: string; body: string; align: "left" | "centre"; columns: 1 | 2 };
export type SiteImageBlock = { id: string; type: "image"; image: SiteImage | null; caption: string; size: "inset" | "wide" | "full" };
export type SiteGalleryBlock = { id: string; type: "gallery"; heading: string; images: SiteImage[]; columns: 2 | 3 | 4 };
export type SiteFeatureItem = { id: string; icon: SiteFeatureIcon; title: string; text: string };
export type SiteFeaturesBlock = { id: string; type: "features"; heading: string; intro: string; items: SiteFeatureItem[]; columns: 2 | 3 };
export type SitePriceItem = { id: string; name: string; price: string; detail: string; features: string; button: SiteButton | null; highlighted: boolean };
export type SitePricingBlock = { id: string; type: "pricing"; heading: string; intro: string; items: SitePriceItem[] };
export type SiteTestimonial = { id: string; quote: string; name: string; role: string };
export type SiteTestimonialsBlock = { id: string; type: "testimonials"; heading: string; items: SiteTestimonial[] };
export type SiteFaqItem = { id: string; question: string; answer: string };
export type SiteFaqBlock = { id: string; type: "faq"; heading: string; intro: string; items: SiteFaqItem[] };
export type SiteCtaBlock = { id: string; type: "cta"; heading: string; text: string; button: SiteButton | null; tone: "primary" | "surface" };
export type SiteVideoBlock = { id: string; type: "video"; heading: string; youtubeId: string; caption: string };
export type SiteBookingBlock = {
  id: string;
  type: "booking";
  heading: string;
  text: string;
  screen: SiteBookingScreen;
  mode: "embed" | "button";
  buttonLabel: string;
  height: number;
};
export type SiteContactBlock = {
  id: string;
  type: "contact";
  heading: string;
  text: string;
  email: string;
  phone: string;
  address: string;
  hours: string;
  showMap: boolean;
};
export type SiteDividerBlock = { id: string; type: "divider"; style: "line" | "space"; size: "small" | "regular" | "large" };
/** The site's article pages, newest first, as cards. */
export type SiteArticlesBlock = { id: string; type: "articles"; heading: string; intro: string; limit: number };
/**
 * The business's online shop (packages and gift vouchers), on the page.
 * "cards" draws what is for sale in the site's own look and takes the order
 * here; "embed" frames Clarity's shop page instead.
 */
export type SiteShopBlock = { id: string; type: "shop"; heading: string; intro: string; mode: "cards" | "embed"; height: number };

export type SiteBlock =
  | SiteHeroBlock
  | SiteTextBlock
  | SiteImageBlock
  | SiteGalleryBlock
  | SiteFeaturesBlock
  | SitePricingBlock
  | SiteTestimonialsBlock
  | SiteFaqBlock
  | SiteCtaBlock
  | SiteVideoBlock
  | SiteBookingBlock
  | SiteContactBlock
  | SiteDividerBlock
  | SiteArticlesBlock
  | SiteShopBlock;
export type SiteBlockType = SiteBlock["type"];

export const SITE_BLOCK_TYPES: readonly SiteBlockType[] = [
  "hero",
  "text",
  "image",
  "gallery",
  "features",
  "pricing",
  "testimonials",
  "faq",
  "cta",
  "video",
  "booking",
  "contact",
  "divider",
  "articles",
  "shop",
];

export type SiteHeader = {
  showLogo: boolean;
  showName: boolean;
  links: SiteLink[];
  button: SiteButton | null;
  sticky: boolean;
};

export type SiteSocialLink = { kind: SiteSocialKind; url: string };

export type SiteFooter = {
  text: string;
  links: SiteLink[];
  social: SiteSocialLink[];
  showCredit: boolean;
};

/** The parts of a site every page shares. */
export type SiteSettings = {
  version: number;
  theme: SiteTheme;
  header: SiteHeader;
  footer: SiteFooter;
};

/** The root page. Cannot be renamed or removed: it is what the domain lands on. */
export const HOME_PAGE_SLUG = "home";

/**
 * Slugs a page may not take: paths Clarity's own hosts and the functions
 * answer at, and the booking screens, so a page can never shadow them.
 */
export const RESERVED_PAGE_SLUGS = [
  "api",
  "assets",
  "site",
  "shop",
  "admin",
  "login",
  "terminal",
  "privacy",
  "terms",
  "support",
  "pos-paid",
  "pos-cancelled",
  "group-lessons",
  "private-lessons",
];

/** A page's address: lower-case letters, digits and hyphens, never reserved. */
export function cleanPageSlug(value: unknown, fallback = ""): string {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!slug || RESERVED_PAGE_SLUGS.includes(slug)) return fallback;
  return slug;
}

/** `wanted`, or wanted-2, wanted-3 … until it is not among `taken`. */
export function uniquePageSlug(wanted: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = cleanPageSlug(wanted, "page");
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base.slice(0, 56)}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 48)}-${Date.now().toString(36)}`;
}

export type SitePageKind = "page" | "article";

/** What the menu and the page list know about a page, without its blocks. */
export type SitePageMeta = {
  id: string;
  slug: string;
  title: string;
  kind: SitePageKind;
  /** Shown in the header menu. A page left out is still reachable by its address. */
  inNav: boolean;
  sortOrder: number;
};

/** A page's own content. Summary, cover and date are what an article shows on an index. */
export type SitePageContent = {
  version: number;
  /** The meta description search engines quote. */
  description: string;
  summary: string;
  cover: SiteImage | null;
  /** YYYY-MM-DD, or "". */
  date: string;
  blocks: SiteBlock[];
};

export type SitePage = SitePageMeta & { content: SitePageContent };

/** What an article index needs of each page: its meta plus the fields the card shows. */
export type SitePageCard = SitePageMeta & Pick<SitePageContent, "summary" | "cover" | "date">;

const blockId = (value: unknown, index: number, prefix = "block") =>
  text(value, 80).replace(/[^A-Za-z0-9_-]/g, "") || `${prefix}-${index}`;

/**
 * The 11-character YouTube id out of anything a coach is likely to paste: a
 * watch URL, a youtu.be link, a Shorts or embed link, or the bare id.
 */
export function siteYoutubeId(input: unknown): string {
  const value = text(input, 400);
  if (!value) return "";
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return "";
  }
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, "").toLowerCase();
  let candidate = "";
  if (host === "youtu.be") {
    candidate = url.pathname.split("/")[1] || "";
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const [first, second] = url.pathname.split("/").filter(Boolean);
    if (first === "watch") candidate = url.searchParams.get("v") || "";
    else if (first === "shorts" || first === "embed" || first === "live" || first === "v") candidate = second || "";
  }
  return /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : "";
}

const MIN_BOOKING_HEIGHT = 480;
const MAX_BOOKING_HEIGHT = 1600;

/**
 * One block, cleaned, or null when it is not a block this page knows.
 * Unknown types are dropped rather than passed through: whatever is stored
 * here is rendered on a page strangers open.
 */
export function cleanSiteBlock(value: unknown, index = 0): SiteBlock | null {
  const input = (value || {}) as Record<string, unknown>;
  const id = blockId(input.id, index);
  switch (input.type) {
    case "hero":
      return {
        id,
        type: "hero",
        eyebrow: text(input.eyebrow, 80),
        heading: text(input.heading, 160),
        text: text(input.text, 1000),
        image: cleanImage(input.image),
        layout: oneOf(input.layout, ["centre", "left", "split", "cover"], "centre"),
        height: oneOf(input.height, ["regular", "tall"], "regular"),
        buttons: cleanButtons(input.buttons, 2),
      };
    case "text":
      return {
        id,
        type: "text",
        heading: text(input.heading, 160),
        body: text(input.body, 8000),
        align: oneOf(input.align, ["left", "centre"], "left"),
        columns: Number(input.columns) === 2 ? 2 : 1,
      };
    case "image":
      return {
        id,
        type: "image",
        image: cleanImage(input.image),
        caption: text(input.caption, 300),
        size: oneOf(input.size, ["inset", "wide", "full"], "wide"),
      };
    case "gallery":
      return {
        id,
        type: "gallery",
        heading: text(input.heading, 160),
        images: cleanImages(input.images, 12),
        columns: ([2, 3, 4] as const).find((count) => count === Number(input.columns)) ?? 3,
      };
    case "features":
      return {
        id,
        type: "features",
        heading: text(input.heading, 160),
        intro: text(input.intro, 600),
        items: cleanList(input.items, 9, (item, itemIndex) => ({
          id: blockId(item.id, itemIndex, "item"),
          icon: oneOf(item.icon, SITE_FEATURE_ICONS, "flag"),
          title: text(item.title, 80),
          text: text(item.text, 400),
        })),
        columns: Number(input.columns) === 2 ? 2 : 3,
      };
    case "pricing":
      return {
        id,
        type: "pricing",
        heading: text(input.heading, 160),
        intro: text(input.intro, 600),
        items: cleanList(input.items, 6, (item, itemIndex) => ({
          id: blockId(item.id, itemIndex, "item"),
          name: text(item.name, 80),
          price: text(item.price, 40),
          detail: text(item.detail, 120),
          features: text(item.features, 800),
          button: cleanButton(item.button),
          highlighted: item.highlighted === true,
        })),
      };
    case "testimonials":
      return {
        id,
        type: "testimonials",
        heading: text(input.heading, 160),
        items: cleanList(input.items, 9, (item, itemIndex) => ({
          id: blockId(item.id, itemIndex, "item"),
          quote: text(item.quote, 600),
          name: text(item.name, 80),
          role: text(item.role, 80),
        })),
      };
    case "faq":
      return {
        id,
        type: "faq",
        heading: text(input.heading, 160),
        intro: text(input.intro, 600),
        items: cleanList(input.items, 20, (item, itemIndex) => ({
          id: blockId(item.id, itemIndex, "item"),
          question: text(item.question, 200),
          answer: text(item.answer, 1500),
        })),
      };
    case "cta":
      return {
        id,
        type: "cta",
        heading: text(input.heading, 160),
        text: text(input.text, 600),
        button: cleanButton(input.button),
        tone: oneOf(input.tone, ["primary", "surface"], "primary"),
      };
    case "video":
      return {
        id,
        type: "video",
        heading: text(input.heading, 160),
        youtubeId: siteYoutubeId(input.youtubeId ?? input.youtubeUrl),
        caption: text(input.caption, 300),
      };
    case "booking": {
      const height = Number(input.height);
      return {
        id,
        type: "booking",
        heading: text(input.heading, 160),
        text: text(input.text, 600),
        screen: oneOf(input.screen, SITE_BOOKING_SCREENS, "main"),
        mode: oneOf(input.mode, ["embed", "button"], "embed"),
        buttonLabel: text(input.buttonLabel, 60),
        height: Number.isFinite(height) ? Math.min(MAX_BOOKING_HEIGHT, Math.max(MIN_BOOKING_HEIGHT, Math.round(height))) : 760,
      };
    }
    case "contact":
      return {
        id,
        type: "contact",
        heading: text(input.heading, 160),
        text: text(input.text, 600),
        email: text(input.email, 180),
        phone: text(input.phone, 40),
        address: text(input.address, 300),
        hours: text(input.hours, 600),
        showMap: input.showMap === true,
      };
    case "divider":
      return {
        id,
        type: "divider",
        style: oneOf(input.style, ["line", "space"], "line"),
        size: oneOf(input.size, ["small", "regular", "large"], "regular"),
      };
    case "articles": {
      const limit = Number(input.limit);
      return {
        id,
        type: "articles",
        heading: text(input.heading, 160),
        intro: text(input.intro, 600),
        limit: Number.isFinite(limit) ? Math.min(24, Math.max(1, Math.round(limit))) : 6,
      };
    }
    case "shop": {
      const height = Number(input.height);
      return {
        id,
        type: "shop",
        heading: text(input.heading, 160),
        intro: text(input.intro, 600),
        mode: oneOf(input.mode, ["cards", "embed"], "cards"),
        height: Number.isFinite(height) ? Math.min(MAX_BOOKING_HEIGHT, Math.max(MIN_BOOKING_HEIGHT, Math.round(height))) : 900,
      };
    }
    default:
      return null;
  }
}

/** Every block, cleaned, in order, with ids made unique and the list capped. */
export function cleanSiteBlocks(value: unknown): SiteBlock[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const blocks: SiteBlock[] = [];
  for (const [index, entry] of value.slice(0, MAX_SITE_BLOCKS).entries()) {
    const block = cleanSiteBlock(entry, index);
    if (!block) continue;
    if (seen.has(block.id)) block.id = `${block.id}-${index}`;
    seen.add(block.id);
    blocks.push(block);
  }
  return blocks;
}

export function cleanHeader(value: unknown): SiteHeader {
  const input = (value || {}) as Record<string, unknown>;
  return {
    showLogo: input.showLogo !== false,
    showName: input.showName !== false,
    links: cleanLinks(input.links, 6),
    button: cleanButton(input.button),
    sticky: input.sticky !== false,
  };
}

export function cleanFooter(value: unknown): SiteFooter {
  const input = (value || {}) as Record<string, unknown>;
  return {
    text: text(input.text, 300),
    links: cleanLinks(input.links, 6),
    social: cleanList(input.social, 6, (entry) => {
      const url = cleanSiteHref(entry.url);
      const kind = oneOf(entry.kind, SITE_SOCIAL_KINDS, "instagram");
      return url && /^https?:/.test(url) ? { kind, url } : null;
    }),
    showCredit: input.showCredit !== false,
  };
}

/** The site's settings, cleaned. */
export function cleanSiteSettings(value: unknown): SiteSettings {
  const input = (value || {}) as Record<string, unknown>;
  return {
    version: SITE_DOCUMENT_VERSION,
    theme: cleanTheme(input.theme),
    header: cleanHeader(input.header),
    footer: cleanFooter(input.footer),
  };
}

/** A page's content, cleaned. The shape every write is stored in and every read returns. */
export function cleanSitePageContent(value: unknown): SitePageContent {
  const input = (value || {}) as Record<string, unknown>;
  const date = text(input.date, 10);
  return {
    version: SITE_DOCUMENT_VERSION,
    description: text(input.description, 300),
    summary: text(input.summary, 400),
    cover: cleanImage(input.cover),
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
    blocks: cleanSiteBlocks(input.blocks),
  };
}

/** A page's meta, cleaned. The id is the server's; a page without one is new. */
export function cleanSitePageMeta(value: unknown, index = 0): SitePageMeta {
  const input = (value || {}) as Record<string, unknown>;
  const sortOrder = Number(input.sortOrder);
  return {
    id: text(input.id, 80).replace(/[^A-Za-z0-9_-]/g, ""),
    slug: cleanPageSlug(input.slug, `page-${index + 1}`),
    title: text(input.title, 120),
    kind: oneOf(input.kind, ["page", "article"], "page"),
    inNav: input.inNav !== false,
    sortOrder: Number.isFinite(sortOrder) ? Math.round(sortOrder) : index,
  };
}

/** The image addresses a page shows. Used to find uploads nothing refers to any more. */
export function sitePageImageUrls(content: SitePageContent): string[] {
  const urls: string[] = [];
  if (content.cover) urls.push(content.cover.url);
  for (const block of content.blocks) {
    if (block.type === "hero" && block.image) urls.push(block.image.url);
    if (block.type === "image" && block.image) urls.push(block.image.url);
    if (block.type === "gallery") urls.push(...block.images.map((image) => image.url));
  }
  return urls;
}

/** Twelve URL-safe characters. Enough for block ids that only need to be unique on one page. */
export function siteId(prefix: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `${prefix}-${out}`;
}

/** A fresh block of a type, with sensible starting content. */
export function newSiteBlock(type: SiteBlockType): SiteBlock {
  const id = siteId("block");
  switch (type) {
    case "hero":
      return { id, type, eyebrow: "", heading: "A heading that says what you do", text: "A sentence or two about who this is for and why they should book.", image: null, layout: "centre", height: "regular", buttons: [{ label: "Book a lesson", href: "", style: "primary" }] };
    case "text":
      return { id, type, heading: "About", body: "Tell your story here. Blank lines start new paragraphs.", align: "left", columns: 1 };
    case "image":
      return { id, type, image: null, caption: "", size: "wide" };
    case "gallery":
      return { id, type, heading: "", images: [], columns: 3 };
    case "features":
      return {
        id,
        type,
        heading: "What you get",
        intro: "",
        columns: 3,
        items: [
          { id: siteId("item"), icon: "target", title: "Clear goals", text: "Every lesson starts with what you want to change." },
          { id: siteId("item"), icon: "video", title: "Video analysis", text: "See your swing, not just hear about it." },
          { id: siteId("item"), icon: "calendar", title: "Easy booking", text: "Book online, any time, and get reminders." },
        ],
      };
    case "pricing":
      return {
        id,
        type,
        heading: "Lessons and packages",
        intro: "",
        items: [
          { id: siteId("item"), name: "Single lesson", price: "", detail: "60 minutes", features: "One-to-one coaching\nVideo analysis\nPractice plan", button: { label: "Book", href: "", style: "primary" }, highlighted: false },
          { id: siteId("item"), name: "Five-lesson package", price: "", detail: "Save on five", features: "Everything in a single lesson\nPriority booking", button: { label: "Book", href: "", style: "primary" }, highlighted: true },
        ],
      };
    case "testimonials":
      return { id, type, heading: "What players say", items: [{ id: siteId("item"), quote: "", name: "", role: "" }] };
    case "faq":
      return { id, type, heading: "Questions", intro: "", items: [{ id: siteId("item"), question: "What should I bring?", answer: "" }] };
    case "cta":
      return { id, type, heading: "Ready to play better golf?", text: "", button: { label: "Book a lesson", href: "", style: "primary" }, tone: "primary" };
    case "video":
      return { id, type, heading: "", youtubeId: "", caption: "" };
    case "booking":
      return { id, type, heading: "Book a lesson", text: "", screen: "main", mode: "embed", buttonLabel: "Book now", height: 760 };
    case "contact":
      return { id, type, heading: "Find us", text: "", email: "", phone: "", address: "", hours: "", showMap: false };
    case "divider":
      return { id, type, style: "line", size: "regular" };
    case "articles":
      return { id, type, heading: "Latest articles", intro: "", limit: 6 };
    case "shop":
      return { id, type, heading: "Shop", intro: "Lesson packages and gift vouchers.", mode: "cards", height: 900 };
  }
}

// --- Page presets ----------------------------------------------------------

export type SitePagePresetInput = {
  businessName: string;
  coachName: string;
  /** The business's public booking page, used for every "Book" button. */
  bookingHref: string;
  venueName: string;
  email: string;
  phone: string;
};

export type SitePagePreset = {
  id: string;
  label: string;
  /** One line on the chooser card. */
  summary: string;
  build: (input: SitePagePresetInput) => Omit<SitePage, "id" | "sortOrder">;
};

const book = (label: string, href: string, style: "primary" | "secondary" = "primary"): SiteButton => ({ label, href, style });

const page = (slug: string, title: string, blocks: SiteBlock[], extra: Partial<SitePageContent> & { kind?: SitePageKind; inNav?: boolean } = {}): Omit<SitePage, "id" | "sortOrder"> => {
  const { kind = "page", inNav = true, ...content } = extra;
  return { slug, title, kind, inNav, content: cleanSitePageContent({ ...content, blocks }) };
};

/**
 * The pages a coach can add. Each is a whole page with its blocks filled in
 * for the business, then forgotten: the coach changes anything afterwards.
 * The home page is not here; it comes from a template (templates.mts).
 */
export const SITE_PAGE_PRESETS: readonly SitePagePreset[] = [
  {
    id: "blank",
    label: "Blank page",
    summary: "A heading and some text. Add blocks from there.",
    build: () => page("new-page", "New page", [{ id: "intro", type: "text", heading: "New page", body: "Write something here.", align: "left", columns: 1 }]),
  },
  {
    id: "about",
    label: "About",
    summary: "Who you are, how you coach, and a picture.",
    build: (input) =>
      page("about", "About", [
        {
          id: "hero",
          type: "hero",
          eyebrow: "About",
          heading: input.coachName || input.businessName,
          text: "A line or two on who you coach and what players can expect.",
          image: null,
          layout: "split",
          height: "regular",
          buttons: [book("Book a lesson", input.bookingHref)],
        },
        {
          id: "story",
          type: "text",
          heading: "How I coach",
          body: "Write a few paragraphs about your background, how you work and who you work with.\n\nBlank lines start new paragraphs.",
          align: "left",
          columns: 1,
        },
        { id: "picture", type: "image", image: null, caption: "", size: "wide" },
        { id: "cta", type: "cta", heading: "Ready when you are", text: "", button: book("Book a lesson", input.bookingHref), tone: "primary" },
      ]),
  },
  {
    id: "location",
    label: "Find us",
    summary: "Address, hours, a map and how to get in touch.",
    build: (input) =>
      page("find-us", "Find us", [
        {
          id: "contact",
          type: "contact",
          heading: input.venueName ? `We are at ${input.venueName}` : "Find us",
          text: "Add the address below and switch the map on.",
          email: input.email,
          phone: input.phone,
          address: "",
          hours: "",
          showMap: true,
        },
        { id: "directions", type: "text", heading: "Getting here", body: "Parking, which entrance to use, and where to meet.", align: "left", columns: 1 },
      ]),
  },
  {
    id: "lessons",
    label: "Lessons & prices",
    summary: "What you offer, what it costs, and the usual questions.",
    build: (input) =>
      page("lessons", "Lessons", [
        {
          id: "prices",
          type: "pricing",
          heading: "Lessons and packages",
          intro: "Prices are shown on the booking page.",
          items: [
            { id: "single", name: "Private lesson", price: "", detail: "One-to-one", features: "Video analysis\nA practice plan to take away", button: book("Book", input.bookingHref), highlighted: false },
            { id: "package", name: "Lesson package", price: "", detail: "Best value", features: "A series of lessons\nPriority booking", button: book("Book", input.bookingHref), highlighted: true },
          ],
        },
        {
          id: "faq",
          type: "faq",
          heading: "Questions",
          intro: "",
          items: [
            { id: "clubs", question: "Do I need my own clubs?", answer: "Bring them if you have them. If not, say so when you book." },
            { id: "cancel", question: "Can I cancel or move a lesson?", answer: "Yes. The confirmation email has a link to move or cancel your booking." },
          ],
        },
        { id: "cta", type: "cta", heading: "Book a lesson", text: "", button: book("Book now", input.bookingHref), tone: "primary" },
      ]),
  },
  {
    id: "book",
    label: "Booking page",
    summary: "Your Clarity booking page, as a page of the site.",
    build: () => page("book", "Book", [{ id: "book", type: "booking", heading: "Book a lesson", text: "", screen: "main", mode: "embed", buttonLabel: "Book now", height: 900 }]),
  },
  {
    id: "articles",
    label: "Articles",
    summary: "A list of your articles, newest first. Add articles as pages.",
    build: () =>
      page("articles", "Articles", [
        { id: "intro", type: "text", heading: "Articles", body: "Tips, drills and news.", align: "left", columns: 1 },
        { id: "list", type: "articles", heading: "", intro: "", limit: 12 },
      ]),
  },
  {
    id: "article",
    label: "Article",
    summary: "One article: a title, a date, a picture and the text. Shown on your Articles page.",
    build: () =>
      page(
        "new-article",
        "New article",
        [
          { id: "title", type: "hero", eyebrow: "", heading: "New article", text: "", image: null, layout: "left", height: "regular", buttons: [] },
          { id: "body", type: "text", heading: "", body: "Write the article here. Blank lines start new paragraphs.", align: "left", columns: 1 },
        ],
        { kind: "article", inNav: false, summary: "One line that says what the article is about.", date: new Date().toISOString().slice(0, 10) },
      ),
  },
  {
    id: "shop",
    label: "Shop",
    summary: "Your online shop: lesson packages and gift vouchers, bought on the page.",
    build: () =>
      page("shop-page", "Shop", [
        { id: "shop", type: "shop", heading: "Shop", intro: "Lesson packages and gift vouchers. Paid online, delivered by email.", mode: "cards", height: 900 },
      ]),
  },
  {
    id: "gallery",
    label: "Gallery",
    summary: "A page of pictures.",
    build: () => page("gallery", "Gallery", [{ id: "pictures", type: "gallery", heading: "Gallery", images: [], columns: 3 }]),
  },
];

export function sitePagePreset(id: string): SitePagePreset | null {
  return SITE_PAGE_PRESETS.find((preset) => preset.id === id) || null;
}
