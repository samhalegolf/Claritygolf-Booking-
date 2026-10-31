// The title, description and sharing picture of a business's website page,
// written into the HTML before it leaves the edge.
//
// The site is drawn by the browser, which sets these tags itself once the
// page loads; a crawler that does not run JavaScript (link previews on
// WhatsApp, Facebook and Slack, some search engines) only ever sees the
// served HTML. So for a page of a site, this reads what the public API says
// about the page and puts it in the <head> on the way out. Anything else
// (the app, the API, assets) passes straight through.
//
// Runs on Netlify's edge (Deno). It imports nothing from the functions so the
// bundle stays its own; the one rule it shares, which hosts are Clarity's, is
// repeated here and must match isClarityHost in _shared/site/document.mts.

type Context = { next: () => Promise<Response> };

const CLARITY_HOST_SUFFIXES = ["claritygolf.app", "netlify.app", "localhost"];
const MAX_SLUG_DEPTH = 3;
const SCREEN_SEGMENTS = new Set(["group-lessons", "private-lessons"]);
const FETCH_TIMEOUT_MS = 2500;

function isClarityHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return CLARITY_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)) || /^\d+\.\d+\.\d+\.\d+$/.test(host);
}

function segments(pathname: string): string[] {
  return pathname.toLowerCase().split("/").map((part) => part.trim()).filter(Boolean);
}

/** Which page of which site a request is for, or null for anything that is not a site page. */
function siteRequest(url: URL): { query: URLSearchParams; slug: string } | null {
  const parts = segments(url.pathname);
  if (!isClarityHost(url.hostname)) {
    if (parts.length > MAX_SLUG_DEPTH) return null;
    const slug = parts.join("/") || "home";
    return { query: new URLSearchParams({ host: url.hostname, page: slug }), slug };
  }
  const [business = "", second = "", ...rest] = parts;
  if (!business || SCREEN_SEGMENTS.has(business) || second !== "site" || rest.length > MAX_SLUG_DEPTH) return null;
  const slug = rest.join("/") || "home";
  return { query: new URLSearchParams({ business, page: slug }), slug };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(request: Request, context: Context): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method !== "GET" || path.startsWith("/api/") || path.startsWith("/assets/") || path.startsWith("/.netlify/")) return context.next();

  // A business's own domain answers /sitemap.xml with the site's pages.
  if (path === "/sitemap.xml" && !isClarityHost(url.hostname)) {
    return fetch(`${url.origin}/api/site/public/sitemap?host=${encodeURIComponent(url.hostname)}`, { headers: { accept: "application/xml" } });
  }
  if (/\.[a-z0-9]{1,5}$/i.test(path)) return context.next();
  if (!(request.headers.get("accept") || "").includes("text/html")) return context.next();

  const site = siteRequest(url);
  if (!site) return context.next();

  const [response, page] = await Promise.all([context.next(), fetchJson(`${url.origin}/api/site/public?${site.query.toString()}`)]);
  const meta = page?.meta as { title?: string; description?: string; image?: string; kind?: string } | undefined;
  if (!meta || !(response.headers.get("content-type") || "").includes("text/html")) return response;

  const canonical = `${url.origin}${path === "/" ? "/" : path.replace(/\/$/, "")}`;
  const tags = [
    meta.description ? `<meta name="description" content="${escapeHtml(meta.description)}">` : "",
    `<meta property="og:title" content="${escapeHtml(meta.title || "")}">`,
    meta.description ? `<meta property="og:description" content="${escapeHtml(meta.description)}">` : "",
    `<meta property="og:type" content="${meta.kind === "article" ? "article" : "website"}">`,
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    meta.image ? `<meta property="og:image" content="${escapeHtml(meta.image)}">` : "",
    `<meta name="twitter:card" content="${meta.image ? "summary_large_image" : "summary"}">`,
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
  ]
    .filter(Boolean)
    .join("\n");

  let html = await response.text();
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(meta.title || "")}</title>`);
  html = html.replace(/<meta\s+name="description"[^>]*>\s*/i, "");
  html = html.replace(/<\/head>/i, `${tags}\n</head>`);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(html, { status: response.status, headers });
}

export const config = { path: "/*" };
