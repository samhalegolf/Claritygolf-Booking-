/**
 * What each external booking source can actually do.
 *
 * The UI and the reschedule route both read this instead of assuming every
 * provider behaves alike. A capability is false until the code to honour it
 * exists and the data it needs is on hand -- claiming one Clarity cannot
 * deliver is how the two systems end up silently disagreeing.
 */

export type ExternalProvider = "optix" | "google_calendar" | "acuity" | "setmore";

export type ExternalSourceType = "api" | "calendar";

export type ProviderCapabilities = {
  sourceType: ExternalSourceType;
  label: string;
  createExternally: boolean;
  rescheduleExternally: boolean;
  cancelExternally: boolean;
  receiveCreatedEvents: boolean;
  receiveUpdatedEvents: boolean;
  receiveCancelledEvents: boolean;
  /** Why a write capability is off, shown to the admin instead of a dead end. */
  writeBlockedReason?: string;
};

const OPTIX_WRITE_BLOCKED =
  "Optix booking webhooks do not include the member ID or resource ID, and both are required to change a booking through the Optix API. Reschedule the lesson in Optix.";

const CAPABILITIES: Record<ExternalProvider, ProviderCapabilities> = {
  optix: {
    sourceType: "api",
    label: "Optix",
    // Clarity does create Optix *bay* bookings, but that is a resource booking
    // against a Clarity-owned lesson, not creating a booking Optix owns.
    createExternally: false,
    rescheduleExternally: false,
    cancelExternally: false,
    receiveCreatedEvents: true,
    receiveUpdatedEvents: true,
    receiveCancelledEvents: true,
    writeBlockedReason: OPTIX_WRITE_BLOCKED,
  },
  google_calendar: {
    sourceType: "calendar",
    label: "Google Calendar",
    createExternally: false,
    rescheduleExternally: false,
    cancelExternally: false,
    receiveCreatedEvents: false,
    receiveUpdatedEvents: false,
    receiveCancelledEvents: false,
    writeBlockedReason: "No Google Calendar import adapter is connected yet.",
  },
  acuity: {
    sourceType: "calendar",
    label: "Acuity",
    createExternally: false,
    rescheduleExternally: false,
    cancelExternally: false,
    receiveCreatedEvents: false,
    receiveUpdatedEvents: false,
    receiveCancelledEvents: false,
    writeBlockedReason: "No Acuity adapter is connected yet.",
  },
  setmore: {
    sourceType: "calendar",
    label: "Setmore",
    createExternally: false,
    rescheduleExternally: false,
    cancelExternally: false,
    receiveCreatedEvents: false,
    receiveUpdatedEvents: false,
    receiveCancelledEvents: false,
    writeBlockedReason: "No Setmore adapter is connected yet.",
  },
};

const UNKNOWN_PROVIDER: ProviderCapabilities = {
  sourceType: "api",
  label: "the booking system it came from",
  createExternally: false,
  rescheduleExternally: false,
  cancelExternally: false,
  receiveCreatedEvents: false,
  receiveUpdatedEvents: false,
  receiveCancelledEvents: false,
  writeBlockedReason: "Clarity does not have an adapter for this booking source.",
};

export function isExternalProvider(value: unknown): value is ExternalProvider {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CAPABILITIES, value);
}

export function providerCapabilities(provider: unknown): ProviderCapabilities {
  return isExternalProvider(provider) ? CAPABILITIES[provider] : UNKNOWN_PROVIDER;
}

/** The whole map, for the calendar payload so the UI never hard-codes a provider. */
export function allProviderCapabilities(): Record<string, ProviderCapabilities> {
  return { ...CAPABILITIES };
}

export type ExternalWriteCheck =
  | { allowed: true; capabilities: ProviderCapabilities }
  | { allowed: false; capabilities: ProviderCapabilities; code: string; message: string };

/**
 * Whether Clarity may move this booking itself. Refusing is the correct answer
 * when it cannot: applying the change locally would leave the external system
 * still holding the original time, which is the drift the whole external
 * booking design exists to prevent.
 */
export function canRescheduleExternally(provider: unknown): ExternalWriteCheck {
  const capabilities = providerCapabilities(provider);
  if (capabilities.rescheduleExternally) return { allowed: true, capabilities };
  return {
    allowed: false,
    capabilities,
    code: "EXTERNAL_RESCHEDULE_UNSUPPORTED",
    message:
      capabilities.writeBlockedReason ||
      `${capabilities.label} bookings cannot be rescheduled from Clarity.`,
  };
}

export function canCancelExternally(provider: unknown): ExternalWriteCheck {
  const capabilities = providerCapabilities(provider);
  if (capabilities.cancelExternally) return { allowed: true, capabilities };
  return {
    allowed: false,
    capabilities,
    code: "EXTERNAL_CANCEL_UNSUPPORTED",
    message:
      capabilities.writeBlockedReason ||
      `${capabilities.label} bookings cannot be cancelled from Clarity.`,
  };
}
