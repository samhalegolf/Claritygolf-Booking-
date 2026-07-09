
export type ClarityVoiceVocabularyCategory =
  | 'brand'
  | 'app'
  | 'club'
  | 'shot'
  | 'swing'
  | 'data'
  | 'course'
  | 'rules'
  | 'score'
  | 'environment'
  | 'booking'
  | 'custom';

export interface ClarityVoiceVocabularyTerm {
  phrase: string;
  canonical: string;
  category: ClarityVoiceVocabularyCategory;
  aliases?: string[];
  tags?: string[];
  summaryHint?: string;
}

export interface ClarityVoiceVocabularyMention {
  phrase: string;
  canonical: string;
  category: ClarityVoiceVocabularyCategory;
  summaryHint?: string;
  index: number;
}

export type ClarityVoiceState =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'starting'
  | 'listening'
  | 'thinking'
  | 'paused'
  | 'error';

export type ClarityVoiceErrorCode =
  | 'unsupported-browser'
  | 'insecure-context'
  | 'permission-denied'
  | 'microphone-unavailable'
  | 'no-speech'
  | 'network'
  | 'aborted'
  | 'already-started'
  | 'unknown';

export type ClarityVoiceAccentPreset =
  | 'en-NZ'
  | 'en-AU'
  | 'en-GB'
  | 'en-US'
  | 'en-CA'
  | 'en-IE'
  | 'en-ZA';

export type ClarityVoicePermissionState =
  | 'unknown'
  | 'prompt'
  | 'granted'
  | 'denied'
  | 'unavailable';

export type ClarityVoiceCapabilityStatus = 'supported' | 'limited' | 'unsupported';

export interface ClarityVoiceSupportReport {
  status: ClarityVoiceCapabilityStatus;
  isSupported: boolean;
  hasNativeSpeechRecognition: boolean;
  isSecureContext: boolean;
  hasMediaDevices: boolean;
  permissionState: ClarityVoicePermissionState;
  supportsContinuous: boolean;
  supportsInterimResults: boolean;
  supportsAlternatives: boolean;
  supportsOnDeviceAvailabilityCheck: boolean;
  supportsOnDeviceInstall: boolean;
  notes: string[];
}

export interface ClarityVoiceTranscriptAlternative {
  transcript: string;
  confidence: number | null;
  score: number;
}

export interface ClarityVoicePauseStats {
  lastSpeechAt: number | null;
  lastFinalAt: number | null;
  lastPauseMs: number | null;
  pauseCount: number;
  fillerCount: number;
  rejectedFillerCount: number;
}

export interface ClarityVoiceTranscript {
  finalText: string;
  interimText: string;
  combinedText: string;
  confidence: number | null;
  alternatives: ClarityVoiceTranscriptAlternative[];
  pauseStats: ClarityVoicePauseStats;
  updatedAt: number;
}

export interface ClarityVoiceSmartEntities {
  lessonTypes: string[];
  durations: string[];
  paymentMentions: string[];
  equipmentMentions: string[];
  swingPatternMentions: string[];
  bookingIntent: 'create' | 'cancel' | 'reschedule' | 'complete' | null;
  vocabularyMentions: ClarityVoiceVocabularyMention[];
}

export interface ClarityVoiceSmartNote {
  rawText: string;
  cleanedText: string;
  title: string;
  bullets: string[];
  entities: ClarityVoiceSmartEntities;
  confidenceHint: 'low' | 'medium' | 'high' | null;
}

export interface ClarityVoiceAudioActivity {
  isAvailable: boolean;
  isMonitoring: boolean;
  isSpeaking: boolean;
  level: number;
  noiseFloor: number;
  updatedAt: number;
}

export interface ClarityVoiceOptions {
  /** English only. Defaults to en-NZ for Sam/Clarity unless overridden. */
  lang?: ClarityVoiceAccentPreset;
  continuous?: boolean;
  interimResults?: boolean;
  /** Use 3-5 for smarter alternative selection when supported. */
  maxAlternatives?: number;
  /** Browser recognition often ends unexpectedly. This restarts unless the user manually stops. */
  autoRestart?: boolean;
  /** Stops after no new speech events. Null disables. */
  silenceAutoStopMs?: number | null;
  /** Stops sooner after a final result and a human pause. Null disables. */
  endpointAfterPauseMs?: number | null;
  /** Removes a small list of obvious profanities from final text. */
  profanityFilter?: boolean;
  /** Ask/check microphone before starting. Helps produce cleaner unsupported/permission errors. */
  requireMicrophonePermission?: boolean;
  /** Restarts after no-speech/network hiccups when autoRestart is true. */
  restartDelayMs?: number;
  /** Local domain vocabulary used to score recognition alternatives. */
  domainPhrases?: string[];
  /** Brand/golf/booking jargon to normalise, score, extract, and store. */
  vocabularyTerms?: ClarityVoiceVocabularyTerm[];
  /** Experimental Chrome on-device recognition flag, ignored where unsupported. */
  preferOnDevice?: boolean;
  /** Drops standalone filler sounds from final text and keeps count for diagnostics. */
  suppressFillers?: boolean;
  /** Adds local punctuation and line breaks around likely pauses. */
  smartPunctuation?: boolean;
  /** Optional microphone energy monitor for speak/pause UI. Does not replace speech recognition. */
  audioActivityMonitor?: boolean;
}

export interface ClarityVoiceCallbacks {
  onStateChange?: (state: ClarityVoiceState) => void;
  onTranscript?: (transcript: ClarityVoiceTranscript) => void;
  onFinalText?: (finalText: string, transcript: ClarityVoiceTranscript) => void;
  onError?: (error: ClarityVoiceError) => void;
  onSupportReport?: (report: ClarityVoiceSupportReport) => void;
  onAudioActivity?: (activity: ClarityVoiceAudioActivity) => void;
}

export interface ClarityVoiceError {
  code: ClarityVoiceErrorCode;
  message: string;
  nativeError?: string;
}

export interface ClarityVoiceController {
  readonly isSupported: boolean;
  readonly state: ClarityVoiceState;
  readonly transcript: ClarityVoiceTranscript;
  readonly supportReport: ClarityVoiceSupportReport;
  readonly audioActivity: ClarityVoiceAudioActivity;
  start(): Promise<void>;
  stop(): void;
  abort(): void;
  reset(): void;
  setLanguage(lang: ClarityVoiceAccentPreset): void;
  refreshSupportReport(): Promise<ClarityVoiceSupportReport>;
  destroy(): void;
}
