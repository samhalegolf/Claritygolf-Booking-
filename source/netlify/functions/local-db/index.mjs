// Compatibility package retained so existing @netlify/database imports keep
// working while the booking functions move to the shared direct Postgres adapter.
export { getDatabase } from "../_shared/database.mts";
