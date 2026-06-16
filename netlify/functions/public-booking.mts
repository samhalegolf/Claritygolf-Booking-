import type { Config, Context } from "@netlify/functions";

import { handlePublicBookingRequest } from "./booking-core.mts";

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function cleanText(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function timeLabel(minutes: number) {
  const hour24 = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour = hour24 % 12 || 12;
  return `${hour}:${String(mins).padStart(2, "0")} ${period}`;
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function sendDirectBookingEmail({ to, subject, text, html, key }: { to: string; subject: string; text: string; html: string; key: string }) {
  const apiKey = env("RESEND_API_KEY");
  if (!apiKey || !to) return { sent: false, reason: !apiKey ? "missing_resend_key" : "missing_recipient" };

  const from = env("CLARITY_EMAIL_FROM", "Clarity Golf Booking <onboarding@resend.dev>");
  const replyTo = env("CLARITY_REPLY_TO_EMAIL", env("CLARITY_NOTIFICATION_EMAIL", ""));
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html,
      text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  const responseText = await response.text().catch(() => "");
  if (!response.ok) return { sent: false, reason: "resend_failed", status: response.status, error: responseText.slice(0, 500) };
  try {
    const data = responseText ? JSON.parse(responseText) : {};
    return { sent: true, id: data?.id || "" };
  } catch {
    return { sent: true, id: "" };
  }
}

async function sendDirectPublicBookingEmails(payload: any, result: any) {
  const firstName = cleanText(payload?.firstName);
  const lastName = cleanText(payload?.lastName);
  const client = [firstName, lastName].filter(Boolean).join(" ") || "Client";
  const clientEmail = cleanText(payload?.email);
  const phone = cleanText(payload?.phone);
  const service = cleanText(payload?.serviceName, cleanText(payload?.serviceId, "Golf lesson"));
  const week = Number(result?.appointment?.week ?? payload?.week ?? 0);
  const day = Number(result?.appointment?.day ?? payload?.day ?? 0);
  const start = Number(result?.appointment?.start ?? payload?.start ?? 0);
  const appointmentId = cleanText(result?.appointment?.id, `booking-${Date.now()}`);
  const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const when = `${dayNames[day] || "Selected day"}, ${timeLabel(start)}`;
  const adminEmail = cleanText(env("CLARITY_NOTIFICATION_EMAIL"), cleanText(env("CLARITY_CONTACT_EMAIL"), "sam@samhalegolf.co.nz"));

  const lines = [
    `Booking: ${service}`,
    `Client: ${client}`,
    `Email: ${clientEmail}`,
    `Phone: ${phone || "Not supplied"}`,
    `When: ${when}`,
    `Booking ID: ${appointmentId}`,
  ];
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.5;color:#111"><h2>${escapeHtml(service)} booking</h2>${lines
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("")}</div>`;
  const text = lines.join("\n");

  const sends = [];
  sends.push(
    sendDirectBookingEmail({
      to: adminEmail,
      subject: `New booking: ${client}`,
      text,
      html,
      key: `public-booking-admin-${appointmentId}-${Date.now()}`,
    }),
  );
  if (clientEmail) {
    sends.push(
      sendDirectBookingEmail({
        to: clientEmail,
        subject: "Your golf lesson booking is received",
        text: `Thanks ${firstName || client}, your booking has been received.\n\n${text}`,
        html: `<div style="font-family:Arial,sans-serif;line-height:1.5;color:#111"><p>Thanks ${escapeHtml(firstName || client)}, your booking has been received.</p>${html}</div>`,
        key: `public-booking-client-${appointmentId}-${Date.now()}`,
      }),
    );
  }
  return Promise.all(sends);
}

export default async (req: Request, context: Context) => {
  const payload = req.method === "POST" ? await req.clone().json().catch(() => ({})) : {};
  const response = await handlePublicBookingRequest(req, context);
  if (req.method === "POST" && response.ok) {
    try {
      const result = await response.clone().json();
      const directEmailTask = sendDirectPublicBookingEmails(payload, result).then((directEmails) => {
        console.log("public_booking:direct_emails", JSON.stringify(directEmails));
      });
      if (context?.waitUntil) context.waitUntil(directEmailTask);
      else void directEmailTask;
    } catch (error) {
      console.error("public_booking:direct_email_failed", error);
    }
  }
  return response;
};

export const config: Config = {
  path: "/api/public-booking",
};
