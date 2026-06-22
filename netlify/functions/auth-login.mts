import type { Config } from "@netlify/functions";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

// Supabase-backed admin login. Keep this route out of the Netlify DB catch-all.
const sessionCookieName = "clarity_session";
const sessionDays = 7;

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}
