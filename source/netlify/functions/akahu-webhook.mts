import type { Config } from "@netlify/functions";
import { createVerify } from "node:crypto";
import { defaultAccountId } from "./_shared/account.mts";
import { autoReconcileCredits, syncAkahuTransactionsByIds } from "./_shared/akahu.mts";

// Akahu webhook — keeps the bank feed live. On a TRANSACTION webhook Akahu sends
// only the changed transaction ids; we verify its RSA signature, fetch those
// transactions into bank_transactions, then auto-reconcile any that are invoice
// payments. Everything is idempotent, so Akahu's at-least-once retries are safe.
//
// Setup: register a webhook in the Akahu dashboard pointing at
// https://claritygolf.app/api/akahu-webhook (TRANSACTION events). No shared
// secret — Akahu signs each delivery with a rotating key we fetch from
// /v1/keys/{X-Akahu-Signing-Key} and verify (RSA-SHA256).

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Akahu signing public keys, cached by id (they rotate but rarely).
const keyCache = new Map<string, string>();

async function akahuPublicKey(keyId: string) {
  const cached = keyCache.get(keyId);
  if (cached) return cached;
  const res = await fetch(`https://api.akahu.io/v1/keys/${encodeURIComponent(keyId)}`);
  if (!res.ok) throw new Error(`Could not fetch Akahu signing key ${keyId}: ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  const key = typeof body?.item === "string" ? body.item : body?.item?.key || body?.key;
  if (!key || typeof key !== "string") throw new Error("Akahu signing key response missing key");
  keyCache.set(keyId, key);
  return key;
}

async function verifySignature(rawBody: string, signature: string, keyId: string) {
  if (!signature || !keyId) return false;
  try {
    const key = await akahuPublicKey(keyId);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(rawBody, "utf8");
    verifier.end();
    return verifier.verify(key, signature, "base64");
  } catch (error) {
    console.error("akahu_webhook:verify_failed", error instanceof Error ? error.message : error);
    return false;
  }
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const rawBody = await req.text();
  const signature = req.headers.get("x-akahu-signature") || "";
  const keyId = req.headers.get("x-akahu-signing-key") || "";
  if (!(await verifySignature(rawBody, signature, keyId))) {
    return json({ error: "invalid_signature" }, 400);
  }

  let event: Record<string, any>;
  try {
    event = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const accountId = defaultAccountId();
  try {
    if (event?.webhook_type === "TRANSACTION") {
      const ids = Array.isArray(event?.new_transaction_ids) ? event.new_transaction_ids : [];
      const synced = ids.length ? await syncAkahuTransactionsByIds(accountId, ids) : { ok: true, synced: 0 };
      const reconciled = await autoReconcileCredits(accountId);
      return json({ received: true, synced, autoReconciled: reconciled.autoApplied });
    }
    // TOKEN / ACCOUNT / PAYMENT events are acknowledged so Akahu stops retrying.
    return json({ received: true, ignored: event?.webhook_type || "unknown" });
  } catch (error) {
    console.error("akahu_webhook:failed", event?.webhook_type, error);
    // 500 → Akahu retries the delivery.
    return json({ error: "processing_failed", message: error instanceof Error ? error.message : "Failed." }, 500);
  }
}

export const config: Config = {
  path: "/api/akahu-webhook",
};
