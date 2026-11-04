/**
 * Player bags: storage, and the sync with Clarity Caddy.
 *
 * One bag per person per business, in `player_bags`. The coach edits it on the
 * player profile, the player edits it in the portal, and when the player has a
 * Clarity Caddy account the same bag is kept in step with the one Caddy uses
 * on the course.
 *
 * HOW THE SYNC WORKS
 *
 * Booking and Caddy run on different databases, so the bag crosses through the
 * one server-to-server seam (_shared/caddy.mts -> Caddy's
 * /api/clarity-integration). Each time the bag is read or saved here, Caddy's
 * copy is read too and the two are reconciled with decideBagSync
 * (bag-model.mts): `caddy_synced_fingerprint` is the bag both sides last
 * agreed on, so whichever side changed since then wins.
 *
 * Caddy is local-first: the player's phone holds the bag and backs it up to
 * Caddy's cloud. A bag Booking sends is picked up by the phone the next time
 * Caddy opens; until then Caddy reports it as `pending`, and its cloud copy is
 * the phone's older bag -- so nothing is taken from Caddy while it is pending.
 *
 * Caddy being down, unconfigured or the player having no account never fails a
 * read or a save. The bag here is always the one shown; the sync state says
 * what happened with Caddy.
 *
 * Every query filters on account_id in the SQL.
 */

import { getDatabase } from "./database.mts";
import {
  bagFingerprint,
  decideBagSync,
  normaliseBag,
  type BagCaddyLink,
  type BagCaddyState,
  type BagClub,
  type BagEditedBy,
  type PlayerBagView,
} from "./bag-model.mts";
import { caddyConfigured, readCaddyBag, writeCaddyBag } from "./caddy.mts";
import { missingAccountScope } from "./permissions.mts";
import { cleanSlug, cleanString } from "./values.mts";

const db = getDatabase;

type BagRow = {
  clubs: unknown;
  updated_by: BagEditedBy;
  updated_at: string | Date;
  caddy_synced_fingerprint: string | null;
  caddy_synced_at: string | Date | null;
};

function iso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function scope(accountId: string, personId: string, where: string) {
  const account = cleanSlug(accountId, "");
  if (!account) throw missingAccountScope(where);
  const person = cleanString(personId, "", 160);
  if (!person) throw Object.assign(new Error("A player id is required."), { status: 400, code: "invalid" });
  return { account, person };
}

async function readRow(account: string, person: string): Promise<BagRow | null> {
  const rows = (await db().sql`
    SELECT clubs, updated_by, updated_at, caddy_synced_fingerprint, caddy_synced_at
    FROM public.player_bags
    WHERE account_id = ${account} AND person_id = ${person}
    LIMIT 1
  `) as BagRow[];
  return rows[0] || null;
}

async function personExists(account: string, person: string) {
  const rows = (await db().sql`
    SELECT 1 FROM public.people WHERE id = ${person} AND account_id = ${account} LIMIT 1
  `) as unknown[];
  return rows.length > 0;
}

async function writeRow(
  account: string,
  person: string,
  clubs: BagClub[],
  by: BagEditedBy,
  synced: string | null,
): Promise<BagRow> {
  const rows = (await db().sql`
    INSERT INTO public.player_bags (
      account_id, person_id, clubs, updated_by, updated_at, caddy_synced_fingerprint, caddy_synced_at
    ) VALUES (
      ${account}, ${person}, ${JSON.stringify(clubs)}::jsonb, ${by}, NOW(),
      ${synced}, ${synced === null ? null : new Date().toISOString()}
    )
    ON CONFLICT (account_id, person_id) DO UPDATE SET
      clubs = EXCLUDED.clubs,
      updated_by = EXCLUDED.updated_by,
      updated_at = EXCLUDED.updated_at,
      caddy_synced_fingerprint = COALESCE(EXCLUDED.caddy_synced_fingerprint, public.player_bags.caddy_synced_fingerprint),
      caddy_synced_at = COALESCE(EXCLUDED.caddy_synced_at, public.player_bags.caddy_synced_at)
    RETURNING clubs, updated_by, updated_at, caddy_synced_fingerprint, caddy_synced_at
  `) as BagRow[];
  return rows[0];
}

async function markSynced(account: string, person: string, fingerprint: string): Promise<BagRow | null> {
  const rows = (await db().sql`
    UPDATE public.player_bags
    SET caddy_synced_fingerprint = ${fingerprint}, caddy_synced_at = NOW()
    WHERE account_id = ${account} AND person_id = ${person}
    RETURNING clubs, updated_by, updated_at, caddy_synced_fingerprint, caddy_synced_at
  `) as BagRow[];
  return rows[0] || null;
}

function view(row: BagRow | null, state: BagCaddyState): PlayerBagView {
  return {
    clubs: normaliseBag(row?.clubs),
    updatedAt: iso(row?.updated_at),
    updatedBy: row?.updated_by || null,
    caddy: { state, syncedAt: iso(row?.caddy_synced_at) },
  };
}

/**
 * Reconciles this bag with Caddy's and returns the row as it stands after.
 * Never throws for a Caddy problem: that comes back as the state.
 */
async function syncWithCaddy(
  account: string,
  person: string,
  row: BagRow | null,
  link: BagCaddyLink,
): Promise<{ row: BagRow | null; state: BagCaddyState }> {
  if (!link?.authUserId && !link?.email) return { row, state: "not_linked" };
  if (!caddyConfigured()) return { row, state: "not_configured" };

  const local = normaliseBag(row?.clubs);
  const localPrint = bagFingerprint(local);
  const lastSynced = row?.caddy_synced_fingerprint ?? null;

  try {
    const remote = await readCaddyBag(link.authUserId, link.email);
    if (!remote.connected) return { row, state: "no_account" };

    if (remote.pending) {
      // The phone has not picked up the last bag we sent. If the bag here has
      // changed again since, send the newer one; otherwise just wait.
      if (localPrint !== lastSynced) {
        await writeCaddyBag(link.authUserId, link.email, local);
        return { row: await markSynced(account, person, localPrint), state: "waiting_for_phone" };
      }
      return { row, state: "waiting_for_phone" };
    }

    const caddyClubs = normaliseBag(remote.clubs);
    const decision = decideBagSync({
      booking: local,
      bookingUpdatedAt: iso(row?.updated_at),
      caddy: caddyClubs,
      caddyUpdatedAt: remote.updatedAt,
      lastSynced,
    });

    if (decision === "take_caddy") {
      const saved = await writeRow(account, person, caddyClubs, "caddy", bagFingerprint(caddyClubs));
      return { row: saved, state: "synced" };
    }
    if (decision === "send_to_caddy") {
      const sent = await writeCaddyBag(link.authUserId, link.email, local);
      const synced = row ? await markSynced(account, person, localPrint) : row;
      return { row: synced, state: sent?.pending === false ? "synced" : "waiting_for_phone" };
    }
    // Already the same bag. Remember that, so the next edit on either side is
    // recognised as the only change.
    if (row && lastSynced !== localPrint) return { row: await markSynced(account, person, localPrint), state: "synced" };
    return { row, state: "synced" };
  } catch (error) {
    console.warn("player_bag:caddy_sync_failed", error instanceof Error ? error.message : error);
    return { row, state: "unreachable" };
  }
}

/** The bag, after bringing it into step with Caddy where the player has an account. */
export async function readPlayerBag(accountId: string, personId: string, link: BagCaddyLink): Promise<PlayerBagView> {
  const { account, person } = scope(accountId, personId, "player_bag_read");
  if (!(await personExists(account, person))) {
    throw Object.assign(new Error("That player was not found."), { status: 404, code: "not_found" });
  }
  const synced = await syncWithCaddy(account, person, await readRow(account, person), link);
  return view(synced.row, synced.state);
}

/** Replaces the bag, then sends it to Caddy where the player has an account. */
export async function savePlayerBag(
  accountId: string,
  personId: string,
  clubs: unknown,
  by: Exclude<BagEditedBy, "caddy">,
  link: BagCaddyLink,
): Promise<PlayerBagView> {
  const { account, person } = scope(accountId, personId, "player_bag_save");
  if (!Array.isArray(clubs)) throw Object.assign(new Error("A bag is a list of clubs."), { status: 400, code: "invalid" });
  if (!(await personExists(account, person))) {
    throw Object.assign(new Error("That player was not found."), { status: 404, code: "not_found" });
  }
  const saved = await writeRow(account, person, normaliseBag(clubs), by, null);
  const synced = await syncWithCaddy(account, person, saved, link);
  return view(synced.row, synced.state);
}
