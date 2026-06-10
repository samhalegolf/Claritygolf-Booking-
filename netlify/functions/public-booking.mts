import type { Config, Context } from "@netlify/functions";

import { handlePublicBookingRequest } from "./booking-core.mts";

export default async (req: Request, context: Context) => {
  const pendingTasks: Promise<unknown>[] = [];
  const waitForNotificationsContext = {
    ...context,
    waitUntil(task: Promise<unknown>) {
      pendingTasks.push(task);
      return context.waitUntil?.(task);
    },
  } as Context;

  const response = await handlePublicBookingRequest(req, waitForNotificationsContext);

  if (response.ok && pendingTasks.length) {
    await Promise.allSettled(pendingTasks);
  }

  return response;
};

export const config: Config = {
  path: "/api/public-booking",
};
