import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";

import { requireCoachActor } from "./_shared/coach-auth.mts";
import {
  readStoredCredentials,
  saveIntegrationCredentials,
  webhookUrlForAccount,
} from "./_shared/integration-credentials.mts";
import {
  chosenResourceProviderId,
  EXTERNAL_RESOURCE_PROVIDER_IDS,
  RESOURCE_PROVIDER_SETTING,
} from "./_shared/resource-handler.mts";
import {
  cleanResourceWebhookUrl,
  generateSigningSecret,
  RESOURCE_WEBHOOK_TIMEOUT_MS,
  sampleResourceWebhookPayload,
  sendResourceWebhook,
} from "./_shared/resource-webhook.mts";
import {
  readResourceWebhookSettings,
  RESOURCE_WEBHOOK_INTEGRATION_ID,
  RESOURCE_WEBHOOK_SECRET_FIELD,
  RESOURCE_WEBHOOK_SETTINGS_KEY,
} from "./_shared/resource-webhook-provider.mts";

/**
 * Settings › Booking › Bay & room system.
 *
 * GET   what is connected, plus the exact messages the guide documents.
 * PUT   { url, enabled, provider }                      save
 * POST  { action: "rotate-secret" }                     new signing secret, shown once
 * POST  { action: "test" }                              send resource.test and report the reply
 */

const INBOUND_PATH = "/api/resource-webhook";

function db() {
  return getDatabase();
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function writeSetting(accountId: string, key: string, value: string) {
  await db().sql`
    INSERT INTO settings (account_id, key, value, updated_at)
    VALUES (${accountId}, ${key}, ${value}, NOW())
    ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

/** True when this business has Optix set up, so the guide can offer it as the ready-made choice. */
async function optixConnected(accountId: string) {
  const rows = await db().sql`
    SELECT value FROM settings WHERE account_id = ${accountId} AND key = 'optixBookingTypeConfigJson' LIMIT 1
  `;
  try {
    const types = JSON.parse(rows[0]?.value || "{}");
    if (types && Object.values(types).some((entry: any) => entry?.enabled === true)) return true;
  } catch {
    // fall through
  }
  const optix = await readStoredCredentials(accountId, "optix");
  return Object.values(optix).some(Boolean);
}

async function state(req: Request, accountId: string) {
  const [settings, secrets, provider, optix] = await Promise.all([
    readResourceWebhookSettings(accountId),
    readStoredCredentials(accountId, RESOURCE_WEBHOOK_INTEGRATION_ID),
    chosenResourceProviderId(accountId),
    optixConnected(accountId),
  ]);
  const secret = String(secrets[RESOURCE_WEBHOOK_SECRET_FIELD] || "");
  const replies = {
    hold: { status: "held", reference: "B-123", resource: { id: "7", name: "Bay 7" } },
    unavailable: { status: "unavailable", message: "No bay free at that time" },
  };
  return {
    provider,
    // Only a business that already uses Optix is shown it. Everyone else sees
    // the generic webhook and nothing else.
    optixAvailable: optix,
    url: settings.url,
    enabled: settings.enabled,
    hasSecret: Boolean(secret),
    secretHint: secret ? `…${secret.slice(-4)}` : "",
    inboundUrl: webhookUrlForAccount(new URL(req.url).origin, INBOUND_PATH, accountId),
    timeoutSeconds: RESOURCE_WEBHOOK_TIMEOUT_MS / 1000,
    samples: {
      hold: sampleResourceWebhookPayload("resource.hold"),
      move: sampleResourceWebhookPayload("resource.move"),
      release: sampleResourceWebhookPayload("resource.release"),
    },
    replies,
  };
}

export default async function handler(req: Request) {
  let actor;
  try {
    actor = await requireCoachActor(req);
  } catch (error: any) {
    return json({ error: "unauthorized", message: "Sign in again." }, Number(error?.status) || 401);
  }
  const accountId = actor.accountId;

  if (req.method === "GET") return json(await state(req, accountId));

  if (!(actor.isOwner || actor.isAdmin)) {
    return json({ error: "forbidden", message: "Only an owner or admin can change the bay system." }, 403);
  }
  const body = await req.json().catch(() => ({}));

  if (req.method === "PUT") {
    const rawUrl = String(body?.url ?? "").trim();
    const url = cleanResourceWebhookUrl(rawUrl);
    if (rawUrl && !url) {
      return json(
        { error: "invalid_url", message: "Use a public https:// address. Local and private addresses can't be reached." },
        400,
      );
    }
    const enabled = body?.enabled === true && Boolean(url);
    await writeSetting(accountId, RESOURCE_WEBHOOK_SETTINGS_KEY, JSON.stringify({ url, enabled }));
    const provider = String(body?.provider || "");
    if ((EXTERNAL_RESOURCE_PROVIDER_IDS as readonly string[]).includes(provider)) {
      // Optix only for a business that has it; nobody else can pick it.
      if (provider === "optix" && !(await optixConnected(accountId))) {
        return json({ error: "optix_not_connected", message: "Optix is not connected for this business." }, 400);
      }
      await writeSetting(accountId, RESOURCE_PROVIDER_SETTING, provider);
    }
    // First save with a URL: mint the secret so the guide can show it.
    const secrets = await readStoredCredentials(accountId, RESOURCE_WEBHOOK_INTEGRATION_ID);
    let newSecret = "";
    if (url && !secrets[RESOURCE_WEBHOOK_SECRET_FIELD]) {
      newSecret = generateSigningSecret();
      await saveIntegrationCredentials({
        accountId,
        integrationId: RESOURCE_WEBHOOK_INTEGRATION_ID,
        values: { [RESOURCE_WEBHOOK_SECRET_FIELD]: newSecret },
        secretKeys: new Set([RESOURCE_WEBHOOK_SECRET_FIELD]),
        updatedBy: actor.authUserId,
      });
    }
    return json({ ...(await state(req, accountId)), ...(newSecret ? { secret: newSecret } : {}) });
  }

  if (req.method === "POST" && body?.action === "rotate-secret") {
    const secret = generateSigningSecret();
    await saveIntegrationCredentials({
      accountId,
      integrationId: RESOURCE_WEBHOOK_INTEGRATION_ID,
      values: { [RESOURCE_WEBHOOK_SECRET_FIELD]: secret },
      secretKeys: new Set([RESOURCE_WEBHOOK_SECRET_FIELD]),
      updatedBy: actor.authUserId,
    });
    return json({ ...(await state(req, accountId)), secret });
  }

  if (req.method === "POST" && body?.action === "test") {
    const settings = await readResourceWebhookSettings(accountId);
    const secrets = await readStoredCredentials(accountId, RESOURCE_WEBHOOK_INTEGRATION_ID);
    const secret = String(secrets[RESOURCE_WEBHOOK_SECRET_FIELD] || "");
    if (!settings.url || !secret) {
      return json({ ok: false, message: "Save your system's address first." }, 400);
    }
    const payload = { ...sampleResourceWebhookPayload("resource.test"), sentAt: new Date().toISOString() };
    const reply = await sendResourceWebhook({ url: settings.url, secret, payload });
    return json({
      ok: reply.ok,
      httpStatus: reply.httpStatus,
      durationMs: reply.durationMs,
      message: reply.ok ? `Your system answered ${reply.httpStatus} in ${reply.durationMs} ms.` : reply.message,
    });
  }

  return json({ error: "method_not_allowed" }, 405);
}

export const config: Config = { path: "/api/resource-webhook-settings" };
