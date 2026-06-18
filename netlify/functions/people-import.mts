import type { Config, Context } from "@netlify/functions";
import { getDatabase } from "@netlify/database";

import { handleBookingApiRoute } from "./booking-core.mts";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function ensurePeopleImportColumns() {
  const database = getDatabase();
  const requiredColumns = [
    ["email", "TEXT"],
    ["phone", "TEXT"],
    ["notes", "TEXT"],
    ["source", "TEXT"],
    ["caddy_profile_id", "TEXT"],
    ["caddy_profile_url", "TEXT"],
    ["created_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"],
    ["updated_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"],
  ];

  for (const [columnName, columnType] of requiredColumns) {
    try {
      await database.pool.query(`ALTER TABLE people ADD COLUMN IF NOT EXISTS ${columnName} ${columnType}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      if (!/already exists|duplicate column/i.test(message)) throw error;
    }
  }
}

export default async (req: Request, context: Context) => {
  try {
    await ensurePeopleImportColumns();
    return await handleBookingApiRoute(req, "/api/people/import", context);
  } catch (error) {
    const message = error instanceof Error ? error.message : "People import failed.";
    console.error("people_import_failed", error);
    return json({ error: "people_import_failed", message }, 500);
  }
};

export const config: Config = {
  path: "/api/people/import",
};
