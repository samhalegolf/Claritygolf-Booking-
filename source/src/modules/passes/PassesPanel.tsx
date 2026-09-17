// The Passes tab on a client profile: what this person is entitled to, where
// each credit came from, and the button that grants more.
//
// Its own module rather than more markup inside App.tsx, following ClientsPanel.
// Everything here is presentational -- it never computes a balance. The numbers
// come from the pass_balances view via /api/passes, because the server owning
// that arithmetic is the whole point of the ledger underneath.

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText, MinusCircle, Plus, Ticket } from "lucide-react";

import { Loading } from "../shared/Loading";

export type PassAllocation = {
  id: string;
  credits: number;
  creditsRedeemed: number;
  creditsAvailable: number;
  availableFrom: string;
  expiresAt: string | null;
  isLive: boolean;
  source: string;
  note: string;
  createdAt: string;
  entitlementServiceId: string | null;
  totalValueCents: number | null;
  currency: string | null;
};

export type PassRedemption = {
  id: string;
  allocationId: string;
  bookingId: string | null;
  credits: number;
  redeemedAt: string;
  redeemedBy: string;
  reversedAt: string | null;
  reversalReason: string | null;
  /** Why the credit was spent, when no booking says so. */
  note: string;
  /** No booking behind it: written by hand to correct a count. */
  manual: boolean;
};

/**
 * A line off an invoice that looks like it is about this pass.
 *
 * Evidence, never a link. The pass was created by hand and the invoice came
 * from somewhere else entirely; the only thing they share is wording, so the
 * strength says how much of a stretch the match was and the coach decides.
 */
export type InvoicedLesson = {
  id: string;
  passId?: string;
  invoiceNumber: string;
  invoiceStatus: string;
  billedTo: string;
  /** "billed" their own invoice, "matched" by email, "included" someone else's. */
  relation: string;
  description: string;
  quantity: number;
  amountCents: number;
  currency: string;
  when: string;
  strength?: "exact" | "close" | "loose";
};

export type Pass = {
  id: string;
  name: string;
  templateServiceId: string | null;
  coversServiceIds: string[];
  crossRedeemable: boolean;
  creditsAvailable: number;
  creditsAllocated: number;
  creditsRedeemed: number;
  nextExpiry: string | null;
  expiresAt: string | null;
  status: "active" | "exhausted" | "expired" | "scheduled" | "void";
  note: string;
  issuedAt: string;
  allocations: PassAllocation[];
  redemptions: PassRedemption[];
};

export type PassTemplate = {
  serviceId: string;
  name: string;
  credits: number;
  coversServiceIds: string[];
  crossRedeemable: boolean;
  priceCents: number | null;
};

export type PassGrant = {
  templateServiceId: string;
  name: string;
  credits: number;
  expiryMonths: number;
  note: string;
  coversServiceIds: string[];
};

export type CoverableService = { id: string; name: string };

export type PassesPanelProps = {
  passes: Pass[];
  /** Invoice lines whose wording matched a pass, keyed by passId on each row. */
  invoicedLines: InvoicedLesson[];
  /** Billed for, and matching no pass. The other half of reconciling. */
  unmatchedInvoicedLines: InvoicedLesson[];
  templates: PassTemplate[];
  /** What a free-form grant can be pointed at. Packages are not in this list. */
  coverableServices: CoverableService[];
  loadState: "idle" | "loading" | "loaded" | "error";
  granting: boolean;
  onGrant: (grant: PassGrant) => void;
  onVoid: (pass: Pass) => void;
  onRedeem: (passId: string, credits: number, note: string) => void;
  onReturnCredit: (redemptionId: string) => void;
  onRetry: () => void;
  /** Turns a covered service id into something a person would recognise. */
  serviceName: (serviceId: string) => string;
};

const EXPIRY_CHOICES = [
  { months: 6, label: "6 months" },
  { months: 12, label: "12 months" },
  { months: 24, label: "24 months" },
  { months: 0, label: "No expiry" },
];

function dateLabel(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function statusLabel(pass: Pass) {
  if (pass.status === "void") return "Voided";
  if (pass.status === "expired") return "Expired";
  if (pass.status === "scheduled") return "Not started yet";
  if (pass.status === "exhausted") return "All used";
  return `${pass.creditsAvailable} of ${pass.creditsAllocated} left`;
}

function creditWord(count: number) {
  return count === 1 ? "credit" : "credits";
}

function allocationValueLabel(allocation: PassAllocation) {
  if (allocation.totalValueCents === null || !allocation.currency) return "native only";
  return `${allocation.currency} ${(allocation.totalValueCents / 100).toFixed(2)} purchase value`;
}

/**
 * The ledger under a pass, in the order the events happened.
 *
 * Credits in and credits out are one sequence, not two lists -- "+2 September,
 * used 1, +2 October" is the sentence a coach needs to be able to read off the
 * screen when somebody asks why they have three left. Splitting it into every
 * allocation and then every redemption makes that arithmetic the reader's job.
 */
function ledgerLines(pass: Pass) {
  const lines = [
    ...pass.allocations.map((allocation) => ({
      id: allocation.id,
      at: allocation.createdAt,
      reversed: false,
      // Credits arriving are never handed back from the ledger -- that is what
      // voiding the pass is for. Only a spend has an undo here.
      returnable: false,
      text:
        `+${allocation.credits} ${creditWord(allocation.credits)} · ${allocation.source}` +
        ` · ${allocationValueLabel(allocation)}` +
        (allocation.expiresAt && !allocation.isLive ? " · expired" : "") +
        ` · ${dateLabel(allocation.createdAt)}`,
    })),
    ...pass.redemptions.map((redemption) => ({
      id: redemption.id,
      at: redemption.redeemedAt,
      reversed: Boolean(redemption.reversedAt),
      // Only a hand-written spend can be handed back from here. One that paid
      // for a lesson is tied to that lesson's paid state, and returning the
      // credit without cancelling the lesson leaves the two disagreeing with
      // nothing on either record admitting it.
      returnable: redemption.manual && !redemption.reversedAt,
      text:
        `−${redemption.credits} ${creditWord(redemption.credits)} · ${dateLabel(redemption.redeemedAt)}` +
        (redemption.manual ? " · by hand" : "") +
        (redemption.note ? ` · ${redemption.note}` : "") +
        (redemption.reversedAt
          ? ` · returned${redemption.reversalReason ? ` (${redemption.reversalReason})` : ""}`
          : ""),
    })),
  ];
  return lines.sort((a, b) => a.at.localeCompare(b.at));
}

function moneyLabel(cents: number, currency: string) {
  const amount = (cents / 100).toFixed(2);
  return currency ? `${currency} ${amount}` : amount;
}

/* How much of a stretch the wording match was.
 *
 * Said out loud on every row rather than only the doubtful ones. A coach
 * counting lessons billed against credits given is relying on this list being
 * the right list, and "these three are certain and this fourth is a guess" is
 * the difference between a count they can act on and one they cannot. */
function strengthNote(strength: InvoicedLesson["strength"]) {
  if (strength === "exact") return "name matches";
  if (strength === "close") return "close match";
  return "loose match — check this is the same thing";
}

/* Where the invoice came from, when it is not simply theirs.
 *
 * "matched" means nothing tied the invoice to this client except the email
 * address on it, which is how every Stripe sale arrives. "included" means the
 * invoice was addressed to somebody else -- a parent, an employer -- and
 * contains one of this person's lessons. Both are worth saying: a coach
 * checking a total needs to know which rows are inferences. */
function relationNote(relation: string) {
  if (relation === "matched") return "matched on email";
  if (relation === "included") return "on someone else's invoice";
  return "";
}

export function PassesPanel({
  passes,
  invoicedLines,
  unmatchedInvoicedLines,
  templates,
  coverableServices,
  loadState,
  granting,
  onGrant,
  onVoid,
  onRedeem,
  onReturnCredit,
  onRetry,
  serviceName,
}: PassesPanelProps) {
  /** Which pass has its "use a credit" form open, and what is typed into it. */
  const [redeemingPassId, setRedeemingPassId] = useState("");
  const [redeemNote, setRedeemNote] = useState("");
  const [redeemCredits, setRedeemCredits] = useState("1");
  /** Invoiced lines that matched nothing, shut by default. */
  const [showUnmatched, setShowUnmatched] = useState(false);

  // Grouped once rather than filtered inside each row's render, so a client
  // with a long billing history does not walk the whole list per pass.
  const linesByPass = useMemo(() => {
    const grouped = new Map<string, InvoicedLesson[]>();
    for (const line of invoicedLines) {
      if (!line.passId) continue;
      const held = grouped.get(line.passId);
      if (held) held.push(line);
      else grouped.set(line.passId, [line]);
    }
    return grouped;
  }, [invoicedLines]);

  function closeRedeem() {
    setRedeemingPassId("");
    setRedeemNote("");
    setRedeemCredits("1");
  }

  function submitRedeem(passId: string) {
    const credits = Math.max(1, Math.round(Number(redeemCredits) || 1));
    const note = redeemNote.trim();
    if (!note) return;
    onRedeem(passId, credits, note);
    closeRedeem();
  }
  const [formOpen, setFormOpen] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("");
  const [credits, setCredits] = useState("1");
  const [expiryMonths, setExpiryMonths] = useState(12);
  const [note, setNote] = useState("");
  const [covers, setCovers] = useState<string[]>([]);

  const template = useMemo(
    () => templates.find((entry) => entry.serviceId === templateId),
    [templateId, templates],
  );

  // Picking a template fills the form in rather than replacing it: a coach can
  // still grant three of a five-credit package without leaving the template
  // behind, which is what a goodwill top-up usually is.
  function chooseTemplate(nextId: string) {
    setTemplateId(nextId);
    const picked = templates.find((entry) => entry.serviceId === nextId);
    if (picked) {
      setName(picked.name);
      setCredits(String(picked.credits));
    }
  }

  function resetForm() {
    setFormOpen(false);
    setTemplateId("");
    setName("");
    setCredits("1");
    setExpiryMonths(12);
    setNote("");
    setCovers([]);
  }

  function submit() {
    const count = Math.max(1, Math.min(100, Math.round(Number(credits) || 0)));
    onGrant({
      templateServiceId: templateId,
      name: name.trim() || template?.name || "",
      credits: count,
      expiryMonths,
      note: note.trim(),
      // A template brings its own coverage; the server uses that and ignores
      // this. It only matters for a free-form grant.
      coversServiceIds: templateId ? [] : covers,
    });
    resetForm();
  }

  // A free-form pass that covers nothing can never be spent, so the form will
  // not let one be created. A template supplies its own coverage.
  const canSubmit =
    !granting && (Boolean(templateId) || (name.trim().length > 0 && covers.length > 0));

  return (
    <div className="pass-panel">
      {!formOpen && (
        <div className="pass-panel-actions">
          <button className="outline-button" type="button" onClick={() => setFormOpen(true)}>
            <Plus size={16} />
            Give pass
          </button>
        </div>
      )}

      {formOpen && (
        <div className="pass-grant-form">
          <label className="pass-field">
            <span>Pass</span>
            <select value={templateId} onChange={(event) => chooseTemplate(event.target.value)}>
              <option value="">Something else</option>
              {templates.map((entry) => (
                <option key={entry.serviceId} value={entry.serviceId}>
                  {entry.name} · {entry.credits} {creditWord(entry.credits)}
                </option>
              ))}
            </select>
          </label>

          {!templateId && (
            <label className="pass-field">
              <span>Name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Goodwill credit"
              />
            </label>
          )}

          {!templateId && (
            <div className="pass-field pass-field-wide">
              <span>Use for</span>
              <div className="pass-coverage">
                {coverableServices.length ? (
                  coverableServices.map((service) => (
                    <label className="pass-coverage-option" key={service.id}>
                      <input
                        type="checkbox"
                        checked={covers.includes(service.id)}
                        onChange={(event) =>
                          setCovers((current) =>
                            event.target.checked
                              ? [...current, service.id]
                              : current.filter((id) => id !== service.id),
                          )
                        }
                      />
                      {service.name}
                    </label>
                  ))
                ) : (
                  <span className="pass-coverage-empty">No services to cover yet.</span>
                )}
              </div>
            </div>
          )}

          <label className="pass-field">
            <span>Credits</span>
            <input
              type="number"
              min={1}
              max={100}
              value={credits}
              onChange={(event) => setCredits(event.target.value)}
            />
          </label>

          <label className="pass-field">
            <span>Expires</span>
            <select
              value={String(expiryMonths)}
              onChange={(event) => setExpiryMonths(Number(event.target.value))}
            >
              {EXPIRY_CHOICES.map((choice) => (
                <option key={choice.months} value={String(choice.months)}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>

          <label className="pass-field pass-field-wide">
            <span>Reason</span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Comped after the rained-out session"
            />
          </label>

          <div className="pass-panel-actions">
            <button className="primary-button" type="button" onClick={submit} disabled={!canSubmit}>
              {granting ? "Giving" : "Give pass"}
            </button>
            <button className="outline-button" type="button" onClick={resetForm}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {loadState === "loading" ? (
        <Loading what="passes" />
      ) : loadState === "error" ? (
        <p>
          Could not load passes.{" "}
          <button className="link-button" type="button" onClick={onRetry}>
            Retry
          </button>
        </p>
      ) : passes.length ? (
        passes.map((pass) => {
          const covers = pass.coversServiceIds.map(serviceName).filter(Boolean).join(", ");
          const spendable = pass.status === "active";
          return (
            <div className="profile-history-row pass-row" key={pass.id}>
              <div>
                <strong>
                  <Ticket size={15} /> {pass.name}
                </strong>
                <span>
                  {covers ? `Covers ${covers}` : "No covered service set"}
                  {pass.crossRedeemable ? " · Cross redeemable" : " · Native use only"}
                  {pass.expiresAt ? ` · Valid until ${dateLabel(pass.expiresAt)}` : " · No expiry"}
                </span>
                {pass.note ? <span>{pass.note}</span> : null}

                <ul className="pass-ledger">
                  {ledgerLines(pass).map((line) => (
                    <li
                      className={`pass-ledger-line${line.reversed ? " pass-ledger-reversed" : ""}`}
                      key={line.id}
                    >
                      {line.text}
                      {line.returnable && (
                        <button
                          className="link-button"
                          type="button"
                          onClick={() => onReturnCredit(line.id)}
                        >
                          Put it back
                        </button>
                      )}
                    </li>
                  ))}
                </ul>

                {/* Using a credit for something that was never booked.
                    The reason is required, not optional: a credit that
                    vanished with no lesson and no explanation is what gets
                    argued about at a counter months later. */}
                {spendable &&
                  (redeemingPassId === pass.id ? (
                    <div className="pass-redeem-form">
                      <label className="pass-field">
                        <span>Credits</span>
                        <input
                          type="number"
                          min={1}
                          max={pass.creditsAvailable || 1}
                          value={redeemCredits}
                          onChange={(event) => setRedeemCredits(event.target.value)}
                        />
                      </label>
                      <label className="pass-field pass-field-wide">
                        <span>What for</span>
                        <input
                          value={redeemNote}
                          onChange={(event) => setRedeemNote(event.target.value)}
                          placeholder="Lesson on the 4th, never booked in"
                        />
                      </label>
                      <div className="pass-panel-actions">
                        <button
                          className="primary-button"
                          type="button"
                          disabled={!redeemNote.trim()}
                          onClick={() => submitRedeem(pass.id)}
                        >
                          Use credit
                        </button>
                        <button className="outline-button" type="button" onClick={closeRedeem}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="link-button pass-redeem-open"
                      type="button"
                      onClick={() => {
                        setRedeemingPassId(pass.id);
                        setRedeemNote("");
                        setRedeemCredits("1");
                      }}
                    >
                      <MinusCircle size={14} /> Use a credit without a booking
                    </button>
                  ))}

                {/* What they were billed for, beside what they hold.
                    Nothing joins these to the pass but wording, so each row
                    says how sure the match was and none of it is totalled
                    into the pass's own numbers. */}
                {(linesByPass.get(pass.id) || []).length > 0 && (
                  <div className="pass-invoiced">
                    <h4>
                      <FileText size={14} />
                      Invoiced for {(linesByPass.get(pass.id) || []).length}{" "}
                      {(linesByPass.get(pass.id) || []).length === 1 ? "line" : "lines"} that look
                      like this
                    </h4>
                    <ul>
                      {(linesByPass.get(pass.id) || []).map((line) => (
                        <li className={`pass-invoiced-${line.strength}`} key={line.id}>
                          <span>{line.description}</span>
                          <em>
                            {[
                              line.quantity > 1 ? `×${line.quantity}` : "",
                              moneyLabel(line.amountCents, line.currency),
                              dateLabel(line.when),
                              line.invoiceNumber ? `Invoice ${line.invoiceNumber}` : "",
                              relationNote(line.relation),
                              strengthNote(line.strength),
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </em>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              <em>
                {statusLabel(pass)}
                {spendable || pass.status === "exhausted" ? (
                  <button className="link-button" type="button" onClick={() => onVoid(pass)}>
                    Void pass
                  </button>
                ) : null}
              </em>
            </div>
          );
        })
      ) : (
        <p>No passes yet.</p>
      )}

      {/* Billed for, and matching no pass they hold. Shut by default because
          most of it is bay time and balls, and worth keeping because the other
          way a pass goes wrong is the one that was never created at all. */}
      {unmatchedInvoicedLines.length > 0 && (
        <div className="pass-invoiced-fold">
          <button
            className="pass-invoiced-fold-toggle"
            type="button"
            aria-expanded={showUnmatched}
            onClick={() => setShowUnmatched((current) => !current)}
          >
            {showUnmatched ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            {unmatchedInvoicedLines.length} other invoiced{" "}
            {unmatchedInvoicedLines.length === 1 ? "line" : "lines"} matching no pass
          </button>
          {showUnmatched && (
            <ul className="pass-invoiced-list">
              {unmatchedInvoicedLines.map((line) => (
                <li key={line.id}>
                  <span>{line.description}</span>
                  <em>
                    {[
                      line.quantity > 1 ? `×${line.quantity}` : "",
                      moneyLabel(line.amountCents, line.currency),
                      dateLabel(line.when),
                      line.invoiceNumber ? `Invoice ${line.invoiceNumber}` : "",
                      relationNote(line.relation),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </em>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
