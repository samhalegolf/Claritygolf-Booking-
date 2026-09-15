/**
 * "What happened since I last looked."
 *
 * There is no notification feed for a player and this does not invent one. It
 * reads the four things the portal already holds -- a returned video, a new
 * practice block, a new lesson note, a new pass -- and picks the most recent.
 * Derived rather than stored, so nothing can be marked read on one device and
 * still unread on another, and so it cannot drift out of step with the thing
 * it describes.
 *
 * One line, not a list. The home screen's job is to say whether anything is
 * waiting; the tab it points at is where the detail lives.
 */

export type ActivityItem = {
  /** Where tapping it should go. */
  tab: "reviews" | "practice" | "notes" | "videos" | "passes";
  label: string;
  at: string;
  /** Something the coach sent that has not been opened. */
  unseen: boolean;
};

type Sources = {
  /** Coach returns the player has not opened. */
  unseenReturns: number;
  newestReturnAt: string;
  practice: Array<{ title: string; assignedAt: string; status: string }>;
  notes: Array<{ title?: string; createdAt?: string; updatedAt?: string }>;
  passes: Array<{ name: string; issuedAt: string; creditsAvailable: number }>;
};

const at = (value?: string) => String(value || "");

/**
 * The single most recent thing worth mentioning.
 *
 * An unopened coach return wins outright, regardless of date: it is the only
 * one of the four that is waiting on the player rather than simply having
 * happened. Everything else is ordered by when it happened.
 */
export function recentActivity(sources: Sources): ActivityItem | null {
  if (sources.unseenReturns > 0) {
    return {
      tab: "videos",
      label:
        sources.unseenReturns === 1
          ? "Your coach sent a video back"
          : `Your coach sent ${sources.unseenReturns} videos back`,
      at: at(sources.newestReturnAt),
      unseen: true,
    };
  }

  const candidates: ActivityItem[] = [];

  const practice = [...sources.practice]
    .filter((block) => block.status === "active")
    .sort((a, b) => at(b.assignedAt).localeCompare(at(a.assignedAt)))[0];
  if (practice) {
    candidates.push({
      tab: "practice",
      label: `New practice: ${practice.title}`,
      at: at(practice.assignedAt),
      unseen: false,
    });
  }

  const note = [...sources.notes].sort((a, b) =>
    at(b.updatedAt || b.createdAt).localeCompare(at(a.updatedAt || a.createdAt)),
  )[0];
  if (note) {
    candidates.push({
      tab: "notes",
      label: note.title ? `Note: ${note.title}` : "Your coach left a note",
      at: at(note.updatedAt || note.createdAt),
      unseen: false,
    });
  }

  const pass = [...sources.passes]
    .filter((entry) => entry.creditsAvailable > 0)
    .sort((a, b) => at(b.issuedAt).localeCompare(at(a.issuedAt)))[0];
  if (pass) {
    candidates.push({
      tab: "passes",
      label: `${pass.name} — ${pass.creditsAvailable} left`,
      at: at(pass.issuedAt),
      unseen: false,
    });
  }

  // Undated entries sort last: a thing that cannot say when it happened should
  // not be able to claim it happened most recently.
  return (
    candidates.sort((a, b) => {
      if (!a.at && !b.at) return 0;
      if (!a.at) return 1;
      if (!b.at) return -1;
      return b.at.localeCompare(a.at);
    })[0] || null
  );
}
