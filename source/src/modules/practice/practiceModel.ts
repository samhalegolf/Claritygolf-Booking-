/* Practice blocks: the shapes, and small pure display helpers.
 *
 * Shared by the coach's builder and the player's Practice section, so the two
 * ends cannot drift on what a block is, what kind it is, or how its
 * status/expiry reads.
 */

export type PracticeBlockStatus = "active" | "completed" | "expired" | "archived";
export type ExpiryType = "next_lesson" | "set_date" | "none";

/**
 * A kind of block is presentation, not behaviour: a name, a colour, and which
 * fields the composer offers for it. Nothing about a block *works* differently
 * because of its kind, which is what makes the whole set safe to hand to a
 * coach to rename, recolour and add to.
 *
 * The id is therefore free text, not a union: a coach can add "Pressure Test"
 * and blocks will carry `blockType: "pressure-test"` forever after. Ids are
 * never reused and never rewritten, because every block ever assigned points
 * at one.
 */
export type PracticeBlockType = string;

/** The optional halves of the composer, each switchable per type. */
export type PracticeFieldKey = "steps" | "dose" | "expiry" | "video";

export const PRACTICE_FIELDS: Array<{ key: PracticeFieldKey; label: string; hint: string }> = [
  { key: "steps", label: "Multi-step body", hint: "Numbered instructions rather than one box" },
  { key: "dose", label: "Dose", hint: "The quantity beside step one — “20 balls”" },
  { key: "expiry", label: "Expiry", hint: "When the block stops mattering" },
  { key: "video", label: "Link a video", hint: "Attach one of the player’s saved swings" },
];

export type PracticeTypeMeta = {
  id: PracticeBlockType;
  label: string;
  /** Sits in the picker's tooltip -- what this kind is *for*. */
  hint: string;
  /** The colour it carries the whole way through, as a hex. */
  tone: string;
  /** Placeholder title, so an empty composer still shows the shape of one. */
  titleHint: string;
  /** Placeholder dose, same idea: "20 balls" reads faster than "e.g. a number". */
  doseHint: string;
  fields: Record<PracticeFieldKey, boolean>;
  /**
   * Retired, not deleted. Blocks already assigned under this type keep their
   * name and colour on the wall -- the type just stops being offered.
   */
  archived: boolean;
};

const ALL_FIELDS: Record<PracticeFieldKey, boolean> = { steps: true, dose: true, expiry: true, video: true };

/**
 * What a workspace starts with, and the single place these five are written
 * down. The server stores nothing until a coach edits something, and hands
 * back an empty list until then -- so there is one definition of "the
 * defaults", here, rather than one here and a copy in the backend drifting
 * against it.
 *
 * Custom is last and is picked out on its own in the composer: the four before
 * it are the shapes a coach reaches for, and Custom is the escape hatch when
 * none of them fit.
 */
export const DEFAULT_PRACTICE_TYPES: PracticeTypeMeta[] = [
  { id: "drill", label: "Drill", hint: "one thing, reps", tone: "#2f5d3a", titleHint: "Gate Drill", doseHint: "20 balls", fields: { ...ALL_FIELDS }, archived: false },
  { id: "skill", label: "Skill test", hint: "scored", tone: "#2c4a75", titleHint: "Start Line Test", doseHint: "10 shots", fields: { ...ALL_FIELDS }, archived: false },
  { id: "game", label: "Game", hint: "pressure", tone: "#8a4a1c", titleHint: "Up & Down 9", doseHint: "9 holes", fields: { ...ALL_FIELDS }, archived: false },
  { id: "routine", label: "Routine", hint: "every session", tone: "#5a3a63", titleHint: "Warm-up Routine", doseHint: "10 min", fields: { ...ALL_FIELDS }, archived: false },
  { id: "custom", label: "Custom", hint: "set your own", tone: "#57544d", titleHint: "Name this block", doseHint: "", fields: { ...ALL_FIELDS }, archived: false },
];

/** The stored list, or the defaults when a workspace has never edited them. */
export function practiceTypeList(stored: PracticeTypeMeta[] | null | undefined): PracticeTypeMeta[] {
  return stored && stored.length ? stored : DEFAULT_PRACTICE_TYPES;
}

/** What the composer offers: everything not retired. */
export function practiceOfferedTypes(types: PracticeTypeMeta[]): PracticeTypeMeta[] {
  return types.filter((type) => !type.archived);
}

/**
 * Resolves a block's stored type id against the account's list.
 *
 * A block whose type has since been deleted outright still has to render, so
 * the fallback keeps the id and titles it from that id rather than silently
 * relabelling the block as something it was not. It is grey, because a colour
 * nobody chose is worse than no colour.
 */
export function practiceTypeMeta(types: PracticeTypeMeta[], id: string | null | undefined): PracticeTypeMeta {
  const found = types.find((type) => type.id === id);
  if (found) return found;
  const fallback = types.find((type) => type.id === "custom") || DEFAULT_PRACTICE_TYPES[DEFAULT_PRACTICE_TYPES.length - 1];
  if (!id) return fallback;
  return { ...fallback, id, label: practiceLabelFromId(id), hint: "no longer offered", tone: "#57544d" };
}

/** "pressure-test" -> "Pressure test", for a type whose definition is gone. */
export function practiceLabelFromId(id: string) {
  const words = String(id).replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Block";
}

/** A new type's id, derived from its name and kept unique within the list. */
export function practiceTypeId(label: string, taken: string[]) {
  const base = String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "type";
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** Whether a type offers a given field. A missing flag reads as "yes". */
export function practiceTypeHasField(type: PracticeTypeMeta, field: PracticeFieldKey) {
  return type.fields?.[field] !== false;
}

export type PracticeBlock = {
  id: string;
  playerId: string;
  playerName: string;
  title: string;
  /** The body. One step per line -- see practiceSteps below. */
  content: string;
  blockType: PracticeBlockType;
  /** The block's one quantity: "20 balls", "10 min". May be empty. */
  dose: string;
  assignedAt: string;
  expiryType: ExpiryType;
  expiryDate: string | null;
  linkedVideoId: string | null;
  status: PracticeBlockStatus;
  completedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * A coach's saved favourite. Account-scoped, so it has no player and no
 * expiry -- those are decided when a block is assigned from it, not here.
 * `sortOrder` is the rail order the coach dragged it into.
 */
export type PracticePreset = {
  id: string;
  title: string;
  content: string;
  blockType: PracticeBlockType;
  dose: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * A "used often" starter, derived from the account's assignment history
 * rather than stored. `uses` is how many blocks share this title, which is
 * the whole reason it's being suggested -- show it.
 */
export type PracticeSuggestion = {
  title: string;
  content: string;
  blockType: PracticeBlockType;
  dose: string;
  uses: number;
};

/** The player-facing shape -- no createdBy/playerName, nothing internal. */
export type PlayerPracticeBlock = Pick<
  PracticeBlock,
  | "id"
  | "title"
  | "content"
  | "blockType"
  | "dose"
  | "assignedAt"
  | "expiryType"
  | "expiryDate"
  | "linkedVideoId"
  | "status"
  | "completedAt"
>;

/* --- Steps ------------------------------------------------------------------
 *
 * A block's body is a numbered list of instructions, but it is stored as one
 * text column: a step is a line of `content`. Deliberate. It means every block
 * assigned before the builder existed already has steps (one, or however many
 * paragraphs the coach typed), the player portal's plain-text render still
 * works, and there is no second copy of the same words to fall out of sync.
 * ------------------------------------------------------------------------- */

export function practiceSteps(content: string): string[] {
  return String(content || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function practiceContentFromSteps(steps: string[]): string {
  return steps.map((step) => step.trim()).filter(Boolean).join("\n");
}

function shortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** "18 Aug" -- the stamp on a brick, and nothing more. */
export function practiceShortDate(value: string) {
  return shortDate(value);
}

/** "No expiry" / "Expires 31 Aug" / "Expires next lesson" -- read the same on both ends. */
export function practiceExpiryLabel(block: Pick<PracticeBlock, "expiryType" | "expiryDate">) {
  if (block.expiryType === "none" || !block.expiryDate) return "No expiry";
  if (block.expiryType === "next_lesson") return "Expires next lesson";
  const date = shortDate(block.expiryDate);
  return date ? `Expires ${date}` : "Has an expiry date";
}

export function practiceAssignedLabel(block: Pick<PracticeBlock, "assignedAt">) {
  const date = shortDate(block.assignedAt);
  return date ? `Assigned ${date}` : "";
}

export function isPracticeBlockActive(block: Pick<PracticeBlock, "status">) {
  return block.status === "active";
}

/**
 * The one line under a block's title wherever it is opened: how much work it
 * is, then when it landed. Built here rather than at each call site so the
 * coach's detail card and the player's read the same.
 */
export function practiceBlockMeta(block: {
  content: string;
  dose?: string;
  assignedAt?: string;
  status?: PracticeBlockStatus;
}) {
  const count = practiceSteps(block.content).length;
  const parts = [count === 1 ? "1 step" : `${count} steps`];
  if (block.dose) parts.push(block.dose);
  const assigned = block.assignedAt ? shortDate(block.assignedAt) : "";
  if (assigned) parts.push(`assigned ${assigned}`);
  return parts.join(" · ");
}

/* --- Rail labels ------------------------------------------------------------
 *
 * A rail tile is about 96px wide and holds three 11px lines. A title that fits
 * is shown whole; anything longer falls back to a three-letter shorthand
 * (initials for a multi-word name, first three letters otherwise) and carries
 * the full title in its tooltip. Guessing at a truncation point mid-word reads
 * worse than an obvious abbreviation.
 * ------------------------------------------------------------------------- */

function fitsRailTile(title: string) {
  return String(title).trim().length <= 38 && !/\S{15,}/.test(title);
}

export function practiceShortLabel(title: string) {
  const words = String(title).trim().split(/[\s-]+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 3).map((word) => word[0]).join("").toUpperCase();
  return (words[0] || "").slice(0, 3).toUpperCase();
}

export function practiceRailLabel(title: string, abbreviate: boolean) {
  if (!abbreviate && fitsRailTile(title)) return title;
  return practiceShortLabel(title) || title;
}
