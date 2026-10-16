// The wording a notification goes out with: the coach's own text where they
// wrote some, otherwise Clarity's default in the business's message language.
//
// Its own module, apart from notification-templates.mts, because translating
// the default needs every language catalogue and the coach app reads the
// template constants on every load. Only the send path and the Notifications
// settings panel (loaded on demand) import this file.

import { translateMessage } from "./message-language.mts";
import {
  DEFAULT_NOTIFICATION_TEMPLATES,
  type NotificationTemplateField,
  type NotificationTemplates,
  type NotificationVariantId,
} from "./notification-templates.mts";

/**
 * One field's effective wording: what the coach wrote, exactly as written, or
 * Clarity's default in the business's message language.
 *
 * A field the coach has deliberately emptied still falls back to the default -
 * there is no way to send a message with no subject, and "blank" is how Reset
 * is stored. The one field allowed to resolve empty is a default that is itself
 * empty (cancelled's button, which does not exist).
 */
export function notificationTemplateText(
  templates: NotificationTemplates | undefined,
  variant: NotificationVariantId,
  field: NotificationTemplateField,
  language: unknown = "en",
): string {
  const written = templates?.[variant]?.[field];
  if (typeof written === "string" && written.trim()) return written;
  const fallback = DEFAULT_NOTIFICATION_TEMPLATES[variant][field];
  return fallback ? translateMessage(language, fallback) : fallback;
}
