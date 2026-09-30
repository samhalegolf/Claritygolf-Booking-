import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * Keeps the two sides of compare moving as one while they are linked.
 *
 * Linked used to mean one thing: the play button started both. Stepping a
 * frame, scrubbing, jumping to a marker or changing speed still moved only the
 * side it was done on, and two videos left playing together drift apart --
 * which is exactly what two cameras filming the same swing cannot afford.
 *
 * So the link lives on the video elements rather than on the controls. Whatever
 * moves one side -- the action bar, the keyboard, the timeline, a drag on the
 * picture -- is an event on its element, and the other side follows. No
 * control has to remember to do it, and a new control cannot forget to.
 *
 * The two sides keep the gap they had when they were linked. Two cameras from
 * one Record press start together, so their gap is nothing. Two different
 * swings can be lined up at impact first and then linked, and they stay lined
 * up from there.
 */

/** Closer than this and the sides already agree. About one frame at 30 fps. */
const SEEK_TOLERANCE_S = 0.034;
/** While playing, drift beyond this is pulled back in. */
const DRIFT_TOLERANCE_S = 0.08;
const DRIFT_CHECK_MS = 250;

type Options = {
  enabled: boolean;
  leftRef: RefObject<HTMLVideoElement | null>;
  rightRef: RefObject<HTMLVideoElement | null>;
  /** Changes whenever either side's video element or clip changes. */
  sourceKey: string;
};

export function useLinkedPlayback({ enabled, leftRef, rightRef, sourceKey }: Options) {
  /** right.currentTime - left.currentTime, held while linked. */
  const offsetRef = useRef(0);
  /** Elements this hook is moving itself, so their events are not echoed back. */
  const followingRef = useRef(new Set<HTMLVideoElement>());

  useEffect(() => {
    const left = leftRef.current;
    const right = rightRef.current;
    if (!enabled || !left || !right) return;

    offsetRef.current = right.currentTime - left.currentTime;
    const following = followingRef.current;

    const other = (video: HTMLVideoElement) => (video === left ? right : left);
    const targetFor = (leader: HTMLVideoElement) =>
      leader === left ? leader.currentTime + offsetRef.current : leader.currentTime - offsetRef.current;

    const follow = (follower: HTMLVideoElement, time: number, tolerance: number) => {
      const duration = Number.isFinite(follower.duration) ? follower.duration : Infinity;
      const clamped = Math.max(0, Math.min(time, duration));
      if (Math.abs(follower.currentTime - clamped) <= tolerance) return;
      following.add(follower);
      follower.currentTime = clamped;
      // "seeked" clears it; this is the backstop for a seek the browser
      // swallowed, so a missed event cannot mute the side for good.
      window.setTimeout(() => following.delete(follower), 1000);
    };

    const onSeeking = (event: Event) => {
      const leader = event.target as HTMLVideoElement;
      if (following.has(leader)) return;
      follow(other(leader), targetFor(leader), SEEK_TOLERANCE_S);
    };
    const onSeeked = (event: Event) => {
      following.delete(event.target as HTMLVideoElement);
    };
    const onPlay = (event: Event) => {
      const follower = other(event.target as HTMLVideoElement);
      // A side that has run out of clip stays put rather than restarting.
      if (follower.paused && !follower.ended) void follower.play().catch(() => undefined);
    };
    const onPause = (event: Event) => {
      const leader = event.target as HTMLVideoElement;
      // The shorter clip reaching its end is not the coach pressing pause.
      if (leader.ended) return;
      const follower = other(leader);
      if (!follower.paused) follower.pause();
      follow(follower, targetFor(leader), SEEK_TOLERANCE_S);
    };
    const onRateChange = (event: Event) => {
      const leader = event.target as HTMLVideoElement;
      const follower = other(leader);
      if (follower.playbackRate !== leader.playbackRate) follower.playbackRate = leader.playbackRate;
    };

    const events: [string, EventListener][] = [
      ["seeking", onSeeking],
      ["seeked", onSeeked],
      ["play", onPlay],
      ["pause", onPause],
      ["ratechange", onRateChange],
    ];
    for (const video of [left, right]) {
      for (const [name, handler] of events) video.addEventListener(name, handler);
    }

    // Two elements decoding separately never stay exactly together. Left
    // leads; right is nudged back whenever it wanders.
    const drift = window.setInterval(() => {
      if (left.paused || right.paused || left.seeking || right.seeking) return;
      follow(right, left.currentTime + offsetRef.current, DRIFT_TOLERANCE_S);
    }, DRIFT_CHECK_MS);

    return () => {
      window.clearInterval(drift);
      for (const video of [left, right]) {
        for (const [name, handler] of events) video.removeEventListener(name, handler);
      }
      following.clear();
    };
  }, [enabled, leftRef, rightRef, sourceKey]);

  /**
   * Re-lines the two sides without the follow echoing it back: after this,
   * the link holds `offset` as the gap. Used by Sync playheads, which sets a
   * new gap on purpose.
   */
  const setOffset = useCallback((offset: number) => {
    offsetRef.current = offset;
  }, []);

  return { setOffset };
}
