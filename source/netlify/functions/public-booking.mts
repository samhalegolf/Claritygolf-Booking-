import type { Config } from "@netlify/functions";

import { handlePublicBookingSubmitRequest } from "./calendar-state.mts";

export default async function handler(req: Request) {
  return handlePublicBookingSubmitRequest(req);
}

export const config: Config = { path: "/api/public-booking" };
