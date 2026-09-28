// Settings › API & webhooks.
//
// Two ways other software connects to a business in Clarity, and both are
// managed here:
//
//   API keys   the other system asks Clarity (read bookings, book a lesson).
//   Webhooks   Clarity tells the other system the moment something changes.
//
// A key or a signing secret is shown once, when it is made, the way Stripe and
// GitHub do it: only a hash of a key is stored, so there is nothing to show
// later. Losing one means making another.

import { useEffect, useState } from "react";

import { Loading } from "../shared/Loading";
import {
  apiAccessAction,
  fetchApiAccess,
  fetchDeliveries,
  type ApiAccessState,
  type ApiKeyRecord,
  type TestResult,
  type WebhookDelivery,
  type WebhookEndpoint,
} from "./apiAccessApi";
import "./api-access.css";

const READ_ONLY = ["bookings:read", "clients:read", "catalog:read", "passes:read", "invoices:read", "events:read"];

function when(value: string | null) {
  if (!value) return "never";
  return new Date(value).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="api-access-copy">
      <code>{value}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        aria-label={`Copy ${label}`}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** Shown once. Dismissing it is the owner saying they have it somewhere safe. */
function RevealOnce({ title, value, note, onDone }: { title: string; value: string; note: string; onDone: () => void }) {
  return (
    <div className="api-access-reveal" role="status">
      <strong>{title}</strong>
      <CopyValue value={value} label={title} />
      <span>{note}</span>
      <button type="button" className="api-access-secondary" onClick={onDone}>
        I have copied it
      </button>
    </div>
  );
}

export default function ApiAccessPanel() {
  const [state, setState] = useState<ApiAccessState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<{ title: string; value: string; note: string } | null>(null);

  const reload = async () => setState(await fetchApiAccess());

  useEffect(() => {
    let cancelled = false;
    fetchApiAccess()
      .then((next) => !cancelled && setState(next))
      .catch((cause: Error) => !cancelled && setError(cause.message));
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="data-card settings-section settings-api integration-panel api-access">
      <header className="integration-header">
        <div>
          <span>Developers</span>
          <h2>API &amp; webhooks</h2>
          <p>Let other software read and change your bookings and clients, and hear about every change as it happens.</p>
        </div>
        {state ? <strong className={state.mode === "test" ? "api-access-mode is-test" : "api-access-mode"}>{state.mode === "test" ? "Sandbox · test keys" : "Live"}</strong> : null}
      </header>

      <div className="integration-body">
        {error ? <div className="integration-error"><strong>Something went wrong</strong>{error}</div> : null}
        {!state && !error ? <Loading what="API access" /> : null}
        {revealed ? <RevealOnce {...revealed} onDone={() => setRevealed(null)} /> : null}
        {state ? (
          <>
            <section className="api-access-section">
              <h3>Connecting</h3>
              <p className="api-access-lede">
                Anything that can call a web API can connect: your own website, Zapier, Make, n8n, Power Automate,
                or a developer's code. Most tools can import the specification below and set themselves up.
              </p>
              <div className="api-access-facts">
                <label>Base URL<CopyValue value={state.baseUrl} label="base URL" /></label>
                <label>OpenAPI specification<CopyValue value={state.specUrl} label="specification URL" /></label>
              </div>
            </section>

            <KeysSection state={state} busy={busy} run={run} reload={reload} reveal={setRevealed} />
            <WebhooksSection state={state} busy={busy} run={run} reload={reload} reveal={setRevealed} />
          </>
        ) : null}
      </div>
    </article>
  );
}

type SectionProps = {
  state: ApiAccessState;
  busy: boolean;
  run: (work: () => Promise<void>) => Promise<void>;
  reload: () => Promise<void>;
  reveal: (value: { title: string; value: string; note: string }) => void;
};

function KeysSection({ state, busy, run, reload, reveal }: SectionProps) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(() => state.scopes.map((scope) => scope.id));
  const [expiresInDays, setExpiresInDays] = useState("0");
  const active = state.keys.filter((key) => !key.revokedAt);
  const revoked = state.keys.filter((key) => key.revokedAt);

  const toggle = (id: string) =>
    setScopes((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));

  return (
    <section className="api-access-section">
      <div className="api-access-heading">
        <h3>API keys</h3>
        <button type="button" className="api-access-primary" disabled={busy} onClick={() => setAdding((value) => !value)}>
          {adding ? "Cancel" : "New key"}
        </button>
      </div>
      <p className="api-access-lede">
        One key per system that connects, so you can switch one off without breaking the others. A key only ever reaches this business.
      </p>

      {adding ? (
        <form
          className="api-access-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const created = await apiAccessAction<{ key: string }>("create_key", {
                name,
                scopes,
                expiresInDays: Number(expiresInDays),
              });
              reveal({
                title: `Your new key: ${name}`,
                value: created.key,
                note: "This is the only time it is shown. Paste it into the other system now; if it is lost, revoke it and make another.",
              });
              setAdding(false);
              setName("");
              await reload();
            });
          }}
        >
          <label className="settings-field">
            <span>Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Zapier, club website" maxLength={80} required />
          </label>
          <fieldset className="api-access-scopes">
            <legend>
              What it may do
              <button type="button" className="text-button" onClick={() => setScopes(state.scopes.map((scope) => scope.id))}>Everything</button>
              <button type="button" className="text-button" onClick={() => setScopes(READ_ONLY)}>Read only</button>
            </legend>
            {state.scopes.map((scope) => (
              <label key={scope.id}>
                <input type="checkbox" checked={scopes.includes(scope.id)} onChange={() => toggle(scope.id)} />
                <span>{scope.label}</span>
                <code>{scope.id}</code>
              </label>
            ))}
          </fieldset>
          <label className="settings-field">
            <span>Expires</span>
            <select value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)}>
              <option value="0">Never</option>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In a year</option>
            </select>
          </label>
          <div className="api-access-row">
            <button type="submit" className="api-access-primary" disabled={busy || !name.trim() || !scopes.length}>
              {busy ? "Creating…" : "Create key"}
            </button>
          </div>
        </form>
      ) : null}

      {active.length ? (
        <ul className="api-access-list">
          {active.map((key) => (
            <KeyRow key={key.id} record={key} busy={busy} onRevoke={() => void run(async () => {
              if (!window.confirm(`Revoke "${key.name}"? Anything using it stops working straight away.`)) return;
              await apiAccessAction("revoke_key", { id: key.id });
              await reload();
            })} />
          ))}
        </ul>
      ) : (
        <p className="integration-empty">No keys yet.</p>
      )}
      {revoked.length ? <p className="api-access-note">{revoked.length} revoked {revoked.length === 1 ? "key" : "keys"} kept for the record.</p> : null}
    </section>
  );
}

function KeyRow({ record, busy, onRevoke }: { record: ApiKeyRecord; busy: boolean; onRevoke: () => void }) {
  const expired = record.expiresAt && Date.parse(record.expiresAt) < Date.now();
  return (
    <li className="api-access-item">
      <div>
        <strong>{record.name}</strong>
        <code>{record.hint}</code>
      </div>
      <span className="api-access-meta">
        {expired ? "Expired · " : ""}Last used {when(record.lastUsedAt)} · made {when(record.createdAt)}
        {record.expiresAt && !expired ? ` · expires ${when(record.expiresAt)}` : ""}
      </span>
      <span className="api-access-chips">
        {record.scopes.map((scope) => <em key={scope}>{scope}</em>)}
      </span>
      <button type="button" className="api-access-danger" disabled={busy} onClick={onRevoke}>Revoke</button>
    </li>
  );
}

function WebhooksSection({ state, busy, run, reload, reveal }: SectionProps) {
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [allEvents, setAllEvents] = useState(true);
  const [events, setEvents] = useState<string[]>([]);

  return (
    <section className="api-access-section">
      <div className="api-access-heading">
        <h3>Webhooks</h3>
        <button type="button" className="api-access-primary" disabled={busy} onClick={() => setAdding((value) => !value)}>
          {adding ? "Cancel" : "Add endpoint"}
        </button>
      </div>
      <p className="api-access-lede">
        Clarity POSTs each change to your URL within about a minute, signed so you can tell it came from Clarity.
        If your end is down it tries again for three days.
      </p>

      {adding ? (
        <form
          className="api-access-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const created = await apiAccessAction<{ secret: string }>("create_endpoint", {
                url,
                description,
                events: allEvents ? ["*"] : events,
              });
              reveal({
                title: "Signing secret",
                value: created.secret,
                note: "Use it to check the X-Clarity-Signature header on each delivery. You can show it again from the endpoint.",
              });
              setAdding(false);
              setUrl("");
              setDescription("");
              await reload();
            });
          }}
        >
          <label className="settings-field">
            <span>URL</span>
            <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/clarity-webhook" required />
          </label>
          <label className="settings-field">
            <span>Description</span>
            <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Optional" maxLength={200} />
          </label>
          <fieldset className="api-access-scopes">
            <legend>Send</legend>
            <label>
              <input type="checkbox" checked={allEvents} onChange={() => setAllEvents((value) => !value)} />
              <span>Every event, including ones added later</span>
            </label>
            {!allEvents
              ? state.eventTypes.map((type) => (
                  <label key={type}>
                    <input
                      type="checkbox"
                      checked={events.includes(type)}
                      onChange={() => setEvents((current) => (current.includes(type) ? current.filter((entry) => entry !== type) : [...current, type]))}
                    />
                    <code>{type}</code>
                  </label>
                ))
              : null}
          </fieldset>
          <div className="api-access-row">
            <button type="submit" className="api-access-primary" disabled={busy || !url.trim() || (!allEvents && !events.length)}>
              {busy ? "Adding…" : "Add endpoint"}
            </button>
          </div>
        </form>
      ) : null}

      {state.endpoints.length ? (
        <ul className="api-access-list">
          {state.endpoints.map((endpoint) => (
            <EndpointRow key={endpoint.id} endpoint={endpoint} busy={busy} run={run} reload={reload} reveal={reveal} />
          ))}
        </ul>
      ) : (
        <p className="integration-empty">No endpoints yet.</p>
      )}
    </section>
  );
}

function EndpointRow({
  endpoint,
  busy,
  run,
  reload,
  reveal,
}: { endpoint: WebhookEndpoint } & Pick<SectionProps, "busy" | "run" | "reload" | "reveal">) {
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const status = !endpoint.enabled
    ? { tone: "bad", label: endpoint.disabled_reason || "Switched off" }
    : endpoint.last_failure_at && (!endpoint.last_success_at || endpoint.last_failure_at > endpoint.last_success_at)
      ? { tone: "warn", label: `Failing since ${when(endpoint.last_failure_at)}` }
      : { tone: "ok", label: endpoint.last_success_at ? `Last delivered ${when(endpoint.last_success_at)}` : "Nothing sent yet" };

  const loadDeliveries = () => run(async () => setDeliveries(await fetchDeliveries(endpoint.id)));

  return (
    <li className="api-access-item is-endpoint">
      <div>
        <strong>{endpoint.url}</strong>
        {endpoint.description ? <span className="api-access-meta">{endpoint.description}</span> : null}
      </div>
      <span className={`api-access-status is-${status.tone}`}>{status.label}</span>
      <span className="api-access-chips">
        {endpoint.events.map((type) => <em key={type}>{type === "*" ? "all events" : type}</em>)}
      </span>
      <div className="api-access-row">
        <button type="button" className="api-access-secondary" disabled={busy} onClick={() => void run(async () => {
          setTest((await apiAccessAction<{ result: TestResult }>("test_endpoint", { id: endpoint.id })).result);
        })}>Send test</button>
        <button type="button" className="api-access-secondary" disabled={busy} onClick={() => (deliveries ? setDeliveries(null) : void loadDeliveries())}>
          {deliveries ? "Hide deliveries" : "Deliveries"}
        </button>
        <button type="button" className="api-access-secondary" disabled={busy} onClick={() => void run(async () => {
          const { secret } = await apiAccessAction<{ secret: string }>("reveal_secret", { id: endpoint.id });
          reveal({ title: "Signing secret", value: secret, note: "Checks the X-Clarity-Signature header on each delivery." });
        })}>Signing secret</button>
        <button type="button" className="api-access-secondary" disabled={busy} onClick={() => void run(async () => {
          if (!window.confirm("Make a new signing secret? Deliveries are signed with the new one straight away, so update the receiving end too.")) return;
          const { secret } = await apiAccessAction<{ secret: string }>("roll_secret", { id: endpoint.id });
          reveal({ title: "New signing secret", value: secret, note: "The old secret no longer verifies anything." });
        })}>New secret</button>
        <button type="button" className="api-access-secondary" disabled={busy} onClick={() => void run(async () => {
          await apiAccessAction("update_endpoint", { id: endpoint.id, enabled: !endpoint.enabled });
          await reload();
        })}>{endpoint.enabled ? "Switch off" : "Switch on"}</button>
        <button type="button" className="api-access-danger" disabled={busy} onClick={() => void run(async () => {
          if (!window.confirm(`Remove ${endpoint.url}? Nothing more is sent to it.`)) return;
          await apiAccessAction("delete_endpoint", { id: endpoint.id });
          await reload();
        })}>Remove</button>
      </div>
      {test ? (
        <p className={`api-access-status is-${test.ok ? "ok" : "bad"}`}>
          {test.ok ? `Test delivered · ${test.status} in ${test.durationMs} ms` : `Test failed · ${test.error}`}
        </p>
      ) : null}
      {deliveries ? (
        deliveries.length ? (
          <table className="api-access-deliveries">
            <thead>
              <tr><th>Event</th><th>Status</th><th>Tries</th><th>Last try</th><th /></tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td><code>{delivery.event_type}</code></td>
                  <td className={`api-access-status is-${delivery.status === "succeeded" ? "ok" : delivery.status === "failed" ? "bad" : "warn"}`}>
                    {delivery.status}
                    {delivery.last_status_code ? ` · ${delivery.last_status_code}` : ""}
                    {delivery.last_error && delivery.status !== "succeeded" ? ` · ${delivery.last_error}` : ""}
                  </td>
                  <td>{delivery.attempts}</td>
                  <td>{when(delivery.last_attempt_at)}</td>
                  <td>
                    {delivery.status !== "succeeded" && delivery.status !== "processing" ? (
                      <button type="button" className="text-button" disabled={busy} onClick={() => void run(async () => {
                        await apiAccessAction("retry_delivery", { id: delivery.id });
                        setDeliveries(await fetchDeliveries(endpoint.id));
                      })}>Send again</button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="api-access-note">Nothing sent to this endpoint yet.</p>
        )
      ) : null}
    </li>
  );
}
