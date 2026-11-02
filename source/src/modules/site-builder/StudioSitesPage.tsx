// The website builder, opened from Clarity Studio for Clarity's own sites.
//
// Clarity Studio (the Caddy deploy) frames this page at /studio-sites. There
// is no Booking session here: the page asks the frame around it for a Studio
// pass (Caddy signs one after checking the admin's own login, see
// _shared/site/house.mts), sends it with every call, and asks for a fresh one
// when it is about to expire. Then it opens the ordinary builder,
// SiteBuilderPanel, pointed at /api/studio-sites for the chosen site. Nothing
// about the builder is Studio's own: a change to the builder is a change here.
//
// The messages, both ways through postMessage:
//
//   to Studio    { source: "clarity-studio-sites", type: "need-pass" }
//   from Studio  { source: "clarity-studio", type: "pass", pass, expiresAt }
//                { source: "clarity-studio", type: "pass-error", message }
//
// A pass is accepted only from the frame directly around this page. It is
// worth nothing until the server checks its signature, so a page that framed
// this one could only hand it a pass that fails.
//
// Its own words are English, like the rest of Clarity Studio; the builder it
// opens speaks the browser's language as it does everywhere.

import "../../appStyles";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";

import { Loading } from "../shared/Loading";
import { setSiteEditorTarget } from "./siteApi";
import { publicSitePath } from "./siteTheme";

const SiteBuilderPanel = lazy(() => import("./SiteBuilderPanel"));

const STUDIO_PASS_HEADER = "X-Clarity-Studio-Pass";
const SITE_PARAM = "site";
/** Ask for a new pass this long before the one held runs out. */
const PASS_MARGIN_MS = 60_000;
const PASS_WAIT_MS = 20_000;

type HouseSite = {
  id: string;
  slug: string;
  name: string;
  note: string;
  started: boolean;
  isPublished: boolean;
  publishedAt: string | null;
  domains: string[];
};

type Pass = { pass: string; expiresAt: number };

const framed = window.parent !== window;
let held: Pass | null = null;
let waiting: Array<{ resolve: (pass: string) => void; reject: (error: Error) => void }> = [];

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window.parent) return;
  const data = (event.data || {}) as { source?: string; type?: string; pass?: string; expiresAt?: number; message?: string };
  if (data.source !== "clarity-studio") return;
  const pending = waiting;
  waiting = [];
  if (data.type === "pass" && data.pass) {
    held = { pass: data.pass, expiresAt: Number(data.expiresAt) || Date.now() + 5 * 60_000 };
    pending.forEach((entry) => entry.resolve(data.pass!));
  } else if (data.type === "pass-error") {
    pending.forEach((entry) => entry.reject(new Error(data.message || "Clarity Studio could not sign you in.")));
  }
});

/** A pass with some life left in it, asking Studio for a new one when needed. */
function studioPass(): Promise<string> {
  if (held && held.expiresAt - PASS_MARGIN_MS > Date.now()) return Promise.resolve(held.pass);
  if (!framed) return Promise.reject(new Error("Open this from Clarity Studio, signed in as an admin."));
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject };
    waiting.push(entry);
    window.parent.postMessage({ source: "clarity-studio-sites", type: "need-pass" }, "*");
    window.setTimeout(() => {
      if (!waiting.includes(entry)) return;
      waiting = waiting.filter((other) => other !== entry);
      reject(new Error("Clarity Studio did not answer. Reload the page and try again."));
    }, PASS_WAIT_MS);
  });
}

async function studioSend(input: string, init: RequestInit = {}): Promise<Response> {
  const send = async () => {
    const headers = new Headers(init.headers);
    headers.set(STUDIO_PASS_HEADER, await studioPass());
    return fetch(input, { ...init, headers, credentials: "omit" });
  };
  const response = await send();
  if (response.status !== 401) return response;
  // The pass ran out between the check and the call: one more go with a new one.
  held = null;
  return send();
}

async function fetchHouseSites(): Promise<HouseSite[]> {
  const response = await studioSend("/api/studio-sites");
  const data = (await response.json().catch(() => ({}))) as { sites?: HouseSite[]; message?: string };
  if (!response.ok) throw new Error(data.message || "That did not work. Try again in a moment.");
  return data.sites || [];
}

function chosenSiteId(): string {
  return new URLSearchParams(window.location.search).get(SITE_PARAM) || "";
}

export default function StudioSitesPage() {
  const [sites, setSites] = useState<HouseSite[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [toast, setToast] = useState("");
  const wanted = chosenSiteId();

  useEffect(() => {
    document.title = "Websites · Clarity Studio";
    let cancelled = false;
    fetchHouseSites()
      .then((next) => !cancelled && setSites(next))
      .catch((cause: Error) => !cancelled && setError(cause.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const site = useMemo(() => (sites ? sites.find((candidate) => candidate.id === wanted) || sites[0] || null : null), [sites, wanted]);

  // Pointed before the builder mounts, and only ever at the site in the address.
  if (site) setSiteEditorTarget({ base: "/api/studio-sites", query: `${SITE_PARAM}=${encodeURIComponent(site.id)}`, send: studioSend });

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const onToast = useCallback((message: string) => setToast(message), []);

  if (error) {
    return (
      <div className="loading-screen">
        <div className="loading-screen-card">
          <h1>Websites could not be opened</h1>
          <p>{error}</p>
        </div>
      </div>
    );
  }
  if (!sites) return <Loading size="screen" what="Clarity's websites" />;
  if (!site) {
    return (
      <div className="loading-screen">
        <div className="loading-screen-card">
          <h1>No websites yet</h1>
          <p>Clarity&apos;s own sites are made by a database migration. Deploy Clarity Booking and reload.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="studio-sites">
      {editing ? null : (
        <nav className="studio-sites-picker" aria-label="Clarity's websites">
          {sites.map((candidate) => (
            // A full load rather than a swap: the builder warns before an unsaved draft is left behind.
            <a key={candidate.id} href={`?${SITE_PARAM}=${encodeURIComponent(candidate.id)}`} aria-current={candidate.id === site.id ? "page" : undefined}>
              <strong>{candidate.name}</strong>
              <small>
                {candidate.isPublished ? "Published" : candidate.started ? "Draft, not published" : "Not started"}
                {candidate.domains.length ? ` · ${candidate.domains.join(", ")}` : ""}
              </small>
            </a>
          ))}
        </nav>
      )}
      {editing ? null : (
        <p className="settings-note studio-sites-note">
          {site.note}{" "}
          {site.isPublished ? (
            <a href={publicSitePath(site.slug)} target="_blank" rel="noreferrer">
              Open the published site
            </a>
          ) : null}
        </p>
      )}
      <Suspense fallback={<Loading what="the website" />}>
        <SiteBuilderPanel key={site.id} onToast={onToast} brandLogo="" brandShowLogo={false} editing={editing} onEditingChange={setEditing} />
      </Suspense>
      {toast ? (
        <div className="toast" role="status" aria-live="polite">
          <span>{toast}</span>
        </div>
      ) : null}
    </div>
  );
}
