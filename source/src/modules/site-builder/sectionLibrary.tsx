// The "Add section" gallery: ready-made section layouts in categories, the
// way Squarespace offers them. Every choice is one of the builder's blocks
// with a few of its settings chosen (a hero with the picture on the right, a
// three-across grid of cards...), so what lands on the page is an ordinary
// block, edited like any other. The pictures are little sketches of the
// layout, drawn in CSS (site-builder.css, .site-sketch).

import type { ReactNode } from "react";

import { newSiteBlock, type SiteBlock, type SiteBlockType } from "../../../netlify/functions/_shared/site/document.mts";
import { t } from "../../lib/i18n";

export type SectionChoice = {
  id: string;
  category: string;
  label: string;
  type: SiteBlockType;
  /** Settings that make this layout, over the block's own starting ones. */
  patch?: Record<string, unknown>;
  sketch: ReactNode;
};

const H = () => <i className="h" />;
const L = ({ short = false }: { short?: boolean }) => <i className={short ? "l is-short" : "l"} />;
const I = ({ tall = false }: { tall?: boolean }) => <i className={tall ? "i is-tall" : "i"} />;
const B = () => <i className="b" />;
const Col = ({ children, centre = false }: { children: ReactNode; centre?: boolean }) => <span className={centre ? "c is-centre" : "c"}>{children}</span>;
const Row = ({ children }: { children: ReactNode }) => <span className="r">{children}</span>;

const columns = (count: number, cell: () => ReactNode) => (
  <Row>
    {Array.from({ length: count }, (_, index) => (
      <Col key={index}>{cell()}</Col>
    ))}
  </Row>
);

export const SECTION_CATEGORIES = [
  t("Intro"),
  t("Text"),
  t("Images"),
  t("Lists"),
  t("Reviews and questions"),
  t("Call to action"),
  t("Contact"),
  t("Video and media"),
  t("Articles and videos"),
  t("Booking and shop"),
  t("Layout"),
] as const;

const [INTRO, TEXT, IMAGES, LISTS, REVIEWS, CTA, CONTACT, MEDIA, POSTS, BOOKING, LAYOUT] = SECTION_CATEGORIES;

export const SECTION_LIBRARY: readonly SectionChoice[] = [
  { id: "hero-centre", category: INTRO, label: t("Centred heading"), type: "hero", patch: { layout: "centre" }, sketch: <Col centre><H /><L /><B /></Col> },
  { id: "hero-split", category: INTRO, label: t("Words left, picture right"), type: "hero", patch: { layout: "split" }, sketch: <Row><Col><H /><L /><B /></Col><Col><I tall /></Col></Row> },
  { id: "hero-split-left", category: INTRO, label: t("Picture left, words right"), type: "hero", patch: { layout: "split-left" }, sketch: <Row><Col><I tall /></Col><Col><H /><L /><B /></Col></Row> },
  { id: "hero-cover", category: INTRO, label: t("Words over a full picture"), type: "hero", patch: { layout: "cover", height: "tall" }, sketch: <span className="site-sketch-cover"><Col centre><H /><L short /><B /></Col></span> },
  { id: "hero-left", category: INTRO, label: t("Heading on the left"), type: "hero", patch: { layout: "left" }, sketch: <Col><H /><L /><L short /><B /></Col> },

  { id: "text", category: TEXT, label: t("Heading and paragraphs"), type: "text", sketch: <Col><H /><L /><L /><L short /></Col> },
  { id: "text-centre", category: TEXT, label: t("Centred text"), type: "text", patch: { align: "centre" }, sketch: <Col centre><H /><L /><L short /></Col> },
  { id: "text-columns", category: TEXT, label: t("Text in two columns"), type: "text", patch: { columns: 2 }, sketch: <Col><H />{columns(2, () => <><L /><L /><L short /></>)}</Col> },

  { id: "image-wide", category: IMAGES, label: t("One wide picture"), type: "image", patch: { size: "wide" }, sketch: <Col><I tall /></Col> },
  { id: "image-full", category: IMAGES, label: t("Edge-to-edge picture"), type: "image", patch: { size: "full" }, sketch: <span className="site-sketch-cover" /> },
  { id: "image-inset", category: IMAGES, label: t("Smaller picture with a caption"), type: "image", patch: { size: "inset" }, sketch: <Col centre><I /><L short /></Col> },
  { id: "gallery-3", category: IMAGES, label: t("Gallery, three across"), type: "gallery", patch: { columns: 3 }, sketch: <Col>{columns(3, () => <I />)}{columns(3, () => <I />)}</Col> },
  { id: "gallery-2", category: IMAGES, label: t("Gallery, two across"), type: "gallery", patch: { columns: 2 }, sketch: <Col>{columns(2, () => <I />)}</Col> },
  { id: "logos", category: IMAGES, label: t("Logos in a row"), type: "logos", sketch: <Col centre><H />{columns(4, () => <I />)}</Col> },

  { id: "features-3", category: LISTS, label: t("Three points with icons"), type: "features", patch: { columns: 3 }, sketch: <Col><H />{columns(3, () => <><B /><L /><L short /></>)}</Col> },
  { id: "features-2", category: LISTS, label: t("Two columns of points"), type: "features", patch: { columns: 2 }, sketch: <Col><H />{columns(2, () => <><B /><L /><L short /></>)}</Col> },
  { id: "cards-3", category: LISTS, label: t("Cards, three across"), type: "cards", patch: { columns: 3 }, sketch: <Col><H />{columns(3, () => <><I /><L /><B /></>)}</Col> },
  { id: "cards-4", category: LISTS, label: t("Cards, four across"), type: "cards", patch: { columns: 4 }, sketch: <Col><H />{columns(4, () => <><I /><L short /><B /></>)}</Col> },
  { id: "pricing", category: LISTS, label: t("Prices side by side"), type: "pricing", sketch: <Col><H />{columns(3, () => <><L short /><H /><L /><B /></>)}</Col> },

  { id: "testimonials", category: REVIEWS, label: t("Reviews"), type: "testimonials", sketch: <Col><H />{columns(2, () => <><L /><L /><L short /></>)}</Col> },
  { id: "faq", category: REVIEWS, label: t("Questions and answers"), type: "faq", sketch: <Col><H /><L /><L /><L /></Col> },

  { id: "cta-primary", category: CTA, label: t("A coloured band with a button"), type: "cta", patch: { tone: "primary" }, sketch: <span className="site-sketch-band"><Row><Col><H /></Col><B /></Row></span> },
  { id: "cta-surface", category: CTA, label: t("A light band with a button"), type: "cta", patch: { tone: "surface" }, sketch: <Row><Col><H /><L short /></Col><B /></Row> },

  { id: "contact", category: CONTACT, label: t("Contact details and a map"), type: "contact", patch: { showMap: true }, sketch: <Row><Col><H /><L /><L short /></Col><Col><I tall /></Col></Row> },
  { id: "form", category: CONTACT, label: t("Contact form"), type: "form", sketch: <Col><H /><i className="f" /><i className="f" /><i className="f is-tall" /><B /></Col> },

  { id: "video", category: MEDIA, label: t("YouTube video"), type: "video", sketch: <Col centre><H /><span className="site-sketch-play"><I tall /></span></Col> },
  { id: "instagram", category: MEDIA, label: t("Instagram grid"), type: "instagram", sketch: <Col><H />{columns(4, () => <I />)}</Col> },
  { id: "embed", category: MEDIA, label: t("Embed another website"), type: "embed", sketch: <Col><H /><i className="f is-tall" /></Col> },

  { id: "articles", category: POSTS, label: t("Latest articles"), type: "articles", sketch: <Col><H />{columns(3, () => <><I /><L /></>)}</Col> },
  { id: "videos-grid", category: POSTS, label: t("Video library, grid"), type: "videos", patch: { layout: "grid" }, sketch: <Col><H />{columns(3, () => <><I /><L short /></>)}</Col> },
  { id: "videos-list", category: POSTS, label: t("Video library, list"), type: "videos", patch: { layout: "list" }, sketch: <Col><H /><Row><Col><I /></Col><Col><L /><L short /></Col></Row><Row><Col><I /></Col><Col><L /><L short /></Col></Row></Col> },

  { id: "booking", category: BOOKING, label: t("Booking page on the page"), type: "booking", sketch: <Col><H /><i className="f is-tall" /></Col> },
  { id: "booking-button", category: BOOKING, label: t("Booking button"), type: "booking", patch: { mode: "button" }, sketch: <Col centre><H /><B /></Col> },
  { id: "venues", category: BOOKING, label: t("Venues with maps"), type: "venues", sketch: <Col><H />{columns(2, () => <><I /><L /><L short /></>)}</Col> },
  { id: "shop", category: BOOKING, label: t("Shop"), type: "shop", sketch: <Col><H />{columns(3, () => <><I /><L short /><B /></>)}</Col> },

  { id: "divider-line", category: LAYOUT, label: t("A line"), type: "divider", patch: { line: "line" }, sketch: <Col centre><L /></Col> },
  { id: "divider-space", category: LAYOUT, label: t("Some space"), type: "divider", patch: { line: "space", size: "large" }, sketch: <Col centre><span className="site-sketch-gap" /></Col> },
];

/** A fresh block for a gallery choice: the block's own start, with the choice's settings over it. */
export function blockForChoice(choice: SectionChoice): SiteBlock {
  return { ...newSiteBlock(choice.type), ...(choice.patch || {}) } as SiteBlock;
}
