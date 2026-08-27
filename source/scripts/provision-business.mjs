#!/usr/bin/env node
//
// Provision a business account and attach an owner.
//
// The boundary work deliberately stopped short of a public signup wizard: a
// second business is created here, deliberately, by someone with database
// access. What this does is exactly the three rows the runtime requires and
// nothing else --
//
//   1. an `accounts` row (the business);
//   2. an `account_memberships` row linking a Supabase Auth user to it as
//      owner (this is the only thing that grants access -- there is no default
//      account and no env fallback);
//   3. the handful of `settings` rows a workspace needs to identify itself.
//
// It does not copy anything from an existing business. That is the point: the
// new workspace opens with no clients, no calendar, no lesson types and no
// integrations, which is what the isolation test checks for.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/provision-business.mjs \
//     --slug boundary-test-business \
//     --name "Boundary Test Business" \
//     --email owner@boundary-test.example
//
// The Supabase Auth user must already exist for that email (create it in the
// Supabase dashboard, or invite them). This script only links it; it never
// creates credentials.
//
// Add --dry-run to print what it would do and change nothing.

import pg from "pg";

const { Pool } = pg;

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : "true";
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function fail(message) {
  console.error(`provision-business: ${message}`);
  process.exit(1);
}

const slug = slugify(arg("slug"));
const businessName = arg("name").trim();
const ownerEmail = arg("email").trim().toLowerCase();
const dryRun = arg("dry-run", "") === "true";

if (!slug) fail("--slug is required (it becomes the account id and the public booking slug)");
if (!businessName) fail("--name is required (the business's display name)");
if (!ownerEmail.includes("@")) fail("--email is required (the owner's Supabase Auth email)");
if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("sslmode=disable") ? false : { rejectUnauthorized: false },
});

// Only what a workspace needs to name itself. Everything else -- lesson types,
// availability, locations, branding, integrations -- is left unset so the new
// business configures its own rather than inheriting anyone's.
function initialSettings() {
  return {
    accountId: slug,
    accountCalendarSlug: slug,
    accountBusinessName: businessName,
    accountCoachName: "",
    accountVenueName: "",
    accountVenueShortName: "",
    accountContactEmail: ownerEmail,
    coachName: businessName,
    servicesJson: "[]",
    availabilityJson: "[[],[],[],[],[],[],[]]",
    locationsJson: "[]",
    coachProfilesJson: "[]",
    appUsersJson: "[]",
    workspaceAccountsJson: JSON.stringify([
      {
        id: slug,
        name: businessName,
        slug,
        planKey: "solo",
        subscriptionStatus: "trialing",
        billingProvider: "none",
        active: true,
      },
    ]),
    updatedAt: new Date().toISOString(),
  };
}

async function main() {
  const client = await pool.connect();
  try {
    const authUser = await client.query(
      "SELECT id FROM auth.users WHERE lower(email) = $1 LIMIT 1",
      [ownerEmail],
    );
    if (!authUser.rows.length) {
      fail(
        `no Supabase Auth user for ${ownerEmail}. Create or invite them in Supabase first; ` +
          "this script links an identity, it never creates credentials.",
      );
    }
    const authUserId = authUser.rows[0].id;

    const existing = await client.query("SELECT id FROM accounts WHERE id = $1 OR slug = $1", [slug]);
    if (existing.rows.length) fail(`a business already exists with the id or slug "${slug}"`);

    const settings = initialSettings();

    if (dryRun) {
      console.log("Would create:");
      console.log(`  accounts            id=${slug} name="${businessName}"`);
      console.log(`  account_memberships ${ownerEmail} (${authUserId}) as owner of ${slug}`);
      console.log(`  settings            ${Object.keys(settings).length} keys, all scoped to ${slug}`);
      return;
    }

    await client.query("BEGIN");

    await client.query(
      `INSERT INTO accounts (id, slug, business_name, status, created_at, updated_at)
       VALUES ($1, $1, $2, 'active', NOW(), NOW())`,
      [slug, businessName],
    );

    await client.query(
      `INSERT INTO account_memberships (id, account_id, auth_user_id, role, active, created_at, updated_at)
       VALUES ($1, $2, $3::uuid, 'owner', true, NOW(), NOW())`,
      [`membership-${slug}-owner`, slug, authUserId],
    );

    const params = [];
    const rows = Object.entries(settings).map(([key, value]) => {
      params.push(slug, key, String(value ?? ""));
      return `($${params.length - 2}, $${params.length - 1}, $${params.length}, NOW())`;
    });
    await client.query(
      `INSERT INTO settings (account_id, key, value, updated_at)
       VALUES ${rows.join(", ")}
       ON CONFLICT (account_id, key) DO NOTHING`,
      params,
    );

    await client.query("COMMIT");

    console.log(`Created business "${businessName}" (${slug}).`);
    console.log(`Owner: ${ownerEmail} (${authUserId}).`);
    console.log("");
    console.log("They sign in with their Supabase Auth password at the normal coach login.");
    console.log(`Their public booking page is ?business=${slug}.`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("provision-business: failed");
  console.error(error);
  process.exit(1);
});
