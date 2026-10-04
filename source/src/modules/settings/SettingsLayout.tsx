import { Check, FlaskConical, Pencil, Webhook, X } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { t } from "../../lib/i18n";
import {
  ClarityAdmin,
  ClarityCalendar,
  ClarityEmail,
  ClarityFacilitiesRooms,
  ClarityIntegrations,
  ClarityLessonsProgrammes,
  ClarityNotifications,
  ClarityProfile,
  ClarityServices,
  type IconComponent,
} from "../shared/ClarityIcons";

/**
 * The building blocks every settings screen is laid out with: the group and
 * section frames, the workspace surface, and editable blocks that save on
 * their own.
 */

type EditableBlockStatus = "idle" | "editing" | "saving" | "saved" | "error";
type EditableBlockState = {
  status: EditableBlockStatus;
  dirty: boolean;
  errorMessage: string | null;
};

const editableBlockSavedDelayMs = 1600;

function cloneEditableValue<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultEditableEqual<T>(a: T, b: T) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function useEditableBlock<T>({
  value,
  onSave,
  isEqual = defaultEditableEqual,
}: {
  value: T;
  onSave: (draft: T) => Promise<T>;
  isEqual?: (a: T, b: T) => boolean;
}) {
  const [savedValue, setSavedValue] = useState<T>(() => cloneEditableValue(value));
  const [draftValue, setDraftValueState] = useState<T>(() => cloneEditableValue(value));
  const [state, setState] = useState<EditableBlockState>({
    status: "idle",
    dirty: false,
    errorMessage: null,
  });
  const savedTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    setSavedValue(cloneEditableValue(value));
    setState((current) => {
      if (current.dirty || current.status === "editing" || current.status === "saving" || current.status === "error") {
        return current;
      }
      setDraftValueState(cloneEditableValue(value));
      return { ...current, status: current.status === "saved" ? "saved" : "idle", errorMessage: null };
    });
  }, [value]);

  useEffect(
    () => () => {
      if (savedTimeoutRef.current !== null) window.clearTimeout(savedTimeoutRef.current);
    },
    [],
  );

  function edit() {
    if (savedTimeoutRef.current !== null) window.clearTimeout(savedTimeoutRef.current);
    setDraftValueState(cloneEditableValue(savedValue));
    setState({ status: "editing", dirty: false, errorMessage: null });
  }

  function cancel() {
    if (savedTimeoutRef.current !== null) window.clearTimeout(savedTimeoutRef.current);
    setDraftValueState(cloneEditableValue(savedValue));
    setState({ status: "idle", dirty: false, errorMessage: null });
  }

  function setDraftValue(next: T | ((current: T) => T)) {
    setDraftValueState((current) => {
      const nextValue = typeof next === "function" ? (next as (current: T) => T)(current) : next;
      setState((currentState) => ({
        status: currentState.status === "error" ? "editing" : currentState.status,
        dirty: !isEqual(nextValue, savedValue),
        errorMessage: currentState.status === "error" ? null : currentState.errorMessage,
      }));
      return nextValue;
    });
  }

  async function save() {
    if (state.status === "saving" || !state.dirty) return false;
    if (savedTimeoutRef.current !== null) window.clearTimeout(savedTimeoutRef.current);
    setState((current) => ({ ...current, status: "saving", errorMessage: null }));
    try {
      const saved = await onSave(cloneEditableValue(draftValue));
      const cleanSaved = cloneEditableValue(saved);
      setSavedValue(cleanSaved);
      setDraftValueState(cleanSaved);
      setState({ status: "saved", dirty: false, errorMessage: null });
      savedTimeoutRef.current = window.setTimeout(() => {
        setState((current) => (current.status === "saved" ? { ...current, status: "idle" } : current));
      }, editableBlockSavedDelayMs);
      return true;
    } catch (error) {
      setState({
        status: "error",
        dirty: true,
        errorMessage: error instanceof Error ? error.message : t("Could not save these settings."),
      });
      return false;
    }
  }

  return {
    savedValue,
    draftValue,
    status: state.status,
    dirty: state.dirty,
    errorMessage: state.errorMessage,
    edit,
    cancel,
    setDraftValue,
    save,
  };
}

export function EditableSettingsBlock({
  id,
  title,
  status,
  dirty,
  errorMessage,
  onEdit,
  onCancel,
  onSave,
  children,
}: {
  id: string;
  title: string;
  status: EditableBlockStatus;
  dirty: boolean;
  errorMessage: string | null;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  children: ReactNode;
}) {
  const isEditing = status === "editing" || status === "error";
  const isSaving = status === "saving";
  const isError = status === "error";
  return (
    <section
      className={`editable-settings-block is-${status}${isEditing ? " is-editing" : ""}${isSaving ? " is-saving" : ""}${isError ? " is-error" : ""}`}
      id={id}
    >
      <div className="editable-settings-block-header">
        <div>
          <span>{title}</span>
          {dirty ? <em>{t("Unsaved changes")}</em> : status === "saved" ? <em aria-live="polite">{t("Saved")}</em> : null}
        </div>
        <div className="editable-settings-block-actions">
          {status === "idle" || status === "saved" ? (
            <button className="outline-button" onClick={onEdit} type="button">
              <Pencil size={15} />{t("Edit")}</button>
          ) : (
            <>
              <button className="outline-button" disabled={isSaving} onClick={onCancel} type="button">{t("Cancel")}</button>
              <button className="primary-button" disabled={!dirty || isSaving} onClick={onSave} type="button">
                {isSaving ? t("Saving...") : isError ? t("Try Again") : t("Save")}
              </button>
            </>
          )}
          {status === "saved" ? (
            <span className="editable-settings-saved" aria-live="polite">
              <Check size={15} />{t("Saved")}</span>
          ) : null}
        </div>
      </div>
      <div className="editable-settings-block-body">{children}</div>
      {errorMessage ? (
        <p className="workspace-save-error" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Settings sections, in the order they appear in the sub-nav.
 *
 * Was eleven tabs, several of which were the same screen under two names —
 * "Customer Experience" and "Coach Branding" showed an identical set of four
 * panels, because every one of them was classed onto both. These six are what
 * is left once each panel is filed once.
 *
 * Missing on purpose: Payments. Invoicing defaults, tax and payment terms all
 * live inside the Account panel today, and pulling them out is a job
 * about that panel rather than about the filing.
 */
/**
 * A collapsible settings group.
 *
 * Settings used to show everything at once: eleven tabs, and every panel on the
 * open one expanded. Six sections fixed half of that; this fixes the rest.
 *
 * The header holds a title and a caret and nothing else — no summary line, no
 * count. A count in a header is information you cannot act on, placed where you
 * click, and it makes every header a different width.
 *
 * `inert` while closed is the part that is easy to leave out and expensive to
 * omit: without it a collapsed Account section keeps a tabbable Change
 * Password, Export and Close account in the DOM, so a keyboard user tabs
 * through controls nobody can see.
 */
const SettingsGroupContext = createContext<{
  openGroup: string;
  setOpenGroup: (id: string) => void;
  /** When set, only this group renders — see SettingsGroups. */
  focusOnly: string;
  /** The open tab. A group filed under another tab is not mounted at all. */
  activeTab: string;
} | null>(null);

export function SettingsGroups({
  children,
  requestedGroup = "",
  focusOnly = "",
  activeTab = "",
}: {
  children: ReactNode;
  requestedGroup?: string;
  /**
   * The tab on screen. Every group used to mount on every visit -- fourteen
   * cards, their editors and their DOM -- and the stylesheet hid all but the
   * open tab's. Now a group filed under another tab is simply not rendered,
   * which is most of what made Settings slow to open.
   */
  activeTab?: string;
  /**
   * Render one group and nothing else.
   *
   * Coach profile opens a settings section over itself rather than navigating
   * to it, and what it opens is this same subtree — the real group, with the
   * real editor and the real save. Focusing it here rather than hiding the
   * others in CSS means the overlay mounts one group, not thirty with
   * twenty-nine display:none.
   */
  focusOnly?: string;
}) {
  // One value. Which group is open and which header is highlighted are the same
  // fact, so they cannot disagree.
  const [openGroup, setOpenGroup] = useState("");
  // Coach profile sends a coach here pointed at one card, so the section it
  // named opens on arrival. Everything else still arrives shut - this only
  // fires when somebody asked for a specific group by name.
  useEffect(() => {
    if (requestedGroup) setOpenGroup(requestedGroup);
  }, [requestedGroup]);
  const value = useMemo(() => ({ openGroup, setOpenGroup, focusOnly, activeTab }), [openGroup, focusOnly, activeTab]);
  return <SettingsGroupContext.Provider value={value}>{children}</SettingsGroupContext.Provider>;
}

/**
 * The settings screen, as a page or as an overlay over whatever you were doing.
 *
 * Coach profile files the workspace by job ("lessons into my diary"); Settings
 * files it by category (Business, Booking, Notifications) and Billing by its
 * own sections. Two indexes, one filing cabinet — so opening a section from the
 * profile must not be a second copy of that section. It is this same subtree,
 * mounted in a modal instead of a page, with the same editors and the same save.
 */
export function WorkspaceSurface({
  overlay,
  title,
  pageClassName,
  onClose,
  children,
}: {
  overlay: boolean;
  /** What the overlay says it is showing, in the coach's words. */
  title: string;
  /** The class this surface wears as a page — settings-page or billing-page. */
  pageClassName: string;
  onClose: () => void;
  children: ReactNode;
}) {
  // Escape closes, like every other dismissable layer in the app.
  useEffect(() => {
    if (!overlay) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay, onClose]);

  if (!overlay) return <section className={`module-page ${pageClassName}`}>{children}</section>;

  return (
    <div className="workspace-overlay" role="dialog" aria-modal="true" aria-label={title}>
      {/* Clicking the backdrop closes. The dialog itself stops the click, so a
          drag that ends outside a field does not dismiss an unsaved edit. */}
      <div className="workspace-overlay-scrim" onClick={onClose} />
      <div className="workspace-overlay-panel">
        <header className="workspace-overlay-head">
          <div>
            <span>{t("Settings")}</span>
            <strong>{title}</strong>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label={t("Close settings")}>
            <X size={18} />
          </button>
        </header>
        <div className={`workspace-overlay-body ${pageClassName}`}>{children}</div>
      </div>
    </div>
  );
}

export function SettingsGroup({
  id,
  section,
  title,
  icon: Icon,
  className = "",
  children,
}: {
  id: string;
  section: string;
  title: string;
  icon: IconComponent;
  className?: string;
  children: ReactNode;
}) {
  const context = useContext(SettingsGroupContext);
  // A focused mount is one section on its own, so the others are not rendered
  // at all rather than rendered and hidden.
  if (context?.focusOnly && context.focusOnly !== id) return null;
  // Filed under a tab that is not open: not mounted, rather than mounted and
  // hidden. The focused case above wins, because an overlay opens one group
  // by name whatever tab was last on screen.
  if (context && !context.focusOnly && context.activeTab && context.activeTab !== section) return null;
  // Every section arrives shut. A tab that opens with one section already
  // expanded pushes the rest below the fold and makes that one look like the
  // screen rather than one choice among several. The exception is a section
  // opened on its own: it is the only thing there, so a collapsed header would
  // just be a second click on the thing already asked for.
  const open = context ? context.focusOnly === id || context.openGroup === id : true;
  return (
    <article
      className={`data-card settings-section settings-${section} settings-group${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}
    >
      <button
        className="settings-group-header"
        aria-expanded={open}
        onClick={() => context?.setOpenGroup(open ? "" : id)}
        type="button"
      >
        <span className="settings-group-title">
          <Icon size={18} />
          {title}
        </span>
        <span className="settings-group-caret" aria-hidden="true">▾</span>
      </button>
      <div className={`disclosure-wrap${open ? " is-open" : ""}`} inert={!open}>
        <div className="disclosure-body settings-group-body">{children}</div>
      </div>
    </article>
  );
}

/**
 * The sub-nav, as data.
 *
 * One list drives the rows, the highlight and the admin gating, so a section
 * cannot exist in the nav and nowhere else — which is how "Customer
 * Experience" and "Coach Branding" both survived pointing at the same panels.
 */
export const SETTINGS_SECTIONS: Array<{
  key: Exclude<SettingsTab, "none">;
  label: string;
  icon: IconComponent;
  adminOnly?: boolean;
  /** Platform staff only. Not a business owner, however senior. */
  platformOnly?: boolean;
}> = [
  { key: "business", label: t("Business"), icon: ClarityFacilitiesRooms, adminOnly: true },
  { key: "booking", label: t("Booking"), icon: ClarityCalendar },
  { key: "services", label: t("Lesson types"), icon: ClarityServices },
  { key: "practice", label: t("Practice"), icon: ClarityLessonsProgrammes },
  // Two questions, two sections. Notifications is "what do we say" — the
  // wording of every client-facing message, in one place. Email / SMS is "how
  // do we send it" — addresses, provider wiring and send rules. They used to be
  // one tab holding four cards, two of which were both called a template.
  { key: "notifications", label: t("Notifications"), icon: ClarityNotifications, adminOnly: true },
  { key: "email-sms", label: t("Email / SMS"), icon: ClarityEmail, adminOnly: true },
  { key: "account", label: t("Account"), icon: ClarityProfile, adminOnly: true },
  // Two lists, two questions. Integrations is "what have I plugged in" — the
  // coach's own accounts. Admin is "what is this software made of" — the
  // services Clarity runs on, which a coach never picks.
  { key: "developer", label: t("Integrations"), icon: ClarityIntegrations, adminOnly: true },
  // The other direction: not what this business has plugged in, but what may
  // plug into it -- API keys and webhooks for other software.
  { key: "api", label: t("API & webhooks"), icon: Webhook, adminOnly: true },
  // Platform-only, not account-admin. Its own description says these are "the
  // services Clarity itself runs on, not things a coach picks" -- shared
  // infrastructure whose state belongs to the platform, not to any one
  // business. Gated on adminOnly it was visible to every business owner, so a
  // brand new workspace could see the platform's Resend, Drive and Stripe
  // wiring and read another business's Google connection as its own.
  { key: "admin", label: t("Admin"), icon: ClarityAdmin, platformOnly: true },
  // Last on purpose. It is the one section that is not about configuring this
  // business -- it is about standing up a second, disposable copy of it.
  { key: "sandbox", label: t("Sandbox"), icon: FlaskConical, adminOnly: true },
];

export type SettingsTab =
  | "none"
  | "business"
  | "booking"
  | "services"
  | "practice"
  | "notifications"
  | "email-sms"
  | "account"
  | "developer"
  | "api"
  | "admin"
  | "sandbox";
