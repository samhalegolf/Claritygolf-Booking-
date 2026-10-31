/**
 * The site tables: one page per business, and the domains that serve it.
 *
 * Every read and write takes an account id, and the public read resolves a
 * hostname to a business before it reads anything. There is no way to read a
 * page without saying whose it is.
 */

import { randomBytes } from "node:crypto";

import { db } from "../settings-store.mts";
import { cleanSiteDocument, type SiteDocument } from "./document.mts";

export const HOME_PAGE_SLUG = "home";

export type SitePageRecord = {
  id: string;
  accountId: string;
  slug: string;
  document: SiteDocument;
  publishedDocument: SiteDocument | null;
  publishedAt: string | null;
  createdAt: string;
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

type PageRow = {
  id: string;
  account_id: string;
  slug: string;
  document: unknown;
  published_document: unknown;
  published_at: string | Date | null;
  created_at: string | Date;
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

function parseDocument(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value ?? {};
}

function pageFromRow(row: PageRow): SitePageRecord {
  const published = parseDocument(row.published_document);
  return {
    id: row.id,
    accountId: row.account_id,
    slug: row.slug,
    document: cleanSiteDocument(parseDocument(row.document)),
    publishedDocument: row.published_document ? cleanSiteDocument(published) : null,
    publishedAt: iso(row.published_at),
    createdAt: iso(row.created_at) || "",
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

// --- Pages ------------------------------------------------------------------

export async function readSitePage(accountId: string, slug = HOME_PAGE_SLUG): Promise<SitePageRecord | null> {
  if (!accountId) return null;
  const rows = (await db().sql`
    SELECT id, account_id, slug, document, published_document, published_at, created_at, updated_at
    FROM site_pages
    WHERE account_id = ${accountId} AND slug = ${slug}
    LIMIT 1
  `) as PageRow[];
  return rows[0] ? pageFromRow(rows[0]) : null;
}

/** Save the draft. Creates the page the first time; the published copy is untouched. */
export async function saveSitePage(accountId: string, document: unknown, slug = HOME_PAGE_SLUG): Promise<SitePageRecord> {
  if (!accountId) throw new Error("saveSitePage: accountId is required");
  const clean = cleanSiteDocument(document);
  const rows = (await db().sql`
    INSERT INTO site_pages (id, account_id, slug, document, updated_at)
    VALUES (${`page-${token(9)}`}, ${accountId}, ${slug}, ${JSON.stringify(clean)}::jsonb, NOW())
    ON CONFLICT (account_id, slug) DO UPDATE
      SET document = EXCLUDED.document,
          updated_at = NOW()
    RETURNING id, account_id, slug, document, published_document, published_at, created_at, updated_at
  `) as PageRow[];
  return pageFromRow(rows[0]);
}

/** Make the draft the page strangers see. */
export async function publishSitePage(accountId: string, slug = HOME_PAGE_SLUG): Promise<SitePageRecord | null> {
  if (!accountId) return null;
  const rows = (await db().sql`
    UPDATE site_pages
    SET published_document = document,
        published_at = NOW(),
        updated_at = NOW()
    WHERE account_id = ${accountId} AND slug = ${slug}
    RETURNING id, account_id, slug, document, published_document, published_at, created_at, updated_at
  `) as PageRow[];
  return rows[0] ? pageFromRow(rows[0]) : null;
}

/** Take the page down. The draft stays, so publishing again is one click. */
export async function unpublishSitePage(accountId: string, slug = HOME_PAGE_SLUG): Promise<SitePageRecord | null> {
  if (!accountId) return null;
  const rows = (await db().sql`
    UPDATE site_pages
    SET published_document = NULL,
        published_at = NULL,
        updated_at = NOW()
    WHERE account_id = ${accountId} AND slug = ${slug}
    RETURNING id, account_id, slug, document, published_document, published_at, created_at, updated_at
  `) as PageRow[];
  return rows[0] ? pageFromRow(rows[0]) : null;
}

/** The published page only. The draft never leaves the account's own session. */
export async function readPublishedSitePage(accountId: string, slug = HOME_PAGE_SLUG): Promise<SiteDocument | null> {
  const page = await readSitePage(accountId, slug);
  return page?.publishedDocument ?? null;
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
