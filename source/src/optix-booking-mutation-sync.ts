const OPTIX_RECONCILE_PATH = "/api/optix-booking-reconcile";

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

async function triggerOptixSync(nativeFetch: typeof window.fetch) {
  try {
    await nativeFetch(OPTIX_RECONCILE_PATH, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "booking-mutation" }),
    });
  } catch (error) {
    console.warn("Optix booking sync trigger failed", error);
  }
}

/**
 * Runs Optix reconciliation immediately after a successful booking mutation.
 * This is installed for both the admin calendar and the public/client booking
 * route. It adds no client-facing UI; the result remains visible only in the
 * admin appointment drawer.
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
    if (shouldSync && response.ok) void triggerOptixSync(nativeFetch);
    return response;
  };
}
