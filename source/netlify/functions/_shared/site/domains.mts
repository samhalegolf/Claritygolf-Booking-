/**
 * Serving a business's page from its own domain.
 *
 * Three steps, each of which can be seen and retried from Settings › Website:
 *
 *   claim    the coach types the hostname. It is stored as pending with a
 *            random token, and the records to add are shown.
 *   verify   "Check DNS" looks the records up. The TXT record proves this
 *            business controls the domain (not merely that someone pointed a
 *            domain at Clarity); the CNAME or A record proves traffic will
 *            arrive here at all. Looked up over DNS-over-HTTPS rather than the
 *            function's resolver so the answer is the public internet's, the
 *            same one a visitor's browser will get.
 *   attach   once both pass, the hostname is added to the Netlify site's
 *            domain aliases through Netlify's API, which is what makes the
 *            CDN answer for it and provisions its certificate.
 *
 * Nothing here reads or writes the database; store.mts does that.
 */

import { trimmedEnv } from "../values.mts";
import { CLARITY_HOST_SUFFIXES } from "./document.mts";

/** Where the verification record goes: _clarity-verify.<hostname>. */
export const VERIFY_RECORD_PREFIX = "_clarity-verify";
export const VERIFY_RECORD_VALUE_PREFIX = "clarity-site=";

/** Netlify's load balancer, the A record an apex domain points at. */
export const NETLIFY_APEX_IPS = ["75.2.60.5"];

/**
 * The CNAME a subdomain points at: the site's own netlify.app name. Netlify
 * sets SITE_NAME in the function's environment; the literal is the site this
 * app has always deployed to, kept as a fallback for a local run.
 */
export function cnameTarget(): string {
  const name = trimmedEnv("SITE_NAME") || "clarity-golf-booking";
  return `${name}.netlify.app`;
}

export class DomainInputError extends Error {
  status = 400;
  code = "invalid_domain";
}

/**
 * A hostname as a coach types it, cleaned to the form it is stored in: lower
 * case, no scheme, no path, no trailing dot, punycode for any non-ASCII
 * label. Throws with a sentence the coach can act on.
 */
export function cleanHostname(input: unknown): string {
  const raw = String(input ?? "").trim().toLowerCase();
  if (!raw) throw new DomainInputError("Type the domain you want the page to live at, such as www.yourclub.com.");
  let hostname: string;
  try {
    hostname = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`).hostname.replace(/\.$/, "");
  } catch {
    throw new DomainInputError("That does not look like a domain name.");
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) {
    throw new DomainInputError("Use a domain name, not an IP address.");
  }
  if (!hostname.includes(".") || hostname.length > 253) {
    throw new DomainInputError("That does not look like a domain name.");
  }
  if (!hostname.split(".").every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new DomainInputError("A domain can only contain letters, numbers, dots and hyphens.");
  }
  if (CLARITY_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) {
    throw new DomainInputError("That is one of Clarity's own addresses. Use a domain you own.");
  }
  return hostname;
}

/** True for a bare domain (yourclub.com) rather than a subdomain (www.yourclub.com). */
export function isApexDomain(hostname: string): boolean {
  // Two labels is an apex for ordinary TLDs. Public-suffix second levels
  // (co.uk, com.au, co.nz) make three labels an apex too; those are the ones
  // Clarity's customers actually have.
  const labels = hostname.split(".");
  if (labels.length === 2) return true;
  if (labels.length === 3) {
    const second = labels[1];
    return ["co", "com", "org", "net", "ac", "gov", "edu"].includes(second) && labels[2].length === 2;
  }
  return false;
}

export type DnsRecordInstruction = { type: "TXT" | "CNAME" | "A"; name: string; value: string };

/** The records a coach is shown to add at their domain provider. */
export function dnsInstructions(hostname: string, token: string): DnsRecordInstruction[] {
  const records: DnsRecordInstruction[] = [
    { type: "TXT", name: `${VERIFY_RECORD_PREFIX}.${hostname}`, value: `${VERIFY_RECORD_VALUE_PREFIX}${token}` },
  ];
  if (isApexDomain(hostname)) {
    records.push({ type: "A", name: hostname, value: NETLIFY_APEX_IPS[0] });
  } else {
    records.push({ type: "CNAME", name: hostname, value: cnameTarget() });
  }
  return records;
}

// --- DNS lookups ------------------------------------------------------------

type DohAnswer = { name?: string; type?: number; data?: string };
type DohResponse = { Status?: number; Answer?: DohAnswer[] };

export type DnsLookup = (name: string, type: "TXT" | "CNAME" | "A") => Promise<string[]>;

const DOH_ENDPOINTS = ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"];
const RECORD_TYPES = { A: 1, CNAME: 5, TXT: 16 } as const;

/**
 * The public answer for one name and type, as plain strings: TXT records
 * without their quotes, names without their trailing dot. The first resolver
 * that answers is believed; the second is only asked when the first cannot
 * be reached. A name with no records is an empty list, not an error.
 */
export const lookupDns: DnsLookup = async (name, type) => {
  let lastError: unknown = null;
  for (const endpoint of DOH_ENDPOINTS) {
    try {
      const url = new URL(endpoint);
      url.searchParams.set("name", name);
      url.searchParams.set("type", type);
      const response = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error(`${endpoint} answered ${response.status}`);
      const body = (await response.json()) as DohResponse;
      // 0 is NOERROR, 3 is NXDOMAIN: both are answers. Anything else is the
      // resolver failing, which the next one may not.
      if (body.Status !== 0 && body.Status !== 3) throw new Error(`${endpoint} status ${body.Status}`);
      return (body.Answer || [])
        .filter((answer) => answer.type === RECORD_TYPES[type] && typeof answer.data === "string")
        .map((answer) => {
          const data = String(answer.data);
          if (type === "TXT") {
            // "part one" "part two" -> part onepart two, as the RFC says.
            return [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((part) => part[1].replace(/\\(.)/g, "$1")).join("") || data;
          }
          return data.replace(/\.$/, "").toLowerCase();
        });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`DNS lookup failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
};

export type DnsCheck = {
  verified: boolean;
  pointed: boolean;
  /** What to tell the coach when something is not yet right. */
  problem: string;
};

/**
 * Both halves of the check, each reported on its own so the coach can see
 * which record is still missing. `lookup` is injectable for the tests.
 */
export async function checkDomainDns(hostname: string, token: string, lookup: DnsLookup = lookupDns): Promise<DnsCheck> {
  const expectedTxt = `${VERIFY_RECORD_VALUE_PREFIX}${token}`;
  const txt = await lookup(`${VERIFY_RECORD_PREFIX}.${hostname}`, "TXT");
  const verified = txt.some((record) => record.trim() === expectedTxt);

  const target = cnameTarget();
  const cnames = await lookup(hostname, "CNAME");
  let pointed = cnames.some((record) => record === target || record.endsWith(".netlify.app"));
  if (!pointed) {
    // An apex record, or a provider that flattens CNAMEs into A records.
    const addresses = await lookup(hostname, "A");
    if (addresses.length) {
      const targetAddresses = await lookup(target, "A").catch(() => [] as string[]);
      pointed = addresses.some((address) => NETLIFY_APEX_IPS.includes(address) || targetAddresses.includes(address));
    }
  }

  let problem = "";
  if (!verified && !pointed) problem = "Neither record has shown up yet. DNS changes can take a few minutes to an hour to appear.";
  else if (!verified) problem = "The domain points at Clarity, but the TXT verification record has not shown up yet.";
  else if (!pointed) problem = "The TXT record is there, but the domain does not point at Clarity yet.";
  return { verified, pointed, problem };
}

// --- Netlify ----------------------------------------------------------------

export class NetlifyDomainError extends Error {
  status = 502;
  code = "netlify_domain_failed";
}

function netlifyToken() {
  return trimmedEnv("NETLIFY_API_TOKEN") || trimmedEnv("NETLIFY_PURGE_API_TOKEN");
}

function netlifySiteId() {
  return trimmedEnv("SITE_ID");
}

/** True when this installation can attach domains at all. */
export function customDomainsConfigured(): boolean {
  return Boolean(netlifyToken() && netlifySiteId());
}

type NetlifyFetch = (input: string, init?: RequestInit) => Promise<Response>;

async function netlifyRequest(path: string, init: RequestInit = {}, doFetch: NetlifyFetch = fetch) {
  const token = netlifyToken();
  const siteId = netlifySiteId();
  if (!token || !siteId) {
    throw Object.assign(new NetlifyDomainError("Custom domains are not switched on for this Clarity installation yet."), {
      status: 503,
      code: "custom_domains_unavailable",
    });
  }
  const response = await doFetch(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new NetlifyDomainError("Clarity's hosting token was refused. The platform's Netlify token needs permission to change the site.");
    }
    if (response.status === 422 && /in use|already/i.test(detail)) {
      throw Object.assign(new NetlifyDomainError("That domain is already attached to another site. Remove it there first."), { status: 409 });
    }
    throw new NetlifyDomainError(`Netlify answered ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return response;
}

type NetlifySite = { name?: string; custom_domain?: string | null; domain_aliases?: string[] };

async function readSite(doFetch: NetlifyFetch = fetch): Promise<NetlifySite> {
  const response = await netlifyRequest("", {}, doFetch);
  return (await response.json()) as NetlifySite;
}

/**
 * Add the hostname to the site's domain aliases. Already there is fine: a
 * retry after a lost response must not fail. The certificate request after
 * it is best effort: Netlify provisions one on its own once DNS is right, and
 * a refused provision now is not a refused domain.
 */
export async function attachDomainToSite(hostname: string, doFetch: NetlifyFetch = fetch): Promise<void> {
  const site = await readSite(doFetch);
  const aliases = (site.domain_aliases || []).map((alias) => alias.toLowerCase());
  if (site.custom_domain?.toLowerCase() === hostname || aliases.includes(hostname)) return;
  await netlifyRequest("", { method: "PATCH", body: JSON.stringify({ domain_aliases: [...aliases, hostname] }) }, doFetch);
  try {
    await netlifyRequest("/ssl", { method: "POST" }, doFetch);
  } catch (error) {
    console.warn("site_domain:ssl_provision_deferred", hostname, error instanceof Error ? error.message : error);
  }
}

/** Take the hostname off the site's aliases. Not there is fine. */
export async function detachDomainFromSite(hostname: string, doFetch: NetlifyFetch = fetch): Promise<void> {
  const site = await readSite(doFetch);
  const aliases = (site.domain_aliases || []).map((alias) => alias.toLowerCase());
  if (!aliases.includes(hostname)) return;
  await netlifyRequest(
    "",
    { method: "PATCH", body: JSON.stringify({ domain_aliases: aliases.filter((alias) => alias !== hostname) }) },
    doFetch,
  );
}
