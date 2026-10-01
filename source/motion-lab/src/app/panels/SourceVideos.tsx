/**
 * The clips behind the 3D, beside it: the swing, and the second angle under
 * it when there is one.
 *
 * The second angle follows the swing's playhead through the offset and rate
 * fusion measured, so both pictures show the same instant of the swing. It
 * is shown even when it did not fuse -- the readout says why -- so a clip
 * that was picked never seems to vanish.
 */

import type { SceneLayers } from "../../space3d/layers";
import type { ObservationFrame } from "../../observe/observation";
import { secondAngleFrameAt } from "../secondAngleSync";
import type { VideoObservationState } from "../useVideoObservation";
import { VideoPanel } from "./VideoPanel";

export function SourceVideos({
  state,
  frame,
  showLowConfidence,
  layers,
}: {
  state: VideoObservationState;
  /** The swing's raw frame under the playhead. */
  frame: ObservationFrame | null;
  showLowConfidence: boolean;
  layers: SceneLayers;
}) {
  const { videoUrl, result, secondVideoUrl, secondRaw, secondInfo, fusion } = state;
  if (!videoUrl) return null;
  const secondFrame =
    secondVideoUrl && frame ? secondAngleFrameAt(frame.timestampMs, secondRaw, fusion) : null;
  return (
    <div className={`lab-stage-videos${secondVideoUrl ? " has-second" : ""}`}>
      <VideoPanel
        videoUrl={videoUrl}
        frame={frame}
        width={result?.info.width ?? 16}
        height={result?.info.height ?? 9}
        showLowConfidence={showLowConfidence}
        layers={layers}
      />
      {secondVideoUrl && (
        <VideoPanel
          videoUrl={secondVideoUrl}
          frame={secondFrame}
          width={secondInfo?.width ?? 16}
          height={secondInfo?.height ?? 9}
          showLowConfidence={showLowConfidence}
          layers={layers}
        />
      )}
    </div>
  );
}
