// The Passes tab on a client profile: what this person is entitled to, where
// each credit came from, and the button that grants more.
//
// Its own module rather than more markup inside App.tsx, following ClientsPanel.
// Everything here is presentational -- it never computes a balance. The numbers
// come from the pass_balances view via /api/passes, because the server owning
// that arithmetic is the whole point of the ledger underneath.

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, MinusCircle, Plus } from "lucide-react";
import { ClarityBookingPages, ClarityPassesCredits } from "../shared/ClarityIcons";

import { Loading } from "../shared/Loading";
import { invoicedSessions } from "./invoicedSessions";
import { passBalanceSummary } from "./passBalance";
import { t, tn, readerLocale } from "../../lib/i18n";

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
  /** Pays for any service; coversServiceIds is then empty. */
  coversAllServices?: boolean;
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
  coversAllServices?: boolean;
  expiryMonths?: number | null;
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
  coversAllServices?: boolean;
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
  /** Credits added by hand to a pass that is still running. */
  onAddCredits: (passId: string, credits: number, note: string) => void;
  onReturnCredit: (redemptionId: string) => void;
  /** Change what one pass pays for: everything, or the listed services. */
  onChangeCoverage: (passId: string, coversAllServices: boolean, coversServiceIds: string[]) => void;
  /**
   * Bumped by the profile's balance card. Each new value opens the adjust form
   * on the pass a coach most likely means -- or the Give pass form, when there
   * is nothing to adjust.
   */
  adjustRequest?: number;
  /** Called once a request has been acted on, so a later visit does not replay it. */
  onAdjustHandled?: () => void;
  onRetry: () => void;
  /** Turns a covered service id into something a person would recognise. */
  serviceName: (serviceId: string) => string;
};

const EXPIRY_CHOICES = [
  { months: 6, label: t("6 months") },
  { months: 12, label: t("12 months") },
  { months: 24, label: t("24 months") },
  { months: 0, label: t("No expiry") },
];

function dateLabel(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(readerLocale(), { day: "numeric", month: "short", year: "numeric" });
}

function statusLabel(pass: Pass) {
  if (pass.status === "void") return t("Voided");
  if (pass.status === "expired") return t("Expired");
  if (pass.status === "scheduled") return t("Not started yet");
  if (pass.status === "exhausted") return t("All used");
  return t("{available} of {allocated} left", { available: pass.creditsAvailable, allocated: pass.creditsAllocated });
}

/** A pass whose count can still be moved by hand: not void, not past its date. */
function adjustable(pass: Pass) {
  return pass.status === "active" || pass.status === "exhausted";
}

function creditCount(count: number) {
  return count === 1 ? t("1 credit") : t("{count} credits", { count });
}

function allocationValueLabel(allocation: PassAllocation) {
  if (allocation.totalValueCents === null || !allocation.currency) return t("native only");
  return t("{amount} purchase value", { amount: `${allocation.currency} ${(allocation.totalValueCents / 100).toFixed(2)}` });
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
        `+${creditCount(allocation.credits)} · ${allocation.source}` +
        ` · ${allocationValueLabel(allocation)}` +
        (allocation.expiresAt && !allocation.isLive ? t(" · expired") : "") +
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
        `−${creditCount(redemption.credits)} · ${dateLabel(redemption.redeemedAt)}` +
        (redemption.manual ? t(" · by hand") : "") +
        (redemption.note ? ` · ${redemption.note}` : "") +
        (redemption.reversedAt
          ? redemption.reversalReason
            ? t(" · returned ({reason})", { reason: redemption.reversalReason })
            : t(" · returned")
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
  if (strength === "exact") return t("name matches");
  if (strength === "close") return t("close match");
  return t("loose match — check this is the same thing");
}

/* Where the invoice came from, when it is not simply theirs.
 *
 * "matched" means nothing tied the invoice to this client except the email
 * address on it, which is how every Stripe sale arrives. "included" means the
 * invoice was addressed to somebody else -- a parent, an employer -- and
 * contains one of this person's lessons. Both are worth saying: a coach
 * checking a total needs to know which rows are inferences. */
function relationNote(relation: string) {
  if (relation === "matched") return t("matched on email");
  if (relation === "included") return t("on someone else's invoice");
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
  onAddCredits,
  onReturnCredit,
  onChangeCoverage,
  adjustRequest = 0,
  onAdjustHandled,
  onRetry,
  serviceName,
}: PassesPanelProps) {
  /** Which pass has its "adjust balance" form open, and what is typed into it. */
  const [redeemingPassId, setRedeemingPassId] = useState("");
  const [adjustDirection, setAdjustDirection] = useState<"add" | "remove">("remove");
  const [redeemNote, setRedeemNote] = useState("");
  const [redeemCredits, setRedeemCredits] = useState("1");
  /** Invoiced lines that matched nothing, shut by default. */
  const [showUnmatched, setShowUnmatched] = useState(false);
  /** Which passes have their invoice lines opened. The count is the headline;
      which lines make it up is a level deeper, on request. */
  const [openInvoiced, setOpenInvoiced] = useState<string[]>([]);

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

  // Same rule as the per-pass headline: what was billed is counted in sessions,
  // so the fold and the rows above it cannot disagree about the same invoice.
  const unmatchedSessions = useMemo(
    () => invoicedSessions(unmatchedInvoicedLines),
    [unmatchedInvoicedLines],
  );

  /** Sessions billed against one pass, its lines, and whether they are open. */
  function invoicedForPass(passId: string) {
    const lines = linesByPass.get(passId) || [];
    return {
      lines,
      sessions: invoicedSessions(lines),
      open: openInvoiced.includes(passId),
    };
  }

  function toggleInvoiced(passId: string) {
    setOpenInvoiced((current) =>
      current.includes(passId)
        ? current.filter((id) => id !== passId)
        : [...current, passId],
    );
  }

  function closeRedeem() {
    setRedeemingPassId("");
    setRedeemNote("");
    setRedeemCredits("1");
  }

  function submitAdjust(passId: string) {
    const credits = Math.max(1, Math.round(Number(redeemCredits) || 1));
    const note = redeemNote.trim();
    if (!note) return;
    if (adjustDirection === "add") onAddCredits(passId, credits, note);
    else onRedeem(passId, credits, note);
    closeRedeem();
  }

  const balance = passBalanceSummary(passes);
  const [formOpen, setFormOpen] = useState(false);
  /** Which pass has its "what it covers" editor open, and the choice so far. */
  const [scopePassId, setScopePassId] = useState("");
  const [scopeAll, setScopeAll] = useState(false);
  const [scopeIds, setScopeIds] = useState<string[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);
  // The panel's own Adjust button and the profile card's share one path.
  const [localAdjust, setLocalAdjust] = useState(0);
  const adjustTrigger = adjustRequest + localAdjust;
  const handledAdjust = useRef(0);

  function openScope(pass: Pass) {
    setScopePassId(pass.id);
    setScopeAll(pass.coversAllServices === true);
    setScopeIds(pass.coversServiceIds);
  }

  function saveScope(passId: string) {
    if (!scopeAll && !scopeIds.length) return;
    onChangeCoverage(passId, scopeAll, scopeAll ? [] : scopeIds);
    setScopePassId("");
  }

  // The profile's "Adjust" lands here. The pass it opens is the one a coach
  // means nine times in ten: a live one with credits, soonest to expire.
  useEffect(() => {
    if (!adjustTrigger || loadState !== "loaded" || handledAdjust.current === adjustTrigger) return;
    handledAdjust.current = adjustTrigger;
    if (adjustRequest) onAdjustHandled?.();
    const candidates = passes.filter(adjustable);
    const target =
      [...candidates]
        .filter((pass) => pass.creditsAvailable > 0)
        .sort((a, b) => (a.nextExpiry || "9999").localeCompare(b.nextExpiry || "9999"))[0] || candidates[0];
    if (target) {
      setRedeemingPassId(target.id);
      setRedeemNote("");
      setRedeemCredits("1");
      setAdjustDirection(target.creditsAvailable > 0 ? "remove" : "add");
      window.setTimeout(() => {
        panelRef.current
          ?.querySelector(`[data-pass-id="${CSS.escape(target.id)}"]`)
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }, 0);
    } else {
      setFormOpen(true);
    }
    // Only a new request should reopen it; a reload of the passes must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adjustTrigger, loadState]);
  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("");
  const [credits, setCredits] = useState("1");
  const [expiryMonths, setExpiryMonths] = useState(12);
  const [note, setNote] = useState("");
  const [covers, setCovers] = useState<string[]>([]);
  const [coversAll, setCoversAll] = useState(false);

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
      if (picked.expiryMonths !== null && picked.expiryMonths !== undefined) setExpiryMonths(picked.expiryMonths);
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
    setCoversAll(false);
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
      coversServiceIds: templateId || coversAll ? [] : covers,
      coversAllServices: templateId ? undefined : coversAll,
    });
    resetForm();
  }

  // A free-form pass that covers nothing can never be spent, so the form will
  // not let one be created. A template supplies its own coverage.
  const canSubmit =
    !granting && (Boolean(templateId) || (name.trim().length > 0 && (coversAll || covers.length > 0)));

  return (
    <div className="pass-panel" ref={panelRef}>
      {loadState === "loaded" && (
        <div className={`pass-balance-summary${balance.credits ? "" : " is-empty"}`}>
          <ClarityPassesCredits size={20} />
          <div>
            <strong>{balance.credits === 1 ? t("1 credit available") : t("{count} credits available", { count: balance.credits })}</strong>
            <span>
              {balance.livePasses
                ? tn(balance.livePasses, "On {count} active pass", "Across {count} active passes") +
                  (balance.nextExpiry ? t(" · next expiry {date}", { date: dateLabel(balance.nextExpiry) }) : "")
                : t("No active passes")}
            </span>
          </div>
        </div>
      )}
      {!formOpen && (
        <div className="pass-panel-actions">
          <button className="outline-button" type="button" onClick={() => setFormOpen(true)}>
            <Plus size={16} />{t("Give pass")}</button>
          {passes.some(adjustable) && (
            <button className="outline-button" type="button" onClick={() => setLocalAdjust((count) => count + 1)}>
              <ClarityPassesCredits size={16} />{t("Adjust balance")}</button>
          )}
        </div>
      )}

      {formOpen && (
        <div className="pass-grant-form">
          <label className="pass-field">
            <span>{t("Pass")}</span>
            <select value={templateId} onChange={(event) => chooseTemplate(event.target.value)}>
              <option value="">{t("Something else")}</option>
              {templates.map((entry) => (
                <option key={entry.serviceId} value={entry.serviceId}>
                  {entry.name} · {creditCount(entry.credits)}
                </option>
              ))}
            </select>
          </label>

          {!templateId && (
            <label className="pass-field">
              <span>{t("Name")}</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("Goodwill credit")}
              />
            </label>
          )}

          {!templateId && (
            <div className="pass-field pass-field-wide">
              <span>{t("Use for")}</span>
              <div className="pass-coverage">
                <label className="pass-coverage-option">
                  <input
                    type="checkbox"
                    checked={coversAll}
                    onChange={(event) => setCoversAll(event.target.checked)}
                  />
                  {t("Every service")}
                </label>
                {coversAll ? null : coverableServices.length ? (
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
                  <span className="pass-coverage-empty">{t("No services to cover yet.")}</span>
                )}
              </div>
            </div>
          )}

          <label className="pass-field">
            <span>{t("Credits")}</span>
            <input
              type="number"
              min={1}
              max={100}
              value={credits}
              onChange={(event) => setCredits(event.target.value)}
            />
          </label>

          <label className="pass-field">
            <span>{t("Expires")}</span>
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
            <span>{t("Reason")}</span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t("Comped after the rained-out session")}
            />
          </label>

          <div className="pass-panel-actions">
            <button className="primary-button" type="button" onClick={submit} disabled={!canSubmit}>
              {granting ? t("Giving") : t("Give pass")}
            </button>
            <button className="outline-button" type="button" onClick={resetForm}>{t("Cancel")}</button>
          </div>
        </div>
      )}

      {loadState === "loading" ? (
        <Loading what={t("passes")} />
      ) : loadState === "error" ? (
        <p>{t("Could not load passes.")}{" "}<button className="link-button" type="button" onClick={onRetry}>{t("Retry")}</button>
        </p>
      ) : passes.length ? (
        passes.map((pass) => {
          const covers = pass.coversServiceIds.map(serviceName).filter(Boolean).join(", ");
          const spendable = pass.status === "active";
          const passInvoiced = invoicedForPass(pass.id);
          return (
            <div className="profile-history-row pass-row" key={pass.id} data-pass-id={pass.id}>
              <div>
                <strong>
                  <ClarityPassesCredits size={15} /> {pass.name}
                </strong>
                <span>
                  {pass.coversAllServices
                    ? t("Covers everything")
                    : covers
                      ? t("Covers {covers}", { covers })
                      : t("No covered service set")}
                  {pass.crossRedeemable ? t(" · Cross redeemable") : t(" · Native use only")}
                  {pass.expiresAt ? t(" · Valid until {expiresAt}", { expiresAt: dateLabel(pass.expiresAt) }) : t(" · No expiry")}
                </span>
                {pass.note ? <span>{pass.note}</span> : null}

                {/* What this pass pays for, changed for this pass only. A pass
                    type edit never re-scopes passes already issued, so this is
                    where "his pass should cover the 30-minute lesson too" is
                    fixed. */}
                {pass.status !== "void" &&
                  (scopePassId === pass.id ? (
                    <div className="pass-redeem-form">
                      <div className="pass-field pass-field-wide">
                        <span>{t("Can be spent on")}</span>
                        <div className="pass-coverage">
                          <label className="pass-coverage-option">
                            <input type="checkbox" checked={scopeAll} onChange={(event) => setScopeAll(event.target.checked)} />
                            {t("Every service")}
                          </label>
                          {scopeAll
                            ? null
                            : coverableServices.map((service) => (
                                <label className="pass-coverage-option" key={service.id}>
                                  <input
                                    type="checkbox"
                                    checked={scopeIds.includes(service.id)}
                                    onChange={(event) =>
                                      setScopeIds((current) =>
                                        event.target.checked
                                          ? [...current, service.id]
                                          : current.filter((id) => id !== service.id),
                                      )
                                    }
                                  />
                                  {service.name}
                                </label>
                              ))}
                        </div>
                      </div>
                      <div className="pass-panel-actions">
                        <button
                          className="primary-button"
                          type="button"
                          disabled={!scopeAll && !scopeIds.length}
                          onClick={() => saveScope(pass.id)}
                        >{t("Save")}</button>
                        <button className="outline-button" type="button" onClick={() => setScopePassId("")}>{t("Cancel")}</button>
                      </div>
                    </div>
                  ) : (
                    <button className="link-button pass-redeem-open" type="button" onClick={() => openScope(pass)}>
                      {t("Change what it covers")}
                    </button>
                  ))}

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
                        >{t("Put it back")}</button>
                      )}
                    </li>
                  ))}
                </ul>

                {/* Using a credit for something that was never booked.
                    The reason is required, not optional: a credit that
                    vanished with no lesson and no explanation is what gets
                    argued about at a counter months later. */}
                {adjustable(pass) &&
                  (redeemingPassId === pass.id ? (
                    <div className="pass-redeem-form">
                      <div className="pass-field pass-field-wide">
                        <span>{t("Adjust balance")}</span>
                        <div className="pass-adjust-toggle" role="radiogroup" aria-label={t("Add or remove credits")}>
                          <button
                            type="button"
                            role="radio"
                            aria-checked={adjustDirection === "add"}
                            className={adjustDirection === "add" ? "active" : ""}
                            onClick={() => setAdjustDirection("add")}
                          >
                            <Plus size={14} />{t("Add credits")}</button>
                          <button
                            type="button"
                            role="radio"
                            aria-checked={adjustDirection === "remove"}
                            className={adjustDirection === "remove" ? "active" : ""}
                            disabled={pass.creditsAvailable < 1}
                            onClick={() => setAdjustDirection("remove")}
                          >
                            <MinusCircle size={14} />{t("Remove credits")}</button>
                        </div>
                      </div>
                      <label className="pass-field">
                        <span>{t("Credits")}</span>
                        <input
                          type="number"
                          min={1}
                          max={adjustDirection === "remove" ? pass.creditsAvailable || 1 : 100}
                          value={redeemCredits}
                          onChange={(event) => setRedeemCredits(event.target.value)}
                        />
                      </label>
                      <label className="pass-field pass-field-wide">
                        <span>{adjustDirection === "add" ? t("Reason") : t("What for")}</span>
                        <input
                          value={redeemNote}
                          onChange={(event) => setRedeemNote(event.target.value)}
                          placeholder={
                            adjustDirection === "add"
                              ? t("Comped after the rained-out session")
                              : t("Lesson on the 4th, never booked in")
                          }
                        />
                      </label>
                      <p className="pass-adjust-preview">
                        {(() => {
                          const step = Math.max(1, Math.round(Number(redeemCredits) || 1));
                          const after = adjustDirection === "add"
                            ? pass.creditsAvailable + step
                            : Math.max(0, pass.creditsAvailable - step);
                          return t("{before} → {after} left on this pass", { before: pass.creditsAvailable, after });
                        })()}
                      </p>
                      <div className="pass-panel-actions">
                        <button
                          className="primary-button"
                          type="button"
                          disabled={
                            !redeemNote.trim() ||
                            (adjustDirection === "remove" &&
                              Math.max(1, Math.round(Number(redeemCredits) || 1)) > pass.creditsAvailable)
                          }
                          onClick={() => submitAdjust(pass.id)}
                        >{adjustDirection === "add" ? t("Add credits") : t("Remove credits")}</button>
                        <button className="outline-button" type="button" onClick={closeRedeem}>{t("Cancel")}</button>
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
                        setAdjustDirection(pass.creditsAvailable > 0 ? "remove" : "add");
                      }}
                    >
                      <ClarityPassesCredits size={14} />{" "}{t("Adjust balance")}</button>
                  ))}

                {/* What they were billed for, beside what they hold.
                    The headline is sessions, not rows: one line reading
                    "Lesson × 3" is three lessons sold, and that is the number
                    that compares against the credits above it. Which lines it
                    came from opens underneath, because nothing joins them to
                    the pass but wording and each row has to say how sure that
                    was. None of it is totalled into the pass's own numbers. */}
                {passInvoiced.lines.length > 0 && (
                  <div className="pass-invoiced">
                    <button
                      className="pass-invoiced-toggle"
                      type="button"
                      aria-expanded={passInvoiced.open}
                      onClick={() => toggleInvoiced(pass.id)}
                    >
                      <ClarityBookingPages size={14} />
                      <span>{tn(passInvoiced.sessions, "Invoiced for {count} session that looks like this", "Invoiced for {count} sessions that look like this")}</span>
                      {passInvoiced.open ? (
                        <ChevronDown className="pass-invoiced-chevron" size={15} />
                      ) : (
                        <ChevronRight className="pass-invoiced-chevron" size={15} />
                      )}
                    </button>
                    {passInvoiced.open && (
                      <>
                        {/* Only said when the two counts differ, which is the
                            one case where "3 sessions" and a list of 2 rows
                            would read as a mistake. */}
                        {passInvoiced.sessions !== passInvoiced.lines.length && (
                          <p className="pass-invoiced-caption">{tn(passInvoiced.lines.length, "Across {count} line", "Across {count} lines")}</p>
                        )}
                        <ul>
                          {passInvoiced.lines.map((line) => (
                            <li className={`pass-invoiced-${line.strength}`} key={line.id}>
                              <span>{line.description}</span>
                              <em>
                                {[
                                  line.quantity > 1 ? `×${line.quantity}` : "",
                                  moneyLabel(line.amountCents, line.currency),
                                  dateLabel(line.when),
                                  line.invoiceNumber ? t("Invoice {number}", { number: line.invoiceNumber }) : "",
                                  relationNote(line.relation),
                                  strengthNote(line.strength),
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </em>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </div>
              <em>
                {statusLabel(pass)}
                {spendable || pass.status === "exhausted" ? (
                  <button className="link-button" type="button" onClick={() => onVoid(pass)}>{t("Void pass")}</button>
                ) : null}
              </em>
            </div>
          );
        })
      ) : (
        <p>{t("No passes yet.")}</p>
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
            {showUnmatched ? <ChevronDown size={15} /> : <ChevronRight size={15} />}{tn(unmatchedSessions, "{count} other invoiced session matching no pass", "{count} other invoiced sessions matching no pass")}</button>
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
                      line.invoiceNumber ? t("Invoice {number}", { number: line.invoiceNumber }) : "",
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
