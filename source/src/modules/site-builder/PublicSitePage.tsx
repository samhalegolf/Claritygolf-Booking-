// A business's page, as a stranger sees it.
//
// Reached at /<business>/site on Clarity's own hosts, and at the root of any
// domain the business has verified and pointed here. Either way the page
// asks the server for the published document and draws it with the same
// renderer the editor previews with. No session, no app stylesheet.

import { useEffect, useState } from "react";

import { googleFontsUrl } from "../../../netlify/functions/_shared/site/document.mts";
import { t } from "../../lib/i18n";
import { Loading } from "../shared/Loading";
import { fetchPublicSite, type PublicSite } from "./siteApi";
import { SiteRenderer } from "./SiteRenderer";
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

export default function PublicSitePage({ business, host }: { business?: string; host?: string }) {
  const [site, setSite] = useState<PublicSite | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPublicSite({ business, host })
      .then((next) => !cancelled && setSite(next))
      .catch((cause: Error & { status?: number }) => !cancelled && setError({ status: cause.status || 0, message: cause.message }));
    return () => {
      cancelled = true;
    };
  }, [business, host]);

  // The tab's title, the description search engines quote, and the fonts.
  useEffect(() => {
    if (!site) return;
    document.title = site.page.title || site.business.name;
    setMeta("description", site.page.description);
    const fonts = googleFontsUrl(site.page.theme);
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
    document.documentElement.style.background = site.page.theme.colors.background;
  }, [site]);

  if (error) {
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
  return <SiteRenderer document={site.page} business={site.business} mode="public" />;
}
