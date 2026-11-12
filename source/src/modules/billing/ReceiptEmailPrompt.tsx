// "Email them a receipt?" on the done screen of both checkouts. For an On
// account sale it is "Email them the invoice?" instead: the sale is a draft
// invoice, and sending it is what moves it to sent.
//
// Two shapes. A customer with an address on file gets a yes/no. One without
// gets the same question with an address field, and when the till attached a
// client, whatever is typed and sent becomes that client's email -- the next
// sale, booking or invoice then has it without anyone typing it twice.

import { useState } from "react";
import { Check } from "lucide-react";
import { ClarityEmail } from "../shared/ClarityIcons";
import { postPosJson } from "./posCheckoutPoll";
import { sendTillInvoice } from "./tillInvoice";
import { t } from "../../lib/i18n";

export type ReceiptEmailTarget =
  | { kind: "receipt"; transactionId: string }
  | { kind: "invoice"; invoiceId: string; invoiceNumber: string; includePaymentLink: boolean };

export type ReceiptEmailPromptProps = {
  target: ReceiptEmailTarget;
  // What the sale already knows. Empty means ask for one.
  email: string;
  // The attached client, if any. Only a real client can have an email saved to
  // them; a loose name typed at the till has no profile to keep it on.
  clientId: string;
  clientName: string;
  onClientEmailSaved?: (clientId: string, email: string) => void;
};

export function ReceiptEmailPrompt({
  target,
  email,
  clientId,
  clientName,
  onClientEmailSaved,
}: ReceiptEmailPromptProps) {
  const [address, setAddress] = useState("");
  const [state, setState] = useState<"ask" | "sending" | "sent" | "declined">("ask");
  const [error, setError] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [saved, setSaved] = useState(false);

  const onFile = email.trim();
  const isInvoice = target.kind === "invoice";
  // Only the receipt endpoint saves a typed address to the client.
  const canSave = !isInvoice && Boolean(clientId) && !clientId.startsWith("appointment-") && !onFile;

  async function send() {
    const to = onFile || address.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      setError(t("Enter a valid email address."));
      return;
    }
    setState("sending");
    setError("");
    try {
      if (target.kind === "invoice") {
        const result = await sendTillInvoice(target.invoiceId, to, target.includePaymentLink);
        setSentTo(result.recipient || to);
        setState("sent");
        return;
      }
      const result = (await postPosJson(`/api/billing/pos/transactions/${encodeURIComponent(target.transactionId)}/receipt`, {
        email: to,
        saveToClient: canSave,
      })) as { recipient?: string; savedToClient?: boolean };
      setSentTo(result.recipient || to);
      setSaved(Boolean(result.savedToClient));
      if (result.savedToClient && canSave) onClientEmailSaved?.(clientId, result.recipient || to);
      setState("sent");
    } catch (sendError) {
      setError(
        sendError instanceof Error
          ? sendError.message
          : isInvoice
            ? t("The invoice could not be sent.")
            : t("The receipt could not be sent."),
      );
      setState("ask");
    }
  }

  if (state === "declined") return null;

  if (state === "sent") {
    return (
      <div className="receipt-email sent" role="status">
        <Check size={15} />
        <span>{target.kind === "invoice"
          ? t("Invoice {number} sent to {sentTo}.", { number: target.invoiceNumber, sentTo })
          : t("Receipt sent to {sentTo}.", { sentTo })}{saved ? (clientName ? t(" Saved to {clientName}'s profile.", { clientName }) : t(" Saved to their profile.")) : ""}
        </span>
      </div>
    );
  }

  return (
    <div className="receipt-email">
      <p className="receipt-email-question">
        <ClarityEmail size={15} />
        {target.kind === "invoice"
          ? onFile
            ? t("Email invoice {number} to {onFile}?", { number: target.invoiceNumber, onFile })
            : t("Email invoice {number}?", { number: target.invoiceNumber })
          : onFile
            ? t("Email a receipt to {onFile}?", { onFile })
            : t("Email a receipt?")}
      </p>
      {!onFile && (
        <input
          type="email"
          inputMode="email"
          autoComplete="off"
          value={address}
          onChange={(event) => {
            setAddress(event.target.value);
            setError("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void send();
          }}
          placeholder={t("Customer's email")}
          aria-label={t("Customer's email")}
        />
      )}
      {!onFile && canSave && (
        <p className="field-help">{t("Sending also saves it as")}{" "}{clientName || "the client"}{t("'s email.")}</p>
      )}
      {error && <p className="pos-error">{error}</p>}
      <div className="receipt-email-actions">
        <button className="outline-button" disabled={state === "sending"} onClick={() => setState("declined")} type="button">{t("No")}</button>
        <button
          className="primary-button"
          disabled={state === "sending" || (!onFile && !address.trim())}
          onClick={() => void send()}
          type="button"
        >
          {state === "sending" ? t("Sending...") : onFile ? t("Yes, send") : isInvoice ? t("Send invoice") : t("Send receipt")}
        </button>
      </div>
    </div>
  );
}
