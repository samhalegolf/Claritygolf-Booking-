// A message to the business, sent from a page of its site.
//
// Name, email, an optional phone number and the message go to the server,
// which emails them to the business and keeps a copy. A hidden field people
// never see is the spam check: a thing that fills it in is not a person.

import { useState } from "react";

import type { SiteFormBlock } from "../../../netlify/functions/_shared/site/document.mts";
import { t } from "../../lib/i18n";
import { sendSiteForm } from "./siteApi";

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function FormBlock({ block, business, pageSlug, preview }: { block: SiteFormBlock; business: string; pageSlug: string; preview: boolean }) {
  const [fields, setFields] = useState({ name: "", email: "", phone: "", message: "", website: "" });
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");
  const canSend = fields.name.trim().length > 0 && VALID_EMAIL.test(fields.email.trim()) && fields.message.trim().length > 0 && state !== "sending";

  async function send() {
    if (preview || !canSend) return;
    setState("sending");
    setError("");
    try {
      await sendSiteForm({ business, page: pageSlug, ...fields });
      setState("sent");
    } catch (cause) {
      setState("error");
      setError(cause instanceof Error ? cause.message : t("That did not work. Try again in a moment."));
    }
  }

  if (state === "sent") {
    return (
      <div className="site-form-thanks" role="status">
        <p>{block.thanks || t("Thanks, your message is on its way.")}</p>
      </div>
    );
  }

  return (
    <form
      className="site-form"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label>
        <span>{t("Your name *")}</span>
        <input value={fields.name} maxLength={120} autoComplete="name" onChange={(event) => setFields({ ...fields, name: event.target.value })} />
      </label>
      <label>
        <span>{t("Email *")}</span>
        <input type="email" value={fields.email} maxLength={180} autoComplete="email" onChange={(event) => setFields({ ...fields, email: event.target.value })} />
      </label>
      {block.askPhone ? (
        <label>
          <span>{t("Phone")}</span>
          <input type="tel" value={fields.phone} maxLength={40} autoComplete="tel" onChange={(event) => setFields({ ...fields, phone: event.target.value })} />
        </label>
      ) : null}
      <label>
        <span>{t("Message *")}</span>
        <textarea value={fields.message} rows={5} maxLength={4000} onChange={(event) => setFields({ ...fields, message: event.target.value })} />
      </label>
      {/* Not for people: hidden from sight and from assistive tech alike. */}
      <input className="site-form-trap" type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" value={fields.website} onChange={(event) => setFields({ ...fields, website: event.target.value })} />
      {error ? <p className="site-shop-error">{error}</p> : null}
      <button type="submit" className="site-button is-primary" disabled={!canSend || preview}>
        {state === "sending" ? t("Sending…") : block.buttonLabel || t("Send")}
      </button>
    </form>
  );
}
