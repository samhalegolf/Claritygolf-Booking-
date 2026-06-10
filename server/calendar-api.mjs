import {
  cleanupExpiredPasswordResets,
  cleanupExpiredSessions,
  createAdminSession,
  createPasswordReset,
  createPublicBooking,
  destroyAdminSession,
  generateCalendarFeed,
  generateSyncKey,
  importPeople,
  publicBookingState,
  publicCalendarState,
  readAvailability,
  readPeople,
  readAdminSession,
  readAdminSettings,
  readBrandSettings,
  readCalendarState,
  readCoachAccount,
  readServices,
  resetAdminPassword,
  updatePerson,
  verifyAdminPassword,
  writeAdminSettings,
  writeAvailability,
  writeBrandSettings,
  writeCalendarState,
  writeCoachAccount,
  writeServices,
} from "./calendar-store.mjs";
import { createHash } from "node:crypto";

const maxBodySize = 1_000_000;
const sessionCookieName = "clarity_session";
const passwordResetMinutes = 30;

function send(res, status, headers, body) {
  res.statusCode = status;
  Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
  res.end(body);
}

function sendJson(res, status, value, extraHeaders = {}) {
  send(
    res,
    status,
    {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
    JSON.stringify(value),
  );
}

function sendText(res, status, value) {
  send(
    res,
    status,
    {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
    value,
  );
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodySize) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const index = pair.indexOf("=");
        return index === -1
          ? [decodeURIComponent(pair), ""]
          : [decodeURIComponent(pair.slice(0, index)), decodeURIComponent(pair.slice(index + 1))];
      }),
  );
}

function sessionTokenFromRequest(req) {
  return parseCookies(req)[sessionCookieName] || "";
}

function cookieHeader(token, req, maxAgeSeconds) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const host = req.headers.host || "";
  const secure = forwardedProto === "https" || (!host.startsWith("127.0.0.1") && !host.startsWith("localhost"));
  return [
    `${sessionCookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function clearCookieHeader() {
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function passwordResetUrl(req, token) {
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers.host || "127.0.0.1:5173";
  const origin = env("CLARITY_APP_URL", `${protocol}://${host}`).replace(/\/$/, "");
  const url = new URL(origin || `${protocol}://${host}`);
  url.searchParams.set("reset", token);
  return url.toString();
}

async function sendPasswordResetEmail(reset, req) {
  const apiKey = env("RESEND_API_KEY");
  if (!apiKey) return { sent: false, reason: "missing_resend_key" };

  const account = await readCoachAccount();
  const resetUrl = passwordResetUrl(req, reset.token);
  const businessName = account.businessName || "Clarity Golf";
  const from = env("CLARITY_EMAIL_FROM", `${businessName} <onboarding@resend.dev>`);
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
      <h2>${escapeHtml(businessName)} password reset</h2>
      <p>Use the button below to reset your Clarity Golf Booking admin password. This link expires in ${passwordResetMinutes} minutes.</p>
      <p><a href="${escapeHtml(resetUrl)}" style="display:inline-block;background:#07100a;color:#fff;padding:12px 16px;text-decoration:none;border-radius:6px">Reset password</a></p>
      <p>If the button does not work, paste this link into your browser:</p>
      <p><a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a></p>
      <p>If you did not request this, you can ignore this email.</p>
    </div>
  `;
  const textBody = [
    `${businessName} password reset`,
    "",
    `Use this link to reset your Clarity Golf Booking admin password. It expires in ${passwordResetMinutes} minutes:`,
    resetUrl,
    "",
    "If you did not request this, you can ignore this email.",
  ].join("\n");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `password-reset-${createHash("sha256").update(reset.token).digest("hex").slice(0, 24)}`,
    },
    body: JSON.stringify({
      from,
      to: [reset.email],
      subject: `${businessName} password reset`,
      html,
      text: textBody,
    }),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    console.error("Password reset email failed", response.status, message.slice(0, 500));
    return { sent: false, reason: "resend_failed" };
  }

  return { sent: true };
}

async function requireAdmin(req, res) {
  const session = await readAdminSession(sessionTokenFromRequest(req));
  if (!session) {
    sendJson(res, 401, { error: "unauthorized", message: "Admin login required." });
    return null;
  }
  return session;
}

function isCalendarFeedPath(pathname) {
  return /^\/calendar\/[a-z0-9-]+\.ics$/.test(pathname);
}

export function calendarApiMiddleware() {
  return async function clarityCalendarApi(req, res, next) {
    if (!req.url) {
      next();
      return;
    }

    const url = new URL(req.url, "http://clarity.local");
    const { pathname } = url;

    if (req.method === "OPTIONS" && (pathname.startsWith("/api/") || pathname.startsWith("/calendar/"))) {
      send(
        res,
        204,
        {
          "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Credentials": "true",
        },
        "",
      );
      return;
    }

    try {
      if (req.method === "GET" && isCalendarFeedPath(pathname)) {
        const state = await readCalendarState();
        if (url.searchParams.get("key") !== state.syncKey) {
          sendText(res, 401, "Invalid calendar sync key.");
          return;
        }

        send(
          res,
          200,
          {
            "Content-Type": "text/calendar; charset=utf-8",
            "Cache-Control": "no-cache, max-age=0",
            "Content-Disposition": 'inline; filename="sam-hale-golf.ics"',
          },
          generateCalendarFeed(state),
        );
        return;
      }

      if (req.method === "POST" && pathname === "/api/auth/login") {
        await cleanupExpiredSessions();
        const body = await readJsonBody(req);
        const user = await verifyAdminPassword(body.email || "sam@clarity.golf", body.password || "");
        if (!user) {
          sendJson(res, 401, { error: "invalid_login", message: "Email or password is incorrect." });
          return;
        }
        const session = await createAdminSession(user.id);
        sendJson(
          res,
          200,
          { authenticated: true, email: user.email, expiresAt: session.expiresAt },
          { "Set-Cookie": cookieHeader(session.token, req, 7 * 24 * 60 * 60) },
        );
        return;
      }

      if (req.method === "POST" && pathname === "/api/auth/forgot-password") {
        if (!env("RESEND_API_KEY")) {
          sendJson(res, 503, { ok: false, message: "Password reset email is not configured yet." });
          return;
        }

        await cleanupExpiredPasswordResets();
        const body = await readJsonBody(req);
        const reset = await createPasswordReset(body.email || "");
        if (reset) {
          const emailResult = await sendPasswordResetEmail(reset, req);
          if (!emailResult.sent) {
            sendJson(res, 502, { ok: false, message: "Could not send the reset email. Try again in a minute." });
            return;
          }
        }

        sendJson(res, 200, { ok: true, message: "If that email matches an admin account, a reset link has been sent." });
        return;
      }

      if (req.method === "POST" && pathname === "/api/auth/reset-password") {
        await cleanupExpiredPasswordResets();
        const body = await readJsonBody(req);
        const result = await resetAdminPassword(body.token || "", body.password || "");
        if (result.error === "weak_password") {
          sendJson(res, 400, { error: "weak_password", message: "Use at least 8 characters." });
          return;
        }
        if (!result.user) {
          sendJson(res, 400, { error: "invalid_token", message: "This reset link has expired or has already been used." });
          return;
        }
        const session = await createAdminSession(result.user.id);
        sendJson(
          res,
          200,
          { authenticated: true, email: result.user.email, expiresAt: session.expiresAt },
          { "Set-Cookie": cookieHeader(session.token, req, 7 * 24 * 60 * 60) },
        );
        return;
      }

      if (req.method === "POST" && pathname === "/api/auth/logout") {
        await destroyAdminSession(sessionTokenFromRequest(req));
        sendJson(res, 200, { authenticated: false }, { "Set-Cookie": clearCookieHeader() });
        return;
      }

      if (req.method === "GET" && pathname === "/api/auth/session") {
        const session = await readAdminSession(sessionTokenFromRequest(req));
        sendJson(res, 200, session ? { authenticated: true, email: session.email } : { authenticated: false });
        return;
      }

      if (req.method === "GET" && pathname === "/api/public-booking-state") {
        sendJson(res, 200, publicBookingState(await readCalendarState()));
        return;
      }

      if (req.method === "POST" && pathname === "/api/public-booking") {
        const result = await createPublicBooking(await readJsonBody(req));
        sendJson(res, 201, {
          appointment: {
            id: result.appointment.id,
            week: result.appointment.week,
            day: result.appointment.day,
            start: result.appointment.start,
            duration: result.appointment.duration,
          },
          state: publicBookingState(result.state),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/calendar-state") {
        if (!(await requireAdmin(req, res))) return;
        sendJson(res, 200, publicCalendarState(await readCalendarState()));
        return;
      }

      if (req.method === "PUT" && pathname === "/api/calendar-state") {
        if (!(await requireAdmin(req, res))) return;
        const body = await readJsonBody(req);
        const current = await readCalendarState();
        const state = await writeCalendarState({
          syncKey: typeof body.syncKey === "string" ? body.syncKey : current.syncKey,
          items: Array.isArray(body.items) ? body.items : current.items,
        });
        sendJson(res, 200, publicCalendarState(state));
        return;
      }

      if (req.method === "PUT" && pathname === "/api/calendar-sync-key") {
        if (!(await requireAdmin(req, res))) return;
        const body = await readJsonBody(req);
        const current = await readCalendarState();
        const state = await writeCalendarState({
          ...current,
          syncKey: typeof body.syncKey === "string" && body.syncKey.startsWith("cg_") ? body.syncKey : generateSyncKey(),
        });
        sendJson(res, 200, publicCalendarState(state));
        return;
      }

      if (req.method === "GET" && pathname === "/api/admin-settings") {
        if (!(await requireAdmin(req, res))) return;
        sendJson(res, 200, await readAdminSettings());
        return;
      }

      if (req.method === "PUT" && pathname === "/api/admin-settings") {
        if (!(await requireAdmin(req, res))) return;
        sendJson(res, 200, await writeAdminSettings(await readJsonBody(req)));
        return;
      }

      if (req.method === "GET" && pathname === "/api/coach-account") {
        if (!(await requireAdmin(req, res))) return;
        sendJson(res, 200, await readCoachAccount());
        return;
      }

      if (req.method === "PUT" && pathname === "/api/coach-account") {
        if (!(await requireAdmin(req, res))) return;
        sendJson(res, 200, await writeCoachAccount(await readJsonBody(req)));
        return;
      }

      if (req.method === "GET" && pathname === "/api/services") {
        if (!(await requireAdmin(req, res))) return;
        sendJson(res, 200, { services: readServices() });
        return;
      }

      if (req.method === "PUT" && pathname === "/api/services") {
        if (!(await requireAdmin(req, res))) return;
        const body = await readJsonBody(req);
        sendJson(res, 200, { services: writeServices(body.services) });
        return;
      }

      if (req.method === "GET" && pathname === "/api/availability") {
        if (!(await requireAdmin(req, res))) return;
        sendJson(res, 200, { availability: readAvailability() });
        return;
      }

      if (req.method === "PUT" && pathname === "/api/availability") {
        if (!(await requireAdmin(req, res))) return;
        const body = await readJsonBody(req);
        sendJson(res, 200, { availability: writeAvailability(body.availability) });
        return;
      }

      if (req.method === "GET" && pathname === "/api/brand-settings") {
        if (!(await requireAdmin(req, res))) return;
        sendJson(res, 200, await readBrandSettings());
        return;
      }

      if (req.method === "PUT" && pathname === "/api/brand-settings") {
        if (!(await requireAdmin(req, res))) return;
        sendJson(res, 200, await writeBrandSettings(await readJsonBody(req)));
        return;
      }

      if (req.method === "GET" && pathname === "/api/people") {
        if (!(await requireAdmin(req, res))) return;
        sendJson(res, 200, { people: readPeople() });
        return;
      }

      if (req.method === "POST" && pathname === "/api/people/import") {
        if (!(await requireAdmin(req, res))) return;
        const body = await readJsonBody(req);
        sendJson(res, 201, importPeople(body.people, "manual_import"));
        return;
      }

      if (req.method === "PUT" && pathname === "/api/people") {
        if (!(await requireAdmin(req, res))) return;
        const body = await readJsonBody(req);
        sendJson(res, 200, updatePerson(body.person || body));
        return;
      }

      next();
    } catch (error) {
      sendJson(res, error?.status || 500, {
        error: error?.status ? "request_error" : "calendar_api_error",
        message: error instanceof Error ? error.message : "Unknown calendar API error",
      });
    }
  };
}
