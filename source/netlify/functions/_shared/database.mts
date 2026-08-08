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

/**
 * Collect idempotent DDL statements and run them as one round trip.
 *
 * Bringing the schema up to date is the first thing an instance does, and it
 * used to be twenty-odd `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD
 * COLUMN IF NOT EXISTS` statements sent one at a time. None of them normally do
 * anything — the tables already exist — so that was pure latency on the first
 * request every new instance served.
 *
 * They go out as a single multi-statement simple query. Parameters would force
 * the extended protocol, which carries one statement per message; DDL takes
 * none, so the tag below refuses interpolation rather than quietly falling back.
 *
 * If the batch is refused, the statements are re-run one at a time. This is the
 * boot path: a connection pooler that will not accept a multi-statement query
 * should make startup slow, not impossible. Re-running is safe because every
 * statement is idempotent, and a batch that fails rolls back as a unit.
 */
export function ddlBatch() {
  const statements: string[] = [];
  return {
    sql(strings: TemplateStringsArray, ...values: unknown[]) {
      if (values.length) {
        throw new Error("DDL statements are batched as text and cannot take parameters.");
      }
      const statement = strings.raw.join("").trim().replace(/;+$/, "");
      if (statement) statements.push(statement);
    },
    /** `pool` is injectable so the batching can be checked without a database. */
    async run(pool: { query: (text: string) => Promise<unknown> } | null = null) {
      if (!statements.length) return;
      const target = pool || getPool();
      try {
        await target.query(statements.join(";\n"));
        return;
      } catch (error) {
        // Not fatal on its own: fall through and find out which statement it was.
        console.warn(
          "database:ddl_batch_fell_back",
          error instanceof Error ? error.message : String(error),
        );
      }
      for (const statement of statements) {
        await target.query(statement);
      }
    },
  };
}

export async function closeDatabase() {
  if (cachedPool) {
    await cachedPool.end();
    cachedPool = null;
    cachedDatabase = null;
  }
}
