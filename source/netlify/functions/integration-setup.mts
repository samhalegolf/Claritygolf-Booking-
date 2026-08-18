import { createHash } from "node:crypto";
import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";

import { allIntegrations, integrationById, integrationsFor } from "./_shared/integrations/catalogue.mts";
import { integrationRequest } from "./_shared/integrations/db.mts";
import { providerCapabilities } from "./_shared/integrations/registry.mts";
import type { ConnectionSpec, FieldSpec, IntegrationDescriptor } from "./_shared/integrations/types.mts";

/**
 * What the Integrations screens need to draw themselves.
 *
 * Two modes. Without ?id it returns every integration with enough status to
 * draw a card; with ?id it returns one, resolved down to fields a browser can
 * render.
 *
 * The rule this endpoint exists to enforce: a secret's VALUE never leaves the
 * server. What leaves is whether it is set, how long it is, and a fingerprint —
 * enough to tell two secrets apart and to catch the trailing newline that
 * rejects every request, and nowhere near enough to reconstruct one.
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

/** A `copy` field's value depends on the deployment, so it is worked out here. */
function computed(field: FieldSpec, connection: ConnectionSpec, origin: string) {
  switch (field.compute) {
    case "webhook-url":
      return connection.path ? `${origin}${connection.path}` : "";
    case "redirect-uri":
      return `${origin}/api/google-calendar/callback`;
    case "event-list":
      return (connection.events || []).map((event) => event.id).join("\n");
    case "signature-recipe":
      return connection.signatureRecipe || "";
    default:
      return "";
  }
}

function resolveField(field: FieldSpec, connection: ConnectionSpec, origin: string) {
  const base = {
    key: field.key,
    type: field.type,
    label: field.label,
    help: field.help,
    required: field.required,
    group: field.group || "",
    defaultValue: field.defaultValue || "",
    choices: field.choices || [],
  };

  // Ours to give away: no secret, no storage, just a value to copy.
  if (field.type === "copy") {
    return { ...base, value: computed(field, connection, origin), set: true, length: 0, fingerprint: "", hasSurroundingWhitespace: false };
  }
  // Not a value at all — a handshake. Whether it is connected is a question for
  // the token store, which the panel asks separately.
  if (field.type === "oauth") {
    return { ...base, value: "", set: false, length: 0, fingerprint: "", hasSurroundingWhitespace: false };
  }

  const raw = env(field.key);
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ...base, value: "", set: false, length: 0, fingerprint: "", hasSurroundingWhitespace: false };
  }
  return {
    ...base,
    set: true,
    length: trimmed.length,
    // Four hex characters of a salted hash: enough to tell two secrets apart or
    // to compare against what the other system shows, nowhere near enough to
    // work backwards to one.
    fingerprint: createHash("sha256").update(`clarity:${field.key}:${trimmed}`).digest("hex").slice(0, 4),
    // Surfaced rather than quietly trimmed. Whitespace around a credential is a
    // real and maddening cause of 401s, and the env var is the thing to fix.
    hasSurroundingWhitespace: raw.length !== trimmed.length,
    // A non-secret reports its value: hiding an endpoint or a numeric id helps
    // nobody, and seeing it is how you spot the wrong one.
    value: field.type === "secret" ? "" : trimmed,
  };
}

/**
 * Is this integration usable right now?
 *
 * "one-of" fields count as satisfied when any member of their group is set —
 * Optix takes either token, Stripe falls back between two webhook secrets. A
 * check that demanded both would report a working integration as broken.
 */
function integrationStatus(descriptor: IntegrationDescriptor) {
  const missing: string[] = [];
  const satisfiedGroups = new Set<string>();
  const groupFields = new Map<string, FieldSpec[]>();

  for (const connection of descriptor.connections) {
    for (const field of connection.fields) {
      if (field.type === "copy" || field.type === "oauth") continue;
      const set = Boolean(env(field.key).trim());
      if (field.required === "one-of" && field.group) {
        const group = groupFields.get(field.group) || [];
        group.push(field);
        groupFields.set(field.group, group);
        if (set) satisfiedGroups.add(field.group);
        continue;
      }
      if (field.required === true && !set) missing.push(field.key);
    }
  }
  for (const [group, fields] of groupFields) {
    if (!satisfiedGroups.has(group)) missing.push(fields.map((field) => field.key).join(" or "));
  }

  const configured = missing.length === 0;
  return {
    configured,
    missing,
    // An OAuth integration is never "ready" from fields alone: the app existing
    // is not the same as somebody having said yes to it.
    needsAuthorisation: descriptor.connections.some((connection) => connection.kind === "oauth2"),
  };
}

/**
 * Whether an OAuth integration is actually connected.
 *
 * Not a question the environment can answer. A client id and secret being set
 * says the app EXISTS; it says nothing about whether anyone has signed in, and
 * the two are days or months apart. The truth is a stored refresh token, which
 * is what the Google Calendar panel has always read — this makes the card agree
 * with it instead of contradicting it one screen higher.
 */
async function oauthState() {
  const rows = await integrationRequest(
    "google_provider_connections?select=provider_email,connection_status,granted_scopes_json,last_error_code,last_successful_use_at,revoked_at&order=updated_at.desc&limit=1",
  ).catch(() => []);
  const row = (rows || [])[0];
  if (!row || row.revoked_at) return { connected: false, account: "", scopes: [] as string[], lastUsed: "", error: "" };
  let scopes: string[] = [];
  try { scopes = JSON.parse(row.granted_scopes_json || "[]"); } catch { scopes = []; }
  return {
    connected: row.connection_status === "connected",
    account: row.provider_email || "",
    scopes,
    lastUsed: row.last_successful_use_at || "",
    error: row.last_error_code || "",
  };
}

function card(descriptor: IntegrationDescriptor) {
  return {
    id: descriptor.id,
    label: descriptor.label,
    audience: descriptor.audience,
    category: descriptor.category,
    caveat: descriptor.caveat || "",
    // The card says "same sign-in as Google Calendar", so it needs the other
    // entry's label — which the client cannot look up, because the twin lives
    // in the other audience's list.
    sharesGrantWith: descriptor.sharesGrantWith
      ? integrationById(descriptor.sharesGrantWith)?.label || descriptor.sharesGrantWith
      : "",
    summary: descriptor.summary,
    kinds: descriptor.connections.map((connection) => connection.kind),
    ...integrationStatus(descriptor),
  };
}

export default async function handler(req: Request) {
  if (!(await requireAdmin(req))) return json({ error: "unauthorized" }, 401);
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const audience = url.searchParams.get("audience");

  // List mode: everything Clarity has code for, configured or not. The ones
  // that are not configured are the "+ New integration" list — four of them are
  // live in the product today and invisible in it.
  //
  // ?audience splits that list in two: what a coach has plugged in, versus what
  // the software itself runs on. No audience means the whole catalogue, which
  // is what anything asking "is everything set up" wants.
  if (!id) {
    const list = audience === "admin" || audience === "integration" ? integrationsFor(audience) : allIntegrations();
    const cards = list.map(card);
    const oauth = await oauthState();
    return json({
      integrations: cards.map((entry) =>
        // An OAuth integration reports what the token store says, not what the
        // field scan guessed. Connected wins over "fields missing": you cannot
        // have signed in without an app to sign into.
        entry.needsAuthorisation
          ? { ...entry, configured: oauth.connected || entry.configured, connectedAs: oauth.account, connectionError: oauth.error }
          : entry,
      ),
    });
  }

  const descriptor = integrationById(id);
  if (!descriptor) {
    return json({
      error: "unknown_integration",
      message: `Clarity has no integration called "${id}".`,
      available: allIntegrations().map((entry) => ({ id: entry.id, label: entry.label })),
    }, 404);
  }

  const oauth = descriptor.connections.some((connection) => connection.kind === "oauth2")
    ? await oauthState()
    : null;

  return json({
    oauth,
    integration: {
      id: descriptor.id,
      label: descriptor.label,
      audience: descriptor.audience,
      category: descriptor.category,
      caveat: descriptor.caveat || "",
      summary: descriptor.summary,
      docsUrl: descriptor.docsUrl || "",
      vocabulary: descriptor.vocabulary || { workspace: "workspace", resource: "resource" },
      // Only a booking provider has capabilities to report; the rest are
      // outbound and have nothing to say here.
      capabilities: descriptor.category === "resource-booking" ? providerCapabilities(descriptor.id) : null,
      ...integrationStatus(descriptor),
      ...(oauth?.connected ? { configured: true } : {}),
    },
    connections: descriptor.connections.map((connection) => ({
      kind: connection.kind,
      title: connection.title,
      summary: connection.summary,
      transport: connection.transport || "",
      events: connection.events || [],
      operations: connection.operations || [],
      signatureRecipe: connection.signatureRecipe || "",
      fields: connection.fields.map((field) => resolveField(field, connection, url.origin)),
    })),
  });
}

export const config: Config = { path: "/api/integration-setup" };
