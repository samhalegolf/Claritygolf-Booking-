// Sandbox-only: finds industry assumptions on the screen as it is drawn.
//
// Two kinds of leak, both read off the rendered page rather than the source:
//
//   - terminology  a word the current profile says should not be here
//                  ("lesson" on a salon's booking card), with the word the
//                  business uses instead.
//   - capability   a module's own name on screen while that module is off
//                  ("Video Analysis" with videoAnalysis = false).
//
// It is a runtime net, not static analysis, and it will miss things and flag
// the odd false positive. Its job is to make the obvious leaks impossible to
// overlook while someone clicks through a Hair & Beauty sandbox.
//
// Mounted by boot.tsx for sandbox sessions only, and does nothing until it is
// switched on in Settings › Sandbox. A live workspace never renders it.

import { useEffect, useRef, useState } from "react";

import {
  capabilityLeakSignatures,
  expectedTermFor,
  findTerms,
  forbiddenTermsFor,
  termMatcher,
  type ResolvedMarket,
} from "../../../netlify/functions/_shared/market-profile.mts";
import { subscribeActiveMarket } from "../../lib/activeMarket";
import { LEAK_DETECTOR_EVENT, leakDetectorEnabled } from "./leakDetectorSwitch";
import "./sandbox.css";

type Finding = {
  key: string;
  kind: "terminology" | "capability";
  term: string;
  text: string;
  expected: string;
  source: string;
  element: Element;
};

const FLAG_CLASS = "industry-leak-flag";
// The detector's own panel, the sandbox bar and the profile builder all name
// modules and golf words on purpose.
const IGNORE_SELECTOR = ".industry-leak-panel, .sandbox-bar, .market-builder, [data-leak-ignore], script, style, noscript";
const ATTRIBUTES = ["placeholder", "title", "aria-label", "alt"];

/** The nearest React component name, when the build kept one. */
function reactComponentName(element: Element): string {
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  let fiber = fiberKey ? (element as unknown as Record<string, any>)[fiberKey] : null;
  for (let depth = 0; fiber && depth < 40; depth += 1, fiber = fiber.return) {
    const type = fiber.type;
    const name = typeof type === "function" ? type.displayName || type.name : "";
    // Minified production names are one or two letters and say nothing.
    if (name && name.length > 2) return name;
  }
  return "";
}

/** Enough to find the element again: a component, then the nearest landmark. */
function describeSource(element: Element): string {
  const parts: string[] = [];
  const component = reactComponentName(element);
  if (component) parts.push(component);
  const landmark = element.closest("[id], section[class], header[class], nav[class], aside[class], dialog");
  if (landmark) {
    const id = landmark.id ? `#${landmark.id}` : "";
    const landmarkClass = [...landmark.classList].find((name) => name !== FLAG_CLASS);
    const firstClass = landmarkClass ? `.${landmarkClass}` : "";
    parts.push(`${landmark.tagName.toLowerCase()}${id || firstClass}`);
  }
  const ownClass = [...element.classList].find((name) => name !== FLAG_CLASS);
  const own = ownClass ? `${element.tagName.toLowerCase()}.${ownClass}` : element.tagName.toLowerCase();
  parts.push(own);
  return parts.join(" › ");
}

function scan(market: ResolvedMarket): Finding[] {
  const termRegex = termMatcher(forbiddenTermsFor(market));
  const signatures = capabilityLeakSignatures(market.capabilities);
  const capabilityRegex = termMatcher(signatures.map((signature) => signature.phrase));
  if (!termRegex && !capabilityRegex) return [];

  const findings = new Map<string, Finding>();
  const record = (element: Element, text: string) => {
    if (element.closest(IGNORE_SELECTOR)) return;
    const snippet = text.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!snippet) return;
    for (const phrase of findTerms(snippet, capabilityRegex)) {
      const signature = signatures.find((candidate) => candidate.phrase.toLowerCase() === phrase.toLowerCase());
      const key = `capability|${phrase.toLowerCase()}|${snippet}`;
      if (!findings.has(key)) {
        findings.set(key, {
          key,
          kind: "capability",
          term: phrase,
          text: snippet,
          expected: signature ? `${signature.key} is off -- this should not render` : "module is off",
          source: describeSource(element),
          element,
        });
      }
    }
    for (const term of findTerms(snippet, termRegex)) {
      const key = `terminology|${term.toLowerCase()}|${snippet}`;
      if (!findings.has(key)) {
        findings.set(key, {
          key,
          kind: "terminology",
          term,
          text: snippet,
          expected: expectedTermFor(term, market.terminology) ?? "not part of this industry",
          source: describeSource(element),
          element,
        });
      }
    }
  };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent && node.textContent && node.textContent.trim()) record(parent, node.textContent);
  }
  for (const attribute of ATTRIBUTES) {
    for (const element of document.body.querySelectorAll(`[${attribute}]`)) {
      record(element, element.getAttribute(attribute) || "");
    }
  }
  return [...findings.values()];
}

function clearFlags() {
  for (const element of document.querySelectorAll(`.${FLAG_CLASS}`)) element.classList.remove(FLAG_CLASS);
}

export default function IndustryLeakDetector() {
  const [enabled, setEnabled] = useState(leakDetectorEnabled);
  const [market, setMarket] = useState<ResolvedMarket | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [open, setOpen] = useState(false);
  const logged = useRef(new Set<string>());

  useEffect(() => subscribeActiveMarket(setMarket), []);

  useEffect(() => {
    const onToggle = (event: Event) => setEnabled(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener(LEAK_DETECTOR_EVENT, onToggle);
    return () => window.removeEventListener(LEAK_DETECTOR_EVENT, onToggle);
  }, []);

  useEffect(() => {
    if (!enabled || !market) {
      clearFlags();
      setFindings([]);
      return;
    }
    let timer = 0;
    const run = () => {
      const next = scan(market);
      clearFlags();
      for (const finding of next) finding.element.classList.add(FLAG_CLASS);
      for (const finding of next) {
        if (logged.current.has(finding.key)) continue;
        logged.current.add(finding.key);
        console.warn(
          `INDUSTRY LEAK (${finding.kind}) "${finding.text}"\n  term: ${finding.term}\n  expected: ${finding.expected}\n  source: ${finding.source}`,
          finding.element,
        );
      }
      setFindings(next);
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(run, 400);
    };
    run();
    // Text and structure only. Attribute changes are ignored on purpose:
    // flagging an element changes its class, and watching that would loop.
    const observer = new MutationObserver((mutations) => {
      if (mutations.every((mutation) => (mutation.target as Element).closest?.(".industry-leak-panel"))) return;
      schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      clearFlags();
    };
  }, [enabled, market]);

  if (!enabled || !market) return null;

  const capabilityCount = findings.filter((finding) => finding.kind === "capability").length;

  return (
    <aside className="industry-leak-panel" aria-label="Industry leak detector">
      <button type="button" className="industry-leak-panel__toggle" onClick={() => setOpen(!open)}>
        <strong>{findings.length}</strong> industry leak{findings.length === 1 ? "" : "s"}
        {capabilityCount ? ` · ${capabilityCount} capability` : ""}
        <span aria-hidden="true">{open ? "▾" : "▴"}</span>
      </button>
      {open ? (
        <div className="industry-leak-panel__body">
          <p className="industry-leak-panel__meta">
            {market.label} · {market.terminology.staffSingular} / {market.terminology.customerSingular} /{" "}
            {market.terminology.serviceSingular}
          </p>
          {findings.length ? (
            <ol>
              {findings.slice(0, 60).map((finding) => (
                <li key={finding.key} className={`is-${finding.kind}`}>
                  <button
                    type="button"
                    onClick={() => finding.element.scrollIntoView({ block: "center", behavior: "smooth" })}
                  >
                    <span className="industry-leak-panel__kind">{finding.kind}</span>
                    <span className="industry-leak-panel__text">“{finding.text}”</span>
                    <span className="industry-leak-panel__expected">
                      {finding.term} → {finding.expected}
                    </span>
                    <span className="industry-leak-panel__source">{finding.source}</span>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="industry-leak-panel__meta">Nothing on this screen. Open another one.</p>
          )}
        </div>
      ) : null}
    </aside>
  );
}
