import { Loading } from "../shared/Loading";
import { useEffect, useState } from "react";

import IntegrationPanel from "./IntegrationPanel";
import { integrationsStore, type IntegrationCard as Card } from "./integrationsStore";
import { t } from "../../lib/i18n";

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

/** Click-to-connect first, then the rest — easiest effort at the top. */
const KIND_ORDER: Record<string, number> = { oauth2: 0, "api-key-pair": 1, "api-token": 2, "webhook-in": 3, "service-link": 4 };

const CATEGORY_LABEL: Record<string, string> = {
  calendar: t("Calendar"),
  "resource-booking": t("Resource booking"),
  accounting: t("Accounting"),
  payments: t("Payments"),
  email: t("Email"),
  storage: t("Storage"),
  billing: t("Billing"),
  "clarity-apps": t("Clarity apps"),
};

/** The order categories read in, rather than alphabetical by accident. */
const CATEGORY_ORDER = [
  "calendar", "resource-booking", "accounting", "payments",
  "email", "storage", "billing", "clarity-apps",
];

const COPY = {
  integration: {
    eyebrow: t("Connections"),
    title: t("Integrations"),
    lead: t("Your own accounts, connected to Clarity."),
    empty: t("Nothing connected yet."),
    add: t("+ New integration"),
  },
  admin: {
    eyebrow: t("Platform"),
    title: t("Admin"),
    lead: t("The services Clarity itself runs on. Not things a coach picks."),
    empty: t("Nothing configured."),
    add: t("+ Show unconfigured"),
  },
};

function statusOf(card: Card) {
  // A recorded error outranks "configured". An integration that is connected
  // and failing is the one worth knowing about, and it used to read as fine.
  if (card.connectionError) return { tone: "bad", label: t("Needs attention") };
  if (!card.configured) return { tone: "unset", label: t("Not set up") };
  if (card.needsAuthorisation) return { tone: "ok", label: card.connectedAs ? t("Connected · {connectedAs}", { connectedAs: card.connectedAs }) : t("Connected") };
  return { tone: "ok", label: t("Ready") };
}

export default function IntegrationsPanel({
  audience = "integration",
}: {
  audience?: "admin" | "integration";
}) {
  const copy = COPY[audience];
  const store = integrationsStore(audience);
  const { items: cards, status, error } = store.useState();
  const loading = status === "idle" || status === "loading";
  const [open, setOpen] = useState<string>("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    // Usually already answered: the workspace warms this list in an idle
    // moment after the calendar paints, and a list from the last half minute
    // is not asked for again.
    void store.load({ maxAgeMs: 30_000 }).catch(() => undefined);
  }, [store]);

  if (open) {
    const card = cards.find((entry) => entry.id === open);
    return (
      <article className={`data-card settings-section settings-${audience === "admin" ? "admin" : "developer"} integration-panel`}>
        <div className="integration-breadcrumb">
          <button
            className="text-button"
            onClick={() => {
              setOpen("");
              // Whatever was just connected or changed should show on the card.
              void store.load().catch(() => undefined);
            }}
            type="button"
          >
            ← {copy.title}
          </button>
          <strong>{card?.label || open}</strong>
        </div>
        <IntegrationPanel integrationId={open} />
      </article>
    );
  }

  const configured = cards.filter((card) => card.configured);
  const available = cards.filter((card) => !card.configured);
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
        {error ? <div className="integration-error"><strong>{t("The list is unavailable")}</strong>{error}</div> : null}
        {loading && !cards.length && !error ? <Loading /> : null}

        {byCategory(configured).map((group) => (
          <section className="integration-group" key={group.category}>
            <h3>{CATEGORY_LABEL[group.category] || group.category}</h3>
            <div className="integration-cards">
              {group.items.map((card) => cardButton(card, statusOf(card)))}
            </div>
          </section>
        ))}

        {!loading && !configured.length && !error ? <p className="integration-cards-note">{copy.empty}</p> : null}

        {available.length ? (
          <div className="integration-cards">
            <button className="integration-card is-add" onClick={() => setAdding((current) => !current)} type="button">
              <strong>{copy.add}</strong>
              <em>{t("{length} available", { length: available.length })}</em>
            </button>
          </div>
        ) : null}

        {adding && available.length ? (
          <>
            <div className="integration-note">
              <strong>{t("What Clarity can already talk to")}</strong>
              <span>{t("Only these. Reading another system's data means knowing what its fields are called, which is code rather than configuration — so this is the honest list, not a form for adding anything. Each one below is live in the product today and configured by environment variable.")}</span>
            </div>
            {byCategory(available).map((group) => (
              <section className="integration-group" key={group.category}>
                <h3>{CATEGORY_LABEL[group.category] || group.category}</h3>
                <div className="integration-cards">
                  {group.items.map((card) =>
                    cardButton(card, {
                      tone: "unset",
                      label: card.missing.length === 1 ? t("1 field to set") : t("{count} fields to set", { count: card.missing.length }),
                    }),
                  )}
                </div>
              </section>
            ))}
          </>
        ) : null}

        {cards.length ? (
          <p className="integration-cards-note">{t("{length} of {length2} set up.", { length: configured.length, length2: cards.length })}{available.length ? t(" The rest work the same way — they just have nothing filled in yet.") : ""}
          </p>
        ) : null}
      </div>
    </article>
  );
}
