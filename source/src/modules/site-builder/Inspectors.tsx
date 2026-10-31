// What the right-hand column shows for whatever is selected: the page and
// its theme, the header, the footer, or one block.
import {
  SITE_BOOKING_SCREENS,
  SITE_FEATURE_ICONS,
  SITE_FONTS,
  SITE_SOCIAL_KINDS,
  SITE_THEME_PRESETS,
  siteId,
  themeFromPreset,
  type SiteBlock,
  type SiteDocument,
  type SiteFooter,
  type SiteHeader,
  type SiteTheme,
} from "../../../netlify/functions/_shared/site/document.mts";
import { t } from "../../lib/i18n";
import { BOOKING_SCREENS } from "../public-booking/bookingScreens";
import { ButtonInput, ColorInput, ImageInput, ListEditor, NumberInput, SelectInput, TextArea, TextInput, ToggleInput } from "./fields";

type Common = { bookingHref: string; onError: (message: string) => void };

const alignOptions = () => [
  { value: "left" as const, label: t("Left") },
  { value: "centre" as const, label: t("Centred") },
];

const fontOptions = SITE_FONTS.map((font) => ({ value: font.id, label: font.label }));

export function PageInspector({ document, onChange }: { document: SiteDocument; onChange: (next: SiteDocument) => void }) {
  const theme = document.theme;
  const setTheme = (patch: Partial<SiteTheme>) => onChange({ ...document, theme: { ...theme, ...patch } });
  const setColor = (key: keyof SiteTheme["colors"], value: string) => setTheme({ colors: { ...theme.colors, [key]: value } });
  return (
    <>
      <h3 className="site-inspector-title">{t("Page")}</h3>
      <TextInput label={t("Browser tab title")} value={document.title} maxLength={120} onChange={(title) => onChange({ ...document, title })} />
      <TextArea label={t("Description for search engines")} value={document.description} rows={3} maxLength={300} onChange={(description) => onChange({ ...document, description })} />

      <h3 className="site-inspector-title">{t("Look")}</h3>
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

export function HeaderInspector({ header, onChange, bookingHref }: { header: SiteHeader; onChange: (next: SiteHeader) => void; bookingHref: string }) {
  return (
    <>
      <h3 className="site-inspector-title">{t("Header")}</h3>
      <ToggleInput label={t("Show your logo")} checked={header.showLogo} onChange={(showLogo) => onChange({ ...header, showLogo })} />
      <ToggleInput label={t("Show your business name")} checked={header.showName} onChange={(showName) => onChange({ ...header, showName })} />
      <ToggleInput label={t("Stays at the top while scrolling")} checked={header.sticky} onChange={(sticky) => onChange({ ...header, sticky })} />
      <p className="site-field-help">{t("The logo is the one under Settings › Business › Business branding.")}</p>
      <h4 className="site-inspector-subtitle">{t("Menu links")}</h4>
      <LinkList links={header.links} onChange={(links) => onChange({ ...header, links })} />
      <h4 className="site-inspector-subtitle">{t("Button")}</h4>
      <ButtonInput label={t("Add a button")} value={header.button} onChange={(button) => onChange({ ...header, button })} bookingHref={bookingHref} />
    </>
  );
}

export function FooterInspector({ footer, onChange }: { footer: SiteFooter; onChange: (next: SiteFooter) => void }) {
  return (
    <>
      <h3 className="site-inspector-title">{t("Footer")}</h3>
      <TextInput label={t("Footer text")} value={footer.text} maxLength={300} onChange={(text) => onChange({ ...footer, text })} />
      <h4 className="site-inspector-subtitle">{t("Links")}</h4>
      <LinkList links={footer.links} onChange={(links) => onChange({ ...footer, links })} />
      <h4 className="site-inspector-subtitle">{t("Social")}</h4>
      <ListEditor
        items={footer.social.map((entry, index) => ({ ...entry, id: `social-${index}` }))}
        onChange={(items) => onChange({ ...footer, social: items.map(({ kind, url }) => ({ kind, url })) })}
        max={6}
        addLabel={t("Add a social link")}
        create={() => ({ id: siteId("social"), kind: "instagram" as const, url: "" })}
        itemLabel={(item) => item.kind}
        render={(item, update) => (
          <>
            <SelectInput
              label={t("Network")}
              value={item.kind}
              onChange={(kind) => update({ kind })}
              options={SITE_SOCIAL_KINDS.map((kind) => ({ value: kind, label: kind }))}
            />
            <TextInput label={t("Address")} value={item.url} maxLength={2000} placeholder="https://…" onChange={(url) => update({ url })} />
          </>
        )}
      />
      <ToggleInput label={t("Show \"Made with Clarity\"")} checked={footer.showCredit} onChange={(showCredit) => onChange({ ...footer, showCredit })} />
    </>
  );
}

function LinkList({ links, onChange }: { links: Array<{ label: string; href: string }>; onChange: (next: Array<{ label: string; href: string }>) => void }) {
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
          <TextInput label={t("Goes to")} value={item.href} maxLength={2000} placeholder="https://…  #contact" onChange={(href) => update({ href })} help={t("Use #contact, #lessons and so on to jump to a block on this page: each block's address is shown above its fields.")} />
        </>
      )}
    />
  );
}

export function BlockInspector({ block, onChange, bookingHref, onError }: { block: SiteBlock; onChange: (next: SiteBlock) => void } & Common) {
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
          <ImageInput label={t("Picture")} value={block.image} onChange={(image) => set({ image })} onError={onError} />
          <ButtonInput label={t("Add a button")} value={block.buttons[0] || null} onChange={(button) => set({ buttons: [button, block.buttons[1]].filter(Boolean) as typeof block.buttons })} bookingHref={bookingHref} />
          {block.buttons[0] ? (
            <ButtonInput label={t("Add a second button")} value={block.buttons[1] || null} onChange={(button) => set({ buttons: [block.buttons[0], button].filter(Boolean) as typeof block.buttons })} bookingHref={bookingHref} />
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
                <ButtonInput label={t("Add a button")} value={item.button} onChange={(button) => update({ button })} bookingHref={bookingHref} />
              </>
            )}
          />
        </>
      );
    case "testimonials":
      return (
        <>
          <TextInput label={t("Heading")} value={block.heading} maxLength={160} onChange={(heading) => set({ heading })} />
          <ListEditor
            items={block.items}
            onChange={(items) => set({ items })}
            max={9}
            addLabel={t("Add a quote")}
            create={() => ({ id: siteId("item"), quote: "", name: "", role: "" })}
            itemLabel={(item) => item.name || item.quote}
            render={(item, update) => (
              <>
                <TextArea label={t("Quote")} value={item.quote} rows={4} maxLength={600} onChange={(quote) => update({ quote })} />
                <TextInput label={t("Name")} value={item.name} maxLength={80} onChange={(name) => update({ name })} />
                <TextInput label={t("Detail")} value={item.role} maxLength={80} placeholder={t("Member since 2024")} onChange={(role) => update({ role })} />
              </>
            )}
          />
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
          <ButtonInput label={t("Add a button")} value={block.button} onChange={(button) => set({ button })} bookingHref={bookingHref} />
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
            value={block.style}
            onChange={(style) => set({ style })}
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

