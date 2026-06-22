import pg from "pg";

const { Pool } = pg;

function env(name, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function buildSql(strings, values) {
  let text = "";
  strings.forEach((part, index) => {
    text += part;
    if (index < values.length) text += `$${index + 1}`;
  });
  return { text, values };
}

function databaseUrl() {
  return env("DATABASE_URL") || env("NETLIFY_DATABASE_URL") || env("POSTGRES_URL") || env("SUPABASE_DB_URL");
}

let cachedDatabase = null;
let cachedPool = null;

function createPool() {
  const connectionString = databaseUrl();
  if (!connectionString) {
    throw new Error("Database is not configured. Set DATABASE_URL in Netlify environment variables.");
  }

  return new Pool({
    connectionString,
    max: Number(env("DATABASE_POOL_MAX", "1")),
    idleTimeoutMillis: Number(env("DATABASE_IDLE_TIMEOUT_MS", "1000")),
    connectionTimeoutMillis: Number(env("DATABASE_CONNECTION_TIMEOUT_MS", "5000")),
    allowExitOnIdle: true,
    ssl: env("DATABASE_SSL", "true").toLowerCase() === "false" ? false : { rejectUnauthorized: false },
  });
}

export function getDatabase() {
  if (!cachedPool) cachedPool = createPool();
  if (!cachedDatabase) {
    cachedDatabase = {
      sql(strings, ...values) {
        const built = buildSql(strings, values);
        return cachedPool.query(built.text, built.values).then((result) => result.rows);
      },
      pool: cachedPool,
    };
  }
  return cachedDatabase;
}
