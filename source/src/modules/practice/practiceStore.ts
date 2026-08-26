/* Practice state that outlives the panel.
 *
 * Two jobs, both of which exist because the panel is mounted inside the coach
 * console and does not control its own lifetime:
 *
 *   The read cache -- so opening a player's profile can start fetching their
 *   practice immediately, and clicking through to the Practice tab a second
 *   later paints from memory instead of from a round trip. The console knows a
 *   player has been opened long before the panel is mounted, so the fetch
 *   cannot live in the panel's own effect.
 *
 *   The draft -- so a half-written block survives the panel being unmounted.
 *   It is unmounted more often than it looks: the console re-derives its
 *   client list from hydrated state, and a blink in that list takes the whole
 *   player tool down and back up. Keeping the draft in React state meant the
 *   coach lost a paragraph to a background refresh they never saw.
 *
 * Module scope, not a context: the console would have to own the provider, and
 * the whole point is to not depend on the console's render tree.
 */

import { apiFetch } from "../auth/apiFetch";
import {
  practiceSteps,
  type ExpiryType,
  type PracticeBlock,
  type PracticeBlockType,
  type PracticePreset,
  type PracticeSuggestion,
  type PracticeTypeMeta,
} from "./practiceModel";

export type PracticeSnapshot = {
  blocks: PracticeBlock[];
  presets: PracticePreset[];
  suggestions: PracticeSuggestion[];
  /** Empty means "this workspace has never edited them" -- see practiceTypeList. */
  blockTypes: PracticeTypeMeta[];
  /** Set when the read failed; the panel shows it and keeps working. */
  error: string;
};

type Entry = {
  snapshot: PracticeSnapshot | null;
  inFlight: Promise<PracticeSnapshot> | null;
  at: number;
};

const entries = new Map<string, Entry>();

/**
 * How long a prefetched read stays worth painting from. Long enough to cover
 * "open the profile, read the notes tab, click Practice", short enough that a
 * coach coming back to a player after a while does not see yesterday's wall
 * even for a moment. Revalidation happens either way -- this only decides
 * whether the first paint has something in it.
 */
const FRESH_MS = 60_000;

function unauthorizedError() {
  return Object.assign(new Error("Admin login required"), { code: "unauthorized" });
}

async function readJson(path: string) {
  const response = await apiFetch(path);
  if (response.status === 401) throw unauthorizedError();
  const data = (await response.json().catch(() => ({}))) as {
    message?: string;
    blocks?: PracticeBlock[];
    presets?: PracticePreset[];
    suggestions?: PracticeSuggestion[];
    blockTypes?: PracticeTypeMeta[];
  };
  if (!response.ok) throw new Error(data?.message || "Practice request failed.");
  return data;
}

async function fetchSnapshot(playerId: string): Promise<PracticeSnapshot> {
  const id = encodeURIComponent(playerId);
  // Two independent reads, together. The panel wants both before it is worth
  // looking at, so in series only ever meant waiting for the sum.
  const [blocksResult, startersResult] = await Promise.allSettled([
    readJson(`/api/practice-blocks?playerId=${id}`),
    readJson(`/api/practice-block-presets?playerId=${id}`),
  ]);

  // The rails failing is survivable -- they are a shortcut, and a composer
  // without them still works. The block list failing is not, and is the only
  // one that earns an error above the panel.
  const starters = startersResult.status === "fulfilled" ? startersResult.value : null;
  const snapshot: PracticeSnapshot = {
    blocks: blocksResult.status === "fulfilled" && Array.isArray(blocksResult.value.blocks) ? blocksResult.value.blocks : [],
    presets: Array.isArray(starters?.presets) ? starters.presets : [],
    suggestions: Array.isArray(starters?.suggestions) ? starters.suggestions : [],
    blockTypes: Array.isArray(starters?.blockTypes) ? starters.blockTypes : [],
    error:
      blocksResult.status === "rejected"
        ? blocksResult.reason instanceof Error
          ? blocksResult.reason.message
          : "Could not load practice."
        : "",
  };
  if (blocksResult.status === "rejected" && (blocksResult.reason as { code?: string })?.code === "unauthorized") {
    throw blocksResult.reason;
  }
  return snapshot;
}

/**
 * Start (or reuse) a read for this player. Safe to call on every profile open:
 * a fresh snapshot or an in-flight request short-circuits it, so clicking
 * through five players does not queue five reads for the first one.
 */
export function prefetchPractice(playerId: string) {
  if (!playerId) return;
  const entry = entries.get(playerId);
  if (entry?.inFlight) return;
  if (entry?.snapshot && Date.now() - entry.at < FRESH_MS) return;
  void loadPractice(playerId);
}

/** The read itself, deduped. Always resolves against the newest request. */
export function loadPractice(playerId: string): Promise<PracticeSnapshot> {
  const existing = entries.get(playerId);
  if (existing?.inFlight) return existing.inFlight;

  const inFlight = fetchSnapshot(playerId)
    .then((snapshot) => {
      entries.set(playerId, { snapshot, inFlight: null, at: Date.now() });
      return snapshot;
    })
    .catch((caught) => {
      // A failed read must not be cached as an answer, or the next open paints
      // an empty wall from it. The entry is cleared and the caller decides.
      entries.set(playerId, { snapshot: existing?.snapshot ?? null, inFlight: null, at: existing?.at ?? 0 });
      throw caught;
    });

  entries.set(playerId, { snapshot: existing?.snapshot ?? null, inFlight, at: existing?.at ?? 0 });
  return inFlight;
}

/** What is already known, for the first paint. Null when nothing is. */
export function cachedPractice(playerId: string): PracticeSnapshot | null {
  const entry = entries.get(playerId);
  if (!entry?.snapshot) return null;
  return Date.now() - entry.at < FRESH_MS ? entry.snapshot : null;
}

/** After a write: the next read must go to the server. */
export function invalidatePractice(playerId: string) {
  const entry = entries.get(playerId);
  if (entry) entries.set(playerId, { ...entry, at: 0 });
}

/** Every player's cache, e.g. after the block types change account-wide. */
export function invalidateAllPractice() {
  entries.forEach((entry, key) => entries.set(key, { ...entry, at: 0 }));
}

/* --- The draft ------------------------------------------------------------ */

export type PracticeDraftStep = { id: number; text: string };

export type PracticeDraft = {
  /** Set when editing an existing block; null for a new one. */
  id: string | null;
  blockType: PracticeBlockType;
  title: string;
  steps: PracticeDraftStep[];
  dose: string;
  expiryType: ExpiryType;
  /** yyyy-mm-dd, only meaningful when expiryType === "set_date". */
  expiryDate: string;
  linkedVideoId: string;
  nextStepId: number;
};

export function emptyPracticeDraft(blockType: PracticeBlockType = "drill"): PracticeDraft {
  return {
    id: null,
    blockType,
    title: "",
    steps: [{ id: 1, text: "" }],
    dose: "",
    // A block a coach writes between lessons is nearly always for the gap
    // before the next one, so that is the default rather than "no expiry".
    expiryType: "next_lesson",
    expiryDate: "",
    linkedVideoId: "",
    nextStepId: 2,
  };
}

export function practiceDraftFromBlock(block: PracticeBlock): PracticeDraft {
  const steps = practiceSteps(block.content);
  return {
    id: block.id,
    blockType: block.blockType,
    title: block.title,
    steps: (steps.length ? steps : [""]).map((text, index) => ({ id: index + 1, text })),
    dose: block.dose || "",
    expiryType: block.expiryType,
    expiryDate: block.expiryType === "set_date" && block.expiryDate ? block.expiryDate.slice(0, 10) : "",
    linkedVideoId: block.linkedVideoId || "",
    nextStepId: Math.max(steps.length, 1) + 1,
  };
}

export function practiceDraftContent(draft: PracticeDraft) {
  return draft.steps.map((step) => step.text.trim()).filter(Boolean).join("\n");
}

export function practiceDraftIsWritten(draft: PracticeDraft) {
  return Boolean(draft.title.trim()) || draft.steps.some((step) => step.text.trim());
}

const drafts = new Map<string, PracticeDraft>();

export function readPracticeDraft(playerId: string): PracticeDraft | null {
  return drafts.get(playerId) || null;
}

/**
 * Only what a coach would be annoyed to lose is kept. An untouched composer is
 * not worth restoring, and storing it would mean a stale expiry or type
 * outliving the session it was picked in.
 */
export function writePracticeDraft(playerId: string, draft: PracticeDraft) {
  if (practiceDraftIsWritten(draft) || draft.id) drafts.set(playerId, draft);
  else drafts.delete(playerId);
}

export function clearPracticeDraft(playerId: string) {
  drafts.delete(playerId);
}
