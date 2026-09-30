/**
 * Which library clips are the same swing, filmed from two cameras.
 *
 * A coach filming face-on and down the line at once ends up with two clips
 * that belong together -- in the library, and in the 3D view, which fuses
 * them into one body. This decides which clips those are.
 *
 * THE EVIDENCE, STRONGEST FIRST
 *
 *   1. A link. Written when the 3D view lined two clips up and found one body
 *      in them, or when one press of a two-camera Clarity Terminal made them.
 *      A link always wins.
 *   2. A refusal. Written when the 3D view tried two clips and found they are
 *      NOT one swing. A refusal stops the recording-time rule below from ever
 *      pairing them again.
 *   3. Recording time. Two clips of the same player whose recordings started
 *      (or finished) within a few seconds of each other, and ran about as
 *      long. Only a recording time that is actually known counts: a file's
 *      load time says when the coach opened it, not when it was filmed, and
 *      two files dropped in together would otherwise always pair.
 *
 * Only pairs. Three cameras on one swing is not something the 3D view can
 * use yet, so a third clip at the same moment stays on its own.
 */

/** Recordings that start or finish this close together are one moment. */
export const SAME_SWING_TOLERANCE_MS = 3000;

export interface SwingAngleCandidate {
  readonly id: string;
  readonly playerId: string;
  /** When the recording started, ISO. Unset when it is not actually known. */
  readonly recordedAt?: string;
  /** Seconds. */
  readonly durationS?: number;
  /** A confirmed partner. */
  readonly linkedTo?: string;
  /** Clips proven not to be this swing. */
  readonly refused?: readonly string[];
}

const durationsAgree = (a?: number, b?: number): boolean => {
  if (!a || !b) return true;
  return Math.abs(a - b) <= Math.max(1.5, 0.25 * Math.max(a, b));
};

/**
 * How far apart two recordings are, milliseconds, or null when they cannot be
 * the same swing. The nearer of start-to-start and end-to-end, because a
 * phone that was started a moment late but stopped with the other one is
 * still the same swing.
 */
export const recordingGapMs = (a: SwingAngleCandidate, b: SwingAngleCandidate): number | null => {
  if (!a.recordedAt || !b.recordedAt) return null;
  if (!durationsAgree(a.durationS, b.durationS)) return null;
  const startA = Date.parse(a.recordedAt);
  const startB = Date.parse(b.recordedAt);
  if (!Number.isFinite(startA) || !Number.isFinite(startB)) return null;
  let gap = Math.abs(startA - startB);
  if (a.durationS && b.durationS) {
    gap = Math.min(gap, Math.abs(startA + a.durationS * 1000 - (startB + b.durationS * 1000)));
  }
  return gap <= SAME_SWING_TOLERANCE_MS ? gap : null;
};

const refuses = (a: SwingAngleCandidate, b: SwingAngleCandidate) =>
  Boolean(a.refused?.includes(b.id) || b.refused?.includes(a.id));

/**
 * Every clip's partner, both ways round: `result.get(a) === b` and
 * `result.get(b) === a`. Clips with no partner are absent.
 */
export const pairSameSwingAngles = (
  candidates: readonly SwingAngleCandidate[]
): Map<string, string> => {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const pairs = new Map<string, string>();
  const join = (a: string, b: string) => {
    pairs.set(a, b);
    pairs.set(b, a);
  };

  for (const candidate of candidates) {
    const partner = candidate.linkedTo ? byId.get(candidate.linkedTo) : undefined;
    if (!partner || partner.id === candidate.id) continue;
    if (pairs.has(candidate.id) || pairs.has(partner.id)) continue;
    join(candidate.id, partner.id);
  }

  // Closest recordings pair first, so a near-miss cannot steal a clip from
  // its true partner.
  const options: { a: string; b: string; gap: number }[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];
      if (a.playerId !== b.playerId || refuses(a, b)) continue;
      const gap = recordingGapMs(a, b);
      if (gap !== null) options.push({ a: a.id, b: b.id, gap });
    }
  }
  options.sort((x, y) => x.gap - y.gap);
  for (const option of options) {
    if (pairs.has(option.a) || pairs.has(option.b)) continue;
    // A clip with a link of its own only ever pairs with that link.
    if (byId.get(option.a)?.linkedTo || byId.get(option.b)?.linkedTo) continue;
    join(option.a, option.b);
  }

  return pairs;
};

/**
 * A list with each pair brought together, in the list's own order: a pair
 * sits where its first member did, and the second member is taken out of
 * its own place.
 */
export const groupSameSwingAngles = <T>(
  items: readonly T[],
  idOf: (item: T) => string,
  pairs: ReadonlyMap<string, string>
): T[][] => {
  const byId = new Map(items.map((item) => [idOf(item), item]));
  const placed = new Set<string>();
  const groups: T[][] = [];
  for (const item of items) {
    const id = idOf(item);
    if (placed.has(id)) continue;
    placed.add(id);
    const partnerId = pairs.get(id);
    const partner = partnerId ? byId.get(partnerId) : undefined;
    if (partner && partnerId && !placed.has(partnerId)) {
      placed.add(partnerId);
      groups.push([item, partner]);
    } else {
      groups.push([item]);
    }
  }
  return groups;
};
