/**
 * A player's golf bag: the clubs they carry and how far each one carries.
 *
 * Pure, so the coach console, the player portal and the server all share one
 * answer. It deliberately follows Clarity Caddy's rules (GolfDaddy
 * scripts/gd-bag-core.js and scripts/gd-bag-generator-core.js) because the two
 * bags sync: a club, a carry and an order that meant something different on
 * each side would make every sync look like an edit.
 *
 *   - A club row is { club, baseCarry, totalM }, metres, the shape Caddy stores.
 *   - Longest club first. Total breaks ties, then carry.
 *   - Club names are matched case-insensitively ("7i" and "7I" are one club).
 *   - Totals are carry plus roll-out at Caddy's "normal" ground. Caddy
 *     re-derives its own totals from its firmness setting, so a total is
 *     never treated as part of the bag's identity -- see bagFingerprint.
 */

export type BagClub = { club: string; baseCarry: number; totalM: number };

export const BAG_MAX_CLUBS = 20;
export const BAG_MIN_CARRY = 20;
export const BAG_MAX_CARRY = 400;
const CLUB_NAME_MAX = 24;

/* Caddy's GD_CLUB_GROUPS and shipped roll-out, verbatim. Medium ground only. */
const CLUB_GROUPS = { driver: /driver/i, woodHybrid: /3w|wood|hybrid|4h/i, wedge: /pw|gw|sw|lw|wedge/i };
const ROLLOUT_PCT = { driver: 0.11, iron: 0.075, wedge: 0.047, woodHybrid: 0.075 * 1.35 };

function rolloutGroup(club: string): keyof typeof ROLLOUT_PCT {
  if (CLUB_GROUPS.driver.test(club)) return "driver";
  if (CLUB_GROUPS.woodHybrid.test(club)) return "woodHybrid";
  if (CLUB_GROUPS.wedge.test(club)) return "wedge";
  return "iron";
}

export function totalForCarry(club: string, carry: number): number {
  const c = Math.max(0, Math.round(Number(carry) || 0));
  if (!c) return 0;
  return Math.max(c, Math.round(c * (1 + ROLLOUT_PCT[rolloutGroup(club)])));
}

export function clubKey(club: unknown): string {
  return String(club ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

function clampCarry(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(BAG_MIN_CARRY, Math.min(BAG_MAX_CARRY, n));
}

/**
 * Anything bag-shaped in, a clean bag out: named clubs with a carry, no
 * duplicates (first one wins), at most BAG_MAX_CLUBS, longest first. Accepts
 * Caddy's older row spellings (name / carry) so a bag read back from Caddy
 * needs no translation first.
 */
export function normaliseBag(rows: unknown): BagClub[] {
  const seen = new Set<string>();
  const out: BagClub[] = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    if (!raw || typeof raw !== "object" || (raw as { ghost?: unknown }).ghost) continue;
    const row = raw as Record<string, unknown>;
    const club = String(row.club ?? row.name ?? "").trim().slice(0, CLUB_NAME_MAX);
    const baseCarry = clampCarry(row.baseCarry ?? row.carry);
    const key = clubKey(club);
    if (!club || !baseCarry || seen.has(key)) continue;
    seen.add(key);
    out.push({ club, baseCarry, totalM: totalForCarry(club, baseCarry) });
  }
  return sortBag(out).slice(0, BAG_MAX_CLUBS);
}

export function sortBag(rows: BagClub[]): BagClub[] {
  return [...rows].sort((a, b) => b.totalM - a.totalM || b.baseCarry - a.baseCarry);
}

/**
 * What makes two bags the same bag: the clubs and their carries. Totals are
 * left out on purpose -- Caddy recomputes them from the player's firmness
 * setting, so the same bag can come back with different totals.
 */
export function bagFingerprint(rows: unknown): string {
  return normaliseBag(rows)
    .map((row) => `${clubKey(row.club)}:${row.baseCarry}`)
    .sort()
    .join("|");
}

// ---------------------------------------------------------------------------
// Edits. Each returns the new bag, or why it was refused -- a code, so the
// screen words it in the reader's language.
// ---------------------------------------------------------------------------

export type BagEditError = "needsName" | "needsCarry" | "duplicate" | "full" | "sevenIronFirst";
export type BagEditResult = { clubs: BagClub[]; error?: BagEditError };

export function addClub(rows: BagClub[], club: string, carry: unknown): BagEditResult {
  const clubs = normaliseBag(rows);
  const name = String(club || "").trim().slice(0, CLUB_NAME_MAX);
  const metres = clampCarry(carry);
  if (!name) return { clubs, error: "needsName" };
  if (!metres) return { clubs, error: "needsCarry" };
  if (clubs.some((row) => clubKey(row.club) === clubKey(name))) return { clubs, error: "duplicate" };
  if (clubs.length >= BAG_MAX_CLUBS) return { clubs, error: "full" };
  return { clubs: normaliseBag([...clubs, { club: name, baseCarry: metres }]) };
}

export function updateClub(rows: BagClub[], club: string, next: { club?: string; carry?: unknown }): BagEditResult {
  const clubs = normaliseBag(rows);
  const current = clubs.find((row) => clubKey(row.club) === clubKey(club));
  if (!current) return { clubs };
  const name = next.club === undefined ? current.club : String(next.club).trim().slice(0, CLUB_NAME_MAX);
  const metres = next.carry === undefined ? current.baseCarry : clampCarry(next.carry);
  if (!name) return { clubs, error: "needsName" };
  if (!metres) return { clubs, error: "needsCarry" };
  if (clubKey(name) !== clubKey(current.club) && clubs.some((row) => clubKey(row.club) === clubKey(name))) {
    return { clubs, error: "duplicate" };
  }
  return {
    clubs: normaliseBag(clubs.map((row) => (row === current ? { club: name, baseCarry: metres } : row))),
  };
}

export function removeClub(rows: BagClub[], club: string): BagClub[] {
  return normaliseBag(rows).filter((row) => clubKey(row.club) !== clubKey(club));
}

// ---------------------------------------------------------------------------
// The generator: a whole bag from one 7-iron carry.
//
// Caddy's speed/loft ladder (gd-bag-generator-core.js generate()), ported
// as is, so a bag generated here and one generated on the course from the same
// 7-iron are the same bag -- and sync as unchanged.
// ---------------------------------------------------------------------------

type HeadType = "driver" | "fairway" | "hybrid" | "iron" | "wedge";
const STANDARD: Array<[string, number, HeadType, number]> = [
  ["Driver", 10.5, "driver", 230], ["3W", 15, "fairway", 205], ["4H", 22, "hybrid", 180],
  ["4i", 24, "iron", 178], ["5i", 26, "iron", 170], ["6i", 28, "iron", 160], ["7i", 32, "iron", 155],
  ["8i", 36, "iron", 142], ["9i", 40, "iron", 130], ["PW", 45, "wedge", 115], ["GW", 50, "wedge", 98],
  ["SW", 55, "wedge", 82], ["LW", 59, "wedge", 66],
];

export const STANDARD_CLUBS = STANDARD.map((entry) => entry[0]);
export const DEFAULT_SEVEN_IRON = 155;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function interpolate(points: Array<[number, number]>, x: number) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (x <= points[i][0]) {
      const a = points[i - 1];
      const b = points[i];
      return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
    }
  }
  return points[points.length - 1][1];
}

function descriptor(label: string) {
  const name = String(label || "").trim() || "Club";
  const normal = clubKey(name);
  const known = STANDARD.find((entry) => clubKey(entry[0]) === normal);
  if (known) return { club: name, loft: known[1], headType: known[2], reference: known[3] as number | null };
  const headType: HeadType = /driver|\b1w\b/.test(normal) ? "driver"
    : /\b(?:3|5|7|9)w\b|wood/.test(normal) ? "fairway"
    : /\d\s*h\b|\d+h\b|hybrid|rescue/.test(normal) ? "hybrid"
    : /\bpw\b|\bgw\b|\baw\b|\bsw\b|\blw\b|wedge/.test(normal) ? "wedge" : "iron";
  const match = normal.match(/(\d{1,2}(?:\.\d+)?)\s*(?:°|deg)?/);
  let loft: number | null = match ? Number(match[1]) : null;
  if (headType === "iron" && /\d\s*i\b|\d+i\b|iron/.test(normal)) {
    const iron = normal.match(/(\d+)\s*i/);
    if (iron) loft = 16 + Number(iron[1]) * 2;
  }
  const fallbackLoft = { driver: 10.5, fairway: 18, hybrid: 22, iron: 32, wedge: 52 }[headType];
  return { club: name, loft: loft == null ? fallbackLoft : clamp(loft, 8, 64), headType, reference: null as number | null };
}

function referenceCarry(desc: ReturnType<typeof descriptor>) {
  if (desc.reference) return desc.reference;
  let same = STANDARD.filter((entry) => entry[2] === desc.headType);
  if (same.length < 2) same = STANDARD.filter((entry) => entry[2] === "iron" || entry[2] === "wedge");
  const points = same.map((entry) => [entry[1], entry[3]] as [number, number]).sort((a, b) => a[0] - b[0]);
  const efficiency = { driver: 1.08, fairway: 1.025, hybrid: 1.01, iron: 1, wedge: 0.97 }[desc.headType] || 1;
  return interpolate(points, desc.loft) * efficiency;
}

function gapFactor(headType: HeadType, carry: number) {
  const x = clamp((carry - 155) / 65, -1, 0.46);
  const ends = {
    driver: [0.45, 1.3], fairway: [0.46, 1.27], hybrid: [0.56, 1.21], iron: [0.78, 1.11], wedge: [0.6, 1.42],
  }[headType];
  return x < 0 ? 1 + x * (1 - ends[0]) : 1 + x * (ends[1] - 1);
}

function carryFor(desc: ReturnType<typeof descriptor>, sevenCarry: number) {
  let estimate = sevenCarry + (referenceCarry(desc) - 155) * gapFactor(desc.headType, sevenCarry);
  if (desc.headType === "wedge" && sevenCarry < 130) estimate = Math.max(estimate, sevenCarry - 55);
  return estimate;
}

/** The full bag from a 7-iron carry, the 7-iron held exactly. */
export function generateBag(sevenIronCarry: unknown, labels: string[] = STANDARD_CLUBS): BagClub[] {
  const seven = Math.round(clamp(Number(sevenIronCarry) || DEFAULT_SEVEN_IRON, 90, 185));
  const list = labels.length ? labels : STANDARD_CLUBS;
  const rows = list.map((label) => {
    const desc = descriptor(label);
    return { club: desc.club, baseCarry: Math.max(20, Math.round(carryFor(desc, seven))) };
  });
  const locked = rows.find((row) => /^7\s*i(?:ron)?$/i.test(row.club.trim()));
  if (locked) locked.baseCarry = seven;
  rows.sort((a, b) => b.baseCarry - a.baseCarry);
  const at = locked ? rows.indexOf(locked) : 0;
  for (let i = at + 1; i < rows.length; i++) rows[i].baseCarry = Math.min(rows[i].baseCarry, rows[i - 1].baseCarry - 1);
  for (let j = at - 1; j >= 0; j--) rows[j].baseCarry = Math.max(rows[j].baseCarry, rows[j + 1].baseCarry + 1);
  return normaliseBag(rows.map((row) => ({ club: row.club, baseCarry: Math.max(20, row.baseCarry) })));
}

/**
 * Fills the gaps in an existing bag from its 7-iron (or the one given). Clubs
 * already in the bag keep their numbers -- they are the player's own.
 */
export function generateRest(rows: BagClub[], sevenIronCarry?: unknown): BagEditResult & { added: number } {
  const clubs = normaliseBag(rows);
  const seven = Number(sevenIronCarry) || clubs.find((row) => clubKey(row.club) === "7i")?.baseCarry || 0;
  if (!(seven > 0)) return { clubs, added: 0, error: "sevenIronFirst" };
  const present = new Set(clubs.map((row) => clubKey(row.club)));
  const additions = generateBag(seven).filter((row) => !present.has(clubKey(row.club)));
  return { clubs: normaliseBag([...clubs, ...additions]), added: additions.length };
}

// ---------------------------------------------------------------------------
// Sync with Clarity Caddy. The storage and the calls are player-bag.mts; the
// types and the rule live here so the screens can share them.
// ---------------------------------------------------------------------------

export type BagEditedBy = "coach" | "player" | "caddy";

/** Who the player is in Caddy: their shared login. Null without portal access. */
export type BagCaddyLink = { authUserId: string; email: string } | null;

export type BagCaddyState =
  /** No portal login, so no shared identity to match a Caddy account by. */
  | "not_linked"
  /** This deployment has no Caddy connection configured. */
  | "not_configured"
  /** The player has a login but no Clarity Caddy account. */
  | "no_account"
  /** Both bags are the same. */
  | "synced"
  /** Sent to Caddy; the player's phone picks it up next time Caddy opens. */
  | "waiting_for_phone"
  /** Caddy could not be reached this time. The bag here is still saved. */
  | "unreachable";

export type PlayerBagView = {
  clubs: BagClub[];
  updatedAt: string | null;
  updatedBy: BagEditedBy | null;
  caddy: { state: BagCaddyState; syncedAt: string | null };
};


export type BagSyncInput = {
  /** Booking's bag now. */
  booking: BagClub[];
  bookingUpdatedAt: string | null;
  /** Caddy's bag now. */
  caddy: BagClub[];
  caddyUpdatedAt: string | null;
  /** Fingerprint of the bag both sides last agreed on; null before the first sync. */
  lastSynced: string | null;
};

/** What to do so both sides hold the same bag. */
export type BagSyncDecision = "in_sync" | "take_caddy" | "send_to_caddy";

/**
 * A three-way merge, with the last agreed bag as the common ancestor:
 *
 *   - Only one side changed since the last sync: that side wins.
 *   - Both changed, or they have never synced: an empty bag never wins over a
 *     real one, and otherwise the more recent edit wins.
 *
 * Nothing is merged club by club. A bag is one thing the player set; mixing
 * two of them would produce a bag nobody chose.
 */
export function decideBagSync(input: BagSyncInput): BagSyncDecision {
  const booking = bagFingerprint(input.booking);
  const caddy = bagFingerprint(input.caddy);
  if (booking === caddy) return "in_sync";
  if (input.lastSynced !== null) {
    if (booking === input.lastSynced) return "take_caddy";
    if (caddy === input.lastSynced) return "send_to_caddy";
  }
  if (!booking) return "take_caddy";
  if (!caddy) return "send_to_caddy";
  const bookingAt = Date.parse(input.bookingUpdatedAt || "") || 0;
  const caddyAt = Date.parse(input.caddyUpdatedAt || "") || 0;
  return caddyAt > bookingAt ? "take_caddy" : "send_to_caddy";
}
