// Lessons the till can take money for.
//
// Typing a client's name into the till's search used to find nothing unless a
// product happened to share it. It now also finds that client's lessons with
// no payment on record -- past or still to come -- so paying for last week's
// lesson, or a block of three booked ahead, is a search rather than a trip to
// the calendar.
//
// App builds the list (it holds the calendar and the paid/invoiced maps); this
// file only decides what a search shows and how it is grouped, so that can be
// tested without either.

export type TillLesson = {
  bookingId: string;
  personId: string;
  clientName: string;
  clientEmail: string;
  serviceName: string;
  // `lesson:<serviceId>` when that lesson type is still in the catalog. Empty
  // otherwise, and the line is then rung up as plain money: an archived lesson
  // type must not make last month's lesson impossible to pay for.
  catalogItemId: string;
  price: number;
  // ISO date-time of the lesson, for sorting and for the label.
  startsAt: string;
  // "Optix", say, when another system owns the booking and may already have
  // taken the money for it.
  ownerLabel: string;
};

export type TillLessonGroup = {
  key: string;
  clientName: string;
  personId: string;
  lessons: TillLesson[];
  // More than a handful is folded behind the client's name so one regular does
  // not push the shelf off the screen.
  collapsed: boolean;
};

// "More than about 3" was the brief. Three show as they are; the fourth folds.
export const TILL_LESSON_FOLD_AT = 3;

const MIN_QUERY_LENGTH = 2;

/**
 * The lessons a search should show, grouped by client.
 *
 * Matches the client's name (or email) only -- a lesson type's name would match
 * every lesson ever taught, which is what the catalog tiles are for. Lessons
 * already on the docket are left out, so adding one takes it off the list.
 */
export function tillLessonGroups(
  lessons: TillLesson[],
  query: string,
  onDocket: ReadonlySet<string> = new Set(),
): TillLessonGroup[] {
  const needle = String(query || "").trim().toLowerCase();
  if (needle.length < MIN_QUERY_LENGTH) return [];

  const groups = new Map<string, TillLessonGroup>();
  for (const lesson of lessons) {
    if (onDocket.has(lesson.bookingId)) continue;
    const haystack = [lesson.clientName, lesson.clientEmail].filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(needle)) continue;
    // One person, one group, even if one booking spelled their name differently.
    const key = lesson.personId || lesson.clientName.trim().toLowerCase();
    const group = groups.get(key) || {
      key,
      clientName: lesson.clientName,
      personId: lesson.personId,
      lessons: [],
      collapsed: false,
    };
    group.lessons.push(lesson);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      // Oldest first: the lesson that has been owed longest is the one being
      // asked about.
      lessons: group.lessons.slice().sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
      collapsed: group.lessons.length > TILL_LESSON_FOLD_AT,
    }))
    .sort((a, b) => a.clientName.localeCompare(b.clientName));
}

/** "Tue 12 Aug, 3:30 pm" -- enough to tell two lessons apart at a glance. */
export function tillLessonWhen(startsAt: string, now = new Date()) {
  const date = new Date(startsAt);
  if (!Number.isFinite(date.getTime())) return "";
  const sameYear = date.getFullYear() === now.getFullYear();
  const day = date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day}, ${time}`;
}

export function tillLessonIsUpcoming(startsAt: string, now = new Date()) {
  const date = new Date(startsAt);
  return Number.isFinite(date.getTime()) && date.getTime() > now.getTime();
}
