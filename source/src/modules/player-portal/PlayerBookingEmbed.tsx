import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * A slot in the player portal for a booking widget that isn't ours.
 *
 * The business configures one URL in Settings > Booking > "Player portal
 * booking widget"; the portal gives it a tab of its own, named by the business.
 * Nothing here knows or cares which provider it is.
 *
 * ## Why an iframe, and why sandboxed
 *
 * The alternative -- dropping the provider's `<script>` into the portal page --
 * would run third-party JavaScript in the same document as a signed-in
 * player's session: same origin, same cookies, same DOM. A booking widget does
 * not need any of that. The iframe puts the provider on its own origin, and the
 * sandbox list below is the smallest set that still lets a real booking
 * complete:
 *
 * - `allow-scripts` + `allow-forms`  -- it is an interactive booking form.
 * - `allow-same-origin`              -- the provider's own storage and cookies,
 *                                       which is how a booking survives a step.
 *                                       Scoped to *their* origin, not ours.
 * - `allow-popups` (+ `-to-escape-sandbox`) -- payment and OAuth steps open a
 *                                       window, and it must not inherit this
 *                                       sandbox or the payment page breaks.
 *
 * Deliberately absent: `allow-top-navigation`. Without it the framed page
 * cannot navigate the portal out from under the player.
 *
 * ## If a provider only gives you a <script> snippet
 *
 * Extend, don't switch. Keep the iframe and give it a `srcdoc` holding a
 * minimal HTML document that loads the snippet, so the provider's JS still runs
 * on an opaque origin instead of on ours. That needs a second setting (the
 * snippet body) and `allow-same-origin` dropped from the list above -- a
 * srcdoc frame with `allow-same-origin` inherits the *parent's* origin, which
 * would hand the provider the portal's session, exactly what this avoids.
 */

const SANDBOX = [
  "allow-scripts",
  "allow-forms",
  "allow-same-origin",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
].join(" ");

export type PlayerBookingEmbedConfig = {
  url: string;
  label: string;
  intro: string;
  height: number;
};

/** Empty/misconfigured reads as "no widget" everywhere, including the nav. */
export function isPlayerBookingEmbedConfigured(
  config: PlayerBookingEmbedConfig | null | undefined,
): config is PlayerBookingEmbedConfig {
  return Boolean(config?.url);
}

/** The height a provider's resize message is allowed to ask for. */
const MIN_HEIGHT = 320;
const MAX_HEIGHT = 4000;

/**
 * A resize height out of a provider's postMessage, or 0 if this message is not
 * one. Providers disagree on the shape -- Calendly nests it, Acuity and others
 * send a bare number or a `{height}` -- so this reads the common ones and
 * ignores everything else rather than trying to be a parser for all of them.
 */
function resizeHeightFromMessage(data: unknown): number {
  const candidate =
    typeof data === "number"
      ? data
      : typeof data === "string"
        ? Number(data.replace(/[^0-9.]/g, ""))
        : typeof data === "object" && data !== null
          ? (data as Record<string, unknown>).height ??
            (data as Record<string, unknown>).scrollHeight ??
            ((data as Record<string, unknown>).payload as Record<string, unknown> | undefined)?.height
          : 0;
  const height = Number(candidate);
  if (!Number.isFinite(height) || height <= 0) return 0;
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(height)));
}

export function PlayerBookingEmbed({ config }: { config: PlayerBookingEmbedConfig }) {
  const [loaded, setLoaded] = useState(false);
  const [height, setHeight] = useState(config.height);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // The one origin allowed to resize this frame. A malformed URL never reaches
  // here (the server rejects it), but the config can change under us, so this
  // is derived rather than assumed.
  const origin = useMemo(() => {
    try {
      return new URL(config.url).origin;
    } catch {
      return "";
    }
  }, [config.url]);

  // A new URL is a different widget: start again rather than showing the old
  // one's height around the new one's first paint.
  useEffect(() => {
    setLoaded(false);
    setHeight(config.height);
  }, [config.url, config.height]);

  useEffect(() => {
    if (!origin) return;
    const onMessage = (event: MessageEvent) => {
      // Origin first, and before anything reads the payload. Any page in any
      // tab can postMessage at this window; only the widget we framed gets to
      // change its own size.
      if (event.origin !== origin) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      const next = resizeHeightFromMessage(event.data);
      if (next) setHeight(next);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin]);

  const openInTab = useCallback(() => {
    window.open(config.url, "_blank", "noopener,noreferrer");
  }, [config.url]);

  return (
    <section className="player-portal-section player-booking-embed">
      {config.intro && <p className="player-portal-lead">{config.intro}</p>}

      <div className="player-booking-embed-frame" style={{ height: `${height}px` }}>
        {!loaded && (
          <p className="player-portal-empty player-booking-embed-loading">Loading booking…</p>
        )}
        <iframe
          ref={frameRef}
          src={config.url}
          title={config.label}
          sandbox={SANDBOX}
          loading="lazy"
          // The provider gets the venue's own booking page, not the player's
          // identity: a full referrer would leak the portal URL, and that
          // carries nothing they need.
          referrerPolicy="strict-origin"
          onLoad={() => setLoaded(true)}
        />
      </div>

      {/* Some providers refuse to be framed at all (X-Frame-Options), and the
          frame then goes blank with no event we can catch. This is always here
          so there is a way through even in that case. */}
      <div className="player-booking-embed-escape">
        <button className="player-portal-ghost" type="button" onClick={openInTab}>
          Open booking in a new tab ↗
        </button>
      </div>
    </section>
  );
}

export default PlayerBookingEmbed;
