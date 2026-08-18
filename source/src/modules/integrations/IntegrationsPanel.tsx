import { useCallback, useEffect, useState } from "react";

import IntegrationPanel from "./IntegrationPanel";

/**
 * Settings › Integrations — the list, and one connection behind each card.
 *
 * The list comes first because the question a coach actually has is "what is
 * Clarity talking to?", and that question has one answer. Six integrations ship
 * today and five of them had no screen at all: they were environment variables,
 * set by editing the deployment, with nothing anywhere saying whether they were
 * configured, working, or subtly wrong.
 *
 * Both connect methods live in one list on purpose. Google is OAuth and Optix
 * is pasted secrets, and an earlier pass split those into different sections on
 * exactly that difference. Splitting by *how you connect* answers a question
 * nobody asks; the click-to-connect ones simply sort first, because those are
 * the ones a coach will touch.
 */

type Card = {
  id: string;
  label: string;
  category: string;
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
  bookings: "Bookings",
  payments: "Payments",
  email: "Email",
  banking: "Banking",
  storage: "Storage",
  internal: "Clarity apps",
};

function statusOf(card: Card) {
  // A recorded error outranks "configured". An integration that is connected
  // and failing is the one worth knowing about, and it used to read as fine.
  if (card.connectionError) return { tone: "bad", label: "Needs attention" };
  if (!card.configured) return { tone: "unset", label: "Not set up" };
  if (card.needsAuthorisation) return { tone: "ok", label: card.connectedAs ? `Connected · ${card.connectedAs}` : "Connected" };
  return { tone: "ok", label: "Ready" };
}

export default function IntegrationsPanel() {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string>("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/integration-setup", { credentials: "same-origin", cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || payload?.error || `Integrations returned ${response.status}.`);
      setCards(payload.integrations || []);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The integrations list could not load.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (open) {
    const card = cards?.find((entry) => entry.id === open);
    return (
      <article className="data-card settings-section settings-developer integration-panel">
        <div className="integration-breadcrumb">
          <button className="text-button" onClick={() => setOpen("")} type="button">← Integrations</button>
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

  return (
    <article className="data-card settings-section settings-developer integration-panel">
      <header className="integration-header">
        <div>
          <span>Connections</span>
          <h2>Integrations</h2>
          <p>What Clarity is talking to.</p>
        </div>
      </header>

      <div className="integration-body">
        {error ? <div className="integration-error"><strong>The list is unavailable</strong>{error}</div> : null}
        {!cards && !error ? <p className="inline-working">Loading…</p> : null}

        <div className="integration-cards">
          {sort(configured).map((card) => {
            const status = statusOf(card);
            return (
              <button className="integration-card" key={card.id} onClick={() => setOpen(card.id)} type="button">
                <span className={`integration-card-dot is-${status.tone}`} aria-hidden="true" />
                <strong>{card.label}</strong>
                <em>{CATEGORY_LABEL[card.category] || card.category}</em>
                <span className="integration-card-status">{status.label}</span>
              </button>
            );
          })}

          {available.length ? (
            <button className="integration-card is-add" onClick={() => setAdding((current) => !current)} type="button">
              <strong>+ New integration</strong>
              <em>{available.length} available</em>
            </button>
          ) : null}
        </div>

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
            <div className="integration-cards">
              {sort(available).map((card) => (
                <button className="integration-card" key={card.id} onClick={() => setOpen(card.id)} type="button">
                  <span className="integration-card-dot is-unset" aria-hidden="true" />
                  <strong>{card.label}</strong>
                  <em>{CATEGORY_LABEL[card.category] || card.category}</em>
                  <span className="integration-card-status">
                    {card.missing.length} {card.missing.length === 1 ? "field" : "fields"} to set
                  </span>
                </button>
              ))}
            </div>
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
