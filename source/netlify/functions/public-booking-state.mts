import type { Config } from "@netlify/functions";

import { readPublicBookingState } from "./calendar-state.mts";
import { publicBookingState } from "./booking-core.mts";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export default async function handler(req: Request) {
  try {
    const state = await readPublicBookingState();
    return jsonResponse(publicBookingState(state));
  } catch (error) {
    console.error("public_booking_state_error", error);
    throw error;
  }
}

export const config: Config = { path: "/api/public-booking-state" };
