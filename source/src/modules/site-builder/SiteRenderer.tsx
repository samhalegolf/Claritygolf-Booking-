// A page of a site, drawn.
//
// The one renderer for both the editor's preview and the public page. In
// preview mode a click on a block selects it instead of following links, a
// click on a page link switches the editor to that page, and the heavy
// embeds (booking widget, map, framed pages) are stood in for by a labelled
// box so the preview stays light and never books anything.
//
// In the editor's edit mode (the `editor` prop) the page is also where it is
// edited, the way Squarespace works: words are typed over where they stand
// (EditableText; each field names itself with a path such as "heading" or
// "items.<item id>.title"), and every section carries "Add section" above
// and below it and a toolbar to edit, move, duplicate or remove it. None of
// that is drawn without the prop, so the public page is unchanged.

import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Award,
  Calendar,
  ChartLine,
  Clock,
  Copy,
  Facebook,
  Flag,
  GraduationCap,
  Heart,
  Instagram,
  Link as LinkIcon,
  Linkedin,
  Mail,
  MapPin,
  Move,
  Pencil,
  Phone,
  Plus,
  Shield,
  ShoppingBag,
  Star,
  Sun,
  Target,
  Trash2,
  Trophy,
  Users,
  Video,
  Youtube,
  Zap,
} from "lucide-react";
import {
  HOME_PAGE_SLUG,
  blockStyleIsPlain,
  instagramUrl,
  pageSlugFromHref,
  youtubeThumbnail,
  type SiteBlock,
  type SiteBlockStyle,
  type SiteButton,
  type SiteCanvasBlock,
  type SiteFeatureIcon,
  type SitePage,
  type SitePageCard,
  type SiteSettings,
  type SiteSocialKind,
  type SiteSocialLink,
  type SiteTheme,
  type SitePictureShape,
} from "../../../netlify/functions/_shared/site/document.mts";
import { CanvasBlock, CanvasEditor } from "./CanvasBlock";
import { canArrangeFreely } from "./canvasLayout";
import { EditableText } from "./EditableText";
import { FormBlock } from "./FormBlock";
import { ShopBlock } from "./ShopBlock";
import { CART_EVENT, cartCount, readCart } from "./siteCart";
import { blockStyleVars, bookingPageUrl, siteThemeClassName, siteThemeStyle } from "./siteTheme";

export type SiteBusiness = { slug: string; name: string; logo: string; showLogo: boolean };

export type SiteSelection = "site" | "header" | "footer" | "page" | { block: string };

export type PreviewLabels = { noArticles: string; noVideos: string; noPage: string };

/** What the editor does when the page is edited in place. Present only in edit mode. */
export type SiteEditorHooks = {
  /** A field typed over on the page. `path` is "heading", or "items.<item id>.title" for a field of one item. */
  editText: (blockId: string, path: string, value: string) => void;
  /** Open the section gallery to put a new section at this position on the page. */
  addSection: (index: number) => void;
  editSection: (blockId: string) => void;
  moveSection: (blockId: string, delta: number) => void;
  duplicateSection: (blockId: string) => void;
  removeSection: (blockId: string) => void;
  editHeader: () => void;
  editFooter: () => void;
  /** Turn a hero, text, call to action or picture section into a free layout (canArrangeFreely). */
  arrangeFreely: (blockId: string) => void;
  /** The item picked in a free layout section, if any. */
  canvasItem: { block: string; item: string } | null;
  selectCanvasItem: (blockId: string, itemId: string | null) => void;
  /** A free layout's items moved, stretched, added, restacked or removed. */
  changeCanvas: (blockId: string, next: Pick<SiteCanvasBlock, "items" | "rows">) => void;
  /** Open the side panel on one item of a free layout. */
  editCanvasItem: (blockId: string, itemId: string) => void;
  /** The words on the editing controls, in the editor's language. */
  labels: {
    addSection: string;
    editSection: string;
    moveUp: string;
    moveDown: string;
    duplicate: string;
    remove: string;
    editHeader: string;
    editFooter: string;
    emptyPage: string;
    arrangeFreely: string;
    canvas: {
      heading: string;
      text: string;
      picture: string;
      button: string;
      shape: string;
      addHeading: string;
      addText: string;
      addPicture: string;
      addButton: string;
      addShape: string;
      newHeading: string;
      newText: string;
      newButton: string;
      edit: string;
      forward: string;
      backward: string;
      duplicate: string;
      remove: string;
      height: string;
    };
  };
};

/** The field-writer for the block being drawn, while the page is being edited in place. */
const InlineEdit = createContext<((path: string, value: string) => void) | null>(null);

/** A line of words that is typed over in edit mode, and drawn as it is otherwise. Nothing when empty. */
function Text({ as, value, field, className, multiline }: { as: "p" | "span" | "strong" | "figcaption"; value: string; field?: string; className?: string; multiline?: boolean }) {
  const edit = useContext(InlineEdit);
  if (!value) return null;
  if (edit && field) return <EditableText as={as} value={value} className={className} multiline={multiline} onCommit={(next) => edit(field, next)} />;
  const Tag = as;
  return <Tag className={className}>{value}</Tag>;
}

/** The path of one item's field: "items.<id>.<field>". By id, not position, so a filtered list still writes to the right item. */
const itemField = (id: string, field: string) => `items.${id}.${field}`;

export type SiteRendererProps = {
  settings: SiteSettings;
  page: SitePage;
  /** Every page of the site, in menu order: the menu and the article index read it. */
  pages: SitePageCard[];
  business: SiteBusiness;
  /** "preview" inside the editor; "public" on the page itself. */
  mode: "preview" | "public";
  /** Where a page of the site lives, as a path for its links. */
  pagePath: (slug: string) => string;
  /** A click on a page of the site. The preview switches page; the public page fetches it in place. */
  onNavigate?: (slug: string) => void;
  selected?: SiteSelection;
  onSelect?: (selection: SiteSelection) => void;
  /** The words on the stand-in boxes, in the coach's language. Preview only. */
  previewLabels?: PreviewLabels;
  /** Public only: the query the page was opened with, so the shop can pick up a returning order. */
  returnQuery?: URLSearchParams;
  /** Public only: the address names no page. The header and footer still draw around a note. */
  missingPage?: boolean;
  /** Public only: the next page is on its way. */
  busy?: boolean;
  /** Preview only, in edit mode: the page is edited where it stands. */
  editor?: SiteEditorHooks;
};

const FEATURE_ICONS: Record<SiteFeatureIcon, typeof Flag> = {
  flag: Flag,
  target: Target,
  trophy: Trophy,
  users: Users,
  video: Video,
  calendar: Calendar,
  "map-pin": MapPin,
  star: Star,
  clock: Clock,
  heart: Heart,
  zap: Zap,
  award: Award,
  "graduation-cap": GraduationCap,
  "line-chart": ChartLine,
  shield: Shield,
  sun: Sun,
};

const SOCIAL: Record<SiteSocialKind, { label: string; Icon: typeof Flag }> = {
  instagram: { label: "Instagram", Icon: Instagram },
  facebook: { label: "Facebook", Icon: Facebook },
  youtube: { label: "YouTube", Icon: Youtube },
  tiktok: { label: "TikTok", Icon: LinkIcon },
  x: { label: "X", Icon: LinkIcon },
  linkedin: { label: "LinkedIn", Icon: Linkedin },
};

function isSelected(selected: SiteSelection | undefined, target: SiteSelection) {
  if (!selected) return false;
  if (typeof selected === "string" || typeof target === "string") return selected === target;
  return selected.block === target.block;
}

/** A date as the visitor's browser writes it. */
export function formatSiteDate(date: string): string {
  if (!date) return "";
  try {
    return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  } catch {
    return date;
  }
}

/** Paragraphs from text: blank lines separate them, single newlines break. */
function Paragraphs({ text, className = "", field }: { text: string; className?: string; field?: string }) {
  const edit = useContext(InlineEdit);
  if (edit && field && text.trim()) return <EditableText as="div" value={text} className={className} multiline onCommit={(next) => edit(field, next)} />;
  const paragraphs = text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  if (!paragraphs.length) return null;
  return (
    <>
      {paragraphs.map((paragraph, index) => (
        <p className={className} key={index}>
          {paragraph.split("\n").map((line, lineIndex, lines) => (
            <span key={lineIndex}>
              {line}
              {lineIndex < lines.length - 1 ? <br /> : null}
            </span>
          ))}
        </p>
      ))}
    </>
  );
}

/** The class that cuts a picture to its shape; none for a picture left as it is. */
function pictureShapeClass(shape: SitePictureShape): string | undefined {
  return shape === "square" ? undefined : `is-${shape}`;
}

function Heading({ level, text, className = "", field }: { level: 1 | 2 | 3; text: string; className?: string; field?: string }) {
  const edit = useContext(InlineEdit);
  if (!text) return null;
  const Tag = `h${level}` as const;
  if (edit && field) return <EditableText as={Tag} value={text} className={`site-heading ${className}`.trim()} onCommit={(next) => edit(field, next)} />;
  return <Tag className={`site-heading ${className}`.trim()}>{text}</Tag>;
}

function SocialIcons({ links, className }: { links: SiteSocialLink[]; className: string }) {
  if (!links.length) return null;
  return (
    <div className={className}>
      {links.map((entry, index) => {
        const { label, Icon } = SOCIAL[entry.kind];
        return (
          <a href={entry.url} key={index} aria-label={label} title={label} target="_blank" rel="noreferrer">
            <Icon size={18} />
          </a>
        );
      })}
    </div>
  );
}

/** The header's bag: how many things are in the visitor's cart, and the way to the shop page. */
function CartIcon({ business, preview, ...link }: { business: string; preview: boolean } & LinkProps) {
  const [count, setCount] = useState(() => (preview ? 0 : cartCount(readCart(business))));
  useEffect(() => {
    if (preview) return;
    const refresh = () => setCount(cartCount(readCart(business)));
    window.addEventListener(CART_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(CART_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [business, preview]);
  return (
    <a className="site-header-cart" aria-label="Cart" title="Cart" {...link}>
      <ShoppingBag size={20} />
      {count > 0 ? <span className="site-header-cart-count">{count}</span> : null}
    </a>
  );
}

/** A YouTube video, or the preview's stand-in for one. */
function YouTubeFrame({ videoId, title, preview }: { videoId: string; title: string; preview: boolean }) {
  if (!videoId || preview) {
    // The editor shows the video's own picture rather than loading a player
    // for every block on every keystroke.
    return (
      <div className="site-placeholder is-video" style={videoId ? { backgroundImage: `url("${youtubeThumbnail(videoId)}")` } : undefined}>
        <Video size={28} />
      </div>
    );
  }
  return (
    <div className="site-video-frame">
      <iframe
        src={`https://www.youtube-nocookie.com/embed/${videoId}?rel=0&modestbranding=1&playsinline=1`}
        title={title || "Video"}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        loading="lazy"
      />
    </div>
  );
}

/**
 * A framed address, or pasted embed code drawn in a frame of its own. The
 * editor's preview shows the real thing, inert: a click lands on the block,
 * not inside the frame, so editing never books or buys anything.
 */
function Frame({ src, code, title, height, className, preview }: { src: string; code?: string; title: string; height: number; className: string; preview: boolean }) {
  const frame = src ? (
    <iframe className={className} src={src} title={title} style={{ height }} loading="lazy" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" allow="payment; web-share; clipboard-write; geolocation" />
  ) : code ? (
    // Pasted code runs with no origin of its own: it can draw and talk to its
    // own servers, never read this page or its visitor's cookies.
    <iframe className={className} srcDoc={`<!doctype html><meta charset="utf-8"><style>html,body{margin:0}</style>${code}`} title={title} style={{ height }} loading="lazy" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" allow="payment; web-share" />
  ) : (
    <div className="site-placeholder is-embed" style={{ height: Math.min(height, 420) }} />
  );
  return preview ? <div className="site-frame-inert">{frame}</div> : frame;
}

function MapFrame({ address, preview }: { address: string; preview: boolean }) {
  const frame = <iframe className="site-map" src={`https://www.google.com/maps?q=${encodeURIComponent(address)}&output=embed`} title={address} loading="lazy" referrerPolicy="no-referrer-when-downgrade" />;
  return preview ? <div className="site-frame-inert">{frame}</div> : frame;
}

type LinkProps = { href: string; onClick?: (event: MouseEvent) => void; target?: string; rel?: string };

/** How every link on the page is drawn: a page of the site, or somewhere else. */
function makeLinkProps(pagePath: (slug: string) => string, onNavigate?: (slug: string) => void) {
  return (href: string): LinkProps => {
    const slug = pageSlugFromHref(href);
    if (slug) {
      return {
        href: pagePath(slug),
        onClick: onNavigate
          ? (event) => {
              event.preventDefault();
              onNavigate(slug);
            }
          : undefined,
      };
    }
    if (/^https?:/.test(href)) return { href, target: "_blank", rel: "noreferrer" };
    return { href: href || "#" };
  };
}

/** True when a block's own style puts light text on something dark. */
function blockIsDark(style: SiteBlockStyle): boolean {
  return Boolean(style.background || style.video) ? style.theme !== "light" && style.theme !== "white" : style.theme === "dark" || style.theme === "accent";
}

export function SiteRenderer({
  settings,
  page,
  pages,
  business,
  mode,
  pagePath,
  onNavigate,
  selected,
  onSelect,
  previewLabels,
  returnQuery,
  missingPage,
  busy,
  editor,
}: SiteRendererProps) {
  const preview = mode === "preview";
  const linkProps = makeLinkProps(pagePath, onNavigate);
  const select = (selection: SiteSelection) => (event: MouseEvent) => {
    if (!preview || !onSelect) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(selection);
  };
  const { header, footer, theme } = settings;

  /** The colour a block's page shows: its own, or the site's. The wave along a block's top edge is cut from the block above in this colour. */
  const pageColourOf = (style: SiteBlockStyle | null | undefined): string => {
    const vars = style && !blockStyleIsPlain(style) ? (blockStyleVars(theme, style) as Record<string, string>) : {};
    return vars["--site-bg"] || theme.colors.background;
  };

  const frame = (target: SiteSelection, className: string, children: ReactNode, id?: string, style?: SiteBlockStyle, above?: SiteBlockStyle | null, chrome?: ReactNode) => {
    const plain = !style || blockStyleIsPlain(style);
    const backdrop = style && (style.background || style.video);
    const divider = style?.divider === "wave";
    return (
      <div
        className={`${className}${plain ? "" : ` has-style is-theme-${style.theme} is-height-${style.height}`}${divider ? " has-divider" : ""}${preview ? " is-editable" : ""}${isSelected(selected, target) ? " is-selected" : ""}`}
        id={id}
        key={id ?? className}
        style={style && !plain ? blockStyleVars(theme, style) : undefined}
        onClick={select(target)}
      >
        {divider ? (
          <svg className="site-block-divider" viewBox="0 0 1200 36" preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 18 C 200 -4, 400 40, 600 18 S 1000 -4, 1200 18 L 1200 0 L 0 0 Z" fill={pageColourOf(above)} />
            <path d="M0 18 C 200 -4, 400 40, 600 18 S 1000 -4, 1200 18" fill="none" stroke="currentColor" strokeWidth="4" />
          </svg>
        ) : null}
        {backdrop ? (
          <div className="site-block-backdrop" aria-hidden="true">
            {style.video ? <video src={style.video} poster={style.background?.url} autoPlay muted loop playsInline /> : <img src={style.background!.url} alt="" />}
            <div className="site-block-overlay" style={{ opacity: style.overlay / 100 }} />
          </div>
        ) : null}
        {backdrop ? <div className="site-block-inner">{children}</div> : children}
        {chrome}
      </div>
    );
  };

  /** An editing control drawn on the page: it acts, and the click goes no further. */
  const control = (label: string, onPress: () => void, content: ReactNode, className = "site-edit-tool") => (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onPress();
      }}
    >
      {content}
    </button>
  );

  /** "Add section" above and below a section, and its toolbar, as Squarespace draws them. */
  const sectionChrome = (block: SiteBlock, index: number, count: number) => {
    if (!editor) return null;
    const { labels } = editor;
    return (
      <>
        {control(labels.addSection, () => editor.addSection(index), <><Plus size={14} /> {labels.addSection}</>, "site-edit-add is-before")}
        {control(labels.addSection, () => editor.addSection(index + 1), <><Plus size={14} /> {labels.addSection}</>, "site-edit-add is-after")}
        <div className="site-edit-toolbar">
          {control(labels.editSection, () => editor.editSection(block.id), <><Pencil size={14} /> <span>{labels.editSection}</span></>, "site-edit-tool is-labelled")}
          {canArrangeFreely(block) ? control(labels.arrangeFreely, () => editor.arrangeFreely(block.id), <Move size={15} />) : null}
          {index > 0 ? control(labels.moveUp, () => editor.moveSection(block.id, -1), <ArrowUp size={15} />) : null}
          {index < count - 1 ? control(labels.moveDown, () => editor.moveSection(block.id, 1), <ArrowDown size={15} />) : null}
          {control(labels.duplicate, () => editor.duplicateSection(block.id), <Copy size={15} />)}
          {control(labels.remove, () => editor.removeSection(block.id), <Trash2 size={15} />)}
        </div>
      </>
    );
  };

  /** The one button on the header or footer in edit mode: they are site-wide, edited in a panel of their own. */
  const partChrome = (label: string, onPress: () => void) =>
    editor ? <div className="site-edit-toolbar is-part">{control(label, onPress, <><Pencil size={14} /> <span>{label}</span></>, "site-edit-tool is-labelled")}</div> : null;

  const Button = ({ button, className = "" }: { button: SiteButton | null; className?: string }) => {
    if (!button) return null;
    const classes = `site-button is-${button.style} ${className}`.trim();
    if (!button.href) return <span className={`${classes} is-unlinked`}>{button.label}</span>;
    return (
      <a className={classes} {...linkProps(button.href)}>
        {button.label}
      </a>
    );
  };

  const showBrand = header.showLogo && business.showLogo && business.logo;
  const menu = pages.filter((candidate) => candidate.inNav).sort((a, b) => a.sortOrder - b.sortOrder);
  const returnPath = pagePath(page.slug);
  const firstBlock = page.content.blocks[0];
  const headerOnDark = header.transparent && !missingPage && Boolean(firstBlock) && blockIsDark(firstBlock.style);

  return (
    <div
      className={`${siteThemeClassName(theme)} ${preview ? "is-preview" : ""}${editor ? " is-editing" : ""}${busy ? " is-busy" : ""}${header.transparent ? " has-transparent-header" : ""}`}
      style={siteThemeStyle(theme)}
      // In the preview every link is inert: the coach is editing, not browsing.
      onClickCapture={preview ? (event) => { if ((event.target as HTMLElement).closest("a")) event.preventDefault(); } : undefined}
    >
      {header.announcement ? (
        <div className="site-announcement">
          {header.announcementHref ? <a {...linkProps(header.announcementHref)}>{header.announcement}</a> : <span>{header.announcement}</span>}
        </div>
      ) : null}
      {frame(
        "header",
        `site-header${header.sticky && !header.transparent ? " is-sticky" : ""}${header.transparent ? " is-transparent" : ""}${headerOnDark ? " is-on-dark" : ""}`,
        <div className="site-container site-header-inner">
          <a className="site-brand" {...linkProps(`page:${HOME_PAGE_SLUG}`)}>
            {showBrand ? <img className="site-brand-logo" src={business.logo} alt="" /> : null}
            {header.showName || !showBrand ? <span className="site-brand-name">{business.name}</span> : null}
          </a>
          {menu.length > 1 || header.links.length ? (
            <nav className="site-nav" aria-label="Site">
              {menu.map((entry) => (
                <a key={entry.slug} aria-current={entry.slug === page.slug ? "page" : undefined} {...linkProps(`page:${entry.slug}`)}>
                  {entry.title || entry.slug}
                </a>
              ))}
              {header.links.map((link, index) => (
                <a key={`link-${index}`} {...linkProps(link.href)}>
                  {link.label}
                </a>
              ))}
            </nav>
          ) : null}
          <SocialIcons links={header.social} className="site-header-social" />
          {header.shopPage ? <CartIcon business={business.slug} preview={preview} {...linkProps(`page:${header.shopPage}`)} /> : null}
          <Button button={header.button} className="site-header-button" />
        </div>,
        "top",
        undefined,
        null,
        editor ? partChrome(editor.labels.editHeader, editor.editHeader) : null,
      )}

      <CanvasEditor.Provider value={editor ?? null}>
      <main className="site-main">
        {missingPage ? (
          <section className="site-container site-missing">
            <h1 className="site-heading">{previewLabels?.noPage || "There is no page here"}</h1>
          </section>
        ) : null}
        {!missingPage && (page.kind === "article" || page.kind === "video") && page.content.date ? (
          <p className="site-container site-article-date">{formatSiteDate(page.content.date)}</p>
        ) : null}
        {!missingPage && page.kind === "video" ? (
          <div className="site-container site-page-video">
            <YouTubeFrame videoId={page.content.video} title={page.title} preview={preview} />
          </div>
        ) : null}
        {!missingPage
          ? page.content.blocks.map((block, index) =>
              frame(
                { block: block.id },
                `site-block site-block-${block.type}`,
                <InlineEdit.Provider key={block.id} value={editor ? (path, value) => editor.editText(block.id, path, value) : null}>
                <Block
                  block={block}
                  page={page}
                  pages={pages}
                  business={business}
                  theme={theme}
                  preview={preview}
                  previewLabels={previewLabels}
                  linkProps={linkProps}
                  Button={Button}
                  returnPath={returnPath}
                  returnQuery={returnQuery}
                />
                </InlineEdit.Provider>,
                block.id,
                block.style,
                // The first block sits under the header, which is the page's own colour.
                index > 0 ? page.content.blocks[index - 1].style : null,
                sectionChrome(block, index, page.content.blocks.length),
              ),
            )
          : null}
        {!missingPage && editor && !page.content.blocks.length ? (
          <div className="site-edit-empty">
            <p>{editor.labels.emptyPage}</p>
            {control(editor.labels.addSection, () => editor.addSection(0), <><Plus size={16} /> {editor.labels.addSection}</>, "site-edit-add is-standalone")}
          </div>
        ) : null}
      </main>
      </CanvasEditor.Provider>

      {frame(
        "footer",
        "site-footer",
        <div className="site-container site-footer-inner">
          <div className="site-footer-text">{footer.text ? <p>{footer.text}</p> : null}</div>
          {footer.links.length ? (
            <nav className="site-footer-links" aria-label="Footer">
              {footer.links.map((link, index) => (
                <a key={index} {...linkProps(link.href)}>
                  {link.label}
                </a>
              ))}
            </nav>
          ) : null}
          <SocialIcons links={footer.social} className="site-social" />
          {footer.showCredit ? (
            <p className="site-credit">
              <a href="https://claritygolf.app" target="_blank" rel="noreferrer">
                Made with Clarity
              </a>
            </p>
          ) : null}
        </div>,
        undefined,
        undefined,
        null,
        editor ? partChrome(editor.labels.editFooter, editor.editFooter) : null,
      )}
    </div>
  );
}

function Block({
  block,
  page,
  pages,
  business,
  preview,
  previewLabels,
  linkProps,
  Button,
  returnPath,
  returnQuery,
}: {
  block: SiteBlock;
  page: SitePage;
  pages: SitePageCard[];
  business: SiteBusiness;
  theme: SiteTheme;
  preview: boolean;
  previewLabels?: PreviewLabels;
  linkProps: (href: string) => LinkProps;
  Button: (props: { button: SiteButton | null; className?: string }) => ReactNode;
  returnPath: string;
  returnQuery?: URLSearchParams;
}) {
  const sectionHead = (heading: string, intro: string) =>
    heading || intro ? (
      <div className="site-section-head">
        <Heading level={2} text={heading} field="heading" />
        <Paragraphs text={intro} className="site-intro" field="intro" />
      </div>
    ) : null;

  switch (block.type) {
    case "hero": {
      const cover = block.layout === "cover" && block.image;
      return (
        <section
          className={`site-hero is-${block.layout} is-${block.height}${cover ? " has-cover" : ""}`}
          style={cover ? { backgroundImage: `url("${block.image!.url}")` } : undefined}
        >
          <div className="site-container site-hero-inner">
            <div className="site-hero-copy">
              <Text as="p" className="site-eyebrow" value={block.eyebrow} field="eyebrow" />
              <Heading level={1} text={block.heading} className="site-hero-heading" field="heading" />
              <Paragraphs text={block.text} className="site-lede" field="text" />
              {block.buttons.length ? (
                <div className="site-buttons">
                  {block.buttons.map((button, index) => (
                    <Button button={button} key={index} />
                  ))}
                </div>
              ) : null}
            </div>
            {block.image && block.layout !== "cover" ? (
              <div className="site-hero-media">
                <img className={pictureShapeClass(block.shape)} src={block.image.url} alt={block.image.alt} loading="eager" />
              </div>
            ) : null}
          </div>
        </section>
      );
    }
    case "text":
      return (
        <section className={`site-container site-text is-${block.align} is-columns-${block.columns}`}>
          <Heading level={2} text={block.heading} field="heading" />
          <div className="site-text-body">
            <Paragraphs text={block.body} field="body" />
          </div>
        </section>
      );
    case "image":
      return (
        <figure className={`site-figure is-${block.size}`}>
          {block.image ? <img className={pictureShapeClass(block.shape)} src={block.image.url} alt={block.image.alt} loading="lazy" /> : <div className="site-placeholder" />}
          <Text as="figcaption" value={block.caption} field="caption" />
        </figure>
      );
    case "gallery":
      return (
        <section className="site-container site-gallery">
          <Heading level={2} text={block.heading} field="heading" />
          <div className="site-gallery-grid" style={{ "--site-columns": block.columns } as CSSProperties}>
            {block.images.length ? (
              block.images.map((image, index) => (
                <figure key={index}>
                  <img src={image.url} alt={image.alt} loading="lazy" />
                  {image.alt ? <figcaption>{image.alt}</figcaption> : null}
                </figure>
              ))
            ) : (
              <div className="site-placeholder" />
            )}
          </div>
          {block.button ? (
            <div className="site-buttons">
              <Button button={block.button} />
            </div>
          ) : null}
        </section>
      );
    case "features":
      return (
        <section className="site-container site-features">
          {sectionHead(block.heading, block.intro)}
          <div className="site-feature-grid" style={{ "--site-columns": block.columns } as CSSProperties}>
            {block.items.map((item) => {
              const Icon = FEATURE_ICONS[item.icon];
              return (
                <div className="site-feature" key={item.id}>
                  <span className="site-feature-icon">
                    <Icon size={22} />
                  </span>
                  <Heading level={3} text={item.title} field={itemField(item.id, "title")} />
                  <Paragraphs text={item.text} field={itemField(item.id, "text")} />
                </div>
              );
            })}
          </div>
        </section>
      );
    case "cards":
      return (
        <section className="site-container site-cards">
          {sectionHead(block.heading, block.intro)}
          <div className="site-card-grid" style={{ "--site-columns": block.columns } as CSSProperties}>
            {block.items.map((item) => (
              <div className="site-card" key={item.id}>
                {item.image ? <img src={item.image.url} alt={item.image.alt} loading="lazy" /> : <div className="site-placeholder" />}
                <div className="site-card-body">
                  <Heading level={3} text={item.title} field={itemField(item.id, "title")} />
                  <Paragraphs text={item.text} field={itemField(item.id, "text")} />
                  <Button button={item.button} />
                </div>
              </div>
            ))}
          </div>
        </section>
      );
    case "logos":
      return (
        <section className={`site-container site-logos is-${block.size}`}>
          {sectionHead(block.heading, block.intro)}
          <div className="site-logo-row">
            {block.items.map((item) => {
              const inner = (
                <>
                  {item.image ? <img src={item.image.url} alt={item.image.alt || item.caption} loading="lazy" /> : <div className="site-placeholder" />}
                  {item.caption ? <span>{item.caption}</span> : null}
                </>
              );
              return item.href ? (
                <a className="site-logo" key={item.id} {...linkProps(item.href)}>
                  {inner}
                </a>
              ) : (
                <div className="site-logo" key={item.id}>
                  {inner}
                </div>
              );
            })}
          </div>
        </section>
      );
    case "pricing":
      return (
        <section className="site-container site-pricing">
          {sectionHead(block.heading, block.intro)}
          <div className="site-price-grid">
            {block.items.map((item) => (
              <div className={`site-price${item.highlighted ? " is-highlighted" : ""}`} key={item.id}>
                <Heading level={3} text={item.name} field={itemField(item.id, "name")} />
                <Text as="p" className="site-price-amount" value={item.price} field={itemField(item.id, "price")} />
                <Text as="p" className="site-price-detail" value={item.detail} field={itemField(item.id, "detail")} />
                {item.features ? (
                  <ul className="site-price-features">
                    {item.features
                      .split("\n")
                      .map((line) => line.trim())
                      .filter(Boolean)
                      .map((line, index) => (
                        <li key={index}>{line}</li>
                      ))}
                  </ul>
                ) : null}
                <Button button={item.button} />
              </div>
            ))}
          </div>
        </section>
      );
    case "testimonials":
      return (
        <section className="site-container site-testimonials">
          {sectionHead(block.heading, block.intro)}
          <div className="site-testimonial-grid">
            {block.items
              .filter((item) => item.quote || item.name || item.image)
              .map((item) => (
                <blockquote className={`site-testimonial${item.image && !item.quote && !item.name ? " has-image-only" : ""}`} key={item.id}>
                  {item.image ? <img src={item.image.url} alt={item.image.alt || item.name} loading="lazy" /> : null}
                  <Text as="p" value={item.quote} field={itemField(item.id, "quote")} multiline />
                  {item.name || item.role ? (
                    <footer>
                      <Text as="strong" value={item.name} field={itemField(item.id, "name")} />
                      <Text as="span" value={item.role} field={itemField(item.id, "role")} />
                    </footer>
                  ) : null}
                </blockquote>
              ))}
          </div>
          {block.button ? (
            <div className="site-buttons">
              <Button button={block.button} />
            </div>
          ) : null}
        </section>
      );
    case "faq":
      return (
        <section className="site-container site-faq">
          {sectionHead(block.heading, block.intro)}
          <div className="site-faq-list">
            {block.items
              .filter((item) => item.question)
              .map((item) => (
                <details className="site-faq-item" key={item.id}>
                  <summary>{item.question}</summary>
                  <div className="site-faq-answer">
                    <Paragraphs text={item.answer} field={itemField(item.id, "answer")} />
                  </div>
                </details>
              ))}
          </div>
        </section>
      );
    case "cta":
      return (
        <section className={`site-cta is-${block.tone}`}>
          <div className="site-container site-cta-inner">
            <div>
              <Heading level={2} text={block.heading} field="heading" />
              <Paragraphs text={block.text} className="site-intro" field="text" />
            </div>
            <Button button={block.button} />
          </div>
        </section>
      );
    case "video":
      return (
        <section className="site-container site-video">
          <Heading level={2} text={block.heading} field="heading" />
          <YouTubeFrame videoId={block.youtubeId} title={block.heading} preview={preview} />
          <Text as="p" className="site-caption" value={block.caption} field="caption" />
        </section>
      );
    case "embed":
      return (
        <section className="site-container site-embed">
          {sectionHead(block.heading, block.text)}
          <Frame src={block.url} code={block.code} title={block.heading || "Embed"} height={block.height} className="site-embed-frame" preview={preview} />
        </section>
      );
    case "booking": {
      const url = bookingPageUrl(business.slug, block.screen);
      return (
        <section className="site-container site-booking">
          {sectionHead(block.heading, block.text)}
          {block.mode === "button" ? (
            <div className="site-buttons is-centre">
              <Button button={{ label: block.buttonLabel || "Book now", href: url, style: "primary" }} />
            </div>
          ) : (
            <Frame src={url} title={block.heading || "Book"} height={block.height} className="site-booking-frame" preview={preview} />
          )}
        </section>
      );
    }
    case "venues":
      return (
        <section className="site-container site-venues">
          {sectionHead(block.heading, block.intro)}
          <div className="site-venue-grid" style={{ "--site-columns": block.columns } as CSSProperties}>
            {block.items.map((venue) => (
              <div className="site-venue" key={venue.id}>
                <Heading level={3} text={venue.name} />
                {venue.address ? <p className="site-venue-address">{venue.address}</p> : null}
                {venue.showMap && venue.address ? <MapFrame address={venue.address} preview={preview} /> : null}
                {venue.hours ? (
                  <div className="site-venue-hours">
                    <Paragraphs text={venue.hours} />
                  </div>
                ) : null}
                <Paragraphs text={venue.text} />
                {venue.booking !== "none" ? (
                  <Frame src={bookingPageUrl(business.slug, venue.booking)} title={venue.name || "Book"} height={venue.height} className="site-booking-frame" preview={preview} />
                ) : venue.embedUrl ? (
                  <Frame src={venue.embedUrl} title={venue.name || "Book"} height={venue.height} className="site-embed-frame" preview={preview} />
                ) : null}
              </div>
            ))}
          </div>
        </section>
      );
    case "form":
      return (
        <section className="site-container site-contact-form">
          {sectionHead(block.heading, block.text)}
          <FormBlock block={block} business={business.slug} pageSlug={page.slug} preview={preview} />
        </section>
      );
    case "shop":
      return (
        <section className="site-container site-shop">
          {sectionHead(block.heading, block.intro)}
          <ShopBlock block={block} business={business} preview={preview} returnPath={returnPath} returnQuery={returnQuery} />
        </section>
      );
    case "articles": {
      const articles = pages
        .filter((candidate) => candidate.kind === "article" && candidate.slug !== page.slug)
        .sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.sortOrder - b.sortOrder)
        .slice(0, block.limit);
      return (
        <section className="site-container site-articles">
          {sectionHead(block.heading, block.intro)}
          {articles.length ? (
            <div className="site-article-grid">
              {articles.map((article) => (
                <a className="site-article-card" key={article.slug} {...linkProps(`page:${article.slug}`)}>
                  {article.cover ? <img src={article.cover.url} alt={article.cover.alt} loading="lazy" /> : null}
                  <span className="site-article-card-body">
                    {article.date ? <time dateTime={article.date}>{formatSiteDate(article.date)}</time> : null}
                    <strong>{article.title || article.slug}</strong>
                    {article.summary ? <span>{article.summary}</span> : null}
                  </span>
                </a>
              ))}
            </div>
          ) : preview ? (
            <div className="site-placeholder">
              <span>{previewLabels?.noArticles || "No articles yet"}</span>
            </div>
          ) : null}
        </section>
      );
    }
    case "videos": {
      const videos = pages
        .filter((candidate) => candidate.kind === "video" && candidate.slug !== page.slug)
        .sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.sortOrder - b.sortOrder)
        .slice(0, block.limit);
      return (
        <section className="site-container site-videos">
          {sectionHead(block.heading, block.intro)}
          {videos.length ? (
            <div className={`site-video-list is-${block.layout}`}>
              {videos.map((video) => {
                const picture = video.cover?.url || youtubeThumbnail(video.video);
                return (
                  <a className="site-video-card" key={video.slug} {...linkProps(`page:${video.slug}`)}>
                    <span className="site-video-card-picture">
                      {picture ? <img src={picture} alt={video.cover?.alt || ""} loading="lazy" /> : null}
                      <Video size={22} />
                    </span>
                    <span className="site-video-card-body">
                      <strong>{video.title || video.slug}</strong>
                      {video.summary ? <span>{video.summary}</span> : null}
                    </span>
                  </a>
                );
              })}
            </div>
          ) : preview ? (
            <div className="site-placeholder">
              <span>{previewLabels?.noVideos || "No videos yet"}</span>
            </div>
          ) : null}
        </section>
      );
    }
    case "instagram": {
      const profile = instagramUrl(block.handle);
      return (
        <section className="site-container site-instagram">
          <div className="site-instagram-head">
            <Heading level={2} text={block.heading} field="heading" />
            {profile ? (
              <a className="site-instagram-handle" href={profile} target="_blank" rel="noreferrer">
                <Instagram size={18} /> @{block.handle}
              </a>
            ) : null}
          </div>
          <div className="site-instagram-grid" style={{ "--site-columns": block.columns } as CSSProperties}>
            {block.items.length ? (
              block.items.map((item) => {
                const picture = item.image ? <img src={item.image.url} alt={item.image.alt} loading="lazy" /> : <span className="site-instagram-empty" />;
                const href = item.href || profile;
                return href ? (
                  <a key={item.id} href={href} target="_blank" rel="noreferrer">
                    {picture}
                  </a>
                ) : (
                  <span key={item.id}>{picture}</span>
                );
              })
            ) : (
              <div className="site-placeholder" />
            )}
          </div>
          {profile ? (
            <div className="site-buttons is-centre">
              <a className="site-button is-primary" href={profile} target="_blank" rel="noreferrer">
                Follow @{block.handle}
              </a>
            </div>
          ) : null}
        </section>
      );
    }
    case "contact":
      return (
        <section className="site-container site-contact">
          <div className="site-contact-copy">
            <Heading level={2} text={block.heading} field="heading" />
            <Paragraphs text={block.text} className="site-intro" field="text" />
            <ul className="site-contact-list">
              {block.email ? (
                <li>
                  <Mail size={18} />
                  <a href={`mailto:${block.email}`}>{block.email}</a>
                </li>
              ) : null}
              {block.phone ? (
                <li>
                  <Phone size={18} />
                  <a href={`tel:${block.phone.replace(/[^+\d]/g, "")}`}>{block.phone}</a>
                </li>
              ) : null}
              {block.address ? (
                <li>
                  <MapPin size={18} />
                  <span>{block.address}</span>
                </li>
              ) : null}
              {block.hours ? (
                <li>
                  <Clock size={18} />
                  <span className="site-contact-hours">
                    <Paragraphs text={block.hours} />
                  </span>
                </li>
              ) : null}
            </ul>
          </div>
          {block.showMap && block.address ? <MapFrame address={block.address} preview={preview} /> : null}
        </section>
      );
    case "canvas":
      return <CanvasBlock block={block} Button={Button} linkProps={linkProps} />;
    case "divider":
      return <div className={`site-container site-divider is-${block.line} is-${block.size}`}>{block.line === "line" ? <hr /> : null}</div>;
    default:
      return null;
  }
}
