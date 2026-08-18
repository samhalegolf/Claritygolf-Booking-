/**
 * What each external booking source can actually do.
 *
 * The UI and the reschedule route both read this instead of assuming every
 * provider behaves alike. A capability is false until the code to honour it
 * exists and the data it needs is on hand -- claiming one Clarity cannot
 * deliver is how the two systems end up silently disagreeing.
 */

import { optixAdapter } from "./providers/optix.mts";
import type { ExternalProvider, ProviderAdapter, ProviderCapabilities } from "./types.mts";

export type { ExternalProvider, ExternalSourceType, ProviderCapabilities } from "./types.mts";

/**
 * Every provider Clarity has an adapter for.
 *
 * Adding a provider is one entry here plus one file under ./providers. Nothing
 * else in the codebase should ever need to name a provider.
 *
 * A provider can appear in CAPABILITIES below without appearing here: that is
 * the honest state for one Clarity knows about but cannot yet talk to.
 */
const ADAPTERS: Partial<Record<ExternalProvider, ProviderAdapter>> = {
  optix: optixAdapter,
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

/**
 * The adapter for a provider, or null when Clarity has no code to talk to it.
 *
 * Callers must handle null rather than assuming: an unrecognised provider is a
 * routine state (a stale mapping row, a webhook from a system someone
 * configured and then removed), not an exception.
 */
export function adapterFor(provider: unknown): ProviderAdapter | null {
  return isExternalProvider(provider) ? ADAPTERS[provider] ?? null : null;
}

/** Every provider that can actually be talked to right now. */
export function connectedProviders(): ProviderAdapter[] {
  return Object.values(ADAPTERS).filter(Boolean) as ProviderAdapter[];
}
