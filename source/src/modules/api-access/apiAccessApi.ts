// The client half of Settings › API & webhooks. Every call goes to
// /api/api-access with the coach's own session; the server decides everything.

import { apiFetch } from "../auth/apiFetch";
import { t } from "../../lib/i18n";

export type ApiKeyRecord = {
  id: string;
  name: string;
  mode: "live" | "test";
  hint: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

export type WebhookEndpoint = {
  id: string;
  url: string;
  description: string;
  events: string[];
  enabled: boolean;
  disabled_reason: string | null;
  created_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
};

export type WebhookDelivery = {
  id: string;
  event_id: string;
  event_type: string;
  status: "pending" | "processing" | "succeeded" | "failed";
  attempts: number;
  next_attempt_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
  last_response: string | null;
  last_attempt_at: string | null;
  created_at: string | null;
};

export type ApiAccessState = {
  mode: "live" | "test";
  keys: ApiKeyRecord[];
  endpoints: WebhookEndpoint[];
  scopes: Array<{ id: string; label: string }>;
  eventTypes: string[];
  baseUrl: string;
  specUrl: string;
};

export type TestResult = { ok: boolean; status: number; error: string; excerpt: string; durationMs: number };

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((data as { message?: string })?.message || t("That did not work. Try again in a moment."));
  }
  return data as T;
}

export async function fetchApiAccess(): Promise<ApiAccessState> {
  return readJson(await apiFetch("/api/api-access"));
}

export async function fetchDeliveries(endpointId: string): Promise<WebhookDelivery[]> {
  const data = await readJson<{ deliveries: WebhookDelivery[] }>(
    await apiFetch(`/api/api-access?deliveries=${encodeURIComponent(endpointId)}`),
  );
  return data.deliveries;
}

export async function apiAccessAction<T = Record<string, unknown>>(action: string, input: Record<string, unknown> = {}): Promise<T> {
  return readJson(
    await apiFetch("/api/api-access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...input }),
    }),
  );
}
