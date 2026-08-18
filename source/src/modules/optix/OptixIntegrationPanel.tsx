import { useCallback, useEffect, useMemo, useState } from "react";

type Tab = "setup" | "resources" | "passes" | "feed" | "diagnostics";
type ResourceProfile = { id: string; name: string; handedness: "standard" | "left"; resourceIds: string[]; serviceIds: string[] };
type PendingSummary = { count: number; oldest: string | null; newest: string | null };
type PassPurchase = {
  id: string; event_type: string; external_purchase_id: string | null; sale_number: string | null;
  member_email: string | null; member_name: string | null; person_id: string | null;
  item_name: string | null; quantity: number | string | null; amount_cents: number | null; currency: string | null;
  purchased_at: string; paid_at: string | null;
  is_pass: boolean; classification: "pass" | "not_pass" | "unknown"; rawPayload: unknown;
};
/**
 * An external workspace Clarity has seen traffic from. Bays, lesson
 * workspaces, hire equipment — Optix models them all the same way, so the
 * panel shows the type and lets you choose rather than guessing which is which.
 */
type Workspace = { id: string; name: string; type: string; events: number; lastSeen: string | null; firstSeen: string | null };
type IntegrationState = { mappings: any[]; catalog: { services: any[]; locations: any[]; coaches: any[] }; events: any[]; workspaces?: Workspace[]; pending?: PendingSummary; purchases?: PassPurchase[] };

/** Events that never reached a conclusion, so the panel can retry them. */
const UNPROCESSED = ["received", "stored", "failed"];

const newProfile = (number = 1, resourceIds: string[] = []): ResourceProfile => ({ id: `resource-${Date.now()}-${number}`, name: number === 1 ? "Standard lessons" : `Resource profile ${number}`, handedness: "standard", resourceIds, serviceIds: [] });

function formatAmount(row: { amount_cents: number | null; currency: string | null }) {
  if (row.amount_cents == null) return "Amount unknown";
  const amount = (row.amount_cents / 100).toFixed(2);
  // new_sale sends no currency, so a bare amount is normal rather than missing.
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
 * A product sale carries no email — only the buyer's display name — so it can
 * never auto-link, and saying "Not matched" would read as a fault. Only a plan
 * subscription has an email to match on.
 */
function clientLabel(row: PassPurchase) {
  if (row.person_id) return "Linked";
  if (row.member_email) return "Not matched";
  return "No email in payload";
}

function safeJson(value: unknown) {
  try { return JSON.stringify(value ?? {}, null, 2); } catch { return "Unable to display payload."; }
}

export default function OptixIntegrationPanel() {
  const [tab, setTab] = useState<Tab>("setup");
  const [integration, setIntegration] = useState<IntegrationState | null>(null);
  const [integrationError, setIntegrationError] = useState("");
  const [resourceError, setResourceError] = useState("");
  const [profiles, setProfiles] = useState<ResourceProfile[]>([]);
  const [resourceServices, setResourceServices] = useState<any[]>([]);
  const [resourceConfig, setResourceConfig] = useState<Record<string, any>>({});
  const [setupDraft, setSetupDraft] = useState({ enabled: false, locationId: "", defaultCoachId: "", emailBehaviour: "none" });
  const [saving, setSaving] = useState<"" | "setup" | "resources">("");
  const [saved, setSaved] = useState("");
  const [replayDays, setReplayDays] = useState(7);
  const [showUnclassified, setShowUnclassified] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [replayResult, setReplayResult] = useState("");

  const loadIntegration = useCallback(async () => {
    try {
      const response = await fetch("/api/external-bookings", { credentials: "same-origin", cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || payload?.error || `Optix feed returned ${response.status}.`);
      setIntegration(payload);
      setIntegrationError("");
      // The saved mapping is what makes a workspace ours. There is one row per
      // provider today; picking the first is the same answer the hardcoded id
      // used to give, without naming anyone's workspace in the source.
      const mapping = payload.mappings?.[0] || {};
      setSetupDraft({ enabled: mapping.enabled === true, locationId: mapping.location_id || "", defaultCoachId: mapping.default_coach_id || "", emailBehaviour: mapping.email_behaviour || "none" });
    } catch (error) {
      setIntegrationError(error instanceof Error ? error.message : "Optix feed could not load.");
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

  useEffect(() => { void Promise.all([loadIntegration(), loadResources()]); }, [loadIntegration, loadResources]);

  // /api/services is normalized, so it always includes the reserved External
  // Booking lesson type; the raw settings catalog only has it after a save.
  const services = resourceServices.length ? resourceServices : integration?.catalog?.services || [];
  const mapping = integration?.mappings?.[0] || null;
  const events = integration?.events || [];
  const pending: PendingSummary = integration?.pending || { count: 0, oldest: null, newest: null };
  const purchases = integration?.purchases || [];
  // The tab is a Pass feed, so it shows Passes. Anything the classifier could
  // not call sits behind a toggle rather than being hidden, because a Pass
  // landing in "unclassified" is exactly the case worth spotting.
  const passes = useMemo(() => purchases.filter((row) => row.is_pass), [purchases]);
  const unclassified = useMemo(() => purchases.filter((row) => row.classification === "unknown"), [purchases]);
  const failedCount = useMemo(() => events.filter((event) => event.processing_status === "failed").length, [events]);
  const workspaces = integration?.workspaces || [];
  // Anything that is not the mapped lesson workspace is a bookable resource.
  // Deriving it this way means a new bay appears on its own the first time it
  // is booked, rather than waiting for someone to edit a constant.
  const mappedIds = useMemo(() => new Set((integration?.mappings || []).map((row: any) => String(row.workspace_id))), [integration]);
  const resourceWorkspaces = useMemo(() => workspaces.filter((workspace) => !mappedIds.has(workspace.id)), [workspaces, mappedIds]);
  const workspaceName = (id: string) => workspaces.find((workspace) => workspace.id === id)?.name || id;
  const workspaceLabel = (workspace: Workspace) => workspace.type ? `${workspace.name} · ${workspace.type}` : workspace.name;

  function patchProfile(id: string, patch: Partial<ResourceProfile>) {
    setProfiles((current) => current.map((profile) => profile.id === id ? { ...profile, ...patch } : profile));
    setSaved("");
  }

  function moveBay(profile: ResourceProfile, index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= profile.resourceIds.length) return;
    const resourceIds = [...profile.resourceIds];
    [resourceIds[index], resourceIds[target]] = [resourceIds[target], resourceIds[index]];
    patchProfile(profile.id, { resourceIds });
  }

  async function saveSetup() {
    setSaving("setup"); setSaved("");
    const response = await fetch("/api/external-bookings", { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: mapping?.workspace_id || "", ...setupDraft }) });
    const payload = await response.json().catch(() => ({})); setSaving("");
    if (!response.ok) return setIntegrationError(payload?.message || payload?.error || "Optix setup could not be saved.");
    setIntegration(payload.state); setIntegrationError(""); setSaved("Setup saved");
  }

  async function saveResources() {
    if (profiles.some((profile) => !profile.resourceIds.length)) return setResourceError("Every resource profile needs at least one bay.");
    const assigned = new Set<string>();
    for (const profile of profiles) for (const serviceId of profile.serviceIds) {
      const key = `${profile.handedness}:${serviceId}`;
      if (assigned.has(key)) return setResourceError("A lesson type can only use one profile for each handedness.");
      assigned.add(key);
    }
    const config = Object.fromEntries(services.map((service) => {
      const standard = profiles.find((profile) => profile.handedness === "standard" && profile.serviceIds.includes(service.id));
      const left = profiles.find((profile) => profile.handedness === "left" && profile.serviceIds.includes(service.id));
      return [service.id, { enabled: Boolean(standard || left), autoBook: resourceConfig[service.id]?.autoBook === true, leftHanded: false, preferredResourceIds: standard?.resourceIds || [], leftHandedResourceIds: left?.resourceIds || [] }];
    }));
    setSaving("resources"); setSaved("");
    const response = await fetch("/api/optix-booking-type-settings", { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ profiles, config: { ...resourceConfig, ...config } }) });
    const payload = await response.json().catch(() => ({})); setSaving("");
    if (!response.ok) return setResourceError(payload?.message || payload?.error || "Resource settings could not be saved.");
    setProfiles(payload.profiles || profiles); setResourceConfig(payload.config || config); setResourceError(""); setSaved("Resources saved");
  }

  async function processPending() {
    setReplaying(true); setReplayResult("");
    const since = new Date(Date.now() - replayDays * 86_400_000).toISOString();
    const response = await fetch("/api/external-bookings", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "process-pending", since }) });
    const payload = await response.json().catch(() => ({})); setReplaying(false);
    if (!response.ok) return setIntegrationError(payload?.message || payload?.error || "Pending events could not be processed.");
    setIntegration(payload.state); setIntegrationError("");
    const summary = Object.entries(payload.summary || {}).map(([key, value]) => `${key} ${value}`).join(" · ");
    setReplayResult(`Processed ${payload.attempted || 0} event${payload.attempted === 1 ? "" : "s"}${summary ? ` — ${summary}` : ""}.`);
  }

  async function retryEvent(eventKey: string) {
    const response = await fetch("/api/external-bookings", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "retry", eventKey }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return setIntegrationError(payload?.message || payload?.error || "Event retry failed.");
    setIntegration(payload.state); setIntegrationError("");
  }

  return (
    <article className="data-card settings-section settings-integrations optix-native-panel">
      <header className="optix-native-header">
        <div><span>Integration</span><h2>Optix</h2><p>Lesson mapping, bay resources, webhook data, and diagnostics.</p></div>
        <strong className={integrationError || resourceError ? "needs-attention" : ""}>{integrationError || resourceError ? "Needs attention" : "Ready"}</strong>
      </header>
      <div className="optix-native-tabs" role="tablist" aria-label="Optix settings">
        {(["setup", "resources", "passes", "feed", "diagnostics"] as Tab[]).map((value) => <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)} role="tab" aria-selected={tab === value} type="button">{value === "feed" ? "Data feed" : value[0].toUpperCase() + value.slice(1)}{value === "feed" && events.length ? <b>{events.length}</b> : null}{value === "passes" && passes.length ? <b>{passes.length}</b> : null}</button>)}
      </div>

      <div className="optix-native-body">
        {tab === "setup" ? <>
          {integrationError ? <div className="optix-native-error"><strong>Setup data is unavailable</strong>{integrationError}</div> : null}
          <div className="optix-native-note"><strong>Inbound Optix lessons</strong><span>{mapping ? `Workspace ${mapping.workspace_id}${workspaceName(String(mapping.workspace_id)) !== String(mapping.workspace_id) ? ` (${workspaceName(String(mapping.workspace_id))})` : ""} is recognised; every other workspace is ignored.` : "No workspace is mapped yet, so nothing is imported."} Every booking imports as the External Booking lesson type — its time comes from Optix, the Optix label goes in the lesson note, and the customer lands in the external booking clients list unless their email matches an existing client.</span></div>
          <div className="optix-native-grid">
            <label className="toggle"><input checked={setupDraft.enabled} onChange={(event) => setSetupDraft((draft) => ({ ...draft, enabled: event.target.checked }))} type="checkbox" /> Enable appointment creation</label>
            <label>Optix workspace<input readOnly value={mapping ? `${mapping.workspace_id}${workspaceName(String(mapping.workspace_id)) !== String(mapping.workspace_id) ? ` · ${workspaceName(String(mapping.workspace_id))}` : ""}` : "Not mapped"} /></label>
            <label>Lesson type<input readOnly value="External Booking (automatic)" /></label>
            <label>Clarity location<select disabled={!integration} value={setupDraft.locationId} onChange={(event) => setSetupDraft((draft) => ({ ...draft, locationId: event.target.value }))}><option value="">Select location</option>{(integration?.catalog?.locations || []).map((location) => <option key={location.id} value={location.id}>{location.name || location.id}</option>)}</select></label>
            <label>Default coach<select disabled={!integration} value={setupDraft.defaultCoachId} onChange={(event) => setSetupDraft((draft) => ({ ...draft, defaultCoachId: event.target.value }))}><option value="">No default coach</option>{(integration?.catalog?.coaches || []).map((coach) => <option key={coach.id} value={coach.id}>{coach.displayName || coach.name || coach.id}</option>)}</select></label>
            <label>Customer email<select value={setupDraft.emailBehaviour} onChange={(event) => setSetupDraft((draft) => ({ ...draft, emailBehaviour: event.target.value }))}><option value="none">No Clarity email</option><option value="immediate">Send immediately</option><option value="after_bay">Send after bay booking</option></select></label>
            <label>Bay booking<input readOnly value="Manual · Auto-book per lesson type (Resources tab)" /></label>
          </div>
          <div className="optix-native-actions"><button disabled={!integration || saving === "setup"} onClick={() => void saveSetup()} type="button">{saving === "setup" ? "Saving…" : "Save setup"}</button>{saved ? <span>{saved}</span> : null}</div>
        </> : null}

        {tab === "resources" ? <>
          {resourceError ? <div className="optix-native-error"><strong>Resource settings need attention</strong>{resourceError}</div> : null}
          <div className="optix-resource-heading"><div><h3>Bay resource profiles</h3><p>Set eligible bays and their booking priority for each Clarity lesson type.</p></div><button onClick={() => setProfiles((current) => [...current, newProfile(current.length + 1, resourceWorkspaces.map((workspace) => workspace.id))])} type="button">+ New profile</button></div>
          {profiles.map((profile) => <section className="optix-resource-profile" key={profile.id}>
            <div className="profile-title"><input aria-label="Profile name" value={profile.name} onChange={(event) => patchProfile(profile.id, { name: event.target.value })} /><select aria-label="Player handedness" value={profile.handedness} onChange={(event) => patchProfile(profile.id, { handedness: event.target.value === "left" ? "left" : "standard" })}><option value="standard">Standard / any player</option><option value="left">Left-handed players</option></select><button className="danger" disabled={profiles.length === 1} onClick={() => setProfiles((current) => current.filter((candidate) => candidate.id !== profile.id))} type="button">Delete</button></div>
            <div className="profile-columns"><div><h4>Bay priority</h4>{profile.resourceIds.map((id, index) => <div className="resource-row" key={id}><span>{index + 1}</span><strong>{workspaceName(id)}</strong><button aria-label={`Move ${workspaceName(id)} up`} disabled={index === 0} onClick={() => moveBay(profile, index, -1)} type="button">↑</button><button aria-label={`Move ${workspaceName(id)} down`} disabled={index === profile.resourceIds.length - 1} onClick={() => moveBay(profile, index, 1)} type="button">↓</button><button onClick={() => patchProfile(profile.id, { resourceIds: profile.resourceIds.filter((candidate) => candidate !== id) })} type="button">Remove</button></div>)}<div className="removed-resources">{resourceWorkspaces.filter((workspace) => !profile.resourceIds.includes(workspace.id)).map((workspace) => <button key={workspace.id} onClick={() => patchProfile(profile.id, { resourceIds: [...profile.resourceIds, workspace.id] })} title={workspaceLabel(workspace)} type="button">+ {workspace.name}</button>)}{resourceWorkspaces.length ? null : <em>No resources seen yet. A bay appears here the first time Optix sends a booking for it.</em>}</div></div>
              <div><h4>Lesson types</h4><div className="resource-services">{services.length ? services.map((service) => <label key={service.id}><input checked={profile.serviceIds.includes(service.id)} onChange={(event) => patchProfile(profile.id, { serviceIds: event.target.checked ? [...profile.serviceIds, service.id] : profile.serviceIds.filter((id) => id !== service.id) })} type="checkbox" />{service.name || service.id}</label>) : <p>Lesson types will appear when the Optix setup endpoint is available.</p>}</div></div></div>
          </section>)}
          <section className="optix-resource-profile">
            <div className="optix-resource-heading"><div><h3>Auto-book resource after client bookings</h3><p>Ticked lesson types get a bay booked automatically once a client booking lands on the calendar. Needs a resource profile above; if no bay is free the booking still goes ahead and the card shows no resource.</p></div></div>
            <div className="resource-services">{services.map((service) => <label key={service.id}><input checked={resourceConfig[service.id]?.autoBook === true} onChange={(event) => { const checked = event.target.checked; setResourceConfig((current) => ({ ...current, [service.id]: { ...(current[service.id] || {}), autoBook: checked } })); setSaved(""); }} type="checkbox" />{service.name || service.id}</label>)}</div>
          </section>
          <div className="optix-native-actions"><button disabled={saving === "resources" || Boolean(resourceError && !profiles.length)} onClick={() => void saveResources()} type="button">{saving === "resources" ? "Saving…" : "Save resources"}</button>{saved ? <span>{saved}</span> : null}</div>
        </> : null}

        {tab === "passes" ? <>
          {integrationError ? <div className="optix-native-error"><strong>Pass purchases are unavailable</strong>{integrationError}</div> : null}
          <div className="optix-feed-toolbar"><div><h3>Pass purchases</h3><p>Recorded from Optix payment webhooks, newest first.</p></div><button onClick={() => void loadIntegration()} type="button">Refresh</button></div>
          {purchases.length ? null : <div className="optix-native-note"><strong>Nothing recorded yet</strong><span>Subscribe to <code>new_sale</code> and <code>new_plan_subscription</code> in your Optix app — those are the only events that say what was bought. Sales are recorded as paid at purchase; <code>invoice_paid</code> carries nothing that can be tied to a sale.</span></div>}
          {passes.length ? passes.map((row) => <details className="optix-native-event" key={row.id}><summary><strong>{formatQuantity(row.quantity)}{row.item_name || "Pass"}</strong><span>{row.member_name || row.member_email || "No customer"}</span><time>{new Date(row.purchased_at).toLocaleString()}</time><em>{formatAmount(row)}</em></summary><div className="event-facts"><span>Event <b>{row.event_type}</b></span><span>Purchase ID <b>{row.external_purchase_id || "—"}</b></span><span>Sale # <b>{row.sale_number || "—"}</b></span><span>Paid <b>{row.paid_at ? new Date(row.paid_at).toLocaleString() : "—"}</b></span><span>Email <b>{row.member_email || "—"}</b></span><span>Client <b>{clientLabel(row)}</b></span></div><pre>{safeJson(row.rawPayload)}</pre></details>) : purchases.length ? <div className="optix-native-empty">No purchases have been classified as a Pass yet.</div> : null}
          {unclassified.length ? <>
            <div className="optix-feed-toolbar"><div><h3>Unclassified purchases</h3><p>Product sales whose name says neither "Lesson" nor "Pass" — bay top-ups like "1 x Extra Hour" belong here. If a lesson pass is in here, renaming the product in Optix is the fix.</p></div><button onClick={() => setShowUnclassified((current) => !current)} type="button">{showUnclassified ? "Hide" : `Show ${unclassified.length}`}</button></div>
            {showUnclassified ? unclassified.map((row) => <details className="optix-native-event" key={row.id}><summary><strong>{formatQuantity(row.quantity)}{row.item_name || "Unnamed purchase"}</strong><span>{row.member_name || row.member_email || "No customer"}</span><time>{new Date(row.purchased_at).toLocaleString()}</time><em>{formatAmount(row)}</em></summary><pre>{safeJson(row.rawPayload)}</pre></details>) : null}
          </> : null}
        </> : null}

        {tab === "feed" ? <>{integrationError ? <div className="optix-native-error"><strong>Webhook feed is unavailable</strong>{integrationError}</div> : null}<div className="optix-feed-toolbar"><div><h3>Received Optix data</h3><p>Protected raw webhook records, newest first.</p></div><button onClick={() => void loadIntegration()} type="button">Refresh</button></div>
          {pending.count ? <div className="optix-pending-bar"><div><strong>{pending.count} event{pending.count === 1 ? "" : "s"} waiting</strong><span>Oldest {pending.oldest ? new Date(pending.oldest).toLocaleDateString() : "—"}. Bookings only reach the calendar once these are processed.</span></div><label>Replay the last<select value={replayDays} onChange={(event) => setReplayDays(Number(event.target.value))}><option value={1}>24 hours</option><option value={7}>7 days</option><option value={30}>30 days</option><option value={365}>everything</option></select></label><button disabled={replaying} onClick={() => void processPending()} type="button">{replaying ? "Processing…" : "Process pending"}</button></div> : null}
          {replayResult ? <div className="optix-native-note"><strong>Replay finished</strong><span>{replayResult}</span></div> : null}
          {events.length ? events.map((event) => <details className="optix-native-event" key={event.event_key} open={event.processing_status === "failed"}><summary><strong>{event.event_type || "Unknown event"}</strong><span>{event.customer || "No customer"}</span><time>{event.received_at ? new Date(event.received_at).toLocaleString() : ""}</time><em>{event.processing_status}</em></summary><div className="event-facts"><span>Workspace <b>{event.workspaceId || "—"}</b></span><span>Lesson ID <b>{event.external_booking_id || "—"}</b></span><span>Appointment <b>{event.clarity_item_id || "Not created"}</b></span><span>Bay ID <b>{event.outboundBayBookingId || "Not booked"}</b></span></div>{event.error_message ? <div className="optix-native-error"><strong>{event.failure_code || "Processing error"}</strong>{event.error_message}</div> : null}<pre>{safeJson(event.rawPayload)}</pre>{UNPROCESSED.includes(event.processing_status) ? <button onClick={() => void retryEvent(event.event_key)} type="button">{event.processing_status === "failed" ? "Retry this event" : "Process this event"}</button> : null}</details>) : <div className="optix-native-empty">No webhook events have been received yet.</div>}</> : null}

        {tab === "diagnostics" ? <><div className="optix-stat-grid"><div><span>Received</span><strong>{events.length}</strong></div><div><span>Processed</span><strong>{events.filter((event) => event.processing_status === "processed").length}</strong></div><div><span>Ignored</span><strong>{events.filter((event) => event.processing_status === "ignored").length}</strong></div><div><span>Failed</span><strong>{failedCount}</strong></div></div><div className="optix-diagnostic-list"><p><span>Inbound endpoint</span><code>/api/optix-webhook</code></p><p><span>Settings/feed endpoint</span><code>{integrationError || "Connected"}</code></p><p><span>Resource endpoint</span><code>{resourceError || "Connected"}</code></p><p><span>Mapping</span><code>{mapping ? `${mapping.workspace_id} · ${mapping.enabled ? "enabled" : "disabled"}` : "Unavailable"}</code></p><p><span>Bay booking</span><code>Manual · auto-book per lesson type</code></p><p><span>Waiting to process</span><code>{pending.count ? `${pending.count} event${pending.count === 1 ? "" : "s"}` : "None"}</code></p></div></> : null}
      </div>
    </article>
  );
}
