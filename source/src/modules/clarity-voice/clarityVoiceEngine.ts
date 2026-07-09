import { ClarityVoiceAudioMonitor } from './clarityVoiceAudioMonitor';
import { getClarityVoiceSupportReport, getSpeechRecognitionConstructor, requestMicrophoneAccess, type SpeechRecognitionConstructor } from './clarityVoiceCompatibility';
import { buildVocabularyPhrases, DEFAULT_CLARITY_VOICE_VOCABULARY, mergeClarityVocabularyTerms } from './clarityVoiceVocabulary';
import { cleanClarityTranscript, scoreTranscriptAlternative, suppressDictationFillers } from './clarityVoiceTextCleaner';
import type {
  ClarityVoiceAccentPreset,
  ClarityVoiceAudioActivity,
  ClarityVoiceCallbacks,
  ClarityVoiceController,
  ClarityVoiceError,
  ClarityVoiceErrorCode,
  ClarityVoiceOptions,
  ClarityVoicePauseStats,
  ClarityVoiceState,
  ClarityVoiceSupportReport,
  ClarityVoiceTranscript,
  ClarityVoiceTranscriptAlternative
} from './types';

type NativeSpeechRecognition = SpeechRecognition;

const DEFAULT_DOMAIN_PHRASES = buildVocabularyPhrases(DEFAULT_CLARITY_VOICE_VOCABULARY);

const DEFAULT_SUPPORT_REPORT: ClarityVoiceSupportReport = {
  status: 'unsupported',
  isSupported: false,
  hasNativeSpeechRecognition: false,
  isSecureContext: false,
  hasMediaDevices: false,
  permissionState: 'unknown',
  supportsContinuous: false,
  supportsInterimResults: false,
  supportsAlternatives: false,
  supportsOnDeviceAvailabilityCheck: false,
  supportsOnDeviceInstall: false,
  notes: []
};

const DEFAULT_AUDIO_ACTIVITY: ClarityVoiceAudioActivity = {
  isAvailable: false,
  isMonitoring: false,
  isSpeaking: false,
  level: 0,
  noiseFloor: 0,
  updatedAt: 0
};

const DEFAULT_PAUSE_STATS: ClarityVoicePauseStats = {
  lastSpeechAt: null,
  lastFinalAt: null,
  lastPauseMs: null,
  pauseCount: 0,
  fillerCount: 0,
  rejectedFillerCount: 0
};

const DEFAULT_OPTIONS: Required<ClarityVoiceOptions> = {
  lang: 'en-NZ',
  continuous: true,
  interimResults: true,
  maxAlternatives: 5,
  autoRestart: false,
  silenceAutoStopMs: null,
  endpointAfterPauseMs: 1800,
  profanityFilter: false,
  requireMicrophonePermission: false,
  restartDelayMs: 450,
  domainPhrases: DEFAULT_DOMAIN_PHRASES,
  vocabularyTerms: DEFAULT_CLARITY_VOICE_VOCABULARY,
  preferOnDevice: false,
  suppressFillers: true,
  smartPunctuation: true,
  audioActivityMonitor: false
};

export function getClarityVoiceSupport(): {
  isSupported: boolean;
  constructorRef: SpeechRecognitionConstructor | undefined;
} {
  const constructorRef = getSpeechRecognitionConstructor();
  return { isSupported: Boolean(constructorRef), constructorRef };
}

export function createClarityVoiceController(
  options: ClarityVoiceOptions = {},
  callbacks: ClarityVoiceCallbacks = {}
): ClarityVoiceController {
  const merged: Required<ClarityVoiceOptions> = { ...DEFAULT_OPTIONS, ...options };
  const effectiveVocabulary = mergeClarityVocabularyTerms(DEFAULT_CLARITY_VOICE_VOCABULARY, merged.vocabularyTerms);
  const effectiveDomainPhrases = buildVocabularyPhrases(effectiveVocabulary).concat(merged.domainPhrases);
  const support = getClarityVoiceSupport();

  let recognition: NativeSpeechRecognition | null = null;
  let state: ClarityVoiceState = support.isSupported ? 'idle' : 'unsupported';
  let supportReport: ClarityVoiceSupportReport = { ...DEFAULT_SUPPORT_REPORT, isSupported: support.isSupported, hasNativeSpeechRecognition: support.isSupported };
  let audioActivity: ClarityVoiceAudioActivity = DEFAULT_AUDIO_ACTIVITY;
  let audioMonitor: ClarityVoiceAudioMonitor | null = null;
  let manuallyStopped = false;
  let finalText = '';
  let interimText = '';
  let confidence: number | null = null;
  let alternatives: ClarityVoiceTranscriptAlternative[] = [];
  let pauseStats: ClarityVoicePauseStats = { ...DEFAULT_PAUSE_STATS };
  let silenceTimer: number | null = null;
  let endpointTimer: number | null = null;
  let restartTimer: number | null = null;

  const transcript = (): ClarityVoiceTranscript => ({
    finalText,
    interimText,
    combinedText: joinTranscript(finalText, interimText),
    confidence,
    alternatives,
    pauseStats: { ...pauseStats },
    updatedAt: Date.now()
  });

  const setState = (next: ClarityVoiceState) => {
    state = next;
    callbacks.onStateChange?.(state);
  };

  const emitTranscript = () => {
    const current = transcript();
    callbacks.onTranscript?.(current);
    if (finalText.trim()) callbacks.onFinalText?.(finalText.trim(), current);
  };

  const emitAudioActivity = (activity: ClarityVoiceAudioActivity) => {
    audioActivity = activity;
    callbacks.onAudioActivity?.(activity);
  };

  const clearTimers = () => {
    if (silenceTimer !== null) window.clearTimeout(silenceTimer);
    if (endpointTimer !== null) window.clearTimeout(endpointTimer);
    if (restartTimer !== null) window.clearTimeout(restartTimer);
    silenceTimer = null;
    endpointTimer = null;
    restartTimer = null;
  };

  const armSilenceTimer = () => {
    if (silenceTimer !== null) window.clearTimeout(silenceTimer);
    if (!merged.silenceAutoStopMs || merged.silenceAutoStopMs <= 0) return;
    silenceTimer = window.setTimeout(() => {
      if (state === 'listening') controller.stop();
    }, merged.silenceAutoStopMs);
  };

  const armEndpointTimer = () => {
    if (endpointTimer !== null) window.clearTimeout(endpointTimer);
    if (!merged.endpointAfterPauseMs || merged.endpointAfterPauseMs <= 0) return;
    endpointTimer = window.setTimeout(() => {
      if (state === 'listening' && pauseStats.lastFinalAt) setState('thinking');
    }, merged.endpointAfterPauseMs);
  };

  const configureRecognition = () => {
    if (!support.constructorRef) return null;
    const instance = new support.constructorRef();
    instance.lang = merged.lang;
    instance.continuous = merged.continuous;
    instance.interimResults = merged.interimResults;
    instance.maxAlternatives = merged.maxAlternatives;

    instance.onstart = () => {
      manuallyStopped = false;
      setState('listening');
      armSilenceTimer();
    };

    instance.onspeechstart = () => {
      const now = Date.now();
      if (pauseStats.lastSpeechAt) {
        const pauseMs = now - pauseStats.lastSpeechAt;
        if (pauseMs > 650) {
          pauseStats = { ...pauseStats, lastPauseMs: pauseMs, pauseCount: pauseStats.pauseCount + 1 };
        }
      }
      pauseStats = { ...pauseStats, lastSpeechAt: now };
      if (state === 'thinking' || state === 'paused') setState('listening');
    };

    instance.onspeechend = () => {
      pauseStats = { ...pauseStats, lastSpeechAt: Date.now() };
      armEndpointTimer();
    };

    instance.onresult = (event: SpeechRecognitionEvent) => {
      armSilenceTimer();
      if (endpointTimer !== null) window.clearTimeout(endpointTimer);

      let freshInterim = '';
      let freshFinal = '';
      let latestConfidence: number | null = confidence;
      const freshAlternatives: ClarityVoiceTranscriptAlternative[] = [];

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const selected = chooseBestAlternative(result, effectiveDomainPhrases, effectiveVocabulary);
        if (!selected) continue;
        latestConfidence = selected.confidence ?? latestConfidence;
        freshAlternatives.push(selected);
        if (result.isFinal) freshFinal = joinTranscript(freshFinal, selected.transcript);
        else freshInterim = joinTranscript(freshInterim, selected.transcript);
      }

      if (freshFinal.trim()) {
        let nextFinal = freshFinal;
        if (merged.suppressFillers) {
          const suppressed = suppressDictationFillers(nextFinal);
          nextFinal = suppressed.text;
          pauseStats = {
            ...pauseStats,
            fillerCount: pauseStats.fillerCount + suppressed.fillerCount,
            rejectedFillerCount: pauseStats.rejectedFillerCount + suppressed.rejectedFillerCount,
            lastFinalAt: Date.now()
          };
        } else {
          pauseStats = { ...pauseStats, lastFinalAt: Date.now() };
        }

        finalText = cleanClarityTranscript(joinTranscript(finalText, nextFinal), {
          removeFillers: merged.suppressFillers,
          smartPunctuation: merged.smartPunctuation,
          profanityFilter: merged.profanityFilter,
          vocabularyTerms: effectiveVocabulary
        });
      }

      interimText = merged.suppressFillers ? suppressDictationFillers(freshInterim).text : freshInterim.trim();
      confidence = latestConfidence;
      alternatives = freshAlternatives;
      emitTranscript();
      armEndpointTimer();
    };

    instance.onerror = (event: SpeechRecognitionErrorEvent) => {
      clearTimers();
      const mapped = mapNativeSpeechError(event.error);
      callbacks.onError?.(mapped);
      if (mapped.code === 'no-speech' && merged.autoRestart && !manuallyStopped) {
        scheduleRestart();
        return;
      }
      setState(mapped.code === 'aborted' ? 'idle' : 'error');
    };

    instance.onend = () => {
      if (silenceTimer !== null) window.clearTimeout(silenceTimer);
      if (endpointTimer !== null) window.clearTimeout(endpointTimer);
      interimText = '';
      emitTranscript();

      if (!manuallyStopped && merged.autoRestart && state !== 'error') {
        scheduleRestart();
        return;
      }

      if (state !== 'error' && state !== 'unsupported') setState('idle');
    };

    return instance;
  };

  const scheduleRestart = () => {
    if (restartTimer !== null) window.clearTimeout(restartTimer);
    setState('starting');
    restartTimer = window.setTimeout(() => {
      try {
        recognition = configureRecognition();
        recognition?.start();
      } catch {
        setState('idle');
      }
    }, merged.restartDelayMs);
  };

  const controller: ClarityVoiceController = {
    get isSupported() {
      return support.isSupported;
    },
    get state() {
      return state;
    },
    get transcript() {
      return transcript();
    },
    get supportReport() {
      return supportReport;
    },
    get audioActivity() {
      return audioActivity;
    },
    async refreshSupportReport() {
      supportReport = await getClarityVoiceSupportReport();
      callbacks.onSupportReport?.(supportReport);
      return supportReport;
    },
    async start() {
      if (!support.isSupported) {
        setState('unsupported');
        callbacks.onError?.({ code: 'unsupported-browser', message: 'Speech recognition is not available in this browser.' });
        return;
      }

      if (state === 'listening' || state === 'starting' || state === 'checking') return;

      if (typeof window !== 'undefined' && !window.isSecureContext) {
        setState('error');
        callbacks.onError?.({ code: 'insecure-context', message: 'Speech recognition needs HTTPS or localhost.' });
        return;
      }

      if (merged.requireMicrophonePermission) {
        setState('checking');
        const permission = await requestMicrophoneAccess();
        if (permission === 'denied') {
          setState('error');
          callbacks.onError?.({ code: 'permission-denied', message: 'Microphone permission was denied.' });
          return;
        }
      }

      if (merged.audioActivityMonitor) {
        audioMonitor = new ClarityVoiceAudioMonitor(emitAudioActivity);
        void audioMonitor.start().catch(() => undefined);
      }

      recognition = configureRecognition();
      if (!recognition) return;

      try {
        manuallyStopped = false;
        setState('starting');
        recognition.start();
      } catch (error) {
        setState('error');
        callbacks.onError?.({
          code: 'unknown',
          message: error instanceof Error ? error.message : 'Could not start speech recognition.'
        });
      }
    },
    stop() {
      manuallyStopped = true;
      clearTimers();
      audioMonitor?.stop();
      try {
        recognition?.stop();
      } finally {
        setState('idle');
      }
    },
    abort() {
      manuallyStopped = true;
      clearTimers();
      audioMonitor?.stop();
      try {
        recognition?.abort();
      } finally {
        interimText = '';
        setState('idle');
        emitTranscript();
      }
    },
    reset() {
      finalText = '';
      interimText = '';
      confidence = null;
      alternatives = [];
      pauseStats = { ...DEFAULT_PAUSE_STATS };
      emitTranscript();
    },
    setLanguage(lang: ClarityVoiceAccentPreset) {
      merged.lang = lang;
      if (recognition) recognition.lang = lang;
    },
    destroy() {
      manuallyStopped = true;
      clearTimers();
      audioMonitor?.destroy();
      audioMonitor = null;
      recognition?.abort();
      recognition = null;
    }
  };

  void controller.refreshSupportReport();
  return controller;
}

function chooseBestAlternative(result: SpeechRecognitionResult, domainPhrases: string[], vocabularyTerms = DEFAULT_CLARITY_VOICE_VOCABULARY): ClarityVoiceTranscriptAlternative | null {
  let best: ClarityVoiceTranscriptAlternative | null = null;

  for (let index = 0; index < result.length; index += 1) {
    const alternative = result[index];
    if (!alternative?.transcript) continue;
    const confidence = typeof alternative.confidence === 'number' ? alternative.confidence : null;
    const score = scoreTranscriptAlternative(alternative.transcript, domainPhrases, vocabularyTerms) + (confidence ?? 0) * 4;
    const candidate = { transcript: alternative.transcript.trim(), confidence, score };
    if (!best || candidate.score > best.score) best = candidate;
  }

  return best;
}

function joinTranscript(left: string, right: string): string {
  return [left.trim(), right.trim()].filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim();
}

function mapNativeSpeechError(nativeError: string): ClarityVoiceError {
  const codeMap: Record<string, ClarityVoiceErrorCode> = {
    'not-allowed': 'permission-denied',
    'service-not-allowed': 'permission-denied',
    'audio-capture': 'microphone-unavailable',
    'no-speech': 'no-speech',
    network: 'network',
    aborted: 'aborted'
  };

  const code = codeMap[nativeError] ?? 'unknown';
  const messageMap: Record<ClarityVoiceErrorCode, string> = {
    'unsupported-browser': 'Speech recognition is not supported in this browser.',
    'insecure-context': 'Speech recognition needs HTTPS or localhost.',
    'permission-denied': 'Microphone or speech recognition permission was denied.',
    'microphone-unavailable': 'No usable microphone was found.',
    'no-speech': 'No speech was detected.',
    network: 'Speech recognition had a network or service problem.',
    aborted: 'Speech recognition was stopped.',
    'already-started': 'Speech recognition is already running.',
    unknown: 'Speech recognition failed.'
  };

  return { code, message: messageMap[code], nativeError };
}
