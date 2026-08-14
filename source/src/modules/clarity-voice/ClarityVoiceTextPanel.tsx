import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Mic, Save, Square } from 'lucide-react';
import { buildVocabularyPhrases, DEFAULT_CLARITY_VOICE_VOCABULARY } from './clarityVoiceVocabulary';
import { useClarityVoice } from './useClarityVoice';
import './clarityVoiceText.css';

type SaveState = 'idle' | 'saving' | 'saved';

export interface ClarityVoiceTextPanelProps {
  initialValue?: string;
  fieldLabel?: string;
  placeholder?: string;
  /**
   * Return false (or throw) to tell the panel the save failed. The typed note is
   * kept in the box so nothing the coach dictated is lost.
   */
  onCommit?: (text: string) => void | boolean | Promise<void | boolean>;
}

export function ClarityVoiceTextPanel({
  initialValue = '',
  fieldLabel = 'Voice note',
  placeholder = 'Type or dictate the coach lesson note.',
  onCommit
}: ClarityVoiceTextPanelProps) {
  const [noteText, setNoteText] = useState(initialValue);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const lastAppliedTranscriptRef = useRef('');

  const voice = useClarityVoice({
    lang: 'en-NZ',
    continuous: true,
    interimResults: true,
    maxAlternatives: 5,
    autoRestart: false,
    silenceAutoStopMs: null,
    endpointAfterPauseMs: 1700,
    suppressFillers: true,
    smartPunctuation: true,
    audioActivityMonitor: true,
    requireMicrophonePermission: false,
    vocabularyTerms: DEFAULT_CLARITY_VOICE_VOCABULARY,
    domainPhrases: buildVocabularyPhrases(DEFAULT_CLARITY_VOICE_VOCABULARY)
  });

  const cleanedTranscript = voice.smartNote.cleanedText.trim();
  const isListening = voice.state === 'listening' || voice.state === 'starting' || voice.state === 'checking';
  const micLabel = isListening ? 'Stop dictation' : 'Start dictation';

  useEffect(() => {
    if (!cleanedTranscript) return;
    setNoteText(current => {
      const previousTranscript = lastAppliedTranscriptRef.current;
      const baseText = previousTranscript && current.endsWith(previousTranscript)
        ? current.slice(0, -previousTranscript.length).trimEnd()
        : current;
      lastAppliedTranscriptRef.current = cleanedTranscript;
      return [baseText.trim(), cleanedTranscript].filter(Boolean).join('\n');
    });
  }, [cleanedTranscript]);

  useEffect(() => {
    if (saveState !== 'saved') return;
    const timer = window.setTimeout(() => setSaveState('idle'), 1600);
    return () => window.clearTimeout(timer);
  }, [saveState]);

  const hasText = useMemo(() => noteText.trim().length > 0, [noteText]);
  const isSaving = saveState === 'saving';
  const saveDisabled = !hasText || isSaving;

  function toggleDictation() {
    if (isListening) {
      voice.stop();
      return;
    }
    voice.start();
  }

  function handleTextChange(nextValue: string) {
    setNoteText(nextValue);
    lastAppliedTranscriptRef.current = '';
  }

  async function commitText() {
    const text = noteText.trim();
    if (!text || isSaving) return;
    setSaveState('saving');
    let saved = true;
    try {
      saved = (await onCommit?.(text)) !== false;
    } catch {
      saved = false;
    }
    if (!saved) {
      setSaveState('idle');
      return;
    }
    setNoteText('');
    lastAppliedTranscriptRef.current = '';
    voice.reset();
    setSaveState('saved');
  }

  const saveLabel = isSaving ? 'Saving…' : saveState === 'saved' ? 'Saved' : 'Save note';
  const saveHint = hasText ? saveLabel : 'Type or dictate a note first';

  return (
    <section className="clarityVoicePanel" aria-label="Lesson note dictation">
      <div className="clarityVoiceInputRow">
        <button
          type="button"
          className={`clarityVoiceMicButton${isListening ? ' is-listening' : ''}`}
          onClick={toggleDictation}
          disabled={!voice.isSupported && !isListening}
          aria-label={micLabel}
          title={micLabel}
        >
          {isListening ? <Square size={18} /> : <Mic size={18} />}
        </button>
        <label className="clarityVoiceTextOutput">
          <span>{fieldLabel}</span>
          <textarea
            value={noteText}
            placeholder={placeholder}
            onChange={event => handleTextChange(event.target.value)}
            rows={5}
          />
        </label>
      </div>
      {voice.transcript.interimText && (
        <p className="clarityVoiceInterim">{voice.transcript.interimText}</p>
      )}
      <div className="clarityVoiceSaveRow">
        <button
          type="button"
          className={`clarityVoiceSaveButton${isSaving ? ' is-saving' : ''}${saveState === 'saved' ? ' is-saved' : ''}`}
          onClick={() => void commitText()}
          disabled={saveDisabled}
          title={saveHint}
          aria-live="polite"
        >
          {saveState === 'saved' ? <Check size={15} /> : <Save size={15} />}
          {saveLabel}
        </button>
      </div>
    </section>
  );
}
