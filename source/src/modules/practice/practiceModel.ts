/* Practice blocks: the shapes, and small pure display helpers.
 *
 * Shared by the coach's panel and the player's Practice section, so the two
 * ends cannot drift on what a block is or how its status/expiry reads.
 */

export type PracticeBlockStatus = "active" | "completed" | "expired" | "archived";
export type ExpiryType = "next_lesson" | "set_date" | "none";

export type PracticeBlock = {
  id: string;
  playerId: string;
  playerName: string;
  title: string;
  content: string;
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
 * A coach's saved template. Account-scoped, so it has no player and no
 * expiry -- those are decided when a block is assigned from it, not here.
 */
export type PracticePreset = {
  id: string;
  title: string;
  content: string;
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
  uses: number;
};

/** The player-facing shape -- no createdBy/playerName, nothing internal. */
export type PlayerPracticeBlock = Pick<
  PracticeBlock,
  "id" | "title" | "content" | "assignedAt" | "expiryType" | "expiryDate" | "linkedVideoId" | "status" | "completedAt"
>;

function shortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
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
