// What the right-hand column shows for whatever is selected: the site's
// look, the header, the footer, the page itself, or one block.
import { ExternalLink, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import {
  HOME_PAGE_SLUG,
  SITE_BOOKING_SCREENS,
  SITE_FEATURE_ICONS,
  SITE_FONTS,
  SITE_SOCIAL_KINDS,
  SITE_THEME_PRESETS,
  cleanPageSlug,
  siteId,
  themeFromPreset,
  MAX_EMBED_CODE,
  embedSource,
  type SiteBlock,
  type SiteBlockStyle,
  type SiteFooter,
  type SiteHeader,
  type SitePage,
  type SiteSettings,
  type SiteSocialLink,
  type SiteTheme,
  type SitePictureShape,
} from "../../../netlify/functions/_shared/site/document.mts";
import { t } from "../../lib/i18n";
import { BOOKING_SCREENS } from "../public-booking/bookingScreens";
import { ButtonInput, ColorInput, DateInput, ImageInput, LinkInput, ListEditor, NumberInput, SelectInput, TextArea, TextInput, ToggleInput, type PageOption } from "./fields";
import { fetchCoachShop, updateCoachShop, type CoachShop } from "./siteApi";
import { money } from "./ShopBlock";

type Common = { pages: PageOption[]; bookingHref: string; onError: (message: string) => void };

const alignOptions = () => [
  { value: "left" as const, label: t("Left") },
  { value: "centre" as const, label: t("Centred") },
];

const fontOptions = SITE_FONTS.map((font) => ({ value: font.id, label: font.label }));

export function SiteInspector({ settings, onChange }: { settings: SiteSettings; onChange: (next: SiteSettings) => void }) {
  const theme = settings.theme;
  const setTheme = (patch: Partial<SiteTheme>) => onChange({ ...settings, theme: { ...theme, ...patch } });
  const setColor = (key: keyof SiteTheme["colors"], value: string) => setTheme({ colors: { ...theme.colors, [key]: value } });
  return (
    <>
      <h3 className="site-inspector-title">{t("Look")}</h3>
      <p className="site-field-help">{t("Colours, fonts and shapes apply to every page of the site.")}</p>
      <div className="site-presets" role="group" aria-label={t("Colour presets")}>
        {SITE_THEME_PRESETS.map((preset) => (
          <button
            type="button"
            key={preset.id}
            className={`site-preset${theme.preset === preset.id ? " is-active" : ""}`}
            onClick={() => setTheme(themeFromPreset(preset.id))}
            style={{ background: preset.theme.colors.background, color: preset.theme.colors.text }}
          >
            <span className="site-preset-swatches">
              <i style={{ background: preset.theme.colors.primary }} />
              <i style={{ background: preset.theme.colors.accent }} />
              <i style={{ background: preset.theme.colors.surface }} />
            </span>
            {preset.label}
          </button>
        ))}
      </div>
      <SelectInput label={t("Heading font")} value={theme.headingFont} onChange={(headingFont) => setTheme({ headingFont })} options={fontOptions} />
      <SelectInput label={t("Body font")} value={theme.bodyFont} onChange={(bodyFont) => setTheme({ bodyFont })} options={fontOptions} />
      <div className="site-colours">
        <ColorInput label={t("Background")} value={theme.colors.background} onChange={(value) => setColor("background", value)} />
        <ColorInput label={t("Panels")} value={theme.colors.surface} onChange={(value) => setColor("surface", value)} />
        <ColorInput label={t("Text")} value={theme.colors.text} onChange={(value) => setColor("text", value)} />
        <ColorInput label={t("Quiet text")} value={theme.colors.muted} onChange={(value) => setColor("muted", value)} />
        <ColorInput label={t("Buttons")} value={theme.colors.primary} onChange={(value) => setColor("primary", value)} />
        <ColorInput label={t("Text on buttons")} value={theme.colors.onPrimary} onChange={(value) => setColor("onPrimary", value)} />
        <ColorInput label={t("Highlight")} value={theme.colors.accent} onChange={(value) => setColor("accent", value)} />
        <ColorInput label={t("Headings")} value={theme.colors.heading} onChange={(value) => setColor("heading", value)} />
      </div>
      <SelectInput
        label={t("Corners")}
        value={theme.corners}
        onChange={(corners) => setTheme({ corners })}
        options={[
          { value: "sharp", label: t("Sharp") },
          { value: "soft", label: t("Soft") },
          { value: "round", label: t("Round") },
        ]}
      />
      <SelectInput
        label={t("Button shape")}
        value={theme.buttons}
        onChange={(buttons) => setTheme({ buttons })}
        options={[
          { value: "filled", label: t("Filled") },
          { value: "outline", label: t("Outlined") },
          { value: "pill", label: t("Pill") },
        ]}
      />
      <SelectInput
        label={t("Page width")}
        value={theme.width}
        onChange={(width) => setTheme({ width })}
        options={[
          { value: "narrow", label: t("Narrow") },
          { value: "regular", label: t("Regular") },
          { value: "wide", label: t("Wide") },
        ]}
      />
      <SelectInput
        label={t("Spacing")}
        value={theme.spacing}
        onChange={(spacing) => setTheme({ spacing })}
        options={[
          { value: "compact", label: t("Compact") },
          { value: "regular", label: t("Regular") },
          { value: "airy", label: t("Airy") },
        ]}
      />
    </>
  );
}

/** The page itself: its name in the menu, its address, and what an article shows on an index. */
export function PageInspector({
  page,
  pages,
  onChange,
  onDelete,
  onError,
}: {
  page: SitePage;
  pages: PageOption[];
  onChange: (next: SitePage) => void;
  onDelete: () => void;
  onError: (message: string) => void;
}) {
  const isHome = page.slug === HOME_PAGE_SLUG;
  const content = page.content;
  const setContent = (patch: Partial<SitePage["content"]>) => onChange({ ...page, content: { ...content, ...patch } });
  // `pages` is every other page: a clash is any of them at this address.
  const slugTaken = pages.some((other) => other.slug === page.slug);
  return (
    <>
      <h3 className="site-inspector-title">{t("This page")}</h3>
      <TextInput label={t("Name in the menu")} value={page.title} maxLength={120} onChange={(title) => onChange({ ...page, title })} />
      <TextInput
        label={t("Address")}
        value={page.slug}
        maxLength={60}
        readOnly={isHome}
        onChange={(slug) => onChange({ ...page, slug: cleanPageSlug(slug, "") || slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-") })}
        help={isHome ? t("The home page is the site's front door: its address cannot change.") : t("Lower-case letters, digits and hyphens. The page lives at /{slug} on your domain.", { slug: page.slug })}
      />
      {slugTaken ? <p className="workspace-save-error">{t("Another page already has this address.")}</p> : null}
      <TextArea label={t("Description for search engines")} value={content.description} rows={3} maxLength={300} onChange={(description) => setContent({ description })} />
      <details className="site-list-item site-section-style">
        <summary>{t("Search and sharing: title and picture")}</summary>
        <TextInput label={t("Title for search results and the browser tab")} value={content.seoTitle} maxLength={120} onChange={(seoTitle) => setContent({ seoTitle })} help={t("Leave empty for the page's name and your business name.")} />
        <ImageInput label={t("Picture when shared")} value={content.socialImage} onChange={(socialImage) => setContent({ socialImage })} onError={onError} />
        <p className="site-field-help">{t("Shown by Facebook, WhatsApp and the like when this page's link is shared. Leave empty for the cover picture or your logo.")}</p>
      </details>
      {!isHome ? <ToggleInput label={t("Show in the menu")} checked={page.inNav} onChange={(inNav) => onChange({ ...page, inNav })} /> : null}
      {!isHome ? (
        <SelectInput
          label={t("Kind of page")}
          value={page.kind}
          onChange={(kind) => onChange({ ...page, kind })}
          options={[
            { value: "page", label: t("Page") },
            { value: "article", label: t("Article") },
            { value: "video", label: t("Video") },
          ]}
        />
      ) : null}
      {page.kind === "video" ? (
        <TextInput
          label={t("YouTube link")}
          value={content.video}
          maxLength={400}
          placeholder="https://youtu.be/…"
          onChange={(video) => setContent({ video })}
          help={t("Plays at the top of this page. Paste the video's address; only the video id is kept.")}
        />
      ) : null}
      {page.kind === "article" || page.kind === "video" ? (
        <>
          <p className="site-field-help">
            {page.kind === "video"
              ? t("A video is listed on any page with a Videos block, newest first, with these details.")
              : t("An article is listed on any page with an Articles block, newest first, with these details.")}
          </p>
          <DateInput label={t("Date")} value={content.date} onChange={(date) => setContent({ date })} />
          <TextArea label={t("Summary")} value={content.summary} rows={3} maxLength={400} onChange={(summary) => setContent({ summary })} />
          <ImageInput label={t("Cover picture")} value={content.cover} onChange={(cover) => setContent({ cover })} onError={onError} />
        </>
      ) : null}
      {!isHome ? (
        <button className="outline-button" type="button" onClick={onDelete}>
          <Trash2 size={16} />
          {t("Delete this page")}
        </button>
      ) : null}
    </>
  );
}

export function HeaderInspector({ header, onChange, pages, bookingHref }: { header: SiteHeader; onChange: (next: SiteHeader) => void; pages: PageOption[]; bookingHref: string }) {
  return (
    <>
      <h3 className="site-inspector-title">{t("Header")}</h3>
      <ToggleInput label={t("Show your logo")} checked={header.showLogo} onChange={(showLogo) => onChange({ ...header, showLogo })} />
      <ToggleInput label={t("Show your business name")} checked={header.showName} onChange={(showName) => onChange({ ...header, showName })} />
      <ToggleInput label={t("Stays at the top while scrolling")} checked={header.sticky} onChange={(sticky) => onChange({ ...header, sticky })} />
      <ToggleInput label={t("Sits over the first block, with no background of its own")} checked={header.transparent} onChange={(transparent) => onChange({ ...header, transparent })} />
      <p className="site-field-help">{t("The logo is the one under Settings › Business › Business branding.")}</p>
      <h4 className="site-inspector-subtitle">{t("Social")}</h4>
      <SocialList links={header.social} onChange={(social) => onChange({ ...header, social })} />
      <p className="site-field-help">{t("The menu lists every page marked \"Show in the menu\", in the order of the page list. Add extra links here.")}</p>
      <h4 className="site-inspector-subtitle">{t("Extra links")}</h4>
      <LinkList links={header.links} onChange={(links) => onChange({ ...header, links })} pages={pages} bookingHref={bookingHref} />
      <h4 className="site-inspector-subtitle">{t("Button")}</h4>
      <ButtonInput label={t("Add a button")} value={header.button} onChange={(button) => onChange({ ...header, button })} pages={pages} bookingHref={bookingHref} />
      <h4 className="site-inspector-subtitle">{t("Cart")}</h4>
      <SelectInput
        label={t("Bag icon opens")}
        value={header.shopPage}
        onChange={(shopPage) => onChange({ ...header, shopPage })}
        options={[{ value: "", label: t("No bag icon") }, ...pages.map((page) => ({ value: page.slug, label: page.title || page.slug }))]}
      />
      <p className="site-field-help">{t("Shows how many things a visitor has in their cart. Pick the page with your Shop block.")}</p>
      <h4 className="site-inspector-subtitle">{t("Announcement")}</h4>
      <TextInput label={t("A line above the header")} value={header.announcement} maxLength={160} onChange={(announcement) => onChange({ ...header, announcement })} help={t("Leave empty for no strip.")} />
      {header.announcement ? <LinkInput label={t("Where it leads")} value={header.announcementHref} onChange={(announcementHref) => onChange({ ...header, announcementHref })} pages={pages} bookingHref={bookingHref} /> : null}
    </>
  );
}

export function FooterInspector({ footer, onChange, pages, bookingHref }: { footer: SiteFooter; onChange: (next: SiteFooter) => void; pages: PageOption[]; bookingHref: string }) {
  return (
    <>
      <h3 className="site-inspector-title">{t("Footer")}</h3>
      <TextInput label={t("Footer text")} value={footer.text} maxLength={300} onChange={(text) => onChange({ ...footer, text })} />
      <h4 className="site-inspector-subtitle">{t("Links")}</h4>
      <LinkList links={footer.links} onChange={(links) => onChange({ ...footer, links })} pages={pages} bookingHref={bookingHref} />
      <h4 className="site-inspector-subtitle">{t("Social")}</h4>
      <SocialList links={footer.social} onChange={(social) => onChange({ ...footer, social })} />
      <ToggleInput label={t("Show \"Made with Clarity\"")} checked={footer.showCredit} onChange={(showCredit) => onChange({ ...footer, showCredit })} />
    </>
  );
}

function SocialList({ links, onChange }: { links: SiteSocialLink[]; onChange: (next: SiteSocialLink[]) => void }) {
  return (
    <ListEditor
      items={links.map((entry, index) => ({ ...entry, id: `social-${index}` }))}
      onChange={(items) => onChange(items.map(({ kind, url }) => ({ kind, url })))}
      max={6}
      addLabel={t("Add a social link")}
      create={() => ({ id: siteId("social"), kind: "instagram" as const, url: "" })}
      itemLabel={(item) => item.kind}
      render={(item, update) => (
        <>
          <SelectInput label={t("Network")} value={item.kind} onChange={(kind) => update({ kind })} options={SITE_SOCIAL_KINDS.map((kind) => ({ value: kind, label: kind }))} />
          <TextInput label={t("Address")} value={item.url} maxLength={2000} placeholder="https://…" onChange={(url) => update({ url })} />
        </>
      )}
    />
  );
}

/**
 * How a block sits on the page: its own colours, a picture or video behind
 * it, how tall it is and how wide its content runs. The same fields on every
 * block, folded shut so the block's own fields come first.
 */
function SectionStyleFields({ style, onChange, onError }: { style: SiteBlockStyle; onChange: (next: SiteBlockStyle) => void; onError: (message: string) => void }) {
  const set = (patch: Partial<SiteBlockStyle>) => onChange({ ...style, ...patch });
  return (
    <details className="site-list-item site-section-style">
      <summary>
        <span>{t("Section: colours, backdrop and size")}</span>
      </summary>
      <div className="site-list-item-body">
        <SelectInput
          label={t("Colours")}
          value={style.theme}
          onChange={(theme) => set({ theme })}
          options={[
            { value: "default", label: t("Same as the page") },
            { value: "light", label: t("Light panel") },
            { value: "white", label: t("White") },
            { value: "dark", label: t("Dark") },
            { value: "accent", label: t("Button colour") },
          ]}
        />
        <ImageInput label={t("Picture behind the block")} value={style.background} onChange={(background) => set({ background })} onError={onError} />
        <TextInput label={t("Video behind the block")} value={style.video} maxLength={2000} placeholder="https://…/clip.mp4" onChange={(video) => set({ video })} help={t("An mp4 or webm address. It plays muted, on a loop; the picture above is shown while it loads.")} />
        <NumberInput label={t("Darken the backdrop, percent")} value={style.overlay} min={0} max={90} step={5} onChange={(overlay) => set({ overlay })} />
        <SelectInput
          label={t("Height")}
          value={style.height}
          onChange={(height) => set({ height })}
          options={[
            { value: "auto", label: t("Fits its content") },
            { value: "small", label: t("Small") },
            { value: "medium", label: t("Medium") },
            { value: "large", label: t("Large") },
          ]}
        />
        <SelectInput
          label={t("Content width")}
          value={style.width}
          onChange={(width) => set({ width })}
          options={[
            { value: "inherit", label: t("Same as the page") },
            { value: "narrow", label: t("Narrow") },
            { value: "regular", label: t("Regular") },
            { value: "wide", label: t("Wide") },
          ]}
        />
        <SelectInput
          label={t("Top edge")}
          value={style.divider}
          onChange={(divider) => set({ divider })}
          options={[
            { value: "none", label: t("Plain") },
            { value: "wave", label: t("A wave, in the button colour") },
          ]}
        />
      </div>
    </details>
  );
}

function LinkList({
  links,
  onChange,
  pages,
  bookingHref,
}: {
  links: Array<{ label: string; href: string }>;
  onChange: (next: Array<{ label: string; href: string }>) => void;
  pages: PageOption[];
  bookingHref: string;
}) {
  return (
    <ListEditor
      items={links.map((link, index) => ({ ...link, id: `link-${index}` }))}
      onChange={(items) => onChange(items.map(({ label, href }) => ({ label, href })))}
      max={6}
      addLabel={t("Add a link")}
      create={() => ({ id: siteId("link"), label: t("Link"), href: "" })}
      itemLabel={(item) => item.label}
      render={(item, update) => (
        <>
          <TextInput label={t("Link text")} value={item.label} maxLength={60} onChange={(label) => update({ label })} />
          <LinkInput label={t("Goes to")} value={item.href} onChange={(href) => update({ href })} pages={pages} bookingHref={bookingHref} />
        </>
      )}
    />
  );
}

/**
 * The shop itself, edited from the block that shows it: the switch that
 * opens it, and what is on the shelf. Packages are the lesson types marked
 * sellable; vouchers are the products ticked as vouchers under Billing.
 */
function ShopStatus({ onError }: { onError: (message: string) => void }) {
  const [shop, setShop] = useState<CoachShop | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchCoachShop()
      .then((next) => !cancelled && setShop(next))
      .catch((cause: Error) => !cancelled && onError(cause.message));
    return () => {
      cancelled = true;
    };
  }, [onError]);
  if (!shop) return null;
  return (
    <div className="site-shop-status">
      <h4 className="site-inspector-subtitle">{t("Your shop")}</h4>
      <ToggleInput
        label={shop.enabled ? t("The shop is open") : t("The shop is closed")}
        checked={shop.enabled}
        onChange={(enabled) => {
          setBusy(true);
          updateCoachShop({ enabled })
            .then(setShop)
            .catch((cause: Error) => onError(cause.message))
            .finally(() => setBusy(false));
        }}
      />
      <NumberInput
        label={t("Shipping fee, per order with something to post")}
        value={shop.shippingFee}
        min={0}
        max={100000}
        step={0.5}
        onChange={(shippingFee) => {
          setShop({ ...shop, shippingFee });
          setBusy(true);
          updateCoachShop({ shippingFee })
            .then(setShop)
            .catch((cause: Error) => onError(cause.message))
            .finally(() => setBusy(false));
        }}
      />
      {busy ? <p className="site-field-help">{t("Saving...")}</p> : null}
      {shop.blocker === "card_payments" ? <p className="site-field-help">{t("Card payments are not set up yet: connect Clarity Pay under Billing before the shop can take orders.")}</p> : null}
      {shop.blocker === "nothing_for_sale" ? <p className="site-field-help">{t("Nothing is for sale yet. Mark a lesson package as sellable under Lesson types, or tick a product as a gift voucher or \"Sell on your website\" under Billing › Products.")}</p> : null}
      {shop.items.length ? (
        <ul className="site-shop-items">
          {shop.items.map((item) => (
            <li key={item.id}>
              <span>{item.name}</span>
              <code>{money(item.price, item.currency)}</code>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="site-field-help">
        <ExternalLink size={12} /> {t("Prices and what is included are set where the item lives: packages under Lesson types, vouchers and goods under Billing › Products, where a product gets its picture, options and how it reaches the buyer.")}
      </p>
    </div>
  );
}

export function BlockInspector({ block, onChange, pages, bookingHref, onError }: { block: SiteBlock; onChange: (next: SiteBlock) => void } & Common) {
  return (
    <>
      <BlockFields block={block} onChange={onChange} pages={pages} bookingHref={bookingHref} onError={onError} />
      <SectionStyleFields style={block.style} onChange={(style) => onChange({ ...block, style })} onError={onError} />
    </>
  );
}

function PictureShapeInput({ value, onChange }: { value: SitePictureShape; onChange: (shape: SitePictureShape) => void }) {
  return (
    <SelectInput
      label={t("Picture shape")}
      value={value}
      onChange={onChange}
      options={[
        { value: "square", label: t("As it is") },
        { value: "rounded", label: t("Rounded corners") },
        { value: "circle", label: t("Circle") },
      ]}
    />
  );
}

function BlockFields({ block, onChange, pages, bookingHref, onError }: { block: SiteBlock; onChange: (next: SiteBlock) => void } & Common) {
  const set = <B extends SiteBlock>(patch: Partial<B>) => onChange({ ...block, ...patch } as SiteBlock);
  switch (block.type) {
    case "hero":
      return (
        <>
          <TextInput label={t("Small line above the heading")} value={block.eyebrow} maxLength={80} onChange={(eyebrow) => set({ eyebrow })} />
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <TextArea label={t("Text")} value={block.text} rows={3} maxLength={1000} onChange={(text) => set({ text })} />
          <SelectInput
            label={t("Layout")}
            value={block.layout}
            onChange={(layout) => set({ layout })}
            options={[
              { value: "centre", label: t("Centred") },
              { value: "left", label: t("Left") },
              { value: "split", label: t("Text beside picture") },
              { value: "split-left", label: t("Picture beside text") },
              { value: "cover", label: t("Text over picture") },
            ]}
          />
          <SelectInput
            label={t("Height")}
            value={block.height}
            onChange={(height) => set({ height })}
            options={[
              { value: "regular", label: t("Regular") },
              { value: "tall", label: t("Tall") },
            ]}
          />
          <PictureShapeInput value={block.shape} onChange={(shape) => set({ shape })} />
          <ImageInput label={t("Picture")} value={block.image} onChange={(image) => set({ image })} onError={onError} />
          <ButtonInput label={t("Add a button")} value={block.buttons[0] || null} onChange={(button) => set({ buttons: [button, block.buttons[1]].filter(Boolean) as typeof block.buttons })} pages={pages} bookingHref={bookingHref} />
          {block.buttons[0] ? (
            <ButtonInput label={t("Add a second button")} value={block.buttons[1] || null} onChange={(button) => set({ buttons: [block.buttons[0], button].filter(Boolean) as typeof block.buttons })} pages={pages} bookingHref={bookingHref} />
          ) : null}
        </>
      );
    case "text":
      return (
        <>
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <TextArea label={t("Text")} value={block.body} rows={10} onChange={(body) => set({ body })} help={t("Blank lines start new paragraphs.")} />
          <SelectInput label={t("Alignment")} value={block.align} onChange={(align) => set({ align })} options={alignOptions()} />
          <SelectInput
            label={t("Columns")}
            value={String(block.columns)}
            onChange={(columns) => set({ columns: columns === "2" ? 2 : 1 })}
            options={[
              { value: "1", label: "1" },
              { value: "2", label: "2" },
            ]}
          />
        </>
      );
    case "image":
      return (
        <>
          <ImageInput label={t("Picture")} value={block.image} onChange={(image) => set({ image })} onError={onError} />
          <PictureShapeInput value={block.shape} onChange={(shape) => set({ shape })} />
          <TextInput label={t("Caption")} value={block.caption} maxLength={300} onChange={(caption) => set({ caption })} />
          <SelectInput
            label={t("Size")}
            value={block.size}
            onChange={(size) => set({ size })}
            options={[
              { value: "inset", label: t("Small") },
              { value: "wide", label: t("Page width") },
              { value: "full", label: t("Edge to edge") },
            ]}
          />
        </>
      );
    case "gallery":
      return (
        <>
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <SelectInput
            label={t("Columns")}
            value={String(block.columns)}
            onChange={(columns) => set({ columns: Number(columns) as 2 | 3 | 4 })}
            options={[
              { value: "2", label: "2" },
              { value: "3", label: "3" },
              { value: "4", label: "4" },
            ]}
          />
          <ListEditor
            items={block.images.map((image, index) => ({ ...image, id: `image-${index}` }))}
            onChange={(items) => set({ images: items.map(({ url, alt }) => ({ url, alt })) })}
            max={12}
            addLabel={t("Add a picture")}
            create={() => ({ id: siteId("image"), url: "", alt: "" })}
            itemLabel={(item, index) => item.alt || `${t("Picture")} ${index + 1}`}
            render={(item, update) => <ImageInput label={t("Picture")} value={item.url ? { url: item.url, alt: item.alt } : null} onChange={(image) => update(image ? { url: image.url, alt: image.alt } : { url: "", alt: "" })} onError={onError} />}
          />
          <ButtonInput label={t("Add a button")} value={block.button} onChange={(button) => set({ button })} pages={pages} bookingHref={bookingHref} />
        </>
      );
    case "cards":
      return (
        <>
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <TextArea label={t("Intro")} value={block.intro} rows={2} maxLength={600} onChange={(intro) => set({ intro })} />
          <SelectInput
            label={t("Columns")}
            value={String(block.columns)}
            onChange={(columns) => set({ columns: Number(columns) as 2 | 3 | 4 })}
            options={[
              { value: "2", label: "2" },
              { value: "3", label: "3" },
              { value: "4", label: "4" },
            ]}
          />
          <ListEditor
            items={block.items}
            onChange={(items) => set({ items })}
            max={8}
            addLabel={t("Add a card")}
            create={() => ({ id: siteId("item"), image: null, title: t("New card"), text: "", button: { label: t("Book now"), href: bookingHref, style: "primary" as const } })}
            itemLabel={(item) => item.title}
            render={(item, update) => (
              <>
                <ImageInput label={t("Picture")} value={item.image} onChange={(image) => update({ image })} onError={onError} />
                <TextInput label={t("Title")} value={item.title} maxLength={80} onChange={(title) => update({ title })} />
                <TextArea label={t("Text")} value={item.text} rows={3} maxLength={400} onChange={(text) => update({ text })} />
                <ButtonInput label={t("Add a button")} value={item.button} onChange={(button) => update({ button })} pages={pages} bookingHref={bookingHref} />
              </>
            )}
          />
        </>
      );
    case "logos":
      return (
        <>
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <TextArea label={t("Intro")} value={block.intro} rows={2} maxLength={600} onChange={(intro) => set({ intro })} />
          <SelectInput
            label={t("Size")}
            value={block.size}
            onChange={(size) => set({ size })}
            options={[
              { value: "small", label: t("Small") },
              { value: "regular", label: t("Regular") },
            ]}
          />
          <ListEditor
            items={block.items}
            onChange={(items) => set({ items })}
            max={8}
            addLabel={t("Add a logo")}
            create={() => ({ id: siteId("item"), image: null, caption: "", href: "" })}
            itemLabel={(item) => item.caption}
            render={(item, update) => (
              <>
                <ImageInput label={t("Picture")} value={item.image} onChange={(image) => update({ image })} onError={onError} />
                <TextInput label={t("Caption")} value={item.caption} maxLength={80} onChange={(caption) => update({ caption })} />
                <LinkInput label={t("Goes to")} value={item.href} onChange={(href) => update({ href })} pages={pages} bookingHref={bookingHref} />
              </>
            )}
          />
        </>
      );
    case "features":
      return (
        <>
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <TextArea label={t("Intro")} value={block.intro} rows={2} maxLength={600} onChange={(intro) => set({ intro })} />
          <SelectInput
            label={t("Columns")}
            value={String(block.columns)}
            onChange={(columns) => set({ columns: columns === "2" ? 2 : 3 })}
            options={[
              { value: "2", label: "2" },
              { value: "3", label: "3" },
            ]}
          />
          <ListEditor
            items={block.items}
            onChange={(items) => set({ items })}
            max={9}
            addLabel={t("Add a point")}
            create={() => ({ id: siteId("item"), icon: "star" as const, title: t("New point"), text: "" })}
            itemLabel={(item) => item.title}
            render={(item, update) => (
              <>
                <SelectInput label={t("Icon")} value={item.icon} onChange={(icon) => update({ icon })} options={SITE_FEATURE_ICONS.map((icon) => ({ value: icon, label: icon }))} />
                <TextInput label={t("Title")} value={item.title} maxLength={80} onChange={(title) => update({ title })} />
                <TextArea label={t("Text")} value={item.text} rows={3} maxLength={400} onChange={(text) => update({ text })} />
              </>
            )}
          />
        </>
      );
    case "pricing":
      return (
        <>
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <TextArea label={t("Intro")} value={block.intro} rows={2} maxLength={600} onChange={(intro) => set({ intro })} />
          <ListEditor
            items={block.items}
            onChange={(items) => set({ items })}
            max={6}
            addLabel={t("Add a price")}
            create={() => ({ id: siteId("item"), name: t("New lesson type"), price: "", detail: "", features: "", button: { label: t("Book"), href: bookingHref, style: "primary" as const }, highlighted: false })}
            itemLabel={(item) => item.name}
            render={(item, update) => (
              <>
                <TextInput label={t("Name")} value={item.name} maxLength={80} onChange={(name) => update({ name })} />
                <TextInput label={t("Price")} value={item.price} maxLength={40} placeholder="$120" onChange={(price) => update({ price })} />
                <TextInput label={t("Detail")} value={item.detail} maxLength={120} placeholder={t("60 minutes")} onChange={(detail) => update({ detail })} />
                <TextArea label={t("What is included, one per line")} value={item.features} rows={4} maxLength={800} onChange={(features) => update({ features })} />
                <ToggleInput label={t("Highlight this one")} checked={item.highlighted} onChange={(highlighted) => update({ highlighted })} />
                <ButtonInput label={t("Add a button")} value={item.button} onChange={(button) => update({ button })} pages={pages} bookingHref={bookingHref} />
              </>
            )}
          />
        </>
      );
    case "testimonials":
      return (
        <>
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <TextArea label={t("Intro")} value={block.intro} rows={2} maxLength={600} onChange={(intro) => set({ intro })} />
          <ListEditor
            items={block.items}
            onChange={(items) => set({ items })}
            max={12}
            addLabel={t("Add a quote")}
            create={() => ({ id: siteId("item"), quote: "", name: "", role: "", image: null })}
            itemLabel={(item) => item.name || item.quote || (item.image ? t("Picture") : "")}
            render={(item, update) => (
              <>
                <TextArea label={t("Quote")} value={item.quote} rows={4} maxLength={600} onChange={(quote) => update({ quote })} />
                <TextInput label={t("Name")} value={item.name} maxLength={80} onChange={(name) => update({ name })} />
                <TextInput label={t("Detail")} value={item.role} maxLength={80} placeholder={t("Member since 2024")} onChange={(role) => update({ role })} />
                <ImageInput label={t("Picture, or a screenshot of the review")} value={item.image} onChange={(image) => update({ image })} onError={onError} />
              </>
            )}
          />
          <ButtonInput label={t("Add a button")} value={block.button} onChange={(button) => set({ button })} pages={pages} bookingHref={bookingHref} />
        </>
      );
    case "faq":
      return (
        <>
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <TextArea label={t("Intro")} value={block.intro} rows={2} maxLength={600} onChange={(intro) => set({ intro })} />
          <ListEditor
            items={block.items}
            onChange={(items) => set({ items })}
            max={20}
            addLabel={t("Add a question")}
            create={() => ({ id: siteId("item"), question: t("New question"), answer: "" })}
            itemLabel={(item) => item.question}
            render={(item, update) => (
              <>
                <TextInput label={t("Question")} value={item.question} maxLength={200} onChange={(question) => update({ question })} />
                <TextArea label={t("Answer")} value={item.answer} rows={4} maxLength={1500} onChange={(answer) => update({ answer })} />
              </>
            )}
          />
        </>
      );
    case "cta":
      return (
        <>
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <TextArea label={t("Text")} value={block.text} rows={2} maxLength={600} onChange={(text) => set({ text })} />
          <SelectInput
            label={t("Colour")}
            value={block.tone}
            onChange={(tone) => set({ tone })}
            options={[
              { value: "primary", label: t("Button colour") },
              { value: "surface", label: t("Panel colour") },
            ]}
          />
          <ButtonInput label={t("Add a button")} value={block.button} onChange={(button) => set({ button })} pages={pages} bookingHref={bookingHref} />
        </>
      );
    case "video":
      return (
        <>
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <TextInput label={t("YouTube link")} value={block.youtubeId} maxLength={400} placeholder="https://youtu.be/…" onChange={(youtubeId) => set({ youtubeId })} help={t("Paste the video's address. Only the video id is kept.")} />
          <TextInput label={t("Caption")} value={block.caption} maxLength={300} onChange={(caption) => set({ caption })} />
        </>
      );
    case "embed":
      return (
        <>
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <TextArea label={t("Text")} value={block.text} rows={2} maxLength={600} onChange={(text) => set({ text })} />
          <TextArea
            label={t("Embed code or address")}
            value={block.code || block.url}
            rows={4}
            maxLength={MAX_EMBED_CODE}
            onChange={(pasted) => {
              // An <iframe> snippet gives up its address and height; other code is kept whole.
              const source = embedSource(pasted);
              set({ url: source.url, code: source.code, height: source.height || block.height });
            }}
            help={t("Paste the embed code another website gave you (an <iframe> or a script), or just its https address. Pasted code runs in a frame of its own and cannot see this page.")}
          />
          <NumberInput label={t("Height in pixels")} value={block.height} min={200} max={1600} step={20} onChange={(height) => set({ height })} />
        </>
      );
    case "venues":
      return (
        <>
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <TextArea label={t("Intro")} value={block.intro} rows={2} maxLength={600} onChange={(intro) => set({ intro })} />
          <SelectInput
            label={t("Columns")}
            value={String(block.columns)}
            onChange={(columns) => set({ columns: columns === "1" ? 1 : 2 })}
            options={[
              { value: "1", label: "1" },
              { value: "2", label: "2" },
            ]}
          />
          <ListEditor
            items={block.items}
            onChange={(items) => set({ items })}
            max={6}
            addLabel={t("Add a venue")}
            create={() => ({ id: siteId("item"), name: t("New venue"), address: "", hours: "", text: "", showMap: true, booking: "main" as const, embedUrl: "", height: 760 })}
            itemLabel={(item) => item.name}
            render={(item, update) => (
              <>
                <TextInput label={t("Name")} value={item.name} maxLength={120} onChange={(name) => update({ name })} />
                <TextInput label={t("Address")} value={item.address} maxLength={300} onChange={(address) => update({ address })} />
                <ToggleInput label={t("Show a map of the address")} checked={item.showMap} onChange={(showMap) => update({ showMap })} />
                <TextArea label={t("Opening hours")} value={item.hours} rows={4} maxLength={600} onChange={(hours) => update({ hours })} />
                <TextArea label={t("Text")} value={item.text} rows={2} maxLength={600} onChange={(text) => update({ text })} />
                <SelectInput
                  label={t("Booking here")}
                  value={item.booking}
                  onChange={(booking) => update({ booking })}
                  options={[
                    { value: "none" as const, label: t("None, or another system (below)") },
                    ...SITE_BOOKING_SCREENS.map((screen) => ({ value: screen, label: BOOKING_SCREENS.find((candidate) => candidate.id === screen)?.label || screen })),
                  ]}
                />
                {item.booking === "none" ? (
                  <TextArea
                    label={t("Embed code or address")}
                    value={item.embedUrl}
                    rows={3}
                    maxLength={MAX_EMBED_CODE}
                    onChange={(pasted) => {
                      const source = embedSource(pasted);
                      update({ embedUrl: source.url, ...(source.height ? { height: source.height } : {}) });
                    }}
                    help={t("Another booking system's form: paste its <iframe> code or its https address.")}
                  />
                ) : null}
                <NumberInput label={t("Height in pixels")} value={item.height} min={480} max={1600} step={20} onChange={(height) => update({ height })} />
              </>
            )}
          />
        </>
      );
    case "form":
      return (
        <>
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <TextArea label={t("Text")} value={block.text} rows={2} maxLength={600} onChange={(text) => set({ text })} />
          <ToggleInput label={t("Ask for a phone number")} checked={block.askPhone} onChange={(askPhone) => set({ askPhone })} />
          <TextInput label={t("Button text")} value={block.buttonLabel} maxLength={60} onChange={(buttonLabel) => set({ buttonLabel })} />
          <TextArea label={t("After sending")} value={block.thanks} rows={2} maxLength={300} onChange={(thanks) => set({ thanks })} />
          <p className="site-field-help">{t("Messages are emailed to your business contact address (Settings › Business) and kept.")}</p>
        </>
      );
    case "booking":
      return (
        <>
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <TextArea label={t("Text")} value={block.text} rows={2} maxLength={600} onChange={(text) => set({ text })} />
          <SelectInput
            label={t("Booking screen")}
            value={block.screen}
            onChange={(screen) => set({ screen })}
            options={SITE_BOOKING_SCREENS.map((screen) => ({ value: screen, label: BOOKING_SCREENS.find((candidate) => candidate.id === screen)?.label || screen }))}
          />
          <SelectInput
            label={t("Show as")}
            value={block.mode}
            onChange={(mode) => set({ mode })}
            options={[
              { value: "embed", label: t("The booking page, on this page") },
              { value: "button", label: t("A button to the booking page") },
            ]}
          />
          {block.mode === "button" ? (
            <TextInput label={t("Button text")} value={block.buttonLabel} maxLength={60} onChange={(buttonLabel) => set({ buttonLabel })} />
          ) : (
            <NumberInput label={t("Height in pixels")} value={block.height} min={480} max={1600} step={20} onChange={(height) => set({ height })} />
          )}
        </>
      );
    case "shop":
      return (
        <>
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <TextArea label={t("Intro")} value={block.intro} rows={2} maxLength={600} onChange={(intro) => set({ intro })} />
          <SelectInput
            label={t("Show as")}
            value={block.mode}
            onChange={(mode) => set({ mode })}
            options={[
              { value: "cards", label: t("Cards in the site's own look, bought on this page") },
              { value: "embed", label: t("Clarity's shop page, framed") },
            ]}
          />
          {block.mode === "embed" ? <NumberInput label={t("Height in pixels")} value={block.height} min={480} max={1600} step={20} onChange={(height) => set({ height })} /> : null}
          <ShopStatus onError={onError} />
        </>
      );
    case "articles":
      return (
        <>
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <TextArea label={t("Intro")} value={block.intro} rows={2} maxLength={600} onChange={(intro) => set({ intro })} />
          <NumberInput label={t("How many to show")} value={block.limit} min={1} max={24} onChange={(limit) => set({ limit })} />
          <p className="site-field-help">{t("Lists every page whose kind is Article, newest first. Add one with Add page › Article.")}</p>
        </>
      );
    case "videos":
      return (
        <>
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <TextArea label={t("Intro")} value={block.intro} rows={2} maxLength={600} onChange={(intro) => set({ intro })} />
          <SelectInput
            label={t("Layout")}
            value={block.layout}
            onChange={(layout) => set({ layout })}
            options={[
              { value: "grid", label: t("Grid of pictures") },
              { value: "list", label: t("List, picture beside the words") },
            ]}
          />
          <NumberInput label={t("How many to show")} value={block.limit} min={1} max={24} onChange={(limit) => set({ limit })} />
          <p className="site-field-help">{t("Lists every page whose kind is Video, newest first. Add one with Add page › Video.")}</p>
        </>
      );
    case "instagram":
      return (
        <>
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <TextInput label={t("Instagram username")} value={block.handle} maxLength={60} placeholder="yourname" onChange={(handle) => set({ handle })} help={t("The Follow button and any picture without its own link lead to this profile.")} />
          <SelectInput
            label={t("Columns")}
            value={String(block.columns)}
            onChange={(columns) => set({ columns: Number(columns) as 3 | 4 | 6 })}
            options={[
              { value: "3", label: "3" },
              { value: "4", label: "4" },
              { value: "6", label: "6" },
            ]}
          />
          <ListEditor
            items={block.items}
            onChange={(items) => set({ items })}
            max={12}
            addLabel={t("Add a post")}
            create={() => ({ id: siteId("item"), image: null, href: "" })}
            itemLabel={(item, index) => item.image?.alt || `${t("Post")} ${index + 1}`}
            render={(item, update) => (
              <>
                <ImageInput label={t("Picture")} value={item.image} onChange={(image) => update({ image })} onError={onError} />
                <TextInput label={t("Link to the post")} value={item.href} maxLength={400} placeholder="https://www.instagram.com/p/…" onChange={(href) => update({ href })} />
              </>
            )}
          />
          <p className="site-field-help">{t("Instagram does not let a site show a feed without an app review, so the pictures here are ones you add. Save a post's picture, upload it, and paste the post's link.")}</p>
        </>
      );
    case "contact":
      return (
        <>
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <TextArea label={t("Text")} value={block.text} rows={2} maxLength={600} onChange={(text) => set({ text })} />
          <TextInput label={t("Email")} value={block.email} maxLength={180} onChange={(email) => set({ email })} />
          <TextInput label={t("Phone")} value={block.phone} maxLength={40} onChange={(phone) => set({ phone })} />
          <TextInput label={t("Address")} value={block.address} maxLength={300} onChange={(address) => set({ address })} />
          <TextArea label={t("Opening hours")} value={block.hours} rows={3} maxLength={600} onChange={(hours) => set({ hours })} />
          <ToggleInput label={t("Show a map of the address")} checked={block.showMap} onChange={(showMap) => set({ showMap })} />
        </>
      );
    case "divider":
      return (
        <>
          <SelectInput
            label={t("Style")}
            value={block.line}
            onChange={(line) => set({ line })}
            options={[
              { value: "line", label: t("Line") },
              { value: "space", label: t("Gap") },
            ]}
          />
          <SelectInput
            label={t("Size")}
            value={block.size}
            onChange={(size) => set({ size })}
            options={[
              { value: "small", label: t("Small") },
              { value: "regular", label: t("Regular") },
              { value: "large", label: t("Large") },
            ]}
          />
        </>
      );
    default:
      return null;
  }
}
