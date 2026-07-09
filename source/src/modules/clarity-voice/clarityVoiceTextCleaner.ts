import { DEFAULT_CLARITY_VOICE_VOCABULARY, normaliseWithClarityVocabulary, scoreWithClarityVocabulary } from './clarityVoiceVocabulary';
import type { ClarityVoiceVocabularyTerm } from './types';

const STANDALONE_FILLERS = [
  'um', 'umm', 'uh', 'uhh', 'ah', 'ahh', 'erm', 'er', 'hmm', 'mmm'
];

const PHRASE_FILLERS = [
  'you know', 'i mean', 'sort of', 'kind of', 'basically', 'actually', 'right so', 'okay so', 'like'
];

const PROFANITY_LIGHT = [
  /\bf+u+c+k+\w*\b/gi,
  /\bs+h+i+t+\w*\b/gi
];

export interface CleanTranscriptOptions {
  removeFillers?: boolean;
  normaliseGolfTerms?: boolean;
  vocabularyTerms?: ClarityVoiceVocabularyTerm[];
  trimWhitespace?: boolean;
  sentenceCase?: boolean;
  smartPunctuation?: boolean;
  profanityFilter?: boolean;
}

export interface FillerSuppressionResult {
  text: string;
  fillerCount: number;
  rejectedFillerCount: number;
}

export function suppressDictationFillers(input: string): FillerSuppressionResult {
  let text = input;
  let fillerCount = 0;
  let rejectedFillerCount = 0;

  for (const filler of STANDALONE_FILLERS) {
    const pattern = new RegExp(`(^|[\\s,.;:!?])${escapeRegExp(filler)}([\\s,.;:!?]|$)`, 'gi');
    text = text.replace(pattern, (match, left: string, right: string) => {
      fillerCount += 1;
      rejectedFillerCount += 1;
      return `${left}${right}`;
    });
  }

  for (const filler of PHRASE_FILLERS) {
    const pattern = new RegExp(`\\b${escapeRegExp(filler)}\\b,?\\s*`, 'gi');
    text = text.replace(pattern, () => {
      fillerCount += 1;
      rejectedFillerCount += 1;
      return '';
    });
  }

  return { text: tidySpacing(text), fillerCount, rejectedFillerCount };
}

export function cleanClarityTranscript(
  input: string,
  options: CleanTranscriptOptions = {}
): string {
  const {
    removeFillers = true,
    normaliseGolfTerms = true,
    trimWhitespace = true,
    sentenceCase = true,
    smartPunctuation = true,
    profanityFilter = false,
    vocabularyTerms = DEFAULT_CLARITY_VOICE_VOCABULARY
  } = options;

  let text = input;

  if (removeFillers) text = suppressDictationFillers(text).text;

  if (normaliseGolfTerms) text = normaliseWithClarityVocabulary(text, vocabularyTerms);

  if (profanityFilter) {
    for (const pattern of PROFANITY_LIGHT) text = text.replace(pattern, '');
  }

  text = tidySpacing(text);
  if (smartPunctuation) text = addLightPunctuation(text);
  if (trimWhitespace) text = text.trim();
  if (sentenceCase) text = toSentenceCase(text);

  return text;
}

export function scoreTranscriptAlternative(transcript: string, domainPhrases: string[] = [], vocabularyTerms: ClarityVoiceVocabularyTerm[] = DEFAULT_CLARITY_VOICE_VOCABULARY): number {
  const lower = transcript.toLowerCase();
  let score = scoreWithClarityVocabulary(transcript, vocabularyTerms);

  for (const phrase of domainPhrases) {
    if (!phrase.trim()) continue;
    if (lower.includes(phrase.toLowerCase())) score += phrase.length >= 6 ? 3 : 1;
  }

  if (/\b(?:lesson|booking|customer|client|paid|invoice|driver|wedge|putting|slice|hook|draw|fade|TrackMan|trackman)\b/i.test(transcript)) score += 2;
  if (/\b(?:um|uh|ah|erm|mmm)\b/i.test(transcript)) score -= 2;
  if (/[\w)]$/.test(transcript.trim())) score += 0.5;

  return score;
}

function addLightPunctuation(value: string): string {
  let text = value
    .replace(/\b(new line|next line|new paragraph)\b/gi, '\n')
    .replace(/\b(full stop|period)\b/gi, '.')
    .replace(/\b(comma)\b/gi, ',')
    .replace(/\b(question mark)\b/gi, '?')
    .replace(/\b(exclamation mark)\b/gi, '!');

  text = text.replace(/\s+\n\s+/g, '\n');
  text = text.replace(/([^.!?\n])\n/g, '$1.\n');

  // Browser speech APIs usually return plain words, not ChatGPT-style punctuation.
  // This is deliberately conservative: it only inserts sentence breaks around
  // strong lesson-note / booking-note cues so it does not mangle golf terms.
  const sentenceCues: Array<[RegExp, string]> = [
    [/\b(today|yesterday|this morning|this afternoon)\s+(he|she|they|we|i)\b/gi, '$1. $2'],
    [/\b(TrackMan|GCQuad|FlightScope|Foresight|SkyTrak)\s+(showed|said|reported|data|numbers)\b/g, '. $1 $2'],
    [/\b(paid by|payment was|invoice|invoiced|send invoice|bank transfer|card payment)\b/gi, '. $1'],
    [/\b(book|rebook|schedule|reschedule)\s+(him|her|them|the client|the player)\b/gi, '. $1 $2'],
    [/\b(next step|homework|main focus|practice plan|follow up)\b/gi, '. $1'],
    [/\b(client note|coach note|admin note)\b/gi, '. $1'],
  ];

  for (const [pattern, replacement] of sentenceCues) {
    text = text.replace(pattern, replacement);
  }

  text = text
    .replace(/(^|[\s\n])\.\s*/g, '$1')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/([.!?])\s*([.!?])+/g, '$1')
    .replace(/([.!?])\s+([a-z])/g, (_match, punct: string, letter: string) => `${punct} ${letter.toUpperCase()}`);

  if (text && !/[.!?]$/.test(text.trim())) text = `${text.trim()}.`;
  return text;
}

function toSentenceCase(value: string): string {
  if (!value) return value;
  return value.replace(/(^\s*[a-z])|([.!?]\s+[a-z])|(\n\s*[a-z])/g, match => match.toUpperCase());
}

function tidySpacing(value: string): string {
  return value
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/([,.!?])([^\s\n])/g, '$1 $2')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
