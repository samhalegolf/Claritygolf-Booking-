/**
 * The nesting law, checked against the rendered page.
 *
 * "A box means you can act on it" only holds if boxes stay rare, and the way
 * they stop being rare is nesting: a card inside a card inside a list, each
 * one reasonable on its own. That is not visible in the stylesheet — a class
 * is only nested when the JSX puts it there — so this walks the real DOM and
 * reads real computed styles. It is the one rule a lint cannot see.
 *
 * The rule it enforces is the handoff's, precisely: inside a card, a border
 * drops to the hairline. A nested box drawn in the *card* colour is a
 * violation; a nested hairline is not. So this is a colour comparison, not a
 * judgement call, and it cannot argue with you about taste.
 *
 * Dev only. Run it from the console on any screen:
 *
 *     __boxAudit()            // the current screen
 *     __boxAudit(el)          // one subtree
 *
 * It prints a table and returns the rows, so you can filter them.
 */

type Finding = {
  element: Element;
  path: string;
  inside: string;
  colour: string;
  depth: number;
};

function isVisibleBorder(style: CSSStyleDeclaration) {
  const sides = ["Top", "Right", "Bottom", "Left"] as const;
  return sides.some((side) => {
    const width = parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`));
    const kind = style.getPropertyValue(`border-${side.toLowerCase()}-style`);
    const colour = style.getPropertyValue(`border-${side.toLowerCase()}-color`);
    return width > 0 && kind !== "none" && kind !== "hidden" && !colour.includes("rgba(0, 0, 0, 0)");
  });
}

/**
 * A full box, as opposed to a hairline.
 *
 * Four sides is the test rather than "has any border": a single
 * `border-bottom` is exactly what a list row is supposed to have, and flagging
 * those would bury the real findings under every compliant row in the app.
 */
function isFullBox(style: CSSStyleDeclaration) {
  const sides = ["top", "right", "bottom", "left"];
  return sides.every((side) => parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0);
}

function describe(element: Element) {
  const classes = [...element.classList].slice(0, 3).join(".");
  return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""}`;
}

function resolveToken(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim().toLowerCase();
}

/** Normalises "#deded8" and "rgb(222, 222, 216)" to one comparable form. */
function toRgb(value: string) {
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved;
}

export function boxAudit(root: Element = document.body): Finding[] {
  const hairline = toRgb(resolveToken("--c-border-soft") || "#ecebe5");
  const findings: Finding[] = [];

  const boxes: Array<{ element: Element; style: CSSStyleDeclaration }> = [];
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (!isVisibleBorder(style) || !isFullBox(style)) continue;
    boxes.push({ element, style });
  }

  const boxed = new Set(boxes.map((box) => box.element));

  for (const { element, style } of boxes) {
    let ancestor = element.parentElement;
    let depth = 0;
    while (ancestor && ancestor !== root) {
      if (boxed.has(ancestor)) break;
      ancestor = ancestor.parentElement;
      depth += 1;
    }
    if (!ancestor || ancestor === root) continue;

    const colour = toRgb(style.borderTopColor);
    // Drawn in the hairline colour: that IS the rule being followed.
    if (colour === hairline) continue;

    findings.push({
      element,
      path: describe(element),
      inside: describe(ancestor),
      colour: style.borderTopColor,
      depth,
    });
  }

  if (findings.length) {
    console.groupCollapsed(
      `%c${findings.length} nested box${findings.length === 1 ? "" : "es"}`,
      "color:#a52e15;font-weight:700",
    );
    console.table(findings.map(({ path, inside, colour, depth }) => ({ box: path, inside, colour, depth })));
    console.info(
      "Each of these is a full border inside another full border. Drop the inner one to " +
        "var(--c-border-soft), or remove it — the outer box is already saying \"this is a thing\".",
    );
    console.groupEnd();
  } else {
    console.info("%cNo nested boxes on this screen.", "color:#225b2f;font-weight:700");
  }

  return findings;
}

declare global {
  interface Window {
    __boxAudit?: typeof boxAudit;
  }
}

/** Attached in dev only; nothing ships to production from this file. */
export function installBoxAudit() {
  if (!import.meta.env.DEV) return;
  window.__boxAudit = boxAudit;
  console.info("%cUI: __boxAudit() checks this screen for nested boxes.", "color:#57544d");
}
