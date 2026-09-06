import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Clock, X } from "lucide-react";
import { appearsOnCurrentPublicBookingScreen } from "./bookingScreen";

type Service = { id: string; name: string; duration: number; price: number; priceMode?: string; description?: string; lessonNote?: string; location?: string; lessonFormat?: string; customGroup?: boolean; customGroupEnabled?: boolean; minParticipants?: number; bookingScreenIds?: string[] };
type Slot = { week: number; day: number; start: number; remainingSpots?: number; locationId?: string; coachId?: string };
type Brand = { logoPreview?: string; showLogo?: boolean };
type Account = { businessName?: string; coachName?: string; venueShortName?: string };
type Form = { firstName: string; lastName: string; phone: string; email: string };

const BASE_WEEK_START = new Date(2026, 5, 1);
const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

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
function price(service: Service) { return service.priceMode === "free" || !service.price ? "Free" : `$${service.price}`; }

/** Customer-only booking surface.  It intentionally owns no coach session,
 * calendar, CRM, video, browser storage, or admin document hooks. */
export default function PublicBookingApp() {
  const [catalogue, setCatalogue] = useState<{ services: Service[]; brand: Brand; account: Account }>({ services: [], brand: {}, account: {} });
  const [catalogueState, setCatalogueState] = useState<"loading" | "ready" | "error">("loading");
  const [week, setWeek] = useState(currentWeek);
  const [slotsByService, setSlotsByService] = useState<Record<string, Slot[]>>({});
  const [slotsState, setSlotsState] = useState<"loading" | "ready" | "error">("loading");
  const [serviceId, setServiceId] = useState("");
  const [day, setDay] = useState<number | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [form, setForm] = useState<Form>({ firstName: "", lastName: "", phone: "", email: "" });
  const [attendees, setAttendees] = useState<Array<{ name: string; email: string }>>([]);
  const [submitState, setSubmitState] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/public-booking-catalog", { headers: { Accept: "application/json" } })
      .then(async (response) => { if (!response.ok) throw new Error("Booking is unavailable."); return response.json(); })
      .then((data) => { if (!cancelled) { setCatalogue({ services: Array.isArray(data.services) ? data.services : [], brand: data.brand ?? {}, account: data.account ?? {} }); setCatalogueState("ready"); } })
      .catch(() => { if (!cancelled) setCatalogueState("error"); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSlotsState("loading");
    // Deliberately one request for the active week. The endpoint returns every
    // public service keyed by id; do not turn this back into an N+1 loop.
    fetch(`/api/public-booking-slots?week=${week}`, { headers: { Accept: "application/json" } })
      .then(async (response) => { if (!response.ok) throw new Error("Availability is unavailable."); return response.json(); })
      .then((data) => {
        if (cancelled) return;
        const next: Record<string, Slot[]> = {};
        for (const [id, entry] of Object.entries(data.services ?? {})) next[id] = Array.isArray((entry as { slots?: Slot[] }).slots) ? (entry as { slots: Slot[] }).slots : [];
        setSlotsByService(next); setSlotsState("ready");
      })
      .catch(() => { if (!cancelled) setSlotsState("error"); });
    return () => { cancelled = true; };
  }, [week]);

  // This is deliberately the same final derivation as App.tsx:
  // public catalogue -> public screen -> bookingScreenIds, including the
  // legacy missing-field fallback and the explicit-empty exclusion.
  const services = useMemo(() => catalogue.services.filter((service) => appearsOnCurrentPublicBookingScreen(service)), [catalogue.services]);
  const service = services.find((candidate) => candidate.id === serviceId) ?? null;
  const scheduledGroup = service?.lessonFormat === "group" && !service?.customGroup && !service?.customGroupEnabled;
  const customGroup = service?.customGroup || service?.customGroupEnabled;
  const availableSlots = service ? (slotsByService[service.id] ?? []).filter((candidate) => scheduledGroup || day === null || candidate.day === day) : [];
  const canSubmit = Boolean(service && slot && form.firstName.trim() && form.lastName.trim() && form.email.trim() && (!customGroup || attendees.length + 1 >= (service.minParticipants ?? 1)));
  const chooseService = (id: string) => { setServiceId(id); setDay(null); setSlot(null); setAttendees([]); };

  async function submit() {
    if (!service || !slot || !canSubmit) return;
    setSubmitState("saving"); setError("");
    try {
      const response = await fetch("/api/public-booking", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serviceId: service.id, week: slot.week, day: slot.day, start: slot.start, duration: service.duration, ...form, coachId: slot.coachId, locationId: slot.locationId, attendees: customGroup ? attendees : undefined }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.appointment?.id) throw new Error(data.message || "That time is no longer available.");
      setSubmitState("done");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not confirm the booking."); setSubmitState("error"); }
  }

  const weekLabel = `${dateFor(week, 0).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${dateFor(week, 6).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  const brandName = catalogue.account.businessName || catalogue.account.coachName || "Clarity Golf";
  if (submitState === "done") return <main className="public-booking"><div className="booking-brand"><strong>{brandName}</strong></div><div className="booking-card booking-confirmation"><Check size={24} /><h1>Booking confirmed</h1><p>Your confirmation is on its way by email.</p><button className="primary-button" onClick={() => { setSubmitState("idle"); setSlot(null); setDay(null); }} type="button">Book another lesson</button></div></main>;

  return <main className="public-booking">
    <div className="booking-brand">{catalogue.brand.showLogo && catalogue.brand.logoPreview ? <img src={catalogue.brand.logoPreview} alt={`${brandName} logo`} /> : <strong>{brandName}</strong>}<em>{catalogue.account.venueShortName}</em></div>
    <div className="booking-toolbar"><a className="booking-login-trigger" href={`${location.pathname}?embed=booking&mode=reschedule`}>Manage / reschedule a booking</a></div>
    <div className="booking-columns booking-progressive-flow">
      <section className="booking-progressive-section is-open"><div className="booking-progressive-title"><span className="booking-progressive-title-label">1. Appointment</span><span className="booking-progressive-title-state">{catalogueState === "loading" ? "Loading" : "In progress"}</span></div><div className="booking-progressive-body"><div className="service-picker">{catalogueState === "error" ? <p role="alert">Booking is unavailable. Please try again shortly.</p> : catalogueState === "loading" ? <p>Loading lesson types…</p> : services.length ? services.map((candidate) => <button className={candidate.id === serviceId ? "selected-service" : ""} key={candidate.id} onClick={() => chooseService(candidate.id)} type="button"><strong>{candidate.name}</strong><em>{candidate.duration} minutes @ {price(candidate)}</em>{candidate.description ? <small>{candidate.description}</small> : null}{candidate.lessonNote || candidate.location ? <small>{candidate.lessonNote || candidate.location}</small> : null}</button>) : <p>No public lesson types are active.</p>}</div></div></section>
      <section className={`booking-progressive-section ${service ? "is-open" : ""}`}><div className="booking-progressive-title"><span className="booking-progressive-title-label">2. Date &amp; Time</span><span className="booking-progressive-title-state">{!service ? "Locked" : slotsState === "loading" ? "Loading" : "In progress"}</span></div>{service ? <div className="booking-progressive-body"><div className="booking-week-controls"><button onClick={() => { setWeek((value) => value - 1); setSlot(null); }} type="button"><ArrowLeft size={15} /><span>Previous week</span></button><strong>{weekLabel}</strong><button onClick={() => { setWeek((value) => value + 1); setSlot(null); }} type="button"><span>Next week</span><ArrowRight size={15} /></button></div>{!scheduledGroup ? <div className="booking-days">{dayNames.map((name, index) => <button className={day === index ? "selected-day" : ""} key={name} onClick={() => { setDay(index); setSlot(null); }} type="button"><strong>{name.slice(0, 3)}</strong><em>{dateFor(week, index).getDate()}</em></button>)}</div> : null}<div className="time-slots">{slotsState === "loading" ? <p>Loading available times…</p> : slotsState === "error" ? <p role="alert">Available times could not be loaded.</p> : !scheduledGroup && day === null ? <p>Choose a day first.</p> : availableSlots.length ? availableSlots.map((candidate) => <button className={slot?.start === candidate.start && slot?.day === candidate.day ? "selected-time" : ""} key={`${candidate.day}-${candidate.start}`} onClick={() => setSlot(candidate)} type="button"><Clock size={15} />{scheduledGroup ? `${dateFor(candidate.week, candidate.day).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · ` : ""}{time(candidate.start)}{candidate.remainingSpots ? ` · ${candidate.remainingSpots} spots left` : ""}</button>) : <p>No public times available for this day.</p>}</div></div> : null}</section>
      <section className={`booking-progressive-section ${slot ? "is-open" : ""}`}><div className="booking-progressive-title"><span className="booking-progressive-title-label">3. Your Information</span><span className="booking-progressive-title-state">{slot ? "In progress" : "Locked"}</span></div>{slot ? <div className="booking-progressive-body"><div className="booking-form">{(["firstName", "lastName", "phone", "email"] as const).map((key) => <input className={key === "email" ? "w-email" : "w-name"} key={key} value={form[key]} type={key === "email" ? "email" : key === "phone" ? "tel" : "text"} autoComplete={key === "firstName" ? "given-name" : key === "lastName" ? "family-name" : key === "phone" ? "tel" : "email"} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} placeholder={key === "firstName" ? "First name *" : key === "lastName" ? "Last name *" : key === "phone" ? "Phone" : "Email *"} />)}</div>{customGroup ? <div className="booking-form"><p>Additional attendees</p>{attendees.map((attendee, index) => <div key={index}><input value={attendee.name} onChange={(event) => setAttendees((current) => current.map((item, position) => position === index ? { ...item, name: event.target.value } : item))} placeholder="Name" /><input value={attendee.email} onChange={(event) => setAttendees((current) => current.map((item, position) => position === index ? { ...item, email: event.target.value } : item))} placeholder="Email" type="email" /><button onClick={() => setAttendees((current) => current.filter((_, position) => position !== index))} type="button">Remove</button></div>)}<button onClick={() => setAttendees((current) => [...current, { name: "", email: "" }])} type="button">Add attendee</button></div> : null}{error ? <p className="email-status failed" role="alert"><X size={17} />{error}</p> : null}<button className="primary-button confirm-booking" disabled={!canSubmit || submitState === "saving"} onClick={() => void submit()} type="button">{submitState === "saving" ? "Confirming…" : "Confirm Appointment"}</button></div> : null}</section>
    </div>
  </main>;
}
