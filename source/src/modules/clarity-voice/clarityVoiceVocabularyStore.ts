import { createVocabularyTerm, mergeClarityVocabularyTerms } from './clarityVoiceVocabulary';
import type { ClarityVoiceVocabularyCategory, ClarityVoiceVocabularyTerm } from './types';

export const CLARITY_VOICE_CUSTOM_VOCABULARY_KEY = 'clarity.voice.customVocabulary.v1';

export function loadCustomVocabularyTerms(storageKey = CLARITY_VOICE_CUSTOM_VOCABULARY_KEY): ClarityVoiceVocabularyTerm[] {
  const storage = getStorage();
  if (!storage) return [];
  const raw = storage.getItem(storageKey);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isVocabularyTermLike).map(term => ({
      ...term,
      phrase: String(term.phrase || '').trim(),
      canonical: String(term.canonical || term.phrase || '').trim(),
      category: term.category || 'custom',
      aliases: Array.isArray(term.aliases) ? term.aliases.map(String) : [],
      tags: Array.isArray(term.tags) ? term.tags.map(String) : []
    }));
  } catch {
    return [];
  }
}

export function saveCustomVocabularyTerms(
  terms: ClarityVoiceVocabularyTerm[],
  storageKey = CLARITY_VOICE_CUSTOM_VOCABULARY_KEY
): void {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(storageKey, JSON.stringify(terms, null, 2));
}

export function addCustomVocabularyTerm(
  phrase: string,
  options: {
    category?: ClarityVoiceVocabularyCategory;
    aliases?: string[];
    tags?: string[];
    storageKey?: string;
  } = {}
): ClarityVoiceVocabularyTerm[] {
  const nextTerm = createVocabularyTerm(phrase, options.category ?? 'custom', options.aliases ?? [], options.tags ?? []);
  const current = loadCustomVocabularyTerms(options.storageKey);
  const merged = mergeClarityVocabularyTerms([], [...current, nextTerm]);
  saveCustomVocabularyTerms(merged, options.storageKey);
  return merged;
}

export function removeCustomVocabularyTerm(canonical: string, storageKey = CLARITY_VOICE_CUSTOM_VOCABULARY_KEY): ClarityVoiceVocabularyTerm[] {
  const target = canonical.trim().toLowerCase();
  const next = loadCustomVocabularyTerms(storageKey).filter(term => (term.canonical || term.phrase).toLowerCase() !== target);
  saveCustomVocabularyTerms(next, storageKey);
  return next;
}

export function clearCustomVocabularyTerms(storageKey = CLARITY_VOICE_CUSTOM_VOCABULARY_KEY): void {
  const storage = getStorage();
  if (!storage) return;
  storage.removeItem(storageKey);
}

export function exportCustomVocabularyJson(storageKey = CLARITY_VOICE_CUSTOM_VOCABULARY_KEY): string {
  return JSON.stringify(loadCustomVocabularyTerms(storageKey), null, 2);
}

export function importCustomVocabularyJson(jsonText: string, storageKey = CLARITY_VOICE_CUSTOM_VOCABULARY_KEY): ClarityVoiceVocabularyTerm[] {
  const parsed = JSON.parse(jsonText);
  if (!Array.isArray(parsed)) throw new Error('Vocabulary import must be a JSON array.');
  const next = mergeClarityVocabularyTerms([], parsed.filter(isVocabularyTermLike));
  saveCustomVocabularyTerms(next, storageKey);
  return next;
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function isVocabularyTermLike(value: unknown): value is ClarityVoiceVocabularyTerm {
  return Boolean(value && typeof value === 'object' && 'phrase' in value && typeof (value as { phrase?: unknown }).phrase === 'string');
}
