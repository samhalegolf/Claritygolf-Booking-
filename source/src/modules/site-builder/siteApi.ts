// The client half of Settings › Website, the public page's reads, and the
// shop block's calls. Every coach call goes to /api/site with the coach's own
// session; the public and shop calls carry no session at all.

import { apiFetch } from "../auth/apiFetch";
import { t } from "../../lib/i18n";
import type { SitePage, SitePageCard, SitePageContent, SitePageMeta, SiteSettings } from "../../../netlify/functions/_shared/site/document.mts";

export type SiteDomainView = {
  id: string;
  hostname: string;
  status: "pending" | "verified" | "active" | "failed";
  lastCheckedAt: string | null;
  lastError: string;
  attachedAt: string | null;
  records: Array<{ type: "TXT" | "CNAME" | "A"; name: string; value: string }>;
};

export type SiteView = {
  settings: SiteSettings;
  isPublished: boolean;
  publishedAt: string | null;
  updatedAt: string;
};

export type SitePageView = SitePageMeta & { content: SitePageContent; isPublished: boolean; updatedAt: string };

export type SiteState = {
  business: { slug: string; name: string; coachName: string; venueName: string; email: string };
  site: SiteView | null;
  pages: SitePageView[];
  domains: SiteDomainView[];
  dns: { cnameTarget: string; apexIp: string };
  customDomainsConfigured: boolean;
  templates: Array<{ id: string; label: string; summary: string; preset: string }>;
  presets: Array<{ id: string; label: string; summary: string }>;
};

export type SavedSite = { site: SiteView; pages: SitePageView[] };

export type PublicSite = {
  settings: SiteSettings;
  page: SitePage;
  pages: SitePageCard[];
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

/** The whole draft: the settings and every page, in menu order. */
export async function saveSite(settings: SiteSettings, pages: Array<SitePageMeta & { content: SitePageContent }>): Promise<SavedSite> {
  return readJson(await apiFetch("/api/site/site", jsonInit("PUT", { settings, pages })));
}

export async function publishSite(): Promise<SavedSite> {
  return readJson(await apiFetch("/api/site/publish", jsonInit("POST")));
}

export async function unpublishSite(): Promise<SavedSite> {
  return readJson(await apiFetch("/api/site/unpublish", jsonInit("POST")));
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
export async function fetchPublicSite(query: { host?: string; business?: string; page: string }): Promise<PublicSite> {
  const params = new URLSearchParams();
  if (query.business) params.set("business", query.business);
  else if (query.host) params.set("host", query.host);
  params.set("page", query.page);
  const response = await fetch(`/api/site/public?${params.toString()}`, { credentials: "omit" });
  return readJson(response);
}

/** A message from the contact form. No session; the business is named by its slug. */
export async function sendSiteForm(input: { business: string; page: string; name: string; email: string; phone: string; message: string; website: string }): Promise<void> {
  await readJson(await fetch("/api/site/public/form", { credentials: "omit", ...jsonInit("POST", input) }));
}

// --- The shop ------------------------------------------------------------------
//
// The same four calls the shop page makes (public-shop.mts), from a page of
// the site. The business is always named: the shop takes money.

export type ShopVariant = { id: string; name: string; price: number | null };

export type ShopItem = {
  id: string;
  kind: "package" | "voucher" | "product";
  name: string;
  description: string;
  price: number;
  currency: string;
  credits: number;
  includes: string[];
  image: string;
  /** How a product reaches its buyer. "" for a package or voucher: they go by email. */
  fulfilment: "collect" | "ship" | "download" | "";
  variants: ShopVariant[];
  /** How many are left when the product counts stock; null when it does not. */
  stock: number | null;
};

export type ShopShelf = { open: boolean; items: ShopItem[]; currency: string; shipping: number };

export type ShopOrderLine = { itemId: string; variantId: string; quantity: number };

export type ShopOrder = {
  status: string;
  receiptNumber: string;
  description: string;
  amount: number;
  email: string;
  recipientName: string;
  vouchers: Array<{ code: string; value: number }>;
  downloads: Array<{ name: string; url: string }>;
  shippingAddress: string;
};

async function shopCall<T>(business: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/public-shop${path}?business=${encodeURIComponent(business)}`, {
    credentials: "omit",
    ...(body === undefined ? {} : jsonInit("POST", body)),
  });
  return readJson(response);
}

export async function fetchShop(business: string): Promise<ShopShelf> {
  return shopCall(business, "");
}

export async function startShopCheckout(
  business: string,
  order: { lines: ShopOrderLine[]; name: string; email: string; recipientName: string; message: string; returnPath: string },
): Promise<string> {
  return (await shopCall<{ url: string }>(business, "/checkout", order)).url;
}

export async function confirmShopOrder(business: string, orderId: string): Promise<ShopOrder> {
  return shopCall(business, "/order", { orderId });
}

export async function cancelShopOrder(business: string, orderId: string): Promise<void> {
  await shopCall(business, "/cancel", { orderId });
}

/** The coach's switch and shipping fee: Settings › Website edits the shop from the shop block. */
export type CoachShop = { enabled: boolean; open: boolean; blocker: string; items: ShopItem[]; shippingFee: number };

export async function fetchCoachShop(): Promise<CoachShop> {
  return readJson(await apiFetch("/api/billing/online-shop"));
}

export async function updateCoachShop(patch: { enabled?: boolean; shippingFee?: number }): Promise<CoachShop> {
  return readJson(await apiFetch("/api/billing/online-shop", jsonInit("PUT", patch)));
}
