type OptixGraphQLError = {
  message?: string;
  extensions?: Record<string, unknown>;
};

type OptixGraphQLResponse<T> = {
  data?: T;
  errors?: OptixGraphQLError[];
};

export type OptixSyncFailureCode =
  | "not_configured"
  | "token_expired"
  | "unauthorized"
  | "resource_conflict"
  | "validation_failed"
  | "timeout"
  | "remote_error";

export class OptixSyncError extends Error {
  readonly code: OptixSyncFailureCode;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(
    code: OptixSyncFailureCode,
    message: string,
    options: { status?: number | null; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "OptixSyncError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
}

export type OptixBookingIdentity = {
  memberId: string;
  ownerUserId: string;
};

export type OptixBookingInput = OptixBookingIdentity & {
  bookingId?: string | null;
  bookingSessionId?: string | null;
  resourceIds: string[];
  startTimestamp: number;
  endTimestamp: number;
  externalId: string;
  title?: string;
  notes?: string;
  source?: string;
  isCanceled?: boolean;
};

export type OptixBookingResult = {
  bookingId: string | null;
  bookingSessionId: string | null;
  raw: unknown;
};

type OptixClientConfig = {
  endpoint: string;
  token: string;
  tokenKind: "organization" | "personal";
};

const OPTIX_REQUEST_TIMEOUT_MS = 12_000;

const BOOKINGS_DRAFT = `
  query OptixBookingsDraft($input: BookingSetInput!) {
    bookingsDraft(input: $input) {
      booking_session_id
      bookings { booking_id }
    }
  }
`;

const BOOKINGS_COMMIT = `
  mutation OptixBookingsCommit($input: BookingSetInput!) {
    bookingsCommit(input: $input) {
      booking_session_id
      bookings { booking_id }
    }
  }
`;

function readEnv(name: string): string {
  return (globalThis.Netlify?.env?.get(name) || process.env[name] || "").trim();
}

export function getOptixClientConfig(): OptixClientConfig {
  const endpoint = readEnv("OPTIX_GRAPHQL_ENDPOINT") || "https://api.optixapp.com/graphql";
  const organizationToken = readEnv("OPTIX_ORGANIZATION_TOKEN");
  const personalToken = readEnv("OPTIX_PERSONAL_TOKEN");
  const token = organizationToken || personalToken;
  const tokenKind = organizationToken ? "organization" : "personal";

  if (!token) {
    throw new OptixSyncError(
      "not_configured",
      "Optix is not configured. Set exactly one of OPTIX_ORGANIZATION_TOKEN or OPTIX_PERSONAL_TOKEN, " +
        "and OPTIX_OWNER_USER_ID for the user the bookings belong to.",
    );
  }

  // Set one token, not both. Which credential is in use decides how Optix reads
  // the request, so leaving a stale second one configured means the behaviour
  // depends on this precedence rule rather than on anything visible in the
  // environment. Say so rather than silently picking.
  if (organizationToken && personalToken) {
    console.warn("optix_client:both_tokens_configured", {
      using: "OPTIX_ORGANIZATION_TOKEN",
      ignored: "OPTIX_PERSONAL_TOKEN",
      hint: "Withhold the token you are not using so the active credential is unambiguous.",
    });
  }

  return { endpoint, token, tokenKind };
}

function normaliseMessages(errors: OptixGraphQLError[] | undefined): string {
  return (errors || [])
    .map((error) => {
      const message = String(error?.message || "").trim();
      const code = String(error?.extensions?.code || error?.extensions?.errorCode || "").trim();
      return [code, message].filter(Boolean).join(": ");
    })
    .filter(Boolean)
    .join("; ");
}

function concise(value: string, max = 1200) {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

export function classifyOptixFailure(input: {
  status?: number | null;
  responseText?: string;
  graphQLErrors?: OptixGraphQLError[];
  requestId?: string;
  /** Which credential made the call, so an auth failure names what to fix. */
  tokenKind?: "organization" | "personal" | null;
}): OptixSyncError {
  const status = input.status ?? null;
  const message = concise([
    normaliseMessages(input.graphQLErrors),
    input.responseText,
  ].filter(Boolean).join("; "));
  const suffix = [status ? `HTTP ${status}` : "", input.requestId ? `request ${input.requestId}` : ""]
    .filter(Boolean)
    .join(", ");
  const detailed = [message, suffix ? `(${suffix})` : ""].filter(Boolean).join(" ");
  const lower = message.toLowerCase();
  // Optix's own wording never says which credential Clarity used, and the two
  // are configured separately -- so an auth failure that does not name the
  // variable leaves the admin guessing which one to replace.
  const credential = input.tokenKind === "personal"
    ? "OPTIX_PERSONAL_TOKEN"
    : input.tokenKind === "organization"
      ? "OPTIX_ORGANIZATION_TOKEN"
      : "OPTIX_ORGANIZATION_TOKEN or OPTIX_PERSONAL_TOKEN";
  const withCredential = (text: string) => `${text} Check ${credential}.`;

  if (
    status === 401 ||
    lower.includes("token expired") ||
    lower.includes("expired token") ||
    lower.includes("invalid token") ||
    lower.includes("access token has expired") ||
    lower.includes("jwt expired")
  ) {
    return new OptixSyncError(
      "token_expired",
      withCredential(detailed || "The Optix access token has expired or is no longer valid."),
      { status, retryable: true },
    );
  }

  // "Your user account is not allowed to make bookings" is a permissions
  // problem, but it says neither "unauthorized" nor "forbidden", so it read as a
  // generic remote error and gave no hint that the Optix account is the thing
  // to fix.
  if (
    status === 403 ||
    lower.includes("unauthorized") ||
    lower.includes("not authorised") ||
    lower.includes("not allowed") ||
    lower.includes("forbidden")
  ) {
    return new OptixSyncError(
      "unauthorized",
      withCredential(detailed || "Optix rejected this account or booking action."),
      { status, retryable: false },
    );
  }

  // Optix words a busy bay as "The resource is not available during the selected
  // times" -- no "unavailable" anywhere in it, so this fell through to
  // remote_error. That is not cosmetic: the auto-select loop only advances to
  // the next bay on resource_conflict, so a misread conflict stopped the search
  // at the first bay and reported failure with every other configured bay
  // untried. Status-guarded so a 5xx "service not available" stays a remote
  // error rather than being mistaken for a busy bay.
  const busyResource = /\bnot available\b/.test(lower) && status !== null && status < 500;

  if (
    busyResource ||
    lower.includes("unavailable") ||
    lower.includes("already booked") ||
    lower.includes("conflict") ||
    lower.includes("overlap")
  ) {
    return new OptixSyncError("resource_conflict", detailed || "The Optix resource is no longer available for this time.", { status, retryable: false });
  }

  if (status === 400 || lower.includes("validation") || lower.includes("invalid input")) {
    return new OptixSyncError("validation_failed", detailed || "Optix rejected the booking input.", { status, retryable: false });
  }

  return new OptixSyncError("remote_error", detailed || "Optix returned an empty or unrecognised response.", {
    status,
    retryable: status === null || status >= 500,
  });
}

async function optixGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  config: OptixClientConfig,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPTIX_REQUEST_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new OptixSyncError(
        "timeout",
        `Optix did not respond within ${Math.round(OPTIX_REQUEST_TIMEOUT_MS / 1000)} seconds. No bay booking was confirmed.`,
        { retryable: true, cause: error },
      );
    }
    throw new OptixSyncError(
      "remote_error",
      `Could not reach Optix: ${error instanceof Error ? error.message : "network request failed"}.`,
      { retryable: true, cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text();
  let payload: OptixGraphQLResponse<T> | null = null;
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch {
    payload = null;
  }

  if (!response.ok || payload?.errors?.length || !payload?.data) {
    throw classifyOptixFailure({
      status: response.status,
      responseText: payload ? "" : responseText,
      graphQLErrors: payload?.errors,
      requestId: response.headers.get("x-request-id") || response.headers.get("request-id") || "",
      tokenKind: config.tokenKind,
    });
  }

  return payload.data;
}

export function buildBookingSetInput(input: OptixBookingInput, tokenKind?: OptixClientConfig["tokenKind"]) {
  if (!input.externalId.trim()) {
    throw new OptixSyncError("validation_failed", "An Optix external ID is required.");
  }
  if (!input.resourceIds.length) {
    throw new OptixSyncError("validation_failed", "At least one Optix resource ID is required.");
  }
  if (!input.isCanceled && input.endTimestamp <= input.startTimestamp) {
    throw new OptixSyncError("validation_failed", "The Optix booking end time must be after its start time.");
  }

  if (!input.memberId && !input.ownerUserId) {
    throw new OptixSyncError(
      "not_configured",
      "Optix needs an identity for the booking. Set OPTIX_MEMBER_ID or OPTIX_OWNER_USER_ID.",
    );
  }

  const title = input.title || "Clarity Booking";
  return {
    ...(input.bookingSessionId ? { booking_session_id: input.bookingSessionId } : {}),
    // Each identity is sent only when it is configured, so exactly one can be
    // supplied and the other withheld. member_id used to go on every request
    // even when unset, and owner_user_id was tied to the token kind, so the
    // combination that Optix accepts -- one id, not both -- could not be
    // expressed no matter what the environment said.
    ...(input.memberId ? { account: { member_id: input.memberId } } : {}),
    ...(input.ownerUserId ? { owner_user_id: input.ownerUserId } : {}),
    source: input.source || "Clarity Booking",
    title,
    // Keep the Optix note intentionally simple: only the person on the
    // corresponding Clarity booking.
    notes: title,
    bookings: [
      {
        ...(input.bookingId ? { booking_id: input.bookingId } : {}),
        start_timestamp: input.startTimestamp,
        end_timestamp: input.endTimestamp,
        resource_id: input.resourceIds,
        external_id: input.externalId,
        ...(input.isCanceled ? { is_canceled: true } : {}),
      },
    ],
  };
}

function readBookingResult(payload: any): OptixBookingResult {
  const bookingSet = payload?.bookingsDraft || payload?.bookingsCommit || null;
  return {
    bookingId: bookingSet?.bookings?.[0]?.booking_id ? String(bookingSet.bookings[0].booking_id) : null,
    bookingSessionId: bookingSet?.booking_session_id ? String(bookingSet.booking_session_id) : null,
    raw: bookingSet,
  };
}

export async function draftOptixBooking(input: OptixBookingInput): Promise<OptixBookingResult> {
  const config = getOptixClientConfig();
  const data = await optixGraphQL<any>(BOOKINGS_DRAFT, {
    input: buildBookingSetInput(input, config.tokenKind),
  }, config);
  return readBookingResult(data);
}

export async function commitOptixBooking(input: OptixBookingInput): Promise<OptixBookingResult> {
  const config = getOptixClientConfig();
  const data = await optixGraphQL<any>(BOOKINGS_COMMIT, {
    input: buildBookingSetInput(input, config.tokenKind),
  }, config);
  return readBookingResult(data);
}

export async function syncOptixBooking(input: OptixBookingInput): Promise<OptixBookingResult> {
  const draft = await draftOptixBooking(input);
  return commitOptixBooking({
    ...input,
    bookingSessionId: draft.bookingSessionId || input.bookingSessionId,
  });
}
