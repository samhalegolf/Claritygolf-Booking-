import type { ClarityVoiceAudioActivity } from './types';

const EMPTY_ACTIVITY: ClarityVoiceAudioActivity = {
  isAvailable: false,
  isMonitoring: false,
  isSpeaking: false,
  level: 0,
  noiseFloor: 0,
  updatedAt: 0
};

export type ClarityVoiceAudioActivityCallback = (activity: ClarityVoiceAudioActivity) => void;

export class ClarityVoiceAudioMonitor {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private frameId: number | null = null;
  private noiseFloor = 0.012;
  private callback: ClarityVoiceAudioActivityCallback | null;
  private activity: ClarityVoiceAudioActivity = EMPTY_ACTIVITY;

  constructor(callback?: ClarityVoiceAudioActivityCallback) {
    this.callback = callback ?? null;
  }

  get current(): ClarityVoiceAudioActivity {
    return this.activity;
  }

  async start(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.emit({ ...EMPTY_ACTIVITY, updatedAt: Date.now() });
      return;
    }

    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const AudioContextRef = window.AudioContext ?? window.webkitAudioContext;
    this.audioContext = new AudioContextRef();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 1024;
    source.connect(this.analyser);
    this.tick();
  }

  stop(): void {
    if (this.frameId !== null) window.cancelAnimationFrame(this.frameId);
    this.frameId = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
    this.analyser = null;
    this.emit({ ...this.activity, isMonitoring: false, isSpeaking: false, level: 0, updatedAt: Date.now() });
  }

  destroy(): void {
    this.stop();
    this.callback = null;
  }

  private tick = (): void => {
    if (!this.analyser) return;
    const buffer = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(buffer);

    let sum = 0;
    for (const value of buffer) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }

    const rms = Math.sqrt(sum / buffer.length);
    this.noiseFloor = this.noiseFloor * 0.96 + Math.min(rms, 0.08) * 0.04;
    const speakingThreshold = Math.max(0.018, this.noiseFloor * 2.8);

    this.emit({
      isAvailable: true,
      isMonitoring: true,
      isSpeaking: rms > speakingThreshold,
      level: Number(rms.toFixed(4)),
      noiseFloor: Number(this.noiseFloor.toFixed(4)),
      updatedAt: Date.now()
    });

    this.frameId = window.requestAnimationFrame(this.tick);
  };

  private emit(activity: ClarityVoiceAudioActivity): void {
    this.activity = activity;
    this.callback?.(activity);
  }
}
