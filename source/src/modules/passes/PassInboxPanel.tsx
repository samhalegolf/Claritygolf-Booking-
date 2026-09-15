// The Pass Inbox: purchases that have not become entitlements, and
// entitlements that have not found an owner.
//
// Two queues on one screen because they are the same interruption -- somebody
// paid and something is unfinished -- but they are not the same question. The
// first is missing a package (how many credits was this?); the second is
// missing a person. Each row therefore offers exactly one control, and neither
// resolves itself.
//
// Nothing here decides anything. The server suggests a package and says how
// sure it is; pressing the button is what commits it. That split is the point:
// a wrong package issues real, spendable credits for the wrong number of
// lessons and nothing downstream can tell, so the guess is never allowed to be
// the answer.

import { useMemo, useState } from "react";
import { Inbox, Ticket, UserPlus } from "lucide-react";

import { Loading } from "../shared/Loading";

export type PassInboxPurchase = {
  id: string;
  provider: string;
  saleNumber: string;
  itemName: string;
  quantity: number;
  amountCents: number | null;
  currency: string;
  purchasedAt: string;
  buyerName: string;
  buyerEmail: string;
  personId: string;
  personName: string;
  /** "email" is certain, "name" is a good guess, "new" made a client. */
  personLinkSource: string;
  classification: string;
  suggestedTemplateServiceId: string;
  suggestedTemplateName: string;
  suggestionConfidence: "exact" | "close" | "none";
};

export type PassInboxUnassigned = {
  id: string;
  name: string;
  creditsAvailable: number;
  creditsAllocated: number;
  expiresAt: string | null;
  source: string;
  note: string;
  issuedAt: string;
};

export type PassInboxTemplate = { serviceId: string; name: string; credits: number };

export type PassInboxPerson = { id: string; name: string };

export type PassInboxPanelProps = {
  purchases: PassInboxPurchase[];
  unassigned: PassInboxUnassigned[];
  templates: PassInboxTemplate[];
  /** Who an unassigned pass can be handed to. */
  people: PassInboxPerson[];
  loadState: "idle" | "loading" | "loaded" | "error";
  busyId: string;
  onIssue: (purchaseId: string, templateServiceId: string) => void;
  onDismiss: (purchaseId: string) => void;
  onAttach: (passId: string, personId: string) => void;
  onRetry: () => void;
};

function formatWhen(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function formatAmount(cents: number | null, currency: string) {
  if (cents === null || !Number.isFinite(cents)) return "";
  const amount = (cents / 100).toFixed(2);
  return currency ? `${currency} ${amount}` : amount;
}

/* How the buyer came to be attached to the client named beside them.
 *
 * Spelled out rather than left implicit because the three are genuinely
 * different levels of certainty, and the weakest of them -- a name match -- is
 * the one an external sale usually gets. A coach about to hand over five
 * lessons should be able to see that the only thing tying this purchase to
 * this person is that the names agreed. */
function linkNote(purchase: PassInboxPurchase) {
  if (!purchase.personId) return "No client matched — this will be issued unassigned";
  if (purchase.personLinkSource === "email") return "Matched on email";
  if (purchase.personLinkSource === "name") return "Matched on name only — check this is them";
  if (purchase.personLinkSource === "new") return "New client created from this sale";
  return "";
}

export function PassInboxPanel({
  purchases,
  unassigned,
  templates,
  people,
  loadState,
  busyId,
  onIssue,
  onDismiss,
  onAttach,
  onRetry,
}: PassInboxPanelProps) {
  // Per-row overrides. A row with nothing here uses the server's suggestion,
  // so the common case is one click and the dropdown only exists for the rows
  // where the suggestion was refused or wrong.
  const [chosenTemplate, setChosenTemplate] = useState<Record<string, string>>({});
  const [chosenPerson, setChosenPerson] = useState<Record<string, string>>({});

  const sortedPeople = useMemo(
    () => [...people].sort((a, b) => a.name.localeCompare(b.name)),
    [people],
  );

  const templateFor = (purchase: PassInboxPurchase) =>
    chosenTemplate[purchase.id] ?? purchase.suggestedTemplateServiceId;

  if (loadState === "loading") return <Loading what="the pass inbox" />;

  if (loadState === "error") {
    return (
      <div className="pass-inbox-empty">
        <p>The pass inbox could not be loaded.</p>
        <button className="outline-button" type="button" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }

  if (!purchases.length && !unassigned.length) {
    return (
      <div className="pass-inbox-empty">
        <Inbox size={22} />
        <p>Nothing waiting.</p>
        <span>
          Purchases that need a package, and passes that need an owner, land here. An empty inbox
          means every pass sold has reached somebody.
        </span>
      </div>
    );
  }

  return (
    <div className="pass-inbox">
      {purchases.length > 0 && (
        <section className="pass-inbox-section">
          <header>
            <h3>Waiting to be issued</h3>
            <p>
              Somebody paid for these and holds nothing yet. The sale names a product, not a number
              of credits — pick the package it was and the credits follow from your catalogue.
            </p>
          </header>

          {purchases.map((purchase) => {
            const selected = templateFor(purchase);
            const busy = busyId === purchase.id;
            return (
              <article className="pass-inbox-row" key={purchase.id}>
                <div className="pass-inbox-row-main">
                  <strong>{purchase.itemName || "Unnamed product"}</strong>
                  <span>
                    {[
                      purchase.buyerName || "Unknown buyer",
                      purchase.saleNumber ? `Sale ${purchase.saleNumber}` : "",
                      formatAmount(purchase.amountCents, purchase.currency),
                      formatWhen(purchase.purchasedAt),
                      purchase.quantity > 1 ? `×${purchase.quantity}` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  <em
                    className={
                      purchase.personLinkSource === "email" ? "" : "pass-inbox-row-caution"
                    }
                  >
                    {purchase.personName ? `${purchase.personName} — ` : ""}
                    {linkNote(purchase)}
                  </em>
                  {/* An unknown never matched the classifier's keywords. It is
                      here to be judged, not because anything thinks it is a
                      pass -- which is how a wrong guess gets corrected without
                      a code change. */}
                  {purchase.classification === "unknown" && (
                    <em className="pass-inbox-row-caution">
                      Not recognised as a lesson pass — is it one?
                    </em>
                  )}
                </div>

                <div className="pass-inbox-row-actions">
                  <label className="pass-inbox-field">
                    <span>Package</span>
                    <select
                      value={selected}
                      onChange={(event) =>
                        setChosenTemplate((current) => ({
                          ...current,
                          [purchase.id]: event.target.value,
                        }))
                      }
                    >
                      <option value="">Pick a package…</option>
                      {templates.map((template) => (
                        <option key={template.serviceId} value={template.serviceId}>
                          {template.name} · {template.credits} credit
                          {template.credits === 1 ? "" : "s"}
                        </option>
                      ))}
                    </select>
                  </label>
                  {/* Only ever shown for a suggestion that is actually in the
                      box. Leaving it up after a coach overrides the guess would
                      describe a choice nobody made. */}
                  {purchase.suggestionConfidence !== "none" &&
                    selected === purchase.suggestedTemplateServiceId && (
                      <span className="pass-inbox-suggestion">
                        {purchase.suggestionConfidence === "exact"
                          ? "Name matched your catalogue"
                          : "Closest match — worth a look"}
                      </span>
                    )}
                  <div className="pass-inbox-row-buttons">
                    <button
                      className="outline-button"
                      type="button"
                      disabled={busy}
                      onClick={() => onDismiss(purchase.id)}
                    >
                      Not a pass
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={busy || !selected}
                      onClick={() => onIssue(purchase.id, selected)}
                    >
                      <Ticket size={15} />
                      {busy ? "Issuing…" : "Issue pass"}
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {unassigned.length > 0 && (
        <section className="pass-inbox-section">
          <header>
            <h3>Waiting for an owner</h3>
            <p>
              These exist and are spendable, but belong to nobody. A pass with no owner is honest;
              one attached to the wrong person is found out at the counter.
            </p>
          </header>

          {unassigned.map((pass) => {
            const person = chosenPerson[pass.id] || "";
            const busy = busyId === pass.id;
            return (
              <article className="pass-inbox-row" key={pass.id}>
                <div className="pass-inbox-row-main">
                  <strong>{pass.name}</strong>
                  <span>
                    {[
                      `${pass.creditsAvailable} of ${pass.creditsAllocated} left`,
                      pass.source ? `From ${pass.source.replace(/_/g, " ")}` : "",
                      formatWhen(pass.issuedAt),
                      pass.expiresAt ? `Expires ${formatWhen(pass.expiresAt)}` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {pass.note && <em>{pass.note}</em>}
                </div>

                <div className="pass-inbox-row-actions">
                  <label className="pass-inbox-field">
                    <span>Client</span>
                    <select
                      value={person}
                      onChange={(event) =>
                        setChosenPerson((current) => ({
                          ...current,
                          [pass.id]: event.target.value,
                        }))
                      }
                    >
                      <option value="">Pick a client…</option>
                      {sortedPeople.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="pass-inbox-row-buttons">
                    <button
                      className="primary-button"
                      type="button"
                      disabled={busy || !person}
                      onClick={() => onAttach(pass.id, person)}
                    >
                      <UserPlus size={15} />
                      {busy ? "Attaching…" : "Attach"}
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}

export default PassInboxPanel;
