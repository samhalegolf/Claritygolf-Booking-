// Settings › Website: build the business's public page.
//
// Two ways of looking at it. At rest the tab shows the page as it stands,
// full width, with Edit top left. Edit takes the whole settings pane: the
// settings sub-nav steps aside (the app's sidebar stays), and the editor
// gets three columns: the blocks on the page (add, reorder, remove), the
// page itself drawn live in a frame (click anything to select it), and the
// fields of whatever is selected. Done returns to the resting view; an
// unsaved draft is kept and still shown there. Save keeps a draft nobody
// else sees; Publish makes it the page at /<business>/site and on the
// business's own domain.
import { ArrowDown, ArrowUp, Check, Copy, Eye, Globe, Monitor, PanelBottom, PanelTop, Pencil, Plus, Smartphone, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { googleFontsUrl, newSiteBlock, type SiteBlock, type SiteBlockType, type SiteDocument } from "../../../netlify/functions/_shared/site/document.mts";
import { SITE_TEMPLATES, type SiteTemplateInput } from "../../../netlify/functions/_shared/site/templates.mts";
import { t } from "../../lib/i18n";
import { ClarityPlayerPortal } from "../shared/ClarityIcons";
import { Loading } from "../shared/Loading";
import { SettingsGroup } from "../settings/SettingsLayout";
import { BLOCK_CATALOG, blockCatalogEntry } from "./blockCatalog";
import { DomainPanel } from "./DomainPanel";
import { BlockInspector, FooterInspector, HeaderInspector, PageInspector } from "./Inspectors";
import { fetchSiteState, publishSite, saveSiteDraft, unpublishSite, type SitePageView, type SiteState } from "./siteApi";
import { SitePreviewFrame } from "./SitePreviewFrame";
import { SiteRenderer, type SiteSelection } from "./SiteRenderer";
import { bookingPageUrl } from "./siteTheme";
import "./site-builder.css";

const PHONE_WIDTH = "390px";

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
    case "contact":
      return block.heading;
    case "image":
      return block.caption || block.image?.alt || "";
    default:
      return "";
  }
}

const sameDocument = (a: SiteDocument | null, b: SiteDocument | null) => JSON.stringify(a) === JSON.stringify(b);

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
  const [draft, setDraft] = useState<SiteDocument | null>(null);
  const [saved, setSaved] = useState<SiteDocument | null>(null);
  const [selected, setSelected] = useState<SiteSelection>("page");
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const [busy, setBusy] = useState<"" | "save" | "publish" | "unpublish">("");
  const [choosingTemplate, setChoosingTemplate] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchSiteState()
      .then((next) => {
        if (cancelled) return;
        setState(next);
        setDraft(next.page?.document ?? null);
        setSaved(next.page?.document ?? null);
      })
      .catch((cause: Error) => !cancelled && setLoadError(cause.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = Boolean(draft) && !sameDocument(draft, saved);

  // Leaving with unsaved blocks is the one thing this editor refuses to do quietly.
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
  const fontsUrl = draft ? googleFontsUrl(draft.theme) : "";

  const applyPage = useCallback((page: SitePageView) => {
    setState((current) => (current ? { ...current, page } : current));
    setSaved(page.document);
    setDraft((current) => (current && !sameDocument(current, page.document) ? current : page.document));
  }, []);

  async function save(): Promise<boolean> {
    if (!draft) return false;
    setBusy("save");
    const sending = draft;
    try {
      const page = await saveSiteDraft(sending);
      setState((current) => (current ? { ...current, page } : current));
      setSaved(page.document);
      // The server's cleaned copy replaces the draft only if nothing changed meanwhile.
      setDraft((current) => (current === sending ? page.document : current));
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
      applyPage(await publishSite());
      onToast(t("Published. Your page is live."));
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("Could not publish the page."));
    } finally {
      setBusy("");
    }
  }

  async function unpublish() {
    if (!window.confirm(t("Take the page down? Visitors see nothing until you publish again. Your draft is kept."))) return;
    setBusy("unpublish");
    try {
      applyPage(await unpublishSite());
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
    if (draft && !window.confirm(t("Replace the whole page with this template? Blocks you have added are lost."))) return;
    const input: SiteTemplateInput = {
      businessName: state.business.name,
      coachName: state.business.coachName,
      bookingHref,
      email: state.business.email,
      phone: "",
      venueName: state.business.venueName,
    };
    const document = template.build(input);
    setDraft(document);
    setSelected("page");
    setChoosingTemplate(false);
    // A fresh page is for editing, not admiring.
    onEditingChange(true);
    setBusy("save");
    try {
      const page = await saveSiteDraft(document);
      setState((current) => (current ? { ...current, page } : current));
      setSaved(page.document);
      setDraft(page.document);
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("Could not save the page."));
    } finally {
      setBusy("");
    }
  }

  const update = (next: SiteDocument) => setDraft(next);
  const updateBlock = (id: string, next: SiteBlock) => draft && update({ ...draft, blocks: draft.blocks.map((block) => (block.id === id ? next : block)) });
  const selectedBlock = draft && typeof selected === "object" ? draft.blocks.find((block) => block.id === selected.block) || null : null;

  function addBlock(type: SiteBlockType) {
    if (!draft) return;
    const block = newSiteBlock(type);
    // After the selected block, or at the end.
    const index = selectedBlock ? draft.blocks.findIndex((candidate) => candidate.id === selectedBlock.id) + 1 : draft.blocks.length;
    const blocks = [...draft.blocks];
    blocks.splice(index, 0, block);
    update({ ...draft, blocks });
    setSelected({ block: block.id });
    setAddMenuOpen(false);
  }

  function moveBlock(id: string, delta: number) {
    if (!draft) return;
    const index = draft.blocks.findIndex((block) => block.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= draft.blocks.length) return;
    const blocks = [...draft.blocks];
    const [block] = blocks.splice(index, 1);
    blocks.splice(target, 0, block);
    update({ ...draft, blocks });
  }

  function duplicateBlock(id: string) {
    if (!draft) return;
    const index = draft.blocks.findIndex((block) => block.id === id);
    if (index < 0) return;
    const copy = { ...structuredClone(draft.blocks[index]), id: newSiteBlock("divider").id };
    const blocks = [...draft.blocks];
    blocks.splice(index + 1, 0, copy);
    update({ ...draft, blocks });
    setSelected({ block: copy.id });
  }

  function removeBlock(id: string) {
    if (!draft) return;
    update({ ...draft, blocks: draft.blocks.filter((block) => block.id !== id) });
    if (typeof selected === "object" && selected.block === id) setSelected("page");
  }

  const previewLabels = useMemo(() => ({ booking: t("Your booking page shows here"), map: t("A map shows here") }), []);

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

  const chooser = (
    <div className="site-templates">
      <p className="settings-note">{t("Pick a starting point. Everything on it can be changed, and blocks can be added or removed afterwards.")}</p>
      <div className="site-template-grid">
        {state.templates.map((template) => {
          const preset = SITE_TEMPLATES.find((candidate) => candidate.id === template.id)?.build({
            businessName: state.business.name,
            coachName: state.business.coachName,
            bookingHref,
            email: "",
            phone: "",
            venueName: "",
          }).theme;
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
          {t("Keep my page")}
        </button>
      ) : null}
    </div>
  );

  const status = (
    <div className="site-builder-status">
      <strong>{state.page?.isPublished ? t("Published") : t("Not published")}</strong>
      <span>{dirty ? t("Unsaved changes") : state.page?.isPublished && state.page.updatedAt > (state.page.publishedAt || "") ? t("Saved draft is newer than the published page") : t("Saved")}</span>
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

  // --- Editing: the whole pane -------------------------------------------------

  if (editing && draft && !choosingTemplate) {
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
              {state.page?.isPublished ? (
                <button className="outline-button" type="button" onClick={() => void unpublish()} disabled={busy !== ""}>
                  {busy === "unpublish" ? t("Taking down…") : t("Take down")}
                </button>
              ) : null}
              {saveButton}
              {publishButton}
            </div>
          </div>

          <div className="site-builder-grid">
            <aside className="site-outline" aria-label={t("Blocks on the page")}>
              <button type="button" className={`site-outline-row is-fixed${selected === "page" ? " is-selected" : ""}`} onClick={() => setSelected("page")}>
                <Globe size={15} />
                <span>{t("Page and look")}</span>
              </button>
              <button type="button" className={`site-outline-row is-fixed${selected === "header" ? " is-selected" : ""}`} onClick={() => setSelected("header")}>
                <PanelTop size={15} />
                <span>{t("Header")}</span>
              </button>
              <ol className="site-outline-list">
                {draft.blocks.map((block, index) => {
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
                        <button type="button" className="icon-button" aria-label={t("Move down")} disabled={index === draft.blocks.length - 1} onClick={() => moveBlock(block.id, 1)}>
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
              <button type="button" className={`site-outline-row is-fixed${selected === "footer" ? " is-selected" : ""}`} onClick={() => setSelected("footer")}>
                <PanelBottom size={15} />
                <span>{t("Footer")}</span>
              </button>
            </aside>

            <div className={`site-preview is-${device}`}>
              <SitePreviewFrame fontsUrl={fontsUrl} width={device === "phone" ? PHONE_WIDTH : "100%"} title={t("Preview")}>
                <SiteRenderer document={draft} business={business} mode="preview" selected={selected} onSelect={setSelected} previewLabels={previewLabels} />
              </SitePreviewFrame>
            </div>

            <aside className="site-inspector">
              {selected === "page" ? <PageInspector document={draft} onChange={update} /> : null}
              {selected === "header" ? <HeaderInspector header={draft.header} onChange={(header) => update({ ...draft, header })} bookingHref={bookingHref} /> : null}
              {selected === "footer" ? <FooterInspector footer={draft.footer} onChange={(footer) => update({ ...draft, footer })} /> : null}
              {selectedBlock ? (
                <>
                  <h3 className="site-inspector-title">{blockCatalogEntry(selectedBlock.type).label}</h3>
                  <p className="site-field-help">
                    {t("Link to this block with")} <code>#{selectedBlock.id}</code>
                  </p>
                  <BlockInspector block={selectedBlock} onChange={(next) => updateBlock(selectedBlock.id, next)} bookingHref={bookingHref} onError={onToast} />
                </>
              ) : null}
            </aside>
          </div>
        </div>
      </article>
    );
  }

  // --- At rest: the page, and where it lives ----------------------------------

  return (
    <>
      <SettingsGroup id="website" icon={Globe} section="website" title={t("Website")} className="site-builder-card">
        <p className="settings-note">{t("A public page for your business, with your booking page built in. Build it here, publish it, and point your own domain at it below.")}</p>
        {!draft || choosingTemplate ? (
          chooser
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
            <div className="site-preview is-desktop is-resting">
              <SitePreviewFrame fontsUrl={fontsUrl} width="100%" title={t("Preview")}>
                <SiteRenderer document={draft} business={business} mode="preview" previewLabels={previewLabels} />
              </SitePreviewFrame>
            </div>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup id="website-address" icon={ClarityPlayerPortal} section="website" title={t("Where the page lives")}>
        <DomainPanel state={state} isPublished={Boolean(state.page?.isPublished)} onDomainsChange={(domains) => setState({ ...state, domains })} />
      </SettingsGroup>
    </>
  );
}
