// One membership, everything a coach can do to it, and the bill for each
// period. Used in Billing › Memberships and on the client profile, so the two
// can never offer different buttons for the same thing.

import { useState } from "react";
import { CreditCard, RotateCcw } from "lucide-react";

import { t, tn } from "../../lib/i18n";
import {
  chargeStatusLabel,
  dateLabel,
  intervalLabel,
  membershipsApi,
  PAYMENT_METHODS,
  statusLabel,
  statusPillClass,
  type Membership,
  type MembershipActionName,
  type MembershipCharge,
} from "./membershipsApi";

export type MembershipCardProps = {
  membership: Membership;
  formatMoney: (amount: number, currency?: string) => string;
  onChanged: (membership: Membership) => void;
  notify: (message: string) => void;
  /** Shown in Billing, where the member is not otherwise named. */
  onOpenPerson?: (personId: string) => void;
};

function owing(charge: MembershipCharge) {
  return charge.status === "pending" || charge.status === "failed" || charge.status === "requires_action";
}

export function MembershipCard({ membership, formatMoney, onChanged, notify, onOpenPerson }: MembershipCardProps) {
  const [busy, setBusy] = useState("");
  const [cardLink, setCardLink] = useState("");
  const [payingId, setPayingId] = useState("");
  const [payVia, setPayVia] = useState("Cash");
  const [chargesVisible, setChargesVisible] = useState(false);
  const m = membership;
  const money = (cents: number) => formatMoney(cents / 100, m.plan.currency);
  const live = m.status === "trialing" || m.status === "active" || m.status === "past_due";

  async function run(key: string, work: () => Promise<{ membership?: Membership } | void>, done?: string) {
    setBusy(key);
    try {
      const result = await work();
      if (result && result.membership) onChanged(result.membership);
      if (done) notify(done);
    } catch (error) {
      notify(error instanceof Error ? error.message : t("Something went wrong."));
    } finally {
      setBusy("");
    }
  }

  const act = (action: MembershipActionName, done: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    void run(action, () => membershipsApi.action(m.id, action), done);
  };

  const makeCardLink = () =>
    run("card-link", async () => {
      const { url } = await membershipsApi.cardLink(m.id);
      setCardLink(url);
      try {
        await navigator.clipboard.writeText(url);
        notify(t("Card link copied. Send it to the member."));
      } catch {
        notify(t("Card link ready. Copy it below and send it to the member."));
      }
    });

  const outstanding = m.charges.filter(owing);

  return (
    <div className="membership-card">
      <div className="membership-card-head">
        <div>
          {onOpenPerson ? (
            <button type="button" className="link-button membership-person" onClick={() => onOpenPerson(m.personId)}>
              {m.personName || t("Unnamed client")}
            </button>
          ) : null}
          <strong className="membership-plan-name">{m.plan.name}</strong>
          <span className="membership-meta">
            {money(m.plan.priceCents)} {intervalLabel(m.plan.interval, m.plan.intervalCount)}
            {" · "}
            {m.collection === "card"
              ? m.cardLabel || t("Card not saved yet")
              : t("Paid by hand")}
          </span>
        </div>
        <span className={`invoice-status-pill ${statusPillClass(m.status)}`}>{statusLabel(m)}</span>
      </div>

      <dl className="membership-facts">
        <div>
          <dt>{t("Started")}</dt>
          <dd>{dateLabel(m.startedAt)}</dd>
        </div>
        {live && m.currentPeriodEnd ? (
          <div>
            <dt>{m.cancelAtPeriodEnd ? t("Ends") : t("Current period ends")}</dt>
            <dd>{dateLabel(m.currentPeriodEnd)}</dd>
          </div>
        ) : null}
        {m.nextChargeAt ? (
          <div>
            <dt>{t("Next charge")}</dt>
            <dd>{dateLabel(m.nextChargeAt)}</dd>
          </div>
        ) : null}
        {m.endedAt ? (
          <div>
            <dt>{t("Ended")}</dt>
            <dd>{dateLabel(m.endedAt)}</dd>
          </div>
        ) : null}
        {m.outstandingCents > 0 ? (
          <div>
            <dt>{t("Owing")}</dt>
            <dd className="membership-owing">{money(m.outstandingCents)}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t("Paid periods")}</dt>
          <dd>
            {m.plan.termCycles
              ? t("{paid} of {term}", { paid: m.paidCycles, term: m.plan.termCycles })
              : m.paidCycles}
          </dd>
        </div>
      </dl>

      {m.plan.entitlements.length ? (
        <p className="membership-entitlements">
          {m.plan.entitlements
            .map((entitlement) =>
              tn(entitlement.credits, "{count} credit each period", "{count} credits each period") +
              (entitlement.name ? ` · ${entitlement.name}` : ""),
            )
            .join("  ·  ")}
        </p>
      ) : null}

      {m.status === "past_due" && outstanding[0]?.lastError ? (
        <p className="membership-warning">
          {t("Last attempt: {error}", { error: outstanding[0].lastError })}
        </p>
      ) : null}
      {m.status === "paused" && m.cancelReason === "payment_failed" ? (
        <p className="membership-warning">{t("Paused after the card failed several times. Update the card or record the payment, then resume.")}</p>
      ) : null}
      {m.status === "incomplete" ? (
        <p className="field-help">{t("Waiting for the member to save a card. Nothing is charged or given until they do.")}</p>
      ) : null}

      <div className="membership-actions">
        {m.status === "past_due" && m.collection === "card" ? (
          <button type="button" className="outline-button" disabled={Boolean(busy)} onClick={() => act("retry", t("Payment retried."))}>
            <RotateCcw size={14} /> {t("Retry payment now")}
          </button>
        ) : null}
        {m.status === "paused" ? (
          <button type="button" className="outline-button" disabled={Boolean(busy)} onClick={() => act("resume", t("Membership resumed."))}>
            {t("Resume")}
          </button>
        ) : null}
        {live && !m.cancelAtPeriodEnd ? (
          <button
            type="button"
            className="outline-button"
            disabled={Boolean(busy)}
            onClick={() => act("cancel_at_period_end", t("It will end when the current period does."))}
          >
            {t("Cancel at period end")}
          </button>
        ) : null}
        {live && m.cancelAtPeriodEnd ? (
          <button type="button" className="outline-button" disabled={Boolean(busy)} onClick={() => act("undo_cancel", t("Cancellation undone."))}>
            {t("Keep membership")}
          </button>
        ) : null}
        {live ? (
          <button type="button" className="outline-button" disabled={Boolean(busy)} onClick={() => act("pause", t("Membership paused."))}>
            {t("Pause")}
          </button>
        ) : null}
        {(live || m.status === "paused" || m.status === "incomplete") && m.status !== "cancelled" ? (
          <>
            <button type="button" className="outline-button" disabled={Boolean(busy)} onClick={() => void makeCardLink()}>
              <CreditCard size={14} /> {m.collection === "card" && m.cardLabel ? t("Change card link") : t("Card link")}
            </button>
            {m.collection === "card" ? (
              <button type="button" className="outline-button" disabled={Boolean(busy)} onClick={() => act("use_manual", t("Now collected by hand."))}>
                {t("Collect by hand instead")}
              </button>
            ) : null}
          </>
        ) : null}
        {live || m.status === "paused" || m.status === "incomplete" ? (
          <button
            type="button"
            className="danger-button"
            disabled={Boolean(busy)}
            onClick={() =>
              act(
                "end_now",
                t("Membership ended."),
                t("End this membership now? Nothing more will be charged, and its unused credits stop today."),
              )
            }
          >
            {t("End now")}
          </button>
        ) : null}
      </div>

      {cardLink ? (
        <div className="settings-field membership-card-link">
          <span>{t("Card link")}</span>
          <input readOnly value={cardLink} onFocus={(event) => event.currentTarget.select()} />
        </div>
      ) : null}

      {outstanding.map((charge) => (
        <div key={charge.id} className="membership-due-row">
          <div>
            <strong>{money(charge.amountCents)}</strong>
            <span>
              {dateLabel(charge.periodStart)} – {dateLabel(charge.periodEnd)} · {chargeStatusLabel(charge)}
            </span>
          </div>
          {payingId === charge.id ? (
            <div className="membership-pay-form">
              <select value={payVia} onChange={(event) => setPayVia(event.target.value)} aria-label={t("Paid with")}>
                {PAYMENT_METHODS.map((method) => (
                  <option key={method.value} value={method.value}>
                    {method.label()}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="primary-button"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run("pay", () => membershipsApi.charge(charge.id, "mark_paid", payVia), t("Payment recorded.")).then(() =>
                    setPayingId(""),
                  )
                }
              >
                {t("Record payment")}
              </button>
              <button type="button" className="link-button" onClick={() => setPayingId("")}>
                {t("Back")}
              </button>
            </div>
          ) : (
            <div className="membership-pay-form">
              <button type="button" className="outline-button" disabled={Boolean(busy)} onClick={() => setPayingId(charge.id)}>
                {t("Mark paid")}
              </button>
              <button
                type="button"
                className="link-button"
                disabled={Boolean(busy)}
                onClick={() => void run("waive", () => membershipsApi.charge(charge.id, "waive"), t("Waived. The period's credits were given."))}
              >
                {t("Waive")}
              </button>
              <button
                type="button"
                className="link-button"
                disabled={Boolean(busy)}
                onClick={() => {
                  if (!window.confirm(t("Cancel this charge? The member owes nothing for this period and gets no credits for it."))) return;
                  void run("void", () => membershipsApi.charge(charge.id, "void"), t("Charge cancelled."));
                }}
              >
                {t("Cancel charge")}
              </button>
            </div>
          )}
        </div>
      ))}

      {m.charges.length ? (
        <div className="membership-history">
          <button
            type="button"
            className="link-button"
            aria-expanded={chargesVisible}
            onClick={() => setChargesVisible((value) => !value)}
          >
            {chargesVisible ? t("Hide payment history") : t("Payment history ({count})", { count: m.charges.length })}
          </button>
          {chargesVisible ? (
            <table className="recent-invoices-table membership-charges">
              <thead>
                <tr>
                  <th>{t("Period")}</th>
                  <th>{t("Amount")}</th>
                  <th>{t("Status")}</th>
                  <th>{t("Paid")}</th>
                </tr>
              </thead>
              <tbody>
                {m.charges.map((charge) => (
                  <tr key={charge.id}>
                    <td>
                      {charge.cycleNumber === 0 ? `${t("Trial")} · ` : ""}
                      {dateLabel(charge.periodStart)} – {dateLabel(charge.periodEnd)}
                    </td>
                    <td>{money(charge.amountCents)}</td>
                    <td>{chargeStatusLabel(charge)}</td>
                    <td>{dateLabel(charge.paidAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
