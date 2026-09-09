// The Clients screen: search, the two lists, merge mode and the import card.
//
// This is the markup that used to sit inline in App.tsx, given its own chunk
// so the first paint of the workspace does not carry it, and its own loading
// state so an empty list on the way in reads as "loading" rather than "none".
// The search box and the list tab are its own; merge mode and the import card
// stay the workspace's, because the merge review dialog and the Settings
// import card share them.

import type { ChangeEvent } from "react";
import { useMemo, useState } from "react";
import { ArrowRight, Check, GitMerge, Plus, Search, Upload } from "lucide-react";

import type { PeopleImportDiagnostic, Person } from "./clientsModel";

/** What a row needs. The workspace's ClientSummary carries more; that is fine. */
export type ClientRow = Person & { count: number };

export type ClientsPanelProps<T extends ClientRow> = {
  clients: T[];
  /** True until the list has answered once. Shown only while there is nothing to draw. */
  loading: boolean;
  matchesSearch: (client: T, term: string) => boolean;
  mergeMode: boolean;
  mergeSelection: string[];
  onToggleMergeMode: () => void;
  onToggleMergeSelection: (client: T) => void;
  onReviewMerge: () => void;
  onOpenClient: (client: T) => void;
  onAddClient: () => void;
  importOpen: boolean;
  onToggleImport: () => void;
  importText: string;
  onImportTextChange: (text: string) => void;
  importState: "idle" | "importing" | "imported";
  importPreview: number;
  importDiagnostic: PeopleImportDiagnostic | null;
  onImport: () => void;
  onImportFile: (event: ChangeEvent<HTMLInputElement>) => void;
};

export function ClientsPanel<T extends ClientRow>({
  clients,
  loading,
  matchesSearch,
  mergeMode,
  mergeSelection,
  onToggleMergeMode,
  onToggleMergeSelection,
  onReviewMerge,
  onOpenClient,
  onAddClient,
  importOpen,
  onToggleImport,
  importText,
  onImportTextChange,
  importState,
  importPreview,
  importDiagnostic,
  onImport,
  onImportFile,
}: ClientsPanelProps<T>) {
  const [search, setSearch] = useState("");
  const [listTab, setListTab] = useState<"main" | "external">("main");

  const term = search.trim();
  const filtered = useMemo(() => (term ? clients.filter((client) => matchesSearch(client, term)) : clients), [clients, matchesSearch, term]);
  // External booking clients (created by an inbound Optix booking) live in
  // their own list until merged or moved into the main client list.
  const mainList = useMemo(() => filtered.filter((client) => client.external !== true), [filtered]);
  const externalList = useMemo(() => filtered.filter((client) => client.external === true), [filtered]);
  const list = listTab === "external" ? externalList : mainList;

  return (
    <section className="module-page clients-page">
      <div className="client-toolbar">
        <div className="client-search">
          <Search size={18} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search clients" />
        </div>
        <button
          className={`outline-button import-client-button${importOpen ? " active" : ""}`}
          onClick={onToggleImport}
          aria-label={importOpen ? "Hide import clients" : "Import clients"}
          type="button"
        >
          <Upload size={16} />
          Import
        </button>
        <button
          className={`icon-button merge-clients-button${mergeMode ? " active" : ""}`}
          onClick={onToggleMergeMode}
          aria-label={mergeMode ? "Cancel merging clients" : "Merge duplicate clients"}
          title={mergeMode ? "Cancel merging clients" : "Merge duplicate clients"}
          type="button"
        >
          <GitMerge size={18} />
        </button>
        <button className="icon-button add-client-button" onClick={onAddClient} aria-label="Add client" title="Add client" type="button">
          <Plus size={18} />
        </button>
      </div>

      {mergeMode && (
        <div className="client-merge-bar">
          <span>
            {mergeSelection.length === 2
              ? "2 clients selected."
              : mergeSelection.length === 1
                ? "Select 1 more client to merge."
                : "Select 2 clients to merge."}
          </span>
          <button className="primary-button" disabled={mergeSelection.length !== 2} onClick={onReviewMerge} type="button">
            Review merge
          </button>
        </div>
      )}

      {importOpen && (
        <article className="data-card import-card">
          <div className="data-card-header">
            <div>
              <span>Import</span>
              <h2>Import clients</h2>
            </div>
            <Upload size={24} />
          </div>
          <textarea
            value={importText}
            onChange={(event) => onImportTextChange(event.target.value)}
            placeholder="name,email,phone,notes,caddyProfileUrl"
          />
          <div className="import-actions">
            <div className="import-action-tools">
              <label className="outline-button import-file-button">
                <Upload size={16} />
                CSV file
                <input accept=".csv,text/csv,text/plain" onChange={onImportFile} type="file" />
              </label>
              <span>{importPreview} ready</span>
            </div>
            <button
              className="primary-button"
              onClick={onImport}
              disabled={importState === "importing" || importPreview === 0}
              type="button"
            >
              {importState === "importing" ? "Importing" : importState === "imported" ? "Imported" : "Import"}
            </button>
          </div>
          {importDiagnostic && (
            <div className={`import-diagnostics${importDiagnostic.ok ? "" : " error"}`} role={importDiagnostic.ok ? "status" : "alert"}>
              <strong>{importDiagnostic.message}</strong>
              <span>Endpoint: {importDiagnostic.endpoint}</span>
              <span>HTTP: {importDiagnostic.status}</span>
              <span>
                Imported {importDiagnostic.imported} · Updated {importDiagnostic.updated} · Skipped {importDiagnostic.skipped}
                {importDiagnostic.failed ? ` · Failed ${importDiagnostic.failed}` : ""}
              </span>
              {importDiagnostic.errors.map((message) => (
                <em key={message}>{message}</em>
              ))}
            </div>
          )}
        </article>
      )}

      <div className="client-list-tabs" role="tablist" aria-label="Client lists">
        <button
          className={`outline-button${listTab === "main" ? " active" : ""}`}
          onClick={() => setListTab("main")}
          role="tab"
          aria-selected={listTab === "main"}
          type="button"
        >
          Clients ({mainList.length})
        </button>
        <button
          className={`outline-button${listTab === "external" ? " active" : ""}`}
          onClick={() => setListTab("external")}
          role="tab"
          aria-selected={listTab === "external"}
          type="button"
        >
          External bookings ({externalList.length})
        </button>
      </div>

      <div className="client-table">
        {list.length ? (
          list.map((client) => {
            const mergeEligible = !client.id.startsWith("appointment-");
            const mergeSelected = mergeSelection.includes(client.id);
            return (
              <button
                className={`client-row${mergeMode ? " merge-mode" : ""}${mergeSelected ? " merge-selected" : ""}`}
                key={client.id}
                onClick={() => (mergeMode ? onToggleMergeSelection(client) : onOpenClient(client))}
                disabled={mergeMode && !mergeEligible}
                title={mergeMode && !mergeEligible ? "Save this client before merging — it isn't linked to a client record yet." : undefined}
                type="button"
              >
                {mergeMode && (
                  <span className={`merge-row-check${mergeSelected ? " checked" : ""}`} aria-hidden="true">
                    {mergeSelected ? <Check size={14} /> : null}
                  </span>
                )}
                <div className="client-main">
                  <strong>{client.name}</strong>
                  <span>{client.email || "No email yet"}</span>
                </div>
                <span className="client-phone">{client.phone || "No phone"}</span>
                <span className="client-booking-count">
                  {client.count} booking{client.count === 1 ? "" : "s"}
                  {(client.caddyProfileId || client.caddyProfileUrl) && <em>Linked to Caddy</em>}
                </span>
                <span className="client-row-arrow">{mergeMode ? null : <ArrowRight size={17} />}</span>
              </button>
            );
          })
        ) : loading && !term && listTab === "main" ? (
          <div className="empty-panel compact" role="status">
            <h2>Loading clients…</h2>
            <p>Your client list is on its way.</p>
          </div>
        ) : listTab === "external" ? (
          <div className="empty-panel compact">
            <h2>No external booking clients</h2>
            <p>People created by an inbound Optix booking appear here until you merge or move them into your clients.</p>
          </div>
        ) : term ? (
          <div className="empty-panel compact">
            <h2>No clients found</h2>
            <p>Try a different name, email, or phone number.</p>
          </div>
        ) : (
          <div className="empty-panel compact">
            <h2>No clients yet</h2>
            <p>Add one with +, import a list, or take a booking.</p>
          </div>
        )}
      </div>
    </section>
  );
}
