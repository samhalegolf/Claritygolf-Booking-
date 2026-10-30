import "../../appStyles";
import { Loading, loadingLabel } from "../shared/Loading";
import { useEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, Pencil, Plus, X } from "lucide-react";
import { apiFetch } from "../auth/apiFetch";
import { appearsOnCurrentPublicBookingScreen, publicApi, publicBookingRoute, publicShopHref, withBusiness } from "./bookingScreen";
import { WeekSlots } from "./WeekSlots";
import { BookingFrame, money, quotedMoney, type Account, type Brand } from "./BookingFrame";
import { BookingConfirmed, type ConfirmedBooking, type ConfirmedGroup, type ConfirmedPayment } from "./BookingConfirmed";
import { forgetRememberedBooker, readRememberedBooker, saveRememberedBooker, type RememberedBooker } from "./rememberedBooker";
import { resolvedMarketFromWire } from "../../../netlify/functions/_shared/market-profile.mts";
import { t, tn, readerLocale } from "../../lib/i18n";
import { calculateCustomGroupPrice, customGroupMaxParticipants, customGroupMinParticipants, type Service as ModelService } from "../services/serviceModel";

type Service = { id: string; name: string; duration: number; price: number; priceMode?: string; description?: string; lessonNote?: string; location?: string; lessonFormat?: string; reviewTurnaroundDays?: number; customGroup?: boolean; customGroupEnabled?: boolean; minParticipants?: number; capacity?: number; baseParticipants?: number; basePrice?: number; extraPersonPrice?: number; coachIds?: string[]; bookingScreenIds?: string[] };
/** A coach as the public catalogue names them: no contact details. */
type Coach = { id: string; name: string; photoUrl?: string };
/** Someone the booker is bringing to a custom group: just a name before booking. Their invite is sent from the confirmation screen. `editing` is the name's field being open rather than folded into its card. */
type Attendee = { name: string; handedness: Handedness; editing: boolean };
type GroupPayment = "booker" | "split";
type Slot = { week: number; day: number; start: number; remainingSpots?: number; locationId?: string; coachId?: string };
type Form = { firstName: string; lastName: string; phone: string; email: string };
export type PublicBookingCustomer = { name?: string; email?: string; phone?: string };
export type PublicBookingAppProps = {
  customer?: PublicBookingCustomer;
  onBookingComplete?: () => void;
  /** The Player Portal's business. The public page reads it from its URL instead. */
  accountId?: string;
};

const BASE_WEEK_START = new Date(2026, 5, 1);

function currentWeek() {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() + (day === 0 ? -6 : 1 - day));
  return Math.round((monday.getTime() - BASE_WEEK_START.getTime()) / 604800000);
}
function dateFor(week: number, day: number) { const date = new Date(BASE_WEEK_START); date.setDate(date.getDate() + week * 7 + day); return date; }
function time(minutes: number) { const hour = Math.floor(minutes / 60); return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`; }
/** What the booker pays of a split group: the total less everyone else's rounded share. */
function bookerSplitShare(total: number, size: number) {
  return Math.round((total - Math.round((total / size) * 100) / 100 * (size - 1)) * 100) / 100;
}

/** The lesson's price in the business's own currency, with its tax named when
 *  prices are quoted before it ("$80 + GST"), and "per person" when that is
 *  how the coach priced it. */
function price(service: Service, account: Account) {
  if (service.priceMode === "free" || !service.price) return t("Free");
  const quoted = quotedMoney(service.price, account);
  return service.priceMode === "per-person" ? t("{price} per person", { price: quoted }) : quoted;
}
/** What the player is told a review will be back by. The server sets the real
 *  deadline at booking; this is the same sum a day earlier or later at worst,
 *  and it is shown so nobody confirms without knowing when they get it back. */
function reviewDueDate(service: Service) {
  const days = Math.max(1, Math.min(30, Math.round(service.reviewTurnaroundDays ?? 3)));
  const due = new Date(Date.now() + days * 86400000);
  return { days, label: due.toLocaleDateString(readerLocale(), { weekday: "long", month: "short", day: "numeric" }) };
}
type Handedness = "right" | "left";
/** What each side means, for players who have never had to say. Shown on hover
 *  and read out as the option's description. */
const NO_BAY_FOR_SWING = t("No bay is free at that time for your swing. Please pick another time above.");

const handednessOptions: Array<{ value: Handedness; label: string; short: string; explainer: string }> = [
  { value: "right", label: t("Right handed"), short: t("R"), explainer: t("You stand on the left side of the ball, with your left shoulder closest to the target. Most players swing this way.") },
  { value: "left", label: t("Left handed"), short: t("L"), explainer: t("You stand on the right side of the ball, with your right shoulder closest to the target. We'll book you into one of our left-handed-friendly bays.") },
];
function manageBookingUrl() { const url = new URL(location.href); url.searchParams.set("embed", "booking"); url.searchParams.set("mode", "reschedule"); return url.toString(); }

/** Customer-only booking surface.  It intentionally owns no coach session,
 * calendar, CRM, video, or admin document hooks. The one thing it keeps in
 * the browser is "remember me" (see rememberedBooker.ts). */
function rememberedForm(booker: RememberedBooker): Form {
  return { firstName: booker.firstName, lastName: booker.lastName, phone: booker.phone, email: booker.email };
}
function customerForm(customer?: PublicBookingCustomer): Form {
  const names = (customer?.name ?? "").trim().split(/\s+/).filter(Boolean);
  return { firstName: names[0] ?? "", lastName: names.slice(1).join(" "), phone: customer?.phone ?? "", email: customer?.email ?? "" };
}

/** The catalogue's lesson type, read by the shared custom group pricing rules. */
function groupModel(service: Service) {
  return service as unknown as Partial<ModelService>;
}
const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function blankAttendees(service: Service | null): Attendee[] {
  if (!service || !(service.customGroup || service.customGroupEnabled)) return [];
  // One row per person still needed to make the group up.
  return Array.from({ length: Math.max(1, customGroupMinParticipants(groupModel(service)) - 1) }, () => blankAttendee());
}
function blankAttendee(): Attendee { return { name: "", handedness: "right", editing: true }; }

/** A player's swing as the app's small two-way pill switch (the theme
 *  switch's look): one press flips it. The initials keep it narrow; the full
 *  label and explainer are its name and tip. */
function SwingToggle({ value, onChange, label }: { value: Handedness; onChange: (next: Handedness) => void; label: string }) {
  const current = handednessOptions.find((option) => option.value === value) ?? handednessOptions[0];
  return <button aria-label={`${label}: ${current.label}`} className="booking-swing" onClick={() => onChange(value === "left" ? "right" : "left")} title={`${current.label}. ${current.explainer}`} type="button">
    {handednessOptions.map((option) => <span aria-hidden="true" className={option.value === value ? "active" : ""} key={option.value}>{option.short}</span>)}
  </button>;
}

/**
 * Who is coming to a custom group, and who is paying. The booker is the first
 * place in the list, and their details (or the fields for them) live there
 * rather than above it, so a signed-in player sees their name once. Then a card
 * per other person: just a name before booking, folding into a name card once
 * it is in, with their swing where the business asks. Invites go out from the
 * confirmation screen, so no one's email is asked for here.
 *
 * Underneath: the price for the group as it stands, and whether the booker is
 * paying for everyone or splitting it. That has to be settled before booking,
 * because it decides what each friend's invite says.
 */
function GroupAttendees({ service, account, booker, bookerSwing, askHandedness, attendees, onChange, groupPayment, onGroupPayment }: { service: Service; account: Account; booker: ReactNode; bookerSwing: ReactNode; askHandedness: boolean; attendees: Attendee[]; onChange: (next: Attendee[]) => void; groupPayment: GroupPayment | ""; onGroupPayment: (next: GroupPayment) => void }) {
  const model = groupModel(service);
  const min = customGroupMinParticipants(model);
  const max = customGroupMaxParticipants(model);
  const size = 1 + attendees.filter((attendee) => attendee.name.trim()).length;
  const total = calculateCustomGroupPrice(model, size);
  const share = Math.round((total / size) * 100) / 100;
  const update = (index: number, patch: Partial<Attendee>) => onChange(attendees.map((attendee, position) => (position === index ? { ...attendee, ...patch } : attendee)));
  // A new card folds every name already in, so only the one being typed is open.
  const addPerson = () => onChange([...attendees.map((attendee) => (attendee.name.trim() ? { ...attendee, editing: false } : attendee)), blankAttendee()]);
  return <div className={`booking-form booking-group${askHandedness ? " has-swing" : ""}`}>
    <div className="booking-group-head"><span>{t("Who's coming")}</span>{askHandedness ? <span className="booking-group-col-head">{t("Swing")}</span> : null}</div>
    <div className="booking-group-booker">
      <div className="booking-group-row"><strong className="booking-group-name">{t("You")}</strong>{bookerSwing}</div>
      {booker}
    </div>
    {attendees.map((attendee, index) => {
      const label = attendee.name.trim() || t("Person {number}", { number: index + 2 });
      const folded = !attendee.editing && Boolean(attendee.name.trim());
      return <div className="booking-group-row" key={index}>
        {folded
          ? <button aria-label={t("Edit {name}", { name: label })} className="booking-group-card" onClick={() => update(index, { editing: true })} type="button"><span aria-hidden="true">{(attendee.name.trim()[0] || "?").toUpperCase()}</span><strong>{attendee.name.trim()}</strong><Pencil size={15} /></button>
          : <input aria-label={t("Name of person {number}", { number: index + 2 })} autoComplete="off" autoFocus={index > 0 && !attendee.name} className="booking-group-name" onBlur={() => { if (attendee.name.trim()) update(index, { editing: false }); }} onChange={(event) => update(index, { name: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter" && attendee.name.trim()) update(index, { editing: false }); }} placeholder={t("Name")} value={attendee.name} />}
        {askHandedness ? <SwingToggle onChange={(handedness) => update(index, { handedness })} value={attendee.handedness} label={t("Which way {name} swings", { name: label })} /> : null}
        <button aria-label={t("Remove {name}", { name: label })} className="booking-group-remove" disabled={attendees.length <= 1} onClick={() => onChange(attendees.filter((_, position) => position !== index))} type="button"><X size={15} /></button>
      </div>;
    })}
    <button className="booking-group-add" disabled={1 + attendees.length >= max} onClick={addPerson} type="button"><Plus size={15} />{1 + attendees.length >= max ? t("Group full ({max})", { max }) : t("Add person")}</button>
    <p className="booking-group-summary">
      <strong>{tn(size, "{count} person", "{count} people")} · {quotedMoney(total, account)}</strong>
      {size < min ? <span>{tn(min - size, "Add {count} more person to book this lesson.", "Add {count} more people to book this lesson.")}</span> : <span>{t("Up to {max} people.", { max })}</span>}
    </p>
    <fieldset className="booking-group-payment">
      <legend>{t("Who's paying?")}</legend>
      <div role="radiogroup" aria-label={t("Who's paying?")}>
        <button aria-checked={groupPayment === "booker"} className={groupPayment === "booker" ? "is-chosen" : ""} onClick={() => onGroupPayment("booker")} role="radio" type="button">
          <span><strong>{t("I'll pay for everyone")}</strong><small>{t("Friends just get an invite")}</small></span><em>{quotedMoney(total, account)}</em>
        </button>
        <button aria-checked={groupPayment === "split"} className={groupPayment === "split" ? "is-chosen" : ""} onClick={() => onGroupPayment("split")} role="radio" type="button">
          <span><strong>{tn(size, "Split it {count} way", "Split it {count} ways")}</strong><small>{t("Friends get an invite with a pay link")}</small></span><em>{t("{share} each", { share: quotedMoney(share, account) })}</em>
        </button>
      </div>
    </fieldset>
  </div>;
}

export default function PublicBookingApp({ customer, onBookingComplete, accountId }: PublicBookingAppProps) {
  const api = (path: string) => (accountId ? withBusiness(path, accountId) : publicApi(path));
  const [catalogue, setCatalogue] = useState<{ services: Service[]; coaches: Coach[]; brand: Brand; account: Account; shopLinked: boolean; onlinePayments: boolean }>({ services: [], coaches: [], brand: {}, account: {}, shopLinked: false, onlinePayments: false });
  // "missing" is a link the server cannot match to a business -- an old embed
  // that does not name one, say. Trying again will not fix it, so it says so.
  const [catalogueState, setCatalogueState] = useState<"loading" | "ready" | "error" | "missing">("loading");
  const [week, setWeek] = useState(currentWeek);
  const [slotsByService, setSlotsByService] = useState<Record<string, Slot[]>>({});
  const [slotsState, setSlotsState] = useState<"loading" | "ready" | "error">("loading");
  const [serviceId, setServiceId] = useState("");
  const [slot, setSlot] = useState<Slot | null>(null);
  // The coach the player picked, for a lesson type taught by more than one.
  // Blank is anyone: each time then goes to whoever is free.
  const [coachId, setCoachId] = useState("");
  // Remember me is for the public page and widget only. The Player Portal
  // passes its signed-in customer and has a proper login of its own.
  const [remembered, setRemembered] = useState<RememberedBooker | null>(() => (customer ? null : readRememberedBooker()));
  // On unless the player unticks it -- a shared computer at the club, say.
  const [rememberMe, setRememberMe] = useState(true);
  // The booker's fields fold into a card once their name and email are in and
  // they click away; the card opens them again. True while they are typing.
  const [editingDetails, setEditingDetails] = useState(false);
  const bookerFields = useRef<HTMLDivElement>(null);
  // Booking for a partner or a friend, for this visit only. The remembered
  // player stays remembered, and this booking is not remembered over them.
  const [forSomeoneElse, setForSomeoneElse] = useState(false);
  const [form, setForm] = useState<Form>(() => (remembered ? rememberedForm(remembered) : customerForm(customer)));
  const [handedness, setHandedness] = useState<Handedness>(() => remembered?.handedness ?? "right");
  const [notes, setNotes] = useState("");
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  // A custom group's "who's paying?", required before it can be booked.
  const [groupPayment, setGroupPayment] = useState<GroupPayment | "">("");
  // Pay now (by card online) or on the day, chosen before confirming: paying
  // now goes straight to the payment once the booking is made.
  const [payChoice, setPayChoice] = useState<ConfirmedPayment["choice"] | "">("");
  // The booking just made, for the confirmation screen to act on.
  const [confirmed, setConfirmed] = useState<ConfirmedBooking | null>(null);
  const [submitState, setSubmitState] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    apiFetch(api("/api/public-booking-catalog"))
      .then(async (response) => { if (response.status === 404) throw new Error("missing"); if (!response.ok) throw new Error(t("Booking is unavailable.")); return response.json(); })
      .then((data) => { if (!cancelled) { setCatalogue({ services: Array.isArray(data.services) ? data.services : [], coaches: Array.isArray(data.coaches) ? data.coaches : [], brand: data.brand ?? {}, account: data.account ?? {}, shopLinked: data.shopLinked === true, onlinePayments: data.onlinePayments === true }); setCatalogueState("ready"); } })
      .catch((cause) => { if (!cancelled) setCatalogueState(cause instanceof Error && cause.message === "missing" ? "missing" : "error"); });
    return () => { cancelled = true; };
  }, []);

  // Player Portal profile loading finishes after its booking subtab mounts.
  // Fill the verified identity when it arrives, without putting it in a URL
  // or asking a signed-in player to type it again.
  useEffect(() => {
    if (!customer?.email) return;
    setForm(customerForm(customer));
  }, [customer?.name, customer?.email, customer?.phone]);

  useEffect(() => {
    let cancelled = false;
    setSlotsState("loading");
    // Deliberately one request for the active week. The endpoint returns every
    // public service keyed by id; do not turn this back into an N+1 loop.
    // Handedness decides which bays count as free where a business has
    // left- or right-handed-only bays, so a change re-asks for the week. So
    // does picking a coach: their times are asked for, not anyone's.
    apiFetch(api(`/api/public-booking-slots?week=${week}&handedness=${handedness}${coachId ? `&coachId=${encodeURIComponent(coachId)}` : ""}`))
      .then(async (response) => { if (!response.ok) throw new Error(t("Availability is unavailable.")); return response.json(); })
      .then((data) => {
        if (cancelled) return;
        const next: Record<string, Slot[]> = {};
        for (const [id, entry] of Object.entries(data.services ?? {})) next[id] = Array.isArray((entry as { slots?: Slot[] }).slots) ? (entry as { slots: Slot[] }).slots : [];
        setSlotsByService(next); setSlotsState("ready");
      })
      .catch(() => { if (!cancelled) setSlotsState("error"); });
    return () => { cancelled = true; };
  }, [week, handedness, coachId]);

  // A time picked as a right-hander may have no bay for a left-hander. Say so
  // here, where the player is, instead of letting Confirm fail. The time stays
  // chosen so this section stays open; picking another clears the message.
  useEffect(() => {
    if (!slot || slotsState !== "ready" || !serviceId) return;
    const stillOffered = (slotsByService[serviceId] ?? []).some(
      (candidate) => candidate.week === slot.week && candidate.day === slot.day && candidate.start === slot.start,
    );
    if (!stillOffered) setError(NO_BAY_FOR_SWING);
    else setError((current) => (current === NO_BAY_FOR_SWING ? "" : current));
  }, [slotsByService, slotsState]);

  // This is deliberately the same final derivation as App.tsx:
  // public catalogue -> public screen -> bookingScreenIds, including the
  // legacy missing-field fallback and the explicit-empty exclusion.
  const services = useMemo(() => catalogue.services.filter((service) => appearsOnCurrentPublicBookingScreen(service)), [catalogue.services]);
  const service = services.find((candidate) => candidate.id === serviceId) ?? null;
  // A review is booked without a time. Step 2 stops being a picker and becomes
  // a statement, and step 3 unlocks the moment a lesson type is chosen --
  // there is nothing in between to wait for.
  const videoReview = service?.lessonFormat === "video-review";
  const readyForDetails = Boolean(service && (videoReview || slot));
  const customGroup = service?.customGroup || service?.customGroupEnabled;
  const availableSlots = service ? slotsByService[service.id] ?? [] : [];
  const namedAttendees = attendees.filter((attendee) => attendee.name.trim());
  // What paying online would cost the booker, as the page quotes it: their
  // share of a split group, the whole group, or the lesson. The server works
  // out the real charge from the booking. Nothing owed, nothing to choose.
  const groupSizeNow = namedAttendees.length + 1;
  const groupTotalNow = customGroup && service ? calculateCustomGroupPrice(groupModel(service), groupSizeNow) : 0;
  const amountDueNow = !service || service.priceMode === "free" ? 0
    : customGroup ? (groupPayment === "split" ? bookerSplitShare(groupTotalNow, groupSizeNow) : groupPayment === "booker" ? groupTotalNow : 0)
    : Number(service.price) || 0;
  const payChoiceOffered = catalogue.onlinePayments && amountDueNow > 0;
  const dueLabelNow = service && !customGroup ? price(service, catalogue.account) : quotedMoney(amountDueNow, catalogue.account);
  const canSubmit = Boolean(service && (videoReview || slot) && form.firstName.trim() && form.lastName.trim() && form.email.trim() && (!customGroup || (namedAttendees.length + 1 >= customGroupMinParticipants(groupModel(service)) && groupPayment !== "")) && (!payChoiceOffered || payChoice !== ""));
  // The coaches the player can choose between: only where there is a choice,
  // and not for a review (no time to be anywhere) or a scheduled group (one
  // session, one coach).
  const scheduledGroup = service?.lessonFormat === "group" && !customGroup;
  const coachChoices = service && !videoReview && !scheduledGroup
    ? (service.coachIds ?? []).map((id) => catalogue.coaches.find((coach) => coach.id === id)).filter((coach): coach is Coach => Boolean(coach))
    : [];
  const slotCoach = slot && coachChoices.length > 1 ? catalogue.coaches.find((coach) => coach.id === slot.coachId) : undefined;
  const chooseService = (id: string) => { setServiceId(id); setSlot(null); setCoachId(""); setGroupPayment(""); setPayChoice(""); setAttendees(blankAttendees(services.find((candidate) => candidate.id === id) ?? null)); };
  const chooseCoach = (id: string) => { setCoachId(id); setSlot(null); };
  // Once a choice is made the other options step aside, so the player sees
  // only what they picked and the next thing to fill in. "Change" brings the
  // full list back.
  const changeButton = (onClick: () => void) => <button className="booking-progressive-change" onClick={onClick} type="button">{t("Change")}</button>;
  const forgetMe = () => { forgetRememberedBooker(); setRemembered(null); setEditingDetails(false); setForSomeoneElse(false); setForm(customerForm()); setHandedness("right"); };
  const bookForSomeoneElse = () => { setForSomeoneElse(true); setEditingDetails(false); setForm(customerForm()); setHandedness("right"); };
  const bookAsRemembered = () => { if (!remembered) return; setForSomeoneElse(false); setForm(rememberedForm(remembered)); setHandedness(remembered.handedness); };

  // The booking is made; now the payment for it, in the tab opened at the tap.
  // Never throws: the booking stands whatever happens here, and the confirmed
  // screen shows what did.
  async function startPayment(appointmentId: string, token: string, tab: Window | null): Promise<ConfirmedPayment> {
    if (!token) { tab?.close(); return { choice: "now" }; }
    try {
      const response = await apiFetch(api("/api/public-booking-pay"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ booking: appointmentId, token, action: "start" }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.message || t("Payment could not be started. You can pay on the day."));
      if (data.paid) { tab?.close(); return { choice: "now", paid: true }; }
      // No tab (a pop-up blocker): the confirmed screen offers a plain link instead.
      if (tab) tab.location.href = String(data.payUrl || "");
      return { choice: "now", payUrl: String(data.payUrl || "") };
    } catch (cause) {
      tab?.close();
      return { choice: "now", error: cause instanceof Error ? cause.message : t("Payment could not be started. You can pay on the day.") };
    }
  }

  async function submit() {
    if (!service || !canSubmit) return;
    if (!videoReview && !slot) return;
    setSubmitState("saving"); setError("");
    // Paying now: Stripe opens in a tab of its own, opened inside this tap (a
    // pop-up opened after the booking round trip is blocked) and pointed at
    // the payment once the booking exists and the server has it.
    const payTab = payChoiceOffered && payChoice === "now" ? window.open("", "_blank") : null;
    try {
      const response = await apiFetch(api("/api/public-booking"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serviceId: service.id, ...(videoReview || !slot ? {} : { week: slot.week, day: slot.day, start: slot.start, coachId: slot.coachId, locationId: slot.locationId, ...(coachId ? { coachChosen: true } : {}) }), duration: service.duration, ...form, ...(market.capabilities.handedness ? { handedness } : {}), notes: notes.trim() || undefined, attendees: customGroup ? namedAttendees.map((attendee) => ({ name: attendee.name.trim(), ...(market.capabilities.handedness ? { handedness: attendee.handedness } : {}) })) : undefined, ...(customGroup ? { groupPayment } : {}), ...(!customer && !forSomeoneElse && (remembered || rememberMe) ? { remember: true, rememberToken: remembered?.token } : {}) }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.appointment?.id) throw new Error(data.message || t("That time is no longer available."));
      if (typeof data.rememberToken === "string" && data.rememberToken) {
        const next: RememberedBooker = { token: data.rememberToken, firstName: form.firstName.trim(), lastName: form.lastName.trim(), phone: form.phone.trim(), email: form.email.trim(), handedness };
        saveRememberedBooker(next); setRemembered(next); setEditingDetails(false);
      }
      const group = data.group && Array.isArray(data.group.attendees) ? (data.group as ConfirmedGroup) : null;
      const groupSize = group ? group.attendees.length + 1 : 1;
      const token = typeof data.bookingToken === "string" ? data.bookingToken : "";
      const payment: ConfirmedPayment | null = !payChoiceOffered || !payChoice ? null
        : payChoice === "now" ? await startPayment(String(data.appointment.id), token, payTab)
        : { choice: "day" };
      setConfirmed({
        appointmentId: String(data.appointment.id),
        token,
        lessonName: service.name,
        when: videoReview || !slot ? t("Review due {date}", { date: reviewDueDate(service).label }) : `${dateFor(slot.week, slot.day).toLocaleDateString(readerLocale(), { weekday: "long", month: "short", day: "numeric" })}, ${time(slot.start)}`,
        business: brandName,
        booker: { name: `${form.firstName.trim()} ${form.lastName.trim()}`.trim(), email: form.email.trim() },
        group,
        // What paying online would cost them: their share, the whole group,
        // or the lesson. The server works out the real charge from the booking.
        amountDue: group ? (group.payment === "split" ? bookerSplitShare(group.total, groupSize) : group.total) : service.priceMode === "free" ? 0 : Number(service.price) || 0,
        priceLabel: group ? "" : price(service, catalogue.account),
        payment,
      });
      setSubmitState("done"); onBookingComplete?.();
    } catch (cause) { payTab?.close(); setError(cause instanceof Error ? cause.message : t("Could not confirm the booking.")); setSubmitState("error"); }
  }

  const weekLabel = `${dateFor(week, 0).toLocaleDateString(readerLocale(), { month: "short", day: "numeric" })} – ${dateFor(week, 6).toLocaleDateString(readerLocale(), { month: "short", day: "numeric" })}`;
  const theme = catalogue.brand.bookingTheme === "dark" ? "dark" : "light";
  // The business's words and modules; the platform's name only as a last
  // resort for a business that has not named itself yet.
  const market = resolvedMarketFromWire(catalogue.account.market, catalogue.account.terminology);
  const brandName = catalogue.account.businessName || catalogue.account.coachName || market.product.name;
  const terms = market.terminology;
  const askHandedness = market.capabilities.handedness;
  // The booker's details: a card once their name and email are in -- remembered,
  // signed in to the Player Portal, or just typed and clicked away from -- and
  // the fields otherwise. The card's chevron opens the fields again; leaving
  // them folds it back. A custom group shows this as the first place in its
  // list of who's coming, everything else above notes.
  const detailsComplete = Boolean(form.firstName.trim() && form.lastName.trim() && VALID_EMAIL.test(form.email.trim()));
  const openDetails = () => { setEditingDetails(true); requestAnimationFrame(() => bookerFields.current?.querySelector("input")?.focus()); };
  const leaveDetails = (event: FocusEvent<HTMLDivElement>) => { if (detailsComplete && !event.currentTarget.contains(event.relatedTarget)) setEditingDetails(false); };
  const bookerDetails = <>{remembered && forSomeoneElse ? <div className="booking-remembered"><p><strong>{t("Booking for someone else")}</strong></p><div className="booking-remembered-actions"><button className="booking-progressive-change" onClick={bookAsRemembered} type="button">{t("Book as {name} instead", { name: remembered.firstName })}</button></div></div> : null}{detailsComplete && !editingDetails ? <div className="booking-remembered"><button aria-expanded={false} aria-label={t("Edit details")} className="booking-remembered-card" onClick={openDetails} title={t("Edit details")} type="button"><span><strong>{t("Booking as {name}", { name: `${form.firstName} ${form.lastName}`.trim() })}</strong><small>{form.email}</small></span><ChevronDown size={18} /></button>{remembered && !forSomeoneElse ? <div className="booking-remembered-actions"><button className="booking-progressive-change" onClick={bookForSomeoneElse} type="button">{t("Book for someone else")}</button><button className="booking-progressive-change" onClick={forgetMe} type="button">{t("Forget me")}</button></div> : null}</div> : <div className="booking-booker-fields" onBlur={leaveDetails} onFocus={() => setEditingDetails(true)} ref={bookerFields}>{(["firstName", "lastName", "phone", "email"] as const).map((key) => <input className={key === "email" ? "w-email" : "w-name"} key={key} value={form[key]} type={key === "email" ? "email" : key === "phone" ? "tel" : "text"} autoComplete={key === "firstName" ? "given-name" : key === "lastName" ? "family-name" : key === "phone" ? "tel" : "email"} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} placeholder={key === "firstName" ? t("First name *") : key === "lastName" ? t("Last name *") : key === "phone" ? t("Phone") : t("Email *")} />)}</div>}{!customer && !remembered ? <label className="booking-remember"><input checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} type="checkbox" />{t("Remember me on this device")}</label> : null}</>;
  const swingChoice = askHandedness ? <fieldset className="booking-handedness"><legend>{t("Which way do you swing?")}</legend><div className="booking-handedness-options" role="radiogroup" aria-label={t("Handedness")}>{handednessOptions.map((option) => <button aria-checked={handedness === option.value} aria-describedby={`handedness-tip-${option.value}`} className={handedness === option.value ? "selected-handedness" : ""} key={option.value} onClick={() => setHandedness(option.value)} role="radio" type="button">{option.label}<span className="booking-handedness-tip" id={`handedness-tip-${option.value}`} role="tooltip">{option.explainer}</span></button>)}</div></fieldset> : null;
  const notesBox = <textarea aria-label={t("Notes for your {staffSingular}", { staffSingular: terms.staffSingular.toLowerCase() })} className="booking-notes" maxLength={800} onChange={(event) => setNotes(event.target.value)} placeholder={t("Notes for your {staffSingular} (optional) — anything useful before the booking", { staffSingular: terms.staffSingular.toLowerCase() })} value={notes} />;
  // The shop needs the business named in the path; a bare legacy link has none
  // to send it to. Not offered inside the Player Portal, which has its own shop.
  const shopBusiness = publicBookingRoute().business;
  const shopHref = catalogue.shopLinked && shopBusiness && !customer ? publicShopHref(shopBusiness) : "";
  if (catalogueState === "ready" && !market.capabilities.publicBooking) return <BookingFrame brand={catalogue.brand}><main className={`public-booking booking-theme-${theme}`}><div className="booking-brand"><strong>{brandName}</strong></div><div className="booking-card booking-confirmation"><h1>{t("This booking page is not available.")}</h1></div></main></BookingFrame>;
  const bookAnother = () => { setSubmitState("idle"); setConfirmed(null); setSlot(null); setNotes(""); setGroupPayment(""); setPayChoice(""); setAttendees(blankAttendees(service)); };
  if (submitState === "done" && confirmed) return <BookingFrame brand={catalogue.brand}><main className={`public-booking booking-theme-${theme}`}><div className="booking-brand"><strong>{brandName}</strong></div>{videoReview ? <p className="booking-confirmed-help">{t("Send your swing from the {customerSingular} portal whenever you are ready — your {staffSingular} works to the turnaround from there.", { customerSingular: terms.customerSingular.toLowerCase(), staffSingular: terms.staffSingular.toLowerCase() })}</p> : null}<BookingConfirmed account={catalogue.account} api={api} booking={confirmed} onBookAnother={bookAnother} onlinePayments={catalogue.onlinePayments} /></main></BookingFrame>;

  return <BookingFrame brand={catalogue.brand}><main className={`public-booking booking-theme-${theme}`}>
    <div className="booking-brand">{catalogue.brand.showLogo && catalogue.brand.logoPreview ? <img src={catalogue.brand.logoPreview} alt={t("{brandName} logo", { brandName })} /> : <strong>{brandName}</strong>}<em>{catalogue.account.venueShortName}</em></div>
    <div className="booking-toolbar">{shopHref ? <a className="booking-login-trigger" href={shopHref}>{t("Gift vouchers & packages")}</a> : null}<a className="booking-login-trigger" href={manageBookingUrl()}>{t("Manage / reschedule a booking")}</a></div>
    <div className="booking-columns booking-progressive-flow">
      <section className="booking-progressive-section is-open"><div className="booking-progressive-title"><span className="booking-progressive-title-label">1. {terms.serviceSingular}</span><span className="booking-progressive-title-state">{catalogueState === "loading" ? loadingLabel() : service ? changeButton(() => chooseService("")) : t("In progress")}</span></div><div className="booking-progressive-body"><div className="service-picker">{catalogueState === "missing" ? <p role="alert">{t("This booking page is not available. The link may be out of date: ask the business for its current booking link.")}</p> : catalogueState === "error" ? <p role="alert">{t("Booking is unavailable. Please try again shortly.")}</p> : catalogueState === "loading" ? <Loading what={t("{serviceSingular} types", { serviceSingular: terms.serviceSingular.toLowerCase() })} /> : services.length ? (service ? [service] : services).map((candidate) => <button className={candidate.id === serviceId ? "selected-service" : ""} key={candidate.id} onClick={() => chooseService(candidate.id === serviceId ? "" : candidate.id)} type="button"><strong>{candidate.name}</strong><em>{t("{duration} minutes @ {candidate}", { duration: candidate.duration, candidate: price(candidate, catalogue.account) })}</em>{candidate.description ? <small>{candidate.description}</small> : null}{candidate.lessonNote || candidate.location ? <small>{candidate.lessonNote || candidate.location}</small> : null}</button>) : <p>{t("No public {serviceSingular} types are active.", { serviceSingular: terms.serviceSingular.toLowerCase() })}</p>}</div></div></section>
      <section className={`booking-progressive-section ${service ? "is-open" : ""}`}><div className="booking-progressive-title"><span className="booking-progressive-title-label">{videoReview ? t("2. Turnaround") : t("2. Date & Time")}</span><span className="booking-progressive-title-state">{!service ? t("Locked") : videoReview ? t("No time needed") : slot ? changeButton(() => setSlot(null)) : slotsState === "loading" ? loadingLabel() : t("In progress")}</span></div>{service && videoReview ? <div className="booking-progressive-body"><div className="booking-review-turnaround"><p>{t("Send your swing from the player portal once you have booked. There is no appointment to attend.")}</p><p><strong>{t("Back with you by {label}", { label: reviewDueDate(service).label })}</strong>{" "}{reviewDueDate(service).days === 1 ? t("— within 1 day.") : t("— within {days} days.", { days: reviewDueDate(service).days })}</p></div></div> : service && slot ? <div className="booking-progressive-body"><WeekSlots week={week} slots={[slot]} dayLabel={(day) => dateFor(week, day).toLocaleDateString(readerLocale(), { weekday: "long", month: "short", day: "numeric" })} slotLabel={(candidate) => time(candidate.start)} isSelected={() => true} onSelect={() => setSlot(null)} emptyLabel="" />{slotCoach ? <p className="booking-slot-coach">{t("With {name}", { name: slotCoach.name })}</p> : null}</div> : service ? <div className="booking-progressive-body">{coachChoices.length > 1 ? <fieldset className="booking-handedness booking-coach-picker"><legend>{t("Who would you like?")}</legend><div className="booking-handedness-options" role="radiogroup" aria-label={terms.staffSingular}><button aria-checked={!coachId} className={!coachId ? "selected-handedness" : ""} onClick={() => chooseCoach("")} role="radio" type="button">{t("Anyone available")}</button>{coachChoices.map((coach) => <button aria-checked={coachId === coach.id} className={coachId === coach.id ? "selected-handedness" : ""} key={coach.id} onClick={() => chooseCoach(coach.id)} role="radio" type="button">{coach.name}</button>)}</div></fieldset> : null}<div className="booking-week-controls"><button onClick={() => { setWeek((value) => value - 1); setSlot(null); }} type="button"><ArrowLeft size={15} /><span>{t("Previous week")}</span></button><strong>{weekLabel}</strong><button onClick={() => { setWeek((value) => value + 1); setSlot(null); }} type="button"><span>{t("Next week")}</span><ArrowRight size={15} /></button></div><WeekSlots week={week} placeholder={slotsState === "loading" ? <Loading what={t("available times")} /> : slotsState === "error" ? <p role="alert">{t("Available times could not be loaded.")}</p> : null} slots={availableSlots} dayLabel={(day) => dateFor(week, day).toLocaleDateString(readerLocale(), { weekday: "long", month: "short", day: "numeric" })} slotLabel={(candidate) => `${time(candidate.start)}${candidate.remainingSpots ? t(" · {remainingSpots} spots left", { remainingSpots: candidate.remainingSpots }) : ""}`} isSelected={(candidate) => slot?.week === candidate.week && slot?.day === candidate.day && slot?.start === candidate.start} onSelect={(candidate) => { setSlot(candidate); setError((current) => (current === NO_BAY_FOR_SWING ? "" : current)); }} emptyLabel={t("No public times available this week.")} /></div> : null}</section>
      <section className={`booking-progressive-section ${readyForDetails ? "is-open" : ""}`}><div className="booking-progressive-title"><span className="booking-progressive-title-label">{t("3. Your Information")}</span><span className="booking-progressive-title-state">{readyForDetails ? t("In progress") : t("Locked")}</span></div>{readyForDetails ? <div className="booking-progressive-body">{customGroup && service ? <><GroupAttendees account={catalogue.account} askHandedness={askHandedness} attendees={attendees} booker={bookerDetails} bookerSwing={askHandedness ? <SwingToggle label={t("Which way you swing")} onChange={setHandedness} value={handedness} /> : null} groupPayment={groupPayment} onChange={setAttendees} onGroupPayment={setGroupPayment} service={service} /><div className="booking-form">{notesBox}</div></> : <div className="booking-form">{bookerDetails}{swingChoice}{notesBox}</div>}{payChoiceOffered ? <fieldset className="booking-pay-choice"><legend>{t("How do you want to pay?")}</legend><div className="booking-pay-options" role="radiogroup" aria-label={t("How do you want to pay?")}><button aria-checked={payChoice === "now"} className={payChoice === "now" ? "is-chosen" : ""} onClick={() => setPayChoice("now")} role="radio" type="button"><span><strong>{t("Pay now")}</strong><small>{t("By card online")}</small></span><em>{dueLabelNow}</em></button><button aria-checked={payChoice === "day"} className={payChoice === "day" ? "is-chosen" : ""} onClick={() => setPayChoice("day")} role="radio" type="button"><span><strong>{t("Pay on the day")}</strong><small>{t("Pay at the lesson")}</small></span></button></div></fieldset> : null}{error ? <p className="email-status failed" role="alert"><X size={17} />{error}</p> : null}<button className="primary-button confirm-booking" disabled={!canSubmit || submitState === "saving"} onClick={() => void submit()} type="button">{submitState === "saving" ? t("Confirming…") : payChoiceOffered && payChoice === "now" ? t("Confirm & pay {amount}", { amount: dueLabelNow }) : t("Confirm booking")}</button></div> : null}</section>
    </div>
  </main></BookingFrame>;
}
