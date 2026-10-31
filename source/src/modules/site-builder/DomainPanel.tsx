// Where the page lives: Clarity's own address for it, and the business's
// own domain once its DNS records are in place.
import { Check, Copy, ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

import { t } from "../../lib/i18n";
import { addSiteDomain, checkSiteDomain, removeSiteDomain, type SiteDomainView, type SiteState } from "./siteApi";
import { publicSitePath } from "./siteTheme";

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={t("Copy")}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </button>
  );
}

function statusLabel(domain: SiteDomainView) {
  switch (domain.status) {
    case "active":
      return t("Live");
    case "verified":
      return t("Verified, attaching");
    case "failed":
      return t("Needs attention");
    default:
      return t("Waiting for DNS");
  }
}

export function DomainPanel({
  state,
  isPublished,
  onDomainsChange,
}: {
  state: SiteState;
  isPublished: boolean;
  onDomainsChange: (domains: SiteDomainView[]) => void;
}) {
  const [hostname, setHostname] = useState("");
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const clarityUrl = `${window.location.origin}${publicSitePath(state.business.slug)}`;

  async function run(id: string, work: () => Promise<void>) {
    setBusyId(id);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("That did not work."));
    } finally {
      setBusyId("");
    }
  }

  return (
    <div className="site-domains">
      <div className="site-address-row">
        <div>
          <span>{t("Your page on Clarity")}</span>
          <code>{clarityUrl}</code>
        </div>
        <div className="site-inline-actions">
          <CopyButton value={clarityUrl} />
          {isPublished ? (
            <a className="icon-button" href={clarityUrl} target="_blank" rel="noreferrer" aria-label={t("Open")}>
              <ExternalLink size={15} />
            </a>
          ) : null}
        </div>
      </div>
      {!isPublished ? <p className="field-help">{t("Publish the page and this address starts working.")}</p> : null}

      <h4 className="site-inspector-subtitle">{t("Your own domain")}</h4>
      {!state.customDomainsConfigured ? (
        <p className="settings-note">{t("Custom domains are not switched on for this Clarity installation yet. You can still add one and check its records; it goes live once hosting is connected.")}</p>
      ) : null}
      <p className="field-help">{t("Use a subdomain such as www.yourclub.com or golf.yourclub.com. You add two records where your domain is managed, then check here. Clarity takes care of the certificate.")}</p>

      {state.domains.map((domain) => (
        <div className={`site-domain is-${domain.status}`} key={domain.id}>
          <div className="site-domain-head">
            <div>
              <strong>{domain.hostname}</strong>
              <span className={`site-domain-status is-${domain.status}`}>{statusLabel(domain)}</span>
            </div>
            <div className="site-inline-actions">
              {domain.status === "active" ? (
                <a className="icon-button" href={`https://${domain.hostname}`} target="_blank" rel="noreferrer" aria-label={t("Open")}>
                  <ExternalLink size={15} />
                </a>
              ) : (
                <button
                  type="button"
                  className="outline-button"
                  disabled={busyId === domain.id}
                  onClick={() =>
                    void run(domain.id, async () => {
                      const next = await checkSiteDomain(domain.id);
                      onDomainsChange(state.domains.map((candidate) => (candidate.id === next.id ? next : candidate)));
                    })
                  }
                >
                  <RefreshCw size={15} />
                  {busyId === domain.id ? t("Checking…") : t("Check DNS")}
                </button>
              )}
              <button
                type="button"
                className="icon-button"
                aria-label={t("Remove")}
                disabled={busyId === domain.id}
                onClick={() => {
                  if (!window.confirm(t("Remove {hostname}? The page stops answering there.", { hostname: domain.hostname }))) return;
                  void run(domain.id, async () => {
                    await removeSiteDomain(domain.id);
                    onDomainsChange(state.domains.filter((candidate) => candidate.id !== domain.id));
                  });
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
          {domain.status !== "active" ? (
            <table className="site-dns-table">
              <thead>
                <tr>
                  <th>{t("Type")}</th>
                  <th>{t("Name")}</th>
                  <th>{t("Value")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {domain.records.map((record) => (
                  <tr key={`${record.type}-${record.name}`}>
                    <td>{record.type}</td>
                    <td>
                      <code>{record.name}</code>
                      <CopyButton value={record.name} />
                    </td>
                    <td>
                      <code>{record.value}</code>
                      <CopyButton value={record.value} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {domain.lastError && domain.status !== "active" ? <p className="site-domain-note">{domain.lastError}</p> : null}
        </div>
      ))}

      {!state.domains.length ? (
        <form
          className="site-domain-add"
          onSubmit={(event) => {
            event.preventDefault();
            const value = hostname.trim();
            if (!value) return;
            void run("add", async () => {
              const domain = await addSiteDomain(value);
              onDomainsChange([...state.domains, domain]);
              setHostname("");
            });
          }}
        >
          <label className="settings-field site-field">
            <span>{t("Domain")}</span>
            <input value={hostname} placeholder="www.yourclub.com" maxLength={253} onChange={(event) => setHostname(event.target.value)} />
          </label>
          <button className="primary-button" type="submit" disabled={busyId === "add" || !hostname.trim()}>
            {busyId === "add" ? t("Adding…") : t("Add domain")}
          </button>
        </form>
      ) : null}
      {error ? (
        <p className="workspace-save-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
