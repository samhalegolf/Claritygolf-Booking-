import type { Config, Context } from "@netlify/functions";

import { handleResendWebhookRequest } from "./booking-core.mts";

export default async (req: Request, _context: Context) => handleResendWebhookRequest(req);

export const config: Config = {
  path: "/api/resend-webhook",
};
