import { useEffect, useMemo, useRef, useState } from 'react';
import { Mic, Save, Square } from 'lucide-react';
import { buildVocabularyPhrases, DEFAULT_CLARITY_VOICE_VOCABULARY } from './clarityVoiceVocabulary';
import { useClarityVoice } from './useClarityVoice';
import './clarityVoiceText.css';

export interface ClarityVoiceTextPanelProps {
  initialValue?: string;
  fieldLabel?: string;
  placeholder?: string;
  onCommit?: (text: string) => void;
}

export function ClarityVoiceTextPanel({
  initialValue = '',
  fieldLabel = 'Voice note',
  placeholder = 'Type or dictate the coach lesson note.',
  onCommit
}: ClarityVoiceTextPanelProps) {
  const [noteText, setNoteText] = useState(initialValue);
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

  const saveDisabled = useMemo(() => !noteText.trim(), [noteText]);

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

  function commitText() {
    const text = noteText.trim();
    if (!text) return;
    onCommit?.(text);
    setNoteText('');
    lastAppliedTranscriptRef.current = '';
    voice.reset();
  }

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
        <button type="button" className="clarityVoiceSaveButton" onClick={commitText} disabled={saveDisabled}>
          <Save size={15} />
          Save note
        </button>
      </div>
    </section>
  );
}
