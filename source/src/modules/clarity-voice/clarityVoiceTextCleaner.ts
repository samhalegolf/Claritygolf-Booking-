import { DEFAULT_CLARITY_VOICE_VOCABULARY, scoreWithClarityVocabulary } from './clarityVoiceVocabulary';
import { dictationRules } from './clarityVoiceLanguage';
import type { ClarityVoiceVocabularyTerm } from './types';

const PROFANITY_LIGHT = [
  /\bf+u+c+k+\w*\b/gi,
  /\bs+h+i+t+\w*\b/gi
];

// Word edges that work for any alphabet: \b only knows ASCII, so "ähm" or
// "punto y aparte" would never match it.
const BEFORE = '(?<![\\p{L}\\p{N}])';
const AFTER = '(?![\\p{L}\\p{N}])';

export interface CleanTranscriptOptions {
  /** The speech locale the text was heard in ("en-NZ", "de-CH"). */
  locale?: string;
  removeFillers?: boolean;
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

export function suppressDictationFillers(input: string, locale = 'en'): FillerSuppressionResult {
  const rules = dictationRules(locale);
  let text = input;
  let fillerCount = 0;

  for (const filler of rules.fillers) {
    // Written without spaces there is no edge to find: the sound goes wherever it is.
    const pattern = rules.noSpaces
      ? new RegExp(`()${escapeRegExp(filler)}()`, 'gu')
      : new RegExp(`(^|[\\s,.;:!?])${escapeRegExp(filler)}([\\s,.;:!?]|$)`, 'giu');
    text = text.replace(pattern, (_match, left: string, right: string) => {
      fillerCount += 1;
      return `${left}${right}`;
    });
  }

  for (const filler of rules.fillerPhrases) {
    const pattern = new RegExp(`${BEFORE}${escapeRegExp(filler)}${AFTER},?\\s*`, 'giu');
    text = text.replace(pattern, () => {
      fillerCount += 1;
      return '';
    });
  }

  return { text: tidySpacing(text), fillerCount, rejectedFillerCount: fillerCount };
}

export function cleanClarityTranscript(
  input: string,
  options: CleanTranscriptOptions = {}
): string {
  const {
    locale = 'en',
    removeFillers = true,
    trimWhitespace = true,
    sentenceCase = true,
    smartPunctuation = true,
    profanityFilter = false
  } = options;

  let text = input;

  if (removeFillers) text = suppressDictationFillers(text, locale).text;

  if (profanityFilter) {
    for (const pattern of PROFANITY_LIGHT) text = text.replace(pattern, '');
  }

  text = tidySpacing(text);
  if (smartPunctuation) text = addLightPunctuation(text, locale);
  if (trimWhitespace) text = text.trim();
  if (sentenceCase) text = toSentenceCase(text);

  return text;
}

export function scoreTranscriptAlternative(
  transcript: string,
  domainPhrases: string[] = [],
  vocabularyTerms: ClarityVoiceVocabularyTerm[] = DEFAULT_CLARITY_VOICE_VOCABULARY,
  locale = 'en'
): number {
  const lower = transcript.toLowerCase();
  let score = scoreWithClarityVocabulary(transcript, vocabularyTerms);

  for (const phrase of domainPhrases) {
    if (!phrase.trim()) continue;
    if (lower.includes(phrase.toLowerCase())) score += phrase.length >= 6 ? 3 : 1;
  }

  if (/\b(?:lesson|booking|customer|client|paid|invoice|driver|wedge|putting|slice|hook|draw|fade|TrackMan|trackman)\b/i.test(transcript)) score += 2;
  const fillers = dictationRules(locale).fillers.map(escapeRegExp).join('|');
  if (fillers && new RegExp(`${BEFORE}(?:${fillers})${AFTER}`, 'iu').test(transcript)) score -= 2;
  if (/[\p{L}\p{N})]$/u.test(transcript.trim())) score += 0.5;

  return score;
}

function addLightPunctuation(value: string, locale: string): string {
  const rules = dictationRules(locale);
  const stop = rules.fullStop;
  let text = value;
  for (const [words, mark] of rules.punctuation) {
    const alternatives = words.map(escapeRegExp).join('|');
    const pattern = rules.noSpaces
      ? new RegExp(`(?:${alternatives})`, 'gu')
      : new RegExp(`${BEFORE}(?:${alternatives})${AFTER}`, 'giu');
    text = text.replace(pattern, mark);
  }

  text = text.replace(/\s+\n\s+/g, '\n');
  text = text.replace(/([^.!?。！？\n])\n/gu, `$1${stop}\n`);

  // Browser speech APIs usually return plain words, not ChatGPT-style punctuation.
  // This is deliberately conservative: it only inserts sentence breaks around
  // strong lesson-note / booking-note cues so it does not mangle golf terms.
  // The cues are English phrases, so they only apply to English notes.
  if (dictationRules(locale) === dictationRules('en')) {
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
  }

  text = text
    .replace(/(^|[\s\n])\.\s*/g, '$1')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/([.!?])\s*([.!?])+/g, '$1')
    // A spoken "new line" survives: only the space after a mark is normalised.
    .replace(/([.!?])(\s+)(\p{Ll})/gu, (_match, punct: string, space: string, letter: string) =>
      `${punct}${space.includes('\n') ? '\n' : ' '}${letter.toUpperCase()}`);

  if (text && !/[.!?。！？]$/u.test(text.trim())) text = `${text.trim()}${stop}`;
  return text;
}

function toSentenceCase(value: string): string {
  if (!value) return value;
  return value.replace(/(^\s*\p{Ll})|([.!?]\s+\p{Ll})|(\n\s*\p{Ll})/gu, match => match.toUpperCase());
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
