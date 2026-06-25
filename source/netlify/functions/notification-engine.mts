import { createHash, randomUUID } from "node:crypto";

const baseWeekStart = new Date(Date.UTC(2026, 5, 1));

type BookingAction = "booking" | "rescheduled" | "cancelled" | "updated" | "reminder" | "test";
type NotificationChannel = "client" | "coach" | "admin";

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

function cleanUrl(value: unknown, fallback: string) {
  const candidate = cleanText(value, fallback, 700);
  try {
    return new URL(candidate).toString();
  } catch {
    return fallback;
  }
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
  const siteUrl = cleanUrl(
    env("URL") || env("DEPLOY_PRIME_URL") || env("CLARITY_SITE_URL", "https://claritygolf.app"),
    "https://claritygolf.app/",
  );
  return {
    notificationEmail: cleanEmail(s.notificationEmail, env("CLARITY_NOTIFICATION_EMAIL", "sam@samhalegolf.co.nz")),
    coachEmail: cleanEmail(s.coachEmail, env("CLARITY_COACH_EMAIL", "")),
    replyToEmail: cleanEmail(s.replyToEmail, env("CLARITY_REPLY_TO_EMAIL", env("CLARITY_NOTIFICATION_EMAIL", "sam@samhalegolf.co.nz"))),
    notificationSubjectLine: cleanText(s.notificationSubjectLine, "", 180),
    sendClientEmail: s.sendClientEmail !== "false",
    sendCoachEmail: s.sendCoachEmail !== "false",
    sendAdminEmail: s.sendAdminEmail !== "false",
    clientEmailSubject: s.clientEmailSubject || "Your {{service}} is confirmed",
    clientEmailIntro: s.clientEmailIntro || "Thanks {{firstName}}, your booking with {{coach}} is confirmed.",
    clientEmailFooter: s.clientEmailFooter || "We look forward to seeing you.",
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
    timezone: s.accountTimezone || env("CLARITY_TIMEZONE", "Pacific/Auckland"),
    bookingUrl: cleanUrl(s.accountBookingUrl || env("CLARITY_BOOKING_URL", "https://book.claritygolf.app"), "https://book.claritygolf.app/"),
    siteUrl,
    contactEmail: cleanEmail(s.accountContactEmail, env("CLARITY_CONTACT_EMAIL", "sam@samhalegolf.co.nz")),
  };
}

async function readServices() {
  const rows = await supabase("settings", { query: "select=key,value&key=eq.servicesJson&limit=1" }).catch(() => []);
  try {
    return rows[0]?.value ? JSON.parse(rows[0].value) : [];
  } catch {
    return [];
  }
}

function slotDate(week = 0, day = 0) {
  const date = new Date(baseWeekStart);
  date.setUTCDate(baseWeekStart.getUTCDate() + Number(week || 0) * 7 + Number(day || 0));
  return date;
}

function slotDateLabel(week = 0, day = 0) {
  return slotDate(week, day).toLocaleDateString("en-NZ", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function compactLocalDateTime(week = 0, day = 0, minutes = 0) {
  const date = slotDate(week, day);
  const hour = Math.floor(Number(minutes || 0) / 60);
  const minute = Number(minutes || 0) % 60;
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(hour)}${pad(minute)}00`;
}

function timeLabel(minutes = 0) {
  const value = Number(minutes || 0);
  const hour24 = Math.floor(value / 60);
  const mins = value % 60;
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour = hour24 % 12 || 12;
  return `${hour}:${String(mins).padStart(2, "0")} ${period}`;
}

function rangeLabel(start = 0, duration = 0) {
  return `${timeLabel(start)}-${timeLabel(Number(start || 0) + Number(duration || 0))}`;
}

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
    status:
      raw.status === "completed" || raw.status === "cancelled" || raw.status === "no_show"
        ? raw.status
        : "booked",
  };
}

function rescheduleUrlFor(appt: any, settings: any) {
  if (!appt?.id) return "";
  try {
    const url = new URL(settings.bookingUrl || "https://book.claritygolf.app");
    url.searchParams.set("embed", "booking");
    url.searchParams.set("mode", "reschedule");
    url.searchParams.set("booking", appt.id);
    if (appt.email) url.searchParams.set("email", appt.email);
    if (appt.phone) url.searchParams.set("phone", appt.phone);
    return url.toString();
  } catch {
    return "";
  }
}

function googleCalendarUrlFor(appt: any, serviceName: string, settings: any, rescheduleUrl: string) {
  const start = compactLocalDateTime(appt.week, appt.day, appt.start);
  const end = compactLocalDateTime(appt.week, appt.day, Number(appt.start || 0) + Number(appt.duration || 0));
  const details = [
    `${serviceName} for ${appt.client || appt.title || "Client"}.`,
    rescheduleUrl ? `Manage or reschedule: ${rescheduleUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `${serviceName} with ${settings.coachName || settings.businessName}`,
    dates: `${start}/${end}`,
    details,
    location: settings.venueName,
    ctz: settings.timezone || "Pacific/Auckland",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function appleCalendarUrlFor(appt: any, settings: any) {
  if (!appt?.id) return "";
  try {
    const url = new URL("/api/public-calendar-invite", settings.siteUrl || "https://claritygolf.app");
    url.searchParams.set("booking", appt.id);
    if (appt.email) url.searchParams.set("email", appt.email);
    if (appt.phone) url.searchParams.set("phone", appt.phone);
    return url.toString();
  } catch {
    return "";
  }
}

async function recordNotification(row: any) {
  try {
    await supabase("notification_history", {
      method: "POST",
      prefer: "return=minimal",
      body: [
        {
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
        },
      ],
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
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": message.idempotencyKey,
    },
    body: JSON.stringify({
      from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(message.replyTo ? { reply_to: message.replyTo } : {}),
    }),
  });
  const responseText = await response.text().catch(() => "");
  if (!response.ok) {
    return {
      sent: false,
      reason: "resend_failed",
      error: responseText.slice(0, 1000),
      status: response.status,
    };
  }
  try {
    const data = responseText ? JSON.parse(responseText) : {};
    return { sent: true, id: data?.id || "" };
  } catch {
    return { sent: true, id: "" };
  }
}

function actionLabels(action: BookingAction) {
  if (action === "rescheduled") return { title: "Booking rescheduled", clientSubject: "Your golf lesson has been rescheduled", adminSubject: "Booking rescheduled" };
  if (action === "cancelled") return { title: "Booking cancelled", clientSubject: "Your golf lesson has been cancelled", adminSubject: "Booking cancelled" };
  if (action === "updated") return { title: "Booking updated", clientSubject: "Your golf lesson booking was updated", adminSubject: "Booking updated" };
  if (action === "reminder") return { title: "Booking reminder", clientSubject: "Reminder: your golf lesson is coming up", adminSubject: "Booking reminder" };
  if (action === "test") return { title: "Booking email test", clientSubject: "Clarity Golf booking email test", adminSubject: "Clarity Golf booking email test" };
  return { title: "Booking confirmed", clientSubject: "Your golf lesson is confirmed", adminSubject: "New booking" };
}

function variablesFor(action: BookingAction, appt: any, previous: any, serviceName: string, settings: any) {
  const rescheduleUrl = rescheduleUrlFor(appt, settings);
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
    rescheduleUrl,
    googleCalendarUrl: googleCalendarUrlFor(appt, serviceName, settings, rescheduleUrl),
    appleCalendarUrl: appleCalendarUrlFor(appt, settings),
  };
}

function templateSubjects(action: BookingAction, settings: any, variables: Record<string, string>) {
  const sharedSubjectTemplate = cleanText(settings.notificationSubjectLine, "", 180);
  const sharedSubject = sharedSubjectTemplate.trim() ? render(sharedSubjectTemplate, variables) : "";
  if (sharedSubject) return { client: sharedSubject, admin: sharedSubject };

  if (action === "rescheduled") return { client: render(settings.rescheduleClientSubject, variables), admin: render(settings.rescheduleAdminSubject, variables) };
  if (action === "cancelled") return { client: render(settings.cancellationClientSubject, variables), admin: render(settings.cancellationAdminSubject, variables) };
  if (action === "updated") return { client: render(settings.updateClientSubject, variables), admin: render(settings.updateAdminSubject, variables) };
  if (action === "reminder") return { client: render(settings.reminderClientSubject, variables), admin: `Reminder: ${variables.client}` };
  if (action === "test") return { client: "Clarity Golf booking email test", admin: "Clarity Golf booking email test" };
  return { client: render(settings.clientEmailSubject, variables), admin: render(settings.adminEmailSubject, variables) };
}

function clientIntro(action: BookingAction, settings: any, variables: Record<string, string>) {
  if (action === "booking") return render(settings.clientEmailIntro, variables);
  if (action === "rescheduled") return `Thanks ${variables.firstName}, your new lesson time is confirmed.`;
  if (action === "cancelled") return `Your ${variables.service} booking has been cancelled.`;
  if (action === "updated") return `Your ${variables.service} booking details have been updated.`;
  if (action === "reminder") return `A reminder for your upcoming ${variables.service}.`;
  return "This is a test of your booking email template.";
}

function clientFooter(action: BookingAction, settings: any, variables: Record<string, string>) {
  const rendered = action === "booking" ? render(settings.clientEmailFooter, variables).trim() : "";
  const isLegacyChangeFooter = /need to (move|change)|reply to this email.*(move|change|reschedul)|email.*(move|change|reschedul)/i.test(rendered);
  if (rendered && !isLegacyChangeFooter) return rendered;
  if (action === "cancelled") return "If this cancellation was unexpected, reply to this email and we will help.";
  if (action === "test") return "Email delivery is working.";
  return "We look forward to seeing you.";
}

function detailTable(rows: Array<[string, string]>) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:20px 0;width:100%;max-width:560px">${rows
    .filter(([, value]) => Boolean(value))
    .map(
      ([label, value], index, array) =>
        `<tr><td style="padding:9px 10px;border-bottom:${index === array.length - 1 ? "0" : "1px solid #dfe5d8"};color:#697166;width:105px;vertical-align:top">${escapeHtml(label)}</td><td style="padding:9px 10px;border-bottom:${index === array.length - 1 ? "0" : "1px solid #dfe5d8"};color:#101612;vertical-align:top">${escapeHtml(value)}</td></tr>`,
    )
    .join("")}</table>`;
}

function clientActionButtonsHtml(action: BookingAction, variables: Record<string, string>) {
  if (action === "cancelled" || action === "test") return "";
  const manageButton = variables.rescheduleUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 14px"><tr><td><a href="${escapeHtml(variables.rescheduleUrl)}" style="display:inline-block;background:#07100a;color:#ffffff;padding:13px 20px;text-decoration:none;border-radius:7px;font-weight:700">Manage / Reschedule</a></td></tr></table>`
    : "";
  const calendarButtons = variables.googleCalendarUrl || variables.appleCalendarUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px"><tr>${
        variables.googleCalendarUrl
          ? `<td style="padding:0 8px 8px 0"><a href="${escapeHtml(variables.googleCalendarUrl)}" style="display:inline-block;border:1px solid #cfd8ca;color:#101612;padding:10px 13px;text-decoration:none;border-radius:7px;font-weight:600"><span style="font-size:15px;vertical-align:-1px;margin-right:6px">&#128197;</span>Google Calendar</a></td>`
          : ""
      }${
        variables.appleCalendarUrl
          ? `<td style="padding:0 0 8px 0"><a href="${escapeHtml(variables.appleCalendarUrl)}" style="display:inline-block;border:1px solid #cfd8ca;color:#101612;padding:10px 13px;text-decoration:none;border-radius:7px;font-weight:600"><span style="font-size:15px;vertical-align:-1px;margin-right:6px">&#128467;&#65039;</span>Apple Calendar</a></td>`
          : ""
      }</tr></table>`
    : "";
  return `${manageButton}${calendarButtons}`;
}

function clientActionButtonsText(action: BookingAction, variables: Record<string, string>) {
  if (action === "cancelled" || action === "test") return [];
  return [
    variables.rescheduleUrl ? `Manage / Reschedule: ${variables.rescheduleUrl}` : "",
    variables.googleCalendarUrl ? `Google Calendar: ${variables.googleCalendarUrl}` : "",
    variables.appleCalendarUrl ? `Apple Calendar: ${variables.appleCalendarUrl}` : "",
  ].filter(Boolean);
}

function bodyFor(
  action: BookingAction,
  appt: any,
  previous: any,
  serviceName: string,
  settings: any,
  variables: Record<string, string>,
  channel: NotificationChannel,
) {
  const labels = actionLabels(action);
  const isClient = channel === "client";
  const previousValue = previous ? `${variables.previousDate}, ${variables.previousTime}` : "";
  const rows: Array<[string, string]> = isClient
    ? [
        ["Lesson", serviceName],
        ["When", `${variables.date}, ${variables.time}`],
        ["Previous", previousValue],
        ["Where", variables.venue],
      ]
    : [
        ["Client", variables.client],
        ["Lesson", serviceName],
        ["When", `${variables.date}, ${variables.time}`],
        ["Previous", previousValue],
        ["Phone", variables.phone],
        ["Email", variables.email],
        ["Where", variables.venue],
        ["Booking ID", appt.id],
      ];
  const intro = isClient ? clientIntro(action, settings, variables) : render(settings.adminEmailIntro, variables);
  const footer = isClient
    ? clientFooter(action, settings, variables)
    : `${channel === "coach" ? "Coach" : "Admin"} booking alert.`;
  const actionsHtml = isClient ? clientActionButtonsHtml(action, variables) : "";
  const actionsText = isClient ? clientActionButtonsText(action, variables) : [];
  const textRows = rows.filter(([, value]) => Boolean(value)).map(([label, value]) => `${label}: ${value}`);
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.55;color:#101612;max-width:600px"><h2 style="margin:0 0 12px">${escapeHtml(labels.title)}</h2><p style="margin:0 0 14px">${escapeHtml(intro)}</p>${detailTable(rows)}${actionsHtml}<p style="margin:18px 0 0;color:#526054">${escapeHtml(footer).replace(/\n/g, "<br/>")}</p></div>`;
  const text = [labels.title, "", intro, "", ...textRows, "", ...actionsText, actionsText.length ? "" : "", footer]
    .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
    .join("\n");
  return { html, text };
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
  const personKey = appt.email ? `email:${appt.email}` : appt.phone ? `phone:${appt.phone}` : `name:${appt.client.toLowerCase()}`;
  const signature = hash({ action, appt, previous, source: input.source }).slice(0, 24);
  const results: any[] = [];

  async function sendAndRecord(channel: NotificationChannel, recipient: string, subject: string) {
    const kind = `${action}_${channel}_email`;
    if (!recipient) {
      const skipped = { channel, recipient, subject, kind, status: "skipped", sent: false, reason: "missing_recipient" };
      results.push(skipped);
      await recordNotification({ personKey, calendarItemId: appt.id, recipient, subject, kind, status: "skipped", provider: "settings", error: "missing_recipient" });
      return;
    }
    const body = bodyFor(action, appt, previous, serviceName, settings, variables, channel);
    const result = await sendEmail({
      to: recipient,
      subject,
      html: body.html,
      text: body.text,
      replyTo: settings.replyToEmail || settings.contactEmail,
      idempotencyKey: `${kind}-${appt.id}-${signature}`,
    });
    const status = result.sent ? "sent" : "failed";
    const output = { channel, recipient, subject, kind, status, ...result };
    results.push(output);
    await recordNotification({ personKey, calendarItemId: appt.id, recipient, subject, kind, status, provider: "resend", providerId: result.id || "", error: result.reason || result.error || "" });
    console.log(
      "notification_engine:result",
      JSON.stringify({ action, channel, recipient, status, reason: result.reason || "", providerId: result.id || "" }),
    );
  }

  if (action === "test") {
    await sendAndRecord("client", cleanEmail(input.testRecipient, appt.email), subjects.client);
    return results;
  }

  if (settings.sendClientEmail || action === "cancelled" || action === "rescheduled") {
    await sendAndRecord("client", appt.email, subjects.client);
  } else {
    await recordNotification({ personKey, calendarItemId: appt.id, recipient: appt.email, subject: subjects.client, kind: `${action}_client_email`, status: "skipped", provider: "settings", error: "disabled_client_email" });
  }

  if (settings.sendCoachEmail || action === "cancelled" || action === "rescheduled") {
    await sendAndRecord("coach", settings.coachEmail || "", subjects.admin);
  } else {
    await recordNotification({ personKey, calendarItemId: appt.id, recipient: settings.coachEmail || "", subject: subjects.admin, kind: `${action}_coach_email`, status: "skipped", provider: "settings", error: "disabled_coach_email" });
  }

  if (settings.sendAdminEmail || action === "cancelled" || action === "rescheduled") {
    await sendAndRecord("admin", settings.notificationEmail || settings.contactEmail, subjects.admin);
  } else {
    await recordNotification({ personKey, calendarItemId: appt.id, recipient: settings.notificationEmail || settings.contactEmail, subject: subjects.admin, kind: `${action}_admin_email`, status: "skipped", provider: "settings", error: "disabled_admin_email" });
  }

  return results;
}

export function inferBookingAction(previous: any, next: any): BookingAction | null {
  if (!previous && next?.kind === "appointment") return "booking";
  if (previous?.kind === "appointment" && !next) {
    return previous.status === "cancelled" ? null : "cancelled";
  }
  if (!previous || !next || next.kind !== "appointment") return null;
  if (previous.status !== "cancelled" && next.status === "cancelled") return "cancelled";
  if (previous.status === "cancelled" && next.status !== "cancelled") return "updated";
  const slotChanged =
    Number(previous.week ?? 0) !== Number(next.week ?? 0) ||
    Number(previous.day ?? 0) !== Number(next.day ?? 0) ||
    Number(previous.start ?? 0) !== Number(next.start ?? 0) ||
    Number(previous.duration ?? 0) !== Number(next.duration ?? 0);
  if (slotChanged) return "rescheduled";
  const contactChanged =
    cleanText(previous.client || previous.title) !== cleanText(next.client || next.title) ||
    cleanEmail(previous.email) !== cleanEmail(next.email) ||
    cleanText(previous.phone) !== cleanText(next.phone) ||
    cleanText(previous.serviceId || previous.service_id) !== cleanText(next.serviceId || next.service_id);
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
