const OPTIX_RECONCILE_PATH = "/api/optix-booking-reconcile";
const OPTIX_RECONCILE_EVENT = "clarity:optix-reconcile-complete";

const BOOKING_MUTATION_PATHS = [
  /^\/api\/calendar-state(?:\/|$)/,
  /^\/api\/public-booking(?:\/|$)/,
  /^\/api\/public-reschedule(?:\/|$)/,
  /^\/api\/public-cancel(?:\/|$)/,
  /^\/api\/booking(?:\/|$)/,
];

function requestMethod(input: RequestInfo | URL, init?: RequestInit) {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

function requestPath(input: RequestInfo | URL) {
  try {
    const value = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    return new URL(value, window.location.origin).pathname;
  } catch {
    return "";
  }
}

function isBookingMutation(input: RequestInfo | URL, init?: RequestInit) {
  const method = requestMethod(input, init);
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return false;
  const path = requestPath(input);
  if (!path || path === OPTIX_RECONCILE_PATH || path.startsWith("/api/optix-booking-status")) return false;
  return BOOKING_MUTATION_PATHS.some((pattern) => pattern.test(path));
}

async function readPayload(response: Response) {
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
}

async function triggerOptixSync(nativeFetch: typeof window.fetch) {
  const response = await nativeFetch(OPTIX_RECONCILE_PATH, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "booking-mutation" }),
  });
  const payload = await readPayload(response);

  window.dispatchEvent(new CustomEvent(OPTIX_RECONCILE_EVENT, {
    detail: {
      ok: response.ok,
      status: response.status,
      payload,
    },
  }));

  if (!response.ok) {
    const message = String(payload?.message || payload?.error || `Optix request failed (${response.status})`);
    throw new Error(message);
  }

  return payload;
}

/**
 * Runs the dedicated Optix resource-booking function immediately after a
 * successful Clarity booking mutation. The booking request is not reported as
 * complete until Optix has returned success or a concrete failure response.
 * Scheduled reconciliation remains a background repair mechanism only.
 */
export function installOptixBookingMutationSync() {
  if (typeof window === "undefined") return;
  const marker = "__clarityOptixMutationSyncInstalled";
  const markedWindow = window as typeof window & Record<string, unknown>;
  if (markedWindow[marker]) return;
  markedWindow[marker] = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const shouldSync = isBookingMutation(input, init);
    const response = await nativeFetch(input, init);

    if (shouldSync && response.ok) {
      try {
        await triggerOptixSync(nativeFetch);
      } catch (error) {
        console.error("Optix resource booking failed", error);
      }
    }

    return response;
  };
}
