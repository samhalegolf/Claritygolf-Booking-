// Words the editor can type over, where they stand on the page.

import { useEffect, useRef } from "react";

type Tag = "h1" | "h2" | "h3" | "p" | "div" | "span" | "strong" | "figcaption";

/**
 * Plain text in, plain text out: a single line ends at Enter, a multi-line
 * field keeps its blank lines as paragraph breaks. Written back on leaving the
 * field, so typing never redraws the page under the caret; Escape puts the
 * words back as they were. `autoFocus` puts the caret at the end as soon as
 * it is drawn (a free layout's text, opened by a double-click), and `onDone`
 * hears every leaving, changed or not.
 */
export function EditableText({
  as: Tag,
  value,
  className = "",
  multiline = false,
  autoFocus = false,
  onCommit,
  onDone,
}: {
  as: Tag;
  value: string;
  className?: string;
  multiline?: boolean;
  autoFocus?: boolean;
  onCommit: (next: string) => void;
  onDone?: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!autoFocus || !element) return;
    element.focus();
    const selection = element.ownerDocument.getSelection();
    if (!selection) return;
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }, [autoFocus]);
  return (
    <Tag
      ref={ref as never}
      // A new value from the side panel draws afresh; typing here does not, until the field is left.
      key={value}
      className={`${className} site-inline-edit${multiline ? " is-multiline" : ""}`.trim()}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck
      onBlur={(event) => {
        const raw = event.currentTarget.innerText.replace(/ /g, " ");
        const next = multiline ? raw.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim() : raw.replace(/\s*\n\s*/g, " ").trim();
        if (next !== value) onCommit(next);
        onDone?.();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.currentTarget.innerText = value;
          event.currentTarget.blur();
        } else if (event.key === "Enter" && !multiline) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    >
      {value}
    </Tag>
  );
}
