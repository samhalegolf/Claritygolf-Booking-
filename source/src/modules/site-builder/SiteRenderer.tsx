// A page of a site, drawn.
//
// The one renderer for both the editor's preview and the public page. In
// preview mode a click on a block selects it instead of following links, a
// click on a page link switches the editor to that page, and the heavy
// embeds (booking widget, map) are stood in for by a labelled box so the
// preview stays light and never books anything.

import type { CSSProperties, MouseEvent, ReactNode } from "react";
import {
  Award,
  Calendar,
  ChartLine,
  Clock,
  Facebook,
  Flag,
  GraduationCap,
  Heart,
  Instagram,
  Link as LinkIcon,
  Linkedin,
  Mail,
  MapPin,
  Phone,
  Shield,
  Star,
  Sun,
  Target,
  Trophy,
  Users,
  Video,
  Youtube,
  Zap,
} from "lucide-react";
import {
  HOME_PAGE_SLUG,
  pageSlugFromHref,
  type SiteBlock,
  type SiteButton,
  type SiteFeatureIcon,
  type SitePage,
  type SitePageCard,
  type SiteSettings,
  type SiteSocialKind,
} from "../../../netlify/functions/_shared/site/document.mts";
import { ShopBlock } from "./ShopBlock";
import { bookingPageUrl, siteThemeClassName, siteThemeStyle } from "./siteTheme";

export type SiteBusiness = { slug: string; name: string; logo: string; showLogo: boolean };

export type SiteSelection = "site" | "header" | "footer" | "page" | { block: string };

export type PreviewLabels = { booking: string; map: string; shop: string; noArticles: string; noPage: string };

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
function Paragraphs({ text, className = "" }: { text: string; className?: string }) {
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

function Heading({ level, text, className = "" }: { level: 1 | 2 | 3; text: string; className?: string }) {
  if (!text) return null;
  const Tag = `h${level}` as const;
  return <Tag className={`site-heading ${className}`.trim()}>{text}</Tag>;
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
}: SiteRendererProps) {
  const preview = mode === "preview";
  const linkProps = makeLinkProps(pagePath, onNavigate);
  const select = (selection: SiteSelection) => (event: MouseEvent) => {
    if (!preview || !onSelect) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(selection);
  };
  const frame = (target: SiteSelection, className: string, children: ReactNode, id?: string) => (
    <div
      className={`${className}${preview ? " is-editable" : ""}${isSelected(selected, target) ? " is-selected" : ""}`}
      id={id}
      key={id ?? className}
      onClick={select(target)}
    >
      {children}
    </div>
  );

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

  const { header, footer, theme } = settings;
  const showBrand = header.showLogo && business.showLogo && business.logo;
  const menu = pages.filter((candidate) => candidate.inNav).sort((a, b) => a.sortOrder - b.sortOrder);
  const returnPath = pagePath(page.slug);

  return (
    <div
      className={`${siteThemeClassName(theme)} ${preview ? "is-preview" : ""}${busy ? " is-busy" : ""}`}
      style={siteThemeStyle(theme)}
      // In the preview every link is inert: the coach is editing, not browsing.
      onClickCapture={preview ? (event) => { if ((event.target as HTMLElement).closest("a")) event.preventDefault(); } : undefined}
    >
      {frame(
        "header",
        `site-header${header.sticky ? " is-sticky" : ""}`,
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
          <Button button={header.button} className="site-header-button" />
        </div>,
        "top",
      )}

      <main className="site-main">
        {missingPage ? (
          <section className="site-container site-missing">
            <h1 className="site-heading">{previewLabels?.noPage || "There is no page here"}</h1>
          </section>
        ) : null}
        {!missingPage && page.kind === "article" && page.content.date ? (
          <p className="site-container site-article-date">{formatSiteDate(page.content.date)}</p>
        ) : null}
        {!missingPage
          ? page.content.blocks.map((block) =>
              frame(
                { block: block.id },
                `site-block site-block-${block.type}`,
                <Block
                  block={block}
                  page={page}
                  pages={pages}
                  business={business}
                  preview={preview}
                  previewLabels={previewLabels}
                  linkProps={linkProps}
                  Button={Button}
                  returnPath={returnPath}
                  returnQuery={returnQuery}
                />,
                block.id,
              ),
            )
          : null}
      </main>

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
          {footer.social.length ? (
            <div className="site-social">
              {footer.social.map((entry, index) => {
                const { label, Icon } = SOCIAL[entry.kind];
                return (
                  <a href={entry.url} key={index} aria-label={label} title={label} target="_blank" rel="noreferrer">
                    <Icon size={18} />
                  </a>
                );
              })}
            </div>
          ) : null}
          {footer.showCredit ? (
            <p className="site-credit">
              <a href="https://claritygolf.app" target="_blank" rel="noreferrer">
                Made with Clarity
              </a>
            </p>
          ) : null}
        </div>,
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
  preview: boolean;
  previewLabels?: PreviewLabels;
  linkProps: (href: string) => LinkProps;
  Button: (props: { button: SiteButton | null; className?: string }) => ReactNode;
  returnPath: string;
  returnQuery?: URLSearchParams;
}) {
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
              {block.eyebrow ? <p className="site-eyebrow">{block.eyebrow}</p> : null}
              <Heading level={1} text={block.heading} className="site-hero-heading" />
              <Paragraphs text={block.text} className="site-lede" />
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
                <img src={block.image.url} alt={block.image.alt} loading="eager" />
              </div>
            ) : null}
          </div>
        </section>
      );
    }
    case "text":
      return (
        <section className={`site-container site-text is-${block.align} is-columns-${block.columns}`}>
          <Heading level={2} text={block.heading} />
          <div className="site-text-body">
            <Paragraphs text={block.body} />
          </div>
        </section>
      );
    case "image":
      return (
        <figure className={`site-figure is-${block.size}`}>
          {block.image ? <img src={block.image.url} alt={block.image.alt} loading="lazy" /> : <div className="site-placeholder" />}
          {block.caption ? <figcaption>{block.caption}</figcaption> : null}
        </figure>
      );
    case "gallery":
      return (
        <section className="site-container site-gallery">
          <Heading level={2} text={block.heading} />
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
        </section>
      );
    case "features":
      return (
        <section className="site-container site-features">
          <div className="site-section-head">
            <Heading level={2} text={block.heading} />
            <Paragraphs text={block.intro} className="site-intro" />
          </div>
          <div className="site-feature-grid" style={{ "--site-columns": block.columns } as CSSProperties}>
            {block.items.map((item) => {
              const Icon = FEATURE_ICONS[item.icon];
              return (
                <div className="site-feature" key={item.id}>
                  <span className="site-feature-icon">
                    <Icon size={22} />
                  </span>
                  <Heading level={3} text={item.title} />
                  <Paragraphs text={item.text} />
                </div>
              );
            })}
          </div>
        </section>
      );
    case "pricing":
      return (
        <section className="site-container site-pricing">
          <div className="site-section-head">
            <Heading level={2} text={block.heading} />
            <Paragraphs text={block.intro} className="site-intro" />
          </div>
          <div className="site-price-grid">
            {block.items.map((item) => (
              <div className={`site-price${item.highlighted ? " is-highlighted" : ""}`} key={item.id}>
                <Heading level={3} text={item.name} />
                {item.price ? <p className="site-price-amount">{item.price}</p> : null}
                {item.detail ? <p className="site-price-detail">{item.detail}</p> : null}
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
          <Heading level={2} text={block.heading} />
          <div className="site-testimonial-grid">
            {block.items
              .filter((item) => item.quote || item.name)
              .map((item) => (
                <blockquote className="site-testimonial" key={item.id}>
                  <p>{item.quote}</p>
                  {item.name || item.role ? (
                    <footer>
                      <strong>{item.name}</strong>
                      {item.role ? <span>{item.role}</span> : null}
                    </footer>
                  ) : null}
                </blockquote>
              ))}
          </div>
        </section>
      );
    case "faq":
      return (
        <section className="site-container site-faq">
          <div className="site-section-head">
            <Heading level={2} text={block.heading} />
            <Paragraphs text={block.intro} className="site-intro" />
          </div>
          <div className="site-faq-list">
            {block.items
              .filter((item) => item.question)
              .map((item) => (
                <details className="site-faq-item" key={item.id}>
                  <summary>{item.question}</summary>
                  <div className="site-faq-answer">
                    <Paragraphs text={item.answer} />
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
              <Heading level={2} text={block.heading} />
              <Paragraphs text={block.text} className="site-intro" />
            </div>
            <Button button={block.button} />
          </div>
        </section>
      );
    case "video":
      return (
        <section className="site-container site-video">
          <Heading level={2} text={block.heading} />
          {block.youtubeId ? (
            <div className="site-video-frame">
              <iframe
                src={`https://www.youtube-nocookie.com/embed/${block.youtubeId}?rel=0&modestbranding=1&playsinline=1`}
                title={block.heading || "Video"}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
                loading="lazy"
              />
            </div>
          ) : (
            <div className="site-placeholder is-video" />
          )}
          {block.caption ? <p className="site-caption">{block.caption}</p> : null}
        </section>
      );
    case "booking": {
      const url = bookingPageUrl(business.slug, block.screen);
      return (
        <section className="site-container site-booking">
          <div className="site-section-head">
            <Heading level={2} text={block.heading} />
            <Paragraphs text={block.text} className="site-intro" />
          </div>
          {block.mode === "button" ? (
            <div className="site-buttons is-centre">
              <Button button={{ label: block.buttonLabel || "Book now", href: url, style: "primary" }} />
            </div>
          ) : preview ? (
            <div className="site-placeholder is-embed" style={{ height: Math.min(block.height, 420) }}>
              <span>{previewLabels?.booking || "Booking"}</span>
            </div>
          ) : (
            <iframe
              className="site-booking-frame"
              src={url}
              title={block.heading || "Book"}
              allow="web-share; clipboard-write; payment"
              style={{ height: block.height }}
              loading="lazy"
            />
          )}
        </section>
      );
    }
    case "shop":
      return (
        <section className="site-container site-shop">
          <div className="site-section-head">
            <Heading level={2} text={block.heading} />
            <Paragraphs text={block.intro} className="site-intro" />
          </div>
          <ShopBlock block={block} business={business} preview={preview} previewLabel={previewLabels?.shop || "Shop"} returnPath={returnPath} returnQuery={returnQuery} />
        </section>
      );
    case "articles": {
      const articles = pages
        .filter((candidate) => candidate.kind === "article" && candidate.slug !== page.slug)
        .sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.sortOrder - b.sortOrder)
        .slice(0, block.limit);
      return (
        <section className="site-container site-articles">
          <div className="site-section-head">
            <Heading level={2} text={block.heading} />
            <Paragraphs text={block.intro} className="site-intro" />
          </div>
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
    case "contact":
      return (
        <section className="site-container site-contact">
          <div className="site-contact-copy">
            <Heading level={2} text={block.heading} />
            <Paragraphs text={block.text} className="site-intro" />
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
          {block.showMap && block.address ? (
            preview ? (
              <div className="site-placeholder is-map">
                <span>{previewLabels?.map || "Map"}</span>
              </div>
            ) : (
              <iframe
                className="site-map"
                src={`https://www.google.com/maps?q=${encodeURIComponent(block.address)}&output=embed`}
                title={block.address}
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
              />
            )
          ) : null}
        </section>
      );
    case "divider":
      return <div className={`site-container site-divider is-${block.style} is-${block.size}`}>{block.style === "line" ? <hr /> : null}</div>;
    default:
      return null;
  }
}

