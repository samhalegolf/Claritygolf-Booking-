import type { Config, Context } from "@netlify/functions";

import { handlePublicRescheduleRequest } from "./booking-core.mts";
import { notifyBookingEvent } from "./notification-engine.mts";

export default async (req: Request, context: Context) => {
  const response = await handlePublicRescheduleRequest(req, context);
  if (req.method === "POST" && response.ok) {
    try {
      const result = await response.clone().json();
      const task = notifyBookingEvent({
        action: "rescheduled",
        appointment: result.appointment,
        source: "public-reschedule",
      }).then((notifications) => console.log("public_reschedule:notifications", JSON.stringify(notifications)));
      if (context?.waitUntil) context.waitUntil(task);
      else await task;
    } catch (error) {
      console.error("public_reschedule:notification_failed", error);
    }
  }
  return response;
};

export const config: Config = {
  path: "/api/public-reschedule",
};
