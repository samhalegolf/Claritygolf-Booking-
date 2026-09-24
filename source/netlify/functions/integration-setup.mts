import type { Config } from "@netlify/functions";
import { requireCoachActor, type CoachActor } from "./_shared/coach-auth.mts";
import { getDatabase } from "./_shared/database.mts";
import {
  credentialFingerprint,
  isOriginalWorkspace,
  isTenantIntegration,
  readAccountStripeSecret,
  readStoredCredentials,
  saveIntegrationCredentials,
  webhookUrlForAccount,
} from "./_shared/integration-credentials.mts";
import { isStripeSecretShaped, STRIPE_SECRET_SETTING } from "./_shared/stripe.mts";

import { allIntegrations, integrationById, integrationsFor } from "./_shared/integrations/catalogue.mts";
import { integrationRequest } from "./_shared/integrations/db.mts";
import { providerCapabilities } from "./_shared/integrations/registry.mts";
import type { ConnectionSpec, FieldSpec, IntegrationDescriptor } from "./_shared/integrations/types.mts";

/**
 * What the Integrations screens need to draw themselves, and where a business
 * saves its own credentials.
 *
 *   GET            every integration, with enough status to draw a card
 *   GET ?id=       one integration, resolved down to fields a browser can render
 *   PUT ?id=       save or clear this business's own credentials for it
 *
 * Everything is per business. A field's value comes from what THIS business
 * saved (see _shared/integration-credentials.mts); only the original workspace
 * falls back to the deployment's env vars, because those are its own tokens.
 * Any other business -- a sandbox, a second tenant -- starts with every
 * integration unset and sees no trace of anybody else's.
 *
 * The rule this endpoint exists to enforce: a secret's VALUE never leaves the
 * server. What leaves is whether it is set, how long it is, and a fingerprint —
 * enough to tell two secrets apart and to catch the trailing newline that
 * rejects every request, and nowhere near enough to reconstruct one.
 */

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function env(name: string) {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || "";
}

/** Field types a coach can type a value into. */
const EDITABLE_TYPES = new Set(["text", "secret", "url", "choice"]);

type FieldValue = { raw: string; source: "saved" | "environment" | "" };
type ValueLookup = (key: string) => FieldValue;

/**
 * Where each of one integration's fields gets its value, for one business.
 *
 * Built once per integration per request, so status, fields and the save
 * response all agree on the same answer.
 */
async function valuesFor(descriptor: IntegrationDescriptor, accountId: string): Promise<ValueLookup> {
  const original = isOriginalWorkspace(accountId);
  const stored = isTenantIntegration(descriptor.id)
    ? await readStoredCredentials(accountId, descriptor.id)
    : {};
  // Stripe's secret key lives where Billing settings has always saved it.
  if (descriptor.id === "stripe") {
    const key = await readAccountStripeSecret(accountId);
    if (key) stored.STRIPE_SECRET_KEY = key;
  }
  return (key: string) => {
    if (stored[key]) return { raw: stored[key], source: "saved" };
    // The env vars are the original workspace's own tokens and Clarity's own
    // platform settings. Nobody else is shown them, in any form.
    if (original && env(key)) return { raw: env(key), source: "environment" };
    return { raw: "", source: "" };
  };
}

/** A `copy` field's value depends on the deployment and the business. */
function computed(field: FieldSpec, connection: ConnectionSpec, origin: string, accountId: string) {
  switch (field.compute) {
    case "webhook-url":
      // Each business registers its own URL; the webhook reads the business
      // from it and verifies with that business's secret.
      return connection.path ? webhookUrlForAccount(origin, connection.path, accountId) : "";
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

function resolveField(
  field: FieldSpec,
  connection: ConnectionSpec,
  context: { origin: string; accountId: string; value: ValueLookup; editable: boolean },
) {
  const base = {
    key: field.key,
    type: field.type,
    label: field.label,
    help: field.help,
    required: field.required,
    group: field.group || "",
    defaultValue: field.defaultValue || "",
    choices: field.choices || [],
    editable: context.editable && EDITABLE_TYPES.has(field.type),
    source: "" as FieldValue["source"],
  };

  // Ours to give away: no secret, no storage, just a value to copy.
  if (field.type === "copy") {
    return {
      ...base,
      editable: false,
      value: computed(field, connection, context.origin, context.accountId),
      set: true,
      length: 0,
      fingerprint: "",
      hasSurroundingWhitespace: false,
    };
  }
  // Not a value at all — a handshake. Whether it is connected is a question for
  // the token store, which the panel asks separately.
  if (field.type === "oauth") {
    return { ...base, editable: false, value: "", set: false, length: 0, fingerprint: "", hasSurroundingWhitespace: false };
  }

  const { raw, source } = context.value(field.key);
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ...base, value: "", set: false, length: 0, fingerprint: "", hasSurroundingWhitespace: false };
  }
  return {
    ...base,
    source,
    set: true,
    length: trimmed.length,
    // Four hex characters of a salted hash: enough to tell two secrets apart or
    // to compare against what the other system shows, nowhere near enough to
    // work backwards to one.
    fingerprint: credentialFingerprint(field.key, trimmed),
    // Surfaced rather than quietly trimmed. Whitespace around a credential is a
    // real and maddening cause of 401s, and the env var is the thing to fix.
    // (Saved values are trimmed on the way in, so only an env var can have it.)
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
function integrationStatus(descriptor: IntegrationDescriptor, value: ValueLookup) {
  const missing: string[] = [];
  const satisfiedGroups = new Set<string>();
  const groupFields = new Map<string, FieldSpec[]>();

  for (const connection of descriptor.connections) {
    for (const field of connection.fields) {
      if (field.type === "copy" || field.type === "oauth") continue;
      const set = Boolean(value(field.key).raw.trim());
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
async function oauthState(accountId: string) {
  const rows = await integrationRequest(
    "google_provider_connections?select=provider_email,connection_status,granted_scopes_json," +
      "last_error_code,last_successful_use_at,revoked_at" +
      `&account_id=eq.${encodeURIComponent(accountId)}&order=updated_at.desc&limit=1`,
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

type OAuthState = Awaited<ReturnType<typeof oauthState>>;

/**
 * An OAuth integration reports what the token store says, not what the field
 * scan guessed. For the original workspace, connected also wins over "fields
 * missing": you cannot have signed in without an app to sign into. For any
 * other business the app's client id is Clarity's, not theirs, so only their
 * own sign-in counts.
 */
function withOAuth<T extends { configured: boolean; needsAuthorisation: boolean }>(
  entry: T,
  oauth: OAuthState | null,
  original: boolean,
) {
  if (!entry.needsAuthorisation || !oauth) return entry;
  return {
    ...entry,
    configured: original ? oauth.connected || entry.configured : oauth.connected,
    connectedAs: oauth.connected ? oauth.account : "",
    connectionError: oauth.error,
  };
}

function card(descriptor: IntegrationDescriptor, value: ValueLookup, editable: boolean) {
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
    editable,
    ...integrationStatus(descriptor, value),
  };
}

/** Owners and admins manage a business's connections; a coach can look. */
function canEdit(actor: CoachActor, descriptor: IntegrationDescriptor) {
  return isTenantIntegration(descriptor.id) && (actor.isOwner || actor.isAdmin);
}

async function detail(descriptor: IntegrationDescriptor, actor: CoachActor, origin: string) {
  const accountId = actor.accountId;
  const original = isOriginalWorkspace(accountId);
  const value = await valuesFor(descriptor, accountId);
  const editable = canEdit(actor, descriptor);
  const oauth = descriptor.connections.some((connection) => connection.kind === "oauth2")
    ? await oauthState(accountId)
    : null;
  const status = withOAuth(integrationStatus(descriptor, value), oauth, original);

  return {
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
      editable,
      ...status,
    },
    connections: descriptor.connections.map((connection) => ({
      kind: connection.kind,
      title: connection.title,
      summary: connection.summary,
      transport: connection.transport || "",
      events: connection.events || [],
      operations: connection.operations || [],
      signatureRecipe: connection.signatureRecipe || "",
      fields: connection.fields.map((field) =>
        resolveField(field, connection, { origin, accountId, value, editable }),
      ),
    })),
  };
}

/**
 * Save or clear this business's own credentials for one integration.
 *
 * Only fields the catalogue lists as typeable for that integration are
 * accepted; anything else in the body is refused rather than stored, so this
 * cannot become a general-purpose place to write settings. An empty string or
 * null clears a field, after which the original workspace falls back to its
 * env var and any other business to nothing.
 */
async function save(req: Request, descriptor: IntegrationDescriptor, actor: CoachActor) {
  if (!canEdit(actor, descriptor)) {
    return json(
      {
        error: isTenantIntegration(descriptor.id) ? "forbidden" : "not_editable",
        message: isTenantIntegration(descriptor.id)
          ? "Only an owner or admin can change this business's connections."
          : `${descriptor.label} is part of Clarity itself, not something a business connects.`,
      },
      403,
    );
  }

  const body = await req.json().catch(() => null);
  const values = body && typeof body.values === "object" && body.values ? (body.values as Record<string, unknown>) : null;
  if (!values) return json({ error: "invalid_body", message: "Send { values: { FIELD: \"value\" } }." }, 400);

  const fields = new Map<string, FieldSpec>();
  for (const connection of descriptor.connections) {
    for (const field of connection.fields) if (EDITABLE_TYPES.has(field.type)) fields.set(field.key, field);
  }
  const unknown = Object.keys(values).filter((key) => !fields.has(key));
  if (unknown.length) {
    return json({ error: "unknown_field", message: `${descriptor.label} has no field ${unknown.join(", ")}.` }, 400);
  }

  const clean: Record<string, string | null> = {};
  for (const [key, raw] of Object.entries(values)) {
    if (raw !== null && typeof raw !== "string") {
      return json({ error: "invalid_value", message: `${fields.get(key)!.label} must be text.` }, 400);
    }
    const value = typeof raw === "string" ? raw.trim().slice(0, 4000) : "";
    const field = fields.get(key)!;
    if (value && field.type === "choice" && field.choices?.length && !field.choices.some((choice) => choice.value === value)) {
      return json({ error: "invalid_value", message: `${field.label} must be one of the listed options.` }, 400);
    }
    if (value && field.type === "url" && !/^https:\/\//i.test(value)) {
      return json({ error: "invalid_value", message: `${field.label} must be an https:// address.` }, 400);
    }
    clean[key] = value || null;
  }

  // Stripe's secret key is the one Billing settings has always saved. Kept in
  // that one place, and held to the same shape check.
  if (descriptor.id === "stripe" && "STRIPE_SECRET_KEY" in clean) {
    const key = clean.STRIPE_SECRET_KEY;
    delete clean.STRIPE_SECRET_KEY;
    if (key && !isStripeSecretShaped(key)) {
      return json(
        {
          error: "invalid_stripe_key",
          message: "That is not a Stripe secret key. It starts sk_live_, sk_test_, rk_live_ or rk_test_ — not pk_.",
        },
        400,
      );
    }
    await getDatabase().sql`
      INSERT INTO settings (account_id, key, value, updated_at)
      VALUES (${actor.accountId}, ${STRIPE_SECRET_SETTING}, ${key || ""}, NOW())
      ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
  }

  if (Object.keys(clean).length) {
    await saveIntegrationCredentials({
      accountId: actor.accountId,
      integrationId: descriptor.id as Parameters<typeof saveIntegrationCredentials>[0]["integrationId"],
      values: clean,
      secretKeys: new Set(
        [...fields.values()].filter((field) => field.type === "secret").map((field) => field.key),
      ),
      updatedBy: actor.authUserId,
    });
  }

  return json({ ok: true, ...(await detail(descriptor, actor, new URL(req.url).origin)) });
}

export default async function handler(req: Request) {
  if (req.method !== "GET" && req.method !== "PUT") return json({ error: "method_not_allowed" }, 405);

  let actor: CoachActor;
  try {
    actor = await requireCoachActor(req);
  } catch (error) {
    const status = (error as { status?: number })?.status === 403 ? 403 : 401;
    return json(
      {
        error: (error as { code?: string })?.code || "unauthorized",
        message: error instanceof Error ? error.message : "Admin login required.",
      },
      status,
    );
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const audience = url.searchParams.get("audience");

  try {
    // List mode: everything Clarity has code for, configured or not.
    //
    // ?audience splits that list in two: what a coach has plugged in, versus
    // what the software itself runs on. No audience means the whole catalogue,
    // which is what anything asking "is everything set up" wants.
    if (!id) {
      if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      const list = audience === "admin" || audience === "integration" ? integrationsFor(audience) : allIntegrations();
      const original = isOriginalWorkspace(actor.accountId);
      const oauth = await oauthState(actor.accountId);
      const integrations = await Promise.all(
        list.map(async (descriptor) =>
          withOAuth(
            card(descriptor, await valuesFor(descriptor, actor.accountId), canEdit(actor, descriptor)),
            oauth,
            original,
          ),
        ),
      );
      return json({ integrations });
    }

    const descriptor = integrationById(id);
    if (!descriptor) {
      return json({
        error: "unknown_integration",
        message: `Clarity has no integration called "${id}".`,
        available: allIntegrations().map((entry) => ({ id: entry.id, label: entry.label })),
      }, 404);
    }

    if (req.method === "PUT") return await save(req, descriptor, actor);
    return json(await detail(descriptor, actor, url.origin));
  } catch (error) {
    const status = Number((error as { status?: unknown })?.status);
    console.error("integration_setup:failed", error instanceof Error ? error.message : error);
    return json(
      {
        error: (error as { code?: string })?.code || "integration_setup_failed",
        message: error instanceof Error ? error.message : "Integration setup failed.",
      },
      Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
    );
  }
}

export const config: Config = { path: "/api/integration-setup" };
