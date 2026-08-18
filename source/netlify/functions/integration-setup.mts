import { createHash } from "node:crypto";
import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";

import { adapterFor, connectedProviders, providerCapabilities } from "./_shared/integrations/registry.mts";
import type { CredentialSpec } from "./_shared/integrations/types.mts";

/**
 * What the setup screens need to draw themselves, for any provider.
 *
 * Two halves, and the split is the point:
 *
 *   "give these to them"   the webhook URL, the events to subscribe to, the
 *                          signature recipe. Facts about Clarity. Read-only,
 *                          copyable, impossible to type wrong.
 *
 *   "paste these from them" the credentials. Reported as set/not-set only,
 *                          never as values.
 *
 * Knowing which direction a value travels is the hard part of wiring up any
 * integration, so direction is the shape of the response rather than something
 * the UI has to infer.
 */

const SESSION_COOKIE = "clarity_session";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function cookies(req: Request) {
  return Object.fromEntries((req.headers.get("cookie") || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const at = part.indexOf("=");
    return at < 0 ? [decodeURIComponent(part), ""] : [decodeURIComponent(part.slice(0, at)), decodeURIComponent(part.slice(at + 1))];
  }));
}

async function requireAdmin(req: Request) {
  const token = cookies(req)[SESSION_COOKIE] || "";
  if (!token) return false;
  const hash = createHash("sha256").update(token).digest("hex");
  const rows = await getDatabase().sql`SELECT id FROM admin_sessions WHERE token_hash = ${hash} AND expires_at > NOW() LIMIT 1`;
  return rows.length > 0;
}

function env(name: string) {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || "";
}

/**
 * A credential's state, without its value.
 *
 * `length` and `fingerprint` are here for one specific bug: a secret pasted
 * with a trailing newline is invisible behind eight dots and rejects every
 * delivery. A length one longer than expected gives it away instantly, and a
 * fingerprint lets you compare what Clarity holds against what the other system
 * shows without either side revealing anything.
 *
 * Four hex characters of a salted hash is 65,536 buckets — enough to tell two
 * secrets apart, nowhere near enough to work backwards to one.
 *
 * A non-secret credential (an endpoint, a numeric member id) reports its value,
 * because hiding it helps nobody and seeing it is how you spot the wrong one.
 */
function credentialStatus(spec: CredentialSpec) {
  const raw = env(spec.key);
  const trimmed = raw.trim();
  const base = {
    key: spec.key,
    label: spec.label,
    help: spec.help,
    secret: spec.secret,
    required: spec.required,
    defaultValue: spec.defaultValue || "",
    set: trimmed.length > 0,
    length: trimmed.length,
    // Surfaced rather than silently trimmed: whitespace around a credential is
    // a real and maddening cause of 401s, and the env var is the thing to fix.
    hasSurroundingWhitespace: raw.length !== trimmed.length,
  };
  if (!trimmed) return { ...base, fingerprint: "", value: "" };
  return {
    ...base,
    fingerprint: createHash("sha256").update(`clarity:${spec.key}:${trimmed}`).digest("hex").slice(0, 4),
    value: spec.secret ? "" : trimmed,
  };
}

export default async function handler(req: Request) {
  if (!(await requireAdmin(req))) return json({ error: "unauthorized" }, 401);
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const url = new URL(req.url);
  const requested = url.searchParams.get("provider") || "optix";
  const adapter = adapterFor(requested);
  if (!adapter) {
    return json({
      error: "unknown_provider",
      message: `Clarity has no adapter for "${requested}".`,
      available: connectedProviders().map((candidate) => ({ id: candidate.id, label: candidate.label })),
    }, 404);
  }

  const descriptor = adapter.descriptor;
  const capabilities = providerCapabilities(adapter.id);

  return json({
    providers: connectedProviders().map((candidate) => ({ id: candidate.id, label: candidate.label })),
    provider: {
      id: descriptor.id,
      label: descriptor.label,
      docsUrl: descriptor.docsUrl || "",
      vocabulary: descriptor.vocabulary,
      capabilities,
    },
    // Inbound. `url` is absolute because the whole point is pasting it
    // somewhere else, and a path alone is one more thing to get wrong.
    webhook: descriptor.webhook
      ? {
          url: `${url.origin}${descriptor.webhook.path}`,
          events: descriptor.webhook.events,
          signatureRecipe: descriptor.webhook.signatureRecipe || "",
          credentials: descriptor.webhook.credentials.map(credentialStatus),
        }
      : null,
    // Outbound.
    api: descriptor.api
      ? {
          kind: descriptor.api.kind,
          operations: descriptor.api.operations,
          credentials: descriptor.api.credentials.map(credentialStatus),
        }
      : null,
  });
}

export const config: Config = { path: "/api/integration-setup" };
