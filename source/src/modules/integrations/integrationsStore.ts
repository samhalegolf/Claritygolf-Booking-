// The connection list, for both audiences, owned in one place.
//
// The Integrations panel used to fetch its list when its tab mounted, so the
// cards always arrived a beat after the tab did. Now the workspace warms this
// in an idle moment after the calendar has painted, and the panel reads a list
// that is usually already there. Same machinery as clients and lesson notes.

import { createRemoteListStore, type RemoteListStore } from "../shared/remoteListStore";

export type IntegrationAudience = "admin" | "integration";

export type IntegrationCard = {
  id: string;
  label: string;
  audience: IntegrationAudience;
  category: string;
  caveat?: string;
  sharesGrantWith?: string;
  summary: string;
  kinds: string[];
  configured: boolean;
  missing: string[];
  needsAuthorisation: boolean;
  /** OAuth only: who is signed in, and whatever last went wrong. */
  connectedAs?: string;
  connectionError?: string;
};

function isCard(row: unknown): row is IntegrationCard {
  return Boolean(row) && typeof row === "object" && typeof (row as { id?: unknown }).id === "string";
}

function storeFor(audience: IntegrationAudience) {
  return createRemoteListStore<IntegrationCard>({
    path: `/api/integration-setup?audience=${audience}`,
    rows: (data) => data.integrations as unknown[],
    clean: (rows) => rows.filter(isCard),
    failure: "The list could not load.",
  });
}

const stores: Record<IntegrationAudience, RemoteListStore<IntegrationCard>> = {
  integration: storeFor("integration"),
  admin: storeFor("admin"),
};

export function integrationsStore(audience: IntegrationAudience) {
  return stores[audience];
}

export function prefetchIntegrations(audience: IntegrationAudience) {
  stores[audience].prefetch();
}
