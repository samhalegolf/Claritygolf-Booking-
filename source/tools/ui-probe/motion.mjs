/**
 * How long does each thing take to open?
 *
 * Opens every disclosure in a fixture and times it — from the click to the
 * moment the height stops changing. They should all report the same number,
 * because they are all meant to be --c-t-expand. A snap shows up as ~0ms and a
 * stray literal duration shows up as the wrong number, and neither is visible
 * by reading the stylesheet: the settings accordion and the sub-section inside
 * it looked identical in CSS and ran at 200ms and 0ms.
 *
 *   node tools/ui-probe/motion.mjs [fixture.html]
 *
 * Needs playwright (npm i -D playwright).
 */

const [fixtureArg = "disclosures.html"] = process.argv.slice(2);

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright is not installed — npm i -D playwright");
  process.exit(1);
}

const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(`file://${process.cwd()}/tools/ui-probe/${fixtureArg}`);

const results = await page.evaluate(async () => {
  /** Height stops changing for four frames, or two seconds, whichever first. */
  const settle = (element, from) =>
    new Promise((resolve) => {
      const started = performance.now();
      let last = from;
      let still = 0;
      const tick = () => {
        const now = element.getBoundingClientRect().height;
        still = Math.abs(now - last) < 0.5 ? still + 1 : 0;
        last = now;
        if (still > 3 || performance.now() - started > 2000) {
          resolve({ ms: Math.round(performance.now() - started), from: Math.round(from), to: Math.round(now) });
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });

  const out = [];
  for (const target of document.querySelectorAll("[data-disclosure]")) {
    const trigger = target.querySelector("[data-open]");
    const measured = target.querySelector("[data-measure]") || target;
    // The wall-clock number below includes four frames of settle detection, so
    // the declared duration is read straight off the element as well: that one
    // is exact, and it is the number the stylesheet actually promises.
    const animated = target.querySelector(".disclosure-wrap") || target;
    const declared = getComputedStyle(animated, animated === target && target.tagName === "DETAILS" ? "::details-content" : null).transitionDuration;
    const before = measured.getBoundingClientRect().height;
    trigger.click();
    const opened = await settle(measured, before);
    // Four frames of settle detection are counted in, so take them back off.
    out.push({ name: target.dataset.disclosure, declared, ...opened, ms: Math.max(0, opened.ms - 64) });
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return out;
});

console.log(`${fixtureArg}\n`);
for (const entry of results) {
  console.log(`  ${entry.name.padEnd(24)} declared ${entry.declared.padEnd(10)} measured ${String(entry.ms).padStart(4)}ms   ${entry.from}px → ${entry.to}px`);
}
const spread = Math.max(...results.map((r) => r.ms)) - Math.min(...results.map((r) => r.ms));
console.log(`\n  spread: ${spread}ms`);
await browser.close();
