// Settings › Website: build the business's public site.
//
// Two ways of looking at it. At rest the tab shows the site as it stands:
// its pages across the top, the chosen one drawn full width, Edit top left.
// Edit takes the whole settings pane: the settings sub-nav steps aside (the
// app's sidebar stays), and the editor gets three columns: the pages and
// the blocks on the chosen page (add, reorder, remove), the page itself
// drawn live in a frame (click anything to select it, click a menu link to
// move to that page), and the fields of whatever is selected. Done returns
// to the resting view; an unsaved draft is kept and still shown there.
//
// Save keeps a draft of the whole site that nobody else sees. Publish makes
// every page public at once, at /<business>/site and on the business's own
// domain.
import { ArrowDown, ArrowUp, Check, Copy, Eye, FilePlus, Globe, Monitor, PanelBottom, PanelTop, Pencil, Plus, Smartphone, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  HOME_PAGE_SLUG,
  SITE_PAGE_PRESETS,
  googleFontsUrl,
  newSiteBlock,
  sitePageCard,
  uniquePageSlug,
  type SiteBlock,
  type SiteBlockType,
  type SitePage,
  type SitePageCard,
  type SitePagePresetInput,
  type SiteSettings,
} from "../../../netlify/functions/_shared/site/document.mts";
import { SITE_TEMPLATES } from "../../../netlify/functions/_shared/site/templates.mts";
import { t } from "../../lib/i18n";
import { ClarityPlayerPortal } from "../shared/ClarityIcons";
import { Loading } from "../shared/Loading";
import { SettingsGroup } from "../settings/SettingsLayout";
import { BLOCK_CATALOG, blockCatalogEntry } from "./blockCatalog";
import { DomainPanel } from "./DomainPanel";
import { BlockInspector, FooterInspector, HeaderInspector, PageInspector, SiteInspector } from "./Inspectors";
import { fetchSiteState, publishSite, saveSite, unpublishSite, type SavedSite, type SitePageView, type SiteState } from "./siteApi";
import { SitePreviewFrame } from "./SitePreviewFrame";
import { SiteRenderer, type PreviewLabels, type SiteSelection } from "./SiteRenderer";
import { bookingPageUrl } from "./siteTheme";
import "./site-builder.css";

const PHONE_WIDTH = "390px";

/** The whole draft: what Save sends. */
type Draft = { settings: SiteSettings; pages: SitePage[] };

/** The first words of a block, for the outline. */
function blockSnippet(block: SiteBlock): string {
  switch (block.type) {
    case "hero":
    case "text":
    case "gallery":
    case "features":
    case "pricing":
    case "testimonials":
    case "faq":
    case "cta":
    case "video":
    case "booking":
    case "shop":
    case "articles":
    case "contact":
    case "cards":
    case "logos":
    case "embed":
    case "venues":
    case "form":
    case "videos":
    case "instagram":
      return block.heading;
    case "image":
      return block.caption || block.image?.alt || "";
    default:
      return "";
  }
}

const sameDraft = (a: Draft | null, b: Draft | null) => JSON.stringify(a) === JSON.stringify(b);

function draftFromViews(settings: SiteSettings, pages: SitePageView[]): Draft {
  return {
    settings,
    pages: pages.map(({ id, slug, title, kind, inNav, sortOrder, content }) => ({ id, slug, title, kind, inNav, sortOrder, content })),
  };
}

function cardsOf(pages: SitePage[]): SitePageCard[] {
  return pages.map(sitePageCard);
}

export type SiteBuilderPanelProps = {
  onToast: (message: string) => void;
  brandLogo: string;
  brandShowLogo: boolean;
  /** True while the editor has the whole pane. The page owns this so it can step the sub-nav aside. */
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
};

export default function SiteBuilderPanel({ onToast, brandLogo, brandShowLogo, editing, onEditingChange }: SiteBuilderPanelProps) {
  const [state, setState] = useState<SiteState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<Draft | null>(null);
  const [currentSlug, setCurrentSlug] = useState(HOME_PAGE_SLUG);
  const [selected, setSelected] = useState<SiteSelection>("page");
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const [busy, setBusy] = useState<"" | "save" | "publish" | "unpublish">("");
  const [choosingTemplate, setChoosingTemplate] = useState(false);
  const [choosingPage, setChoosingPage] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchSiteState()
      .then((next) => {
        if (cancelled) return;
        setState(next);
        const initial = next.site ? draftFromViews(next.site.settings, next.pages) : null;
        setDraft(initial);
        setSaved(initial);
      })
      .catch((cause: Error) => !cancelled && setLoadError(cause.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = Boolean(draft) && !sameDraft(draft, saved);

  // Leaving with unsaved pages is the one thing this editor refuses to do quietly.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const bookingHref = state ? bookingPageUrl(state.business.slug) : "";
  const business = useMemo(
    () => ({ slug: state?.business.slug || "", name: state?.business.name || "", logo: brandLogo, showLogo: brandShowLogo }),
    [state?.business.slug, state?.business.name, brandLogo, brandShowLogo],
  );
  const fontsUrl = draft ? googleFontsUrl(draft.settings.theme) : "";
  const currentPage = draft?.pages.find((page) => page.slug === currentSlug) || draft?.pages.find((page) => page.slug === HOME_PAGE_SLUG) || draft?.pages[0] || null;
  const pageOptions = useMemo(() => (draft ? draft.pages.map((page) => ({ slug: page.slug, title: page.title })) : []), [draft]);
  const cards = useMemo(() => (draft ? cardsOf(draft.pages) : []), [draft]);
  const presetInput: SitePagePresetInput = {
    businessName: state?.business.name || "",
    coachName: state?.business.coachName || "",
    bookingHref,
    venueName: state?.business.venueName || "",
    email: state?.business.email || "",
    phone: "",
  };

  const applySaved = useCallback((result: SavedSite, sending: Draft | null) => {
    const next = draftFromViews(result.site.settings, result.pages);
    setState((current) => (current ? { ...current, site: result.site, pages: result.pages } : current));
    setSaved(next);
    // The server's cleaned copy (with ids for new pages) replaces the draft
    // only if nothing changed meanwhile.
    setDraft((current) => (current === sending || !current ? next : current));
  }, []);

  async function save(): Promise<boolean> {
    if (!draft) return false;
    setBusy("save");
    const sending = draft;
    try {
      applySaved(await saveSite(sending.settings, sending.pages), sending);
      return true;
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("Could not save the page."));
      return false;
    } finally {
      setBusy("");
    }
  }

  async function publish() {
    if (dirty && !(await save())) return;
    setBusy("publish");
    try {
      applySaved(await publishSite(), draft);
      onToast(t("Published. Your site is live."));
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("Could not publish the page."));
    } finally {
      setBusy("");
    }
  }

  async function unpublish() {
    if (!window.confirm(t("Take the site down? Visitors see nothing until you publish again. Your drafts are kept."))) return;
    setBusy("unpublish");
    try {
      applySaved(await unpublishSite(), draft);
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("Could not take the page down."));
    } finally {
      setBusy("");
    }
  }

  async function startFromTemplate(templateId: string) {
    if (!state) return;
    const template = SITE_TEMPLATES.find((candidate) => candidate.id === templateId);
    if (!template) return;
    if (draft && !window.confirm(t("Replace the whole site with this template? Every page you have made is lost."))) return;
    const built = template.build(presetInput);
    const next: Draft = { settings: built.settings, pages: built.pages.map((page, index) => ({ ...page, id: "", sortOrder: index })) };
    setDraft(next);
    setCurrentSlug(HOME_PAGE_SLUG);
    setSelected("page");
    setChoosingTemplate(false);
    // A fresh site is for editing, not admiring.
    onEditingChange(true);
    setBusy("save");
    try {
      applySaved(await saveSite(next.settings, next.pages), next);
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("Could not save the page."));
    } finally {
      setBusy("");
    }
  }

  const update = (next: Draft) => setDraft(next);
  const updatePage = (slug: string, next: SitePage) => draft && update({ ...draft, pages: draft.pages.map((page) => (page.slug === slug ? next : page)) });
  const updateBlock = (id: string, next: SiteBlock) =>
    currentPage && updatePage(currentPage.slug, { ...currentPage, content: { ...currentPage.content, blocks: currentPage.content.blocks.map((block) => (block.id === id ? next : block)) } });
  const selectedBlock = currentPage && typeof selected === "object" ? currentPage.content.blocks.find((block) => block.id === selected.block) || null : null;

  function addPage(presetId: string) {
    if (!draft) return;
    const preset = SITE_PAGE_PRESETS.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    const built = preset.build(presetInput);
    const slug = uniquePageSlug(built.slug, draft.pages.map((page) => page.slug));
    const page: SitePage = { ...built, slug, id: "", sortOrder: draft.pages.length };
    update({ ...draft, pages: [...draft.pages, page] });
    setCurrentSlug(slug);
    setSelected("page");
    setChoosingPage(false);
    onEditingChange(true);
  }

  function renamePage(page: SitePage, next: SitePage) {
    if (!draft) return;
    update({ ...draft, pages: draft.pages.map((candidate) => (candidate.slug === page.slug ? next : candidate)) });
    if (next.slug !== page.slug) setCurrentSlug(next.slug);
  }

  function deletePage(page: SitePage) {
    if (!draft || page.slug === HOME_PAGE_SLUG) return;
    if (!window.confirm(t("Delete the page \"{title}\"? Its blocks are lost.", { title: page.title || page.slug }))) return;
    update({ ...draft, pages: draft.pages.filter((candidate) => candidate.slug !== page.slug) });
    setCurrentSlug(HOME_PAGE_SLUG);
    setSelected("page");
  }

  function movePage(slug: string, delta: number) {
    if (!draft) return;
    const index = draft.pages.findIndex((page) => page.slug === slug);
    const target = index + delta;
    // Home stays first: it is the page the domain lands on.
    if (index < 1 || target < 1 || target >= draft.pages.length) return;
    const pages = [...draft.pages];
    const [page] = pages.splice(index, 1);
    pages.splice(target, 0, page);
    update({ ...draft, pages: pages.map((candidate, order) => ({ ...candidate, sortOrder: order })) });
  }

  function addBlock(type: SiteBlockType) {
    if (!currentPage) return;
    const block = newSiteBlock(type);
    const blocks = [...currentPage.content.blocks];
    // After the selected block, or at the end.
    const index = selectedBlock ? blocks.findIndex((candidate) => candidate.id === selectedBlock.id) + 1 : blocks.length;
    blocks.splice(index, 0, block);
    updatePage(currentPage.slug, { ...currentPage, content: { ...currentPage.content, blocks } });
    setSelected({ block: block.id });
    setAddMenuOpen(false);
  }

  function moveBlock(id: string, delta: number) {
    if (!currentPage) return;
    const blocks = [...currentPage.content.blocks];
    const index = blocks.findIndex((block) => block.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= blocks.length) return;
    const [block] = blocks.splice(index, 1);
    blocks.splice(target, 0, block);
    updatePage(currentPage.slug, { ...currentPage, content: { ...currentPage.content, blocks } });
  }

  function duplicateBlock(id: string) {
    if (!currentPage) return;
    const blocks = [...currentPage.content.blocks];
    const index = blocks.findIndex((block) => block.id === id);
    if (index < 0) return;
    const copy = { ...structuredClone(blocks[index]), id: newSiteBlock("divider").id };
    blocks.splice(index + 1, 0, copy);
    updatePage(currentPage.slug, { ...currentPage, content: { ...currentPage.content, blocks } });
    setSelected({ block: copy.id });
  }

  function removeBlock(id: string) {
    if (!currentPage) return;
    updatePage(currentPage.slug, { ...currentPage, content: { ...currentPage.content, blocks: currentPage.content.blocks.filter((block) => block.id !== id) } });
    if (typeof selected === "object" && selected.block === id) setSelected("page");
  }

  const previewLabels = useMemo<PreviewLabels>(
    () => ({
      booking: t("Your booking page shows here"),
      map: t("A map shows here"),
      shop: t("Your shop shows here"),
      embed: t("The framed page shows here"),
      noArticles: t("No articles yet. Add one with Add page › Article."),
      noVideos: t("No videos yet. Add one with Add page › Video."),
      noPage: t("There is no page here"),
    }),
    [],
  );
  const previewPath = useCallback((slug: string) => `#${slug}`, []);

  if (loadError) {
    return (
      <SettingsGroup id="website" icon={Globe} section="website" title={t("Website")}>
        <div className="integration-error">
          <strong>{t("Something went wrong")}</strong>
          {loadError}
        </div>
      </SettingsGroup>
    );
  }
  if (!state) {
    return (
      <SettingsGroup id="website" icon={Globe} section="website" title={t("Website")}>
        <Loading what={t("your website")} />
      </SettingsGroup>
    );
  }

  const templateChooser = (
    <div className="site-templates">
      <p className="settings-note">{t("Pick a starting point. Everything on it can be changed, and pages and blocks can be added or removed afterwards.")}</p>
      <div className="site-template-grid">
        {state.templates.map((template) => {
          const preset = SITE_TEMPLATES.find((candidate) => candidate.id === template.id)?.build(presetInput).settings.theme;
          return (
            <button
              type="button"
              className="site-template"
              key={template.id}
              disabled={busy !== ""}
              onClick={() => void startFromTemplate(template.id)}
              style={preset ? { background: preset.colors.background, color: preset.colors.text } : undefined}
            >
              <span className="site-template-art" aria-hidden="true">
                <i style={{ background: preset?.colors.primary }} />
                <i style={{ background: preset?.colors.surface }} />
                <i style={{ background: preset?.colors.accent }} />
              </span>
              <strong>{template.label}</strong>
              <span>{template.summary}</span>
            </button>
          );
        })}
      </div>
      {draft ? (
        <button className="outline-button" type="button" onClick={() => setChoosingTemplate(false)}>
          {t("Keep my site")}
        </button>
      ) : null}
    </div>
  );

  const pageChooser = (
    <div className="site-templates">
      <p className="settings-note">{t("What kind of page? Each comes filled in for your business; change anything afterwards.")}</p>
      <div className="site-template-grid">
        {state.presets.map((preset) => (
          <button type="button" className="site-template is-plain" key={preset.id} onClick={() => addPage(preset.id)}>
            <strong>{preset.label}</strong>
            <span>{preset.summary}</span>
          </button>
        ))}
      </div>
      <button className="outline-button" type="button" onClick={() => setChoosingPage(false)}>
        {t("Cancel")}
      </button>
    </div>
  );

  const status = (
    <div className="site-builder-status">
      <strong>{state.site?.isPublished ? t("Published") : t("Not published")}</strong>
      <span>{dirty ? t("Unsaved changes") : state.site?.isPublished && state.site.updatedAt > (state.site.publishedAt || "") ? t("Saved draft is newer than the published page") : t("Saved")}</span>
    </div>
  );

  const saveButton = (
    <button className="outline-button" type="button" onClick={() => void save()} disabled={busy !== "" || !dirty}>
      {busy === "save" ? t("Saving...") : t("Save")}
    </button>
  );

  const publishButton = (
    <button className="primary-button" type="button" onClick={() => void publish()} disabled={busy !== ""}>
      <Eye size={16} />
      {busy === "publish" ? t("Publishing…") : t("Publish")}
    </button>
  );

  const pageStrip = draft ? (
    <div className="site-pages-strip" role="tablist" aria-label={t("Pages")}>
      {draft.pages.map((page) => (
        <button
          type="button"
          role="tab"
          key={page.slug}
          aria-selected={page.slug === currentPage?.slug}
          className={`site-page-tab${page.slug === currentPage?.slug ? " is-active" : ""}${page.inNav ? "" : " is-hidden"}`}
          onClick={() => {
            setCurrentSlug(page.slug);
            if (typeof selected === "object") setSelected("page");
          }}
        >
          {page.title || page.slug}
        </button>
      ))}
      <button type="button" className="site-page-tab is-add" onClick={() => setChoosingPage(true)}>
        <FilePlus size={15} />
        {t("Add page")}
      </button>
    </div>
  ) : null;

  const preview = currentPage ? (
    <SiteRenderer
      settings={draft!.settings}
      page={currentPage}
      pages={cards}
      business={business}
      mode="preview"
      pagePath={previewPath}
      onNavigate={(slug) => {
        if (draft?.pages.some((page) => page.slug === slug)) setCurrentSlug(slug);
      }}
      selected={editing ? selected : undefined}
      onSelect={editing ? setSelected : undefined}
      previewLabels={previewLabels}
    />
  ) : null;

  // --- Editing: the whole pane -------------------------------------------------

  if (editing && draft && currentPage && !choosingTemplate) {
    return (
      <article className="data-card settings-section settings-website site-editor-full">
        <div className="site-builder">
          <div className="site-builder-toolbar">
            <button className="outline-button" type="button" onClick={() => onEditingChange(false)}>
              <Check size={16} />
              {t("Done")}
            </button>
            {status}
            <div className="site-builder-devices" role="group" aria-label={t("Preview size")}>
              <button type="button" className={`icon-button${device === "desktop" ? " is-active" : ""}`} aria-label={t("Desktop")} onClick={() => setDevice("desktop")}>
                <Monitor size={16} />
              </button>
              <button type="button" className={`icon-button${device === "phone" ? " is-active" : ""}`} aria-label={t("Phone")} onClick={() => setDevice("phone")}>
                <Smartphone size={16} />
              </button>
            </div>
            <div className="site-inline-actions">
              <button className="outline-button" type="button" onClick={() => setChoosingTemplate(true)} disabled={busy !== ""}>
                {t("Start again")}
              </button>
              {state.site?.isPublished ? (
                <button className="outline-button" type="button" onClick={() => void unpublish()} disabled={busy !== ""}>
                  {busy === "unpublish" ? t("Taking down…") : t("Take down")}
                </button>
              ) : null}
              {saveButton}
              {publishButton}
            </div>
          </div>

          {choosingPage ? (
            pageChooser
          ) : (
            <div className="site-builder-grid">
              <aside className="site-outline" aria-label={t("Pages and blocks")}>
                <h4 className="site-outline-title">{t("Pages")}</h4>
                <ol className="site-outline-list">
                  {draft.pages.map((page, index) => {
                    const isCurrent = page.slug === currentPage.slug;
                    return (
                      <li key={page.slug} className={`site-outline-row${isCurrent ? " is-current" : ""}`}>
                        <button
                          type="button"
                          className="site-outline-main"
                          onClick={() => {
                            setCurrentSlug(page.slug);
                            setSelected("page");
                          }}
                        >
                          <span>
                            <strong>{page.title || page.slug}</strong>
                            {!page.inNav ? <em>{page.kind === "article" ? t("Article") : page.kind === "video" ? t("Video") : t("Not in the menu")}</em> : null}
                          </span>
                        </button>
                        {page.slug !== HOME_PAGE_SLUG ? (
                          <span className="site-outline-actions">
                            <button type="button" className="icon-button" aria-label={t("Move up")} disabled={index <= 1} onClick={() => movePage(page.slug, -1)}>
                              <ArrowUp size={14} />
                            </button>
                            <button type="button" className="icon-button" aria-label={t("Move down")} disabled={index === draft.pages.length - 1} onClick={() => movePage(page.slug, 1)}>
                              <ArrowDown size={14} />
                            </button>
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
                <button type="button" className="outline-button" onClick={() => setChoosingPage(true)}>
                  <FilePlus size={16} />
                  {t("Add page")}
                </button>

                <h4 className="site-outline-title">{t("Site")}</h4>
                <button type="button" className={`site-outline-row is-fixed${selected === "site" ? " is-selected" : ""}`} onClick={() => setSelected("site")}>
                  <Globe size={15} />
                  <span>{t("Look")}</span>
                </button>
                <button type="button" className={`site-outline-row is-fixed${selected === "header" ? " is-selected" : ""}`} onClick={() => setSelected("header")}>
                  <PanelTop size={15} />
                  <span>{t("Header")}</span>
                </button>
                <button type="button" className={`site-outline-row is-fixed${selected === "footer" ? " is-selected" : ""}`} onClick={() => setSelected("footer")}>
                  <PanelBottom size={15} />
                  <span>{t("Footer")}</span>
                </button>

                <h4 className="site-outline-title">{currentPage.title || currentPage.slug}</h4>
                <button type="button" className={`site-outline-row is-fixed${selected === "page" ? " is-selected" : ""}`} onClick={() => setSelected("page")}>
                  <Pencil size={15} />
                  <span>{t("This page")}</span>
                </button>
                <ol className="site-outline-list">
                  {currentPage.content.blocks.map((block, index) => {
                    const entry = blockCatalogEntry(block.type);
                    const isSelected = typeof selected === "object" && selected.block === block.id;
                    return (
                      <li key={block.id} className={`site-outline-row${isSelected ? " is-selected" : ""}`}>
                        <button type="button" className="site-outline-main" onClick={() => setSelected({ block: block.id })}>
                          <entry.Icon size={15} />
                          <span>
                            <strong>{entry.label}</strong>
                            {blockSnippet(block) ? <em>{blockSnippet(block)}</em> : null}
                          </span>
                        </button>
                        <span className="site-outline-actions">
                          <button type="button" className="icon-button" aria-label={t("Move up")} disabled={index === 0} onClick={() => moveBlock(block.id, -1)}>
                            <ArrowUp size={14} />
                          </button>
                          <button type="button" className="icon-button" aria-label={t("Move down")} disabled={index === currentPage.content.blocks.length - 1} onClick={() => moveBlock(block.id, 1)}>
                            <ArrowDown size={14} />
                          </button>
                          <button type="button" className="icon-button" aria-label={t("Duplicate")} onClick={() => duplicateBlock(block.id)}>
                            <Copy size={14} />
                          </button>
                          <button type="button" className="icon-button" aria-label={t("Remove")} onClick={() => removeBlock(block.id)}>
                            <Trash2 size={14} />
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ol>
                <div className="site-add">
                  <button type="button" className="outline-button" aria-expanded={addMenuOpen} onClick={() => setAddMenuOpen((open) => !open)}>
                    <Plus size={16} />
                    {t("Add a block")}
                  </button>
                  {addMenuOpen ? (
                    <div className="site-add-menu" role="menu">
                      {BLOCK_CATALOG.map((entry) => (
                        <button type="button" role="menuitem" key={entry.type} onClick={() => addBlock(entry.type)}>
                          <entry.Icon size={16} />
                          <span>
                            <strong>{entry.label}</strong>
                            <em>{entry.hint}</em>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </aside>

              <div className={`site-preview is-${device}`}>
                <SitePreviewFrame fontsUrl={fontsUrl} width={device === "phone" ? PHONE_WIDTH : "100%"} title={t("Preview")}>
                  {preview}
                </SitePreviewFrame>
              </div>

              <aside className="site-inspector">
                {selected === "site" ? <SiteInspector settings={draft.settings} onChange={(settings) => update({ ...draft, settings })} /> : null}
                {selected === "header" ? (
                  <HeaderInspector header={draft.settings.header} onChange={(header) => update({ ...draft, settings: { ...draft.settings, header } })} pages={pageOptions} bookingHref={bookingHref} />
                ) : null}
                {selected === "footer" ? (
                  <FooterInspector footer={draft.settings.footer} onChange={(footer) => update({ ...draft, settings: { ...draft.settings, footer } })} pages={pageOptions} bookingHref={bookingHref} />
                ) : null}
                {selected === "page" ? (
                  <PageInspector page={currentPage} pages={pageOptions.filter((page) => page.slug !== currentPage.slug)} onChange={(next) => renamePage(currentPage, next)} onDelete={() => deletePage(currentPage)} onError={onToast} />
                ) : null}
                {selectedBlock ? (
                  <>
                    <h3 className="site-inspector-title">{blockCatalogEntry(selectedBlock.type).label}</h3>
                    <p className="site-field-help">
                      {t("Link to this block with")} <code>#{selectedBlock.id}</code>
                    </p>
                    <BlockInspector block={selectedBlock} onChange={(next) => updateBlock(selectedBlock.id, next)} pages={pageOptions} bookingHref={bookingHref} onError={onToast} />
                  </>
                ) : null}
              </aside>
            </div>
          )}
        </div>
      </article>
    );
  }

  // --- At rest: the site, and where it lives ----------------------------------

  return (
    <>
      <SettingsGroup id="website" icon={Globe} section="website" title={t("Website")} className="site-builder-card">
        <p className="settings-note">{t("A public website for your business, with your booking page and shop built in. Build it here, publish it, and point your own domain at it below.")}</p>
        {!draft || choosingTemplate ? (
          templateChooser
        ) : choosingPage ? (
          pageChooser
        ) : (
          <div className="site-builder">
            <div className="site-builder-toolbar">
              <button className="primary-button" type="button" onClick={() => onEditingChange(true)}>
                <Pencil size={16} />
                {t("Edit")}
              </button>
              {status}
              <div className="site-inline-actions">
                {dirty ? saveButton : null}
                {publishButton}
              </div>
            </div>
            {pageStrip}
            <div className="site-preview is-desktop is-resting">
              <SitePreviewFrame fontsUrl={fontsUrl} width="100%" title={t("Preview")}>
                {preview}
              </SitePreviewFrame>
            </div>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup id="website-address" icon={ClarityPlayerPortal} section="website" title={t("Where the page lives")}>
        <DomainPanel state={state} isPublished={Boolean(state.site?.isPublished)} onDomainsChange={(domains) => setState({ ...state, domains })} />
      </SettingsGroup>
    </>
  );
}
