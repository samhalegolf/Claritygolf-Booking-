import { useEffect, useState } from "react";
import { Check, Copy, RefreshCw, Send } from "lucide-react";

/**
 * Settings › Booking › Bay & room system.
 *
 * A guide as much as a form: connecting another booking system means someone
 * on the venue's side building a small endpoint, so the screen shows them the
 * exact messages Clarity sends and the exact replies it expects, then lets
 * them test it. The formats come from the server (resource-webhook.mts), so
 * what is documented here is what is sent.
 *
 * Optix appears only for a business that already uses it.
 */

type Sample = Record<string, unknown>;

type ResourceSystemState = {
  provider: "optix" | "webhook";
  optixAvailable: boolean;
  url: string;
  enabled: boolean;
  hasSecret: boolean;
  secretHint: string;
  inboundUrl: string;
  timeoutSeconds: number;
  samples: { hold: Sample; move: Sample; release: Sample };
  replies: { hold: Sample; unavailable: Sample };
  secret?: string;
};

type SampleKey = "hold" | "move" | "release";

const SAMPLE_LABELS: Record<SampleKey, string> = { hold: "Hold", move: "Move", release: "Release" };

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="outline-button compact-button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        });
      }}
      type="button"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "Copied" : label}
    </button>
  );
}

export function ResourceSystemPanel({ canEdit }: { canEdit: boolean }) {
  const [state, setState] = useState<ResourceSystemState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [url, setUrl] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<"optix" | "webhook">("webhook");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");
  const [freshSecret, setFreshSecret] = useState("");
  const [sample, setSample] = useState<SampleKey>("hold");
  const [test, setTest] = useState<{ state: "idle" | "sending" | "done"; ok?: boolean; message?: string }>({
    state: "idle",
  });

  function apply(next: ResourceSystemState) {
    setState(next);
    setUrl(next.url);
    setEnabled(next.enabled);
    setProvider(next.provider);
    if (next.secret) setFreshSecret(next.secret);
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/resource-webhook-settings", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.message || "Could not load the bay system settings.");
        if (!cancelled) apply(data as ResourceSystemState);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Could not load.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function send(method: "PUT" | "POST", body: Record<string, unknown>) {
    const response = await fetch("/api/resource-webhook-settings", {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.message || "That didn't save.");
    return data;
  }

  async function save() {
    setSaveState("saving");
    setMessage("");
    try {
      apply(await send("PUT", { url, enabled, provider }));
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 1600);
    } catch (error) {
      setSaveState("error");
      setMessage(error instanceof Error ? error.message : "That didn't save.");
    }
  }

  async function rotate() {
    if (state?.hasSecret && !window.confirm("Make a new secret? Your system must switch to it, or Clarity's requests will fail its check.")) {
      return;
    }
    try {
      apply(await send("POST", { action: "rotate-secret" }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not make a new secret.");
    }
  }

  async function runTest() {
    setTest({ state: "sending" });
    try {
      const response = await fetch("/api/resource-webhook-settings", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test" }),
      });
      const data = await response.json().catch(() => ({}));
      setTest({ state: "done", ok: data?.ok === true, message: data?.message || "No answer." });
    } catch {
      setTest({ state: "done", ok: false, message: "Could not reach Clarity." });
    }
  }

  if (loadError) return <p className="workspace-save-error">{loadError}</p>;
  if (!state) return <p className="field-help">Loading…</p>;

  const usingOptix = provider === "optix";
  const connected = usingOptix || (state.enabled && Boolean(state.url) && state.hasSecret);

  return (
    <div className="resource-system">
      <div className="resource-system-status">
        <span className={`resource-system-dot ${connected ? "is-on" : ""}`} aria-hidden="true" />
        <strong>
          {usingOptix
            ? "Using Optix"
            : connected
              ? "Connected to your booking system"
              : "Not connected"}
        </strong>
        <small>
          {usingOptix
            ? "Bays are held in Optix, set up per lesson type under Integrations."
            : "Clarity asks your system to hold, move and release a bay for each lesson that needs one."}
        </small>
      </div>

      {state.optixAvailable ? (
        <div className="resource-system-choice" role="radiogroup" aria-label="Which system keeps your bays">
          {(
            [
              ["optix", "Optix", "Ready-made connection. Already set up for this business."],
              ["webhook", "Your own system", "Any software that can answer a web request."],
            ] as const
          ).map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={provider === value}
              className={`resource-system-option ${provider === value ? "is-selected" : ""}`}
              onClick={() => setProvider(value)}
              disabled={!canEdit}
            >
              <strong>{label}</strong>
              <small>{hint}</small>
            </button>
          ))}
        </div>
      ) : null}

      {!usingOptix ? (
        <ol className="resource-system-steps">
          <li>
            <strong>Choose which bookings need a bay</strong>
            <p>
              In Locations, set <em>Who keeps track of them</em> to <em>Another booking system</em>. Then, on each
              lesson type that uses a bay there, tick <em>Holds one of the location's resources</em>.
            </p>
          </li>

          <li>
            <strong>Your system's address</strong>
            <p>Clarity sends a signed POST here every time a lesson needs a bay, moves or is cancelled.</p>
            <div className="resource-system-row">
              <input
                aria-label="Your system's webhook address"
                placeholder="https://your-system.example.com/clarity"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                disabled={!canEdit}
                inputMode="url"
              />
              <label className="settings-toggle">
                <input
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                  type="checkbox"
                  disabled={!canEdit}
                />
                <span>On</span>
              </label>
            </div>
          </li>

          <li>
            <strong>Check it's really Clarity</strong>
            <p>
              Every request carries <code>X-Clarity-Signature: t=&lt;time&gt;,v1=&lt;signature&gt;</code>. The
              signature is HMAC-SHA256 of <code>&lt;time&gt;.&lt;body&gt;</code> using this secret. Refuse requests
              that don't match or are more than five minutes old.
            </p>
            {freshSecret ? (
              <div className="resource-system-secret">
                <code>{freshSecret}</code>
                <CopyButton text={freshSecret} />
                <small>Shown once. Copy it into your system now.</small>
              </div>
            ) : (
              <div className="resource-system-row">
                <span className="field-help">
                  {state.hasSecret ? `Secret ending ${state.secretHint}` : "A secret is made when you first save an address."}
                </span>
                {canEdit && state.hasSecret ? (
                  <button className="outline-button compact-button" onClick={() => void rotate()} type="button">
                    <RefreshCw size={14} />
                    New secret
                  </button>
                ) : null}
              </div>
            )}
          </li>

          <li>
            <strong>What Clarity sends</strong>
            <p>
              The event is in the body and in <code>X-Clarity-Event</code>. Times include the location's offset.
            </p>
            <div className="resource-system-tabs" role="tablist" aria-label="Example request">
              {(Object.keys(SAMPLE_LABELS) as SampleKey[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={sample === key}
                  className={sample === key ? "is-selected" : ""}
                  onClick={() => setSample(key)}
                >
                  {SAMPLE_LABELS[key]}
                </button>
              ))}
            </div>
            <pre className="resource-system-code">{pretty(state.samples[sample])}</pre>
          </li>

          <li>
            <strong>What to reply</strong>
            <p>
              Reply within {state.timeoutSeconds} seconds. For a hold or a move, say which bay you held:
            </p>
            <pre className="resource-system-code">{pretty(state.replies.hold)}</pre>
            <p>or that none is free (the lesson then shows no bay, and the coach sees why):</p>
            <pre className="resource-system-code">{pretty(state.replies.unavailable)}</pre>
            <p>For a release, any 2xx reply is enough.</p>
          </li>

          <li>
            <strong>Changes on your side (optional)</strong>
            <p>
              If a bay is freed or swapped in your system, tell Clarity. Sign the request the same way and send
              <code> resource.released</code> or <code>resource.updated</code> with the Clarity <code>booking.id</code>.
            </p>
            <div className="resource-system-row">
              <code className="resource-system-url">{state.inboundUrl}</code>
              <CopyButton text={state.inboundUrl} />
            </div>
          </li>
        </ol>
      ) : null}

      {message ? (
        <p className="workspace-save-error" role="alert">
          {message}
        </p>
      ) : null}

      {canEdit ? (
        <div className="resource-system-actions">
          <button className="primary-button" disabled={saveState === "saving"} onClick={() => void save()} type="button">
            {saveState === "saving" ? "Saving" : saveState === "saved" ? "Saved" : "Save"}
          </button>
          {!usingOptix ? (
            <button
              className="outline-button"
              disabled={test.state === "sending" || !state.url || !state.hasSecret}
              onClick={() => void runTest()}
              type="button"
            >
              <Send size={15} />
              {test.state === "sending" ? "Sending…" : "Send a test"}
            </button>
          ) : null}
          {test.state === "done" ? (
            <span className={`resource-system-test ${test.ok ? "is-ok" : "is-failed"}`} role="status">
              {test.message}
            </span>
          ) : null}
        </div>
      ) : (
        <p className="field-help">Only an owner or admin can change this.</p>
      )}
    </div>
  );
}
