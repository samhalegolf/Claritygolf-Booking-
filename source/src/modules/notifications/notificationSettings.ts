import type { NotificationTemplates } from "../../../netlify/functions/_shared/notification-templates.mts";

export type NotificationSettings = {
  emailNotificationsEnabled: boolean;
  notificationEmail: string;
  notificationSubjectLine: string;
  notificationFromName: string;
  googleReviewUrl: string;
  configuredSenderEmailAddress: string;
  coachEmail: string;
  replyToEmail: string;
  notificationDelaySeconds: number;
  sendClientEmail: boolean;
  sendCoachEmail: boolean;
  sendAdminEmail: boolean;
  // Off by default. A lesson type swap rewrites the booking's duration, so
  // it would otherwise go out as a reschedule email - and those bypass the
  // three toggles above.
  sendLessonTypeChangeEmail: boolean;
  reminderEnabled: boolean;
  reminderLeadMinutes: number;
  clientEmailSubject: string;
  clientEmailIntro: string;
  clientEmailFooter: string;
  adminEmailSubject: string;
  adminEmailIntro: string;
  minBookingNoticeMinutes: number;
  // Booking page › Look busy: offer only the times that butt up against the
  // day's edges or an existing booking, so lessons pack together.
  publicBookingLookBusy: boolean;
  smsProviderName: string;
  smsWebhookUrl: string;
  smsFromNumber: string;
  sendClientSms: boolean;
  sendAdminSms: boolean;
  // The wording of each client-facing message, one template per thing that
  // happened. Blank fields mean "use Clarity's default" - see
  // netlify/functions/_shared/notification-templates.mts, which the send path
  // reads from too so the preview and the email cannot drift.
  notificationTemplates: NotificationTemplates;
  // What the map link beside the venue is called, on every message.
  mapLinkLabel: string;
  // The player portal's slot for an outside booking widget: a URL, what the
  // tab is called, a line above it and how tall it starts. An empty URL means
  // the tab does not exist in the portal at all.
  playerBookingEmbedUrl: string;
  playerBookingEmbedLabel: string;
  playerBookingEmbedIntro: string;
  playerBookingEmbedHeight: number;
};
