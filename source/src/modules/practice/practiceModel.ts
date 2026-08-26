/* Practice blocks: the shapes, and small pure display helpers.
 *
 * Shared by the coach's builder and the player's Practice section, so the two
 * ends cannot drift on what a block is, what kind it is, or how its
 * status/expiry reads.
 */

export type PracticeBlockStatus = "active" | "completed" | "expired" | "archived";
export type ExpiryType = "next_lesson" | "set_date" | "none";

/**
 * The five kinds of block. Presentation only -- a kind is a label and a
 * colour, and nothing about a block behaves differently because of it. That is
 * why an unrecognised value degrades to "custom" everywhere rather than being
 * rejected: an older row, or one written by hand, is still a perfectly good
 * block.
 */
export type PracticeBlockType = "drill" | "skill" | "game" | "routine" | "custom";

export type PracticeTypeMeta = {
  id: PracticeBlockType;
  label: string;
  /** Sits under the label in the type picker -- what this kind is *for*. */
  hint: string;
  /** Placeholder title, so an empty composer still shows the shape of one. */
  titleHint: string;
  /** Placeholder dose, same idea: "20 balls" reads faster than "e.g. a number". */
  doseHint: string;
};

/**
 * Custom is last and is picked out on its own in the composer: the four before
 * it are the shapes a coach reaches for, and Custom is the escape hatch when
 * none of them fit.
 */
export const PRACTICE_TYPES: PracticeTypeMeta[] = [
  { id: "drill", label: "Drill", hint: "one thing, reps", titleHint: "Gate Drill", doseHint: "20 balls" },
  { id: "skill", label: "Skill test", hint: "scored", titleHint: "Start Line Test", doseHint: "10 shots" },
  { id: "game", label: "Game", hint: "pressure", titleHint: "Up & Down 9", doseHint: "9 holes" },
  { id: "routine", label: "Routine", hint: "every session", titleHint: "Warm-up Routine", doseHint: "10 min" },
  { id: "custom", label: "Custom", hint: "set your own", titleHint: "Name this block", doseHint: "" },
];

export function practiceTypeMeta(type: string | null | undefined): PracticeTypeMeta {
  return PRACTICE_TYPES.find((meta) => meta.id === type) || PRACTICE_TYPES[PRACTICE_TYPES.length - 1];
}

export function practiceBlockType(value: string | null | undefined): PracticeBlockType {
  return practiceTypeMeta(value).id;
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
