import { createHash, randomUUID } from "node:crypto";

const baseWeekStart = new Date(Date.UTC(2026, 5, 1));

type BookingAction = "booking" | "rescheduled" | "cancelled" | "updated" | "reminder" | "test";

type NotifyInput = {
  action?: BookingAction;
  appointment: any;
  previousAppointment?: any;
  source?: string;
  testRecipient?: string;
};

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function cleanText(value: unknown, fallback = "", max = 800) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function cleanEmail(value: unknown, fallback = "") {
  const email = cleanText(value, "", 180).toLowerCase();
  return email.includes("@") ? email : fallback;
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value ?? "")).digest("hex");
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function render(template: string, variables: Record<string, string>) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => variables[key] ?? "");
}

function supabaseConfig() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("Supabase is not configured for notifications.");
  return { url, key };
}

async function supabase(table: string, options: { method?: string; query?: string; body?: unknown; prefer?: string } = {}) {
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/${table}${options.query ? `?${options.query}` : ""}`, {
    method: options.method || "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.prefer ? { Prefer: options.prefer } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${options.method || "GET"} ${table} failed ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : [];
}

async function settingRows() {
  return supabase("settings", { query: "select=key,value" }).catch(() => []);
}

async function readSettings() {
  const rows = await settingRows();
  const s = Object.fromEntries(rows.map((row: any) => [row.key, row.value]));
  return {
    notificationEmail: cleanEmail(s.notificationEmail, env("CLARITY_NOTIFICATION_EMAIL", "sam@samhalegolf.co.nz")),
    coachEmail: cleanEmail(s.coachEmail, env("CLARITY_COACH_EMAIL", "")),
    replyToEmail: cleanEmail(s.replyToEmail, env("CLARITY_REPLY_TO_EMAIL", env("CLARITY_NOTIFICATION_EMAIL", "sam@samhalegolf.co.nz"))),
    sendClientEmail: s.sendClientEmail !== "false",
    sendCoachEmail: s.sendCoachEmail !== "false",
    sendAdminEmail: s.sendAdminEmail !== "false",
    clientEmailSubject: s.clientEmailSubject || "Your {{service}} is confirmed",
    clientEmailIntro: s.clientEmailIntro || "Thanks {{firstName}}, your booking with {{coach}} is confirmed.",
    clientEmailFooter: s.clientEmailFooter || "Need to move your booking? Reply to this email and we will help.",
    adminEmailSubject: s.adminEmailSubject || "New booking: {{client}}",
    adminEmailIntro: s.adminEmailIntro || "{{client}} booked {{service}} for {{date}} at {{time}}.",
    rescheduleClientSubject: s.rescheduleClientSubject || "Your {{service}} has been rescheduled",
    rescheduleAdminSubject: s.rescheduleAdminSubject || "Rescheduled booking: {{client}}",
    cancellationClientSubject: s.cancellationClientSubject || "Your {{service}} booking has been cancelled",
    cancellationAdminSubject: s.cancellationAdminSubject || "Cancelled booking: {{client}}",
    updateClientSubject: s.updateClientSubject || "Your {{service}} booking has been updated",
    updateAdminSubject: s.updateAdminSubject || "Updated booking: {{client}}",
    reminderClientSubject: s.reminderClientSubject || "Reminder: {{service}} at {{time}}",
    businessName: s.accountBusinessName || env("CLARITY_BUSINESS_NAME", "Sam Hale Golf"),
    coachName: s.accountCoachName || env("CLARITY_COACH_NAME", "Sam Hale"),
    venueName: s.accountVenueName || env("CLARITY_VENUE_NAME", "The Range 24/7 - Three Kings"),
    contactEmail: cleanEmail(s.accountContactEmail, env("CLARITY_CONTACT_EMAIL", "sam@samhalegolf.co.nz")),
  };
}

async function readServices() {
  const rows = await supabase("settings", { query: "select=key,value&key=eq.servicesJson&limit=1" }).catch(() => []);
  try { return rows[0]?.value ? JSON.parse(rows[0].value) : []; } catch { return []; }
}

function slotDateLabel(week = 0, day = 0) {
  const date = new Date(baseWeekStart);
  date.setUTCDate(baseWeekStart.getUTCDate() + Number(week || 0) * 7 + Number(day || 0));
  return date.toLocaleDateString("en-NZ", { weekday: "long", month: "short", day: "numeric" });
}

function timeLabel(minutes = 0) {
  const value = Number(minutes || 0);
  const hour24 = Math.floor(value / 60);
  const mins = value % 60;
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour = hour24 % 12 || 12;
  return `${hour}:${String(mins).padStart(2, "0")} ${period}`;
}

function rangeLabel(start = 0, duration = 0) { return `${timeLabel(start)}-${timeLabel(Number(start || 0) + Number(duration || 0))}`; }

function normaliseAppointment(raw: any = {}) {
  const client = cleanText(raw.client, cleanText(raw.title, [raw.firstName, raw.lastName].filter(Boolean).join(" "), 160), 160);
  return {
    id: cleanText(raw.id, `appt-${Date.now()}`, 160),
    kind: raw.kind || "appointment",
    week: Number(raw.week ?? 0),
    day: Number(raw.day ?? 0),
    start: Number(raw.start ?? 0),
    duration: Number(raw.duration ?? 30),
    serviceId: cleanText(raw.serviceId || raw.service_id, "", 160),
    client: client || "Client",
    title: cleanText(raw.title, client || "Booking", 160),
    phone: cleanText(raw.phone, "", 80),
    email: cleanEmail(raw.email, ""),
    note: cleanText(raw.note || raw.notes, "", 1200),
  };
}

async function recordNotification(row: any) {
  try {
    await supabase("notification_history", {
      method: "POST",
      prefer: "return=minimal",
      body: [{
        id: randomUUID(),
        person_key: cleanText(row.personKey, "", 220),
        calendar_item_id: cleanText(row.calendarItemId, "", 180),
        recipient: cleanEmail(row.recipient, cleanText(row.recipient, "", 180)),
        subject: cleanText(row.subject, "", 220),
        kind: cleanText(row.kind, "", 100),
        status: cleanText(row.status, "", 80),
        provider: cleanText(row.provider, "", 80),
        provider_id: cleanText(row.providerId, "", 180),
        error: cleanText(row.error, "", 1000),
        created_at: new Date().toISOString(),
      }],
    });
  } catch (error) {
    console.error("notification_engine:history_failed", error);
  }
}

async function sendEmail(message: { to: string; subject: string; html: string; text: string; replyTo?: string; idempotencyKey: string }) {
  const apiKey = env("RESEND_API_KEY");
  if (!apiKey) return { sent: false, reason: "missing_resend_key" };
  if (!cleanEmail(message.to)) return { sent: false, reason: "missing_recipient" };
  const settings = await readSettings();
  const from = env("CLARITY_EMAIL_FROM", `${settings.businessName} <onboarding@resend.dev>`);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": message.idempotencyKey },
    body: JSON.stringify({ from, to: [message.to], subject: message.subject, html: message.html, text: message.text, ...(message.replyTo ? { reply_to: message.replyTo } : {}) }),
  });
  const responseText = await response.text().catch(() => "");
  if (!response.ok) return { sent: false, reason: "resend_failed", error: responseText.slice(0, 1000), status: response.status };
  try { const data = responseText ? JSON.parse(responseText) : {}; return { sent: true, id: data?.id || "" }; } catch { return { sent: true, id: "" }; }
}

function actionLabels(action: BookingAction) {
  if (action === "rescheduled") return { title: "Booking rescheduled", clientSubject: "Your golf lesson has been rescheduled", adminSubject: "Booking rescheduled" };
  if (action === "cancelled") return { title: "Booking cancelled", clientSubject: "Your golf lesson has been cancelled", adminSubject: "Booking cancelled" };
  if (action === "updated") return { title: "Booking updated", clientSubject: "Your golf lesson booking was updated", adminSubject: "Booking updated" };
  if (action === "reminder") return { title: "Booking reminder", clientSubject: "Reminder: your golf lesson is coming up", adminSubject: "Booking reminder" };
  return { title: "Booking confirmed", clientSubject: "Your golf lesson is confirmed", adminSubject: "New booking" };
}

function variablesFor(action: BookingAction, appt: any, previous: any, serviceName: string, settings: any) {
  return {
    client: appt.client || appt.title,
    firstName: String(appt.client || appt.title || "Client").split(/\s+/)[0] || "Client",
    coach: settings.coachName || settings.businessName,
    business: settings.businessName,
    service: serviceName,
    date: slotDateLabel(appt.week, appt.day),
    time: rangeLabel(appt.start, appt.duration),
    previousDate: previous ? slotDateLabel(previous.week, previous.day) : "",
    previousTime: previous ? rangeLabel(previous.start, previous.duration) : "",
    venue: settings.venueName,
    phone: appt.phone || "Not supplied",
    email: appt.email || "Not supplied",
    action,
  };
}

function templateSubjects(action: BookingAction, settings: any, variables: Record<string, string>) {
  if (action === "rescheduled") return { client: render(settings.rescheduleClientSubject, variables), admin: render(settings.rescheduleAdminSubject, variables) };
  if (action === "cancelled") return { client: render(settings.cancellationClientSubject, variables), admin: render(settings.cancellationAdminSubject, variables) };
  if (action === "updated") return { client: render(settings.updateClientSubject, variables), admin: render(settings.updateAdminSubject, variables) };
  if (action === "reminder") return { client: render(settings.reminderClientSubject, variables), admin: `Reminder: ${variables.client}` };
  if (action === "test") return { client: "Clarity Golf booking email test", admin: "Clarity Golf booking email test" };
  return { client: render(settings.clientEmailSubject, variables), admin: render(settings.adminEmailSubject, variables) };
}

function bodyFor(action: BookingAction, appt: any, previous: any, serviceName: string, settings: any, variables: Record<string, string>) {
  const labels = actionLabels(action);
  const intro = action === "booking" ? render(settings.clientEmailIntro, variables) : labels.title;
  const previousLine = previous ? `Previous time: ${variables.previousDate}, ${variables.previousTime}` : "";
  const rows = [`Client: ${variables.client}`, `Service: ${serviceName}`, `Date: ${variables.date}`, `Time: ${variables.time}`, previousLine, `Phone: ${variables.phone}`, `Email: ${variables.email}`, `Venue: ${variables.venue}`, `Booking ID: ${appt.id}`].filter(Boolean);
  const htmlRows = rows.map((line) => `<p style="margin:6px 0">${escapeHtml(line)}</p>`).join("");
  const footer = action === "booking" ? render(settings.clientEmailFooter, variables) : "Reply to this email if you need help.";
  return { html: `<div style="font-family:Arial,sans-serif;line-height:1.5;color:#111"><h2>${escapeHtml(labels.title)}</h2><p>${escapeHtml(intro)}</p>${htmlRows}<p>${escapeHtml(footer)}</p></div>`, text: [labels.title, "", intro, "", ...rows, "", footer].join("\n") };
}

export async function notifyBookingEvent(input: NotifyInput) {
  const action = input.action || "booking";
  const settings = await readSettings();
  const services = await readServices();
  const appt = normaliseAppointment(input.appointment);
  const previous = input.previousAppointment ? normaliseAppointment(input.previousAppointment) : null;
  const service = services.find((candidate: any) => candidate.id === appt.serviceId);
  const serviceName = cleanText(service?.name, "Golf Lesson", 160);
  const variables = variablesFor(action, appt, previous, serviceName, settings);
  const subjects = templateSubjects(action, settings, variables);
  const body = bodyFor(action, appt, previous, serviceName, settings, variables);
  const personKey = appt.email ? `email:${appt.email}` : appt.phone ? `phone:${appt.phone}` : `name:${appt.client.toLowerCase()}`;
  const signature = hash({ action, appt, previous, source: input.source }).slice(0, 24);
  const results: any[] = [];

  async function sendAndRecord(channel: "client" | "coach" | "admin", recipient: string, subject: string) {
    const kind = `${action}_${channel}_email`;
    if (!recipient) {
      const skipped = { channel, recipient, subject, kind, status: "skipped", sent: false, reason: "missing_recipient" };
      results.push(skipped);
      await recordNotification({ personKey, calendarItemId: appt.id, recipient, subject, kind, status: "skipped", provider: "settings", error: "missing_recipient" });
      return;
    }
    const result = await sendEmail({ to: recipient, subject, html: body.html, text: body.text, replyTo: settings.replyToEmail || settings.contactEmail, idempotencyKey: `${kind}-${appt.id}-${signature}` });
    const status = result.sent ? "sent" : "failed";
    const output = { channel, recipient, subject, kind, status, ...result };
    results.push(output);
    await recordNotification({ personKey, calendarItemId: appt.id, recipient, subject, kind, status, provider: "resend", providerId: result.id || "", error: result.reason || result.error || "" });
  }

  if (action === "test") {
    await sendAndRecord("client", cleanEmail(input.testRecipient, appt.email), subjects.client);
    return results;
  }

  if (settings.sendClientEmail || action === "cancelled" || action === "rescheduled") await sendAndRecord("client", appt.email, subjects.client);
  else await recordNotification({ personKey, calendarItemId: appt.id, recipient: appt.email, subject: subjects.client, kind: `${action}_client_email`, status: "skipped", provider: "settings", error: "disabled_client_email" });

  if (settings.sendCoachEmail || action === "cancelled" || action === "rescheduled") await sendAndRecord("coach", settings.coachEmail || "", subjects.admin);
  else await recordNotification({ personKey, calendarItemId: appt.id, recipient: settings.coachEmail || "", subject: subjects.admin, kind: `${action}_coach_email`, status: "skipped", provider: "settings", error: "disabled_coach_email" });

  if (settings.sendAdminEmail || action === "cancelled" || action === "rescheduled") await sendAndRecord("admin", settings.notificationEmail || settings.contactEmail, subjects.admin);
  else await recordNotification({ personKey, calendarItemId: appt.id, recipient: settings.notificationEmail || settings.contactEmail, subject: subjects.admin, kind: `${action}_admin_email`, status: "skipped", provider: "settings", error: "disabled_admin_email" });

  return results;
}

export function inferBookingAction(previous: any, next: any): BookingAction | null {
  if (!previous && next?.kind === "appointment") return "booking";
  if (previous?.kind === "appointment" && !next) return "cancelled";
  if (!previous || !next || next.kind !== "appointment") return null;
  const slotChanged = Number(previous.week ?? 0) !== Number(next.week ?? 0) || Number(previous.day ?? 0) !== Number(next.day ?? 0) || Number(previous.start ?? 0) !== Number(next.start ?? 0) || Number(previous.duration ?? 0) !== Number(next.duration ?? 0);
  if (slotChanged) return "rescheduled";
  const contactChanged = cleanText(previous.client || previous.title) !== cleanText(next.client || next.title) || cleanEmail(previous.email) !== cleanEmail(next.email) || cleanText(previous.phone) !== cleanText(next.phone) || cleanText(previous.serviceId || previous.service_id) !== cleanText(next.serviceId || next.service_id);
  return contactChanged ? "updated" : null;
}

export async function notifyCalendarDiff(previousItems: any[] = [], nextItems: any[] = []) {
  const previousById = new Map(previousItems.filter((item) => item?.kind === "appointment").map((item) => [item.id, item]));
  const nextById = new Map(nextItems.filter((item) => item?.kind === "appointment").map((item) => [item.id, item]));
  const ids = new Set([...previousById.keys(), ...nextById.keys()]);
  const results: any[] = [];
  for (const id of ids) {
    const previous = previousById.get(id);
    const next = nextById.get(id);
    const action = inferBookingAction(previous, next);
    if (!action) continue;
    results.push(...(await notifyBookingEvent({ action, appointment: next || previous, previousAppointment: previous, source: "calendar-state" })));
  }
  return results;
}
