import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import {
  practiceShortDate,
  practiceTypeMeta,
  type PracticeBlockStatus,
  type PracticeBlockType,
  type PracticeTypeMeta,
} from "./practiceModel";

/* The wall.
 *
 * Every block a player has ever been given, laid as brickwork: oldest at the
 * bottom, newest on the top course. It replaces a reverse-chronological list
 * on both ends of the app, and it is the same component on both -- a player
 * looking at their wall and a coach looking at the same player's wall should
 * be looking at the same object, not two renderings of one dataset.
 *
 * Why a wall and not a list. A list of forty practice blocks is forty rows
 * nobody scrolls; a wall of forty bricks is one picture of a season's work,
 * readable in a glance, where colour says what kind of work it was and how
 * filled-in it looks says how much of it got done. The point is the shape of
 * the whole thing, so a brick carries only a title -- everything else waits
 * until it is opened.
 *
 * The bond. Courses alternate: a full course of whole bricks, then one that
 * starts and ends with a half closer so the vertical joints stagger instead of
 * lining up into a seam. That is what real bonded brickwork does, and it is
 * the reason the wall reads as a wall rather than as a grid. A short top
 * course is padded with blanks rather than left ragged -- the newest block
 * should not be the one that looks broken.
 */

export type PracticeWallBlock = {
  id: string;
  title: string;
  blockType: PracticeBlockType;
  status: PracticeBlockStatus;
  assignedAt: string;
};

export type PracticeWallProps = {
  /** Newest first, exactly as the API hands them over. */
  blocks: PracticeWallBlock[];
  /** The account's kinds, for the colour each brick is laid in. */
  types: PracticeTypeMeta[];
  openId: string | null;
  onOpen: (id: string) => void;
  /** Coach only. Absent on the player's wall -- a player cannot unassign work. */
  onRemove?: (id: string) => void;
  emptyNote?: string;
};

/* Whole bricks in a full course -- one fewer in a course with half closers.
 * Four on a laptop, three on a phone: below about 420px a fourth brick leaves
 * roughly 75px for a title, which turns every two-word block into three
 * stacked fragments. The bond is the same either way. */
const BRICKS_PER_COURSE = 4;
const BRICKS_PER_COURSE_NARROW = 3;
const NARROW_WALL = 420;

export function PracticeWall({
  blocks,
  types,
  openId,
  onOpen,
  onRemove,
  emptyNote = "No practice blocks yet.",
}: PracticeWallProps) {
  const wallRef = useRef<HTMLDivElement | null>(null);
  const [perCourse, setPerCourse] = useState(BRICKS_PER_COURSE);

  useEffect(() => {
    const node = wallRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () =>
      setPerCourse(node.clientWidth < NARROW_WALL ? BRICKS_PER_COURSE_NARROW : BRICKS_PER_COURSE);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
    // The empty state renders no wall at all, so the node this observes only
    // exists once there is a first block -- re-run when that flips.
  }, [blocks.length]);

  const courses = useMemo(() => {
    // The wall is laid bottom-up in assignment order, so the newest-first list
    // the API returns is reversed once, here. The container then stacks
    // column-reverse, which puts the last course laid at the top.
    const laid = [...blocks].reverse();
    const rows: { bricks: PracticeWallBlock[]; closer: boolean; pad: number }[] = [];
    let cursor = 0;
    while (cursor < laid.length) {
      const closer = rows.length % 2 === 1;
      const take = closer ? perCourse - 1 : perCourse;
      const bricks = laid.slice(cursor, cursor + take);
      rows.push({ bricks, closer, pad: take - bricks.length });
      cursor += take;
    }
    return rows;
  }, [blocks, perCourse]);

  if (!blocks.length) return <p className="practice-wall-empty">{emptyNote}</p>;

  return (
    <div className="practice-wall" ref={wallRef}>
      {courses.map((course, index) => (
        <div className="practice-wall-course" key={index}>
          {course.closer && <span className="practice-brick-closer" aria-hidden="true" />}
          {course.bricks.map((block) => (
            <div className="practice-brick-slot" key={block.id}>
              <button
                type="button"
                className="practice-brick"
                data-practice-type={block.blockType}
                style={{ "--practice-tone": practiceTypeMeta(types, block.blockType).tone } as CSSProperties}
                data-status={block.status}
                /* data-brick is the flight animation's handle on this slot;
                   it sets data-pending/data-just-laid on it directly, since
                   neither is state this component has any reason to hold. */
                data-brick={block.id}
                aria-expanded={openId === block.id}
                aria-current={openId === block.id ? "true" : undefined}
                title={`${block.title} — ${block.status}, assigned ${practiceShortDate(block.assignedAt)}`}
                onClick={() => onOpen(block.id)}
              >
                <strong>{block.title}</strong>
              </button>
              {onRemove && (
                <button
                  type="button"
                  className="practice-brick-remove"
                  title={`Remove "${block.title}"`}
                  aria-label={`Remove ${block.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemove(block.id);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {course.pad > 0 && (
            <span className="practice-brick-blank" style={{ flexGrow: course.pad }} aria-hidden="true" />
          )}
          {course.closer && <span className="practice-brick-closer" aria-hidden="true" />}
        </div>
      ))}
    </div>
  );
}

export default PracticeWall;
