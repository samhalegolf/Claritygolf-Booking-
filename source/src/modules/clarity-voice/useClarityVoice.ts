import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClarityVoiceController } from './clarityVoiceEngine';
import { buildClaritySmartNote } from './clarityVoiceSmartNotes';
import type {
  ClarityVoiceAccentPreset,
  ClarityVoiceAudioActivity,
  ClarityVoiceController,
  ClarityVoiceError,
  ClarityVoiceOptions,
  ClarityVoiceSmartNote,
  ClarityVoiceState,
  ClarityVoiceSupportReport,
  ClarityVoiceTranscript
} from './types';

const EMPTY_TRANSCRIPT: ClarityVoiceTranscript = {
  finalText: '',
  interimText: '',
  combinedText: '',
  confidence: null,
  alternatives: [],
  pauseStats: {
    lastSpeechAt: null,
    lastFinalAt: null,
    lastPauseMs: null,
    pauseCount: 0,
    fillerCount: 0,
    rejectedFillerCount: 0
  },
  updatedAt: 0
};

const EMPTY_AUDIO: ClarityVoiceAudioActivity = {
  isAvailable: false,
  isMonitoring: false,
  isSpeaking: false,
  level: 0,
  noiseFloor: 0,
  updatedAt: 0
};

export function useClarityVoice(options: ClarityVoiceOptions = {}) {
  const [state, setState] = useState<ClarityVoiceState>('idle');
  const [transcript, setTranscript] = useState<ClarityVoiceTranscript>(EMPTY_TRANSCRIPT);
  const [error, setError] = useState<ClarityVoiceError | null>(null);
  const [supportReport, setSupportReport] = useState<ClarityVoiceSupportReport | null>(null);
  const [audioActivity, setAudioActivity] = useState<ClarityVoiceAudioActivity>(EMPTY_AUDIO);
  const controllerRef = useRef<ClarityVoiceController | null>(null);

  const stableOptions = useMemo(() => options, [JSON.stringify(options)]);

  useEffect(() => {
    const controller = createClarityVoiceController(stableOptions, {
      onStateChange: setState,
      onTranscript: setTranscript,
      onError: setError,
      onSupportReport: setSupportReport,
      onAudioActivity: setAudioActivity
    });
    controllerRef.current = controller;
    setState(controller.state);
    setTranscript(controller.transcript);
    setSupportReport(controller.supportReport);
    setAudioActivity(controller.audioActivity);

    return () => {
      controller.destroy();
      controllerRef.current = null;
    };
  }, [stableOptions]);

  const smartNote: ClarityVoiceSmartNote = useMemo(
    () => buildClaritySmartNote(transcript.combinedText, transcript.confidence, stableOptions.vocabularyTerms),
    [transcript.combinedText, transcript.confidence, stableOptions.vocabularyTerms]
  );

  const start = useCallback(() => {
    setError(null);
    void controllerRef.current?.start();
  }, []);

  const stop = useCallback(() => controllerRef.current?.stop(), []);
  const abort = useCallback(() => controllerRef.current?.abort(), []);
  const reset = useCallback(() => controllerRef.current?.reset(), []);
  const refreshSupportReport = useCallback(() => controllerRef.current?.refreshSupportReport(), []);
  const setLanguage = useCallback((lang: ClarityVoiceAccentPreset) => {
    controllerRef.current?.setLanguage(lang);
  }, []);

  return {
    isSupported: controllerRef.current?.isSupported ?? false,
    state,
    transcript,
    smartNote,
    audioActivity,
    supportReport,
    error,
    start,
    stop,
    abort,
    reset,
    setLanguage,
    refreshSupportReport
  };
}
