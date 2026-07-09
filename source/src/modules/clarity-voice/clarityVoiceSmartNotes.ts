import { DEFAULT_CLARITY_VOICE_VOCABULARY, extractClarityVocabularyMentions } from './clarityVoiceVocabulary';
import { cleanClarityTranscript } from './clarityVoiceTextCleaner';
import type { ClarityVoiceSmartEntities, ClarityVoiceSmartNote, ClarityVoiceVocabularyTerm } from './types';

const LESSON_TYPES = ['driver', 'iron', 'wedge', 'putting', 'short game', 'bunker', 'playing lesson', 'junior', 'trackman', 'TrackMan'];
const EQUIPMENT = ['TrackMan', 'FlightScope', 'GCQuad', 'Foresight', 'range', 'simulator', 'video'];
const SWING_PATTERNS = ['slice', 'hook', 'pull', 'push', 'fade', 'draw', 'thin', 'fat', 'shank', 'top', 'toe', 'heel'];
const PAYMENT = ['paid', 'unpaid', 'cash', 'card', 'invoice', 'bank transfer', 'refund', 'voucher'];

export function buildClaritySmartNote(rawText: string, confidence: number | null = null, vocabularyTerms: ClarityVoiceVocabularyTerm[] = DEFAULT_CLARITY_VOICE_VOCABULARY): ClarityVoiceSmartNote {
  const cleanedText = cleanClarityTranscript(rawText, { smartPunctuation: true, vocabularyTerms });
  const entities = extractClarityVoiceEntities(cleanedText, vocabularyTerms);
  const bullets = buildBullets(cleanedText, entities);

  return {
    rawText,
    cleanedText,
    title: buildTitle(cleanedText, entities),
    bullets,
    entities,
    confidenceHint: confidence == null ? null : confidence >= 0.82 ? 'high' : confidence >= 0.58 ? 'medium' : 'low'
  };
}

export function extractClarityVoiceEntities(text: string, vocabularyTerms: ClarityVoiceVocabularyTerm[] = DEFAULT_CLARITY_VOICE_VOCABULARY): ClarityVoiceSmartEntities {
  const lower = text.toLowerCase();
  const durations = Array.from(text.matchAll(/\b(?:\d{1,3}|half an?|one|two)\s*(?:minute|minutes|min|hour|hours|hr|hrs)\b/gi)).map(match => match[0]);

  return {
    lessonTypes: unique(LESSON_TYPES.filter(term => lower.includes(term.toLowerCase()))),
    durations: unique(durations),
    paymentMentions: unique(PAYMENT.filter(term => lower.includes(term.toLowerCase()))),
    equipmentMentions: unique(EQUIPMENT.filter(term => lower.includes(term.toLowerCase()))),
    swingPatternMentions: unique(SWING_PATTERNS.filter(term => lower.includes(term.toLowerCase()))),
    bookingIntent: inferBookingIntent(lower),
    vocabularyMentions: extractClarityVocabularyMentions(text, vocabularyTerms).slice(0, 24)
  };
}

function buildTitle(text: string, entities: ClarityVoiceSmartEntities): string {
  if (entities.bookingIntent === 'cancel') return 'Cancellation note';
  if (entities.bookingIntent === 'reschedule') return 'Reschedule note';
  if (entities.bookingIntent === 'complete') return 'Completed lesson note';
  if (entities.lessonTypes.length) return `${capitalise(entities.lessonTypes[0])} lesson note`;
  const firstSentence = text.split(/[.!?]/)[0]?.trim();
  return firstSentence ? truncate(firstSentence, 56) : 'Voice note';
}

function buildBullets(text: string, entities: ClarityVoiceSmartEntities): string[] {
  const bullets: string[] = [];
  if (entities.bookingIntent) bullets.push(`Intent: ${entities.bookingIntent}`);
  if (entities.durations.length) bullets.push(`Duration: ${entities.durations.join(', ')}`);
  if (entities.lessonTypes.length) bullets.push(`Lesson focus: ${entities.lessonTypes.join(', ')}`);
  if (entities.swingPatternMentions.length) bullets.push(`Swing pattern: ${entities.swingPatternMentions.join(', ')}`);
  if (entities.equipmentMentions.length) bullets.push(`Equipment: ${entities.equipmentMentions.join(', ')}`);
  if (entities.paymentMentions.length) bullets.push(`Payment/admin: ${entities.paymentMentions.join(', ')}`);
  const jargon = entities.vocabularyMentions.filter(mention => mention.category === 'brand' || mention.category === 'app' || mention.category === 'data').slice(0, 6).map(mention => mention.canonical);
  if (jargon.length) bullets.push(`Recognised jargon: ${Array.from(new Set(jargon)).join(', ')}`);
  if (!bullets.length && text) bullets.push(truncate(text, 120));
  return bullets;
}

function inferBookingIntent(lower: string): ClarityVoiceSmartEntities['bookingIntent'] {
  if (/\b(cancel|cancelled|canceled|delete|remove)\b/.test(lower)) return 'cancel';
  if (/\b(reschedule|move|shift|change time|drag)\b/.test(lower)) return 'reschedule';
  if (/\b(complete|completed|finished|done)\b/.test(lower)) return 'complete';
  if (/\b(book|booking|schedule|add lesson|new lesson)\b/.test(lower)) return 'create';
  return null;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function capitalise(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trim()}…`;
}
