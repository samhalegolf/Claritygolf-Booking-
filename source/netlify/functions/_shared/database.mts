import pg from "pg";

/**
 * Postgres access for the booking app.
 *
 * This replaces the REST allowlist adapter that used to sit behind the
 * `@netlify/database` alias. The SQL in this codebase is sent directly to
 * Postgres using parameterised queries.
 *
 * Interface is unchanged:
 *   db().sql`SELECT ...`          -> array of rows
 *   db().pool.connect()           -> client with .query() and .release()
 */

const { Pool, types } = pg;

types.setTypeParser(20, (value: string) => (value === null ? null : Number(value)));

function env(name: string): string {
  return (globalThis.Netlify?.env?.get(name) || process.env[name] || "").trim();
}

function connectionString(): string {
  const url = env("DATABASE_URL") || env("SUPABASE_DB_URL");
  if (!url) {
    throw new Error(
      "Postgres is not configured. Set DATABASE_URL in Netlify to the Supabase " +
        "transaction pooler connection string (port 6543).",
    );
  }
  return url;
}

let cachedPool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (cachedPool) return cachedPool;

  const url = connectionString();
  const isLocal = url.includes("host=/") || url.includes("sslmode=disable");

  cachedPool = new Pool({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000,
  });

  cachedPool.on("error", (error) => {
    console.error("database:idle_client_error", error);
  });

  return cachedPool;
}

function buildSql(strings: TemplateStringsArray, values: unknown[]) {
  let text = "";
  strings.forEach((part, index) => {
    text += part;
    if (index < values.length) text += `$${index + 1}`;
  });
  return { text, values };
}

let cachedDatabase: { sql: Function; pool: pg.Pool } | null = null;

export function getDatabase() {
  if (!cachedDatabase) {
    cachedDatabase = {
      async sql(strings: TemplateStringsArray, ...values: unknown[]) {
        const { text, values: params } = buildSql(strings, values);
        const result = await getPool().query(text, params);
        return result.rows;
      },
      get pool() {
        return getPool();
      },
    } as any;
  }
  return cachedDatabase!;
}

export async function closeDatabase() {
  if (cachedPool) {
    await cachedPool.end();
    cachedPool = null;
    cachedDatabase = null;
  }
}
