import { Loading } from "../shared/Loading";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Clock, X } from "lucide-react";
import { apiFetch } from "../auth/apiFetch";

type Service = { id: string; name: string; duration: number; location?: string };
type Match = { id: string; serviceId: string; serviceName: string; duration: number; week: number; day: number; start: number; client: string };
type Slot = { week: number; day: number; start: number; remainingSpots?: number };
type Credentials = { email: string; phone: string };
const BASE_WEEK_START = new Date(2026, 5, 1);
const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function dateFor(week: number, day: number) { const date = new Date(BASE_WEEK_START); date.setDate(date.getDate() + week * 7 + day); return date; }
function time(minutes: number) { const hour = Math.floor(minutes / 60); return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`; }
function initialCredentials(): Credentials { const query = new URLSearchParams(location.search); return { email: query.get("email") ?? "", phone: query.get("phone") ?? "" }; }
function initialBookingId() { return new URLSearchParams(location.search).get("booking") ?? ""; }
function bookingUrl() { const url = new URL(location.href); url.searchParams.set("embed", "booking"); url.searchParams.delete("mode"); url.searchParams.delete("email"); url.searchParams.delete("phone"); url.searchParams.delete("booking"); return url.toString(); }

/** Appointment-scoped public manager. It intentionally uses the targeted
 * availability request because ignoreId is part of a correct reschedule. */
export default function PublicBookingManage() {
  const [credentials, setCredentials] = useState<Credentials>(initialCredentials);
  const [services, setServices] = useState<Service[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [week, setWeek] = useState(0);
  const [day, setDay] = useState(0);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "saving" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const selected = matches.find((match) => match.id === selectedId) ?? null;
  const selectedService = services.find((service) => service.id === selected?.serviceId) ?? null;

  useEffect(() => { apiFetch("/api/public-booking-catalog").then((response) => response.ok ? response.json() : null).then((data) => setServices(Array.isArray(data?.services) ? data.services : [])).catch(() => {}); }, []);
  useEffect(() => { if (credentials.email && credentials.phone) void lookup(); }, []);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setSlots([]); setSlot(null); setState("loading");
    const query = new URLSearchParams({ serviceId: selected.serviceId, week: String(week), ignoreId: selected.id });
    apiFetch(`/api/public-booking-slots?${query}`)
      .then(async (response) => { if (!response.ok) throw new Error("Available times could not be loaded."); return response.json(); })
      .then((data) => { if (!cancelled) { setSlots(Array.isArray(data.services?.[selected.serviceId]?.slots) ? data.services[selected.serviceId].slots : Array.isArray(data.slots) ? data.slots : []); setState("idle"); } })
      .catch(() => { if (!cancelled) { setMessage("Available times could not be loaded."); setState("error"); } });
    return () => { cancelled = true; };
  }, [selected?.id, selected?.serviceId, week]);

  async function lookup() {
    if (!credentials.email.trim() || !credentials.phone.trim()) { setMessage("Enter the email and phone number used on the booking."); return; }
    setState("loading"); setMessage(""); setMatches([]); setSelectedId("");
    try {
      const response = await apiFetch("/api/public-reschedule-lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(credentials) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || "Could not find that booking.");
      const found = Array.isArray(data.matches) ? data.matches : [];
      setMatches(found);
      const preferred = initialBookingId();
      const selection = found.find((match: Match) => match.id === preferred) ?? (found.length === 1 ? found[0] : null);
      if (selection) { setSelectedId(selection.id); setWeek(selection.week); setDay(selection.day); }
      if (!found.length) setMessage("No booking matched those details.");
      setState("idle");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not reach the booking server."); setState("error"); }
  }
  async function reschedule() {
    if (!selected || !slot) return;
    setState("saving"); setMessage("");
    try {
      const response = await apiFetch("/api/public-reschedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appointmentId: selected.id, ...credentials, week: slot.week, day: slot.day, start: slot.start }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || "That time is no longer available.");
      setState("done");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not complete the reschedule."); setState("error"); }
  }
  async function cancel() {
    if (!selected || !window.confirm(`Cancel ${selected.serviceName} for ${selected.client}?`)) return;
    setState("saving"); setMessage("");
    try {
      const response = await apiFetch("/api/public-cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appointmentId: selected.id, ...credentials }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || "Could not cancel that booking.");
      setState("done"); setMessage("Booking cancelled.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not cancel that booking."); setState("error"); }
  }
  const weekLabel = `${dateFor(week, 0).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${dateFor(week, 6).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  const visibleSlots = useMemo(() => slots.filter((candidate) => candidate.day === day), [slots, day]);
  if (state === "done") return <main className="public-booking"><div className="booking-card booking-confirmation"><Check size={24} /><h1>{message || "Booking updated"}</h1><a className="primary-button" href={bookingUrl()}>Back to booking</a></div></main>;
  return <main className="public-booking"><div className="booking-toolbar"><a className="booking-hero-action" href={bookingUrl()}>Book a lesson</a></div><div className="booking-columns">
    <section className="booking-card"><span>Manage Booking</span><div className="booking-login-copy"><strong>Find your booking</strong><em>Use the email and phone number from your booking.</em></div><div className="booking-form"><input value={credentials.email} onChange={(event) => setCredentials((current) => ({ ...current, email: event.target.value }))} placeholder="Email" type="email" /><input value={credentials.phone} onChange={(event) => setCredentials((current) => ({ ...current, phone: event.target.value }))} placeholder="Phone" type="tel" /></div><button className="primary-button confirm-booking" disabled={state === "loading"} onClick={() => void lookup()} type="button">{state === "loading" ? "Finding…" : "Find booking"}</button></section>
    {matches.length ? <section className="booking-card"><span>Your bookings</span><div className="service-picker reschedule-list">{matches.map((match) => <button className={match.id === selectedId ? "selected-service" : ""} key={match.id} onClick={() => { setSelectedId(match.id); setWeek(match.week); setDay(match.day); }} type="button"><strong>{match.serviceName}</strong><em>{dateFor(match.week, match.day).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · {time(match.start)}</em><small>{match.client}</small></button>)}</div></section> : null}
    {selected ? <><section className="booking-card"><span>New Date &amp; Time</span><div className="booking-week-controls"><button onClick={() => setWeek((value) => value - 1)} type="button"><ArrowLeft size={15} />Previous week</button><strong>{weekLabel}</strong><button onClick={() => setWeek((value) => value + 1)} type="button">Next week<ArrowRight size={15} /></button></div><div className="booking-days">{days.map((name, index) => <button className={day === index ? "selected-day" : ""} key={name} onClick={() => { setDay(index); setSlot(null); }} type="button"><strong>{name}</strong><em>{dateFor(week, index).getDate()}</em></button>)}</div><div className="time-slots">{state === "loading" ? <Loading what="available times" /> : visibleSlots.length ? visibleSlots.map((candidate) => <button className={slot?.start === candidate.start ? "selected-time" : ""} key={`${candidate.day}-${candidate.start}`} onClick={() => setSlot(candidate)} type="button"><Clock size={15} />{time(candidate.start)}</button>) : <p>No public times available for this day.</p>}</div></section><section className="booking-card"><span>Confirm Change</span><div className="booking-summary"><strong>{selected.serviceName}</strong><span>Current: {dateFor(selected.week, selected.day).toLocaleDateString()} · {time(selected.start)}</span><span>{slot ? `New: ${dateFor(slot.week, slot.day).toLocaleDateString()} · ${time(slot.start)}` : "Choose a new time"}</span>{selectedService?.location ? <small>{selectedService.location}</small> : null}</div><button className="primary-button confirm-booking" disabled={!slot || state === "saving"} onClick={() => void reschedule()} type="button">{state === "saving" ? "Moving…" : "Confirm Reschedule"}</button><button className="danger-button public-cancel-booking" disabled={state === "saving"} onClick={() => void cancel()} type="button">Cancel Booking</button></section></> : null}
    {message ? <p className="email-status failed" role="alert"><X size={17} />{message}</p> : null}
  </div></main>;
}
