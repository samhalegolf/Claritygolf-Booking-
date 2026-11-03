// Settings › Website: build the business's public site.
//
// Laid out the way Squarespace works, because that is the workflow coaches
// (and Clarity, for its own sites) already know:
//
//   At rest     the site as it stands, in the Settings card: its pages across
//               the top, the chosen one drawn full width, and Edit site.
//   Pages       the editor takes the whole pane. Pages down the left (Main
//               navigation, Not linked, each with its gear for page
//               settings), the chosen page beside them, Edit at the top.
//   Edit        the page fills the space and is edited where it stands:
//               words are typed over on the page, every section has "Add
//               section" above and below it and a toolbar (edit, move,
//               duplicate, remove), and the header and footer each have an
//               edit button. Add section opens the gallery of ready-made
//               layouts; Edit section opens its Content and Design tabs; Site
//               styles is the look of every page.
//
// Save works the way Squarespace's does: on a site that is already public
// the changes go live at once. A site that has never been published is saved
// privately until "Make site public". Exit with unsaved changes asks whether
// to throw them away.
import { ArrowDown, ArrowUp, Check, Eye, FilePlus, Globe, Monitor, MoreHorizontal, Paintbrush, PanelBottom, PanelTop, Pencil, Plus, Settings2, Smartphone, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  BUSINESS_ONLY_BLOCKS,
  HOME_PAGE_SLUG,
  SITE_PAGE_PRESETS,
  googleFontsUrl,
  newSiteBlock,
  sitePageCard,
  sitePageParent,
  sitePageTree,
  uniquePageSlug,
  type SiteBlock,
  type SitePage,
  type SitePageCard,
  type SitePagePresetInput,
  type SiteSettings,
} from "../../../netlify/functions/_shared/site/document.mts";
import { findSiteTemplate } from "../../../netlify/functions/_shared/site/templates.mts";
import { t } from "../../lib/i18n";
import { ClarityPlayerPortal } from "../shared/ClarityIcons";
import { Loading } from "../shared/Loading";
import { SettingsGroup } from "../settings/SettingsLayout";
import { blockCatalogEntry } from "./blockCatalog";
import { setBlockField } from "./blockText";
import { arrangeFreely } from "./canvasLayout";
import { DomainPanel } from "./DomainPanel";
import { BlockContentFields, FooterInspector, HeaderInspector, PageInspector, SectionDesignFields, SiteInspector } from "./Inspectors";
import { SECTION_CATEGORIES, SECTION_LIBRARY, blockForChoice, type SectionChoice } from "./sectionLibrary";
import { fetchSiteState, publishSite, saveSite, unpublishSite, type SavedSite, type SitePageView, type SiteState, type SiteView, importPictures, importSite } from "./siteApi";
import { SitePreviewFrame } from "./SitePreviewFrame";
import { SiteRenderer, type PreviewLabels, type SiteEditorHooks, type SiteSelection } from "./SiteRenderer";
import { bookingPageUrl } from "./siteTheme";
import "./site-builder.css";

const PHONE_WIDTH = "390px";

/** The whole draft: what Save sends. */
type Draft = { settings: SiteSettings; pages: SitePage[] };

/** Which side panel is open. "add" is the section gallery, on the left; the rest open on the right. */
type Panel = null | "add" | "section" | "styles" | "header" | "footer" | "page";

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
  const [busy, setBusy] = useState<"" | "save" | "publish" | "unpublish" | "import">("");
  const [choosingTemplate, setChoosingTemplate] = useState(false);
  // Inside the editor: the pages panel, or the page in edit mode.
  const [mode, setMode] = useState<"pages" | "edit">("pages");
  const [panel, setPanel] = useState<Panel>(null);
  const [sectionTab, setSectionTab] = useState<"content" | "design">("content");
  const [addAt, setAddAt] = useState(0);
  // The item picked in a free layout section: drawn with handles on the page, opened in the side panel.
  const [canvasItem, setCanvasItem] = useState<{ block: string; item: string } | null>(null);
  const [addCategory, setAddCategory] = useState<string>(SECTION_CATEGORIES[0]);
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

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
  // What Save sends is the draft as it is when Save runs, including words typed on the page a moment before.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Leaving with unsaved pages is the one thing this editor refuses to do quietly.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // One of Clarity's own sites has no booking page and no shop to offer.
  const bookingHref = state?.forBusiness ? bookingPageUrl(state.business.slug) : "";
  const gallery = useMemo(() => SECTION_LIBRARY.filter((choice) => state?.forBusiness !== false || !BUSINESS_ONLY_BLOCKS.includes(choice.type)), [state?.forBusiness]);
  const galleryCategories = useMemo(() => SECTION_CATEGORIES.filter((category) => gallery.some((choice) => choice.category === category)), [gallery]);
  const business = useMemo(
    () => ({ slug: state?.business.slug || "", name: state?.business.name || "", logo: brandLogo, showLogo: brandShowLogo }),
    [state?.business.slug, state?.business.name, brandLogo, brandShowLogo],
  );
  const fontsUrl = draft ? googleFontsUrl(draft.settings.theme) : "";
  const currentPage = draft?.pages.find((page) => page.slug === currentSlug) || draft?.pages.find((page) => page.slug === HOME_PAGE_SLUG) || draft?.pages[0] || null;
  const pageOptions = useMemo(() => (draft ? draft.pages.map((page) => ({ slug: page.slug, title: page.title })) : []), [draft]);
  const cards = useMemo(() => (draft ? cardsOf(draft.pages) : []), [draft]);
  // The pages at the top, each with the pages inside it (articles under
  // Articles, videos under the video library), so the list stays the menu.
  // A hook, so it sits here with the others, above the early returns.
  const pageTree = useMemo(() => (draft ? sitePageTree(draft.pages) : []), [draft]);
  const currentGroup = currentPage ? pageTree.find((group) => group.page === currentPage || group.inside.includes(currentPage)) || null : null;
  const presetInput: SitePagePresetInput = {
    businessName: state?.business.name || "",
    coachName: state?.business.coachName || "",
    bookingHref,
    venueName: state?.business.venueName || "",
    email: state?.business.email || "",
    phone: "",
  };

  /**
   * Take what the server saved. Its cleaned copy (with ids for new pages)
   * replaces the draft only if nothing changed meanwhile, or always when the
   * result is a whole new site (an import) that the draft must follow.
   */
  const applySaved = useCallback((result: SavedSite, sending: Draft | null, replace = false) => {
    const next = draftFromViews(result.site.settings, result.pages);
    setState((current) => (current ? { ...current, site: result.site, pages: result.pages } : current));
    setSaved(next);
    setDraft((current) => (replace || current === sending || !current ? next : current));
  }, []);

  /** The site as last seen saved, so the server can tell a stale tab from the latest work. */
  const lastSeen = state?.site?.updatedAt || null;
  const isPublic = Boolean(state?.site?.isPublished);
  // A whole new site (a template, an import) is saved without going live; Save puts it live.
  const notLive = isPublic && Boolean(state?.site && state.site.updatedAt > (state.site.publishedAt || ""));
  const canSave = dirty || notLive;

  /** Save, Squarespace's way: on a public site the changes go live at once. */
  async function save(): Promise<SiteView | null> {
    const sending = draftRef.current;
    if (!sending) return null;
    setBusy("save");
    try {
      const result = await saveSite(sending.settings, sending.pages, lastSeen, true);
      applySaved(result, sending);
      onToast(result.site.isPublished ? t("Saved. Your changes are live.") : t("Saved. Make the site public when it is ready."));
      return result.site;
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("Could not save the page."));
      return null;
    } finally {
      setBusy("");
    }
  }

  /** The first time: make the site public. After that, Save keeps it up to date. */
  async function publish() {
    const site = dirty ? await save() : state?.site;
    if (!site) return;
    setBusy("publish");
    try {
      applySaved(await publishSite(site.updatedAt), draftRef.current);
      onToast(t("Published. Your site is live."));
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("Could not publish the page."));
    } finally {
      setBusy("");
    }
  }

  async function unpublish() {
    if (!window.confirm(t("Take the site offline? Visitors see nothing until you make it public again. Your pages are kept."))) return;
    setBusy("unpublish");
    try {
      applySaved(await unpublishSite(), draftRef.current);
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("Could not take the page down."));
    } finally {
      setBusy("");
    }
  }

  /** Into the editor, on the pages panel or straight into edit mode. */
  function openEditor(next: "pages" | "edit") {
    setMode(next);
    setPanel(null);
    onEditingChange(true);
  }

  /** Unsaved changes are thrown away only when the coach says so, as Squarespace asks on Exit. */
  function confirmDiscard(): boolean {
    if (!dirty) return true;
    if (!window.confirm(t("Discard your unsaved changes?"))) return false;
    setDraft(saved);
    return true;
  }

  /** Exit edit mode, back to the pages panel. */
  function exitEdit() {
    if (!confirmDiscard()) return;
    setMode("pages");
    setPanel(null);
    setSelected("page");
  }

  /** Close the editor, back to the Settings card. */
  function closeEditor() {
    if (!confirmDiscard()) return;
    setPanel(null);
    setMode("pages");
    onEditingChange(false);
  }

  const [importUrl, setImportUrl] = useState("");
  const [importPreset, setImportPreset] = useState("classic");
  const [importReport, setImportReport] = useState<string[]>([]);

  async function importFromUrl() {
    if (!state || !importUrl.trim()) return;
    if (draft && !window.confirm(t("Replace the whole site with the one at this address? Every page you have made here is lost."))) return;
    setBusy("import");
    setImportReport([]);
    try {
      const result = await importSite(importUrl.trim(), importPreset, lastSeen);
      applySaved(result, null, true);
      setImportReport(result.report);
      setCurrentSlug(HOME_PAGE_SLUG);
      setSelected("page");
      onToast(result.report[0] || t("The site came over."));
      // The pictures, a few at a time, each batch a short call of its own.
      const pictures = result.pictures;
      const report = [...result.report];
      for (let index = 0; index < pictures.length; index += 6) {
        setImportReport([...report, t("Bringing pictures over: {done} of {total}", { done: index, total: pictures.length })]);
        const batch = await importPictures(pictures.slice(index, index + 6));
        applySaved(batch, null, true);
        report.push(...batch.report);
      }
      if (pictures.length) report.push(t("{count} pictures are now in your own storage.", { count: pictures.length - report.filter((line) => line.startsWith("A picture stays")).length }));
      setImportReport(report);
      setChoosingTemplate(false);
      openEditor("pages");
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("The site could not be brought over."));
    } finally {
      setBusy("");
    }
  }

  async function startFromTemplate(templateId: string) {
    if (!state) return;
    const template = findSiteTemplate(templateId);
    if (!template) return;
    if (draft && !window.confirm(t("Replace the whole site with this template? Every page you have made is lost."))) return;
    const built = template.build(presetInput);
    const next: Draft = { settings: built.settings, pages: built.pages.map((page, index) => ({ ...page, id: "", sortOrder: index })) };
    setDraft(next);
    setCurrentSlug(HOME_PAGE_SLUG);
    setSelected("page");
    setChoosingTemplate(false);
    // A fresh site is for editing, not admiring.
    openEditor("edit");
    setBusy("save");
    try {
      applySaved(await saveSite(next.settings, next.pages, lastSeen), next);
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("Could not save the page."));
    } finally {
      setBusy("");
    }
  }

  const update = (next: Draft) => setDraft(next);
  const updatePage = (slug: string, next: SitePage) => draft && update({ ...draft, pages: draft.pages.map((page) => (page.slug === slug ? next : page)) });
  const setBlocks = (blocks: SiteBlock[]) => currentPage && updatePage(currentPage.slug, { ...currentPage, content: { ...currentPage.content, blocks } });
  const updateBlock = (id: string, next: SiteBlock) => currentPage && setBlocks(currentPage.content.blocks.map((block) => (block.id === id ? next : block)));
  const selectedBlock = currentPage && typeof selected === "object" ? currentPage.content.blocks.find((block) => block.id === selected.block) || null : null;

  function addPage(presetId: string) {
    if (!draft) return;
    const preset = SITE_PAGE_PRESETS.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    const built = preset.build(presetInput);
    // A new article or video lives under the page that lists it ("articles/new-article"), like one brought over from an old site.
    const lists = built.kind === "article" ? "articles" : built.kind === "video" ? "videos" : "";
    const index = lists ? draft.pages.find((page) => page.kind === "page" && page.content.blocks.some((block) => block.type === lists)) : null;
    const slug = uniquePageSlug(index ? `${index.slug}/${built.slug}` : built.slug, draft.pages.map((page) => page.slug));
    const page: SitePage = { ...built, slug, id: "", sortOrder: draft.pages.length };
    update({ ...draft, pages: [...draft.pages, page] });
    setCurrentSlug(slug);
    setSelected("page");
    setPageMenuOpen(false);
    setPanel("page");
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
    setPanel(null);
  }

  /** The pages beside a page: those inside the same page, or at the top with it. Home stays first at the top: it is the page the domain lands on. */
  const siblingsOf = (page: SitePage): { siblings: SitePage[]; at: number; first: number } => {
    const pages = draft?.pages || [];
    const parent = sitePageParent(page, pages);
    const siblings = pages.filter((candidate) => sitePageParent(candidate, pages) === parent);
    return { siblings, at: siblings.indexOf(page), first: parent ? 0 : 1 };
  };

  /** Move a page one place among the pages beside it; a page inside another never leaves it. */
  function movePage(slug: string, delta: number) {
    if (!draft) return;
    const page = draft.pages.find((candidate) => candidate.slug === slug);
    if (!page) return;
    const { siblings, at, first } = siblingsOf(page);
    const target = at + delta;
    if (at < first || target < first || target >= siblings.length) return;
    const pages = draft.pages.filter((candidate) => candidate !== page);
    pages.splice(pages.indexOf(siblings[target]) + (delta > 0 ? 1 : 0), 0, page);
    update({ ...draft, pages: pages.map((candidate, order) => ({ ...candidate, sortOrder: order })) });
  }

  /** A section from the gallery, put where its "Add section" was pressed. */
  function insertSection(choice: SectionChoice) {
    if (!currentPage) return;
    const block = blockForChoice(choice);
    const blocks = [...currentPage.content.blocks];
    blocks.splice(Math.min(addAt, blocks.length), 0, block);
    setBlocks(blocks);
    setSelected({ block: block.id });
    setPanel(null);
  }

  function moveBlock(id: string, delta: number) {
    if (!currentPage) return;
    const blocks = [...currentPage.content.blocks];
    const index = blocks.findIndex((block) => block.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= blocks.length) return;
    const [block] = blocks.splice(index, 1);
    blocks.splice(target, 0, block);
    setBlocks(blocks);
  }

  function duplicateBlock(id: string) {
    if (!currentPage) return;
    const blocks = [...currentPage.content.blocks];
    const index = blocks.findIndex((block) => block.id === id);
    if (index < 0) return;
    const copy = { ...structuredClone(blocks[index]), id: newSiteBlock("divider").id };
    blocks.splice(index + 1, 0, copy);
    setBlocks(blocks);
    setSelected({ block: copy.id });
  }

  function removeBlock(id: string) {
    if (!currentPage) return;
    if (!window.confirm(t("Remove this section?"))) return;
    setBlocks(currentPage.content.blocks.filter((block) => block.id !== id));
    if (typeof selected === "object" && selected.block === id) {
      setSelected("page");
      if (panel === "section") setPanel(null);
    }
  }

  const previewLabels = useMemo<PreviewLabels>(
    () => ({
      noArticles: t("No articles yet. Add one with Add page › Article."),
      noVideos: t("No videos yet. Add one with Add page › Video."),
      noPage: t("There is no page here"),
    }),
    [],
  );
  const previewPath = useCallback((slug: string) => `#${slug}`, []);

  // What the page does when it is edited where it stands (edit mode only).
  const editorHooks: SiteEditorHooks = {
    editText: (blockId, path, value) => {
      const block = currentPage?.content.blocks.find((candidate) => candidate.id === blockId);
      if (block) updateBlock(blockId, setBlockField(block, path, value));
    },
    addSection: (index) => {
      setAddAt(index);
      setPanel("add");
    },
    editSection: (blockId) => {
      setSelected({ block: blockId });
      setSectionTab("content");
      setPanel("section");
    },
    moveSection: moveBlock,
    duplicateSection: duplicateBlock,
    removeSection: removeBlock,
    editHeader: () => {
      setSelected("header");
      setPanel("header");
    },
    editFooter: () => {
      setSelected("footer");
      setPanel("footer");
    },
    arrangeFreely: (blockId) => {
      const block = currentPage?.content.blocks.find((candidate) => candidate.id === blockId);
      const next = block ? arrangeFreely(block) : null;
      if (!next || !window.confirm(t("Turn this section into a free layout? You can then drag its words, buttons and picture anywhere. It stays a free layout afterwards."))) return;
      updateBlock(blockId, next);
      setSelected({ block: blockId });
    },
    canvasItem,
    selectCanvasItem: (blockId, itemId) => {
      setSelected({ block: blockId });
      setCanvasItem(itemId ? { block: blockId, item: itemId } : null);
    },
    changeCanvas: (blockId, next) => {
      const block = currentPage?.content.blocks.find((candidate) => candidate.id === blockId);
      if (block?.type === "canvas") updateBlock(blockId, { ...block, ...next });
    },
    editCanvasItem: (blockId, itemId) => {
      setSelected({ block: blockId });
      setCanvasItem({ block: blockId, item: itemId });
      setSectionTab("content");
      setPanel("section");
    },
    labels: {
      addSection: t("Add section"),
      editSection: t("Edit section"),
      moveUp: t("Move up"),
      moveDown: t("Move down"),
      duplicate: t("Duplicate"),
      remove: t("Remove"),
      editHeader: t("Edit site header"),
      editFooter: t("Edit footer"),
      emptyPage: t("This page is empty. Add a section to start."),
      arrangeFreely: t("Arrange freely: drag the parts anywhere"),
      canvas: {
        heading: t("Heading"),
        text: t("Text"),
        picture: t("Picture"),
        button: t("Button"),
        shape: t("Shape"),
        addHeading: t("Add a heading"),
        addText: t("Add text"),
        addPicture: t("Add a picture"),
        addButton: t("Add a button"),
        addShape: t("Add a shape"),
        newHeading: t("A new heading"),
        newText: t("Write something here."),
        newButton: t("Find out more"),
        edit: t("Edit"),
        forward: t("Bring forward"),
        backward: t("Send backward"),
        duplicate: t("Duplicate"),
        remove: t("Remove"),
        height: t("Drag to change the section's height"),
      },
    },
  };

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
          const preset = findSiteTemplate(template.id)?.build(presetInput).settings.theme;
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
      <div className="site-import">
        <h4 className="site-inspector-subtitle">{t("Or bring over a site you already have")}</h4>
        <p className="settings-note">{t("A Squarespace site comes over with its pages, articles, videos, words and pictures, at the same addresses, in the look you pick above. It replaces what is in the editor; visitors see none of it until you press Save.")}</p>
        <div className="site-import-row">
          <input value={importUrl} placeholder="https://www.yoursite.com" maxLength={300} onChange={(event) => setImportUrl(event.target.value)} />
          <select value={importPreset} onChange={(event) => setImportPreset(event.target.value)} aria-label={t("Look")}>
            {state.templates.map((template) => (
              <option key={template.id} value={template.preset}>
                {template.label}
              </option>
            ))}
          </select>
          <button className="primary-button" type="button" disabled={busy !== "" || !importUrl.trim()} onClick={() => void importFromUrl()}>
            {busy === "import" ? t("Bringing it over…") : t("Import")}
          </button>
        </div>
        {importReport.length ? (
          <ul className="site-import-report">
            {importReport.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {draft ? (
        <button className="outline-button" type="button" onClick={() => setChoosingTemplate(false)}>
          {t("Keep my site")}
        </button>
      ) : null}
    </div>
  );

  const status = (
    <div className="site-builder-status">
      <strong>{isPublic ? t("Live") : t("Not public yet")}</strong>
      <span>{dirty ? t("Unsaved changes") : notLive ? t("Changes not live yet") : isPublic ? t("Everything is saved and live") : t("Saved")}</span>
    </div>
  );

  const saveButton = (
    <button className="primary-button" type="button" onClick={() => void save()} disabled={busy !== "" || !canSave}>
      <Check size={16} />
      {busy === "save" ? t("Saving...") : t("Save")}
    </button>
  );

  const makePublicButton = !isPublic ? (
    <button className={mode === "edit" && editing ? "outline-button" : "primary-button"} type="button" onClick={() => void publish()} disabled={busy !== ""}>
      <Eye size={16} />
      {busy === "publish" ? t("Publishing…") : t("Make site public")}
    </button>
  ) : null;

  const devices = (
    <div className="site-builder-devices" role="group" aria-label={t("Preview size")}>
      <button type="button" className={`icon-button${device === "desktop" ? " is-active" : ""}`} aria-label={t("Desktop")} onClick={() => setDevice("desktop")}>
        <Monitor size={16} />
      </button>
      <button type="button" className={`icon-button${device === "phone" ? " is-active" : ""}`} aria-label={t("Phone")} onClick={() => setDevice("phone")}>
        <Smartphone size={16} />
      </button>
    </div>
  );

  /** The rarely needed: start again, take the site offline. */
  const moreMenu = (
    <div className="site-sq-more">
      <button type="button" className="icon-button" aria-label={t("More")} aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}>
        <MoreHorizontal size={18} />
      </button>
      {moreOpen ? (
        <div className="site-add-menu site-sq-more-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            disabled={busy !== ""}
            onClick={() => {
              setMoreOpen(false);
              setChoosingTemplate(true);
            }}
          >
            <span>
              <strong>{t("Start again")}</strong>
              <em>{t("Pick a template or bring a site over. It replaces this one.")}</em>
            </span>
          </button>
          {isPublic ? (
            <button
              type="button"
              role="menuitem"
              disabled={busy !== ""}
              onClick={() => {
                setMoreOpen(false);
                void unpublish();
              }}
            >
              <span>
                <strong>{busy === "unpublish" ? t("Taking down…") : t("Take the site offline")}</strong>
                <em>{t("Visitors see nothing until you make it public again.")}</em>
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const pageTab = (page: SitePage) => (
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
  );

  /** One page in the pages panel: its name, a note, its gear (page settings), and its move buttons. */
  const pageRow = (page: SitePage, note: string) => {
    const { siblings, at, first } = siblingsOf(page);
    const kind = page.kind === "article" ? t("Article") : page.kind === "video" ? t("Video") : "";
    return (
      <div key={page.slug} className={`site-outline-row${page.slug === currentPage?.slug ? " is-current" : ""}`}>
        <button
          type="button"
          className="site-outline-main"
          onClick={() => {
            setCurrentSlug(page.slug);
            setSelected("page");
            if (panel === "page") setPanel(null);
          }}
        >
          <span>
            <strong>{page.title || page.slug}</strong>
            {note || kind ? <em>{[kind, note].filter(Boolean).join(" · ")}</em> : null}
          </span>
        </button>
        <span className="site-outline-actions">
          {page.slug !== HOME_PAGE_SLUG ? (
            <>
              <button type="button" className="icon-button" aria-label={t("Move up")} disabled={at <= first} onClick={() => movePage(page.slug, -1)}>
                <ArrowUp size={14} />
              </button>
              <button type="button" className="icon-button" aria-label={t("Move down")} disabled={at >= siblings.length - 1} onClick={() => movePage(page.slug, 1)}>
                <ArrowDown size={14} />
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="icon-button"
            aria-label={t("Page settings")}
            onClick={() => {
              setCurrentSlug(page.slug);
              setSelected("page");
              setPanel("page");
            }}
          >
            <Settings2 size={14} />
          </button>
        </span>
      </div>
    );
  };

  /** A group of pages in the panel: the page, and the pages inside it while it is the one open. */
  const pageGroup = (group: (typeof pageTree)[number]) => {
    const open = group === currentGroup && group.inside.length > 0;
    return (
      <li key={group.page.slug}>
        {pageRow(group.page, open ? "" : group.inside.length ? t("{count} inside", { count: group.inside.length }) : "")}
        {open ? <ol className="site-outline-list is-inside">{group.inside.map((page) => pageRow(page, ""))}</ol> : null}
      </li>
    );
  };

  const pageStrip = draft ? (
    <>
      <div className="site-pages-strip" role="tablist" aria-label={t("Pages")}>
        {pageTree.map((group) => pageTab(group.page))}
      </div>
      {currentGroup && currentGroup.inside.length ? (
        <div className="site-pages-strip is-inside" role="tablist" aria-label={t("Inside {page}", { page: currentGroup.page.title || currentGroup.page.slug })}>
          <span className="site-pages-inside-label">{t("Inside {page}", { page: currentGroup.page.title || currentGroup.page.slug })}</span>
          {currentGroup.inside.map(pageTab)}
        </div>
      ) : null}
    </>
  ) : null;

  const inEdit = editing && mode === "edit";

  const preview = currentPage ? (
    <SiteRenderer
      settings={draft!.settings}
      page={currentPage}
      pages={cards}
      business={business}
      mode="preview"
      pagePath={previewPath}
      onNavigate={(slug) => {
        if (draft?.pages.some((page) => page.slug === slug)) {
          setCurrentSlug(slug);
          setSelected("page");
          if (panel === "section") setPanel(null);
        }
      }}
      selected={inEdit ? selected : undefined}
      onSelect={inEdit ? setSelected : undefined}
      previewLabels={previewLabels}
      editor={inEdit ? editorHooks : undefined}
    />
  ) : null;

  // --- The editor: the whole pane ----------------------------------------------

  if (editing && draft && currentPage && !choosingTemplate) {
    const panelTitle =
      panel === "section" && selectedBlock
        ? blockCatalogEntry(selectedBlock.type).label
        : panel === "styles"
          ? t("Site styles")
          : panel === "header"
            ? t("Site header")
            : panel === "footer"
              ? t("Footer")
              : panel === "page"
                ? t("Page settings: {page}", { page: currentPage.title || currentPage.slug })
                : "";
    const rightPanel = panel && panel !== "add" && (panel !== "section" || selectedBlock);

    return (
      <article className={`data-card settings-section settings-website site-editor-full site-sq is-${mode}`}>
        <div className="site-sq-bar">
          {mode === "edit" ? (
            <>
              <button className="outline-button" type="button" onClick={exitEdit}>
                {t("Exit")}
              </button>
              {saveButton}
            </>
          ) : (
            <>
              <button className="icon-button" type="button" aria-label={t("Close the editor")} onClick={closeEditor}>
                <X size={18} />
              </button>
              <button className="primary-button" type="button" onClick={() => setMode("edit")}>
                <Pencil size={16} />
                {t("Edit")}
              </button>
              {canSave ? saveButton : null}
            </>
          )}
          {status}
          <div className="site-inline-actions">
            {devices}
            {mode === "edit" ? (
              <button className={`outline-button${panel === "styles" ? " is-active" : ""}`} type="button" onClick={() => setPanel(panel === "styles" ? null : "styles")}>
                <Paintbrush size={16} />
                {t("Site styles")}
              </button>
            ) : null}
            {makePublicButton}
            {moreMenu}
          </div>
        </div>

        <div className="site-sq-body">
          {mode === "pages" ? (
            <aside className="site-sq-side site-outline" aria-label={t("Pages")}>
              <div className="site-sq-panel-head">
                <h3>{t("Pages")}</h3>
                <button type="button" className="icon-button" aria-label={t("Add page")} aria-expanded={pageMenuOpen} onClick={() => setPageMenuOpen((open) => !open)}>
                  <Plus size={18} />
                </button>
              </div>
              {pageMenuOpen ? (
                <div className="site-add-menu" role="menu">
                  {state.presets.map((preset) => (
                    <button type="button" role="menuitem" key={preset.id} onClick={() => addPage(preset.id)}>
                      <FilePlus size={16} />
                      <span>
                        <strong>{preset.label}</strong>
                        <em>{preset.summary}</em>
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
              <h4 className="site-outline-title">{t("Main navigation")}</h4>
              <ol className="site-outline-list">{pageTree.filter((group) => group.page.inNav).map(pageGroup)}</ol>
              <h4 className="site-outline-title">{t("Not linked")}</h4>
              {pageTree.some((group) => !group.page.inNav) ? (
                <ol className="site-outline-list">{pageTree.filter((group) => !group.page.inNav).map(pageGroup)}</ol>
              ) : (
                <p className="site-field-help">{t("Pages that are not in the menu, reached only by a link.")}</p>
              )}
              <h4 className="site-outline-title">{t("Site")}</h4>
              <button type="button" className={`site-outline-row is-fixed${panel === "styles" ? " is-selected" : ""}`} onClick={() => setPanel("styles")}>
                <Paintbrush size={15} />
                <span>{t("Site styles")}</span>
              </button>
              <button type="button" className={`site-outline-row is-fixed${panel === "header" ? " is-selected" : ""}`} onClick={() => setPanel("header")}>
                <PanelTop size={15} />
                <span>{t("Site header")}</span>
              </button>
              <button type="button" className={`site-outline-row is-fixed${panel === "footer" ? " is-selected" : ""}`} onClick={() => setPanel("footer")}>
                <PanelBottom size={15} />
                <span>{t("Footer")}</span>
              </button>
            </aside>
          ) : null}

          {panel === "add" ? (
            <aside className="site-sq-side site-sq-gallery" aria-label={t("Add section")}>
              <div className="site-sq-panel-head">
                <h3>{t("Add section")}</h3>
                <button type="button" className="icon-button" aria-label={t("Close")} onClick={() => setPanel(null)}>
                  <X size={18} />
                </button>
              </div>
              <div className="site-sq-gallery-body">
                <nav className="site-sq-categories" aria-label={t("Kinds of section")}>
                  {galleryCategories.map((category) => (
                    <button type="button" key={category} className={category === addCategory ? "is-active" : ""} onClick={() => setAddCategory(category)}>
                      {category}
                    </button>
                  ))}
                </nav>
                <div className="site-sq-choices">
                  {gallery
                    .filter((choice) => choice.category === (galleryCategories.includes(addCategory as (typeof SECTION_CATEGORIES)[number]) ? addCategory : galleryCategories[0]))
                    .map((choice) => (
                      <button type="button" className="site-sq-choice" key={choice.id} onClick={() => insertSection(choice)}>
                        <span className="site-sketch" aria-hidden="true">
                          {choice.sketch}
                        </span>
                        <span>{choice.label}</span>
                      </button>
                    ))}
                </div>
              </div>
            </aside>
          ) : null}

          <div className={`site-preview is-${device}`}>
            <SitePreviewFrame fontsUrl={fontsUrl} width={device === "phone" ? PHONE_WIDTH : "100%"} title={t("Preview")}>
              {preview}
            </SitePreviewFrame>
          </div>

          {rightPanel ? (
            <aside className="site-sq-side site-sq-panel site-inspector" aria-label={panelTitle}>
              <div className="site-sq-panel-head">
                <h3>{panelTitle}</h3>
                <button type="button" className="icon-button" aria-label={t("Close")} onClick={() => setPanel(null)}>
                  <X size={18} />
                </button>
              </div>
              {panel === "section" && selectedBlock ? (
                <>
                  <div className="site-sq-tabs" role="tablist">
                    <button type="button" role="tab" aria-selected={sectionTab === "content"} className={sectionTab === "content" ? "is-active" : ""} onClick={() => setSectionTab("content")}>
                      {t("Content")}
                    </button>
                    <button type="button" role="tab" aria-selected={sectionTab === "design"} className={sectionTab === "design" ? "is-active" : ""} onClick={() => setSectionTab("design")}>
                      {t("Design")}
                    </button>
                  </div>
                  {sectionTab === "content" ? (
                    <>
                      <BlockContentFields block={selectedBlock} focusItem={canvasItem?.block === selectedBlock.id ? canvasItem.item : ""} onChange={(next) => updateBlock(selectedBlock.id, next)} pages={pageOptions} bookingHref={bookingHref} onError={onToast} />
                      <p className="site-field-help">
                        {t("Link to this section with")} <code>#{selectedBlock.id}</code>
                      </p>
                    </>
                  ) : (
                    <SectionDesignFields style={selectedBlock.style} onChange={(style) => updateBlock(selectedBlock.id, { ...selectedBlock, style })} onError={onToast} />
                  )}
                </>
              ) : null}
              {panel === "styles" ? <SiteInspector settings={draft.settings} onChange={(settings) => update({ ...draft, settings })} /> : null}
              {panel === "header" ? (
                <HeaderInspector header={draft.settings.header} onChange={(header) => update({ ...draft, settings: { ...draft.settings, header } })} pages={pageOptions} bookingHref={bookingHref} />
              ) : null}
              {panel === "footer" ? (
                <FooterInspector footer={draft.settings.footer} onChange={(footer) => update({ ...draft, settings: { ...draft.settings, footer } })} pages={pageOptions} bookingHref={bookingHref} />
              ) : null}
              {panel === "page" ? (
                <PageInspector page={currentPage} pages={pageOptions.filter((page) => page.slug !== currentPage.slug)} onChange={(next) => renamePage(currentPage, next)} onDelete={() => deletePage(currentPage)} onError={onToast} />
              ) : null}
            </aside>
          ) : null}
        </div>
      </article>
    );
  }

  // --- At rest: the site, and where it lives ----------------------------------

  return (
    <>
      <SettingsGroup id="website" icon={Globe} section="website" title={t("Website")} className="site-builder-card">
        <p className="settings-note">
          {state.forBusiness
            ? t("A public website for your business, with your booking page and shop built in. Build it here, publish it, and point your own domain at it below.")
            : t("One of Clarity's own websites, built with the same builder coaches use. Build it here, publish it, and point its domain at it below.")}
        </p>
        {!draft || choosingTemplate ? (
          templateChooser
        ) : (
          <div className="site-builder">
            <div className="site-builder-toolbar">
              <button className="primary-button" type="button" onClick={() => openEditor("pages")}>
                <Pencil size={16} />
                {t("Edit site")}
              </button>
              {status}
              <div className="site-inline-actions">{makePublicButton}</div>
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
        <DomainPanel state={state} isPublished={isPublic} onDomainsChange={(domains) => setState({ ...state, domains })} />
      </SettingsGroup>
    </>
  );
}
