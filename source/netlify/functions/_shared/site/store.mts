/**
 * The site tables: a business's site settings, its pages, and the domains
 * that serve it.
 *
 * Every read and write takes an account id, and the public read resolves a
 * hostname to a business before it reads anything. There is no way to read a
 * page without saying whose it is.
 */

import { randomBytes } from "node:crypto";

import { db } from "../settings-store.mts";
import {
  HOME_PAGE_SLUG,
  cleanSitePageContent,
  cleanSitePageMeta,
  cleanSiteSettings,
  type SitePage,
  type SitePageCard,
  type SitePageContent,
  type SitePageMeta,
  type SiteSettings,
} from "./document.mts";

export { HOME_PAGE_SLUG };

export type SiteRecord = {
  settings: SiteSettings;
  publishedSettings: SiteSettings | null;
  publishedAt: string | null;
  updatedAt: string;
};

export type SitePageRecord = SitePage & {
  publishedContent: SitePageContent | null;
  publishedAt: string | null;
  updatedAt: string;
};

export type SiteDomainStatus = "pending" | "verified" | "active" | "failed";

export type SiteDomainRecord = {
  id: string;
  accountId: string;
  hostname: string;
  verificationToken: string;
  status: SiteDomainStatus;
  lastCheckedAt: string | null;
  lastError: string;
  attachedAt: string | null;
  createdAt: string;
};

type SiteRow = {
  document: unknown;
  published_document: unknown;
  published_at: string | Date | null;
  updated_at: string | Date;
};

type PageRow = {
  id: string;
  slug: string;
  title: string;
  kind: string;
  in_nav: boolean;
  sort_order: number;
  document: unknown;
  published_document: unknown;
  published_at: string | Date | null;
  updated_at: string | Date;
};

type DomainRow = {
  id: string;
  account_id: string;
  hostname: string;
  verification_token: string;
  status: string;
  last_checked_at: string | Date | null;
  last_error: string | null;
  attached_at: string | Date | null;
  created_at: string | Date;
};

const iso = (value: string | Date | null | undefined) => (value ? new Date(value).toISOString() : null);

function parseJson(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value ?? {};
}

function siteFromRow(row: SiteRow): SiteRecord {
  return {
    settings: cleanSiteSettings(parseJson(row.document)),
    publishedSettings: row.published_document ? cleanSiteSettings(parseJson(row.published_document)) : null,
    publishedAt: iso(row.published_at),
    updatedAt: iso(row.updated_at) || "",
  };
}

function metaFromRow(row: Pick<PageRow, "id" | "slug" | "title" | "kind" | "in_nav" | "sort_order">): SitePageMeta {
  return cleanSitePageMeta({ id: row.id, slug: row.slug, title: row.title, kind: row.kind, inNav: row.in_nav, sortOrder: row.sort_order });
}

function pageFromRow(row: PageRow): SitePageRecord {
  return {
    ...metaFromRow(row),
    content: cleanSitePageContent(parseJson(row.document)),
    publishedContent: row.published_document ? cleanSitePageContent(parseJson(row.published_document)) : null,
    publishedAt: iso(row.published_at),
    updatedAt: iso(row.updated_at) || "",
  };
}

function domainFromRow(row: DomainRow): SiteDomainRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    hostname: row.hostname,
    verificationToken: row.verification_token,
    status: (["pending", "verified", "active", "failed"].includes(row.status) ? row.status : "pending") as SiteDomainStatus,
    lastCheckedAt: iso(row.last_checked_at),
    lastError: row.last_error || "",
    attachedAt: iso(row.attached_at),
    createdAt: iso(row.created_at) || "",
  };
}

const token = (bytes: number) => randomBytes(bytes).toString("base64url");

export class SiteInputError extends Error {
  status = 400;
  code = "invalid_site";
}

export class PageSlugTakenError extends Error {
  status = 409;
  code = "slug_taken";
}

// --- The site and its pages -------------------------------------------------

export async function readSite(accountId: string): Promise<SiteRecord | null> {
  if (!accountId) return null;
  const rows = (await db().sql`
    SELECT document, published_document, published_at, updated_at
    FROM sites
    WHERE account_id = ${accountId}
    LIMIT 1
  `) as SiteRow[];
  return rows[0] ? siteFromRow(rows[0]) : null;
}

export async function listSitePages(accountId: string): Promise<SitePageRecord[]> {
  if (!accountId) return [];
  const rows = (await db().sql`
    SELECT id, slug, title, kind, in_nav, sort_order, document, published_document, published_at, updated_at
    FROM site_pages
    WHERE account_id = ${accountId}
    ORDER BY sort_order ASC, created_at ASC
  `) as PageRow[];
  return rows.map(pageFromRow);
}

/**
 * Save the whole draft: the settings and every page, in one transaction.
 *
 * The list sent is the list that remains: a page the coach removed in the
 * editor is deleted here, a page without an id is new. The home page must
 * be among them, and no two pages may share an address. The published copies
 * are untouched.
 */
export async function saveSite(accountId: string, input: { settings: unknown; pages: unknown }): Promise<{ site: SiteRecord; pages: SitePageRecord[] }> {
  if (!accountId) throw new Error("saveSite: accountId is required");
  const settings = cleanSiteSettings(input.settings);
  const rawPages = Array.isArray(input.pages) ? input.pages.slice(0, 60) : [];
  const pages = rawPages.map((entry, index) => {
    const raw = (entry || {}) as Record<string, unknown>;
    return { ...cleanSitePageMeta(raw, index), sortOrder: index, content: cleanSitePageContent(raw.content) };
  });
  if (!pages.some((page) => page.slug === HOME_PAGE_SLUG)) throw new SiteInputError("The home page cannot be removed.");
  const slugs = new Set<string>();
  for (const page of pages) {
    if (slugs.has(page.slug)) throw new SiteInputError(`Two pages have the address "${page.slug}". Give one of them another address.`);
    slugs.add(page.slug);
  }

  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO sites (account_id, document, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (account_id) DO UPDATE SET document = EXCLUDED.document, updated_at = NOW()`,
      [accountId, JSON.stringify(settings)],
    );
    const existing = new Set(
      ((await client.query(`SELECT id FROM site_pages WHERE account_id = $1`, [accountId])).rows as Array<{ id: string }>).map((row) => row.id),
    );
    const kept: string[] = [];
    for (const page of pages) {
      const id = page.id && existing.has(page.id) ? page.id : `page-${token(9)}`;
      kept.push(id);
      await client.query(
        `INSERT INTO site_pages (id, account_id, slug, title, kind, in_nav, sort_order, document, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE
           SET slug = EXCLUDED.slug,
               title = EXCLUDED.title,
               kind = EXCLUDED.kind,
               in_nav = EXCLUDED.in_nav,
               sort_order = EXCLUDED.sort_order,
               document = EXCLUDED.document,
               updated_at = NOW()
         WHERE site_pages.account_id = $2`,
        [id, accountId, page.slug, page.title, page.kind, page.inNav, page.sortOrder, JSON.stringify(page.content)],
      );
    }
    await client.query(`DELETE FROM site_pages WHERE account_id = $1 AND NOT (id = ANY($2::text[]))`, [accountId, kept]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: string })?.code === "23505") {
      throw new PageSlugTakenError("Two pages have the same address. Give one of them another address.");
    }
    throw error;
  } finally {
    client.release();
  }
  const [site, saved] = await Promise.all([readSite(accountId), listSitePages(accountId)]);
  return { site: site!, pages: saved };
}

/**
 * Make the draft the site strangers see: the settings and every page at
 * once. Each page's meta rides along in its published copy, so a title or
 * address changed afterwards stays private until the next publish.
 */
export async function publishSite(accountId: string): Promise<boolean> {
  if (!accountId) return false;
  const rows = (await db().sql`
    UPDATE sites
    SET published_document = document, published_at = NOW(), updated_at = NOW()
    WHERE account_id = ${accountId}
    RETURNING account_id
  `) as Array<{ account_id: string }>;
  if (!rows.length) return false;
  await db().sql`
    UPDATE site_pages
    SET published_document = document || jsonb_build_object('slug', slug, 'title', title, 'kind', kind, 'inNav', in_nav, 'sortOrder', sort_order),
        published_at = NOW(),
        updated_at = NOW()
    WHERE account_id = ${accountId}
  `;
  return true;
}

/** Take the site down. The drafts stay, so publishing again is one click. */
export async function unpublishSite(accountId: string): Promise<boolean> {
  if (!accountId) return false;
  const rows = (await db().sql`
    UPDATE sites
    SET published_document = NULL, published_at = NULL, updated_at = NOW()
    WHERE account_id = ${accountId}
    RETURNING account_id
  `) as Array<{ account_id: string }>;
  if (!rows.length) return false;
  await db().sql`
    UPDATE site_pages
    SET published_document = NULL, published_at = NULL, updated_at = NOW()
    WHERE account_id = ${accountId}
  `;
  return true;
}

export type PublishedSite = {
  settings: SiteSettings;
  /** Every published page's card, in menu order. */
  pages: SitePageCard[];
  /** The page asked for, or null when there is none at that address. */
  page: SitePage | null;
};

/**
 * The published site, and one of its pages. The drafts never leave the
 * account's own session. A page's meta comes from its published copy (see
 * publishSite); a copy from before that carried it falls back to the columns.
 */
export async function readPublishedSite(accountId: string, slug: string): Promise<PublishedSite | null> {
  if (!accountId) return null;
  const site = await readSite(accountId);
  if (!site?.publishedSettings) return null;
  const rows = (await db().sql`
    SELECT id, slug, title, kind, in_nav, sort_order, published_document
    FROM site_pages
    WHERE account_id = ${accountId} AND published_document IS NOT NULL
    ORDER BY sort_order ASC, created_at ASC
  `) as Array<Pick<PageRow, "id" | "slug" | "title" | "kind" | "in_nav" | "sort_order" | "published_document">>;
  const pages = rows.map((row) => {
    const published = parseJson(row.published_document) as Record<string, unknown>;
    const meta = cleanSitePageMeta({
      id: row.id,
      slug: published.slug ?? row.slug,
      title: published.title ?? row.title,
      kind: published.kind ?? row.kind,
      inNav: published.inNav ?? row.in_nav,
      sortOrder: published.sortOrder ?? row.sort_order,
    });
    return { ...meta, content: cleanSitePageContent(published) };
  });
  const wanted = slug || HOME_PAGE_SLUG;
  const page = pages.find((candidate) => candidate.slug === wanted) || null;
  return {
    settings: site.publishedSettings,
    pages: pages.map(({ content, ...meta }) => ({ ...meta, summary: content.summary, cover: content.cover, date: content.date })),
    page,
  };
}

// --- Domains ----------------------------------------------------------------

export async function listSiteDomains(accountId: string): Promise<SiteDomainRecord[]> {
  if (!accountId) return [];
  const rows = (await db().sql`
    SELECT id, account_id, hostname, verification_token, status, last_checked_at, last_error, attached_at, created_at
    FROM site_domains
    WHERE account_id = ${accountId}
    ORDER BY created_at ASC
  `) as DomainRow[];
  return rows.map(domainFromRow);
}

export async function readSiteDomain(accountId: string, id: string): Promise<SiteDomainRecord | null> {
  if (!accountId || !id) return null;
  const rows = (await db().sql`
    SELECT id, account_id, hostname, verification_token, status, last_checked_at, last_error, attached_at, created_at
    FROM site_domains
    WHERE account_id = ${accountId} AND id = ${id}
    LIMIT 1
  `) as DomainRow[];
  return rows[0] ? domainFromRow(rows[0]) : null;
}

/**
 * The business a hostname belongs to, if the hostname is live. Pending and
 * verified domains answer nothing: until the alias is attached, the CDN
 * would not route the hostname here anyway, and a page must not appear on a
 * domain the business has only claimed.
 */
export async function accountIdForHostname(hostname: string): Promise<string> {
  const clean = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  if (!clean) return "";
  const rows = (await db().sql`
    SELECT account_id
    FROM site_domains
    WHERE hostname = ${clean} AND status = 'active'
    LIMIT 1
  `) as Array<{ account_id: string }>;
  return rows[0]?.account_id || "";
}

export class DomainTakenError extends Error {
  status = 409;
  code = "domain_taken";
}

/** Claim a hostname for a business. Taken by another business is a 409. */
export async function claimSiteDomain(accountId: string, hostname: string): Promise<SiteDomainRecord> {
  if (!accountId) throw new Error("claimSiteDomain: accountId is required");
  const existing = (await db().sql`
    SELECT id, account_id, hostname, verification_token, status, last_checked_at, last_error, attached_at, created_at
    FROM site_domains
    WHERE hostname = ${hostname}
    LIMIT 1
  `) as DomainRow[];
  if (existing[0]) {
    if (existing[0].account_id === accountId) return domainFromRow(existing[0]);
    throw new DomainTakenError("That domain is already in use by another business on Clarity.");
  }
  const rows = (await db().sql`
    INSERT INTO site_domains (id, account_id, hostname, verification_token, status)
    VALUES (${`domain-${token(9)}`}, ${accountId}, ${hostname}, ${token(18)}, 'pending')
    RETURNING id, account_id, hostname, verification_token, status, last_checked_at, last_error, attached_at, created_at
  `) as DomainRow[];
  return domainFromRow(rows[0]);
}

export async function updateSiteDomainStatus(
  accountId: string,
  id: string,
  next: { status: SiteDomainStatus; error?: string; attached?: boolean },
): Promise<SiteDomainRecord | null> {
  if (!accountId || !id) return null;
  const rows = (await db().sql`
    UPDATE site_domains
    SET status = ${next.status},
        last_checked_at = NOW(),
        last_error = ${next.error || ""},
        attached_at = CASE WHEN ${next.attached === true} THEN NOW() ELSE attached_at END,
        updated_at = NOW()
    WHERE account_id = ${accountId} AND id = ${id}
    RETURNING id, account_id, hostname, verification_token, status, last_checked_at, last_error, attached_at, created_at
  `) as DomainRow[];
  return rows[0] ? domainFromRow(rows[0]) : null;
}

export async function deleteSiteDomain(accountId: string, id: string): Promise<boolean> {
  if (!accountId || !id) return false;
  const rows = (await db().sql`
    DELETE FROM site_domains
    WHERE account_id = ${accountId} AND id = ${id}
    RETURNING id
  `) as Array<{ id: string }>;
  return rows.length > 0;
}
