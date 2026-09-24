// "Email them a receipt?" on the done screen of both checkouts.
//
// Two shapes. A customer with an address on file gets a yes/no. One without
// gets the same question with an address field, and when the till attached a
// client, whatever is typed and sent becomes that client's email -- the next
// sale, booking or invoice then has it without anyone typing it twice.

import { useState } from "react";
import { Check, Mail } from "lucide-react";
import { postPosJson } from "./posCheckoutPoll";

export type ReceiptEmailPromptProps = {
  transactionId: string;
  // What the sale already knows. Empty means ask for one.
  email: string;
  // The attached client, if any. Only a real client can have an email saved to
  // them; a loose name typed at the till has no profile to keep it on.
  clientId: string;
  clientName: string;
  onClientEmailSaved?: (clientId: string, email: string) => void;
};

export function ReceiptEmailPrompt({
  transactionId,
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
  const canSave = Boolean(clientId) && !clientId.startsWith("appointment-") && !onFile;

  async function send() {
    const to = onFile || address.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      setError("Enter a valid email address.");
      return;
    }
    setState("sending");
    setError("");
    try {
      const result = (await postPosJson(`/api/billing/pos/transactions/${encodeURIComponent(transactionId)}/receipt`, {
        email: to,
        saveToClient: canSave,
      })) as { recipient?: string; savedToClient?: boolean };
      setSentTo(result.recipient || to);
      setSaved(Boolean(result.savedToClient));
      if (result.savedToClient && canSave) onClientEmailSaved?.(clientId, result.recipient || to);
      setState("sent");
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "The receipt could not be sent.");
      setState("ask");
    }
  }

  if (state === "declined") return null;

  if (state === "sent") {
    return (
      <div className="receipt-email sent" role="status">
        <Check size={15} />
        <span>
          Receipt sent to {sentTo}.
          {saved ? ` Saved to ${clientName ? `${clientName}'s` : "their"} profile.` : ""}
        </span>
      </div>
    );
  }

  return (
    <div className="receipt-email">
      <p className="receipt-email-question">
        <Mail size={15} />
        {onFile ? <>Email a receipt to {onFile}?</> : <>Email a receipt?</>}
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
          placeholder="Customer's email"
          aria-label="Customer's email"
        />
      )}
      {!onFile && canSave && (
        <p className="field-help">Sending also saves it as {clientName || "the client"}'s email.</p>
      )}
      {error && <p className="pos-error">{error}</p>}
      <div className="receipt-email-actions">
        <button className="outline-button" disabled={state === "sending"} onClick={() => setState("declined")} type="button">
          No
        </button>
        <button
          className="primary-button"
          disabled={state === "sending" || (!onFile && !address.trim())}
          onClick={() => void send()}
          type="button"
        >
          {state === "sending" ? "Sending..." : onFile ? "Yes, send" : "Send receipt"}
        </button>
      </div>
    </div>
  );
}
