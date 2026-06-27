import type { Config } from "@netlify/functions";

import { handleCustomGroupConfirmRequest } from "./booking-core.mts";

export default async function handler(req: Request) {
  return handleCustomGroupConfirmRequest(req);
}

export const config: Config = { path: "/api/custom-group-confirm" };
