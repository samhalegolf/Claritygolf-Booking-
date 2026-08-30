// The Coach profile: who the coach is, and everything Clarity is plugged into
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

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Link2,
  Plus,
  Settings as SettingsIcon,
} from "lucide-react";

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

export type CoachProfileIdentity = {
  coachName: string;
  businessName: string;
  venueName: string;
  roleLabel: string;
  email: string;
  phone: string;
  timezone: string;
  currency: string;
};

// The integration list's own shape. Only the fields this screen reads.
type IntegrationCard = {
  id: string;
  label: string;
  category: string;
  summary: string;
  configured: boolean;
  needsAuthorisation: boolean;
  connectedAs?: string;
  connectionError?: string;
};

/**
 * The job a connection does, which is how somebody arrives here: "I want my
 * lessons in my diary", not "I want to configure an OAuth2 connection". Same
 * vocabulary as IntegrationsPanel's CATEGORY_LABEL.
 */
const JOB_BY_CATEGORY: Record<string, string> = {
  calendar: "Calendar",
  "resource-booking": "Resource booking",
  accounting: "Bank feed",
  payments: "Payments",
  storage: "Cloud storage",
  email: "Email delivery",
  billing: "Billing account",
  "clarity-apps": "Clarity apps",
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

/** The placeholder mark a not-yet-connected provider wears. */
function providerInitial(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return words.length === 1 ? words[0].slice(0, 2) : words.map((word) => word[0]).join("").slice(0, 2);
}

export type CoachProfilePanelProps = {
  identity: CoachProfileIdentity;
  /** Clarity's own settings, with facts read from live workspace state. */
  internalJobs: ProfileInternalJob[];
  onOpen: (target: ProfileTarget) => void;
};

export function CoachProfilePanel({ identity, internalJobs, onOpen }: CoachProfilePanelProps) {
  const [cards, setCards] = useState<IntegrationCard[] | null>(null);
  const [error, setError] = useState("");
  const [openDetail, setOpenDetail] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/integration-setup?audience=integration", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || payload?.error || `Connections returned ${response.status}.`);
      setCards(payload.integrations || []);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your connections could not be loaded.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const initials =
    identity.coachName
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?";

  // Sections hold external connections and internal settings together: a coach
  // looking for "how do lessons reach my diary" should not have to know which
  // of the two answers it.
  const sections = SECTION_ORDER.map((name) => ({
    name,
    external: (cards || []).filter((card) => (SECTION_BY_CATEGORY[card.category] || "Accounting") === name),
    internal: internalJobs.filter((job) => job.category === name),
  })).filter((section) => section.external.length || section.internal.length);

  function detailToggle(id: string, hasFacts: boolean) {
    const open = openDetail === id;
    return (
      <button
        className="cp-detail-toggle"
        onClick={() => setOpenDetail(open ? "" : id)}
        disabled={!hasFacts}
        aria-expanded={open}
        title={hasFacts ? (open ? "Hide detail" : "Show detail") : "Nothing to show yet"}
        type="button"
      >
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
    );
  }

  function facts(id: string, list: Array<[string, string]>, path: string) {
    if (openDetail !== id) return null;
    return (
      <div className="cp-facts">
        {list.map(([key, value]) => (
          <div className="cp-fact" key={key}>
            <span>{key}</span>
            <span>{value}</span>
          </div>
        ))}
        <p className="cp-fact-path">
          <SettingsIcon size={14} />
          {path}
        </p>
      </div>
    );
  }

  return (
    <div className="coach-profile">
      <article className="cp-identity">
        <span className="cp-avatar" aria-hidden="true">
          {initials}
        </span>
        <div className="cp-identity-main">
          <div className="cp-identity-name">
            <strong>{identity.coachName || "Your name"}</strong>
            <span className="cp-role">{identity.roleLabel}</span>
          </div>
          <p className="cp-identity-where">
            {[identity.businessName, identity.venueName].filter(Boolean).join(" · ") || "Set your business in Settings › Business"}
          </p>
          <div className="cp-identity-facts">
            {(
              [
                ["Email", identity.email],
                ["Phone", identity.phone],
                ["Timezone", identity.timezone],
                ["Currency", identity.currency],
              ] as Array<[string, string]>
            ).map(([key, value]) => (
              <div key={key}>
                <span>{key}</span>
                <strong>{value || "Not set"}</strong>
              </div>
            ))}
          </div>
        </div>
        <button
          className="cp-gear"
          onClick={() => onOpen({ kind: "settings", tab: "account", group: "coach-account" })}
          title="Settings › Account"
          type="button"
        >
          <SettingsIcon size={16} />
        </button>
      </article>

      {error && (
        <div className="cp-error" role="alert">
          <strong>Your connections are unavailable</strong>
          {error}
          <button className="text-button" onClick={() => void load()} type="button">
            Try again
          </button>
        </div>
      )}

      <div className="cp-sections">
        {sections.map((section) => (
          <section className="cp-section" key={section.name}>
            <h3>{section.name}</h3>

            {section.external.map((card) => {
              const state = stateOf(card);
              const connected = state !== "unset";
              const job = JOB_BY_CATEGORY[card.category] || section.name;
              // Before it exists the card is the job; once it exists the
              // provider's own name is the more useful label.
              const title = connected ? card.label : job;
              const detail: Array<[string, string]> = [
                ["Provider", card.label],
                ["Status", card.connectedAs ? `Connected · ${card.connectedAs}` : connected ? "Ready" : "Not set up"],
              ];
              return (
                <article className="cp-cell" key={card.id}>
                  <div className="cp-cell-head">
                    {connected ? (
                      <span className={`cp-mark is-${state}`} title={`${card.label} logo`}>
                        {providerInitial(card.label)}
                      </span>
                    ) : (
                      <span className="cp-mark is-placeholder" title={card.label}>
                        {providerInitial(card.label)}
                      </span>
                    )}
                    <span className="cp-cell-title">
                      <strong>{title}</strong>
                      <span className="cp-external" title="An outside account, connected to Clarity">
                        <Link2 size={14} />
                      </span>
                    </span>
                    <span className="cp-cell-actions">
                      {connected && detailToggle(card.id, true)}
                      {state === "ok" && (
                        <span className="cp-chip is-ok" title="Connected and healthy">
                          <Link2 size={15} />
                        </span>
                      )}
                      {state === "bad" && (
                        <span className="cp-chip is-bad" title="Needs attention">
                          <AlertCircle size={15} />
                        </span>
                      )}
                      {connected ? (
                        <button
                          className="cp-gear"
                          onClick={() => onOpen(INTEGRATION_TARGET)}
                          title={`Manage — Settings › Integrations › ${card.label}`}
                          type="button"
                        >
                          <SettingsIcon size={16} />
                        </button>
                      ) : (
                        <button
                          className="cp-setup"
                          onClick={() => onOpen(INTEGRATION_TARGET)}
                          title={`Set up ${job}`}
                          type="button"
                        >
                          <Plus size={16} />
                        </button>
                      )}
                    </span>
                  </div>
                  <p className="cp-cell-summary">{card.summary}</p>
                  {/* The point of the failing state is the sentence, not the
                      colour: what actually broke, in the coach's words. */}
                  {state === "bad" && <p className="cp-cell-error">{card.connectionError}</p>}
                  {facts(card.id, detail, "Settings › Integrations")}
                </article>
              );
            })}

            {section.internal.map((job) => (
              <article className="cp-cell" key={job.id}>
                <div className="cp-cell-head">
                  <span className="cp-cell-title">
                    <strong>{job.label}</strong>
                  </span>
                  <span className="cp-cell-actions">
                    {detailToggle(job.id, job.facts.length > 0)}
                    <button className="cp-gear" onClick={() => onOpen(job.target)} title={`Manage — ${job.path}`} type="button">
                      <SettingsIcon size={16} />
                    </button>
                  </span>
                </div>
                <p className="cp-cell-summary">{job.summary}</p>
                {facts(job.id, job.facts, job.path)}
              </article>
            ))}
          </section>
        ))}
      </div>

      {!cards && !error && <p className="inline-working">Loading your connections…</p>}
    </div>
  );
}
