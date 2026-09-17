// The Passes tab in Billing: every pass this business has issued, whoever
// holds it. The client profile shows one person's passes; this is all of them.
//
// Presentational, like PassesPanel. The balance and state of each row come
// from the pass_balances view via /api/passes/list -- nothing here counts a
// credit. It filters and sorts what the server said, and hands a click on a
// holder's name back to App.tsx to open their profile.

import { useMemo, useState } from "react";
import { Ticket } from "lucide-react";

import { Loading } from "../shared/Loading";
import type { Pass } from "./PassesPanel";

export type IssuedPass = Pass & {
  personId: string | null;
  personName: string;
  source: string;
};

type StatusFilter = "active" | "all" | "exhausted" | "expired" | "void";

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "all", label: "All" },
  { value: "exhausted", label: "All used" },
  { value: "expired", label: "Expired" },
  { value: "void", label: "Voided" },
];

export type IssuedPassesPanelProps = {
  passes: IssuedPass[];
  loadState: "idle" | "loading" | "loaded" | "error";
  onRetry: () => void;
  /** Opens the holder's profile. Null when the pass has no owner yet. */
  onOpenPerson: (personId: string) => void;
  serviceName: (serviceId: string) => string;
};

function dateLabel(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function statusText(pass: IssuedPass) {
  if (pass.status === "void") return "Voided";
  if (pass.status === "expired") return "Expired";
  if (pass.status === "scheduled") return "Not started";
  if (pass.status === "exhausted") return "All used";
  return "Active";
}

// The same pill the invoice and POS tables use, so a pass reads like every
// other row in Billing: green while it can be spent, struck through once void.
function statusPillClass(pass: IssuedPass) {
  if (pass.status === "void") return "invoice-status-void";
  if (pass.status === "active") return "invoice-status-paid";
  if (pass.status === "expired") return "invoice-status-overdue";
  return "invoice-status-published";
}

function sourceLabel(source: string) {
  if (source === "optix") return "Optix";
  if (source === "clarity_pos" || source === "pos") return "Point of sale";
  if (source === "clarity_invoice" || source === "invoice") return "Invoice";
  if (source === "manual") return "Given";
  return source || "-";
}

export function IssuedPassesPanel({
  passes,
  loadState,
  onRetry,
  onOpenPerson,
  serviceName,
}: IssuedPassesPanelProps) {
  const [filter, setFilter] = useState<StatusFilter>("active");

  const shown = useMemo(
    () => (filter === "all" ? passes : passes.filter((pass) => pass.status === filter)),
    [filter, passes],
  );

  return (
    <div className="issued-passes">
      <div className="issued-passes-toolbar">
        <label>
          <span>Show</span>
          <select value={filter} onChange={(event) => setFilter(event.target.value as StatusFilter)}>
            {FILTERS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loadState === "loading" && !passes.length ? (
        <Loading what="passes" />
      ) : loadState === "error" ? (
        <p>
          Could not load passes.{" "}
          <button className="link-button" type="button" onClick={onRetry}>
            Retry
          </button>
        </p>
      ) : shown.length ? (
        <table className="recent-invoices-table">
          <thead>
            <tr>
              <th>Holder</th>
              <th>Pass</th>
              <th>Left</th>
              <th>Covers</th>
              <th>Expires</th>
              <th>Source</th>
              <th>Issued</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((pass) => {
              const covers = pass.coversServiceIds.map(serviceName).filter(Boolean).join(", ");
              return (
                <tr key={pass.id}>
                  <td>
                    {pass.personId ? (
                      <button className="link-button" type="button" onClick={() => onOpenPerson(pass.personId as string)}>
                        {pass.personName || "Unnamed client"}
                      </button>
                    ) : (
                      "Nobody yet"
                    )}
                  </td>
                  <td>
                    <span className="issued-pass-name">
                      <Ticket size={14} /> {pass.name}
                    </span>
                    {pass.note ? <em className="pos-adjusted-note">{pass.note}</em> : null}
                  </td>
                  <td>
                    {pass.creditsAvailable} of {pass.creditsAllocated}
                  </td>
                  <td>{covers || "-"}</td>
                  <td>{pass.expiresAt ? dateLabel(pass.expiresAt) : "Never"}</td>
                  <td>{sourceLabel(pass.source)}</td>
                  <td>{dateLabel(pass.issuedAt)}</td>
                  <td>
                    <span className={`invoice-status-pill ${statusPillClass(pass)}`}>{statusText(pass)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p>{filter === "all" ? "No passes issued yet." : `No ${FILTERS.find((entry) => entry.value === filter)?.label.toLowerCase()} passes.`}</p>
      )}
    </div>
  );
}
