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
  personalToken: string;
};

const BOOKINGS_DRAFT = `
  query OptixBookingsDraft($input: BookingSetInput!) {
    bookingsDraft(input: $input) {
      booking_session_id
      bookings {
        booking_id
      }
    }
  }
`;

const BOOKINGS_COMMIT = `
  mutation OptixBookingsCommit($input: BookingSetInput!) {
    bookingsCommit(input: $input) {
      booking_session_id
      bookings {
        booking_id
      }
    }
  }
`;

function readEnv(name: string): string {
  return (
    globalThis.Netlify?.env?.get(name) ||
    process.env[name] ||
    ""
  ).trim();
}

export function getOptixClientConfig(): OptixClientConfig {
  const endpoint = readEnv("OPTIX_GRAPHQL_ENDPOINT") || "https://api.optixapp.com/graphql";
  const personalToken = readEnv("OPTIX_PERSONAL_TOKEN");

  if (!personalToken) {
    throw new OptixSyncError(
      "not_configured",
      "Optix is not configured. Add OPTIX_PERSONAL_TOKEN in the server environment.",
    );
  }

  return { endpoint, personalToken };
}

function normaliseMessages(errors: OptixGraphQLError[] | undefined): string {
  return (errors || [])
    .map((error) => String(error?.message || "").trim())
    .filter(Boolean)
    .join("; ");
}

export function classifyOptixFailure(input: {
  status?: number | null;
  responseText?: string;
  graphQLErrors?: OptixGraphQLError[];
}): OptixSyncError {
  const status = input.status ?? null;
  const message = [input.responseText, normaliseMessages(input.graphQLErrors)]
    .filter(Boolean)
    .join("; ")
    .trim();
  const lower = message.toLowerCase();

  const tokenExpired =
    status === 401 ||
    lower.includes("token expired") ||
    lower.includes("expired token") ||
    lower.includes("invalid token") ||
    lower.includes("access token has expired") ||
    lower.includes("jwt expired");

  if (tokenExpired) {
    return new OptixSyncError(
      "token_expired",
      "The Optix personal token has expired or is no longer valid. Replace OPTIX_PERSONAL_TOKEN and retry the sync.",
      { status, retryable: true },
    );
  }

  if (status === 403 || lower.includes("unauthorized") || lower.includes("not authorised") || lower.includes("forbidden")) {
    return new OptixSyncError(
      "unauthorized",
      "Optix rejected this account or booking action. Check the personal token, member ID and owner user ID.",
      { status, retryable: false },
    );
  }

  if (
    lower.includes("unavailable") ||
    lower.includes("already booked") ||
    lower.includes("conflict") ||
    lower.includes("overlap")
  ) {
    return new OptixSyncError(
      "resource_conflict",
      "The Optix resource is no longer available for this time.",
      { status, retryable: false },
    );
  }

  if (status === 400 || lower.includes("validation")) {
    return new OptixSyncError(
      "validation_failed",
      message || "Optix rejected the booking input.",
      { status, retryable: false },
    );
  }

  return new OptixSyncError(
    "remote_error",
    message || "Optix could not complete the booking request.",
    { status, retryable: status === null || status >= 500 },
  );
}

async function optixGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  config = getOptixClientConfig(),
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.personalToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (error) {
    throw new OptixSyncError("remote_error", "Could not reach Optix.", {
      retryable: true,
      cause: error,
    });
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
    });
  }

  return payload.data;
}

function buildBookingSetInput(input: OptixBookingInput) {
  if (!input.externalId.trim()) {
    throw new OptixSyncError("validation_failed", "An Optix external ID is required.");
  }
  if (!input.resourceIds.length) {
    throw new OptixSyncError("validation_failed", "At least one Optix resource ID is required.");
  }
  if (!input.isCanceled && input.endTimestamp <= input.startTimestamp) {
    throw new OptixSyncError("validation_failed", "The Optix booking end time must be after its start time.");
  }

  return {
    ...(input.bookingSessionId ? { booking_session_id: input.bookingSessionId } : {}),
    account: { member_id: input.memberId },
    owner_user_id: input.ownerUserId,
    source: input.source || "Clarity Booking",
    title: input.title || "Clarity Booking",
    notes: input.notes || undefined,
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
  const data = await optixGraphQL<any>(BOOKINGS_DRAFT, {
    input: buildBookingSetInput(input),
  });
  return readBookingResult(data);
}

export async function commitOptixBooking(input: OptixBookingInput): Promise<OptixBookingResult> {
  const data = await optixGraphQL<any>(BOOKINGS_COMMIT, {
    input: buildBookingSetInput(input),
  });
  return readBookingResult(data);
}

export async function syncOptixBooking(input: OptixBookingInput): Promise<OptixBookingResult> {
  const draft = await draftOptixBooking(input);
  return commitOptixBooking({
    ...input,
    bookingSessionId: draft.bookingSessionId || input.bookingSessionId,
  });
}
