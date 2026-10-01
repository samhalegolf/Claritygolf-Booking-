/**
 * Which frame of the second angle to show beside the swing's current frame.
 *
 * The second camera's clock is not the swing's: two phones never start on
 * the same frame, and a slow-motion export runs at another rate. Fusion has
 * already measured both (see `motion/fuse/twoView`), so the second clip's
 * time is `primary time × rate + offsetMs`. Without a usable fusion there is
 * nothing measured, and the two are shown from their own starts.
 */

import type { ObservationFrame } from "../observe/observation";
import type { TwoViewReport } from "../motion/fuse/twoView";

export const secondAngleFrameAt = (
  primaryMs: number,
  raw: readonly ObservationFrame[],
  fusion: Pick<TwoViewReport, "usable" | "rate" | "offsetMs"> | null
): ObservationFrame | null => {
  if (!raw.length) return null;
  const target = fusion?.usable ? primaryMs * fusion.rate + fusion.offsetMs : primaryMs;
  const first = raw[0].timestampMs;
  const last = raw[raw.length - 1].timestampMs;
  // Outside the second clip: it had not started yet, or has already stopped.
  const step = raw.length > 1 ? (last - first) / (raw.length - 1) : 0;
  if (target < first - step || target > last + step) return null;

  let lo = 0;
  let hi = raw.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (raw[mid].timestampMs < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && target - raw[lo - 1].timestampMs <= raw[lo].timestampMs - target) lo -= 1;
  return raw[lo];
};
