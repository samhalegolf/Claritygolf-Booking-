// A business's site, as a stranger sees it.
//
// Reached at /<business>/site[/<page>] on Clarity's own hosts, and at the
// root of any domain the business has verified and pointed here, where /
// is the home page and /<page> any other. The page asks the server for the
// published site and draws it with the same renderer the editor previews
// with. Moving between pages fetches the next one and swaps it in without
// a reload; the address bar follows, and Back works. No session, no app
// stylesheet.

import { useCallback, useEffect, useRef, useState } from "react";

import { HOME_PAGE_SLUG, googleFontsUrl } from "../../../netlify/functions/_shared/site/document.mts";
import { t } from "../../lib/i18n";
import { customDomainPageSlug, publicSiteRoute } from "../public-booking/bookingScreen";
import { Loading } from "../shared/Loading";
import { fetchPublicSite, type PublicSite } from "./siteApi";
import { SiteRenderer } from "./SiteRenderer";
import { customDomainPagePath, publicSitePath } from "./siteTheme";
import "./site.css";

const FONT_LINK_ID = "site-fonts";

function setMeta(name: string, content: string) {
  let tag = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!tag) {
    tag = document.createElement("meta");
    tag.name = name;
    document.head.appendChild(tag);
  }
  tag.content = content;
}

export default function PublicSitePage({ business, host, slug }: { business?: string; host?: string; slug: string }) {
  const [current, setCurrent] = useState(slug);
  const [site, setSite] = useState<PublicSite | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  // The query the page was opened with: a shop order on its way back carries its id here.
  const returnQuery = useRef(new URLSearchParams(window.location.search));

  const pagePath = useCallback(
    (pageSlug: string) => (host ? customDomainPagePath(pageSlug) : publicSitePath(business || site?.business.slug || "", pageSlug)),
    [host, business, site?.business.slug],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    if (!current) {
      setError({ status: 404, message: "" });
      setLoading(false);
      return;
    }
    fetchPublicSite({ business, host, page: current })
      .then((next) => {
        if (cancelled) return;
        setSite(next);
        setError(null);
      })
      .catch((cause: Error & { status?: number }) => !cancelled && setError({ status: cause.status || 0, message: cause.message }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [business, host, current]);

  // Back and Forward: the address decides the page, the same way the first load did.
  useEffect(() => {
    const onPop = () => {
      const next = host ? customDomainPageSlug() : publicSiteRoute()?.slug || HOME_PAGE_SLUG;
      setCurrent(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [host]);

  const navigate = useCallback(
    (pageSlug: string) => {
      if (pageSlug === current) {
        window.scrollTo({ top: 0 });
        return;
      }
      window.history.pushState(null, "", pagePath(pageSlug));
      returnQuery.current = new URLSearchParams();
      setCurrent(pageSlug);
      window.scrollTo({ top: 0 });
    },
    [current, pagePath],
  );

  // The tab's title, the description search engines quote, and the fonts.
  useEffect(() => {
    if (!site) return;
    document.title = site.page.slug === HOME_PAGE_SLUG ? site.business.name : `${site.page.title} · ${site.business.name}`;
    setMeta("description", site.page.content.description);
    const fonts = googleFontsUrl(site.settings.theme);
    let link = document.getElementById(FONT_LINK_ID) as HTMLLinkElement | null;
    if (fonts) {
      if (!link) {
        link = document.createElement("link");
        link.id = FONT_LINK_ID;
        link.rel = "stylesheet";
        document.head.appendChild(link);
      }
      link.href = fonts;
    } else {
      link?.remove();
    }
    if (site.business.logo) {
      const icon = document.head.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (icon) icon.href = site.business.logo;
    }
    document.documentElement.style.background = site.settings.theme.colors.background;
  }, [site]);

  if (error && !site) {
    return (
      <div className="loading-screen">
        <div className="loading-screen-card">
          <h1>{error.status === 404 ? t("There is no page here yet") : t("This page could not be loaded")}</h1>
          <p>{error.status === 404 ? t("If this is your business, publish your page from Settings › Website in Clarity.") : error.message}</p>
        </div>
      </div>
    );
  }
  if (!site) return <Loading size="screen" label="" />;
  return (
    <SiteRenderer
      settings={site.settings}
      page={site.page}
      pages={site.pages}
      business={site.business}
      mode="public"
      pagePath={pagePath}
      onNavigate={navigate}
      returnQuery={returnQuery.current}
      missingPage={Boolean(error && error.status === 404)}
      busy={loading}
    />
  );
}
