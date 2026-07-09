import type { ClarityVoiceAudioActivity } from './types';

export interface ClarityVoiceVadDecision {
  isSpeech: boolean;
  probability: number | null;
  startedAt?: number;
  endedAt?: number;
}

export interface ClarityVoiceVadAdapter {
  readonly name: string;
  start(onDecision: (decision: ClarityVoiceVadDecision) => void): Promise<void>;
  stop(): void;
  destroy(): void;
}

/**
 * Tiny dependency-free fallback VAD built from the WebAudio activity monitor output.
 * It is not as accurate as Silero/WebRTC VAD, but it gives the UI human-like
 * speaking/pause feedback without adding a model bundle to the booking app.
 */
export function createEnergyVadDecision(activity: ClarityVoiceAudioActivity): ClarityVoiceVadDecision {
  const floor = Math.max(activity.noiseFloor, 0.001);
  const ratio = activity.level / floor;
  const probability = Math.max(0, Math.min(1, (ratio - 1.4) / 2.8));
  return {
    isSpeech: activity.isSpeaking,
    probability: Number(probability.toFixed(3)),
    startedAt: activity.isSpeaking ? activity.updatedAt : undefined,
    endedAt: activity.isSpeaking ? undefined : activity.updatedAt
  };
}
