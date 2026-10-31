// The client half of Settings › Website, and the public page's one read.
// Every coach call goes to /api/site with the coach's own session.

import { apiFetch } from "../auth/apiFetch";
import { t } from "../../lib/i18n";
import type { SiteDocument } from "../../../netlify/functions/_shared/site/document.mts";

export type SiteDomainView = {
  id: string;
  hostname: string;
  status: "pending" | "verified" | "active" | "failed";
  lastCheckedAt: string | null;
  lastError: string;
  attachedAt: string | null;
  records: Array<{ type: "TXT" | "CNAME" | "A"; name: string; value: string }>;
};

export type SitePageView = {
  document: SiteDocument;
  publishedAt: string | null;
  updatedAt: string;
  isPublished: boolean;
};

export type SiteState = {
  business: { slug: string; name: string; coachName: string; venueName: string; email: string };
  page: SitePageView | null;
  domains: SiteDomainView[];
  dns: { cnameTarget: string; apexIp: string };
  customDomainsConfigured: boolean;
  templates: Array<{ id: string; label: string; summary: string; preset: string }>;
};

export type PublicSite = {
  page: SiteDocument;
  business: { slug: string; name: string; logo: string; showLogo: boolean };
};

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error((data as { message?: string })?.message || t("That did not work. Try again in a moment.")), {
      status: response.status,
      code: (data as { error?: string })?.error || "",
    });
  }
  return data as T;
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export async function fetchSiteState(): Promise<SiteState> {
  return readJson(await apiFetch("/api/site"));
}

export async function saveSiteDraft(document: SiteDocument): Promise<SitePageView> {
  return (await readJson<{ page: SitePageView }>(await apiFetch("/api/site/page", jsonInit("PUT", { document })))).page;
}

export async function publishSite(): Promise<SitePageView> {
  return (await readJson<{ page: SitePageView }>(await apiFetch("/api/site/page/publish", jsonInit("POST")))).page;
}

export async function unpublishSite(): Promise<SitePageView> {
  return (await readJson<{ page: SitePageView }>(await apiFetch("/api/site/page/unpublish", jsonInit("POST")))).page;
}

export async function uploadSiteImage(type: string, dataBase64: string): Promise<string> {
  return (await readJson<{ url: string }>(await apiFetch("/api/site/media", jsonInit("POST", { type, dataBase64 })))).url;
}

export async function addSiteDomain(hostname: string): Promise<SiteDomainView> {
  return (await readJson<{ domain: SiteDomainView }>(await apiFetch("/api/site/domains", jsonInit("POST", { hostname })))).domain;
}

export async function checkSiteDomain(id: string): Promise<SiteDomainView> {
  return (await readJson<{ domain: SiteDomainView }>(await apiFetch("/api/site/domains/check", jsonInit("POST", { id })))).domain;
}

export async function removeSiteDomain(id: string): Promise<void> {
  await readJson(await apiFetch(`/api/site/domains?id=${encodeURIComponent(id)}`, { method: "DELETE" }));
}

/** The stranger's read. No session, cached at the CDN. */
export async function fetchPublicSite(query: { host?: string; business?: string }): Promise<PublicSite> {
  const params = new URLSearchParams();
  if (query.business) params.set("business", query.business);
  else if (query.host) params.set("host", query.host);
  const response = await fetch(`/api/site/public?${params.toString()}`, { credentials: "omit" });
  return readJson(response);
}
