/**
 * Does this screen fit on a phone?
 *
 * Loads a fixture — plain HTML using the real stylesheet — at a given width and
 * reports every element that sticks out past the viewport or is wider than the
 * box holding it. The second kind is the one that matters: a card clipped by
 * its parent shows up as text cut off mid-word rather than as a scrollbar, so
 * looking for horizontal scroll on the page will never find it.
 *
 * Anything that scrolls on purpose is excluded: inputs, selects, and any
 * element whose own overflow-x is auto or scroll (the integration tab strip).
 *
 *   node tools/mobile-probe/probe.mjs [fixture.html] [width]
 *
 * Needs playwright (npm i -D playwright). Fixtures live beside this file; add
 * one whenever a screen is worth checking, copying the class names AND the
 * ancestor chain out of the JSX — the cascade depends on both.
 */

const [fixtureArg = "settings-google-calendar.html", widthArg = "390"] = process.argv.slice(2);
const width = Number(widthArg);

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright is not installed — npm i -D playwright");
  process.exit(1);
}

const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] });
const page = await browser.newPage({ viewport: { width, height: 844 }, deviceScaleFactor: 2 });
await page.goto(`file://${process.cwd()}/tools/mobile-probe/${fixtureArg}`);
await page.waitForTimeout(150);

const report = await page.evaluate((vw) => {
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    const tag = el.tagName.toLowerCase();
    const style = getComputedStyle(el);
    const scrollsByDesign =
      tag === "input" || tag === "textarea" || tag === "select" ||
      style.overflowX === "auto" || style.overflowX === "scroll";
    // Inside a strip that scrolls sideways on purpose, sticking out is the
    // point — the tab bar is meant to be swiped.
    let inScroller = false;
    for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
      const ups = getComputedStyle(up).overflowX;
      if (ups === "auto" || ups === "scroll") { inScroller = true; break; }
    }
    const past = inScroller ? 0 : Math.round(box.right - vw);
    const clipped = scrollsByDesign ? 0 : el.scrollWidth - el.clientWidth;
    if (past > 0 || clipped > 1) {
      out.push({
        tag,
        cls: typeof el.className === "string" ? el.className.slice(0, 70) : "",
        past: past > 0 ? past : 0,
        clipped: clipped > 1 ? clipped : 0,
        text: (el.textContent || "").trim().slice(0, 40),
      });
    }
  }
  return {
    pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    offenders: out,
  };
}, width);

console.log(`${fixtureArg} at ${width}px — page scrolls sideways by ${report.pageScroll}px`);
for (const entry of report.offenders) {
  console.log(`  ${entry.tag}.${entry.cls} past=${entry.past} clipped=${entry.clipped}  "${entry.text}"`);
}
await browser.close();
