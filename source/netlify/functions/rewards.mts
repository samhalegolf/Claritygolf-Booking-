import type { Config } from "@netlify/functions";

import { requireCoachActor } from "./_shared/coach-auth.mts";
import { getDatabase } from "./_shared/database.mts";
import { json } from "./_shared/http.mts";
import {
  archiveProgram,
  readPersonRewards,
  readPrograms,
  runRewards,
  saveProgram,
} from "./_shared/rewards.mts";

/**
 * Rewards -- the coach's side.
 *
 * The engine is _shared/rewards.mts; this file is routing, the account (always
 * from requireCoachActor, never the request), and the catalogue read a
 * programme is validated against.
 *
 *   GET    /api/rewards                 programmes, with what each has paid out
 *   GET    /api/rewards?personId=       one client's progress in each programme
 *   POST   /api/rewards/programs        create or update a programme (and pay
 *                                       anything it has already earned)
 *   DELETE /api/rewards/programs?id=    retire a programme
 *   POST   /api/rewards/run             pay every earned reward now
 */

async function body(req: Request): Promise<Record<string, any>> {
  try {
    const parsed = await req.json();
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** The catalogue a programme may name, or undefined when it cannot be read. */
async function serviceIds(accountId: string): Promise<Set<string> | undefined> {
  const rows = (await getDatabase().sql`
    SELECT value FROM settings WHERE account_id = ${accountId} AND key = 'servicesJson' LIMIT 1
  `) as Array<{ value: string }>;
  try {
    const services = rows[0]?.value ? JSON.parse(rows[0].value) : null;
    return Array.isArray(services)
      ? new Set<string>(services.map((service: { id?: unknown }) => String(service?.id || "")).filter(Boolean))
      : undefined;
  } catch {
    return undefined;
  }
}

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/\.netlify\/functions\/rewards/, "/api/rewards").replace(/\/$/, "");

  try {
    const actor = await requireCoachActor(req);
    const accountId = actor.accountId;
    const who = { accountId, actorId: actor.authUserId };

    if (req.method === "GET" && path === "/api/rewards") {
      const personId = (url.searchParams.get("personId") || "").slice(0, 160);
      if (personId) return json({ progress: await readPersonRewards(accountId, personId) });
      return json({ programs: await readPrograms(accountId) });
    }

    if (req.method === "POST" && path === "/api/rewards/programs") {
      const input = await body(req);
      await saveProgram(input.program || input, { serviceIds: await serviceIds(accountId) }, who);
      // Anything already earned since the programme's start date is paid now,
      // rather than half an hour from now when the coach has moved on.
      const ran = await runRewards(accountId);
      return json({ programs: await readPrograms(accountId), ran });
    }

    if (req.method === "DELETE" && path === "/api/rewards/programs") {
      return json({ programs: await archiveProgram(url.searchParams.get("id") || "", who) });
    }

    if (req.method === "POST" && path === "/api/rewards/run") {
      const ran = await runRewards(accountId);
      return json({ programs: await readPrograms(accountId), ran });
    }

    return json({ error: "not_found" }, 404);
  } catch (error) {
    const status = Number((error as { status?: number })?.status) || 500;
    if (status >= 500) console.error("rewards:failed", path, error);
    return json(
      {
        error: (error as { code?: string })?.code || "failed",
        message: status >= 500 ? "Something went wrong." : (error as Error).message,
      },
      status,
    );
  }
}

export const config: Config = {
  path: ["/api/rewards", "/api/rewards/programs", "/api/rewards/run"],
};
