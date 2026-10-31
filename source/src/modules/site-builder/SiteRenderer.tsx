// A page, drawn.
//
// The one renderer for both the editor's preview and the public page. In
// preview mode a click on a block selects it instead of following links, and
// the heavy embeds (booking widget, map) are stood in for by a labelled box
// so the preview stays light and never books anything.

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
import type {
  SiteBlock,
  SiteButton,
  SiteDocument,
  SiteFeatureIcon,
  SiteSocialKind,
} from "../../../netlify/functions/_shared/site/document.mts";
import { bookingPageUrl, siteThemeClassName, siteThemeStyle } from "./siteTheme";

export type SiteBusiness = { slug: string; name: string; logo: string; showLogo: boolean };

export type SiteSelection = "page" | "header" | "footer" | { block: string };

export type SiteRendererProps = {
  document: SiteDocument;
  business: SiteBusiness;
  /** "preview" inside the editor; "public" on the page itself. */
  mode: "preview" | "public";
  selected?: SiteSelection;
  onSelect?: (selection: SiteSelection) => void;
  /** Preview only: the words on the stand-in boxes, in the coach's language. */
  previewLabels?: { booking: string; map: string };
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

const external = (href: string) => (/^https?:/.test(href) ? { target: "_blank", rel: "noreferrer" } : {});

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

function Button({ button, className = "" }: { button: SiteButton | null; className?: string }) {
  if (!button) return null;
  const classes = `site-button is-${button.style} ${className}`.trim();
  if (!button.href) return <span className={`${classes} is-unlinked`}>{button.label}</span>;
  return (
    <a className={classes} href={button.href} {...external(button.href)}>
      {button.label}
    </a>
  );
}

function Heading({ level, text, className = "" }: { level: 1 | 2 | 3; text: string; className?: string }) {
  if (!text) return null;
  const Tag = `h${level}` as const;
  return <Tag className={`site-heading ${className}`.trim()}>{text}</Tag>;
}

export function SiteRenderer({ document, business, mode, selected, onSelect, previewLabels }: SiteRendererProps) {
  const preview = mode === "preview";
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

  const { header, footer, theme } = document;
  const showBrand = header.showLogo && business.showLogo && business.logo;

  return (
    <div
      className={`${siteThemeClassName(theme)} ${preview ? "is-preview" : ""}`}
      style={siteThemeStyle(theme)}
      // In the preview every link is inert: the coach is editing, not browsing.
      onClickCapture={preview ? (event) => { if ((event.target as HTMLElement).closest("a")) event.preventDefault(); } : undefined}
    >
      {frame(
        "header",
        `site-header${header.sticky ? " is-sticky" : ""}`,
        <div className="site-container site-header-inner">
          <a className="site-brand" href="#top">
            {showBrand ? <img className="site-brand-logo" src={business.logo} alt="" /> : null}
            {header.showName || !showBrand ? <span className="site-brand-name">{business.name}</span> : null}
          </a>
          {header.links.length ? (
            <nav className="site-nav" aria-label="Site">
              {header.links.map((link, index) => (
                <a href={link.href || "#"} key={index} {...external(link.href)}>
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
        {document.blocks.map((block) =>
          frame(
            { block: block.id },
            `site-block site-block-${block.type}`,
            <Block block={block} business={business} preview={preview} previewLabels={previewLabels} />,
            block.id,
          ),
        )}
      </main>

      {frame(
        "footer",
        "site-footer",
        <div className="site-container site-footer-inner">
          <div className="site-footer-text">{footer.text ? <p>{footer.text}</p> : null}</div>
          {footer.links.length ? (
            <nav className="site-footer-links" aria-label="Footer">
              {footer.links.map((link, index) => (
                <a href={link.href || "#"} key={index} {...external(link.href)}>
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
  business,
  preview,
  previewLabels,
}: {
  block: SiteBlock;
  business: SiteBusiness;
  preview: boolean;
  previewLabels?: { booking: string; map: string };
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
