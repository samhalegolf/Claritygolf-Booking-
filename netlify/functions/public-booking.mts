import type { Config, Context } from "@netlify/functions";

import { handlePublicBookingRequest } from "./booking-core.mts";
import { notifyBookingEvent } from "./notification-engine.mts";

export default async (req: Request, context: Context) => {
  const response = await handlePublicBookingRequest(req, context);
  if (req.method === "POST" && response.ok) {
    try {
      const result = await response.clone().json();
      const task = notifyBookingEvent({
        action: "booking",
        appointment: result.appointment,
        source: "public-booking",
      }).then((notifications) => console.log("public_booking:notifications", JSON.stringify(notifications)));
      if (context?.waitUntil) context.waitUntil(task);
      else await task;
    } catch (error) {
      console.error("public_booking:notification_failed", error);
    }
  }
  return response;
};

export const config: Config = {
  path: "/api/public-booking",
};
