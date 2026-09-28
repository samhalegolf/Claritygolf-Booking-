import type { Config, Context } from "@netlify/functions";

import { handleApiRequest } from "./_shared/public-api/handler.mts";

// Clarity's public REST API. Everything is in _shared/public-api/; this file
// only claims the path. Docs: docs/PUBLIC_API.md, spec: GET /api/v1/openapi.json.
export default async function handler(req: Request, context: Context) {
  return handleApiRequest(req, context);
}

export const config: Config = {
  path: ["/api/v1", "/api/v1/*"],
};
