import type { Config } from "@netlify/functions";
import { purgeCache } from "@netlify/functions";

import { requireCoachActor, resolvePublicAccount } from "./_shared/coach-auth.mts";
import { coachAccountFromSettings } from "./_shared/coach-account.mts";
import { json } from "./_shared/http.mts";
import { readSandboxAccount } from "./_shared/sandbox.mts";
import { db, readSettingsMap } from "./_shared/settings-store.mts";
import { cleanString } from "./_shared/values.mts";
import { SITE_PAGE_PRESETS, cleanPageSlug, sitePageImageUrls } from "./_shared/site/document.mts";
import {
  attachDomainToSite,
  checkDomainDns,
  cleanHostname,
  cnameTarget,
  customDomainsConfigured,
  detachDomainFromSite,
  dnsInstructions,
  NETLIFY_APEX_IPS,
} from "./_shared/site/domains.mts";
import { sweepUnusedSiteImages, uploadSiteImage } from "./_shared/site/media.mts";
import {
  accountIdForHostname,
  claimSiteDomain,
  deleteSiteDomain,
  listSiteDomains,
  listSitePages,
  publishSite,
  readPublishedSite,
  readSite,
  readSiteDomain,
  saveSite,
  unpublishSite,
  updateSiteDomainStatus,
  type SiteDomainRecord,
  type SitePageRecord,
  type SiteRecord,
} from "./_shared/site/store.mts";
import { SITE_TEMPLATES } from "./_shared/site/templates.mts";

/**
 * Settings › Website, and the public site it publishes.
 *
 * The coach's routes, all behind their own login (owners and admins only --
 * this is the business's public face):
 *
 *   GET    /api/site                   the draft site, its pages, domains, what to start from
 *   PUT    /api/site/site              save the whole draft       { settings, pages }
 *   POST   /api/site/publish           make the draft public, every page at once
 *   POST   /api/site/unpublish         take the site down (the drafts stay)
 *   POST   /api/site/media             store a picture           { type, dataBase64 }
 *   POST   /api/site/domains           claim a hostname          { hostname }
 *   POST   /api/site/domains/check     look the DNS records up, attach when right   { id }
 *   DELETE /api/site/domains?id=       release a hostname
 *
 * And the one stranger's route, cached at the CDN and purged on publish:
 *
 *   GET    /api/site/public?host=  |  ?business=   [&page=<slug>]   one published page
 *
 * The pages are drawn by the browser (src/modules/site-builder), which is
 * why this answers with documents rather than HTML.
 */

const PUBLIC_CACHE_SECONDS = 60;
const PUBLIC_STALE_SECONDS = 600;

function publicCacheTag(accountId: string) {
  return `public-site-${accountId}`;
}

/** Drop the CDN's copies of a business's pages. Best effort, like the booking page's. */
async function purgePublicSite(accountId: string) {
  if (!accountId || !process.env.NETLIFY_PURGE_API_TOKEN) return;
  try {
    await purgeCache({ tags: [publicCacheTag(accountId)] });
  } catch (error) {
    console.error("public_site_cache_purge_failed", accountId, error);
  }
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const raw = await req.text();
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function readAccountIdentity(accountId: string): Promise<{ slug: string; businessName: string }> {
  const rows = (await db().sql`
    SELECT slug, business_name FROM accounts WHERE id = ${accountId} LIMIT 1
  `) as Array<{ slug: string; business_name: string }>;
  return { slug: cleanString(rows[0]?.slug, accountId), businessName: cleanString(rows[0]?.business_name, "") };
}

function domainView(domain: SiteDomainRecord) {
  return {
    id: domain.id,
    hostname: domain.hostname,
    status: domain.status,
    lastCheckedAt: domain.lastCheckedAt,
    lastError: domain.lastError,
    attachedAt: domain.attachedAt,
    records: dnsInstructions(domain.hostname, domain.verificationToken),
  };
}

function siteView(site: SiteRecord | null) {
  return site ? { settings: site.settings, isPublished: Boolean(site.publishedSettings), publishedAt: site.publishedAt, updatedAt: site.updatedAt } : null;
}

function pageView(page: SitePageRecord) {
  return {
    id: page.id,
    slug: page.slug,
    title: page.title,
    kind: page.kind,
    inNav: page.inNav,
    sortOrder: page.sortOrder,
    content: page.content,
    isPublished: Boolean(page.publishedContent),
    updatedAt: page.updatedAt,
  };
}

async function coachState(accountId: string) {
  const [site, pages, domains, settings, identity] = await Promise.all([
    readSite(accountId),
    listSitePages(accountId),
    listSiteDomains(accountId),
    readSettingsMap(accountId),
    readAccountIdentity(accountId),
  ]);
  const account = coachAccountFromSettings(settings, accountId) as {
    businessName?: string;
    coachName?: string;
    venueName?: string;
    contactEmail?: string;
  };
  return {
    business: {
      slug: identity.slug,
      name: cleanString(account.businessName, identity.businessName),
      coachName: cleanString(account.coachName, ""),
      venueName: cleanString(account.venueName, ""),
      email: cleanString(account.contactEmail, ""),
    },
    site: siteView(site),
    pages: pages.map(pageView),
    domains: domains.map(domainView),
    dns: { cnameTarget: cnameTarget(), apexIp: NETLIFY_APEX_IPS[0] },
    customDomainsConfigured: customDomainsConfigured(),
    templates: SITE_TEMPLATES.map((template) => ({ id: template.id, label: template.label, summary: template.summary, preset: template.preset })),
    presets: SITE_PAGE_PRESETS.map((preset) => ({ id: preset.id, label: preset.label, summary: preset.summary })),
  };
}

async function handlePublic(req: Request) {
  const url = new URL(req.url);
  const business = cleanString(url.searchParams.get("business"), "", 120);
  const host = cleanString(url.searchParams.get("host") || req.headers.get("host") || "", "", 253)
    .toLowerCase()
    .replace(/:\d+$/, "");
  const slug = cleanPageSlug(url.searchParams.get("page"), "home");
  let accountId = "";
  let identity = { slug: "", businessName: "" };
  if (business) {
    const account = await resolvePublicAccount(business);
    if (account) {
      accountId = account.id;
      identity = { slug: account.slug || business, businessName: account.businessName };
    }
  } else if (host) {
    accountId = await accountIdForHostname(host);
    if (accountId) identity = await readAccountIdentity(accountId);
  }
  if (!accountId) return json({ error: "not_found", message: "There is no page at this address." }, 404);

  const site = await readPublishedSite(accountId, slug);
  if (!site) return json({ error: "not_published", message: "This site is not published yet." }, 404);
  if (!site.page) return json({ error: "no_page", message: "There is no page at this address." }, 404);

  const settings = await readSettingsMap(accountId);
  const logo = settings.brandLogoPreview || "";
  const account = coachAccountFromSettings(settings, accountId) as { businessName?: string };
  const body = {
    settings: site.settings,
    page: site.page,
    pages: site.pages,
    business: {
      slug: identity.slug,
      name: cleanString(account.businessName, identity.businessName),
      logo: logo.startsWith("data:image/") && logo.length < 400_000 ? logo : "",
      showLogo: settings.brandShowLogo !== "false",
    },
  };
  return json(body, 200, {
    "Netlify-CDN-Cache-Control": `public, durable, max-age=${PUBLIC_CACHE_SECONDS}, stale-while-revalidate=${PUBLIC_STALE_SECONDS}`,
    "Cache-Control": "public, max-age=0, must-revalidate",
    "Netlify-Cache-Tag": publicCacheTag(accountId),
  });
}

async function checkDomain(accountId: string, id: string) {
  const domain = await readSiteDomain(accountId, id);
  if (!domain) return null;
  if (domain.status === "active") return domain;
  let check: Awaited<ReturnType<typeof checkDomainDns>>;
  try {
    check = await checkDomainDns(domain.hostname, domain.verificationToken);
  } catch (error) {
    return updateSiteDomainStatus(accountId, id, {
      status: domain.status === "verified" ? "verified" : "pending",
      error: `The DNS lookup did not answer. Try again in a moment. (${error instanceof Error ? error.message : "lookup failed"})`,
    });
  }
  if (!check.verified || !check.pointed) {
    return updateSiteDomainStatus(accountId, id, { status: "pending", error: check.problem });
  }
  try {
    await attachDomainToSite(domain.hostname);
  } catch (error) {
    // Verified is worth recording even when hosting said no: the coach's
    // records are right, and the next check only has the attach left to do.
    return updateSiteDomainStatus(accountId, id, {
      status: "verified",
      error: error instanceof Error ? error.message : "Attaching the domain failed.",
    });
  }
  const active = await updateSiteDomainStatus(accountId, id, { status: "active", attached: true });
  await purgePublicSite(accountId);
  return active;
}

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const action = url.pathname.replace(/^\/api\/site\/?/, "").replace(/\/$/, "");
  try {
    if (action === "public") {
      if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      return await handlePublic(req);
    }

    const actor = await requireCoachActor(req);
    if (!actor.isAdmin) {
      return json({ error: "forbidden", message: "Only the business owner or an admin can edit the website." }, 403);
    }
    const accountId = actor.accountId;

    if (!action && req.method === "GET") return json(await coachState(accountId));

    if (action === "site" && req.method === "PUT") {
      const body = await readBody(req);
      const saved = await saveSite(accountId, { settings: body.settings, pages: body.pages });
      // Every page's draft and published copy keeps its pictures.
      const keep = saved.pages.flatMap((page) => [
        ...sitePageImageUrls(page.content),
        ...(page.publishedContent ? sitePageImageUrls(page.publishedContent) : []),
      ]);
      await sweepUnusedSiteImages(accountId, keep);
      return json({ site: siteView(saved.site), pages: saved.pages.map(pageView) });
    }

    if (action === "publish" && req.method === "POST") {
      if (!(await publishSite(accountId))) return json({ error: "not_found", message: "Save the site before publishing it." }, 404);
      await purgePublicSite(accountId);
      const [site, pages] = await Promise.all([readSite(accountId), listSitePages(accountId)]);
      return json({ site: siteView(site), pages: pages.map(pageView) });
    }

    if (action === "unpublish" && req.method === "POST") {
      if (!(await unpublishSite(accountId))) return json({ error: "not_found", message: "There is no site to take down." }, 404);
      await purgePublicSite(accountId);
      const [site, pages] = await Promise.all([readSite(accountId), listSitePages(accountId)]);
      return json({ site: siteView(site), pages: pages.map(pageView) });
    }

    if (action === "media" && req.method === "POST") {
      const body = await readBody(req);
      const uploaded = await uploadSiteImage(accountId, { type: body.type, dataBase64: body.dataBase64 });
      return json({ url: uploaded.url, bytes: uploaded.bytes }, 201);
    }

    if (action === "domains" && req.method === "POST") {
      if (await readSandboxAccount(accountId)) {
        return json({ error: "sandbox", message: "A sandbox cannot have its own domain. Switch to your live business to add one." }, 400);
      }
      const body = await readBody(req);
      const hostname = cleanHostname(body.hostname);
      const domain = await claimSiteDomain(accountId, hostname);
      return json({ domain: domainView(domain) }, 201);
    }

    if (action === "domains/check" && req.method === "POST") {
      const body = await readBody(req);
      const domain = await checkDomain(accountId, cleanString(body.id, "", 80));
      if (!domain) return json({ error: "not_found", message: "That domain is no longer listed. Refresh and try again." }, 404);
      return json({ domain: domainView(domain) });
    }

    if (action === "domains" && req.method === "DELETE") {
      const id = cleanString(url.searchParams.get("id"), "", 80);
      const domain = await readSiteDomain(accountId, id);
      if (!domain) return json({ error: "not_found", message: "That domain is no longer listed. Refresh and try again." }, 404);
      if (domain.status === "active") {
        try {
          await detachDomainFromSite(domain.hostname);
        } catch (error) {
          console.error("site_domain:detach_failed", domain.hostname, error);
        }
      }
      await deleteSiteDomain(accountId, id);
      await purgePublicSite(accountId);
      return json({ ok: true });
    }

    return json({ error: "not_found" }, 404);
  } catch (error) {
    const status = Number((error as { status?: unknown })?.status);
    const httpStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
    if (httpStatus >= 500) console.error("site:failed", action, error);
    return json(
      {
        error: (error as { code?: string })?.code || "site_error",
        message: httpStatus < 500 && error instanceof Error ? error.message : "Something went wrong. Please try again in a moment.",
      },
      httpStatus,
    );
  }
}

export const config: Config = {
  path: ["/api/site", "/api/site/*"],
};
