import pg from "pg";

const { Client } = pg;

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

function createClient() {
  const connectionString = databaseUrl();
  if (!connectionString) {
    throw new Error("Database is not configured. Set DATABASE_URL in Netlify environment variables.");
  }

  return new Client({
    connectionString,
    connectionTimeoutMillis: Number(env("DATABASE_CONNECTION_TIMEOUT_MS", "5000")),
    query_timeout: Number(env("DATABASE_QUERY_TIMEOUT_MS", "10000")),
    statement_timeout: Number(env("DATABASE_STATEMENT_TIMEOUT_MS", "10000")),
    ssl: env("DATABASE_SSL", "true").toLowerCase() === "false" ? false : { rejectUnauthorized: false },
  });
}

async function runQuery(text, values = []) {
  const client = createClient();
  await client.connect();
  try {
    const result = await client.query(text, values);
    return result.rows;
  } finally {
    await client.end().catch(() => {});
  }
}

class SingleUseClient {
  constructor(client) {
    this.client = client;
  }

  async query(text, values = []) {
    return this.client.query(text, values);
  }

  release() {
    void this.client.end().catch(() => {});
  }
}

let cachedDatabase = null;

export function getDatabase() {
  if (!cachedDatabase) {
    cachedDatabase = {
      sql(strings, ...values) {
        const built = buildSql(strings, values);
        return runQuery(built.text, built.values);
      },
      pool: {
        async connect() {
          const client = createClient();
          await client.connect();
          return new SingleUseClient(client);
        },
      },
    };
  }
  return cachedDatabase;
}
