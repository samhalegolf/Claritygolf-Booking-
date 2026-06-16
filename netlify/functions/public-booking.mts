import type { Config, Context } from "@netlify/functions";

import { handlePublicBookingRequest } from "./booking-core.mts";
import { notifyBookingEvent } from "./notification-engine.mts";

export default async (req: Request, context: Context) => {
  const payload = req.method === "POST" ? await req.clone().json().catch(() => ({})) : {};
  const response = await handlePublicBookingRequest(req, context);
  if (req.method === "POST" && response.ok) {
    try {
      const result = await response.clone().json();
      const client = [payload.firstName, payload.lastName].filter(Boolean).join(" ");
      const appointment = {
        ...result.appointment,
        serviceId: payload.serviceId,
        client,
        title: client,
        email: payload.email,
        phone: payload.phone,
      };
      const task = notifyBookingEvent({
        action: "booking",
        appointment,
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
