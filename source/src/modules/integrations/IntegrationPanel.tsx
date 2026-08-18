import { useCallback, useEffect, useMemo, useState } from "react";

import { AutoSaved, InlineEditProvider, InlineEditRow } from "../shared/InlineEdit";

/**
 * The Developer tab's connection screen.
 *
 * Organised by direction rather than by feature, because direction is the thing
 * that is actually hard to keep straight when wiring two systems together:
 *
 *   Webhooks   what they send us      we publish a URL, they give us a secret
 *   API        what we send them      they give us an endpoint and tokens
 *   Mapping    their words → ours     workspace, resources, lesson types
 *   Activity   everything that moved  both directions, newest first
 *   Health     can I use this now
 *
 * Nothing here names a provider. The tabs, the credential fields, the event
 * list and even the word for a "bay" all come from the descriptor the server
 * sends, so a second provider needs a backend adapter and no UI change at all.
 */

type Tab = "webhooks" | "api" | "mapping" | "activity" | "health";
type ActivityFilter = "all" | "bookings" | "purchases" | "problems";

type Credential = {
  key: string; label: string; help: string; secret: boolean; required: boolean;
  defaultValue: string; set: boolean; length: number; fingerprint: string;
  value: string; hasSurroundingWhitespace: boolean;
};
type Capabilities = {
  sourceType: string; label: string;
  createExternally: boolean; rescheduleExternally: boolean; cancelExternally: boolean;
  receiveCreatedEvents: boolean; receiveUpdatedEvents: boolean; receiveCancelledEvents: boolean;
  writeBlockedReason?: string;
};
type SetupState = {
  providers: Array<{ id: string; label: string }>;
  provider: { id: string; label: string; docsUrl: string; vocabulary: { workspace: string; resource: string }; capabilities: Capabilities };
  webhook: { url: string; events: Array<{ id: string; label: string; note?: string }>; signatureRecipe: string; credentials: Credential[] } | null;
  api: { kind: string; operations: Array<{ id: string; label: string }>; credentials: Credential[] } | null;
};

type ResourceProfile = { id: string; name: string; handedness: "standard" | "left"; resourceIds: string[]; serviceIds: string[] };
type PendingSummary = { count: number; oldest: string | null; newest: string | null };
type Workspace = { id: string; name: string; type: string; events: number; lastSeen: string | null; firstSeen: string | null };
type PassPurchase = {
  id: string; event_type: string; external_purchase_id: string | null; sale_number: string | null;
  member_email: string | null; member_name: string | null; person_id: string | null;
  item_name: string | null; quantity: number | string | null; amount_cents: number | null; currency: string | null;
  purchased_at: string; paid_at: string | null;
  is_pass: boolean; classification: "pass" | "not_pass" | "unknown"; rawPayload: unknown;
};
type IntegrationState = {
  mappings: any[]; catalog: { services: any[]; locations: any[]; coaches: any[] };
  events: any[]; workspaces?: Workspace[]; pending?: PendingSummary; purchases?: PassPurchase[];
};

/** Events that never reached a conclusion, so the panel can retry them. */
const UNPROCESSED = ["received", "stored", "failed"];

const newProfile = (number = 1, resourceIds: string[] = []): ResourceProfile => ({
  id: `resource-${Date.now()}-${number}`,
  name: number === 1 ? "Standard lessons" : `Resource profile ${number}`,
  handedness: "standard",
  resourceIds,
  serviceIds: [],
});

function formatAmount(row: { amount_cents: number | null; currency: string | null }) {
  if (row.amount_cents == null) return "Amount unknown";
  const amount = (row.amount_cents / 100).toFixed(2);
  // A sale event may carry no currency, so a bare amount is normal rather than
  // missing.
  return row.currency ? `${row.currency} ${amount}` : amount;
}

/** "2 x" for a multi-quantity sale; nothing at all for a single one. */
function formatQuantity(quantity: number | string | null) {
  const value = Number(quantity);
  return Number.isFinite(value) && value > 1 ? `${value % 1 === 0 ? value : value.toFixed(2)} x ` : "";
}

/**
 * Why a purchase has no Clarity client against it.
 *
 * Some providers omit the buyer's email on a product sale and send only a
 * display name, so it can never auto-link, and saying "Not matched" would read
 * as a fault rather than a fact about the payload.
 */
function clientLabel(row: PassPurchase) {
  if (row.person_id) return "Linked";
  if (row.member_email) return "Not matched";
  return "No email in payload";
}

function safeJson(value: unknown) {
  try { return JSON.stringify(value ?? {}, null, 2); } catch { return "Unable to display payload."; }
}

function since(iso: string | null) {
  if (!iso) return "never";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days > 1) return `${days} days ago`;
  const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return "just now";
}

/**
 * One thing to copy into the other system.
 *
 * Read-only by construction. These are facts about Clarity — you never type
 * them, so you can never type them wrong.
 */
function CopyField({ label, value, help }: { label: string; value: string; help?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <label className="integration-credential">
      <span className="credential-label">
        {label}
        <button
          className="credential-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
          type="button"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </span>
      <input readOnly value={value} />
      {help ? <small>{help}</small> : null}
    </label>
  );
}

/**
 * One credential's state, never its value when it is a secret.
 *
 * Length and fingerprint are shown for a specific reason: a secret pasted with
 * a trailing newline is invisible behind a row of dots and rejects every
 * delivery. A length one longer than expected gives it away immediately.
 */
function CredentialField({ credential }: { credential: Credential }) {
  const status = credential.set
    ? credential.secret
      ? `Set · ${credential.length} chars · ${credential.fingerprint}`
      : credential.value
    : credential.required ? "Not set — required" : "Not set";
  return (
    <label className={`integration-credential${credential.set ? "" : credential.required ? " missing" : " optional"}`}>
      <span className="credential-label">
        {credential.label}
        <code>{credential.key}</code>
      </span>
      <input readOnly value={status} />
      {credential.hasSurroundingWhitespace ? (
        <strong className="credential-warning">
          This value has a space or newline around it. That is enough on its own to make every request fail — re-paste it.
        </strong>
      ) : null}
      <small>{credential.help}</small>
      {!credential.set && credential.defaultValue ? <small>Default if left unset: <code>{credential.defaultValue}</code></small> : null}
    </label>
  );
}

export default function IntegrationPanel() {
  const [tab, setTab] = useState<Tab>("webhooks");
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [setupError, setSetupError] = useState("");
  const [integration, setIntegration] = useState<IntegrationState | null>(null);
  const [integrationError, setIntegrationError] = useState("");
  const [resourceError, setResourceError] = useState("");
  const [profiles, setProfiles] = useState<ResourceProfile[]>([]);
  const [resourceServices, setResourceServices] = useState<any[]>([]);
  const [resourceConfig, setResourceConfig] = useState<Record<string, any>>({});
  const [mappingDraft, setMappingDraft] = useState({ enabled: false, locationId: "", defaultCoachId: "", emailBehaviour: "none" });
  // Rule 06: every control on these two panels commits on its own, so what is
  // tracked is when it last landed and whether it failed — not whether a
  // button should be enabled.
  const [busy, setBusy] = useState<"" | "mapping" | "resources">("");
  const [savedAt, setSavedAt] = useState<{ mapping: number | null; resources: number | null }>({
    mapping: null,
    resources: null,
  });
  const [replayDays, setReplayDays] = useState(7);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [replaying, setReplaying] = useState(false);
  const [replayResult, setReplayResult] = useState("");

  const loadSetup = useCallback(async () => {
    try {
      const response = await fetch("/api/integration-setup", { credentials: "same-origin", cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || payload?.error || `Setup returned ${response.status}.`);
      setSetup(payload);
      setSetupError("");
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : "Connection details could not load.");
    }
  }, []);

  const loadIntegration = useCallback(async () => {
    try {
      const response = await fetch("/api/external-bookings", { credentials: "same-origin", cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || payload?.error || `Feed returned ${response.status}.`);
      setIntegration(payload);
      setIntegrationError("");
      const mapping = payload.mappings?.[0] || {};
      setMappingDraft({
        enabled: mapping.enabled === true,
        locationId: mapping.location_id || "",
        defaultCoachId: mapping.default_coach_id || "",
        emailBehaviour: mapping.email_behaviour || "none",
      });
    } catch (error) {
      setIntegrationError(error instanceof Error ? error.message : "The event feed could not load.");
    }
  }, []);

  const loadResources = useCallback(async () => {
    try {
      const [response, servicesResponse] = await Promise.all([
        fetch("/api/optix-booking-type-settings", { credentials: "same-origin", cache: "no-store" }),
        fetch("/api/services", { credentials: "same-origin", cache: "no-store" }),
      ]);
      const payload = await response.json().catch(() => ({}));
      const servicesPayload = await servicesResponse.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || payload?.error || `Resource settings returned ${response.status}.`);
      if (servicesResponse.ok && Array.isArray(servicesPayload?.services)) setResourceServices(servicesPayload.services);
      setResourceConfig(payload.config || {});
      setProfiles(Array.isArray(payload.profiles) && payload.profiles.length ? payload.profiles : [newProfile()]);
      setResourceError("");
    } catch (error) {
      setResourceError(error instanceof Error ? error.message : "Resource settings could not load.");
      setProfiles((current) => current.length ? current : [newProfile()]);
    }
  }, []);

  useEffect(() => { void Promise.all([loadSetup(), loadIntegration(), loadResources()]); }, [loadSetup, loadIntegration, loadResources]);

  // /api/services is normalized, so it always includes the reserved External
  // Booking lesson type; the raw settings catalog only has it after a save.
  const services = resourceServices.length ? resourceServices : integration?.catalog?.services || [];
  const mapping = integration?.mappings?.[0] || null;
  const events = integration?.events || [];
  const pending: PendingSummary = integration?.pending || { count: 0, oldest: null, newest: null };
  const purchases = integration?.purchases || [];
  const workspaces = integration?.workspaces || [];

  // Falls back to a noun that reads correctly inside a sentence. It used to be
  // "Integration", which turned the API tab's hint into "What we send
  // Integration" any time the descriptor had not loaded — which is exactly when
  // somebody is looking at this screen.
  const providerLabel = setup?.provider?.label || "this connection";
  const words = setup?.provider?.vocabulary || { workspace: "workspace", resource: "resource" };
  const resourceWord = words.resource;

  const mappedIds = useMemo(
    () => new Set((integration?.mappings || []).map((row: any) => String(row.workspace_id))),
    [integration],
  );
  // Anything not mapped as the lesson workspace is a bookable resource. Derived
  // rather than listed, so a new bay appears on its own the first time it is
  // booked instead of waiting for someone to edit a constant.
  const resourceWorkspaces = useMemo(
    () => workspaces.filter((workspace) => !mappedIds.has(workspace.id)),
    [workspaces, mappedIds],
  );
  const workspaceName = (id: string) => workspaces.find((workspace) => workspace.id === id)?.name || id;
  const workspaceLabel = (workspace: Workspace) => workspace.type ? `${workspace.name} · ${workspace.type}` : workspace.name;

  const failedCount = useMemo(() => events.filter((event) => event.processing_status === "failed").length, [events]);
  const lastDelivery = events[0]?.received_at || null;

  const purchaseRows = useMemo(
    () => purchases.filter((row) => activityFilter === "problems" ? row.classification === "unknown" : true),
    [purchases, activityFilter],
  );
  const eventRows = useMemo(
    () => events.filter((event) => activityFilter === "problems"
      ? event.processing_status === "failed" || UNPROCESSED.includes(event.processing_status)
      : true),
    [events, activityFilter],
  );
  const showEvents = activityFilter === "all" || activityFilter === "bookings" || activityFilter === "problems";
  const showPurchases = activityFilter === "all" || activityFilter === "purchases" || activityFilter === "problems";

  const missingRequired = useMemo(() => {
    const all = [...(setup?.webhook?.credentials || []), ...(setup?.api?.credentials || [])];
    return all.filter((credential) => credential.required && !credential.set);
  }, [setup]);
  const whitespaceProblems = useMemo(() => {
    const all = [...(setup?.webhook?.credentials || []), ...(setup?.api?.credentials || [])];
    return all.filter((credential) => credential.hasSurroundingWhitespace);
  }, [setup]);

  // Age, not count. One event stuck for three days matters more than fifty that
  // arrived in the last hour, and only age tells you something is wrong.
  const pendingAgeDays = pending.oldest
    ? Math.floor((Date.now() - new Date(pending.oldest).getTime()) / 86_400_000)
    : 0;
  const queueStuck = pending.count > 0 && pendingAgeDays >= 1;

  const attention = Boolean(setupError || integrationError || resourceError || missingRequired.length || whitespaceProblems.length || failedCount || queueStuck);

  function patchProfile(id: string, patch: Partial<ResourceProfile>) {
    void commitResources(profiles.map((profile) => profile.id === id ? { ...profile, ...patch } : profile));
  }

  function moveResource(profile: ResourceProfile, index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= profile.resourceIds.length) return;
    const resourceIds = [...profile.resourceIds];
    [resourceIds[index], resourceIds[target]] = [resourceIds[target], resourceIds[index]];
    patchProfile(profile.id, { resourceIds });
  }

  /**
   * Commit one mapping change the moment it is made.
   *
   * Every control here is a toggle or a picker, and Rule 06 is explicit that
   * those never get a Save button: the change already happened when you made
   * it, so a Save would ask you to confirm something that is already true.
   * What they get instead is the line that says when it landed.
   */
  async function commitMapping(patch: Partial<typeof mappingDraft>) {
    const next = { ...mappingDraft, ...patch };
    setMappingDraft(next);
    setBusy("mapping");
    const response = await fetch("/api/external-bookings", {
      method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: mapping?.workspace_id || "", ...next }),
    });
    const payload = await response.json().catch(() => ({}));
    setBusy("");
    if (!response.ok) {
      return setIntegrationError(payload?.message || payload?.error || "That change could not be saved.");
    }
    setIntegration(payload.state);
    setIntegrationError("");
    setSavedAt((current) => ({ ...current, mapping: Date.now() }));
  }

  /**
   * Commit the resource profiles as they are edited.
   *
   * Validation used to run when a Save button was pressed, which meant an
   * invalid arrangement could sit on screen indefinitely looking fine. It now
   * runs on every change: an invalid state is refused, said out loud on the
   * line under the panel, and — crucially — not written, so what is stored and
   * what is shown cannot drift apart while somebody thinks about it.
   */
  async function commitResources(nextProfiles: ResourceProfile[], nextConfig = resourceConfig) {
    setProfiles(nextProfiles);
    setResourceConfig(nextConfig);
    if (nextProfiles.some((profile) => !profile.resourceIds.length)) {
      return setResourceError(`Every profile needs at least one ${resourceWord}.`);
    }
    const assigned = new Set<string>();
    for (const profile of nextProfiles) for (const serviceId of profile.serviceIds) {
      const key = `${profile.handedness}:${serviceId}`;
      if (assigned.has(key)) return setResourceError("A lesson type can only use one profile for each handedness.");
      assigned.add(key);
    }
    const config = Object.fromEntries(services.map((service) => {
      const standard = nextProfiles.find((profile) => profile.handedness === "standard" && profile.serviceIds.includes(service.id));
      const left = nextProfiles.find((profile) => profile.handedness === "left" && profile.serviceIds.includes(service.id));
      return [service.id, {
        enabled: Boolean(standard || left),
        autoBook: nextConfig[service.id]?.autoBook === true,
        leftHanded: false,
        preferredResourceIds: standard?.resourceIds || [],
        leftHandedResourceIds: left?.resourceIds || [],
      }];
    }));
    setBusy("resources");
    const response = await fetch("/api/optix-booking-type-settings", {
      method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ profiles: nextProfiles, config: { ...nextConfig, ...config } }),
    });
    const payload = await response.json().catch(() => ({}));
    setBusy("");
    if (!response.ok) {
      return setResourceError(payload?.message || payload?.error || "That change could not be saved.");
    }
    setProfiles(payload.profiles || nextProfiles);
    setResourceConfig(payload.config || config);
    setResourceError("");
    setSavedAt((current) => ({ ...current, resources: Date.now() }));
  }

  async function processPending() {
    setReplaying(true); setReplayResult("");
    const sinceIso = new Date(Date.now() - replayDays * 86_400_000).toISOString();
    const response = await fetch("/api/external-bookings", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "process-pending", since: sinceIso }),
    });
    const payload = await response.json().catch(() => ({})); setReplaying(false);
    if (!response.ok) return setIntegrationError(payload?.message || payload?.error || "Pending events could not be processed.");
    setIntegration(payload.state); setIntegrationError("");
    const summary = Object.entries(payload.summary || {}).map(([key, value]) => `${key} ${value}`).join(" · ");
    setReplayResult(`Processed ${payload.attempted || 0} event${payload.attempted === 1 ? "" : "s"}${summary ? ` — ${summary}` : ""}.`);
  }

  async function retryEvent(eventKey: string) {
    const response = await fetch("/api/external-bookings", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retry", eventKey }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return setIntegrationError(payload?.message || payload?.error || "Event retry failed.");
    setIntegration(payload.state); setIntegrationError("");
  }

  const TAB_LABELS: Record<Tab, string> = {
    webhooks: "Webhooks",
    api: "API",
    mapping: "Mapping",
    activity: "Activity",
    health: "Health",
  };
  const TAB_HINTS: Record<Tab, string> = {
    webhooks: `What ${providerLabel} sends us`,
    api: `What we send ${providerLabel}`,
    mapping: "Their words, in yours",
    activity: "Everything that moved",
    health: "Can I use this right now",
  };
  const tabs: Tab[] = ["webhooks", "api", "mapping", "activity", "health"];

  return (
    <InlineEditProvider>
    <article className="data-card settings-section settings-developer integration-panel">
      <header className="integration-header">
        <div>
          <span>Connection</span>
          <h2>{setup?.provider?.label || "Not connected"}</h2>
          <p>{TAB_HINTS[tab]}</p>
        </div>
        <strong className={attention ? "needs-attention" : ""}>{attention ? "Needs attention" : "Ready"}</strong>
      </header>

      <div className="integration-tabs" role="tablist" aria-label={`${providerLabel} connection`}>
        {tabs.map((value) => (
          <button
            key={value}
            className={tab === value ? "active" : ""}
            onClick={() => setTab(value)}
            role="tab"
            aria-selected={tab === value}
            type="button"
          >
            {TAB_LABELS[value]}
            {value === "activity" && events.length ? <b>{events.length}</b> : null}
            {value === "health" && attention ? <b>!</b> : null}
          </button>
        ))}
      </div>

      <div className="integration-body">
        {setupError ? <div className="integration-error"><strong>Connection details are unavailable</strong>{setupError}</div> : null}

        {/* ---------------- Webhooks: what they send us ------------------- */}
        {tab === "webhooks" ? (
          setup?.webhook ? (
            <>
              <div className="integration-note">
                <strong>Inbound</strong>
                <span>
                  {providerLabel} posts to Clarity. Copy the two things on the left into {providerLabel};
                  paste the two on the right back here. Nothing works until both directions are done.
                </span>
              </div>
              <div className="integration-directions">
                <section>
                  <h3>Give these to {providerLabel}</h3>
                  <CopyField
                    label="Webhook URL"
                    value={setup.webhook.url}
                    help={`Paste into ${providerLabel}'s webhook settings. This is the only address Clarity listens on.`}
                  />
                  <CopyField
                    label="Events to subscribe to"
                    value={setup.webhook.events.map((event) => event.id).join("\n")}
                    help="Nothing else is read. Anything not on this list is stored and ignored."
                  />
                  <ul className="integration-events">
                    {setup.webhook.events.map((event) => (
                      <li key={event.id}>
                        <code>{event.id}</code>
                        <span>{event.label}</span>
                        {event.note ? <em>{event.note}</em> : null}
                      </li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3>Paste these from {providerLabel}</h3>
                  {setup.webhook.credentials.map((credential) => <CredentialField credential={credential} key={credential.key} />)}
                  {setup.webhook.signatureRecipe ? (
                    <label className="integration-credential">
                      <span className="credential-label">Signature recipe</span>
                      <input readOnly value={setup.webhook.signatureRecipe} />
                      <small>
                        How every delivery is signed. Shown because this is what silently fails when a secret
                        is pasted with a stray space — a 401 should be readable from here rather than from the source.
                      </small>
                    </label>
                  ) : null}
                </section>
              </div>
              <div className="integration-note">
                <strong>Credentials live in the environment</strong>
                <span>
                  Clarity reads these from environment variables, so they are set where the site is
                  deployed rather than here. This screen reports what is set and what is missing;
                  it deliberately never shows a secret back to you.
                </span>
              </div>
            </>
          ) : <div className="integration-empty">{providerLabel} does not send Clarity anything.</div>
        ) : null}

        {/* ---------------- API: what we send them ------------------------ */}
        {tab === "api" ? (
          setup?.api ? (
            <>
              <div className="integration-note">
                <strong>Outbound</strong>
                <span>
                  Clarity calls {providerLabel} over {setup.api.kind === "graphql" ? "GraphQL" : "REST"} to book and
                  release {resourceWord}s. Everything here is pasted from {providerLabel}; there is nothing to copy back.
                </span>
              </div>
              <div className="integration-directions single">
                <section>
                  <h3>Paste these from {providerLabel}</h3>
                  {setup.api.credentials.map((credential) => <CredentialField credential={credential} key={credential.key} />)}
                </section>
              </div>
              <div className="integration-note">
                <strong>What Clarity asks for</strong>
                <ul className="integration-events">
                  {setup.api.operations.map((operation) => (
                    <li key={operation.id}><code>{operation.id}</code><span>{operation.label}</span></li>
                  ))}
                </ul>
              </div>
              {setup.provider.capabilities.writeBlockedReason ? (
                <div className="integration-note">
                  <strong>What Clarity cannot do</strong>
                  <span>{setup.provider.capabilities.writeBlockedReason}</span>
                </div>
              ) : null}
            </>
          ) : <div className="integration-empty">Clarity only receives from {providerLabel}; it never calls out.</div>
        ) : null}

        {/* ---------------- Mapping: their words, in ours ----------------- */}
        {tab === "mapping" ? (
          <>
            {integrationError ? <div className="integration-error"><strong>Mapping data is unavailable</strong>{integrationError}</div> : null}
            <div className="integration-note">
              <strong>Inbound lessons</strong>
              <span>
                {mapping
                  ? `${capitalise(words.workspace)} ${mapping.workspace_id}${workspaceName(String(mapping.workspace_id)) !== String(mapping.workspace_id) ? ` (${workspaceName(String(mapping.workspace_id))})` : ""} is recognised; every other ${words.workspace} is ignored.`
                  : `No ${words.workspace} is mapped yet, so nothing is imported.`}
                {" "}Every booking files under the reserved External Booking lesson type — its time comes from
                {" "}{providerLabel}, their label goes in the lesson note, and the customer lands in the external
                booking clients list unless their email matches an existing client.
              </span>
            </div>
            <div className="integration-grid">
              <label className="toggle">
                <input checked={mappingDraft.enabled} onChange={(event) => void commitMapping({ enabled: event.target.checked })} type="checkbox" />
                {" "}Enable appointment creation
              </label>
              <label>
                {capitalise(words.workspace)}
                <input readOnly value={mapping ? `${mapping.workspace_id}${workspaceName(String(mapping.workspace_id)) !== String(mapping.workspace_id) ? ` · ${workspaceName(String(mapping.workspace_id))}` : ""}` : "Not mapped"} />
              </label>
              <label>Lesson type<input readOnly value="External Booking (automatic)" /></label>
              <label>
                Clarity location
                <select disabled={!integration} value={mappingDraft.locationId} onChange={(event) => void commitMapping({ locationId: event.target.value })}>
                  <option value="">Select location</option>
                  {(integration?.catalog?.locations || []).map((location) => <option key={location.id} value={location.id}>{location.name || location.id}</option>)}
                </select>
              </label>
              <label>
                Default coach
                <select disabled={!integration} value={mappingDraft.defaultCoachId} onChange={(event) => void commitMapping({ defaultCoachId: event.target.value })}>
                  <option value="">No default coach</option>
                  {(integration?.catalog?.coaches || []).map((coach) => <option key={coach.id} value={coach.id}>{coach.displayName || coach.name || coach.id}</option>)}
                </select>
              </label>
              <label>
                Customer email
                <select value={mappingDraft.emailBehaviour} onChange={(event) => void commitMapping({ emailBehaviour: event.target.value })}>
                  <option value="none">No Clarity email</option>
                  <option value="immediate">Send immediately</option>
                  <option value="after_bay">Send after {resourceWord} booking</option>
                </select>
              </label>
            </div>
            {/* No Save. Every control above is a toggle or a picker and has
                already committed; what is left to say is when. */}
            <div className="integration-actions">
              <AutoSaved savedAt={savedAt.mapping} busy={busy === "mapping"} />
            </div>

            {resourceError ? <div className="integration-error"><strong>Resource settings need attention</strong>{resourceError}</div> : null}
            <div className="integration-resource-heading">
              <div>
                <h3>{capitalise(resourceWord)} profiles</h3>
                <p>
                  Which {resourceWord}s a lesson type may use, in the order Clarity should try them.
                  {" "}The list comes from {words.workspace}s {providerLabel} has actually sent — {resourceWorkspaces.length} so far.
                </p>
              </div>
              <button onClick={() => void commitResources([...profiles, newProfile(profiles.length + 1, resourceWorkspaces.map((workspace) => workspace.id))])} type="button">+ New profile</button>
            </div>
            {profiles.map((profile) => (
              <section className="integration-resource-profile" key={profile.id}>
                <div className="profile-title">
                  <InlineEditRow
                    label="Profile name"
                    value={profile.name}
                    width="name"
                    onSave={(name) => patchProfile(profile.id, { name: String(name) })}
                  />
                  <select aria-label="Player handedness" value={profile.handedness} onChange={(event) => patchProfile(profile.id, { handedness: event.target.value === "left" ? "left" : "standard" })}>
                    <option value="standard">Standard / any player</option>
                    <option value="left">Left-handed players</option>
                  </select>
                  <button className="text-button danger" disabled={profiles.length === 1} onClick={() => void commitResources(profiles.filter((candidate) => candidate.id !== profile.id))} type="button">Delete</button>
                </div>
                <div className="profile-columns">
                  <div>
                    <h4>Priority</h4>
                    <div className="resource-list">
                    {profile.resourceIds.map((id, index) => (
                      <div className="resource-row" key={id}>
                        <span>{index + 1}</span>
                        <strong>{workspaceName(id)}</strong>
                        <button aria-label={`Move ${workspaceName(id)} up`} disabled={index === 0} onClick={() => moveResource(profile, index, -1)} type="button">↑</button>
                        <button aria-label={`Move ${workspaceName(id)} down`} disabled={index === profile.resourceIds.length - 1} onClick={() => moveResource(profile, index, 1)} type="button">↓</button>
                        <button onClick={() => patchProfile(profile.id, { resourceIds: profile.resourceIds.filter((candidate) => candidate !== id) })} type="button">Remove</button>
                      </div>
                    ))}
                    </div>
                    <div className="removed-resources">
                      {resourceWorkspaces.filter((workspace) => !profile.resourceIds.includes(workspace.id)).map((workspace) => (
                        <button key={workspace.id} onClick={() => patchProfile(profile.id, { resourceIds: [...profile.resourceIds, workspace.id] })} title={workspaceLabel(workspace)} type="button">
                          + {workspace.name}
                        </button>
                      ))}
                      {resourceWorkspaces.length ? null : (
                        <em>Nothing seen yet. A {resourceWord} appears here the first time {providerLabel} sends a booking for it.</em>
                      )}
                    </div>
                  </div>
                  <div>
                    <h4>Lesson types</h4>
                    <div className="resource-services">
                      {services.length ? services.map((service) => (
                        <label key={service.id}>
                          <input
                            checked={profile.serviceIds.includes(service.id)}
                            onChange={(event) => patchProfile(profile.id, { serviceIds: event.target.checked ? [...profile.serviceIds, service.id] : profile.serviceIds.filter((id) => id !== service.id) })}
                            type="checkbox"
                          />
                          {service.name || service.id}
                        </label>
                      )) : <p>Lesson types will appear when the settings endpoint is available.</p>}
                    </div>
                  </div>
                </div>
              </section>
            ))}
            <section className="integration-resource-profile">
              <div className="integration-resource-heading">
                <div>
                  <h3>Auto-book after client bookings</h3>
                  <p>
                    Ticked lesson types get a {resourceWord} booked automatically once a client booking lands on the
                    calendar. Needs a profile above; if none is free the booking still goes ahead and the card shows
                    no {resourceWord}.
                  </p>
                </div>
              </div>
              <div className="resource-services">
                {services.map((service) => (
                  <label key={service.id}>
                    <input
                      checked={resourceConfig[service.id]?.autoBook === true}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        void commitResources(profiles, {
                          ...resourceConfig,
                          [service.id]: { ...(resourceConfig[service.id] || {}), autoBook: checked },
                        });
                      }}
                      type="checkbox"
                    />
                    {service.name || service.id}
                  </label>
                ))}
              </div>
            </section>
            {/* Same again: every control in this section commits itself, and
                validation now runs on the change rather than on a button, so an
                invalid arrangement is refused instead of sitting on screen
                looking saved. */}
            <div className="integration-actions">
              <AutoSaved savedAt={savedAt.resources} busy={busy === "resources"} />
            </div>
          </>
        ) : null}

        {/* ---------------- Activity: one log, both shapes ---------------- */}
        {tab === "activity" ? (
          <>
            {integrationError ? <div className="integration-error"><strong>The feed is unavailable</strong>{integrationError}</div> : null}
            <div className="integration-feed-toolbar">
              <div>
                <h3>Received from {providerLabel}</h3>
                <p>Raw deliveries, newest first.</p>
              </div>
              <label>
                Show
                <select value={activityFilter} onChange={(event) => setActivityFilter(event.target.value as ActivityFilter)}>
                  <option value="all">Everything</option>
                  <option value="bookings">Bookings</option>
                  <option value="purchases">Purchases</option>
                  <option value="problems">Problems only</option>
                </select>
              </label>
              <button onClick={() => void loadIntegration()} type="button">Refresh</button>
            </div>

            {pending.count ? (
              <div className={`integration-pending-bar${queueStuck ? " stuck" : ""}`}>
                <div>
                  <strong>{pending.count} event{pending.count === 1 ? "" : "s"} waiting</strong>
                  <span>
                    Oldest {pending.oldest ? since(pending.oldest) : "—"}. Bookings do not reach the calendar until these are processed.
                  </span>
                </div>
                <label>
                  Replay the last
                  <select value={replayDays} onChange={(event) => setReplayDays(Number(event.target.value))}>
                    <option value={1}>24 hours</option>
                    <option value={7}>7 days</option>
                    <option value={30}>30 days</option>
                    <option value={365}>everything</option>
                  </select>
                </label>
                <button disabled={replaying} onClick={() => void processPending()} type="button">{replaying ? "Processing…" : "Process pending"}</button>
              </div>
            ) : null}
            {replayResult ? <div className="integration-note"><strong>Replay finished</strong><span>{replayResult}</span></div> : null}

            {showPurchases && purchaseRows.length ? (
              <>
                <h4 className="integration-feed-group">Purchases</h4>
                {purchaseRows.map((row) => (
                  <details className="integration-event" key={row.id}>
                    <summary>
                      <strong>{formatQuantity(row.quantity)}{row.item_name || "Purchase"}</strong>
                      <span>{row.member_name || row.member_email || "No customer"}</span>
                      <time>{new Date(row.purchased_at).toLocaleString()}</time>
                      <em>{formatAmount(row)}</em>
                    </summary>
                    <div className="event-facts">
                      <span>Event <b>{row.event_type}</b></span>
                      <span>Classified <b>{row.classification}</b></span>
                      <span>Purchase ID <b>{row.external_purchase_id || "—"}</b></span>
                      <span>Sale # <b>{row.sale_number || "—"}</b></span>
                      <span>Paid <b>{row.paid_at ? new Date(row.paid_at).toLocaleString() : "—"}</b></span>
                      <span>Client <b>{clientLabel(row)}</b></span>
                    </div>
                    <pre>{safeJson(row.rawPayload)}</pre>
                  </details>
                ))}
              </>
            ) : null}

            {showEvents ? (
              <>
                {showPurchases && purchaseRows.length ? <h4 className="integration-feed-group">Bookings</h4> : null}
                {eventRows.length ? eventRows.map((event) => (
                  <details className="integration-event" key={event.event_key} open={event.processing_status === "failed"}>
                    <summary>
                      <strong>{event.event_type || "Unknown event"}</strong>
                      <span>{event.customer || "No customer"}</span>
                      <time>{event.received_at ? new Date(event.received_at).toLocaleString() : ""}</time>
                      <em>{event.processing_status}</em>
                    </summary>
                    <div className="event-facts">
                      <span>{capitalise(words.workspace)} <b>{event.workspaceId || "—"}</b></span>
                      <span>Booking ID <b>{event.external_booking_id || "—"}</b></span>
                      <span>Appointment <b>{event.clarity_item_id || "Not created"}</b></span>
                      <span>{capitalise(resourceWord)} <b>{event.outboundBayBookingId || "Not booked"}</b></span>
                    </div>
                    {event.error_message ? <div className="integration-error"><strong>{event.failure_code || "Processing error"}</strong>{event.error_message}</div> : null}
                    <pre>{safeJson(event.rawPayload)}</pre>
                    {UNPROCESSED.includes(event.processing_status) ? (
                      <button onClick={() => void retryEvent(event.event_key)} type="button">
                        {event.processing_status === "failed" ? "Retry this event" : "Process this event"}
                      </button>
                    ) : null}
                  </details>
                )) : <div className="integration-empty">Nothing to show for this filter.</div>}
              </>
            ) : null}
          </>
        ) : null}

        {/* ---------------- Health: can I use this right now -------------- */}
        {tab === "health" ? (
          <>
            <div className="integration-stat-grid">
              <div><span>Received</span><strong>{events.length}</strong></div>
              <div><span>Processed</span><strong>{events.filter((event) => event.processing_status === "processed").length}</strong></div>
              <div><span>Ignored</span><strong>{events.filter((event) => event.processing_status === "ignored").length}</strong></div>
              <div><span>Failed</span><strong>{failedCount}</strong></div>
            </div>
            <div className="integration-checks">
              <Check
                ok={Boolean(lastDelivery)}
                label="Deliveries arriving"
                detail={lastDelivery ? `Last one ${since(lastDelivery)}.` : `Nothing has ever arrived. Check the webhook URL is saved in ${providerLabel}.`}
              />
              <Check
                ok={!missingRequired.length && !whitespaceProblems.length}
                label="Credentials"
                detail={
                  whitespaceProblems.length
                    ? `${whitespaceProblems.map((credential) => credential.key).join(", ")} has whitespace around it. That alone rejects every request.`
                    : missingRequired.length
                      ? `Missing: ${missingRequired.map((credential) => credential.key).join(", ")}.`
                      : "Everything required is set."
                }
              />
              <Check
                ok={Boolean(mapping?.enabled && mapping?.location_id)}
                label={`${capitalise(words.workspace)} mapping`}
                detail={
                  !mapping ? `No ${words.workspace} mapped.`
                    : !mapping.enabled ? "Mapped but disabled — nothing will be imported."
                      : !mapping.location_id ? "Mapped but no Clarity location chosen."
                        : `${mapping.workspace_id} → ${mapping.account_id}, enabled.`
                }
              />
              <Check
                ok={resourceWorkspaces.length > 0}
                label={`${capitalise(resourceWord)} list`}
                detail={
                  resourceWorkspaces.length
                    ? `${resourceWorkspaces.length} discovered from traffic. A new one appears the first time it is booked.`
                    : `None seen yet. They appear as ${providerLabel} sends bookings for them.`
                }
              />
              <Check
                ok={!queueStuck}
                label="Unprocessed queue"
                detail={
                  !pending.count ? "Nothing waiting."
                    : queueStuck
                      ? `${pending.count} waiting, oldest ${since(pending.oldest)}. Bookings do not reach the calendar until processed.`
                      : `${pending.count} waiting, all from the last day.`
                }
                action={pending.count ? { label: "Go to Activity", run: () => setTab("activity") } : undefined}
              />
              <Check
                ok={failedCount === 0}
                label="Processing failures"
                detail={failedCount ? `${failedCount} event${failedCount === 1 ? "" : "s"} failed and can be retried from Activity.` : "None."}
              />
            </div>
            {setup?.provider?.docsUrl ? (
              <div className="integration-note">
                <strong>{providerLabel} documentation</strong>
                <span><a href={setup.provider.docsUrl} rel="noreferrer" target="_blank">{setup.provider.docsUrl}</a></span>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </article>
    </InlineEditProvider>
  );
}

/**
 * One health row: a fact with a verdict, not a label.
 *
 * "Connected" tells you the browser reached Clarity, which is never the
 * question. Every row here answers something you would otherwise have to go
 * and check.
 */
function Check({ ok, label, detail, action }: { ok: boolean; label: string; detail: string; action?: { label: string; run: () => void } }) {
  return (
    <p className={ok ? "check ok" : "check bad"}>
      <span aria-hidden="true">{ok ? "✓" : "✗"}</span>
      <b>{label}</b>
      <span>{detail}</span>
      {action ? <button onClick={action.run} type="button">{action.label}</button> : null}
    </p>
  );
}

function capitalise(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}
