#!/usr/bin/env node
//
// Apply outstanding database migrations.
//
// This exists because it didn't. The migrations directory has always been a set
// of SQL files with nothing that runs them: they were applied by hand, and the
// build was `tsc && vite build`. That was survivable while the code tolerated an
// older schema. It stopped being survivable the moment the code began to
// *require* a column -- a deploy shipped expecting `settings.account_id`, the
// migration adding it had never run, and the site went down with
// `column "account_id" does not exist`.
//
// So: migrations are now part of deploying, and a deploy that cannot apply them
// fails instead of shipping code the database cannot serve.
//
// WHY database/migrations AND NOT netlify/database/migrations
//
// `netlify/database/migrations/` is Netlify DB's reserved path: the platform
// scans it during the *Deploying* phase and applies anything pending to the
// Netlify-provisioned Postgres. This project's schema does not live there -- it
// lives in Supabase, which is what DATABASE_URL points at and what the
// @netlify/database shim in package.json actually forwards to.
//
// While the files sat in that path, both consumers read them. A new migration
// applied here during Building, then failed in Netlify DB during Deploying with
// `relation "billing_invoice_items" does not exist`, because that database has
// none of this app's tables. It blocked six production deploys before anyone
// noticed the two phases were doing different things. Keep migrations out of
// Netlify's path so only this runner reads them.
//
// Usage:
//   node scripts/migrate.mjs              apply anything outstanding
//   node scripts/migrate.mjs --dry-run    list what would run, change nothing
//   node scripts/migrate.mjs --baseline   record every migration on disk as
//                                         already applied, running none
//   node scripts/migrate.mjs --status     show applied vs outstanding
//
// Reads DATABASE_URL (the same connection string the functions use).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, "..", "database", "migrations");

const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith("--")));
const dryRun = flags.has("--dry-run");
const baseline = flags.has("--baseline");
const statusOnly = flags.has("--status");

function fail(message) {
  console.error(`\nmigrate: ${message}\n`);
  process.exit(1);
}

/**
 * Every migration on disk, in the order their directory names sort.
 *
 * The names are timestamps, so lexical order is chronological order. A
 * migration is its directory name plus the SQL inside it; the checksum is only
 * used to notice that an already-applied file has been edited since, which is
 * a mistake worth reporting rather than silently ignoring.
 */
function migrationsOnDisk() {
  let entries;
  try {
    entries = readdirSync(MIGRATIONS_DIR);
  } catch {
    fail(`no migrations directory at ${MIGRATIONS_DIR}`);
  }
  return entries
    .filter((name) => {
      try {
        return statSync(path.join(MIGRATIONS_DIR, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .map((name) => {
      const file = path.join(MIGRATIONS_DIR, name, "migration.sql");
      let sql;
      try {
        sql = readFileSync(file, "utf8");
      } catch {
        fail(`${name} has no migration.sql`);
      }
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16) };
    });
}

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function appliedMigrations(client) {
  const { rows } = await client.query("SELECT name, checksum FROM public.schema_migrations");
  return new Map(rows.map((row) => [row.name, row.checksum]));
}

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;

  // A production build with no database is the exact situation that caused the
  // outage: code ships, schema does not. Refuse rather than deploy blind.
  if (!connectionString) {
    if (process.env.CONTEXT === "production") {
      fail(
        "DATABASE_URL is not set, so outstanding migrations cannot be applied.\n" +
          "        Set it in the Netlify site's environment variables. Refusing to\n" +
          "        build: shipping code against an unmigrated database is what took\n" +
          "        the site down before.",
      );
    }
    console.log("migrate: DATABASE_URL not set and this is not a production build — skipping.");
    return;
  }

  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("sslmode=disable") ? false : { rejectUnauthorized: false },
    max: 1,
  });

  const client = await pool.connect();
  try {
    await ensureLedger(client);
    const onDisk = migrationsOnDisk();
    const applied = await appliedMigrations(client);

    // An applied migration whose file has changed since. Not fatal -- the
    // database is what it is -- but it means the file no longer describes what
    // actually ran, which is worth knowing.
    for (const migration of onDisk) {
      const recorded = applied.get(migration.name);
      if (recorded && recorded !== migration.checksum) {
        console.warn(
          `migrate: WARNING ${migration.name} was applied as ${recorded} but the file is now ${migration.checksum}.`,
        );
      }
    }

    const outstanding = onDisk.filter((migration) => !applied.has(migration.name));

    if (statusOnly) {
      console.log(`migrate: ${applied.size} applied, ${outstanding.length} outstanding.`);
      outstanding.forEach((migration) => console.log(`  outstanding  ${migration.name}`));
      return;
    }

    if (baseline) {
      // Records everything on disk as applied WITHOUT running it. For adopting
      // this runner on a database whose migrations were all applied by hand --
      // which is every database this project has. Running them instead would
      // re-execute 43 migrations against a schema that already has them.
      if (!outstanding.length) {
        console.log("migrate: nothing to baseline, every migration is already recorded.");
        return;
      }
      if (dryRun) {
        console.log(`migrate: --dry-run, would baseline ${outstanding.length} migration(s):`);
        outstanding.forEach((migration) => console.log(`  baseline  ${migration.name}`));
        return;
      }
      for (const migration of outstanding) {
        await client.query(
          "INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING",
          [migration.name, migration.checksum],
        );
      }
      console.log(`migrate: baselined ${outstanding.length} migration(s) as already applied.`);
      console.log("migrate: nothing was executed. Verify the schema matches before relying on this.");
      return;
    }

    if (!outstanding.length) {
      console.log(`migrate: up to date (${applied.size} applied).`);
      return;
    }

    if (dryRun) {
      console.log(`migrate: --dry-run, ${outstanding.length} migration(s) would run:`);
      outstanding.forEach((migration) => console.log(`  would apply  ${migration.name}`));
      return;
    }

    console.log(`migrate: applying ${outstanding.length} migration(s)…`);
    for (const migration of outstanding) {
      // One transaction per migration: a failure rolls that migration back
      // whole and stops the run, so the ledger never claims something that
      // only half happened.
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)",
          [migration.name, migration.checksum],
        );
        await client.query("COMMIT");
        console.log(`  applied  ${migration.name}`);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`  FAILED   ${migration.name}`);
        throw error;
      }
    }
    console.log("migrate: done.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("\nmigrate: failed");
  console.error(error?.message || error);
  // Non-zero so a build that cannot migrate does not ship.
  process.exit(1);
});
