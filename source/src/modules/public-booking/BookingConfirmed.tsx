// What the booker sees once their booking is made: the booking, each friend
// on a group booking with a way to send them their invite, and paying -- now
// or on the day. The booking is already made by the time this shows; nothing
// here can unmake it, and nothing here is required.
import { useEffect, useRef, useState } from "react";
import { Check, Mail, Share2, X } from "lucide-react";
import { apiFetch } from "../auth/apiFetch";
import { money, type Account } from "./BookingFrame";
import { t } from "../../lib/i18n";

export type ConfirmedFriend = { id: string; name: string; url: string };
export type ConfirmedGroup = { payment: "booker" | "split"; total: number; attendees: ConfirmedFriend[] };
export type ConfirmedBooking = {
  appointmentId: string;
  /** What the screen acts with. Empty if the server could not issue one: then there is nothing to send with. */
  token: string;
  lessonName: string;
  when: string;
  business: string;
  booker: { name: string; email: string };
  group: ConfirmedGroup | null;
  /** What the booker pays if they pay online. 0: nothing to pay (a free lesson). */
  amountDue: number;
  /** The lesson's price as the page quotes it, for a private lesson. */
  priceLabel: string;
};

type Invite = { method: "email" | "link"; email?: string };
const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function initial(name: string) {
  return (name.trim()[0] || "?").toUpperCase();
}

export function BookingConfirmed({ booking, account, onlinePayments, api, onBookAnother, onDone }: {
  booking: ConfirmedBooking;
  account: Account;
  onlinePayments: boolean;
  api: (path: string) => string;
  onBookAnother: () => void;
  onDone?: () => void;
}) {
  const group = booking.group;
  const split = group?.payment === "split";
  const size = group ? group.attendees.length + 1 : 1;
  const share = group && size ? Math.round((group.total / size) * 100) / 100 : 0;
  const bookerFirst = booking.booker.name.trim().split(/\s+/)[0] || t("Your friend");

  const [invites, setInvites] = useState<Record<string, Invite>>({});
  const [openId, setOpenId] = useState("");
  const [emailMode, setEmailMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [inviteError, setInviteError] = useState("");

  const [payChoice, setPayChoice] = useState<"now" | "day" | "">("");
  const [payState, setPayState] = useState<"idle" | "starting" | "waiting" | "paid">("idle");
  const [payError, setPayError] = useState("");
  const [payUrl, setPayUrl] = useState("");
  const polling = useRef<number | null>(null);

  const post = async (path: string, body: Record<string, unknown>) => {
    const response = await apiFetch(api(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ booking: booking.appointmentId, token: booking.token, ...body }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.message || t("Something went wrong. Please try again."));
    return data;
  };

  const toggle = (id: string) => {
    setInviteError("");
    setEmailMode(false);
    setDraft(invites[id]?.email ?? "");
    setOpenId((current) => (current === id ? "" : id));
  };

  async function sendEmail(friend: ConfirmedFriend) {
    const email = draft.trim();
    if (!VALID_EMAIL.test(email) || sending) return;
    setSending(true); setInviteError("");
    try {
      await post("/api/public-booking-invite", { attendeeId: friend.id, method: "email", email });
      setInvites((current) => ({ ...current, [friend.id]: { method: "email", email } }));
      setOpenId(""); setEmailMode(false); setDraft("");
    } catch (cause) {
      setInviteError(cause instanceof Error ? cause.message : t("The invite could not be sent."));
    } finally {
      setSending(false);
    }
  }

  // The share sheet has to open straight from the tap -- Safari refuses one
  // that waits on the network -- so it opens first with the link already in
  // hand, and the server only hears afterwards that it went.
  async function shareLink(friend: ConfirmedFriend) {
    setInviteError("");
    const first = friend.name.trim().split(/\s+/)[0];
    const message = [
      first ? t("Hi {name},", { name: first }) : "",
      t("{booker} booked you into {lesson} with {business}, {when}.", { booker: bookerFirst, lesson: booking.lessonName, business: booking.business, when: booking.when }),
      split
        ? t("Your share is {share}. Pay and confirm your spot here:", { share: money(share, account) })
        : t("It's covered. Confirm your spot here:"),
    ].filter(Boolean).join(" ");
    let shared = false;
    try {
      if (navigator.share) {
        await navigator.share({ title: booking.lessonName, text: message, url: friend.url });
        shared = true;
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
    }
    if (!shared) {
      try {
        await navigator.clipboard.writeText(`${message}\n${friend.url}`);
        shared = true;
      } catch {
        setInviteError(t("Copy this link and send it to {name}: {url}", { name: friend.name, url: friend.url }));
        return;
      }
    }
    setInvites((current) => ({ ...current, [friend.id]: { method: "link" } }));
    setOpenId("");
    // Recording it is for the coach's view; the friend already has their link.
    post("/api/public-booking-invite", { attendeeId: friend.id, method: "link" }).catch(() => {});
  }

  const checkPaid = async () => {
    try {
      const data = await post("/api/public-booking-pay", { action: "status" });
      if (data.paid) {
        setPayState("paid");
        if (polling.current) window.clearInterval(polling.current);
        polling.current = null;
      }
    } catch {
      // Still waiting; the next check will tell.
    }
  };

  // Stripe opens in a tab of its own so this screen, and the invites on it,
  // stay put. It is opened inside the tap (a popup opened later is blocked) and
  // pointed at the payment once the server has it.
  async function payNow() {
    if (payState === "starting") return;
    setPayError(""); setPayState("starting");
    const tab = window.open("", "_blank");
    try {
      const data = await post("/api/public-booking-pay", { action: "start" });
      if (data.paid) { tab?.close(); setPayState("paid"); return; }
      // No tab (a pop-up blocker): Stripe will not load inside this page, so
      // the screen offers a plain link to it instead -- a tapped link opens.
      if (tab) tab.location.href = data.payUrl;
      setPayUrl(data.payUrl);
      setPayState("waiting");
      if (!polling.current) polling.current = window.setInterval(checkPaid, 4000);
    } catch (cause) {
      tab?.close();
      setPayState("idle");
      setPayError(cause instanceof Error ? cause.message : t("Payment could not be started. You can pay on the day."));
    }
  }

  useEffect(() => {
    const onFocus = () => { if (payState === "waiting") void checkPaid(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [payState]);
  useEffect(() => () => { if (polling.current) window.clearInterval(polling.current); }, []);

  const canAct = Boolean(booking.token);
  const offerPayment = booking.amountDue > 0;
  const dueLabel = group ? money(booking.amountDue, account) : booking.priceLabel || money(booking.amountDue, account);
  const bookerSub = payState === "paid"
    ? t("Paid {amount}", { amount: dueLabel })
    : payChoice === "day"
      ? t("Paying {amount} on the day", { amount: dueLabel })
      : booking.booker.email;

  return <div className="booking-confirmed">
    <div className="booking-card booking-confirmed-summary">
      <dl>
        <div><dt>{t("Lesson")}</dt><dd>{booking.lessonName}</dd></div>
        <div><dt>{t("When")}</dt><dd>{booking.when}</dd></div>
        {group ? <div><dt>{t("Total")}</dt><dd>{split ? t("{total} · {share} each", { total: money(group.total, account), share: money(share, account) }) : t("{total} · covered by you", { total: money(group.total, account) })}</dd></div> : null}
      </dl>
    </div>

    {group ? <section className="booking-confirmed-section" aria-labelledby="booking-group-heading">
      <h2 id="booking-group-heading">{t("Your group")}</h2>
      <p className="booking-confirmed-help">{canAct
        ? split
          ? t("Send each person their invite by email, or share their own link. Each invite carries their {share} share, which they can pay through it or on the day.", { share: money(share, account) })
          : t("You're covering everyone, so each invite just asks them to confirm their spot.")
        : t("Your coach has everyone's names. Ask them if you'd like invites sent.")}</p>
      <div className="booking-person is-booker">
        <span className="booking-person-initial" aria-hidden="true">{initial(booking.booker.name)}</span>
        <span className="booking-person-text"><strong>{t("{name} (you)", { name: booking.booker.name })}</strong><small>{bookerSub}</small></span>
      </div>
      {group.attendees.map((friend) => {
        const invite = invites[friend.id];
        const open = openId === friend.id;
        const email = invite?.email ?? "";
        const sub = !invite
          ? split ? t("{share} share", { share: money(share, account) }) : t("Covered by {name}", { name: bookerFirst })
          : invite.method === "email"
            ? split ? t("Pay link emailed to {email}", { email }) : t("Invite emailed to {email}", { email })
            : split ? t("Pay link shared") : t("Invite shared");
        const validDraft = VALID_EMAIL.test(draft.trim());
        return <div className={`booking-person${open ? " is-open" : ""}`} key={friend.id}>
          <div className="booking-person-row">
            <span className="booking-person-initial" aria-hidden="true">{initial(friend.name)}</span>
            <span className="booking-person-text"><strong>{friend.name}</strong><small>{sub}</small></span>
            {canAct ? <button
              aria-expanded={open}
              aria-label={open ? t("Close invite options") : invite ? t("Sent. Send {name}'s invite again", { name: friend.name }) : t("Invite {name}", { name: friend.name })}
              className={`booking-person-invite${invite && !open ? " is-sent" : ""}`}
              onClick={() => toggle(friend.id)}
              type="button"
            >{open ? t("Close") : invite ? <><Check size={16} />{t("Sent")}</> : t("Invite")}</button> : null}
          </div>
          {open ? <div className="booking-person-panel">
            <div className="booking-person-methods">
              <button aria-pressed={emailMode} className={emailMode ? "is-chosen" : ""} onClick={() => setEmailMode(true)} type="button"><Mail size={17} />{t("Email")}</button>
              <button onClick={() => void shareLink(friend)} type="button"><Share2 size={17} />{t("Share link")}</button>
            </div>
            {emailMode ? <div className="booking-person-email">
              <input aria-label={t("Email for {name}", { name: friend.name })} autoComplete="off" autoFocus inputMode="email" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void sendEmail(friend); }} placeholder={t("Their email")} type="email" value={draft} />
              <button className="primary-button" disabled={!validDraft || sending} onClick={() => void sendEmail(friend)} type="button">{sending ? t("Sending…") : t("Send")}</button>
            </div> : null}
            {inviteError ? <p className="email-status failed" role="alert"><X size={17} />{inviteError}</p> : null}
          </div> : null}
        </div>;
      })}
    </section> : null}

    {offerPayment ? <section className="booking-confirmed-section" aria-labelledby="booking-pay-heading">
      <h2 id="booking-pay-heading">{t("Your payment")}</h2>
      <p className="booking-confirmed-help">{group ? (split ? t("Your share of the split") : t("You're covering the whole group")) : booking.lessonName}</p>
      {payState === "paid" ? <p className="booking-paid" role="status"><Check size={18} /><strong>{t("Paid {amount}", { amount: dueLabel })}</strong><small>{t("Receipt emailed")}</small></p>
        : onlinePayments && canAct ? <div className="booking-pay-options" role="radiogroup" aria-label={t("How do you want to pay?")}>
          <button aria-checked={payChoice === "now"} className={payChoice === "now" ? "is-chosen" : ""} onClick={() => setPayChoice("now")} role="radio" type="button">
            <span><strong>{t("Pay now")}</strong><small>{t("By card online")}</small></span><em>{dueLabel}</em>
          </button>
          <button aria-checked={payChoice === "day"} className={payChoice === "day" ? "is-chosen" : ""} onClick={() => setPayChoice("day")} role="radio" type="button">
            <span><strong>{t("Pay on the day")}</strong><small>{t("Pay at the lesson")}</small></span>
          </button>
          {payChoice === "now" && payState === "waiting" && payUrl
            ? <a className="primary-button" href={payUrl} rel="noopener" target="_blank">{t("Open payment again")}</a>
            : payChoice === "now" ? <button className="primary-button" disabled={payState === "starting"} onClick={() => void payNow()} type="button">{payState === "starting" ? t("Opening payment…") : t("Pay {amount}", { amount: dueLabel })}</button> : null}
          {payState === "waiting" ? <p className="booking-confirmed-help" role="status">{t("Finish paying in the tab that opened. This updates once it's through.")}</p> : null}
          {payError ? <p className="email-status failed" role="alert"><X size={17} />{payError}</p> : null}
        </div>
        : <p className="booking-confirmed-help">{t("Pay {amount} at the lesson.", { amount: dueLabel })}</p>}
    </section> : null}

    <div className="booking-confirmed-bar" role="status">
      <span className="booking-confirmed-tick" aria-hidden="true"><Check size={18} /></span>
      <span className="booking-person-text"><strong>{t("Booking confirmed")}</strong><small>{booking.booker.email ? t("Confirmation emailed to {email}", { email: booking.booker.email }) : t("Your confirmation is on its way by email.")}</small></span>
      <button className="booking-progressive-change" onClick={onDone ?? onBookAnother} type="button">{onDone ? t("Done") : t("Book another")}</button>
    </div>
  </div>;
}
