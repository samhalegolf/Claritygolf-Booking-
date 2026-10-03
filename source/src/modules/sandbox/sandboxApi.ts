// The client half of Sandbox Mode.
//
// Four calls, and none of them decides anything: the server reads the accounts
// table for every one of them. `enterSandbox` in particular sends an account id
// the server has to recognise as this business's sandbox before it writes
// anything -- naming an id is not the same as being allowed into it.

import { apiFetch } from "../auth/apiFetch";
import { t } from "../../lib/i18n";
import type {
  AccountMarketConfig,
  CapabilityDefinition,
  CustomMarketPreset,
  MarketCapabilities,
  MarketProfileId,
  ResolvedMarket,
} from "../../../netlify/functions/_shared/market-profile.mts";
import type { BusinessTerminology } from "../../../netlify/functions/_shared/business-terminology.mts";

export type SandboxSummary = {
  id: string;
  name: string;
  planKey: string;
};

export type SandboxStatus = {
  liveAccountId: string;
  inSandbox: boolean;
  sandbox: SandboxSummary | null;
};

/** The plans a sandbox can run on, in the order the catalogue defines them. */
export const SANDBOX_PLAN_KEYS = ["solo", "studio", "academy", "enterprise", "founder"] as const;

export type SandboxPlanKey = (typeof SANDBOX_PLAN_KEYS)[number];

async function readJson(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      (data as { message?: string })?.message || t("That did not work. Try again in a moment."),
    );
  }
  return data;
}

export type SandboxPlayer = { id: string; name: string; email: string };

/** The people in this sandbox, for the "continue as" picker. */
export async function fetchSandboxPlayers(): Promise<SandboxPlayer[]> {
  const data = (await readJson(await apiFetch("/api/sandbox/players"))) as {
    players: SandboxPlayer[];
  };
  return data.players || [];
}

/**
 * Become one of the sandbox's players.
 *
 * The reload is the same reason switchWorkspace reloads: the shell that renders
 * next is a different application, chosen by the session role, and the coach
 * workspace's stores have nothing to say to it.
 */
export async function continueAsPlayer(personId: string): Promise<void> {
  await readJson(
    await apiFetch("/api/sandbox/impersonate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personId }),
    }),
  );
  window.location.assign("/");
}

/** End the handoff. The coach's own session was never touched. */
export async function returnToCoach(): Promise<void> {
  await readJson(await apiFetch("/api/sandbox/return", { method: "POST" }));
  window.location.assign("/");
}

export async function fetchSandboxStatus(): Promise<SandboxStatus> {
  return (await readJson(await apiFetch("/api/sandbox"))) as SandboxStatus;
}

export async function createSandbox(): Promise<SandboxSummary> {
  const data = (await readJson(
    await apiFetch("/api/sandbox", { method: "POST" }),
  )) as { sandbox: SandboxSummary };
  return data.sandbox;
}

export async function setSandboxPlan(planKey: SandboxPlanKey): Promise<void> {
  await readJson(
    await apiFetch("/api/sandbox/plan", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planKey }),
    }),
  );
}

/**
 * Point this session at another workspace, then reload.
 *
 * The reload is deliberate rather than lazy. Switching workspace changes the
 * account behind every store the shell has already loaded -- clients, notes,
 * calendar, settings, passes. Reconciling those in place would mean teaching
 * each one to invalidate itself, and a single missed store would show one
 * workspace's data inside the other, which is the exact failure Sandbox exists
 * to avoid.
 */
export async function switchWorkspace(accountId: string): Promise<void> {
  await readJson(
    await apiFetch("/api/workspace/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId }),
    }),
  );
  window.location.assign("/");
}

// --- Market profile builder -------------------------------------------------
//
// The account's market profile, capability overrides and words. The server
// resolves and returns the whole picture after every write, so the builder
// never has to work out what the server decided.


export type MarketProfileSummary = {
  id: MarketProfileId;
  label: string;
  product: string;
  terminology: BusinessTerminology;
  capabilities: MarketCapabilities;
};

export type MarketProfileState = {
  inSandbox: boolean;
  config: AccountMarketConfig;
  market: ResolvedMarket;
  profiles: MarketProfileSummary[];
  capabilities: CapabilityDefinition[];
  customPresets: CustomMarketPreset[];
};

const JSON_HEADERS = { "Content-Type": "application/json" };

export async function fetchMarketProfile(): Promise<MarketProfileState> {
  return (await readJson(await apiFetch("/api/market-profile"))) as MarketProfileState;
}

export async function saveMarketProfile(body: {
  config?: AccountMarketConfig;
  terminology?: BusinessTerminology;
  applyProfileId?: MarketProfileId;
  applyPresetId?: string;
}): Promise<MarketProfileState> {
  return (await readJson(
    await apiFetch("/api/market-profile", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) }),
  )) as MarketProfileState;
}

export async function saveCustomMarketPreset(preset: {
  name: string;
  baseProfileId: MarketProfileId;
  terminology: BusinessTerminology;
  capabilities: MarketCapabilities;
}): Promise<MarketProfileState> {
  return (await readJson(
    await apiFetch("/api/market-profile/presets", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ preset }),
    }),
  )) as MarketProfileState;
}

export async function deleteCustomMarketPreset(id: string): Promise<MarketProfileState> {
  return (await readJson(
    await apiFetch(`/api/market-profile/presets?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
  )) as MarketProfileState;
}
