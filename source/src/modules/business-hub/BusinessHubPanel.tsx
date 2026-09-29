// The Business Hub: who the coach is, and everything Clarity is plugged into
// on their behalf, on one screen.
//
// It is a map, not a second Settings. Every card routes to the screen that
// already owns that setting — so there is still exactly one place each thing is
// edited, and this screen can never disagree with it about what is configured.
//
// Two kinds of card sit side by side:
//
//   External — somebody else's account (Google, Optix, Stripe, Akahu, Drive).
//     Only these have a not-set-up state, because only these can be absent.
//     Before one is connected the card is the JOB, not the brand: "Calendar",
//     not "Google Calendar", with the providers Clarity has code for shown as
//     small placeholder marks. Once connected, the provider's own name does the
//     identifying. Status comes from /api/integration-setup — the same endpoint
//     Settings › Integrations reads, so the two cannot drift.
//
//   Internal — Clarity's own settings. They always exist, so a card opens to
//     show what it currently says and the gear goes to where it is changed.

import { useEffect, useState, type ReactNode } from "react";
import { integrationsStore, type IntegrationCard } from "../integrations/integrationsStore";
import { AlertCircle, ChevronDown, ChevronUp, Phone, Plus } from "lucide-react";
import {
  ClarityBookingPages,
  ClarityCalendar,
  ClarityClientsPlayers,
  ClarityEmail,
  ClarityFilesMedia,
  ClarityIntegrations,
  ClarityInvoices,
  ClarityLessonsProgrammes,
  ClarityLocations,
  ClarityMessages,
  ClarityNotifications,
  ClarityPayments,
  ClarityPlayerPortal,
  ClarityPreferences,
  ClarityProducts,
  ClarityProfile,
  ClarityResources,
  ClaritySettings,
  ClarityVideoAnalysis,
  type IconComponent,
} from "../shared/ClarityIcons";
import { t } from "../../lib/i18n";

/** Where a card sends you. The profile owns no forms of its own. */
export type ProfileTarget =
  | { kind: "settings"; tab: string; group?: string }
  | { kind: "billing"; section: string }
  | { kind: "view"; view: string };

/** One of Clarity's own settings, resolved from live workspace state. */
export type ProfileInternalJob = {
  id: string;
  category: string;
  /** An optional band within a category — "Notifications" inside Customer experience. */
  sub?: string;
  label: string;
  summary: string;
  /** Where it lives, written the way the coach would say it. */
  path: string;
  target: ProfileTarget;
  facts: Array<[string, string]>;
};

export type BusinessHubIdentity = {
  coachName: string;
  roleLabel: string;
  email: string;
  phone: string;
};

/**
 * The top of the hub for an owner who runs the business without a coach
 * profile of their own. Anyone who coaches gets CoachProfilePanel instead.
 */
export function OwnerIdentityCard({
  identity,
  onOpenCoaches,
}: {
  identity: BusinessHubIdentity;
  onOpenCoaches: () => void;
}) {
  const initials =
    identity.coachName
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?";
  return (
    <article className="bh-identity">
      <span className="bh-avatar" aria-hidden="true">
        {initials}
      </span>
      <div className="bh-identity-main">
        <div className="bh-identity-name">
          <strong>{identity.coachName || t("Your name")}</strong>
          <span className="bh-role">{identity.roleLabel}</span>
        </div>
        <div className="bh-identity-facts">
          {(
            [
              [t("Email"), identity.email, ClarityEmail],
              [t("Phone"), identity.phone, Phone],
            ] as Array<[string, string, IconComponent]>
          ).map(([key, value, Icon]) => (
            <div key={key}>
              <span>
                <Icon size={14} />
                {key}
              </span>
              <strong>{value || t("Not set")}</strong>
            </div>
          ))}
        </div>
      </div>
      <button className="bh-gear" onClick={onOpenCoaches} title={t("Settings › Business › Coaches")} type="button">
        <ClaritySettings size={16} />
      </button>
    </article>
  );
}

/**
 * The job a connection does, which is how somebody arrives here: "I want my
 * lessons in my diary", not "I want to configure an OAuth2 connection". Same
 * vocabulary as IntegrationsPanel's CATEGORY_LABEL.
 */
const JOB_BY_CATEGORY: Record<string, string> = {
  calendar: t("Calendar"),
  "resource-booking": t("Resource booking"),
  accounting: t("Bank feed"),
  payments: t("Payments"),
  storage: t("Cloud storage"),
  email: t("Email delivery"),
  billing: t("Billing account"),
  "clarity-apps": t("Clarity apps"),
};

/** Which section of the page a connection files under. */
const SECTION_BY_CATEGORY: Record<string, string> = {
  calendar: "Calendar",
  "resource-booking": "Resource booking",
  storage: "Storage",
  accounting: "Accounting",
  payments: "Accounting",
  billing: "Accounting",
  email: "Customer experience",
  "clarity-apps": "Storage",
};

/** The order the sections read in, rather than alphabetical by accident. */
const SECTION_ORDER = [
  "Calendar",
  "Resource booking",
  "Storage",
  "Accounting",
  "Customer experience",
  "Player portal",
];

/** The section names as they read on screen. The keys above stay English. */
const SECTION_LABELS: Record<string, string> = {
  Calendar: t("Calendar"),
  "Resource booking": t("Resource booking"),
  Storage: t("Storage"),
  Accounting: t("Accounting"),
  "Customer experience": t("Customer experience"),
  "Player portal": t("Player portal"),
};

const SECTION_ICONS: Record<string, IconComponent> = {
  Calendar: ClarityCalendar,
  "Resource booking": ClarityResources,
  Storage: ClarityFilesMedia,
  Accounting: ClarityPayments,
  "Customer experience": ClarityNotifications,
  "Player portal": ClarityPlayerPortal,
};

function SectionTitle({ name }: { name: string }) {
  const Icon = SECTION_ICONS[name];
  return (
    <h3>
      {Icon ? <Icon size={14} /> : null}
      {SECTION_LABELS[name] || name}
    </h3>
  );
}

/** The icon each of Clarity's own settings wears, keyed by ProfileInternalJob id. */
const INTERNAL_JOB_ICONS: Record<string, IconComponent> = {
  "lesson-types": ClarityLessonsProgrammes,
  locations: ClarityLocations,
  "booking-page": ClarityBookingPages,
  "coach-branding": ClarityPreferences,
  "email-notifications": ClarityEmail,
  "notification-templates": ClarityNotifications,
  "sms-notifications": ClarityMessages,
  invoicing: ClarityInvoices,
  products: ClarityProducts,
  clients: ClarityClientsPlayers,
  players: ClarityProfile,
  video: ClarityVideoAnalysis,
  practice: ClarityCalendar,
};

const EXTERNAL_SECTION_JOBS: Record<string, string> = {
  Calendar: t("Calendar"),
  "Resource booking": t("Resource booking"),
  Storage: t("Cloud storage"),
  Accounting: t("Payments & accounting"),
};

/** Where a connection is set up. One destination: Settings › Integrations. */
const INTEGRATION_TARGET: ProfileTarget = { kind: "settings", tab: "developer" };

type CardState = "ok" | "bad" | "unset" | "internal";

function stateOf(card: IntegrationCard): CardState {
  // A recorded error outranks "configured" — a connection that is set up and
  // failing is the one worth knowing about, and it would otherwise read as fine.
  if (card.connectionError) return "bad";
  if (!card.configured) return "unset";
  return "ok";
}

/**
 * The providers we hold a mark for, keyed by integration id — which is also the
 * filename, so there is no mapping table to drift from the catalogue.
 *
 * An id not listed here keeps its initials rather than requesting a file that
 * is not there: a 404 renders as a broken image, which looks like a bug rather
 * than like an integration nobody has drawn yet.
 */
const PROVIDER_LOGOS = new Set(["google-calendar", "google-drive", "optix", "stripe", "akahu"]);

/** The placeholder mark a not-yet-connected provider wears. */
function providerInitial(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return words.length === 1 ? words[0].slice(0, 2) : words.map((word) => word[0]).join("").slice(0, 2);
}

export type BusinessHubPanelProps = {
  /** Who this hub belongs to: the coach profile, or OwnerIdentityCard for an owner who does not coach. */
  profile: ReactNode;
  /** Clarity's own settings, with facts read from live workspace state. */
  internalJobs: ProfileInternalJob[];
  /** `label` is what the card is called, so an overlay can name itself. */
  onOpen: (target: ProfileTarget, label: string) => void;
  /** Connections shown elsewhere on the hub (your Google Calendar is on your profile). */
  hiddenIntegrationIds?: string[];
};

export function BusinessHubPanel({ profile, internalJobs, onOpen, hiddenIntegrationIds = [] }: BusinessHubPanelProps) {
  // One shared integration resource for the whole workspace. Settings and the
  // profile now join the same in-flight request and reuse the same cached
  // snapshot instead of mounting their own independent fetch lifecycle.
  const store = integrationsStore("integration");
  const { items: allCards, status: connectionsStatus, error } = store.useState();
  const cards = allCards.filter((card) => !hiddenIntegrationIds.includes(card.id));
  const [openDetail, setOpenDetail] = useState("");

  useEffect(() => {
    // Accept the workspace's idle/navigation prefetch when it is recent. If the
    // profile wins the race, this starts the same deduped request itself.
    void store.load({ maxAgeMs: 30_000 }).catch(() => undefined);
  }, [store]);

  // Sections hold external connections and internal settings together: a coach
  // looking for "how do lessons reach my diary" should not have to know which
  // of the two answers it.
  const sections = SECTION_ORDER.map((name) => ({
    name,
    external: cards.filter((card) => (SECTION_BY_CATEGORY[card.category] || "Accounting") === name),
    internal: internalJobs.filter((job) => job.category === name),
  })).filter(
    (section) =>
      section.external.length ||
      section.internal.length ||
      (connectionsStatus !== "loaded" && Boolean(EXTERNAL_SECTION_JOBS[section.name])),
  );

  function detailToggle(id: string, hasFacts: boolean) {
    const open = openDetail === id;
    return (
      <button
        className="bh-detail-toggle"
        onClick={() => setOpenDetail(open ? "" : id)}
        disabled={!hasFacts}
        aria-expanded={open}
        title={hasFacts ? (open ? t("Hide detail") : t("Show detail")) : t("Nothing to show yet")}
        type="button"
      >
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
    );
  }

  function facts(id: string, list: Array<[string, string]>, path: string) {
    if (openDetail !== id) return null;
    return (
      <div className="bh-facts">
        {list.map(([key, value]) => (
          <div className="bh-fact" key={key}>
            <span>{key}</span>
            <span>{value}</span>
          </div>
        ))}
        <p className="bh-fact-path">
          <ClaritySettings size={14} />
          {path}
        </p>
      </div>
    );
  }

  return (
    <div className="business-hub">
      {profile}

      {error && (
        <div className="bh-error" role="alert">
          <strong>{t("Your connections are unavailable")}</strong>
          {error}
          <button className="text-button" onClick={() => void store.load().catch(() => undefined)} type="button">{t("Try again")}</button>
        </div>
      )}

      <div className="bh-sections">
        {sections.map((section) => (
          <section className="bh-section" key={section.name}>
            <SectionTitle name={section.name} />

            {connectionsStatus !== "loaded" && section.external.length === 0 && EXTERNAL_SECTION_JOBS[section.name] ? (
              <article className="bh-cell bh-cell-pending" aria-busy="true">
                <div className="bh-cell-head">
                  <span className="bh-mark is-placeholder">…</span>
                  <span className="bh-cell-title">
                    <strong>{EXTERNAL_SECTION_JOBS[section.name]}</strong>
                    <span className="bh-external" title={t("External connection")}>
                      <ClarityIntegrations size={14} />
                    </span>
                  </span>
                </div>
                <p className="bh-cell-summary">{t("Checking connection…")}</p>
              </article>
            ) : null}

            {section.external.map((card) => {
              const state = stateOf(card);
              const connected = state !== "unset";
              const job = JOB_BY_CATEGORY[card.category] || SECTION_LABELS[section.name] || section.name;
              // Before it exists the card is the job; once it exists the
              // provider's own name is the more useful label.
              const title = connected ? card.label : job;
              const detail: Array<[string, string]> = [
                [t("Provider"), card.label],
                [t("Status"), card.connectedAs ? t("Connected · {connectedAs}", { connectedAs: card.connectedAs }) : connected ? t("Ready") : t("Not set up")],
              ];
              return (
                <article className="bh-cell" key={card.id}>
                  <div className="bh-cell-head">
                    {/* Connected: the provider's own mark identifies it. Not
                        connected: initials in a dashed box, because the card is
                        the job at that point ("Calendar", not "Google
                        Calendar") and a full-colour logo would advertise a
                        connection that does not exist. */}
                    {connected && PROVIDER_LOGOS.has(card.id) ? (
                      <span className="bh-mark is-logo" title={card.label}>
                        <img src={`/assets/integrations/${card.id}.svg`} alt="" />
                      </span>
                    ) : (
                      <span className={`bh-mark${connected ? "" : " is-placeholder"}`} title={card.label}>
                        {providerInitial(card.label)}
                      </span>
                    )}
                    <span className="bh-cell-title">
                      <strong>{title}</strong>
                      <span className="bh-external" title={t("An outside account, connected to Clarity")}>
                        <ClarityIntegrations size={14} />
                      </span>
                    </span>
                    <span className="bh-cell-actions">
                      {connected && detailToggle(card.id, true)}
                      {state === "ok" && (
                        <span className="bh-chip is-ok" title={t("Connected and healthy")}>
                          <ClarityIntegrations size={15} />
                        </span>
                      )}
                      {state === "bad" && (
                        <span className="bh-chip is-bad" title={t("Needs attention")}>
                          <AlertCircle size={15} />
                        </span>
                      )}
                      {connected ? (
                        <button
                          className="bh-gear"
                          onClick={() => onOpen(INTEGRATION_TARGET, card.label)}
                          title={t("Manage — Settings › Integrations › {label}", { label: card.label })}
                          type="button"
                        >
                          <ClaritySettings size={16} />
                        </button>
                      ) : (
                        <button
                          className="bh-setup"
                          onClick={() => onOpen(INTEGRATION_TARGET, job)}
                          title={t("Set up {job}", { job })}
                          type="button"
                        >
                          <Plus size={16} />
                        </button>
                      )}
                    </span>
                  </div>
                  <p className="bh-cell-summary">{card.summary}</p>
                  {/* The point of the failing state is the sentence, not the
                      colour: what actually broke, in the coach's words. */}
                  {state === "bad" && <p className="bh-cell-error">{card.connectionError}</p>}
                  {facts(card.id, detail, t("Settings › Integrations"))}
                </article>
              );
            })}

            {section.internal.map((job) => (
              <article className="bh-cell" key={job.id}>
                <div className="bh-cell-head">
                  {(() => {
                    const Icon = INTERNAL_JOB_ICONS[job.id];
                    return Icon ? (
                      <span className="bh-job-icon" aria-hidden="true">
                        <Icon size={18} />
                      </span>
                    ) : null;
                  })()}
                  <span className="bh-cell-title">
                    <strong>{job.label}</strong>
                  </span>
                  <span className="bh-cell-actions">
                    {detailToggle(job.id, job.facts.length > 0)}
                    <button className="bh-gear" onClick={() => onOpen(job.target, job.label)} title={t("Manage — {path}", { path: job.path })} type="button">
                      <ClaritySettings size={16} />
                    </button>
                  </span>
                </div>
                <p className="bh-cell-summary">{job.summary}</p>
                {facts(job.id, job.facts, job.path)}
              </article>
            ))}
          </section>
        ))}
      </div>

    </div>
  );
}
