import { useCallback, useEffect, useState } from "react";

import IntegrationPanel from "./IntegrationPanel";

/**
 * The connection list — used twice, for two different audiences.
 *
 * Settings › Integrations   what a coach connects: their calendar, their
 *                           range's booking system, their bank.
 * Settings › Admin          what Clarity runs on: the email sender, the video
 *                           storage, the sibling app, the billing account.
 *
 * Both are credentials on a screen, which is why they were one list to begin
 * with. They answer completely different questions: one is "what have I plugged
 * in", the other is "what is this software made of". A coach picks from the
 * first and never needs the second.
 *
 * Within Integrations the grouping is by the JOB — Calendar, Resource booking,
 * Accounting — because "I want my lessons in my diary" is how somebody arrives
 * here, not "I want to configure an OAuth2 connection".
 */

type Card = {
  id: string;
  label: string;
  audience: "admin" | "integration";
  category: string;
  caveat?: string;
  sharesGrantWith?: string;
  summary: string;
  kinds: string[];
  configured: boolean;
  missing: string[];
  needsAuthorisation: boolean;
  /** OAuth only: who is signed in, and whatever last went wrong. */
  connectedAs?: string;
  connectionError?: string;
};

/** Click-to-connect first, then the rest — easiest effort at the top. */
const KIND_ORDER: Record<string, number> = { oauth2: 0, "api-key-pair": 1, "api-token": 2, "webhook-in": 3, "service-link": 4 };

const CATEGORY_LABEL: Record<string, string> = {
  calendar: "Calendar",
  "resource-booking": "Resource booking",
  accounting: "Accounting",
  payments: "Payments",
  email: "Email",
  storage: "Storage",
  billing: "Billing",
  "clarity-apps": "Clarity apps",
};

/** The order categories read in, rather than alphabetical by accident. */
const CATEGORY_ORDER = [
  "calendar", "resource-booking", "accounting", "payments",
  "email", "storage", "billing", "clarity-apps",
];

const COPY = {
  integration: {
    eyebrow: "Connections",
    title: "Integrations",
    lead: "Your own accounts, connected to Clarity.",
    empty: "Nothing connected yet.",
    add: "+ New integration",
  },
  admin: {
    eyebrow: "Platform",
    title: "Admin",
    lead: "The services Clarity itself runs on. Not things a coach picks.",
    empty: "Nothing configured.",
    add: "+ Show unconfigured",
  },
};

function statusOf(card: Card) {
  // A recorded error outranks "configured". An integration that is connected
  // and failing is the one worth knowing about, and it used to read as fine.
  if (card.connectionError) return { tone: "bad", label: "Needs attention" };
  if (!card.configured) return { tone: "unset", label: "Not set up" };
  if (card.needsAuthorisation) return { tone: "ok", label: card.connectedAs ? `Connected · ${card.connectedAs}` : "Connected" };
  return { tone: "ok", label: "Ready" };
}

export default function IntegrationsPanel({
  audience = "integration",
}: {
  audience?: "admin" | "integration";
}) {
  const copy = COPY[audience];
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string>("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/integration-setup?audience=${audience}`, { credentials: "same-origin", cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || payload?.error || `Integrations returned ${response.status}.`);
      setCards(payload.integrations || []);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The list could not load.");
    }
  }, [audience]);

  useEffect(() => { void load(); }, [load]);

  if (open) {
    const card = cards?.find((entry) => entry.id === open);
    return (
      <article className={`data-card settings-section settings-${audience === "admin" ? "admin" : "developer"} integration-panel`}>
        <div className="integration-breadcrumb">
          <button className="text-button" onClick={() => setOpen("")} type="button">← {copy.title}</button>
          <strong>{card?.label || open}</strong>
        </div>
        <IntegrationPanel integrationId={open} />
      </article>
    );
  }

  const configured = (cards || []).filter((card) => card.configured);
  const available = (cards || []).filter((card) => !card.configured);
  const sort = (list: Card[]) =>
    [...list].sort((a, b) => (KIND_ORDER[a.kinds[0]] ?? 9) - (KIND_ORDER[b.kinds[0]] ?? 9) || a.label.localeCompare(b.label));

  /** By job, in reading order. A category with nothing in it is not drawn. */
  const byCategory = (list: Card[]) =>
    CATEGORY_ORDER
      .map((category) => ({ category, items: sort(list.filter((card) => card.category === category)) }))
      .filter((group) => group.items.length);

  const cardButton = (card: Card, status: { tone: string; label: string }) => (
    <button className="integration-card" key={card.id} onClick={() => setOpen(card.id)} type="button">
      <span className={`integration-card-dot is-${status.tone}`} aria-hidden="true" />
      <strong>{card.label}</strong>
      <em>{card.summary}</em>
      <span className="integration-card-status">{status.label}</span>
      {card.sharesGrantWith ? <span className="integration-card-note">Same sign-in as {card.sharesGrantWith}</span> : null}
      {card.caveat ? <span className="integration-card-note is-caveat">{card.caveat}</span> : null}
    </button>
  );

  return (
    <article className={`data-card settings-section settings-${audience === "admin" ? "admin" : "developer"} integration-panel`}>
      <header className="integration-header">
        <div>
          <span>{copy.eyebrow}</span>
          <h2>{copy.title}</h2>
          <p>{copy.lead}</p>
        </div>
      </header>

      <div className="integration-body">
        {error ? <div className="integration-error"><strong>The list is unavailable</strong>{error}</div> : null}
        {!cards && !error ? <p className="inline-working">Loading…</p> : null}

        {byCategory(configured).map((group) => (
          <section className="integration-group" key={group.category}>
            <h3>{CATEGORY_LABEL[group.category] || group.category}</h3>
            <div className="integration-cards">
              {group.items.map((card) => cardButton(card, statusOf(card)))}
            </div>
          </section>
        ))}

        {cards && !configured.length && !error ? <p className="integration-cards-note">{copy.empty}</p> : null}

        {available.length ? (
          <div className="integration-cards">
            <button className="integration-card is-add" onClick={() => setAdding((current) => !current)} type="button">
              <strong>{copy.add}</strong>
              <em>{available.length} available</em>
            </button>
          </div>
        ) : null}

        {adding && available.length ? (
          <>
            <div className="integration-note">
              <strong>What Clarity can already talk to</strong>
              <span>
                Only these. Reading another system's data means knowing what its fields are called, which is code
                rather than configuration — so this is the honest list, not a form for adding anything. Each one
                below is live in the product today and configured by environment variable.
              </span>
            </div>
            {byCategory(available).map((group) => (
              <section className="integration-group" key={group.category}>
                <h3>{CATEGORY_LABEL[group.category] || group.category}</h3>
                <div className="integration-cards">
                  {group.items.map((card) =>
                    cardButton(card, {
                      tone: "unset",
                      label: `${card.missing.length} ${card.missing.length === 1 ? "field" : "fields"} to set`,
                    }),
                  )}
                </div>
              </section>
            ))}
          </>
        ) : null}

        {cards?.length ? (
          <p className="integration-cards-note">
            {configured.length} of {cards.length} set up.
            {available.length ? " The rest work the same way — they just have nothing filled in yet." : ""}
          </p>
        ) : null}
      </div>
    </article>
  );
}
