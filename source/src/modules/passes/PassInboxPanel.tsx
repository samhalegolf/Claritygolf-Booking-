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
//
// WHAT THE THIRD STATE COSTS
//
// The first queue reads every sale, from Optix and from Stripe, and most sales
// are not entitlements at all -- a coffee, an hour of bay time, a green fee.
// Those arrive classified "unknown" and they used to render at full size with
// a line saying they were probably not passes, which made a queue of four real
// jobs look like a queue of forty. An unlikely row is still shown, because the
// classifier is a keyword match and being quietly wrong about which sales
// exist is the one failure that looks exactly like an empty inbox. It is just
// shown folded: one line saying how many, opened on request.
//
// And when the coach says a product is never an entitlement, that is kept. The
// dismissal is by product rather than by sale, so next month's bay-hire line
// does not come back -- a queue that refills with the same rejected rows is a
// queue nobody opens twice.

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Gift, Inbox, Ticket, Undo2, UserPlus } from "lucide-react";

import { Loading } from "../shared/Loading";

/** What a sale looks like it is. "unknown" is a real answer, not a failure. */
export type PassInboxKind = "pass" | "voucher" | "unknown";

export type PassInboxPurchase = {
  id: string;
  provider: string;
  /** What the wording classifier made of it. Never what it is. */
  kind: PassInboxKind;
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

/**
 * What a pass issued from this sale is worth, before the coach touches it.
 *
 * An external sale often carries no usable price -- a pass bundled into a
 * membership arrives as 0.00 -- so the catalogue price of the package stands in.
 * Shown rather than applied silently, because a comped or discounted pass is a
 * real thing and the coach is the only one who knows.
 *
 * Mirrors resolveInboxPassValue on the server, which decides it for real.
 */
export function suggestedValueCents(
  purchase: { amountCents: number | null; quantity: number },
  template: { priceCents: number | null } | undefined,
): number | null {
  if (purchase.amountCents !== null && purchase.amountCents > 0) return purchase.amountCents;
  if (!template || template.priceCents === null) return null;
  return template.priceCents * Math.max(1, purchase.quantity || 1);
}

export type PassInboxTemplate = {
  serviceId: string;
  name: string;
  credits: number;
  /** The catalogue price, used when the external sale carried none. */
  priceCents: number | null;
};

export type PassInboxPerson = { id: string; name: string };

export type PassInboxDismissedType = { type: string; label: string };

export type PassInboxPanelProps = {
  purchases: PassInboxPurchase[];
  unassigned: PassInboxUnassigned[];
  templates: PassInboxTemplate[];
  /** Who an unassigned pass can be handed to. */
  people: PassInboxPerson[];
  /** Products the coach has said are never entitlements, newest last. The
   *  type is the match key and the label is the wording it was dismissed as --
   *  the key alone ("1xextrahour") is not something a coach would recognise. */
  dismissedTypes: PassInboxDismissedType[];
  loadState: "idle" | "loading" | "loaded" | "error";
  busyId: string;
  /** `valueCents` is undefined when the coach left the suggested price alone. */
  onIssue: (purchaseId: string, templateServiceId: string, valueCents?: number) => void;
  onVoucher: (purchaseId: string, valueCents?: number) => void;
  onDismiss: (purchaseId: string) => void;
  onDismissType: (itemName: string) => void;
  onRestoreType: (itemName: string) => void;
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

/* Where the sale came from, in the one word a coach would use.
 *
 * Worth a line of its own now that the queue mixes two providers: "matched on
 * name only" means something quite different for an Optix sale that carries no
 * email at all than for a Stripe one where an address was present and simply
 * did not match anybody. */
function providerLabel(provider: string) {
  if (provider === "stripe") return "Stripe";
  if (provider === "optix") return "Optix";
  return provider ? provider.replace(/_/g, " ") : "";
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

/**
 * The "value" field, as typed, turned into the number the server is sent.
 *
 * Undefined means "the coach did not touch it", which is not the same as zero
 * and must not be sent as one: the server works the value out again from the
 * sale and the catalogue rather than trusting a number the browser rendered.
 */
function typedValueCents(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(Number(raw))) return undefined;
  return Math.max(0, Math.round(Number(raw) * 100));
}

export function PassInboxPanel({
  purchases,
  unassigned,
  templates,
  people,
  dismissedTypes,
  loadState,
  busyId,
  onIssue,
  onVoucher,
  onDismiss,
  onDismissType,
  onRestoreType,
  onAttach,
  onRetry,
}: PassInboxPanelProps) {
  // Per-row overrides. A row with nothing here uses the server's suggestion,
  // so the common case is one click and the dropdown only exists for the rows
  // where the suggestion was refused or wrong.
  const [chosenTemplate, setChosenTemplate] = useState<Record<string, string>>({});
  /** Per-row price override, as typed. Empty means "use the suggested one". */
  const [chosenValue, setChosenValue] = useState<Record<string, string>>({});
  const [chosenPerson, setChosenPerson] = useState<Record<string, string>>({});
  /** The two folded sections. Both start shut; neither hides anything. */
  const [showUnlikely, setShowUnlikely] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);

  const sortedPeople = useMemo(
    () => [...people].sort((a, b) => a.name.localeCompare(b.name)),
    [people],
  );

  // The split the whole screen is arranged around. A sale the classifier
  // recognised is work; one it did not is a question, and a question should
  // not be the same size as a job.
  const likely = useMemo(
    () => purchases.filter((purchase) => purchase.kind !== "unknown"),
    [purchases],
  );
  const unlikely = useMemo(
    () => purchases.filter((purchase) => purchase.kind === "unknown"),
    [purchases],
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

  /* One sale, as a row.
   *
   * `folded` is passed rather than derived from the kind because the same row
   * renders in both places: an unknown sale opened out of the fold gets the
   * full set of controls, since the coach opening it has already decided it is
   * worth a look. Folded rows are dimmed, not disabled -- a row you cannot act
   * on is a row that wasted the click that opened it.
   */
  function renderPurchase(purchase: PassInboxPurchase, folded: boolean) {
    const selected = templateFor(purchase);
    const busy = busyId === purchase.id;
    const suggested = suggestedValueCents(
      purchase,
      templates.find((template) => template.serviceId === selected),
    );
    const typed = typedValueCents(chosenValue[purchase.id]);
    // A voucher is worth what was paid and nothing else -- there is no
    // catalogue package behind it to price it from.
    const voucherSuggested = purchase.amountCents;
    const isVoucher = purchase.kind === "voucher";
    const offerPass = !isVoucher;
    const offerVoucher = isVoucher || purchase.kind === "unknown";

    return (
      <article
        className={folded ? "pass-inbox-row pass-inbox-row-folded" : "pass-inbox-row"}
        key={purchase.id}
      >
        <div className="pass-inbox-row-main">
          <strong>{purchase.itemName || "Unnamed product"}</strong>
          <span>
            {[
              providerLabel(purchase.provider),
              purchase.buyerName || "Unknown buyer",
              purchase.saleNumber ? `Sale ${purchase.saleNumber}` : "",
              formatAmount(purchase.amountCents, purchase.currency),
              formatWhen(purchase.purchasedAt),
              purchase.quantity > 1 ? `×${purchase.quantity}` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <em className={purchase.personLinkSource === "email" ? "" : "pass-inbox-row-caution"}>
            {purchase.personName ? `${purchase.personName} — ` : ""}
            {linkNote(purchase)}
          </em>
          {/* An unknown never matched the classifier's keywords. It is here to
              be judged, not because anything thinks it is a pass -- which is
              how a wrong guess gets corrected without a code change. */}
          {purchase.kind === "unknown" && (
            <em className="pass-inbox-row-caution">
              Not recognised as a pass or a voucher — is it one?
            </em>
          )}
        </div>

        <div className="pass-inbox-row-actions">
          {offerPass && (
            <label className="pass-inbox-field">
              <span>Package</span>
              <select
                value={selected}
                onChange={(event) =>
                  setChosenTemplate((current) => ({ ...current, [purchase.id]: event.target.value }))
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
          )}

          {/* What it was worth. An external sale often says 0.00 -- the pass
              was bundled into a membership, or rung up elsewhere -- so the
              package's own price stands in, and stays editable because a
              comped or discounted one is a real thing. A voucher has no
              package behind it, so what was paid is all there is. */}
          <label className="pass-inbox-field">
            <span>Value</span>
            <input
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={
                chosenValue[purchase.id] ??
                (() => {
                  const fallback = isVoucher ? voucherSuggested : suggested;
                  return fallback === null ? "" : (fallback / 100).toFixed(2);
                })()
              }
              placeholder={purchase.currency || ""}
              onChange={(event) =>
                setChosenValue((current) => ({ ...current, [purchase.id]: event.target.value }))
              }
            />
          </label>

          {offerPass && suggested !== null && (purchase.amountCents === null || purchase.amountCents <= 0) && (
            <span className="pass-inbox-suggestion">
              The sale came through at 0 — this is the package's price.
            </span>
          )}
          {/* Only ever shown for a suggestion that is actually in the box.
              Leaving it up after a coach overrides the guess would describe a
              choice nobody made. */}
          {offerPass &&
            purchase.suggestionConfidence !== "none" &&
            selected === purchase.suggestedTemplateServiceId && (
              <span className="pass-inbox-suggestion">
                {purchase.suggestionConfidence === "exact"
                  ? "Name matched your catalogue"
                  : "Closest match — worth a look"}
              </span>
            )}

          <div className="pass-inbox-row-buttons">
            {/* Dismissing the product, not the sale. The wording says so,
                because "Not a pass" reading as "hide this one" is how a coach
                ends up doing it again next month. */}
            <button
              className="outline-button"
              type="button"
              disabled={busy}
              title={`Stop showing anything sold as “${purchase.itemName}”`}
              onClick={() => onDismissType(purchase.itemName)}
            >
              Never a pass
            </button>
            {/* Optix rows keep the single-sale correction as well: it writes
                back to the classifier's own output, which is the record that
                was wrong. A Stripe line has no such row -- the billing sync
                owns it and would overwrite the edit -- so it only has the
                product-level answer above. */}
            {purchase.provider === "optix" && (
              <button
                className="outline-button"
                type="button"
                disabled={busy}
                title="Just this sale"
                onClick={() => onDismiss(purchase.id)}
              >
                Just this one
              </button>
            )}
            {offerVoucher && (
              <button
                className={isVoucher ? "primary-button" : "outline-button"}
                type="button"
                disabled={busy}
                onClick={() => onVoucher(purchase.id, typed)}
              >
                <Gift size={15} />
                {busy ? "Issuing…" : "Issue voucher"}
              </button>
            )}
            {offerPass && (
              <button
                className="primary-button"
                type="button"
                disabled={busy || !selected}
                onClick={() => onIssue(purchase.id, selected, typed)}
              >
                <Ticket size={15} />
                {busy ? "Issuing…" : "Issue pass"}
              </button>
            )}
          </div>
        </div>
      </article>
    );
  }

  const nothingWaiting = !likely.length && !unlikely.length && !unassigned.length;

  // The empty state has to survive a coach who has dismissed a lot of
  // products: "nothing waiting" while a dismissed list quietly holds twenty
  // types would be true and useless. The fold below stays available.
  if (nothingWaiting && !dismissedTypes.length) {
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
      {(likely.length > 0 || unlikely.length > 0) && (
        <section className="pass-inbox-section">
          <header>
            <h3>Waiting to be issued</h3>
            <p>
              Somebody paid for these and holds nothing yet. The sale names a product, not a number
              of credits — pick the package it was and the credits follow from your catalogue. A
              gift voucher gets a code and a balance instead, because nobody knows yet who will
              spend it.
            </p>
          </header>

          {likely.map((purchase) => renderPurchase(purchase, false))}

          {likely.length === 0 && unlikely.length > 0 && (
            <p className="pass-inbox-suggestion">
              Nothing here looks like a pass or a voucher.
            </p>
          )}

          {/* The fold. Counted on the button rather than hidden behind it: the
              number is the whole reason not to open it. */}
          {unlikely.length > 0 && (
            <div className="pass-inbox-fold">
              <button
                className="pass-inbox-fold-toggle"
                type="button"
                aria-expanded={showUnlikely}
                onClick={() => setShowUnlikely((current) => !current)}
              >
                {showUnlikely ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                {unlikely.length} other sale{unlikely.length === 1 ? "" : "s"} that probably
                {unlikely.length === 1 ? " is not" : " are not"} passes
              </button>
              {showUnlikely && unlikely.map((purchase) => renderPurchase(purchase, true))}
            </div>
          )}
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
                        setChosenPerson((current) => ({ ...current, [pass.id]: event.target.value }))
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

      {/* Every dismissal is reversible from here, and that is what makes
          dismissing one cheap. A "never show me this" with no way back is a
          decision a coach has to be sure about, which means hesitating over
          every row -- exactly the cost this screen exists to remove. */}
      {dismissedTypes.length > 0 && (
        <div className="pass-inbox-fold">
          <button
            className="pass-inbox-fold-toggle"
            type="button"
            aria-expanded={showDismissed}
            onClick={() => setShowDismissed((current) => !current)}
          >
            {showDismissed ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            {dismissedTypes.length} product{dismissedTypes.length === 1 ? "" : "s"} you have said
            {dismissedTypes.length === 1 ? " is" : " are"} never a pass
          </button>
          {showDismissed && (
            <ul className="pass-inbox-dismissed">
              {dismissedTypes.map((entry) => (
                <li key={entry.type}>
                  <span>{entry.label || entry.type}</span>
                  <button
                    className="outline-button"
                    type="button"
                    disabled={busyId === entry.type}
                    onClick={() => onRestoreType(entry.type)}
                  >
                    <Undo2 size={14} />
                    Show again
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default PassInboxPanel;
