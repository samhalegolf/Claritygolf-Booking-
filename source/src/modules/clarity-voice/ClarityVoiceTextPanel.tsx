import { useMemo, useState } from 'react';
import { buildVocabularyPhrases, DEFAULT_CLARITY_VOICE_VOCABULARY, mergeClarityVocabularyTerms } from './clarityVoiceVocabulary';
import { addCustomVocabularyTerm, loadCustomVocabularyTerms, removeCustomVocabularyTerm } from './clarityVoiceVocabularyStore';
import { useClarityVoice } from './useClarityVoice';
import type { ClarityVoiceAccentPreset } from './types';
import './clarityVoiceText.css';

const ACCENTS: ClarityVoiceAccentPreset[] = ['en-NZ', 'en-AU', 'en-GB', 'en-US', 'en-CA', 'en-IE', 'en-ZA'];

export interface ClarityVoiceTextPanelProps {
  initialValue?: string;
  fieldLabel?: string;
  placeholder?: string;
  onCommit?: (text: string) => void;
}

export function ClarityVoiceTextPanel({
  initialValue = '',
  fieldLabel = 'Voice note',
  placeholder = 'Tap Start, speak naturally, pause when finished, then review before saving.',
  onCommit
}: ClarityVoiceTextPanelProps) {
  const [accent, setAccent] = useState<ClarityVoiceAccentPreset>('en-NZ');
  const [manualText, setManualText] = useState(initialValue);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [customVocabulary, setCustomVocabulary] = useState(() => loadCustomVocabularyTerms());
  const [newJargon, setNewJargon] = useState('');

  const vocabularyTerms = useMemo(
    () => mergeClarityVocabularyTerms(DEFAULT_CLARITY_VOICE_VOCABULARY, customVocabulary),
    [customVocabulary]
  );

  const voice = useClarityVoice({
    lang: accent,
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
    vocabularyTerms,
    domainPhrases: buildVocabularyPhrases(vocabularyTerms)
  });

  const cleanedTranscript = voice.smartNote.cleanedText;
  const draftText = useMemo(
    () => [manualText.trim(), cleanedTranscript.trim()].filter(Boolean).join('\n'),
    [manualText, cleanedTranscript]
  );
  const isListening = voice.state === 'listening' || voice.state === 'starting' || voice.state === 'checking';

  function handleAccentChange(nextAccent: ClarityVoiceAccentPreset) {
    setAccent(nextAccent);
    voice.setLanguage(nextAccent);
  }

  function appendTranscript() {
    if (!cleanedTranscript) return;
    setManualText(previous => [previous.trim(), cleanedTranscript].filter(Boolean).join('\n'));
    voice.reset();
  }

  function commitText() {
    onCommit?.(draftText.trim());
  }

  function addJargonTerm() {
    if (!newJargon.trim()) return;
    setCustomVocabulary(addCustomVocabularyTerm(newJargon, { category: 'custom', tags: ['manual'] }));
    setNewJargon('');
  }

  function removeJargonTerm(canonical: string) {
    setCustomVocabulary(removeCustomVocabularyTerm(canonical));
  }

  return (
    <section className="clarityVoicePanel" aria-label="Clarity voice to text">
      <header className="clarityVoiceHeader">
        <div>
          <p className="clarityVoiceKicker">Clarity Voice</p>
          <h2>{fieldLabel}</h2>
        </div>
        <span className={`clarityVoiceStatus clarityVoiceStatus--${voice.state}`}>{voice.state}</span>
      </header>

      <div className="clarityVoiceSmartStrip">
        <span>{voice.audioActivity.isSpeaking ? 'Voice detected' : isListening ? 'Listening for pause' : 'Ready'}</span>
        <span>Confidence: {voice.smartNote.confidenceHint ?? 'unknown'}</span>
        <span>Fillers removed: {voice.transcript.pauseStats.rejectedFillerCount}</span>
      </div>

      <label className="clarityVoiceLabel">
        English accent preset
        <select
          value={accent}
          onChange={event => handleAccentChange(event.target.value as ClarityVoiceAccentPreset)}
          disabled={isListening}
        >
          {ACCENTS.map(option => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </label>

      <div className="clarityVoiceControls">
        <button type="button" onClick={voice.start} disabled={!voice.isSupported || isListening}>
          Start dictation
        </button>
        <button type="button" onClick={voice.stop} disabled={!isListening}>
          Stop
        </button>
        <button type="button" onClick={voice.reset} disabled={!voice.transcript.combinedText}>
          Clear transcript
        </button>
      </div>

      {!voice.isSupported && (
        <p className="clarityVoiceWarning">
          Speech recognition is not available in this browser. Keep the normal typing path available.
        </p>
      )}

      {voice.supportReport?.notes?.map(note => (
        <p className="clarityVoiceWarning" key={note}>{note}</p>
      ))}

      {voice.error && <p className="clarityVoiceError">{voice.error.message}</p>}

      <label className="clarityVoiceLabel">
        Typed note / saved draft
        <textarea
          value={manualText}
          placeholder={placeholder}
          onChange={event => setManualText(event.target.value)}
          rows={5}
        />
      </label>

      <div className="clarityVoiceTranscriptBox">
        <div className="clarityVoiceBoxHeader">
          <p className="clarityVoiceBoxTitle">Clean transcript</p>
          <button type="button" className="clarityVoiceLinkButton" onClick={() => setShowDiagnostics(value => !value)}>
            {showDiagnostics ? 'Hide diagnostics' : 'Show diagnostics'}
          </button>
        </div>
        <p className="clarityVoiceFinal">{cleanedTranscript || 'Nothing captured yet.'}</p>
        {voice.transcript.interimText && <p className="clarityVoiceInterim">{voice.transcript.interimText}</p>}
      </div>

      <div className="clarityVoiceTranscriptBox clarityVoiceTranscriptBox--smart">
        <p className="clarityVoiceBoxTitle">Smart note preview</p>
        <strong>{voice.smartNote.title}</strong>
        <ul>
          {voice.smartNote.bullets.map(bullet => <li key={bullet}>{bullet}</li>)}
        </ul>
      </div>

      <div className="clarityVoiceTranscriptBox clarityVoiceTranscriptBox--vocabulary">
        <p className="clarityVoiceBoxTitle">Jargon recogniser</p>
        <p className="clarityVoiceHelpText">
          Loaded {vocabularyTerms.length} seeded Clarity/golf terms. Add your own names, course labels, products, or common misheard phrases here.
        </p>
        <div className="clarityVoiceVocabularyAdd">
          <input
            value={newJargon}
            placeholder="Add jargon, e.g. Maungakiekie, Sam Hale Golf, TrackTee"
            onChange={event => setNewJargon(event.target.value)}
          />
          <button type="button" onClick={addJargonTerm} disabled={!newJargon.trim()}>Add</button>
        </div>
        {customVocabulary.length > 0 && (
          <div className="clarityVoiceVocabularyPills">
            {customVocabulary.slice(0, 12).map(term => (
              <button
                type="button"
                className="clarityVoiceVocabularyPill"
                key={term.canonical || term.phrase}
                onClick={() => removeJargonTerm(term.canonical || term.phrase)}
                title="Remove custom term"
              >
                {term.canonical || term.phrase} ×
              </button>
            ))}
          </div>
        )}
      </div>

      {showDiagnostics && (
        <pre className="clarityVoiceDiagnostics">
{JSON.stringify({
  state: voice.state,
  support: voice.supportReport,
  audio: voice.audioActivity,
  pauseStats: voice.transcript.pauseStats,
  alternatives: voice.transcript.alternatives,
  vocabulary: { seededAndCustomTerms: vocabularyTerms.length, customTerms: customVocabulary.length, mentions: voice.smartNote.entities.vocabularyMentions }
}, null, 2)}
        </pre>
      )}

      <div className="clarityVoiceControls clarityVoiceControls--right">
        <button type="button" onClick={appendTranscript} disabled={!cleanedTranscript}>
          Append to note
        </button>
        <button type="button" onClick={commitText} disabled={!draftText.trim()}>
          Use this text
        </button>
      </div>
    </section>
  );
}
